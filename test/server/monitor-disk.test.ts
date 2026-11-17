// THE MONITOR's disk growers (monitor-disk.ts): a home folder made in a scratch folder, a clock the test moves, a
// store in memory, and a process starter that never runs a real du: it answers in the test, or runs a stub program
// that prints a fixed size, hangs or fails. Then the places macOS guards, which no walk may touch, and the monitor
// with a disk to read: a tick does not wait for a walk, and the walk's cost is on a later tick's row. No test walks
// a folder outside its scratch folder.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitor, TICK_MS, type Source } from "../../src/server/monitor.ts";
import { createDisk, growers, GROWERS, guarded, run, USER_TEMP, type Grower, type Spawn } from "../../src/server/monitor-disk.ts";
import { openStore, type Store } from "../../src/server/monitor-store.ts";
import type { Host } from "../../src/server/monitor-types.ts";

const dirs: string[] = [];
const scratch = () => (dirs.push(mkdtempSync(join(tmpdir(), "hq-monitor-disk-"))), dirs[dirs.length - 1]);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const T0 = Date.parse("2026-03-10T09:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const TEMP = "Temp folders";
const WALKED = [".cache", "Library/Caches", ".bun/install/cache", ".npm", "Library/Developer/Xcode/DerivedData"];

type Ran = Awaited<ReturnType<Spawn>>;
type Du = (folders: string[], opts: Parameters<Spawn>[1]) => Promise<Ran> | Ran;
const prints = (folders: string[], kb: number) => folders.map((folder) => `${kb}\t${folder}\n`).join("");
const answers = (kb: number, cpuMs = 0): Du => (folders) => ({ code: 0, out: prints(folders, kb), cpuMs });

// A du that is a program: it prints `kb` for every folder ("ok"), prints them and exits 1 as du does when it could
// not open a folder inside ("unreadable"), exits 1 with nothing ("fail"), or hangs until its limit ends it ("hang").
const STUB = join(scratch(), "du");
writeFileSync(STUB, `#!/bin/sh\nmode=$1; kb=$2; shift 2\ncase $mode in fail) exit 1;; hang) exec sleep 5;; esac\nfor folder in "$@"; do printf '%s\\t%s\\n' "$kb" "$folder"; done\n[ $mode = unreadable ] && exit 1\nexit 0\n`);
chmodSync(STUB, 0o755);
// Only the one that hangs gets a short limit: on a busy machine a shell takes longer to start than that.
const program = (mode: (folders: string[]) => "ok" | "unreadable" | "fail" | "hang", kb: number): Du => (folders, { signal }) =>
  run([STUB, mode(folders), String(kb), ...folders], { limitMs: mode(folders) === "hang" ? 150 : 30_000, signal });

// A machine: a home folder with these folders in it, a user temp folder, a clock and a store. start() is one run of
// the server, by the real table of growers unless it is given another; cmds is every command it started, walks the
// folders of every du.
function machine({ folders = WALKED, du = answers(1000), table, userTemp }: { folders?: string[]; du?: Du; table?: Grower[]; userTemp?: (home: string) => string } = {}) {
  const home = scratch();
  const temp = userTemp?.(home) ?? scratch();
  for (const folder of folders) mkdirSync(join(home, folder), { recursive: true });
  mkdirSync(temp, { recursive: true });
  const store = openStore(":memory:");
  const clock = { t: T0 };
  const cmds: string[][] = [];
  const walks: string[][] = [];
  const signals: AbortSignal[] = [];
  const spawn: Spawn = async (cmd, opts) => {
    cmds.push(cmd);
    if (cmd[0] === "getconf") return { code: 0, out: `${temp}\n`, cpuMs: 2 };
    const asked = cmd.filter((arg) => arg.startsWith("/"));
    walks.push(asked);
    signals.push(opts.signal);
    return du(asked, opts);
  };
  // /private/tmp is walked wherever there is one; the stub only ever names it.
  const temps = [...(existsSync("/private/tmp") ? ["/private/tmp"] : []), temp];
  return { home, temp, temps, store, clock, cmds, walks, signals, spawn, start: () => createDisk({ store, now: () => clock.t, home, spawn, growers: table }) };
}
const sizes = (store: Store) => Object.fromEntries((store.db.query("SELECT name, kb FROM growers ORDER BY t").all() as { name: string; kb: number }[]).map((r) => [r.name, r.kb]));
const readings = (store: Store, name: string) => (store.db.query("SELECT t FROM growers WHERE name = ? ORDER BY t").all(name) as { t: number }[]).map((r) => r.t * 1000 - T0);
// A gate holds every du until it is opened.
function gate(answer: Du = answers(1000)) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  const du: Du = async (folders, opts) => (await opened, answer(folders, opts));
  return { du, open };
}

