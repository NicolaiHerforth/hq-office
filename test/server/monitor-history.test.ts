// THE MONITOR's history (monitor-history.ts): the data is written through the real store, in memory, at a clock the
// test moves, and rolled up; then the questions are asked of its database. Every expected value is worked out from
// the fixture by hand.
import { describe, expect, test } from "bun:test";
import { episodes, marks, offenders } from "../../src/server/monitor-history.ts";
import { openStore, type Store } from "../../src/server/monitor-store.ts";
import type { HostUsage, OwnerKind, Usage } from "../../src/server/monitor-types.ts";

const TICK = 10_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1024 * 1024;
// B0 is the start of an hour. A tick says what was used in the ten seconds up to it, so minute m after B0 is made of
// the six ticks from B0 + m min + 10 s to B0 + m min + 60 s.
const B0 = Date.parse("2026-03-10T09:00:00Z");
const BOOT = B0 / 1000 - 30 * 86_400;

// A calm machine: ten cores, nothing short.
const host = (more: Partial<HostUsage> = {}): HostUsage => ({
  dtMs: TICK, cores: 10, busyMs: 0, load1: 1, memTotalKb: 64 * GB, memFreeKb: 1000, memWiredKb: 2000, memAppKb: 3000, memCachedKb: 4000, memCompressedKb: 5000, memStoredKb: 6000, swapTotalKb: 20 * GB, swapUsedKb: 0,
  pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotalKb: 900 * GB, diskFreeKb: 100 * GB, bootAt: BOOT, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...more,
});
const used = (kind: OwnerKind, owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}): Usage => ({ kind, owner, name: owner, cpuMs, memKb, n: 1, readKb: 0, writtenKb: 0, ...more });
const lane = (owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}) => used("lane", owner, cpuMs, memKb, more);
const app = (owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}) => used("app", owner, cpuMs, memKb, more);

function minute(s: Store, m: number, h: Partial<HostUsage> = {}, rows: Usage[] = []) {
  for (let i = 1; i <= 6; i++) s.write(B0 + m * MINUTE + i * TICK, host(h), rows);
}
// What a tick's busyMs is at a share of all ten cores, and the three kinds of minute the episodes are made of.
const busy = (share: number) => ({ busyMs: Math.round(share * 10 * TICK) });
const CALM = busy(0.1);
const TIGHT = busy(0.8);
const CAPPED = busy(0.95);
const min = (m: number) => B0 + m * MINUTE;

