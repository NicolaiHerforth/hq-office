// THE MONITOR's limits (monitor-limits.ts): every rule on both sides of its threshold, the spans made from the
// store's own rows, written through the store so a renamed column fails here, and swap growth a minute as the verdict
// on now and a minute's bucket read it from the same ticks.
import { describe, expect, test } from "bun:test";
import { verdicts } from "../../src/server/monitor-history.ts";
import { diskLines, limits, spanOfBucket, spanOfTicks, type BucketRow, type Span, type TickRow } from "../../src/server/monitor-limits.ts";
import { lastMinute, now } from "../../src/server/monitor-page.ts";
import { openStore } from "../../src/server/monitor-store.ts";
import type { HostUsage } from "../../src/server/monitor-types.ts";

const GB = 1024 * 1024;
const MINUTE = 60_000;
// A minute on ten cores and a 2000 GB disk in which nothing is short.
const span = (more: Partial<Span> = {}): Span => ({ ms: MINUTE, cores: 10, busyMs: 0, warnMs: 0, criticalMs: 0, swapGrowthKb: 0, thermalMax: 0, diskTotalKb: 2000 * GB, diskFreeKb: 100 * GB, ...more });
const memory = (level: string) => [{ kind: "memory", level }];

describe("memory", () => {
  test("is the limit from half the span at pressure warn", () => {
    expect(limits(span({ warnMs: 29_999 }))).toEqual([]);
    expect(limits(span({ warnMs: 30_000 }))).toEqual(memory("tight"));
    expect(limits(span({ warnMs: 60_000 }))).toEqual(memory("tight"));
  });

  test("is the limit when swap grows by 100 MB a minute, whatever the pressure says", () => {
    expect(limits(span({ swapGrowthKb: 102_399 }))).toEqual([]);
    expect(limits(span({ swapGrowthKb: 102_400 }))).toEqual(memory("tight"));
  });

  test("counts swap growth per minute of the span, however long the span is", () => {
    const quarter = 15 * MINUTE;
    expect(limits(span({ ms: quarter, swapGrowthKb: 15 * 102_400 - 1 }))).toEqual([]);
    expect(limits(span({ ms: quarter, swapGrowthKb: 15 * 102_400 }))).toEqual(memory("tight"));
    expect(limits(span({ ms: 10_000, swapGrowthKb: 17_066 }))).toEqual([]);
    expect(limits(span({ ms: 10_000, swapGrowthKb: 17_067 }))).toEqual(memory("tight"));
  });

  test("caps the machine at any time at pressure critical", () => {
    expect(limits(span({ criticalMs: 1 }))).toEqual(memory("capped"));
    expect(limits(span({ criticalMs: 0, warnMs: 59_999 }))).toEqual(memory("tight"));
  });

  test("caps the machine at warn for half the span only while swap grows", () => {
    expect(limits(span({ warnMs: 30_000, swapGrowthKb: 102_400 }))).toEqual(memory("capped"));
    expect(limits(span({ warnMs: 30_000, swapGrowthKb: 102_399 }))).toEqual(memory("tight"));
    expect(limits(span({ warnMs: 29_999, swapGrowthKb: 102_400 }))).toEqual(memory("tight"));
  });

  test("is not the limit when swap shrinks", () => {
    expect(limits(span({ swapGrowthKb: -5 * GB }))).toEqual([]);
  });
});