describe("a walk", () => {
  const walked = async (m: ReturnType<typeof machine>) => {
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    return disk.read();
  };

  test("is one niced du per grower, of its folders that exist, summed", async () => {
    const m = machine({ folders: ["Library/Caches", ".npm"], du: program(() => "ok", 1500) });
    const cpuMs = await walked(m);
    expect(sizes(m.store)).toMatchObject({ [TEMP]: 1500 * m.temps.length, "~/Library/Caches": 1500, "Package caches": 1500 });
    expect(m.walks).toEqual([m.temps, [join(m.home, "Library/Caches")], [join(m.home, ".npm")]]);
    for (const cmd of m.cmds.filter((c) => c[0] !== "getconf")) expect(cmd.slice(0, 5)).toEqual(["nice", "-n", "19", "du", "-sk"]);
    expect(cpuMs).toBeGreaterThan(2);
  });

  test("of a grower with none of its folders is not started, and leaves no size", async () => {
    const m = machine({ folders: [".bun/install/cache", ".npm"] });
    await walked(m);
    expect(Object.keys(sizes(m.store)).sort()).toEqual(["Package caches", TEMP]);
    expect(sizes(m.store)["Package caches"]).toBe(2000);
    expect(m.walks.length).toBe(2);
  });

  test("that fails or is stopped at its limit writes nothing, and the ones after it are still read", async () => {
    const m = machine({ du: program((folders) => (folders[0].endsWith("Library/Caches") ? "fail" : folders[0].endsWith(".cache") ? "hang" : "ok"), 700) });
    await walked(m);
    expect(Object.keys(sizes(m.store)).sort()).toEqual(["Package caches", TEMP, "Xcode DerivedData"]);
    expect(m.walks.length).toBe(5);
  });

  test("by a du that could not open a folder inside still counts: it printed the size of the rest", async () => {
    const m = machine({ folders: [".cache"], du: program(() => "unreadable", 900) });
    await walked(m);
    expect(sizes(m.store)["~/.cache"]).toBe(900);
  });

  test("with no line for one of its folders writes nothing", async () => {
    const m = machine({ folders: [".bun/install/cache", ".npm"], du: (folders) => ({ code: 0, out: prints(folders.slice(0, 1), 1000), cpuMs: 0 }) });
    await walked(m);
    expect(sizes(m.store)["Package caches"]).toBeUndefined();
  });

  test("that was stopped writes nothing, whatever it had printed by then", async () => {
    const m = machine({ folders: [".cache"], du: (folders) => ({ code: null, out: prints(folders, 1000), cpuMs: 0 }) });
    await walked(m);
    expect(sizes(m.store)).toEqual({});
  });

  test("costs what its child processes used, and read() says so", async () => {
    const m = machine({ du: answers(1000, 40) });
    expect(await walked(m)).toBe(2 + 40 * m.walks.length);
    expect(m.walks.length).toBe(5);
  });
});

