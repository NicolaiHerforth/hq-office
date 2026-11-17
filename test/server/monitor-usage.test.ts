// THE MONITOR, what was used between two readings (monitor-usage.ts): hand-written readings, no load and no real
// process table.
import { describe, expect, test } from "bun:test";
import type { Host, Owner, Proc, Reading, Usage } from "../../src/server/monitor-types.ts";
import { MAX_GAP_MS, SMALL, usage } from "../../src/server/monitor-usage.ts";

const MB = 1024 * 1024;
const AT = 1_000_000_000;
const TICK = 10_000;
// Started long before the reading at AT.
const OLD = AT / 1000 - 5000;
const SELF = { cpuMs: 0, memKb: 0 };

const proc = (pid: number, more: Partial<Proc> = {}): Proc => ({ pid, ppid: 1, uid: 501, name: "bun", path: null, start: OLD, cpuMs: 0, childCpuMs: 0, mem: 0, exact: true, read: 0, written: 0, ...more });
const host = (more: Partial<Host> = {}): Host => ({
  cores: 8, busyMs: 0, idleMs: 0, load1: 1, memTotal: 16 * 1024 * MB, memFree: 0, memWired: 0, memApp: 0, memCached: 0, memCompressed: 0, memStored: 0,
  swapTotal: 0, swapUsed: 0, pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotal: null, diskFree: null, bootAt: 1_700_000_000, ...more,
});
const reading = (at: number, procs: Proc[], more: Partial<Host> = {}): Reading => ({ at, procs, host: host(more) });
const lane = (name = "bun", owner = "builder"): Owner => ({ kind: "lane", owner, name });
const owners = (by: Record<number, Owner>) => new Map(Object.entries(by).map(([pid, owner]) => [Number(pid), owner]));
const row = (owner: Owner, more: Partial<Usage> = {}): Usage => ({ ...owner, cpuMs: 0, memKb: 0, n: 1, readKb: 0, writtenKb: 0, ...more });
const byName = (rows: Usage[]) => Object.fromEntries(rows.map((r) => [`${r.kind}/${r.owner}/${r.name}`, r]));
// The rows of two readings one tick apart.
const between = (before: Proc[], after: Proc[], who: Record<number, Owner>, hosts: [Partial<Host>, Partial<Host>] = [{}, {}]) =>
  usage(reading(AT, before, hosts[0]), reading(AT + TICK, after, hosts[1]), owners(who), SELF);

