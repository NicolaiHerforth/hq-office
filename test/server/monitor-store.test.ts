// THE MONITOR's store (monitor-store.ts), in memory with the time passed in: what a tick writes, the rollups, and
// what is thrown away by age and by size. The last tests use a file in a throwaway folder, for what only a file
// shows: what a restart finds, that the file shrinks, a database made by an earlier version, and a file that is not
// a database.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MARK_LABEL, RAW_KEEP_MS, RES, openOrRenew, openStore, type Store } from "../../src/server/monitor-store.ts";
import type { HostUsage, Usage } from "../../src/server/monitor-types.ts";

// B0 is the start of a minute and of a quarter of an hour. T0 is the first tick of that minute: a tick says what was
// used in the ten seconds up to it, so the minute's six ticks are B0 + 10 s to B0 + 60 s. times() gives a tick's
// seconds after the first tick, and a bucket's seconds after B0.
const TICK = 10_000;
const B0 = Date.parse("2026-03-10T09:00:00Z");
const T0 = B0 + TICK;
const S0 = T0 / 1000;
const BUCKET0 = B0 / 1000;
const MINUTE = 60_000;
const QUARTER = 900_000;

const host = (more: Partial<HostUsage> = {}): HostUsage => ({
  dtMs: TICK, cores: 8, busyMs: 0, load1: 1, memTotalKb: 16_000_000, memFreeKb: 1000, memWiredKb: 2000, memAppKb: 3000, memCachedKb: 4000, memCompressedKb: 5000, memStoredKb: 6000,
  swapTotalKb: 7000, swapUsedKb: 0, pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotalKb: 900_000, diskFreeKb: 500_000, bootAt: 1_700_000_000, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...more,
});
const row = (name: string, more: Partial<Usage> = {}): Usage => ({ kind: "lane", owner: "builder", name, cpuMs: 0, memKb: 0, n: 1, readKb: 0, writtenKb: 0, ...more });

const all = (s: Store, sql: string, ...args: number[]) => s.db.query(sql).all(...args) as Record<string, any>[];
const raw = (s: Store) => all(s, "SELECT r.t, s.kind, s.owner, s.name, r.cpu_ms, r.mem_kb, r.n, r.read_kb, r.written_kb FROM raw r JOIN series s ON s.id = r.sid ORDER BY r.t, s.kind, s.owner, s.name");
const rolled = (s: Store, res: number) => all(s, "SELECT r.t, s.name, r.cpu_ms, r.mem_avg_kb, r.mem_max_kb, r.n_max, r.read_kb, r.written_kb FROM roll r JOIN series s ON s.id = r.sid WHERE r.res = ? ORDER BY r.t, s.name", res);
const hostRolled = (s: Store, res: number) => all(s, "SELECT * FROM host_roll WHERE res = ? ORDER BY t", res);
const times = (s: Store, table: string, res?: number) => all(s, `SELECT DISTINCT t FROM ${table} WHERE ${res ? `res = ${res}` : "TRUE"} ORDER BY t`).map((r) => r.t - (table.endsWith("roll") ? BUCKET0 : S0));
// Every row a reader can see. When a series was last seen is the store's own bookkeeping, and moves with a prune.
const everything = (s: Store) => Object.fromEntries(["series", "raw", "host_raw", "roll", "host_roll"].map((table) => [table, all(s, `SELECT ${table === "series" ? "id, kind, owner, name" : "*"} FROM ${table}`)]));