describe("what is due when", () => {
  test("nothing at the start; the folders ten minutes after it and once a day", async () => {
    const m = machine();
    const disk = m.start();
    expect(disk.due()).toBe(false);
    expect(await disk.read()).toBe(0);
    m.clock.t = T0 + 10 * MINUTE - 1000;
    expect(disk.due()).toBe(false);
    m.clock.t = T0 + 10 * MINUTE;
    expect(disk.due()).toBe(true);
    await disk.read();
    expect(m.walks.length).toBe(5);
    expect(disk.due()).toBe(false);
    m.clock.t = T0 + 10 * MINUTE + DAY - 1000;
    expect(disk.due()).toBe(false);
    await disk.read();
    expect(m.walks.length).toBe(5);
    m.clock.t += 1000;
    expect(disk.due()).toBe(true);
    await disk.read();
    expect(m.walks.length).toBe(10);
    expect(readings(m.store, "~/.cache")).toEqual([10 * MINUTE, 10 * MINUTE + DAY]);
  });

  test("a restart does not repeat a walk that is less than a day old", async () => {
    const m = machine();
    const first = m.start();
    m.clock.t += 10 * MINUTE;
    await first.read();
    expect(m.walks.length).toBe(5);
    m.clock.t += 60 * MINUTE;
    const again = m.start();
    m.clock.t += 10 * MINUTE;
    expect(again.due()).toBe(false);
    await again.read();
    expect(m.walks.length).toBe(5);
    m.clock.t = T0 + 10 * MINUTE + DAY;
    expect(again.due()).toBe(true);
    await again.read();
    expect(m.walks.length).toBe(10);
  });

  test("a server that restarts every few minutes never walks", async () => {
    const m = machine();
    for (let i = 0; i < 5; i++, m.clock.t += 9 * MINUTE) await m.start().read();
    expect(m.walks).toEqual([]);
    const stays = m.start();
    m.clock.t += 10 * MINUTE;
    await stays.read();
    expect(m.walks.length).toBe(5);
  });

  test("a walk that failed is tried again a day later, not at the next tick", async () => {
    const m = machine({ folders: [".cache"], du: program((folders) => (folders[0].endsWith(".cache") ? "fail" : "ok"), 800) });
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    await disk.read();
    expect(sizes(m.store)["~/.cache"]).toBeUndefined();
    m.clock.t += TICK_MS;
    expect(disk.due()).toBe(false);
    m.clock.t += DAY;
    await disk.read();
    expect(m.walks.filter((folders) => folders[0].endsWith(".cache")).length).toBe(2);
  });

  test("a walk that failed is not tried again by a restart, but a day after it was tried", async () => {
    const m = machine({ folders: [".cache"], du: program(() => "fail", 800) });
    const first = m.start();
    m.clock.t += 10 * MINUTE;
    await first.read();
    expect(sizes(m.store)).toEqual({});
    expect(m.walks.length).toBe(2);
    m.clock.t += 60 * MINUTE;
    const again = m.start();
    m.clock.t += 10 * MINUTE;
    expect(again.due()).toBe(false);
    await again.read();
    expect(m.walks.length).toBe(2);
    m.clock.t = T0 + 10 * MINUTE + DAY;
    expect(again.due()).toBe(true);
    await again.read();
    expect(m.walks.length).toBe(4);
  });

  test("a walk that a restart cut short counts as tried: the next server waits out the day", async () => {
    const held = gate();
    const m = machine({ folders: [".cache"], du: held.du });
    const first = m.start();
    m.clock.t += 10 * MINUTE;
    const reading = first.read();
    while (!m.walks.length) await Bun.sleep(1);
    first.stop();
    held.open();
    await reading;
    expect(sizes(m.store)).toEqual({});
    const again = m.start();
    m.clock.t += 10 * MINUTE;
    // The grower whose walk was under way waits a day. The one that was never started is still due.
    await again.read();
    expect(m.walks.slice(1)).toEqual([[join(m.home, ".cache")]]);
  });

  test("a database from before the tries were kept: its sizes say when each grower was last read", async () => {
    const m = machine();
    m.store.grower(T0 - 60 * MINUTE, "~/.cache", 5000);
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    await disk.read();
    expect(m.walks.length).toBe(4);
    expect(m.walks.flat()).not.toContain(join(m.home, ".cache"));
  });

  test("one walk at a time: nothing is due while one is under way, and asking again starts nothing", async () => {
    const held = gate();
    const m = machine({ du: held.du });
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    const reading = disk.read();
    while (!m.walks.length) await Bun.sleep(1);
    expect(disk.due()).toBe(false);
    expect(await disk.read()).toBe(0);
    expect(m.walks.length).toBe(1);
    held.open();
    await reading;
    expect(m.walks.length).toBe(5);
  });

  test("stopped: the walk under way is told to end, and nothing more is written or due", async () => {
    const held = gate();
    const m = machine({ du: held.du });
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    const reading = disk.read();
    while (!m.walks.length) await Bun.sleep(1);
    disk.stop();
    expect(m.signals[0].aborted).toBe(true);
    held.open();
    await reading;
    expect(sizes(m.store)).toEqual({});
    m.clock.t += 2 * DAY;
    expect(disk.due()).toBe(false);
  });
});