describe("a process across two readings", () => {
  test("its CPU and disk are what was added, its memory what it holds now", () => {
    const { rows } = between(
      [proc(10, { cpuMs: 1000, mem: 400 * MB, read: 1 * MB, written: 10 * MB })],
      [proc(10, { cpuMs: 1500, mem: 50 * MB, read: 3 * MB, written: 10 * MB + 2048 })],
      { 10: lane() },
    );
    expect(rows).toEqual([row(lane(), { cpuMs: 500, memKb: 51_200, readKb: 2048, writtenKb: 2 })]);
  });

  test("processes of one owner and name are one row", () => {
    const { rows } = between(
      [proc(10, { cpuMs: 100 }), proc(11, { cpuMs: 100 }), proc(12, { cpuMs: 100 })],
      [proc(10, { cpuMs: 400, mem: 300 * MB }), proc(11, { cpuMs: 200, mem: 300 * MB }), proc(12, { cpuMs: 150, mem: 250 * MB })],
      { 10: lane(), 11: lane(), 12: lane("bun", "tester") },
    );
    expect(byName(rows)).toEqual({
      "lane/builder/bun": row(lane(), { cpuMs: 400, memKb: 614_400, n: 2 }),
      "lane/tester/bun": row(lane("bun", "tester"), { cpuMs: 50, memKb: 256_000 }),
    });
  });

  test("a start that moved by a second is still the same process", () => {
    const { rows } = between([proc(10, { cpuMs: 1000, start: OLD })], [proc(10, { cpuMs: 1300, start: OLD + 1 })], { 10: lane() });
    expect(rows[0].cpuMs).toBe(300);
  });

  test("a reused pid is a new process: all of its CPU, none of the old one's", () => {
    const born = AT / 1000 + 5;
    const { rows } = between([proc(10, { cpuMs: 5000 })], [proc(10, { cpuMs: 300, start: born, written: 4 * MB })], { 10: lane() });
    expect(rows).toEqual([row(lane(), { cpuMs: 300, writtenKb: 4096 })]);
    const more = between([proc(10, { cpuMs: 200 })], [proc(10, { cpuMs: 5000, start: born })], { 10: lane() });
    expect(more.rows[0].cpuMs).toBe(5000);
  });

  test("a process the reading before missed adds no CPU or disk, only what it holds", () => {
    const { rows } = between([], [proc(11, { cpuMs: 99_000, read: 500 * MB, written: 500 * MB, mem: 300 * MB })], { 11: lane() });
    expect(rows).toEqual([row(lane(), { memKb: 307_200 })]);
  });

  test("one born just before the reading before, which could not have seen it, counts in full", () => {
    const { rows } = between([], [proc(11, { cpuMs: 700, start: AT / 1000 - 1 })], { 11: lane() });
    expect(rows[0].cpuMs).toBe(700);
  });

  test("without a start, the same pid, parent and name with CPU that did not go down is the same process", () => {
    const unknown = (more: Partial<Proc>) => proc(10, { start: 0, ppid: 7, name: "node", ...more });
    const cpu = (before: Partial<Proc>, after: Partial<Proc>) => between([unknown(before)], [unknown(after)], { 10: lane("node") }).rows[0].cpuMs;
    expect(cpu({ cpuMs: 1000 }, { cpuMs: 1400 })).toBe(400);
    expect(cpu({ cpuMs: 1000 }, { cpuMs: 300 })).toBe(300);
    expect(cpu({ cpuMs: 1000 }, { cpuMs: 1400, ppid: 8 })).toBe(1400);
    expect(cpu({ cpuMs: 1000, name: "sh" }, { cpuMs: 1400 })).toBe(1400);
    expect(cpu({ cpuMs: 1000, start: OLD }, { cpuMs: 1400 })).toBe(400);
  });

  test("disk that cannot be read counts as nothing, also on the tick it becomes readable", () => {
    const disk = (before: Partial<Proc>, after: Partial<Proc>) => {
      const { readKb, writtenKb } = between([proc(10, before)], [proc(10, { mem: 300 * MB, ...after })], { 10: lane() }).rows[0];
      return { readKb, writtenKb };
    };
    expect(disk({ read: null, written: null }, { read: null, written: null })).toEqual({ readKb: 0, writtenKb: 0 });
    expect(disk({ read: null, written: 1 * MB }, { read: 900 * MB, written: 3 * MB })).toEqual({ readKb: 0, writtenKb: 2048 });
    expect(disk({ read: 5 * MB, written: 5 * MB }, { read: null, written: 4 * MB })).toEqual({ readKb: 0, writtenKb: 0 });
  });

  test("a process nobody attributed is other", () => {
    const { rows } = between([proc(10)], [proc(10, { cpuMs: 100, name: "stray" })], {});
    expect(rows).toEqual([row({ kind: "other", owner: "other", name: "stray" }, { cpuMs: 100 })]);
  });
});

describe("what runs inside a process", () => {
  test("gets its own row, and the process around it keeps the rest", () => {
    const vm = (cpuMs: number) => proc(50, { name: "vm", cpuMs, mem: 10_000 * MB });
    const box = (cpuMs: number, mem: number) => proc(-7, { name: "shop: db", ppid: 50, cpuMs, mem: mem * MB, childCpuMs: null, inside: 50 });
    const { rows } = between([vm(1000), box(5000, 300)], [vm(3000), box(5600, 400)], { 50: { kind: "app", owner: "Engine", name: "vm" }, [-7]: lane("shop: db") });
    expect(byName(rows)).toEqual({
      "app/Engine/vm": row({ kind: "app", owner: "Engine", name: "vm" }, { cpuMs: 1400, memKb: 9600 * 1024 }),
      "lane/builder/shop: db": row(lane("shop: db"), { cpuMs: 600, memKb: 400 * 1024 }),
    });
  });

  test("never takes the process around it below nothing", () => {
    const { rows } = between(
      [proc(50, { name: "vm", cpuMs: 1000, mem: 100 * MB }), proc(-7, { name: "box", cpuMs: 0, mem: 0, inside: 50 })],
      [proc(50, { name: "vm", cpuMs: 1200, mem: 100 * MB }), proc(-7, { name: "box", cpuMs: 900, mem: 300 * MB, inside: 50 })],
      { 50: lane("vm"), [-7]: lane("box") },
    );
    expect(byName(rows)["lane/builder/box"]).toMatchObject({ cpuMs: 900, memKb: 300 * 1024 });
    expect(byName(rows)["lane/builder/(small)"]).toMatchObject({ cpuMs: 0, memKb: 0 });
  });

  test("without the process around it in the reading, it is a row like any other", () => {
    const { rows } = between([proc(-7, { name: "box", cpuMs: 0, inside: 50 })], [proc(-7, { name: "box", cpuMs: 500, mem: 300 * MB, inside: 50 })], { [-7]: lane("box") });
    expect(rows).toEqual([row(lane("box"), { cpuMs: 500, memKb: 300 * 1024 })]);
  });
});