describe("a tick", () => {
  test("reads back, field for field", () => {
    const s = openStore(":memory:");
    const h = host({
      dtMs: 9990, cores: 10, busyMs: 4321, load1: 2.25, memTotalKb: 16_000_001, memFreeKb: 1_000_002, memWiredKb: 2_000_003, memAppKb: 3_000_004, memCachedKb: 4_000_005, memCompressedKb: 5_000_006,
      memStoredKb: 6_000_007, swapTotalKb: 7_000_008, swapUsedKb: 8_000_009, pressure: 2, available: 37, pageins: 11, pageouts: 12, swapins: 13, swapouts: 14, thermal: 1, diskTotalKb: 900_000_015,
      diskFreeKb: 100_000_016, bootAt: 1_700_000_018, heldKb: 451_200, selfCpuMs: 2.5, selfMemKb: 90_017,
    });
    s.write(T0 + 10_400, h, [row("bun", { cpuMs: 500, memKb: 51_200, n: 2, readKb: 7, writtenKb: 9 }), { kind: "app", owner: "Editor", name: "Editor Helper", cpuMs: 30, memKb: 400_000, n: 4, readKb: 0, writtenKb: 1 }]);
    expect(all(s, "SELECT * FROM host_raw")).toEqual([
      {
        t: S0 + 10, dt_ms: 9990, cores: 10, busy_ms: 4321, load1: 2.25, mem_total_kb: 16_000_001, mem_free_kb: 1_000_002, mem_wired_kb: 2_000_003, mem_app_kb: 3_000_004, mem_cached_kb: 4_000_005,
        mem_compressed_kb: 5_000_006, mem_stored_kb: 6_000_007, swap_total_kb: 7_000_008, swap_used_kb: 8_000_009, pressure: 2, available: 37, pageins: 11, pageouts: 12, swapins: 13, swapouts: 14, thermal: 1,
        disk_total_kb: 900_000_015, disk_free_kb: 100_000_016, boot_at: 1_700_000_018, held_kb: 451_200, self_cpu_ms: 2.5, self_mem_kb: 90_017,
      },
    ]);
    expect(raw(s)).toEqual([
      { t: S0 + 10, kind: "app", owner: "Editor", name: "Editor Helper", cpu_ms: 30, mem_kb: 400_000, n: 4, read_kb: 0, written_kb: 1 },
      { t: S0 + 10, kind: "lane", owner: "builder", name: "bun", cpu_ms: 500, mem_kb: 51_200, n: 2, read_kb: 7, written_kb: 9 },
    ]);
  });

  test("is stored at its nearest second, and what could not be read stays empty", () => {
    const s = openStore(":memory:");
    s.write(T0 + 10_600, host({ pressure: null, available: null, thermal: null, diskTotalKb: null, diskFreeKb: null }), []);
    expect(all(s, "SELECT t, pressure, available, thermal, disk_total_kb, disk_free_kb FROM host_raw")).toEqual([{ t: S0 + 11, pressure: null, available: null, thermal: null, disk_total_kb: null, disk_free_kb: null }]);
  });

  test("names each series once, however many ticks it is in", () => {
    const s = openStore(":memory:");
    for (let i = 0; i < 5; i++) s.write(T0 + i * TICK, host(), [row("bun", { cpuMs: i }), row("git"), ...(i === 3 ? [row("tsc")] : [])]);
    s.write(T0 + 5 * TICK, host(), [row("bun", { owner: "tester" }), { ...row("bun"), kind: "pane" }]);
    expect(all(s, "SELECT kind, owner, name FROM series ORDER BY id")).toEqual([
      { kind: "lane", owner: "builder", name: "bun" },
      { kind: "lane", owner: "builder", name: "git" },
      { kind: "lane", owner: "builder", name: "tsc" },
      { kind: "lane", owner: "tester", name: "bun" },
      { kind: "pane", owner: "builder", name: "bun" },
    ]);
    expect(raw(s).filter((r) => r.owner === "builder" && r.kind === "lane" && r.name === "bun").map((r) => r.cpu_ms)).toEqual([0, 1, 2, 3, 4]);
  });

  test("adds up two rows that are one series", () => {
    const s = openStore(":memory:");
    s.write(T0, host(), [row("***", { cpuMs: 100, memKb: 1000, n: 1, readKb: 5, writtenKb: 6 }), row("***", { cpuMs: 30, memKb: 200, n: 2, readKb: 1, writtenKb: 1 })]);
    expect(raw(s)).toEqual([{ t: S0, kind: "lane", owner: "builder", name: "***", cpu_ms: 130, mem_kb: 1200, n: 3, read_kb: 6, written_kb: 7 }]);
  });

  test("written again for the same second replaces the first, whole", () => {
    const s = openStore(":memory:");
    s.write(T0, host({ busyMs: 100 }), [row("bun", { cpuMs: 100 }), row("git", { cpuMs: 5 })]);
    s.write(T0 + 300, host({ busyMs: 7 }), [row("bun", { cpuMs: 7 })]);
    expect(all(s, "SELECT t, busy_ms FROM host_raw")).toEqual([{ t: S0, busy_ms: 7 }]);
    expect(raw(s).map((r) => [r.name, r.cpu_ms])).toEqual([["bun", 7]]);
  });

  test("that fails leaves nothing behind, and the next one is whole", () => {
    const s = openStore(":memory:");
    expect(() => s.write(T0, host(), [row("fresh"), row("broken", { n: null as unknown as number })])).toThrow();
    expect(everything(s)).toEqual({ series: [], raw: [], host_raw: [], roll: [], host_roll: [] });
    s.write(T0 + TICK, host(), [row("other"), row("fresh", { cpuMs: 9 })]);
    expect(raw(s).map((r) => [r.name, r.cpu_ms])).toEqual([["fresh", 9], ["other", 0]]);
  });
});