describe("the other rules", () => {
  test("cpu: tight from four fifths of all cores, capped from fifteen sixteenths", () => {
    // Ten cores for a minute are 600 000 ms.
    expect(limits(span({ busyMs: 479_999 }))).toEqual([]);
    expect(limits(span({ busyMs: 480_000 }))).toEqual([{ kind: "cpu", level: "tight" }]);
    expect(limits(span({ busyMs: 562_499 }))).toEqual([{ kind: "cpu", level: "tight" }]);
    expect(limits(span({ busyMs: 562_500 }))).toEqual([{ kind: "cpu", level: "capped" }]);
    expect(limits(span({ cores: 5, busyMs: 281_250 }))).toEqual([{ kind: "cpu", level: "capped" }]);
  });

  test("heat: tight at thermal level 1, capped from 2, nothing when it could not be read", () => {
    expect(limits(span({ thermalMax: 0 }))).toEqual([]);
    expect(limits(span({ thermalMax: null }))).toEqual([]);
    expect(limits(span({ thermalMax: 1 }))).toEqual([{ kind: "heat", level: "tight" }]);
    expect(limits(span({ thermalMax: 2 }))).toEqual([{ kind: "heat", level: "capped" }]);
    expect(limits(span({ thermalMax: 4 }))).toEqual([{ kind: "heat", level: "capped" }]);
  });

  test("disk, a large one: tight under 100 GB free, capped under 20 GB, nothing when it could not be read", () => {
    expect(limits(span({ diskFreeKb: 100 * GB }))).toEqual([]);
    expect(limits(span({ diskFreeKb: null }))).toEqual([]);
    expect(limits(span({ diskFreeKb: 100 * GB - 1 }))).toEqual([{ kind: "disk", level: "tight" }]);
    expect(limits(span({ diskFreeKb: 20 * GB }))).toEqual([{ kind: "disk", level: "tight" }]);
    expect(limits(span({ diskFreeKb: 20 * GB - 1 }))).toEqual([{ kind: "disk", level: "capped" }]);
  });

  test("disk, a 256 GB one: tight under a tenth of it free, capped under a fiftieth", () => {
    // 256 GB is 268 435 456 kB: a tenth is 26 843 545.6 kB, a fiftieth 5 368 709.12 kB.
    const small = (diskFreeKb: number | null) => limits(span({ diskTotalKb: 256 * GB, diskFreeKb }));
    expect(small(80 * GB)).toEqual([]);
    expect(small(26_843_546)).toEqual([]);
    expect(small(null)).toEqual([]);
    expect(small(26_843_545)).toEqual([{ kind: "disk", level: "tight" }]);
    expect(small(5_368_710)).toEqual([{ kind: "disk", level: "tight" }]);
    expect(small(5_368_709)).toEqual([{ kind: "disk", level: "capped" }]);
  });

  test("disk, one whose size could not be read: the fixed amounts alone", () => {
    const unsized = (diskFreeKb: number | null) => limits(span({ diskTotalKb: null, diskFreeKb }));
    expect(unsized(100 * GB)).toEqual([]);
    expect(unsized(null)).toEqual([]);
    expect(unsized(100 * GB - 1)).toEqual([{ kind: "disk", level: "tight" }]);
    expect(unsized(20 * GB)).toEqual([{ kind: "disk", level: "tight" }]);
    expect(unsized(20 * GB - 1)).toEqual([{ kind: "disk", level: "capped" }]);
  });

  test("the two lines for a disk's size: the fixed amount or the part of the disk, whichever is less", () => {
    expect(diskLines(1858 * GB)).toEqual({ tightKb: 100 * GB, cappedKb: 20 * GB });
    // Where the two meet: a tenth of 1000 GB is 100 GB, a fiftieth of it 20 GB.
    expect(diskLines(1000 * GB)).toEqual({ tightKb: 100 * GB, cappedKb: 20 * GB });
    // 512 GB is 536 870 912 kB.
    expect(diskLines(512 * GB)).toEqual({ tightKb: 53_687_091.2, cappedKb: 10_737_418.24 });
    expect(diskLines(256 * GB)).toEqual({ tightKb: 26_843_545.6, cappedKb: 5_368_709.12 });
    expect(diskLines(null)).toEqual({ tightKb: 100 * GB, cappedKb: 20 * GB });
  });

  test("everything that is short is named, each at its own level, in the table's order", () => {
    expect(limits(span({ diskFreeKb: GB, thermalMax: 1, busyMs: 600_000, warnMs: 40_000 }))).toEqual([
      { kind: "memory", level: "tight" },
      { kind: "cpu", level: "capped" },
      { kind: "heat", level: "tight" },
      { kind: "disk", level: "capped" },
    ]);
  });

  test("a span that covers no time says nothing", () => {
    expect(limits(span({ ms: 0, thermalMax: 4, diskFreeKb: 1 }))).toEqual([]);
    expect(limits(spanOfTicks([], null))).toEqual([]);
  });
});