describe("the places macOS guards", () => {
  const HOME = "/Users/someone";

  test("a guarded folder, a folder inside one and a folder that holds one are guarded; any other folder is not", () => {
    for (const is of ["~/Library/Group Containers", "~/Library/Mail", "~/Documents", "/Volumes"]) expect([is, guarded(is, HOME)]).toEqual([is, true]);
    for (const within of ["~/Library/Containers/an.app/Data/Library/Caches", "~/Downloads/cache", "/Volumes/backup/tmp"]) expect([within, guarded(within, HOME)]).toEqual([within, true]);
    for (const holds of ["~/Library", "~/Library/Application Support", "~/", HOME, "/Users", "/"]) expect([holds, guarded(holds, HOME)]).toEqual([holds, true]);
    for (const free of ["~/Library/Caches", "~/Library/Application Support/an.app", "~/.cache", "/private/tmp", "/var/folders/ab/cd/T", "~/Documents-old", "~/Musical", "/Volumes2"]) expect([free, guarded(free, HOME)]).toEqual([free, false]);
  });

  test("however the path is written: a slash at its end, a way round through .., other capitals", () => {
    expect(guarded("~/Pictures/", HOME)).toBe(true);
    expect(guarded("~/Library/Caches/../Messages", HOME)).toBe(true);
    expect(guarded("/users/someone/library/group containers/an.app", HOME)).toBe(true);
    expect(guarded("~/Library/Caches/", "/Users/someone/")).toBe(false);
  });

  test("no folder the real table walks is one, lies inside one or holds one", () => {
    const folders = GROWERS.flatMap((grower) => grower.folders).filter((folder) => folder !== USER_TEMP);
    expect(folders).toContain("~/Library/Caches");
    expect(folders.filter((folder) => guarded(folder, HOME))).toEqual([]);
  });

  test("no walk is started for a guarded folder, were one in the table or the system's answer for the user's temp folder", async () => {
    const table = [
      { name: "Mail", folders: ["~/Library/Mail"] },
      { name: "Mixed", folders: ["~/Documents/cache", "~/.cache"] },
      { name: "Home", folders: ["~/"] },
      { name: "Temp", folders: [USER_TEMP] },
    ];
    const m = machine({ table, folders: ["Library/Mail", "Documents/cache", ".cache"], userTemp: (home) => join(home, "Downloads/T") });
    const disk = m.start();
    m.clock.t += 10 * MINUTE;
    await disk.read();
    expect(m.cmds).toEqual([["nice", "-n", "19", "du", "-sk", join(m.home, ".cache")], ["getconf", "DARWIN_USER_TEMP_DIR"]]);
    expect(sizes(m.store)).toEqual({ Mixed: 1000 });
  });

  test("the module names the folder of other apps' group containers once, in the table of guarded places", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/server/monitor-disk.ts"), "utf8");
    expect(source.match(/group containers/gi)).toEqual(["Group Containers"]);
    expect(guarded("~/Library/Group Containers", HOME)).toBe(true);
  });
});

describe("growers(), for the page", () => {
  const at = (days: number) => T0 + days * DAY;
  const table = ["image", "caches", "new today", "temp"].map((name) => ({ name, folders: [] }));

  test("the newest size of each, largest first, and what it grew since the reading nearest to 30 days before", () => {
    const s = openStore(":memory:");
    for (const [days, kb] of [[0, 100_000], [14, 150_000], [16.5, 160_000], [44, 290_000], [45, 300_000]]) s.grower(at(days), "image", kb);
    for (let days = 40; days <= 45; days++) s.grower(at(days), "caches", 2_000_000 - (45 - days) * 1000);
    s.grower(at(45), "new today", 500);
    expect(growers(s.db, { now: at(45) + 3_600_000, table })).toEqual([
      { name: "caches", kb: 2_000_000, at: at(45), grewKb: 5000, overDays: 5 },
      { name: "image", kb: 300_000, at: at(45), grewKb: 150_000, overDays: 31 },
      { name: "new today", kb: 500, at: at(45), grewKb: null, overDays: null },
    ]);
  });

  test("a size that shrank grew by less than nothing, and a part of a day is a part", () => {
    const s = openStore(":memory:");
    s.grower(at(0), "temp", 9000);
    s.grower(at(0.5), "temp", 4000);
    expect(growers(s.db, { now: at(0.5), table })).toEqual([{ name: "temp", kb: 4000, at: at(0.5), grewKb: -5000, overDays: 0.5 }]);
    expect(growers(openStore(":memory:").db, { now: at(1), table })).toEqual([]);
  });

  test("a grower the table no longer has is not listed, though its sizes are still in the database", () => {
    const s = openStore(":memory:");
    s.grower(at(0), "Container image", 80_000_000);
    s.grower(at(1), "Container image", 90_000_000);
    s.grower(at(1), "~/.cache", 4000);
    expect(growers(s.db, { now: at(1) })).toEqual([{ name: "~/.cache", kb: 4000, at: at(1), grewKb: null, overDays: null }]);
    expect(growers(s.db, { now: at(1), table: [] })).toEqual([]);
    expect((s.db.query("SELECT COUNT(*) AS n FROM growers WHERE name = 'Container image'").get() as { n: number }).n).toBe(2);
  });
});