describe("the rollup", () => {
  // One minute with the tick at :30 missing; the one after the gap has nothing to count from, so its dt is 0.
  function oneMinute() {
    const s = openStore(":memory:");
    const bun = (memKb: number, n: number) => row("bun", { cpuMs: 10, memKb, n, readKb: 1, writtenKb: 2 });
    const ticks: [number, Partial<HostUsage>, Usage[]][] = [
      [0, { pressure: 1, load1: 1, memFreeKb: 1000, swapUsedKb: 0, available: 60, thermal: 0, diskFreeKb: 500_000, busyMs: 100, pageins: 1, pageouts: 2, swapins: 3, swapouts: 4, selfCpuMs: 1.5, selfMemKb: 50 }, [bun(100, 1)]],
      [10, { pressure: 2, load1: 3, memFreeKb: 2000, swapUsedKb: 500, available: 40, thermal: 2, diskFreeKb: 400_000, busyMs: 200, pageins: 10, selfCpuMs: 1.5, selfMemKb: 70 }, [bun(200, 2), row("tsc", { cpuMs: 7, memKb: 1000 })]],
      [20, { pressure: 4, load1: 2, memFreeKb: 3000, swapUsedKb: 100, available: 10, thermal: 1, diskFreeKb: 450_000, busyMs: 300, selfCpuMs: 1, selfMemKb: 60 }, [bun(300, 3), row("tsc", { cpuMs: 8, memKb: 1500 })]],
      [40, { dtMs: 0, pressure: 2, load1: 2, memFreeKb: 2000, available: 30, selfMemKb: 60 }, [bun(400, 2)]],
      [50, { pressure: 2, load1: 2, memFreeKb: 2000, available: 30, busyMs: 400, selfMemKb: 60 }, [bun(500, 1)]],
    ];
    for (const [second, h, rows] of ticks) s.write(T0 + second * 1000, host(h), rows);
    return s;
  }

  test("waits until the bucket is complete", () => {
    const s = oneMinute();
    s.roll(B0 + MINUTE - 1);
    expect(everything(s)).toMatchObject({ roll: [], host_roll: [] });
    s.roll(B0 + MINUTE);
    expect(times(s, "host_roll", 60)).toEqual([0]);
    expect(times(s, "host_roll", 900)).toEqual([]);
  });

  test("gives the machine's sums, averages and worst values, and says what the bucket covers", () => {
    const s = oneMinute();
    s.roll(B0 + MINUTE);
    expect(hostRolled(s, 60)).toEqual([
      {
        res: 60, t: BUCKET0, samples: 5, covered_ms: 40_000, cores: 8, busy_ms: 1000, load_avg: 2, load_max: 3, mem_total_kb: 16_000_000, mem_free_avg_kb: 2000, mem_wired_avg_kb: 2000, mem_app_avg_kb: 3000,
        mem_cached_avg_kb: 4000, mem_compressed_avg_kb: 5000, mem_stored_avg_kb: 6000, swap_total_kb: 7000, swap_used_avg_kb: 120, swap_used_max_kb: 500, pressure_max: 4, warn_ms: 20_000, critical_ms: 10_000,
        available_min: 10, pageins: 11, pageouts: 2, swapins: 3, swapouts: 4, thermal_max: 2, disk_total_kb: 900_000, disk_free_min_kb: 400_000, boot_at: 1_700_000_000, available_avg: 34, held_avg_kb: 0, held_max_kb: 0, busy_max: 0.04, self_cpu_ms: 4, self_mem_max_kb: 70,
      },
    ]);
  });

  test("divides a series' memory by the bucket's samples, also the ones it was not in", () => {
    const s = oneMinute();
    s.roll(B0 + MINUTE);
    expect(rolled(s, 60)).toEqual([
      { t: BUCKET0, name: "bun", cpu_ms: 50, mem_avg_kb: 300, mem_max_kb: 500, n_max: 3, read_kb: 5, written_kb: 10 },
      { t: BUCKET0, name: "tsc", cpu_ms: 15, mem_avg_kb: 500, mem_max_kb: 1500, n_max: 1, read_kb: 0, written_kb: 0 },
    ]);
  });

  test("keeps what could not be read empty", () => {
    const s = openStore(":memory:");
    for (const second of [0, 10]) s.write(T0 + second * 1000, host({ pressure: null, available: null, thermal: null, diskTotalKb: null, diskFreeKb: null }), []);
    s.roll(B0 + MINUTE);
    expect(hostRolled(s, 60)[0]).toMatchObject({ samples: 2, pressure_max: null, warn_ms: 0, critical_ms: 0, available_min: null, thermal_max: null, disk_total_kb: null, disk_free_min_kb: null });
  });

  test("leaves a bucket without a tick out, and catches up after a pause", () => {
    const s = openStore(":memory:");
    for (const second of [0, 10, 180, 250, 610]) s.write(T0 + second * 1000, host(), [row("bun", { cpuMs: 1 })]);
    s.roll(B0 + 4 * MINUTE + 30_000);
    expect(times(s, "host_roll", 60)).toEqual([0, 180]);
    expect(times(s, "roll", 60)).toEqual([0, 180]);
    s.roll(B0 + QUARTER);
    expect(times(s, "host_roll", 60)).toEqual([0, 180, 240, 600]);
    expect(times(s, "roll", 60)).toEqual([0, 180, 240, 600]);
    expect(hostRolled(s, 900)).toMatchObject([{ t: BUCKET0, samples: 5, covered_ms: 50_000 }]);
    expect(rolled(s, 900)).toMatchObject([{ t: BUCKET0, name: "bun", cpu_ms: 5 }]);
  });

  test("makes the quarter of an hour from the ticks, not from the minutes", () => {
    const s = openStore(":memory:");
    s.write(T0, host({ memFreeKb: 1000 }), []);
    for (const second of [60, 70, 80]) s.write(T0 + second * 1000, host({ memFreeKb: 2000 }), [row("bun", { memKb: 400 })]);
    s.roll(B0 + QUARTER);
    expect(hostRolled(s, 60).map((r) => r.mem_free_avg_kb)).toEqual([1000, 2000]);
    expect(hostRolled(s, 900).map((r) => r.mem_free_avg_kb)).toEqual([1750]);
    expect(rolled(s, 60).map((r) => r.mem_avg_kb)).toEqual([400]);
    expect(rolled(s, 900).map((r) => r.mem_avg_kb)).toEqual([300]);
  });

  test("run twice gives the same rows, and a later run adds only what is new", () => {
    const s = oneMinute();
    s.roll(B0 + MINUTE);
    const once = everything(s);
    s.roll(B0 + MINUTE);
    s.roll(B0 + MINUTE + 30_000);
    expect(everything(s)).toEqual(once);
    s.write(T0 + MINUTE + TICK, host(), [row("bun", { cpuMs: 3 })]);
    s.roll(B0 + 2 * MINUTE);
    expect(hostRolled(s, 60).slice(0, 1)).toEqual(once.host_roll);
    expect(rolled(s, 60).map((r) => [r.t - BUCKET0, r.name, r.cpu_ms])).toEqual([[0, "bun", 50], [0, "tsc", 15], [60, "bun", 3]]);
  });

  test("that stopped halfway is finished by the next run", () => {
    const s = oneMinute();
    s.roll(B0 + MINUTE);
    const whole = everything(s);
    s.db.exec("DELETE FROM host_roll");
    s.db.exec("UPDATE roll SET cpu_ms = 0 WHERE sid = (SELECT MIN(sid) FROM roll)");
    s.roll(B0 + MINUTE);
    expect(everything(s)).toEqual(whole);
  });
});