describe("episodes", () => {
  // Minutes written as given, missing where the list has null, and rolled up.
  function rolled(minutes: (Partial<HostUsage> | null)[], rows: Usage[] = []) {
    const s = openStore(":memory:");
    minutes.forEach((h, m) => h && minute(s, m, h, rows));
    s.roll(min(minutes.length));
    return s.db;
  }
  const all = { from: B0 - HOUR, to: B0 + HOUR };
  // Each episode as kind, level, and the minutes after B0 it runs from and to.
  const spans = (db: Store["db"], q = all) => episodes(db, q).map((e) => [e.kind, e.level, (e.from - B0) / MINUTE, (e.to - B0) / MINUTE]);

  test("nothing short, no episode", () => {
    expect(episodes(rolled([CALM, CALM, CALM]), all)).toEqual([]);
  });

  test("one bucket without the limit does not split an episode, two do, and a missing one does; newest first", () => {
    expect(spans(rolled([TIGHT, CALM, TIGHT, CALM, CALM, TIGHT, null, TIGHT, CALM]))).toEqual([
      ["cpu", "tight", 7, 8],
      ["cpu", "tight", 5, 6],
      ["cpu", "tight", 0, 3],
    ]);
  });

  test("a bucket without the limit and then a missing one end it where the limit was last seen", () => {
    expect(spans(rolled([TIGHT, CALM, null, TIGHT]))).toEqual([
      ["cpu", "tight", 3, 4],
      ["cpu", "tight", 0, 1],
    ]);
  });

  test("the worst level in it is its level, and the busiest bucket its peak", () => {
    const [episode, ...more] = episodes(rolled([TIGHT, CAPPED, busy(0.85)]), all);
    expect(more).toEqual([]);
    expect(episode).toMatchObject({ kind: "cpu", level: "capped", from: min(0), to: min(3), peak: { cpuShare: 0.95 } });
  });

  test("an episode is cut at the window's edges", () => {
    const db = rolled([TIGHT, TIGHT, TIGHT, TIGHT]);
    expect(spans(db, { from: min(1), to: min(3) })).toEqual([["cpu", "tight", 1, 3]]);
  });

  test("cpu: who used the most CPU time in it, with each one's share of all owners'", () => {
    // Six ticks: 3600 + 1800 + 360 + 240 ms.
    const db = rolled([TIGHT], [lane("builder", 600), lane("tester", 300), app("Editor", 60), used("system", "system", 40)]);
    expect(episodes(db, all)[0].who).toEqual([
      { kind: "lane", owner: "builder", share: 0.6, value: 3600 },
      { kind: "lane", owner: "tester", share: 0.3, value: 1800 },
      { kind: "app", owner: "Editor", share: 0.06, value: 360 },
    ]);
  });

  test("memory: who held the most on average, and one that came halfway held half; the peak is the pressure and the swap growth", () => {
    const s = openStore(":memory:");
    const steady = [lane("a", 0, 8 * GB), lane("b", 0, 6 * GB), app("d", 0, 2 * GB)];
    minute(s, 0, { pressure: 2, swapUsedKb: 1000 }, steady);
    minute(s, 1, { pressure: 2, swapUsedKb: 301_000 }, [...steady, app("c", 0, 8 * GB)]);
    s.roll(min(2));
    // Warn throughout, and in the second minute swap grew by 300 000 kB: capped. All owners hold 20 GB on average.
    expect(episodes(s.db, all)).toEqual([
      {
        kind: "memory", level: "capped", from: min(0), to: min(2), peak: { pressureMax: 2, swapGrowthKb: 300_000 },
        who: [
          { kind: "lane", owner: "a", share: 0.4, value: 8 * GB },
          { kind: "lane", owner: "b", share: 0.3, value: 6 * GB },
          { kind: "app", owner: "c", share: 0.2, value: 4 * GB },
        ],
      },
    ]);
  });

  test("swap is not taken to have grown across a missing bucket", () => {
    expect(episodes(rolled([{ swapUsedKb: 0 }, null, { swapUsedKb: GB }, { swapUsedKb: GB }]), all)).toEqual([]);
  });

  test("heat: the owners are ranked by CPU time, not by memory, and one that used none is not named", () => {
    const db = rolled([{ thermal: 1 }, { thermal: 2 }], [lane("holder", 100, 8 * GB), lane("worker", 900, 0), app("Idle", 0, 4 * GB)]);
    expect(episodes(db, all)).toEqual([
      {
        kind: "heat", level: "capped", from: min(0), to: min(2), peak: { thermalMax: 2 },
        who: [{ kind: "lane", owner: "worker", share: 0.9, value: 10_800 }, { kind: "lane", owner: "holder", share: 0.1, value: 1200 }],
      },
    ]);
  });

  test("disk: the least free space is the peak, and nobody is blamed", () => {
    const db = rolled([{ diskFreeKb: 20 * GB }, { diskFreeKb: 4 * GB }], [lane("builder", 100, GB)]);
    expect(episodes(db, all)).toEqual([{ kind: "disk", level: "capped", from: min(0), to: min(2), peak: { diskFreeKb: 4 * GB }, who: [] }]);
  });

  test("disk: the lines follow the disk's size, so a 256 GB disk has no episode at 80 GB free and a tight one at 10 GB", () => {
    const small = (free: number) => ({ diskTotalKb: 256 * GB, diskFreeKb: free * GB });
    expect(episodes(rolled([small(80), small(80)]), all)).toEqual([]);
    expect(episodes(rolled([small(10), small(10)]), all)).toEqual([{ kind: "disk", level: "tight", from: min(0), to: min(2), peak: { diskFreeKb: 10 * GB }, who: [] }]);
  });

  test("two limits at once are two episodes, in the order of the rules", () => {
    expect(spans(rolled([{ ...TIGHT, thermal: 1, pressure: 4 }, { thermal: 1 }]))).toEqual([
      ["memory", "capped", 0, 1],
      ["cpu", "tight", 0, 1],
      ["heat", "tight", 0, 2],
    ]);
  });

  test("further back than the minutes are kept, the quarters of an hour are read, and an episode runs on across the two", () => {
    const s = openStore(":memory:");
    // The newest sample is at B0, so the minutes begin seven days before it.
    const cut = B0 - 7 * DAY;
    const old = cut - 2 * DAY;
    s.write(old + 3 * MINUTE + TICK, host({ thermal: 2 }), [lane("builder", 500)]);
    s.write(cut - 5 * MINUTE, host({ thermal: 1 }), []);
    for (let i = 1; i <= 6; i++) s.write(cut + i * TICK, host({ thermal: 1 }), []);
    s.write(B0, host(), []);
    s.roll(B0);
    expect(episodes(s.db, { from: old - HOUR, to: B0 })).toEqual([
      { kind: "heat", level: "tight", from: cut - 15 * MINUTE, to: cut + MINUTE, peak: { thermalMax: 1 }, who: [] },
      { kind: "heat", level: "capped", from: old, to: old + 15 * MINUTE, peak: { thermalMax: 2 }, who: [{ kind: "lane", owner: "builder", share: 1, value: 500 }] },
    ]);
  });
});