describe("children that exited", () => {
  const shell = (childCpuMs: number | null, more: Partial<Proc> = {}) => proc(100, { name: "zsh", childCpuMs, ...more });
  const who = { 100: lane("zsh") };
  const exited = (rows: Usage[]) => byName(rows)["lane/builder/(exited)"];

  test("CPU of children that came and went between two readings goes to the parent's owner", () => {
    const { rows } = between([shell(1000)], [shell(1600)], who);
    expect(exited(rows)).toEqual(row(lane("(exited)"), { cpuMs: 600, n: 0 }));
  });

  test("a child that was seen before it exited adds only its last stretch", () => {
    const { rows } = between([shell(1000), proc(101, { ppid: 100, cpuMs: 400, childCpuMs: 50 })], [shell(1600)], who);
    expect(exited(rows).cpuMs).toBe(150);
  });

  test("a whole tree that was seen and exited at once is not counted again", () => {
    const tree = [proc(101, { ppid: 100, cpuMs: 400, childCpuMs: 0 }), proc(102, { ppid: 101, cpuMs: 300, childCpuMs: 20 }), proc(103, { ppid: 102, cpuMs: 100, childCpuMs: null })];
    const { rows } = between([shell(1000), ...tree], [shell(2000)], who);
    expect(exited(rows).cpuMs).toBe(180);
  });

  test("a gone child of another parent is not taken off", () => {
    const { rows } = between([shell(1000), proc(201, { ppid: 200, cpuMs: 400 }), proc(200, { cpuMs: 0 })], [shell(1600), proc(200, { cpuMs: 0 })], { ...who, 200: lane("zsh", "tester") });
    expect(exited(rows).cpuMs).toBe(600);
  });

  test("a pid reused by a new child counts the old child as gone", () => {
    const { rows } = between(
      [shell(1000), proc(101, { ppid: 100, cpuMs: 400 })],
      [shell(1600), proc(101, { ppid: 100, cpuMs: 130, start: AT / 1000 + 3 })],
      { ...who, 101: lane("bun") },
    );
    expect(exited(rows).cpuMs).toBe(200);
    expect(byName(rows)["lane/builder/bun"].cpuMs).toBe(130);
  });

  test("a parent born in the tick gives all of its collected children's CPU, one the reading before missed gives none", () => {
    const born = { start: AT / 1000 + 2 };
    expect(exited(between([], [shell(1600, born)], who).rows).cpuMs).toBe(1600);
    expect(exited(between([shell(1000)], [shell(1600, born)], who).rows).cpuMs).toBe(1600);
    expect(exited(between([], [shell(1600)], who).rows)).toBeUndefined();
  });

  test("never below nothing, and nothing when a total could not be read", () => {
    expect(exited(between([shell(1000), proc(101, { ppid: 100, cpuMs: 900 })], [shell(1600)], who).rows)).toBeUndefined();
    expect(exited(between([shell(1000)], [shell(900)], who).rows)).toBeUndefined();
    expect(exited(between([shell(null)], [shell(1600)], who).rows)).toBeUndefined();
    expect(exited(between([shell(1000)], [shell(null)], who).rows)).toBeUndefined();
  });

  test("a table that is not a tree ends", () => {
    const { rows } = between([shell(1000), proc(101, { ppid: 100, cpuMs: 100 }), proc(101, { ppid: 101, cpuMs: 100 })], [shell(1600)], who);
    expect(exited(rows).cpuMs).toBe(400);
  });
});