describe("a mark", () => {
  const marked = (s: Store) => all(s, "SELECT t, kind, label FROM marks ORDER BY id");

  test("is kept with its second, its kind and its text", () => {
    const s = openStore(":memory:");
    s.mark(T0 + 400, "suite", "  full suite started  ");
    expect(marked(s)).toEqual([{ t: S0, kind: "suite", label: "full suite started" }]);
  });

  test("with no kind, or one that is not a short lower-case word, is a note; a long text is cut", () => {
    const s = openStore(":memory:");
    for (const kind of [undefined, "", "Two Words", "x".repeat(25), "<b>"]) s.mark(T0, kind, "a".repeat(MARK_LABEL + 50));
    expect(marked(s).map((m) => [m.kind, m.label.length])).toEqual(Array.from({ length: 5 }, () => ["note", MARK_LABEL]));
  });

  test("goes when the history it marks goes", () => {
    const s = openStore(":memory:");
    s.mark(T0, "release", "0.1.0");
    s.prune(T0 + RES[1].keepMs);
    expect(marked(s).length).toBe(1);
    s.prune(T0 + RES[1].keepMs + 1000);
    expect(marked(s)).toEqual([]);
  });
});

describe("a grower's size", () => {
  const sized = (s: Store) => all(s, "SELECT name, t, kb FROM growers ORDER BY name, t");

  test("is kept with its name and its second, and read again in the same second it replaces the first", () => {
    const s = openStore(":memory:");
    s.grower(T0 + 400, "an image", 274_000_000);
    s.grower(T0 + 400, "a folder", 1200);
    s.grower(T0 + TICK, "a folder", 1300);
    s.grower(T0 + TICK + 300, "a folder", 1350);
    expect(sized(s)).toEqual([{ name: "a folder", t: S0, kb: 1200 }, { name: "a folder", t: S0 + 10, kb: 1350 }, { name: "an image", t: S0, kb: 274_000_000 }]);
  });

  test("goes when the longest history goes, not before", () => {
    const s = openStore(":memory:");
    s.grower(T0, "a folder", 1200);
    s.grower(T0 + MINUTE, "a folder", 1300);
    s.prune(T0 + RES[0].keepMs + RAW_KEEP_MS);
    s.prune(T0 + RES[1].keepMs);
    expect(sized(s).length).toBe(2);
    s.prune(T0 + RES[1].keepMs + 1000);
    expect(sized(s)).toEqual([{ name: "a folder", t: S0 + 60, kb: 1300 }]);
  });
});