describe("a span from the store's rows", () => {
  const TICK = 10_000;
  const B0 = Date.parse("2026-03-10T09:00:00Z");
  const host = (more: Partial<HostUsage> = {}): HostUsage => ({
    dtMs: TICK, cores: 10, busyMs: 0, load1: 1, memTotalKb: 64 * GB, memFreeKb: 0, memWiredKb: 0, memAppKb: 0, memCachedKb: 0, memCompressedKb: 0, memStoredKb: 0, swapTotalKb: 20 * GB, swapUsedKb: 0,
    pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotalKb: 900 * GB, diskFreeKb: 100 * GB, bootAt: 1_700_000_000, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...more,
  });
  // The ticks are written from the first of minute B0 on, one every ten seconds; then every bucket is rolled up.
  function stored(ticks: Partial<HostUsage>[]) {
    const s = openStore(":memory:");
    ticks.forEach((h, i) => s.write(B0 + (i + 1) * TICK, host(h), []));
    s.roll(B0 + 3_600_000);
    return {
      db: s.db,
      ticks: s.db.query("SELECT * FROM host_raw ORDER BY t").all() as TickRow[],
      minutes: s.db.query("SELECT * FROM host_roll WHERE res = 60 ORDER BY t").all() as BucketRow[],
    };
  }

  test("of ticks: the time and the CPU summed, the time at each pressure, swap from tick to tick, the worst heat and disk, the disk's size", () => {
    const { ticks } = stored([
      { busyMs: 1000, swapUsedKb: 500, pressure: 1, thermal: 0, diskFreeKb: 90 * GB },
      { busyMs: 2000, swapUsedKb: 900, pressure: 2, thermal: 2, diskFreeKb: 70 * GB },
      { busyMs: 3000, swapUsedKb: 700, pressure: 2, thermal: 1, diskFreeKb: 80 * GB, dtMs: 9000 },
      { busyMs: 4000, swapUsedKb: 800, pressure: 4, thermal: null, diskTotalKb: null, diskFreeKb: null, cores: 12 },
    ]);
    // With no tick before them, nothing is known of how swap moved in the first one's time: 400 - 200 + 100.
    expect(spanOfTicks(ticks, null)).toEqual({ ms: 39_000, cores: 12, busyMs: 10_000, warnMs: 19_000, criticalMs: 10_000, swapGrowthKb: 300, thermalMax: 2, diskTotalKb: 900 * GB, diskFreeKb: 70 * GB });
    // The last three, counted from the first: swap went from 500 to 800 in their 29 s.
    expect(spanOfTicks(ticks.slice(1), ticks[0])).toMatchObject({ ms: 29_000, swapGrowthKb: 300 });
  });

  test("of ticks: what no tick could read stays unknown", () => {
    const unread = { pressure: null, thermal: null, diskTotalKb: null, diskFreeKb: null };
    const { ticks } = stored([unread, unread]);
    expect(spanOfTicks(ticks, null)).toEqual({ ms: 20_000, cores: 10, busyMs: 0, warnMs: 0, criticalMs: 0, swapGrowthKb: 0, thermalMax: null, diskTotalKb: null, diskFreeKb: null });
  });

  test("of a bucket: the bucket's own sums, and swap against the bucket before", () => {
    const first = [{ swapUsedKb: 1000 }, { swapUsedKb: 1000 }, { swapUsedKb: 1000 }, { swapUsedKb: 1000 }, { swapUsedKb: 1000 }, { swapUsedKb: 1000 }];
    const second = [
      { busyMs: 50_000, swapUsedKb: 4000, pressure: 2 as const, thermal: 1, diskFreeKb: 60 * GB },
      { busyMs: 70_000, swapUsedKb: 6000, pressure: 4 as const, thermal: 3, diskFreeKb: 40 * GB },
    ];
    const { minutes } = stored([...first, ...second]);
    expect(spanOfBucket(minutes[1], minutes[0].swap_used_avg_kb)).toEqual({ ms: 20_000, cores: 10, busyMs: 120_000, warnMs: 10_000, criticalMs: 10_000, swapGrowthKb: 4000, thermalMax: 3, diskTotalKb: 900 * GB, diskFreeKb: 40 * GB });
    expect(spanOfBucket(minutes[1], null).swapGrowthKb).toBe(0);
  });

  test("a 256 GB disk with 80 GB free is not a limit, in ticks or in a bucket, and with 10 GB free it is tight in both", () => {
    const roomy = stored(Array.from({ length: 6 }, () => ({ diskTotalKb: 256 * GB, diskFreeKb: 80 * GB })));
    expect(limits(spanOfTicks(roomy.ticks, null))).toEqual([]);
    expect(limits(spanOfBucket(roomy.minutes[0], null))).toEqual([]);
    const fuller = stored(Array.from({ length: 6 }, () => ({ diskTotalKb: 256 * GB, diskFreeKb: 10 * GB })));
    expect(limits(spanOfTicks(fuller.ticks, null))).toEqual([{ kind: "disk", level: "tight" }]);
    expect(limits(spanOfBucket(fuller.minutes[0], null))).toEqual([{ kind: "disk", level: "tight" }]);
  });

  test("a swap that is full and does not grow is not a limit, in ticks or in a bucket", () => {
    const full = Array.from({ length: 12 }, () => ({ swapUsedKb: 19 * GB }));
    const { ticks, minutes } = stored(full);
    expect(limits(spanOfTicks(ticks.slice(6), ticks[5]))).toEqual([]);
    expect(limits(spanOfBucket(minutes[1], minutes[0].swap_used_avg_kb))).toEqual([]);
  });

  // Two minutes in which swap grows by the same amount with every tick, read as the verdict on now reads the second
  // of them and as that minute's bucket does. The rates are in kB a minute.
  const MB = 1024;
  const perMinute = (span: Span) => span.swapGrowthKb / (span.ms / 60_000);
  function growing(kbATick: number) {
    const { db } = stored(Array.from({ length: 12 }, (_, i) => ({ swapUsedKb: 19 * GB + (i + 1) * kbATick })));
    const end = B0 + 12 * TICK;
    return { db, end, live: lastMinute(db, end / 1000)!.span, bucket: verdicts(db, { from: B0, to: end })[1].span };
  }

  test("swap that grows 20 MB with every tick grows 120 MB a minute, and now says so", () => {
    const { db, end, live } = growing(20 * MB);
    expect(live.ms).toBe(60_000);
    expect(perMinute(live)).toBe(120 * MB);
    expect(now(db, { now: end, name: "forge", size: { bytes: 0, limit: 1 } })!.now).toMatchObject({ swapGrowth: 120, state: 1, limiter: "memory", headline: "Memory is close to the cap: swap growing 120 MB a minute." });
  });

  test("the verdict on now and the minute's bucket give the same rate for the same ticks", () => {
    for (const kbATick of [20 * MB, 17 * MB, 3 * MB]) {
      const { live, bucket } = growing(kbATick);
      expect([kbATick, perMinute(live)]).toEqual([kbATick, 6 * kbATick]);
      expect([kbATick, perMinute(bucket)]).toEqual([kbATick, 6 * kbATick]);
    }
  });

  test("swap that grows 102 MB a minute is a limit, live and in the bucket; 96 MB a minute is not", () => {
    // 17 MB a tick is 102 MB a minute, over the line of 100. From the first tick to the last it is 85.
    const over = growing(17 * MB);
    expect(limits(over.live)).toEqual([{ kind: "memory", level: "tight" }]);
    expect(limits(over.bucket)).toEqual([{ kind: "memory", level: "tight" }]);
    const under = growing(16 * MB);
    expect(limits(under.live)).toEqual([]);
    expect(limits(under.bucket)).toEqual([]);
  });

  test("swap that jumped while nobody watched did not grow in the minute after", () => {
    // The fourth tick is the first after a gap: it covers no time, and holds 5 GB more than the one before it.
    const { ticks } = stored(Array.from({ length: 7 }, (_, i) => ({ swapUsedKb: i < 3 ? GB : 6 * GB, ...(i === 3 ? { dtMs: 0 } : {}) })));
    expect(spanOfTicks(ticks.slice(1), ticks[0])).toMatchObject({ ms: 50_000, swapGrowthKb: 0 });
  });
});