describe("the table stays short", () => {
  test("an owner's small rows fold into one, and its totals stay exact", () => {
    const before = [proc(100, { name: "zsh", childCpuMs: 0 }), proc(10), proc(11), proc(12), proc(13), proc(14), proc(20)];
    const after = [
      proc(100, { name: "zsh", childCpuMs: 8, cpuMs: 1, mem: 2 * MB }),
      proc(10, { name: "bun", cpuMs: 500, mem: 100 * MB }),
      proc(11, { name: "sed", cpuMs: 5, mem: 1 * MB, read: 3 * MB }),
      proc(12, { name: "git", cpuMs: 10, mem: 2 * MB, written: 1 * MB }),
      proc(13, { name: "idle", cpuMs: 0, mem: 300 * MB }),
      proc(14, { name: "spin", cpuMs: SMALL.cpuMs, mem: 1 * MB }),
      proc(20, { name: "cat", cpuMs: 3, mem: 1 * MB }),
    ];
    const who = { 100: lane("zsh"), 10: lane("bun"), 11: lane("sed"), 12: lane("git"), 13: lane("idle"), 14: lane("spin"), 20: lane("cat", "tester") };
    const { rows } = between(before, after, who);
    expect(byName(rows)).toEqual({
      "lane/builder/bun": row(lane("bun"), { cpuMs: 500, memKb: 102_400 }),
      "lane/builder/idle": row(lane("idle"), { memKb: 307_200 }),
      "lane/builder/spin": row(lane("spin"), { cpuMs: SMALL.cpuMs, memKb: 1024 }),
      "lane/builder/(small)": row(lane("(small)"), { cpuMs: 1 + 5 + 10 + 8, memKb: 2048 + 1024 + 2048, n: 3, readKb: 3072, writtenKb: 1024 }),
      "lane/tester/(small)": row(lane("(small)", "tester"), { cpuMs: 3, memKb: 1024 }),
    });
    const builder = rows.filter((r) => r.owner === "builder");
    expect(builder.reduce((ms, r) => ms + r.cpuMs, 0)).toBe(1 + 500 + 5 + 10 + 0 + SMALL.cpuMs + 8);
    expect(builder.reduce((kb, r) => kb + r.memKb, 0)).toBe((2 + 100 + 1 + 2 + 300 + 1) * 1024);
    expect(builder.reduce((n, r) => n + r.n, 0)).toBe(6);
  });

  test("small rows of one owner name under two kinds stay apart", () => {
    const { rows } = between([proc(10), proc(11)], [proc(10, { cpuMs: 1 }), proc(11, { cpuMs: 2 })], { 10: { kind: "app", owner: "Notes", name: "a" }, 11: { kind: "lane", owner: "Notes", name: "b" } });
    expect(rows.map((r) => [r.kind, r.name, r.cpuMs]).sort()).toEqual([["app", "(small)", 1], ["lane", "(small)", 2]]);
  });
});