describe("what is kept", () => {
  const [minutes, quarters] = RES;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  // A tick with two series, one of them again an hour later, all rolled up.
  function twoTicks() {
    const s = openStore(":memory:");
    s.write(T0, host(), [row("early"), row("bun")]);
    s.write(T0 + HOUR, host(), [row("bun")]);
    s.roll(B0 + HOUR + QUARTER);
    return s;
  }
  const names = (s: Store) => all(s, "SELECT name FROM series ORDER BY name").map((r) => r.name);

  test("the resolutions and how long each is kept", () => {
    expect(RES).toEqual([{ res: 60, keepMs: 7 * 24 * HOUR }, { res: 900, keepMs: 90 * 24 * HOUR }]);
    expect(RAW_KEEP_MS).toBe(24 * HOUR + QUARTER);
  });

  test("raw ticks go after a day and a quarter of an hour, the rollups stay", () => {
    const s = twoTicks();
    s.prune(T0 + RAW_KEEP_MS);
    expect(times(s, "raw")).toEqual([0, 3600]);
    s.prune(T0 + RAW_KEEP_MS + 1000);
    expect(times(s, "raw")).toEqual([3600]);
    expect(times(s, "host_raw")).toEqual([3600]);
    expect(times(s, "roll", 60)).toEqual([0, 3600]);
    expect(times(s, "host_roll", 900)).toEqual([0, 3600]);
    expect(names(s)).toEqual(["bun", "early"]);
  });

  test("each resolution goes after its own time", () => {
    const s = twoTicks();
    s.prune(T0 + minutes.keepMs + 1000);
    expect(times(s, "raw")).toEqual([]);
    expect(times(s, "roll", 60)).toEqual([3600]);
    expect(times(s, "host_roll", 60)).toEqual([3600]);
    expect(times(s, "roll", 900)).toEqual([0, 3600]);
    s.prune(T0 + quarters.keepMs + 1000);
    expect(times(s, "roll", 60)).toEqual([]);
    expect(times(s, "roll", 900)).toEqual([3600]);
    expect(times(s, "host_roll", 900)).toEqual([3600]);
  });

  test("a series goes a day after the last row that could name it, and comes back when it is seen again", () => {
    const s = twoTicks();
    s.prune(T0 + quarters.keepMs + DAY);
    expect(names(s)).toEqual(["bun", "early"]);
    s.prune(T0 + quarters.keepMs + DAY + 1000);
    expect(names(s)).toEqual(["bun"]);
    s.prune(T0 + quarters.keepMs + DAY + HOUR + 1000);
    expect(everything(s)).toEqual({ series: [], raw: [], host_raw: [], roll: [], host_roll: [] });
    const later = T0 + quarters.keepMs + DAY + 2 * HOUR;
    s.write(later, host(), [row("early", { cpuMs: 4 }), row("bun", { cpuMs: 6 })]);
    expect(raw(s).map((r) => [r.name, r.cpu_ms])).toEqual([["bun", 6], ["early", 4]]);
  });

  test("a series that is still in the ticks stays, however long ago it was first seen", () => {
    const s = openStore(":memory:");
    const last = T0 + quarters.keepMs + 30 * DAY;
    for (const at of [T0, T0 + 60 * DAY, last]) {
      s.write(at, host(), [row("bun")]);
      s.prune(at);
    }
    s.write(T0 + 60 * DAY + TICK, host(), [row("once")]);
    s.prune(last + quarters.keepMs);
    expect(names(s)).toEqual(["bun"]);
    expect(raw(s)).toEqual([]);
  });

  test("a prune reads raw and roll by their keys only, never all of either, to find the series that go", () => {
    const s = twoTicks();
    const ran: string[] = [];
    for (const how of ["query", "exec", "run"] as const) {
      const real = s.db[how].bind(s.db) as (sql: string, ...more: unknown[]) => unknown;
      (s.db as unknown as Record<string, unknown>)[how] = (sql: string, ...more: unknown[]) => (ran.push(sql), real(sql, ...more));
    }
    s.prune(T0 + quarters.keepMs + DAY + 1000);
    const plans = ran.filter((sql) => !sql.startsWith("PRAGMA")).map((sql) => {
      const explain = s.db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
      const steps = (explain.all() as { detail: string }[]).map((step) => step.detail);
      explain.finalize();
      return [sql, steps] as const;
    });
    expect(plans.some(([sql]) => sql.startsWith("DELETE FROM series"))).toBe(true);
    expect(plans.filter(([, steps]) => steps.some((step) => /^SCAN (raw|roll)\b/.test(step)))).toEqual([]);
    expect(names(s)).toEqual(["bun"]);
  });

  test("a bucket is rolled up once, never again from raw ticks that are partly gone", () => {
    const s = openStore(":memory:");
    s.write(T0, host({ busyMs: 100 }), [row("bun", { cpuMs: 5 })]);
    s.write(T0 + 50_000, host({ busyMs: 200 }), [row("bun", { cpuMs: 7 })]);
    s.roll(B0 + QUARTER);
    const rolledUp = () => ({ minutes: hostRolled(s, 60), quarters: hostRolled(s, 900), rows: [...rolled(s, 60), ...rolled(s, 900)] });
    const whole = rolledUp();
    expect(whole.rows.map((r) => r.cpu_ms)).toEqual([12, 12]);
    const later = T0 + RAW_KEEP_MS + 30_000;
    s.prune(later);
    expect(times(s, "raw")).toEqual([50]);
    s.roll(later);
    expect(rolledUp()).toEqual(whole);
  });

  test("pruning is not rolling up: what is not rolled yet is still rolled after", () => {
    const s = openStore(":memory:");
    s.write(T0, host(), [row("bun", { cpuMs: 5 })]);
    s.prune(T0 + QUARTER);
    s.roll(B0 + QUARTER);
    expect(rolled(s, 900)).toMatchObject([{ name: "bun", cpu_ms: 5 }]);
  });
});