describe("marks", () => {
  const all = { from: B0 - HOUR, to: B0 + HOUR };

  test("a mark that was put down is on the timeline, when it is inside the window", () => {
    const s = openStore(":memory:");
    for (const m of [0, 1]) minute(s, m);
    s.roll(min(2));
    s.mark(B0 + 30_000, "suite", "full suite started");
    s.mark(B0 - 2 * HOUR, "suite", "before the window");
    s.mark(B0 + HOUR, "suite", "after the window");
    expect(marks(s.db, all)).toEqual([{ at: B0 + 30_000, kind: "suite", label: "full suite started" }]);
  });

  test("a mark that was put down is there without a single sample", () => {
    const s = openStore(":memory:");
    s.mark(B0, "release", "0.1.0");
    expect(marks(s.db, all)).toEqual([{ at: B0, kind: "release", label: "0.1.0" }]);
  });

  test("a restart: at the time the machine started, saying how long it had been up", () => {
    const s = openStore(":memory:");
    // Up since three days and four hours before B0, sampled until two minutes after it.
    const before = B0 / 1000 - (3 * 24 + 4) * 3600;
    const after = B0 / 1000 + 200;
    for (const m of [0, 1]) minute(s, m, { bootAt: before });
    for (const m of [5, 6]) minute(s, m, { bootAt: after });
    s.roll(min(7));
    expect(marks(s.db, all)).toEqual([{ at: after * 1000, kind: "restart", label: "restart after 3d4h up" }]);
  });

  test("a start time that moves by seconds without a break in the samples is the clock being set, not a restart", () => {
    const s = openStore(":memory:");
    // Started ten minutes before B0, inside the window: a restart read from it would be a mark there.
    const started = B0 / 1000 - 600;
    minute(s, 0, { bootAt: started });
    minute(s, 1, { bootAt: started + 2 });
    s.roll(min(2));
    expect(marks(s.db, all)).toEqual([]);
  });

  test("no restart is read from a start time that could not be read", () => {
    const s = openStore(":memory:");
    minute(s, 0, { bootAt: null });
    minute(s, 1, { bootAt: B0 / 1000 + 30 });
    minute(s, 2, { bootAt: null });
    s.roll(min(3));
    expect(marks(s.db, all)).toEqual([]);
  });

  test("a gap: two minutes without a sample, at its start, saying how long; one minute is not one", () => {
    const s = openStore(":memory:");
    for (const m of [0, 3, 5, 26]) minute(s, m);
    s.roll(min(27));
    expect(marks(s.db, all)).toEqual([
      { at: min(1), kind: "gap", label: "no samples for 2:00" },
      { at: min(6), kind: "gap", label: "no samples for 20:00" },
    ]);
  });

  // Six minutes of samples. runner is there throughout, builder in minutes 2 and 3, early in 0 and 1, late in 4 and 5.
  function lanes() {
    const s = openStore(":memory:");
    for (let m = 0; m < 6; m++) {
      const there = [lane("runner"), ...(m < 2 ? [lane("early")] : m < 4 ? [lane("builder"), app("Editor")] : [lane("late")])];
      minute(s, m, {}, there);
    }
    s.roll(min(6));
    return s.db;
  }

  test("a lane started and ended where its first and last buckets are, unless those are the window's own", () => {
    expect(marks(lanes(), all)).toEqual([
      { at: min(2), kind: "lane-started", label: "builder" },
      { at: min(2), kind: "lane-ended", label: "early" },
      { at: min(4), kind: "lane-ended", label: "builder" },
      { at: min(4), kind: "lane-started", label: "late" },
    ]);
  });

  test("a lane that runs across the window's edge neither started nor ended in it", () => {
    expect(marks(lanes(), { from: min(2), to: min(4) })).toEqual([]);
    expect(marks(lanes(), { from: min(3), to: min(6) })).toEqual([{ at: min(4), kind: "lane-ended", label: "builder" }, { at: min(4), kind: "lane-started", label: "late" }]);
  });

  test("a gap that began before the window is not a mark in it, and an empty window has none", () => {
    const s = openStore(":memory:");
    for (const m of [0, 10]) minute(s, m);
    s.roll(min(11));
    expect(marks(s.db, { from: min(5), to: min(11) })).toEqual([]);
    expect(marks(s.db, { from: min(0), to: min(11) })).toEqual([{ at: min(1), kind: "gap", label: "no samples for 9:00" }]);
    expect(marks(s.db, { from: min(2), to: min(9) })).toEqual([]);
  });
});