const HOST: Host = {
  cores: 8, busyMs: 0, idleMs: 0, load1: 1, memTotal: 16 * 2 ** 30, memFree: 2 ** 30, memWired: 2 ** 30, memApp: 8 * 2 ** 30, memCached: 2 ** 30, memCompressed: 2 ** 30, memStored: 3 * 2 ** 30,
  swapTotal: 0, swapUsed: 0, pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotal: 100 * 2 ** 30, diskFree: 40 * 2 ** 30, bootAt: 1_700_000_000,
};

describe("the monitor, with a disk to read", () => {
  // A monitor fed an empty process table, with no herdr. tick() gives what that tick's row says the monitor cost.
  function fed(m: ReturnType<typeof machine>) {
    const dir = scratch();
    const source: Source = { read: async (now) => ({ reading: { at: now(), procs: [], host: HOST }, childCpuMs: 0 }), lookup: { launchPane: () => null, cwd: () => null, responsible: () => null } };
    const monitor = createMonitor({ dir, herdr: join(dir, "no-herdr"), now: () => m.clock.t, source, disk: { home: m.home, spawn: m.spawn } });
    const tick = async () => {
      await monitor.tick();
      expect(monitor.failed()).toBeNull();
      m.clock.t += TICK_MS;
      return monitor.last()!.host.selfCpuMs;
    };
    const names = () => growers(monitor.store.db, { now: m.clock.t }).map((g) => g.name);
    return { monitor, tick, names, dir };
  }

  test("a tick does not wait for a walk, and a walk under way is not started again", async () => {
    const held = gate();
    const m = machine({ folders: [".cache"], du: held.du });
    const { monitor, tick, names } = fed(m);
    await tick();
    expect(names()).toEqual([]);
    m.clock.t += 10 * MINUTE;
    const before = m.clock.t;
    await tick();
    expect(monitor.last()!.at).toBe(before);
    while (!m.walks.length) await Bun.sleep(1);
    await tick();
    await tick();
    expect(m.walks.length).toBe(1);
    expect(names()).toEqual([]);
    held.open();
    while (names().length < 2) await Bun.sleep(1);
    expect(names().sort()).toEqual([TEMP, "~/.cache"]);
    monitor.stop();
  });

  test("what a walk's child processes used is on a later tick's row, once", async () => {
    const held = gate(answers(1000, 5000));
    const m = machine({ folders: [".cache"], du: held.du });
    const { monitor, tick, names } = fed(m);
    await tick();
    m.clock.t += 10 * MINUTE;
    expect(await tick()).toBeLessThan(5000);
    expect(await tick()).toBeLessThan(5000);
    held.open();
    while (names().length < 2) await Bun.sleep(1);
    const cost = await tick();
    expect(cost).toBeGreaterThanOrEqual(10_002);
    expect(cost).toBeLessThan(15_000);
    expect(await tick()).toBeLessThan(5000);
    monitor.stop();
  });

  test("stopped with a walk under way: the walk is told to end, and what it says afterwards goes nowhere", async () => {
    const held = gate();
    const m = machine({ folders: [".cache"], du: held.du });
    const { monitor, tick, dir } = fed(m);
    m.clock.t += 10 * MINUTE;
    await tick();
    while (!m.walks.length) await Bun.sleep(1);
    monitor.stop();
    expect(m.signals.map((s) => s.aborted)).toEqual([true]);
    held.open();
    await Bun.sleep(5);
    const stored = new Database(join(dir, "monitor.db"), { readonly: true });
    expect(stored.query("SELECT DISTINCT name FROM growers").all()).toEqual([]);
    stored.close();
  });

  test("a monitor that is fed its readings and told of no disk reads none", async () => {
    const dir = scratch();
    const source: Source = { read: async (now) => ({ reading: { at: now(), procs: [], host: HOST }, childCpuMs: 0 }), lookup: { launchPane: () => null, cwd: () => null, responsible: () => null } };
    const monitor = createMonitor({ dir, herdr: join(dir, "no-herdr"), now: () => T0, source });
    await monitor.tick();
    expect(monitor.failed()).toBeNull();
    expect(growers(monitor.store.db, { now: T0 })).toEqual([]);
    monitor.stop();
  });
});