describe("the machine", () => {
  test("CPU the host spent that no process accounts for is a lost row", () => {
    const procs: [Proc[], Proc[]] = [[proc(10)], [proc(10, { cpuMs: 500 })]];
    const { rows, host: h } = between(...procs, { 10: lane() }, [{ busyMs: 7000 }, { busyMs: 9000 }]);
    expect(byName(rows)["lost/kernel and unattributed/(unattributed)"]).toEqual({ kind: "lost", owner: "kernel and unattributed", name: "(unattributed)", cpuMs: 1500, memKb: 0, n: 0, readKb: 0, writtenKb: 0 });
    expect(h.busyMs).toBe(2000);
    expect(between(...procs, { 10: lane() }, [{ busyMs: 7000 }, { busyMs: 7500 }]).rows).toHaveLength(1);
    expect(between(...procs, { 10: lane() }, [{ busyMs: 7000 }, { busyMs: 7400 }]).rows).toHaveLength(1);
  });

  test("its totals since boot become what was added, the rest is as of now, in KB", () => {
    const before = reading(AT, [], { busyMs: 1000, idleMs: 9000, pageins: 10, pageouts: 20, swapins: 30, swapouts: 40 });
    const now: Partial<Host> = {
      cores: 10, busyMs: 4000, idleMs: 96_000, load1: 2.5, memTotal: 1000 * MB, memFree: 100 * MB, memWired: 200 * MB, memApp: 300 * MB, memCached: 150 * MB, memCompressed: 50 * MB,
      memStored: 120 * MB, swapTotal: 2000 * MB, swapUsed: 500 * MB, pressure: 2, available: 37, pageins: 15, pageouts: 20, swapins: 37, swapouts: 49, thermal: 1, diskTotal: 4000 * MB, diskFree: 1024 + 500,
    };
    expect(usage(before, reading(AT + TICK, [], now), owners({}), { cpuMs: 12.5, memKb: 90_000 }).host).toEqual({
      dtMs: TICK, cores: 10, busyMs: 3000, load1: 2.5, memTotalKb: 1_024_000, memFreeKb: 102_400, memWiredKb: 204_800, memAppKb: 307_200, memCachedKb: 153_600, memCompressedKb: 51_200,
      memStoredKb: 122_880, swapTotalKb: 2_048_000, swapUsedKb: 512_000, pressure: 2, available: 37, pageins: 5, pageouts: 0, swapins: 7, swapouts: 9, thermal: 1, diskTotalKb: 4_096_000, diskFreeKb: 1,
      bootAt: 1_700_000_000, heldKb: 0, selfCpuMs: 12.5, selfMemKb: 90_000,
    });
    expect(usage(before, reading(AT + TICK, [], { ...now, pressure: null, available: null, thermal: null, diskTotal: null, diskFree: null }), owners({}), SELF).host).toMatchObject({ pressure: null, available: null, thermal: null, diskTotalKb: null, diskFreeKb: null });
  });

  // What both a first reading and a restart must say: what is held now, and nothing about the time before.
  const nothingUsed = (prev: Reading | null, more: Partial<Host> = {}) => {
    const cur = reading(AT + TICK, [proc(100, { name: "zsh", cpuMs: 9000, childCpuMs: 7000, mem: 300 * MB, read: 5 * MB, written: 5 * MB }), proc(10, { cpuMs: 400, mem: 400 * MB, start: AT / 1000 + 5 })], { busyMs: 50_000, idleMs: 60_000, pageins: 5, pageouts: 5, swapins: 5, swapouts: 5, ...more });
    const { rows, host: h } = usage(prev, cur, owners({ 100: lane("zsh"), 10: lane() }), { cpuMs: 3, memKb: 4 });
    expect(byName(rows)).toEqual({ "lane/builder/zsh": row(lane("zsh"), { memKb: 307_200 }), "lane/builder/bun": row(lane(), { memKb: 409_600 }) });
    expect(h).toMatchObject({ dtMs: 0, busyMs: 0, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, memTotalKb: 16 * 1024 * 1024, selfCpuMs: 3, selfMemKb: 4 });
  };
  const earlier = (more: Partial<Host>) => reading(AT, [proc(100, { name: "zsh", cpuMs: 100, childCpuMs: 100 })], { busyMs: 10_000, idleMs: 10_000, ...more });

  test("the first reading says what is held and nothing about what was used", () => {
    nothingUsed(null);
  });

  test("totals that went backwards are a restart: the same as a first reading", () => {
    nothingUsed(earlier({ busyMs: 80_000 }));
    nothingUsed(earlier({ idleMs: 80_000 }));
    nothingUsed(earlier({ pageins: 9 }));
    nothingUsed(earlier({ swapouts: 9 }));
  });

  test("a clock that did not move forward is the same as a first reading", () => {
    nothingUsed({ ...earlier({}), at: AT + TICK });
    nothingUsed({ ...earlier({}), at: AT + 2 * TICK });
  });

  test("a reading long after the one before (the machine slept) starts over; a tick that only ran long does not", () => {
    nothingUsed({ ...earlier({}), at: AT + TICK - MAX_GAP_MS - 1 });
    const slow = usage({ ...earlier({}), at: AT + TICK - MAX_GAP_MS }, reading(AT + TICK, [proc(100, { name: "zsh", cpuMs: 900, childCpuMs: 100 })], { busyMs: 50_000, idleMs: 60_000 }), owners({ 100: lane("zsh") }), SELF);
    expect(slow.host.dtMs).toBe(MAX_GAP_MS);
    expect(byName(slow.rows)["lane/builder/zsh"].cpuMs).toBe(800);
  });
});