describe("offenders", () => {
  // Three minutes at the limit, each on its own: calm minutes in between. leaders[i] used the most CPU in the i-th.
  function cpuEpisodes(s: Store, first: number, leaders: string[]) {
    leaders.forEach((leader, i) => {
      minute(s, first + 3 * i, TIGHT, [lane(leader, 900), lane("bystander", 100, GB)]);
      for (const calm of [1, 2]) minute(s, first + 3 * i + calm, CALM);
    });
    return min(first + 3 * leaders.length);
  }

  test("top-in-episodes: an owner that led two of three episodes of one limit", () => {
    const s = openStore(":memory:");
    const now = cpuEpisodes(s, 0, ["builder", "tester", "builder"]);
    s.roll(now);
    expect(offenders(s.db, { now })).toEqual([{ pattern: "top-in-episodes", limit: "cpu", kind: "lane", owner: "builder", episodes: 2, of: 3 }]);
  });

  test("top-in-episodes: not for one episode led of three, and not for two of two", () => {
    const three = openStore(":memory:");
    const now = cpuEpisodes(three, 0, ["builder", "tester", "runner"]);
    three.roll(now);
    expect(offenders(three.db, { now })).toEqual([]);
    const two = openStore(":memory:");
    cpuEpisodes(two, 0, ["builder", "builder"]);
    two.roll(now);
    expect(offenders(two.db, { now })).toEqual([]);
  });

  // One tick an hour before the end of each day, counted back from NOW: day 0 is the 24 hours up to NOW. peaks is
  // each owner's memory in GB on day 0, 1, 2, ... A null leaves that owner out of the day.
  const NOW = B0 + DAY;
  function daily(s: Store, peaks: Record<string, (number | null)[]>, days: number[]) {
    for (const day of days) {
      const rows = Object.entries(peaks).flatMap(([owner, gb]) => (gb[day] == null ? [] : [app(owner, 0, gb[day]! * GB)]));
      s.write(NOW - day * DAY - HOUR, host(), [...rows, app("Editor", 0, (day < 3 ? 5 : 2) * GB), app("Editor", 0, (day < 3 ? 4 : 1) * GB, { name: "Editor Helper" })]);
    }
  }

  test("days-above: the highest round threshold an owner's peak reached on three days, of the days that have data", () => {
    const s = openStore(":memory:");
    // Editor's two process groups peak at 9 GB together on three days. Notes is over 16 GB on two days only, so
    // 8 GB is what it reached on three. Mail reached 4 GB on two days, which is one too few.
    daily(s, { Browser: [40, 40, 40, 40], Notes: [20, 20, 9, 5], Mail: [6, 6, 3, 3] }, [0, 1, 2, 3]);
    s.roll(NOW);
    expect(offenders(s.db, { now: NOW })).toEqual([
      { pattern: "days-above", kind: "app", owner: "Browser", memKb: 32 * GB, days: 4, of: 4 },
      { pattern: "days-above", kind: "app", owner: "Editor", memKb: 8 * GB, days: 3, of: 4 },
      { pattern: "days-above", kind: "app", owner: "Notes", memKb: 8 * GB, days: 3, of: 4 },
    ]);
  });

  test("days-above: a day counts from its peak, and only the days asked about count", () => {
    const s = openStore(":memory:");
    const peaks = { Browser: Array.from({ length: 21 }, () => 9) };
    daily(s, peaks, [0, 1, 13, 14, 20]);
    s.roll(NOW);
    const browser = (facts: ReturnType<typeof offenders>) => facts.filter((f) => f.owner === "Browser");
    // Fourteen days back from NOW hold days 0, 1 and 13; thirty hold all five.
    expect(browser(offenders(s.db, { now: NOW }))).toEqual([{ pattern: "days-above", kind: "app", owner: "Browser", memKb: 8 * GB, days: 3, of: 3 }]);
    expect(browser(offenders(s.db, { now: NOW, days: 30 }))).toEqual([{ pattern: "days-above", kind: "app", owner: "Browser", memKb: 8 * GB, days: 5, of: 5 }]);
    expect(browser(offenders(s.db, { now: NOW, days: 13 }))).toEqual([]);
  });

  test("before-restart: who held the most memory in that run's last quarter of an hour, and what limited the machine then", () => {
    const s = openStore(":memory:");
    const first = B0 / 1000 - 3600;
    const second = B0 / 1000 + 240;
    const third = B0 / 1000 + 600;
    const busyRun = [lane("builder", 0, 30 * GB), app("Editor", 0, 10 * GB)];
    minute(s, 0, { bootAt: first }, busyRun);
    minute(s, 1, { bootAt: first }, busyRun);
    minute(s, 2, { bootAt: first, pressure: 4 }, busyRun);
    for (const m of [6, 7]) minute(s, m, { bootAt: second }, [app("Editor", 0, 10 * GB)]);
    for (const m of [11, 12, 20]) minute(s, m, { bootAt: third }, [app("Editor", 0, 10 * GB)]);
    s.roll(min(21));
    // The second run was calm, and what limited the first one is not held against it. The gap in the third run is
    // not a restart.
    expect(offenders(s.db, { now: min(21) })).toEqual([
      { pattern: "before-restart", at: third * 1000, limit: null, kind: "app", owner: "Editor", memKb: 10 * GB },
      { pattern: "before-restart", at: second * 1000, limit: "memory", kind: "lane", owner: "builder", memKb: 30 * GB },
    ]);
  });

  test("the finding with the most behind it comes first", () => {
    const s = openStore(":memory:");
    daily(s, { Browser: [40, 40, 40, 40] }, [0, 1, 2, 3]);
    const restarted = B0 / 1000 + 86_400 - 1200;
    cpuEpisodes(s, 24 * 60 - 40, ["builder", "tester", "builder"]);
    minute(s, 24 * 60 - 10, { bootAt: restarted }, [app("Browser", 0, 40 * GB)]);
    s.roll(NOW);
    expect(offenders(s.db, { now: NOW }).map((f) => [f.pattern, f.owner])).toEqual([
      ["days-above", "Browser"],
      ["days-above", "Editor"],
      ["top-in-episodes", "builder"],
      ["before-restart", "bystander"],
    ]);
  });
});