describe("the size limit", () => {
  const TICKS = 600;
  // 100 minutes of ticks with 20 series each, rolled up as they come.
  function fill(s: Store) {
    for (let i = 0; i < TICKS; i++) {
      s.write(T0 + i * TICK, host(), Array.from({ length: 20 }, (_, j) => row(`worker ${j}`, { cpuMs: i, memKb: 50_000 + j })));
      s.roll(B0 + i * TICK);
    }
    return T0 + TICKS * TICK;
  }

  test("is 500 MB unless it is given", () => {
    expect(openStore(":memory:").size().limit).toBe(500 * 1024 * 1024);
    expect(openStore(":memory:", { limitBytes: 1234 }).size().limit).toBe(1234);
  });

  test("the size grows with what is written", () => {
    const s = openStore(":memory:");
    const empty = s.size().bytes;
    fill(s);
    expect(s.size().bytes).toBeGreaterThan(empty + 100_000);
  });

  test("over it, the oldest of every table goes until the size is under it", () => {
    const limit = 150_000;
    const s = openStore(":memory:", { limitBytes: limit });
    const now = fill(s);
    const last = (TICKS - 1) * (TICK / 1000);
    expect(s.size().bytes).toBeGreaterThan(2 * limit);
    expect(times(s, "raw")[0]).toBe(0);
    s.prune(now);
    expect(s.size().bytes).toBeLessThanOrEqual(limit);
    const lastMinute = last - (last % 60) - 60;
    for (const [table, res, newest] of [["raw", 0, last], ["host_raw", 0, last], ["roll", 60, lastMinute], ["host_roll", 60, lastMinute]] as [string, number, number][]) {
      const kept = times(s, table, res);
      expect(kept[0]).toBeGreaterThan(0);
      expect(kept.at(-1)).toBe(newest);
    }
    expect(raw(s).at(-1)).toMatchObject({ t: S0 + last, name: "worker 9", cpu_ms: TICKS - 1 });
  });

  test("under it, nothing goes", () => {
    const s = openStore(":memory:");
    const now = fill(s);
    const before = everything(s);
    s.prune(now);
    expect(everything(s)).toEqual(before);
  });
});

describe("the file", () => {
  const HOUR = 3_600_000;
  const dirs: string[] = [];
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-store-"));
    dirs.push(dir);
    return join(dir, "monitor.db");
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("a restart finds the series it knew and adds to what is there", () => {
    const path = file();
    const first = openStore(path);
    first.write(T0, host(), [row("bun", { cpuMs: 1 }), row("git", { cpuMs: 2 })]);
    first.close();
    const second = openStore(path);
    second.write(T0 + TICK, host(), [row("git", { cpuMs: 3 }), row("tsc", { cpuMs: 4 })]);
    expect(raw(second).map((r) => [r.t - S0, r.name, r.cpu_ms])).toEqual([[0, "bun", 1], [0, "git", 2], [10, "git", 3], [10, "tsc", 4]]);
    expect(all(second, "SELECT name FROM series ORDER BY id").map((r) => r.name)).toEqual(["bun", "git", "tsc"]);
    second.close();
  });

  test("shrinks when the limit prunes it", () => {
    const path = file();
    const limit = 150_000;
    const s = openStore(path, { limitBytes: limit });
    for (let i = 0; i < 600; i++) s.write(T0 + i * TICK, host(), Array.from({ length: 20 }, (_, j) => row(`worker ${j}`, { memKb: 50_000 + j })));
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(statSync(path).size).toBeGreaterThan(2 * limit);
    s.prune(T0 + 600 * TICK);
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(statSync(path).size).toBeLessThanOrEqual(limit);
    s.close();
  });

  test("a database from before a series had its last-seen time opens, takes ticks, and prunes by them from then on", () => {
    const path = file();
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE series (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (kind, owner, name))");
    old.exec("INSERT INTO series (kind, owner, name) VALUES ('lane', 'builder', 'bun'), ('lane', 'builder', 'gone long ago')");
    old.close();
    const s = openStore(path);
    s.write(T0, host(), [row("bun", { cpuMs: 3 }), row("tsc", { cpuMs: 4 })]);
    expect(raw(s).map((r) => [r.name, r.cpu_ms])).toEqual([["bun", 3], ["tsc", 4]]);
    const names = () => all(s, "SELECT name FROM series ORDER BY name").map((r) => r.name);
    // The first prune cannot know when the old rows were last seen, and takes them as seen then.
    const first = T0 + HOUR;
    s.prune(first);
    expect(names()).toEqual(["bun", "gone long ago", "tsc"]);
    const longest = RES[1].keepMs + 24 * HOUR;
    s.prune(T0 + longest + 1000);
    expect(names()).toEqual(["gone long ago"]);
    s.prune(first + longest + 1000);
    expect(names()).toEqual([]);
    s.close();
  });

  test("a file that is not a database is moved aside with its log files, and a new store is started in its place", () => {
    const path = file();
    writeFileSync(path, "never a database ".repeat(500));
    for (const part of ["-wal", "-shm"]) writeFileSync(path + part, "its old log");
    const { store, setAside } = openOrRenew(path, T0);
    expect(setAside).toBe("monitor.db.broken-20260310T090010Z");
    expect(readFileSync(join(dirname(path), setAside!), "utf8")).toBe("never a database ".repeat(500));
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith(setAside!)).sort()).toEqual([setAside, `${setAside}-shm`, `${setAside}-wal`]);
    store.write(T0, host(), [row("bun", { cpuMs: 1 })]);
    expect(raw(store).map((r) => r.name)).toEqual(["bun"]);
    store.close();
    // What it started is a database: the next open finds it whole and sets nothing aside.
    const again = openOrRenew(path, T0 + HOUR);
    expect(again.setAside).toBeNull();
    expect(raw(again.store).map((r) => r.name)).toEqual(["bun"]);
    again.store.close();
  });

  test("a database that opens as it should is not touched, and one that cannot be opened at all is not moved", () => {
    const path = file();
    openStore(path).close();
    expect(openOrRenew(path, T0).setAside).toBeNull();
    const folder = file();
    mkdirSync(folder);
    expect(() => openOrRenew(folder, T0)).toThrow("unable to open database file");
    const locked = file();
    writeFileSync(locked, "");
    chmodSync(locked, 0o444);
    expect(() => openOrRenew(locked, T0)).toThrow("readonly");
    expect([existsSync(folder), statSync(locked).size, readdirSync(dirname(locked))]).toEqual([true, 0, ["monitor.db"]]);
  });
});
