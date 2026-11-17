// THE MONITOR, around its pure core (monitor-attribution, monitor-usage and monitor-store have their own files):
//   1. monitor-ps.ts: one `ps` as rows, from recorded output.
//   2. monitor-panes.ts against a stub herdr of its own: which shell is whose, asked once and in the background, kept
//      through a bad minute, and never waited for when herdr hangs.
//   3. monitor.ts with a reader the test feeds and a clock it moves: what a tick stores, a failed reading as a gap,
//      a held secret masked, the monitor's own cost on the row, one tick at a time.
//   4. monitor-darwin.ts once against this machine (macOS only): one reading, nothing started but its `ps`.
//   5. server.ts with the monitor on (HUD_MONITOR=1), on a spare port with a throwaway data dir and a stub herdr: it
//      starts with the server, answers on its route, and writes to monitor.db, never to hud.db. And off, as a server
//      is that nobody asked to monitor. Its page is served either way. A monitor.db that is not a database, or
//      cannot be opened, leaves the server running. A replay (HUD_MONITOR_REPLAY) answers from a database that
//      scripts/monitor-fixture.ts wrote, the same on every run, and writes nothing to it but the colours.
// No test makes load: the readings are fixtures, and the real readings only look.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_END, writeFixture } from "../../scripts/monitor-fixture.ts";
import { spawnServer } from "../../scripts/room-hash.ts";
import { createMonitor, TICK_MS, type Source } from "../../src/server/monitor.ts";
import { asProcs, containerOf, ownerByFolder } from "../../src/server/monitor-containers.ts";
import { createPanes } from "../../src/server/monitor-panes.ts";
import { parsePs } from "../../src/server/monitor-ps.ts";
import type { Host, Proc } from "../../src/server/monitor-types.ts";

const dirs: string[] = [];
const scratch = () => (dirs.push(mkdtempSync(join(tmpdir(), "hq-monitor-"))), dirs[dirs.length - 1]);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("one ps, parsed", () => {
  const AT = Date.parse("2026-03-10T09:00:00Z");
  const OUT = [
    "    1     0     0 10-00:50:47 168:30.34  11872 launchd         ",
    "  345     1     0    01:02:03   0:07.50  20352 mds             ",
    " 4242   345    88       00:09   1:00:01.00   512 Window Server Xtra",
    "garbage that is not a row",
    "",
  ].join("\n");
  const rows = parsePs(OUT, AT);

  test("every row that is a row, and nothing else", () => expect(rows.map((r) => r.pid)).toEqual([1, 345, 4242]));
  test("CPU time in any of its shapes, as milliseconds", () => expect(rows.map((r) => r.cpuMs)).toEqual([(168 * 60 + 30.34) * 1000, 7500, 3_601_000]));
  test("the start, from how long ago it started", () => {
    expect(rows[0].start).toBe(AT / 1000 - (10 * 86_400 + 50 * 60 + 47));
    expect(rows[1].start).toBe(AT / 1000 - 3723);
    expect(rows[2].start).toBe(AT / 1000 - 9);
  });
  test("a name with spaces is kept whole", () => expect(rows[2].name).toBe("Window Server Xtra"));
  test("memory is the resident size and says so", () => expect(rows.map((r) => [r.mem, r.exact])).toEqual([[11872 * 1024, false], [20352 * 1024, false], [512 * 1024, false]]));
  test("what ps does not know is null, never zero", () => expect([rows[0].childCpuMs, rows[0].read, rows[0].written, rows[0].path]).toEqual([null, null, null, null]));
});

// A herdr that answers from files in its folder and logs every call. `pane process-info --pane P` answers the pid in
// shell-P, and fails when that file is missing. While it hangs it says nothing for three seconds and then nothing at
// all.
function stubHerdr() {
  const dir = scratch();
  const bin = join(dir, "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh\ncd ${JSON.stringify(dir)}\necho "$*" >> calls.log\n[ -f down ] && exit 1\n[ -f hang ] && exec sleep 3\ncase "$1 $2" in\n"pane list") cat panes.json;;\n"agent list") cat agents.json;;\n"pane process-info") [ -f "shell-$4" ] || exit 1; printf '{"result":{"process_info":{"pane_id":"%s","shell_pid":%s}}}' "$4" "$(cat "shell-$4")";;\n*) exit 2;;\nesac\n`,
  );
  chmodSync(bin, 0o755);
  const set = (panes: { pane_id: string; cwd?: string }[], agents: { name?: string; pane_id: string }[], shells: Record<string, number>) => {
    writeFileSync(join(dir, "panes.json"), JSON.stringify({ result: { panes } }));
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ result: { agents } }));
    for (const [pane, pid] of Object.entries(shells)) writeFileSync(join(dir, `shell-${pane}`), String(pid));
  };
  const calls = () => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  const flag = (name: string) => (on: boolean) => (on ? writeFileSync(join(dir, name), "") : rmSync(join(dir, name), { force: true }));
  return { dir, bin, set, calls, down: flag("down"), hang: flag("hang") };
}

describe("the panes: which shell is whose", () => {
  // A process table with these pids, each a child of herdr's server (pid 50).
  const table = (...pids: number[]): Proc[] => pids.map((pid) => ({ pid, ppid: 50, uid: 501, name: "zsh", path: "/bin/zsh", start: 1000, cpuMs: 0, childCpuMs: 0, mem: 0, exact: true, read: 0, written: 0 }));

  test("a named agent's pane is its lane; a plain pane has only its folder", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1", cwd: "/work/api" }, { pane_id: "w1:p2", cwd: "/work/notes" }], [{ name: "builder", pane_id: "w1:p1" }], { "w1:p1": 500, "w1:p2": 600 });
    const panes = await createPanes(herdr.bin, () => 0).panes(table(500, 600));
    expect(panes).toEqual([
      { pane: "w1:p1", shellPid: 500, lane: "builder", cwd: "/work/api" },
      { pane: "w1:p2", shellPid: 600, lane: null, cwd: "/work/notes" },
    ]);
  });

  // What a tick gets is the list of the asking before it. next() is the tick that starts an asking, that asking's
  // end, and the list the tick after it gets.
  const next = async (panes: ReturnType<typeof createPanes>, procs: Proc[]) => {
    await panes.panes(procs);
    await panes.settled();
    return panes.panes(procs);
  };

  test("a pane's shell is asked for once, and again only when that shell is gone", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    await panes.panes(table(500));
    clock.t += 60_000;
    await next(panes, table(500));
    const asked = () => herdr.calls().filter((c) => c.startsWith("pane process-info")).length;
    expect(asked()).toBe(1);
    herdr.set([{ pane_id: "w1:p1" }], [], { "w1:p1": 777 });
    clock.t += 60_000;
    expect(await next(panes, table(777))).toEqual([{ pane: "w1:p1", shellPid: 777, lane: null, cwd: null }]);
    expect(asked()).toBe(2);
  });

  test("herdr is asked once a minute, not once a tick", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    for (let i = 0; i < 6; i++, clock.t += 10_000) await next(panes, table(500));
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(1);
    await next(panes, table(500));
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(2);
  });

  test("the very first list is waited for; after it a tick gets the last list at once and the new one a tick later", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    expect((await panes.panes(table(500))).map((p) => p.pane)).toEqual(["w1:p1"]);
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [], { "w1:p2": 600 });
    clock.t += 60_000;
    expect((await panes.panes(table(500))).map((p) => p.pane)).toEqual(["w1:p1"]);
    await panes.settled();
    clock.t += 10_000;
    expect((await panes.panes(table(500, 600))).map((p) => p.pane)).toEqual(["w1:p1", "w1:p2"]);
  });

  test("a new shell beside the panes' shells is a new pane: herdr is asked at once, and once", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    await panes.panes(table(500));
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [{ name: "tester", pane_id: "w1:p2" }], { "w1:p2": 600 });
    clock.t += 10_000;
    expect((await next(panes, table(500, 600))).map((p) => [p.pane, p.lane])).toEqual([["w1:p1", null], ["w1:p2", "tester"]]);
    const lists = () => herdr.calls().filter((c) => c === "pane list").length;
    expect(lists()).toBe(2);
    clock.t += 10_000;
    await next(panes, table(500, 600, 700));
    clock.t += 10_000;
    await next(panes, table(500, 600, 700));
    expect(lists()).toBe(3);
  });

  // The server's own herdr sync has both lists every 20 s: given them, the minute's look starts no herdr for a list.
  test("lists that someone else has are taken, and herdr is asked for neither", async () => {
    const herdr = stubHerdr();
    herdr.set([], [], { "w1:p1": 500, "w1:p2": 600 });
    const clock = { t: 1_000_000 };
    const given = { at: clock.t, panes: [{ pane_id: "w1:p1", cwd: "/work/api" }, { pane_id: "w1:p2", cwd: "/work/notes" }], agents: [{ name: "builder", pane_id: "w1:p1" }] };
    const panes = createPanes(herdr.bin, () => clock.t, () => given);
    expect(await panes.panes(table(500, 600))).toEqual([
      { pane: "w1:p1", shellPid: 500, lane: "builder", cwd: "/work/api" },
      { pane: "w1:p2", shellPid: 600, lane: null, cwd: "/work/notes" },
    ]);
    const lists = () => herdr.calls().filter((c) => c === "pane list" || c === "agent list").length;
    expect(lists()).toBe(0);
    // A minute on, with newer lists: still neither, and the agent's new name is there.
    clock.t += 60_000;
    Object.assign(given, { at: clock.t - 5_000, agents: [{ name: "renamed", pane_id: "w1:p1" }] });
    expect((await next(panes, table(500, 600))).map((p) => p.lane)).toEqual(["renamed", null]);
    expect(lists()).toBe(0);
    expect(herdr.calls().filter((c) => c.startsWith("pane process-info")).length).toBe(2);
  });

  test("lists older than a minute are not taken: herdr is asked", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [{ name: "fresh", pane_id: "w1:p1" }], { "w1:p1": 500 });
    const clock = { t: 1_000_000 };
    const panes = createPanes(herdr.bin, () => clock.t, () => ({ at: clock.t - 61_000, panes: [{ pane_id: "w1:p1" }], agents: [{ name: "stale", pane_id: "w1:p1" }] }));
    expect((await panes.panes(table(500))).map((p) => p.lane)).toEqual(["fresh"]);
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(1);
  });

  test("a new pane is asked of herdr itself, at once, whatever lists there are", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [{ name: "tester", pane_id: "w1:p2" }], { "w1:p1": 500, "w1:p2": 600 });
    const clock = { t: 1_000_000 };
    // The lists the sync has are from before the pane was made.
    const panes = createPanes(herdr.bin, () => clock.t, () => ({ at: clock.t, panes: [{ pane_id: "w1:p1" }], agents: [] }));
    expect((await panes.panes(table(500))).map((p) => p.pane)).toEqual(["w1:p1"]);
    clock.t += 10_000;
    expect((await next(panes, table(500, 600))).map((p) => [p.pane, p.lane])).toEqual([["w1:p1", null], ["w1:p2", "tester"]]);
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(1);
  });

  test("a pane herdr could not name a shell for is asked about again before the minute is over", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    expect((await panes.panes(table(500))).length).toBe(1);
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [], { "w1:p2": 600 });
    clock.t += 20_000;
    expect((await next(panes, table(500))).map((p) => p.pane)).toEqual(["w1:p1", "w1:p2"]);
  });

  test("a herdr that fails leaves the last list standing", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [{ name: "builder", pane_id: "w1:p1" }], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    const before = await panes.panes(table(500));
    herdr.down(true);
    clock.t += 60_000;
    expect(await next(panes, table(500))).toEqual(before);
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(2);
  });

  test("a herdr that hangs holds no tick up: each gets the last list at once, and herdr is asked once while it hangs", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }], [{ name: "builder", pane_id: "w1:p1" }], { "w1:p1": 500 });
    const clock = { t: 0 };
    const panes = createPanes(herdr.bin, () => clock.t);
    const before = await panes.panes(table(500));
    herdr.hang(true);
    const began = performance.now();
    for (let i = 0; i < 6; i++) {
      clock.t += 10_000;
      expect(await panes.panes(table(500))).toEqual(before);
    }
    // Six ticks in far less than the three seconds one answer takes.
    expect(performance.now() - began).toBeLessThan(1500);
    while (herdr.calls().filter((c) => c === "pane list").length < 2) await Bun.sleep(5);
    expect(herdr.calls().filter((c) => c === "pane list").length).toBe(2);
    // herdr answers again: the asking that hung ends without a list, and the one after it brings a new one.
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [], { "w1:p2": 600 });
    herdr.hang(false);
    await panes.settled();
    clock.t += 20_000;
    expect((await next(panes, table(500))).map((p) => p.pane)).toEqual(["w1:p1", "w1:p2"]);
  }, 15_000);

  test("no herdr at all: no panes, and no error", async () => {
    expect(await createPanes(join(scratch(), "missing"), () => 0).panes(table(500))).toEqual([]);
  });

  test("a pane herdr cannot name a shell for is left out", async () => {
    const herdr = stubHerdr();
    herdr.set([{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }], [], { "w1:p1": 500 });
    expect((await createPanes(herdr.bin, () => 0).panes(table(500))).map((p) => p.pane)).toEqual(["w1:p1"]);
  });
});

describe("containers", () => {
  const listed = (more: object = {}) => ({ Id: "a0fd1d3d5e6f7a8b9c0d", Names: ["/shop-db-1"], Command: "postgres --password=hunter2", Created: 1_700_000_000, Labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": "db", "com.docker.compose.project.working_dir": "/work/shop/infra" }, ...more });
  const stats = { cpu_stats: { cpu_usage: { total_usage: 12_345_000_000 } }, memory_stats: { usage: 700 * 2 ** 20, stats: { inactive_file: 100 * 2 ** 20 } } };

  test("a container is its compose project and service, what it cannot give up, and its CPU total", () => {
    expect(containerOf(listed(), stats)).toEqual({ id: "a0fd1d3d5e6f7a8b9c0d", name: "shop: db", folder: "/work/shop/infra", startedAt: 1_700_000_000, cpuMs: 12_345, mem: 600 * 2 ** 20 });
  });
  test("without compose it is the container's own name, and nobody's folder", () => {
    expect(containerOf(listed({ Labels: {} }), stats)).toMatchObject({ name: "shop-db-1", folder: null });
  });
  test("its command line is never taken", () => {
    expect(JSON.stringify(containerOf(listed(), stats))).not.toContain("hunter2");
  });
  test("as a process it sits inside its machine, with a pid no real process has, the same every time", () => {
    const machine = proc(77, 1, "vm", 0, 9000);
    const [p] = asProcs([containerOf(listed(), stats)], machine);
    expect(p).toMatchObject({ ppid: 77, inside: 77, name: "shop: db", start: 1_700_000_000, cpuMs: 12_345, path: null, childCpuMs: null });
    expect(p.pid).toBeLessThan(0);
    expect(asProcs([containerOf(listed(), stats)], machine)[0].pid).toBe(p.pid);
    expect(asProcs([containerOf(listed({ Id: "ffff1d3d5e6f7a8b9c0d" }), stats)], machine)[0].pid).not.toBe(p.pid);
  });

  const builder = { kind: "lane" as const, owner: "builder", name: "zsh" };
  const tester = { kind: "lane" as const, owner: "tester", name: "zsh" };
  const whose = (folder: string | null, running: { folder: string; owner: typeof builder }[]) => ownerByFolder(folder, running, "/home/u")?.owner ?? null;
  test("it is the lane's that runs in its folder, or up to two folders above it", () => {
    const running = [{ folder: "/work/shop", owner: builder }];
    expect(whose("/work/shop", running)).toBe("builder");
    expect(whose("/work/shop/infra/docker", running)).toBe("builder");
    expect(whose("/work/shop/a/b/c", running)).toBeNull();
    expect(whose("/work/shop-two", running)).toBeNull();
    expect(whose(null, running)).toBeNull();
  });
  test("the deepest folder decides, and two lanes in one folder decide nothing", () => {
    expect(whose("/work/shop/api", [{ folder: "/work/shop", owner: builder }, { folder: "/work/shop/api", owner: tester }])).toBe("tester");
    expect(whose("/work/shop", [{ folder: "/work/shop", owner: builder }, { folder: "/work/shop", owner: tester }])).toBeNull();
    expect(whose("/work/shop", [{ folder: "/work/shop", owner: builder }, { folder: "/work/shop", owner: { ...builder, name: "bun" } }])).toBe("builder");
  });
  test("a lane that runs in the home folder or the root owns nothing by it", () => {
    expect(whose("/home/u/shop", [{ folder: "/home/u", owner: builder }])).toBeNull();
    expect(whose("/srv", [{ folder: "/", owner: builder }])).toBeNull();
  });
});

const HOST: Host = {
  cores: 8, busyMs: 0, idleMs: 0, load1: 1, memTotal: 16 * 2 ** 30, memFree: 2 ** 30, memWired: 2 ** 30, memApp: 8 * 2 ** 30, memCached: 2 ** 30, memCompressed: 2 ** 30, memStored: 3 * 2 ** 30,
  swapTotal: 0, swapUsed: 0, pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotal: 100 * 2 ** 30, diskFree: 40 * 2 ** 30, bootAt: 1_700_000_000,
};
const proc = (pid: number, ppid: number, name: string, cpuMs: number, memMb: number, more: Partial<Proc> = {}): Proc => ({ pid, ppid, uid: 501, name, path: `/opt/tools/${name}`, start: 1000, cpuMs, childCpuMs: 0, mem: memMb * 2 ** 20, exact: true, read: 0, written: 0, ...more });

// A monitor fed by the test: each tick takes the next reading (or throws, for a reading that fails), ten seconds on.
function fed({ cwd = () => null as string | null, containers, ...opts }: { mask?: (text: string) => string; cwd?: () => string | null; containers?: Source["containers"] } = {}) {
  const dir = scratch();
  const herdr = stubHerdr();
  herdr.set([{ pane_id: "w1:p1", cwd: "/work/api" }], [{ name: "builder", pane_id: "w1:p1" }], { "w1:p1": 500 });
  const clock = { t: Date.parse("2026-03-10T09:00:00Z") };
  let next: { procs: Proc[]; busyMs: number } | Error = new Error("no reading");
  const asked: number[] = [];
  const source: Source = {
    async read(now) {
      if (next instanceof Error) throw next;
      return { reading: { at: now(), procs: next.procs, host: { ...HOST, busyMs: next.busyMs } }, childCpuMs: 7 };
    },
    lookup: { launchPane: (p) => (asked.push(p.pid), p.pid === 900 ? "w1:p1" : null), cwd, responsible: () => null },
    containers,
  };
  const monitor = createMonitor({ dir, herdr: herdr.bin, now: () => clock.t, source, ...opts });
  const tick = async (reading: { procs: Proc[]; busyMs: number } | Error) => {
    next = reading;
    await monitor.tick();
    clock.t += TICK_MS;
  };
  const stored = () => new Database(join(dir, "monitor.db"), { readonly: true });
  return { monitor, tick, stored, dir, asked, herdr };
}
const shell = proc(500, 1, "zsh", 0, 5);

describe("a tick", () => {
  test("stores who used what since the tick before, under the lane that ran it", async () => {
    const m = fed();
    await m.tick({ procs: [shell, proc(501, 500, "bun", 1000, 300)], busyMs: 10_000 });
    await m.tick({ procs: [shell, proc(501, 500, "bun", 4000, 400)], busyMs: 13_500 });
    const last = m.monitor.last()!;
    expect(last.host.dtMs).toBe(TICK_MS);
    expect(last.host.busyMs).toBe(3500);
    expect(last.host.heldKb).toBe(last.rows.reduce((kb, r) => kb + r.memKb, 0));
    expect(last.host.heldKb).toBe(405 * 1024);
    expect(last.rows.find((r) => r.kind === "lane" && r.owner === "builder" && r.name === "bun")).toMatchObject({ cpuMs: 3000, memKb: 400 * 1024, n: 1 });
    expect(last.rows.find((r) => r.kind === "lost")?.cpuMs).toBe(500);
    const db = m.stored();
    const rows = db.query("SELECT s.kind, s.owner, s.name, r.cpu_ms FROM raw r JOIN series s ON s.id = r.sid WHERE r.cpu_ms > 0 ORDER BY r.cpu_ms DESC").all();
    expect(rows).toEqual([{ kind: "lane", owner: "builder", name: "bun", cpu_ms: 3000 }, { kind: "lost", owner: "kernel and unattributed", name: "(unattributed)", cpu_ms: 500 }]);
    expect((db.query("SELECT COUNT(*) AS n FROM host_raw").get() as { n: number }).n).toBe(2);
    db.close();
    m.monitor.stop();
  });

  test("a tree a lane started and detached is still the lane's, and its pane is asked for once while it lives", async () => {
    const m = fed();
    const detached = [proc(900, 1, "tmux", 0, 5), proc(901, 900, "node", 1000, 2000)];
    await m.tick({ procs: [shell, ...detached], busyMs: 0 });
    await m.tick({ procs: [shell, ...detached], busyMs: 0 });
    expect(m.monitor.last()!.rows.find((r) => r.name === "node")).toMatchObject({ kind: "lane", owner: "builder", memKb: 2000 * 1024 });
    expect(m.asked.filter((pid) => pid === 900).length).toBe(1);
    await m.tick({ procs: [shell], busyMs: 0 });
    await m.tick({ procs: [shell, { ...detached[0], start: 2000 }], busyMs: 0 });
    expect(m.asked.filter((pid) => pid === 900).length).toBe(2);
    m.monitor.stop();
  });

  test("a virtual machine's containers get rows of their own, the lane's when it runs where they were started", async () => {
    const box = (name: string, folder: string | null, cpuMs: number, memMb: number) => ({ id: `${name}00aa11bb22cc`.replace(/[^0-9a-f]/g, "0"), name, folder, startedAt: 1000, cpuMs, mem: memMb * 2 ** 20 });
    let cpu = 0;
    const m = fed({ containers: async () => ({ machine: "vm", containers: [box("shop: db", "/work/api/infra", (cpu += 400), 600), box("cache", null, 50, 200)] }) });
    const vm = (cpuMs: number) => proc(77, 1, "vm", cpuMs, 9000, { path: "/Applications/Engine.app/Contents/MacOS/vm" });
    await m.tick({ procs: [shell, vm(1000)], busyMs: 0 });
    await m.tick({ procs: [shell, vm(3000)], busyMs: 2000 });
    const rows = m.monitor.last()!.rows;
    expect(rows.find((r) => r.name === "shop: db")).toMatchObject({ kind: "lane", owner: "builder", cpuMs: 400, memKb: 600 * 1024 });
    expect(rows.find((r) => r.name === "cache")).toMatchObject({ kind: "app", owner: "Engine", memKb: 200 * 1024 });
    expect(rows.find((r) => r.name === "vm")).toMatchObject({ kind: "app", owner: "Engine", cpuMs: 1600, memKb: 8200 * 1024 });
    m.monitor.stop();
  });

  test("a virtual machine that does not answer leaves its process whole", async () => {
    const m = fed({ containers: async () => Promise.reject(new Error("no answer")) });
    await m.tick({ procs: [shell, proc(77, 1, "vm", 1000, 9000)], busyMs: 0 });
    expect(m.monitor.failed()).toBeNull();
    expect(m.monitor.last()!.rows.find((r) => r.name === "vm")?.memKb).toBe(9000 * 1024);
    m.monitor.stop();
  });

  test("a reading that fails leaves a gap, and the reading after it does not count the gap as one long tick", async () => {
    const m = fed();
    await m.tick({ procs: [shell, proc(501, 500, "bun", 1000, 300)], busyMs: 10_000 });
    await m.tick(new Error("the table could not be read"));
    expect(m.monitor.failed()).toBe("the table could not be read");
    await m.tick({ procs: [shell, proc(501, 500, "bun", 9000, 300)], busyMs: 30_000 });
    expect(m.monitor.failed()).toBeNull();
    const db = m.stored();
    expect(db.query("SELECT dt_ms, busy_ms FROM host_raw ORDER BY t").all()).toEqual([{ dt_ms: 0, busy_ms: 0 }, { dt_ms: 0, busy_ms: 0 }]);
    expect((db.query("SELECT COALESCE(SUM(cpu_ms), 0) AS cpu FROM raw").get() as { cpu: number }).cpu).toBe(0);
    db.close();
    m.monitor.stop();
  });

  test("a held secret in a name or an owner never reaches the database", async () => {
    const SECRET = "sk-live-0123456789abcdef";
    const m = fed({ mask: (text) => text.replaceAll(SECRET, "•••"), cwd: () => `/work/${SECRET}/api` });
    await m.tick({ procs: [shell, proc(501, 500, `run-${SECRET}`, 1000, 300), proc(700, 1, "stray", 0, 300)], busyMs: 0 });
    m.monitor.stop();
    for (const file of ["monitor.db", "monitor.db-wal"]) {
      const bytes = (() => {
        try {
          return readFileSync(join(m.dir, file)).toString("latin1");
        } catch {
          return "";
        }
      })();
      expect(bytes.includes(SECRET)).toBe(false);
    }
    expect(m.monitor.last()!.rows.some((r) => r.name === "run-•••")).toBe(true);
    expect(m.monitor.last()!.rows.find((r) => r.name === "stray")?.owner).toBe("…/•••/api");
  });

  test("a herdr that hangs holds no tick up, and the lane keeps what it runs", async () => {
    const m = fed();
    await m.tick({ procs: [shell, proc(501, 500, "bun", 1000, 300)], busyMs: 0 });
    m.herdr.hang(true);
    const began = performance.now();
    // Seven ticks are 70 seconds on the monitor's clock: the list comes due in them, and herdr does not answer.
    for (let i = 1; i <= 7; i++) await m.tick({ procs: [shell, proc(501, 500, "bun", 1000 + i * 100, 300)], busyMs: 0 });
    expect(performance.now() - began).toBeLessThan(1500);
    expect(m.monitor.failed()).toBeNull();
    expect(m.monitor.last()!.rows.find((r) => r.name === "bun")).toMatchObject({ kind: "lane", owner: "builder", cpuMs: 100 });
    const db = m.stored();
    expect((db.query("SELECT COUNT(*) AS n FROM host_raw").get() as { n: number }).n).toBe(8);
    db.close();
    m.monitor.stop();
  });

  test("one tick at a time: the tick a start begins with and one asked for beside it are the same tick", async () => {
    const dir = scratch();
    let reads = 0;
    let release = () => {};
    const held = new Promise<void>((open) => (release = open));
    const source: Source = {
      async read(now) {
        reads++;
        await held;
        return { reading: { at: now(), procs: [shell], host: HOST }, childCpuMs: 0 };
      },
      lookup: { launchPane: () => null, cwd: () => null, responsible: () => null },
    };
    const clock = { t: Date.parse("2026-03-10T09:00:00Z") };
    const monitor = createMonitor({ dir, herdr: join(dir, "no-herdr"), now: () => clock.t, source });
    monitor.start();
    const beside = [monitor.tick(), monitor.tick()];
    await Bun.sleep(20);
    expect(reads).toBe(1);
    release();
    await Promise.all(beside);
    expect(reads).toBe(1);
    expect((monitor.store.db.query("SELECT COUNT(*) AS n FROM host_raw").get() as { n: number }).n).toBe(1);
    clock.t += TICK_MS;
    await monitor.tick();
    expect(reads).toBe(2);
    monitor.stop();
  });

  test("the row says what the monitor itself cost: its own CPU and that of what it started", async () => {
    const m = fed();
    await m.tick({ procs: [shell, proc(process.pid, 500, "bun", 0, 64)], busyMs: 0 });
    const { selfCpuMs, selfMemKb } = m.monitor.last()!.host;
    expect(selfCpuMs).toBeGreaterThan(7);
    expect(selfMemKb).toBe(64 * 1024);
    m.monitor.stop();
  });
});

describe.skipIf(process.platform !== "darwin")("one reading of this machine", () => {
  test("finds this process with its footprint, the system's processes, and a host that adds up", async () => {
    const { readDarwin } = await import("../../src/server/monitor-darwin.ts");
    const { reading } = await readDarwin();
    const me = reading.procs.find((p) => p.pid === process.pid)!;
    expect(me.exact).toBe(true);
    expect(me.mem).toBeGreaterThan(2 ** 20);
    expect(me.path).toBe(process.execPath);
    expect(me.name).toBe("bun");
    expect(me.ppid).toBe(process.ppid);
    expect(Math.abs(me.start - (Date.now() / 1000 - process.uptime()))).toBeLessThan(3);
    const used = process.cpuUsage();
    expect(me.cpuMs).toBeGreaterThan(0);
    expect(me.cpuMs).toBeLessThanOrEqual((used.user + used.system) / 1000 + 1);
    expect(me.cpuMs).toBeGreaterThan((used.user + used.system) / 1000 - 250);
    const init = reading.procs.find((p) => p.pid === 1)!;
    expect([init.uid, init.exact, init.name]).toEqual([0, false, "launchd"]);
    expect(init.cpuMs).toBeGreaterThan(0);
    const h = reading.host;
    const parts = h.memFree + h.memWired + h.memApp + h.memCached + h.memCompressed;
    expect(parts).toBeGreaterThan(h.memTotal * 0.8);
    expect(parts).toBeLessThanOrEqual(h.memTotal * 1.02);
    expect(h.busyMs + h.idleMs).toBeGreaterThan(0);
    expect([1, 2, 4]).toContain(h.pressure!);
    expect(h.diskFree!).toBeLessThan(h.diskTotal!);
    expect(h.bootAt!).toBeLessThan(Date.now() / 1000);
    expect(h.bootAt!).toBeGreaterThan(Date.now() / 1000 - 400 * 86_400);
  });

  test("says where a process runs, which pane it was started from, and takes nothing else from its environment", async () => {
    const { readDarwin, lookup } = await import("../../src/server/monitor-darwin.ts");
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(20000)"], { cwd: tmpdir(), env: { ...process.env, HERDR_PANE_ID: "w9:test", HUD_TEST_TOKEN: "not-to-be-read" }, stdout: "ignore", stderr: "ignore" });
    try {
      let seen: Proc | undefined;
      for (let i = 0; i < 40 && !seen; i++, await Bun.sleep(50)) seen = (await readDarwin()).reading.procs.find((p) => p.pid === child.pid);
      expect(lookup.launchPane(seen!)).toBe("w9:test");
      expect(realpathSync(lookup.cwd(seen!)!)).toBe(realpathSync(tmpdir()));
      expect(lookup.responsible(seen!)).toBeGreaterThan(0);
      expect(seen!.ppid).toBe(process.pid);
    } finally {
      child.kill();
    }
  });

  test("a child that was seen and has exited, but is not collected yet, stays in the table with no memory", async () => {
    const { readDarwin } = await import("../../src/server/monitor-darwin.ts");
    // A parent that does not collect its child: the child lives for a second, then waits.
    const parent = Bun.spawn(["/usr/bin/perl", "-e", "if (fork() == 0) { sleep 1; exit 0 } sleep 30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const child = async () => (await readDarwin()).reading.procs.find((p) => p.ppid === parent.pid);
      let alive: Proc | undefined;
      for (let i = 0; i < 20 && !alive; i++, await Bun.sleep(50)) alive = await child();
      expect(alive!.mem).toBeGreaterThan(0);
      let waiting = alive;
      for (let i = 0; i < 60 && waiting?.mem !== 0; i++, await Bun.sleep(100)) waiting = await child();
      expect(waiting).toMatchObject({ pid: alive!.pid, ppid: parent.pid, start: alive!.start, mem: 0 });
      expect(waiting!.cpuMs).toBeGreaterThanOrEqual(alive!.cpuMs);
      expect((await child())?.pid).toBe(alive!.pid);
    } finally {
      parent.kill("SIGKILL");
    }
  });
});

describe("with the server", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  // No server here reads the disk growers: a walk of the real folders is not a test's to start. monitor is what
  // HUD_MONITOR says, and undefined a server that was told nothing, whatever this test run was started with.
  const serve = (data: string, herdr: string, monitor: string | undefined) => {
    const { HUD_MONITOR: _, ...env } = process.env;
    return spawnServer({ cwd: ROOT, env: { ...env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_MONITOR_DISK: "0", ...(monitor === undefined ? {} : { HUD_MONITOR: monitor }) } });
  };
  const stateOf = async (base: string) => (await (await fetch(`${base}/api/state`)).json()) as Record<string, any>;
  const PARTS = ["now", "range?key=day", "days", "incidents", "patterns", "events", "moment", "growers"];
  const pageOf = async (base: string) => {
    const res = await fetch(`${base}/monitor`);
    return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"), policy: res.headers.get("content-security-policy") ?? "", body: await res.text() };
  };
  const isThePage = (seen: Awaited<ReturnType<typeof pageOf>>) => {
    expect([seen.status, seen.type, seen.cache]).toEqual([200, "text/html; charset=utf-8", "no-cache"]);
    expect(seen.body).toBe(readFileSync(join(ROOT, "public", "monitor.html"), "utf8"));
    // What the page may load: itself and its two fonts.
    expect(seen.policy).toContain("default-src 'none'");
    expect(seen.policy.match(/https?:\/\/[^\s;]+/g)).toEqual(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
  };

  test.skipIf(process.platform !== "darwin")(
    "on: it ticks at once, answers on its route, and keeps to a database of its own",
    async () => {
      const data = scratch();
      const server = await serve(data, stubHerdr().bin, "1");
      try {
        let now: any = {};
        for (let i = 0; i < 100 && !now.at; i++, await Bun.sleep(100)) now = await (await fetch(`${server.base}/api/monitor/now`)).json();
        expect(now).toMatchObject({ on: true, failed: null });
        expect(now.size.limit).toBeGreaterThan(now.size.bytes);
        expect(now.host.memTotalKb).toBeGreaterThan(0);
        expect(now.rows.some((r: any) => r.kind === "hq" && r.owner === "HQ Office" && r.memKb > 0)).toBe(true);
        expect(JSON.stringify(now)).not.toContain("server.ts");
        const part = async (path: string) => (await fetch(`${server.base}/api/monitor/page/${path}`)).json() as Promise<any>;
        const seen = await part("now");
        expect(seen.now.state).toBeGreaterThanOrEqual(0);
        expect(seen.now.headline).toMatch(/^\S+ is |^Memory |^CPU |^The disk |^Heat /);
        expect(seen.holders.find((h: any) => h.id === "hq")).toMatchObject({ name: "HQ Office", kind: "hq" });
        expect(seen.self.dbLimitMB).toBe(500);
        const hour = await part("range?key=hour");
        expect([hour.key, hour.n, hour.step]).toEqual(["hour", 60, 60_000]);
        // Not the last sample alone: when a minute turns between the first tick and this answer, the newest step is
        // still empty.
        expect(hour.host.held.some((gb: number | null) => (gb ?? 0) > 0)).toBe(true);
        expect((await part("range?key=nonsense")).key).toBe("hour");
        expect((await part("range?key=quarter")).n).toBe(360);
        expect(Array.isArray(await part("days"))).toBe(true);
        expect((await part("incidents")).incidents).toEqual([]);
        expect((await part("patterns")).patterns).toEqual([]);
        expect((await part(`moment?key=hour&t=${Date.now()}`))?.holders?.length ?? 0).toBeGreaterThan(0);
        expect(Math.abs(seen.asOf - Date.now())).toBeLessThan(10_000);
        expect(await part("growers")).toEqual([]);
        isThePage(await pageOf(server.base));
        const cli = (...args: string[]) => Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base }, stdout: "ignore", stderr: "ignore" }).exited;
        expect(await cli("monitor", "mark", "full", "suite", "started", "--kind", "suite")).toBe(0);
        const marks = (await (await fetch(`${server.base}/api/monitor/marks?hours=1`)).json()) as { at: number; kind: string; label: string }[];
        expect(marks.filter((m) => m.kind === "suite").map((m) => m.label)).toEqual(["full suite started"]);
        expect(Math.abs(marks.find((m) => m.kind === "suite")!.at - Date.now())).toBeLessThan(10_000);
        // The timeline is kept for a minute: a mark written behind the server's back is not seen, and one put down
        // through the server drops what is kept. However many hours are asked for, it reaches back 90 days.
        const behind = new Database(join(data, "monitor.db"));
        // The server writes a tick to this file every ten seconds: wait for it, should the two meet.
        behind.exec("PRAGMA busy_timeout = 5000");
        const put = behind.query("INSERT INTO marks (t, kind, label) VALUES (?, 'note', ?)");
        put.run(Math.round(Date.now() / 1000), "behind its back");
        put.run(Math.round(Date.now() / 1000) - 100 * 86_400, "a hundred days old");
        behind.close();
        const labels = async (path: string) => ((await (await fetch(`${server.base}/api/monitor/${path}`)).json()) as { label: string }[]).map((m) => m.label);
        expect(await labels("marks?hours=1")).not.toContain("behind its back");
        expect(await cli("monitor", "mark", "second", "mark")).toBe(0);
        expect(await labels("marks?hours=1")).toEqual(expect.arrayContaining(["behind its back", "second mark"]));
        expect(await labels("page/events?hours=1")).toEqual(expect.arrayContaining(["Behind its back", "Second mark"]));
        expect(await labels("marks?hours=99999")).toEqual(expect.arrayContaining(["second mark"]));
        expect(await labels("marks?hours=99999")).not.toContain("a hundred days old");
        const own = new Database(join(data, "monitor.db"), { readonly: true });
        expect((own.query("SELECT COUNT(*) AS n FROM host_raw").get() as { n: number }).n).toBeGreaterThan(0);
        own.close();
        const hud = new Database(join(data, "hud.db"), { readonly: true });
        expect(hud.query("SELECT name FROM sqlite_master WHERE name IN ('raw', 'host_raw', 'roll', 'host_roll', 'series')").all()).toEqual([]);
        hud.close();
      } finally {
        await server.stop();
      }
    },
    30_000,
  );

  // A server that was told nothing is the one a test, a script or a lane starts: it must not sample this machine.
  for (const [told, monitor] of [["told nothing", undefined], ["told HUD_MONITOR=0", "0"]] as const) {
    test(
      `off for a server that was ${told}: the route says so, and nothing is read or written`,
      async () => {
        const data = scratch();
        const herdr = stubHerdr();
        const server = await serve(data, herdr.bin, monitor);
        try {
          expect(await (await fetch(`${server.base}/api/monitor/now`)).json()).toEqual({ on: false });
          const mark = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), "monitor", "mark", "nobody keeps this"], { env: { ...process.env, HUD_URL: server.base }, stdout: "ignore", stderr: "ignore" });
          expect(await mark.exited).toBe(0);
          expect(await (await fetch(`${server.base}/api/monitor/marks`)).json()).toEqual([]);
          for (const path of PARTS) expect(await (await fetch(`${server.base}/api/monitor/page/${path}`)).json()).toEqual({ on: false });
          // The page is served all the same, and says for itself that the monitor is off.
          isThePage(await pageOf(server.base));
          // Nothing of the monitor is in the HUD's state, so MACHINES goes by its own readings.
          expect("monitor" in (await stateOf(server.base))).toBe(false);
          expect(existsSync(join(data, "monitor.db"))).toBe(false);
        } finally {
          await server.stop();
        }
      },
      30_000,
    );
  }

  test.skipIf(process.platform !== "darwin")(
    "a monitor.db that is not a database is set aside and a new one started: the server runs, and the monitor says what it did",
    async () => {
      const data = scratch();
      const garbage = "this was never a database\n".repeat(400);
      writeFileSync(join(data, "monitor.db"), garbage);
      writeFileSync(join(data, "monitor.db-wal"), "nor was this its log");
      const server = await serve(data, stubHerdr().bin, "1");
      try {
        expect((await stateOf(server.base)).config).toBeDefined();
        let now: any = {};
        for (let i = 0; i < 100 && !now.at; i++, await Bun.sleep(100)) now = await (await fetch(`${server.base}/api/monitor/now`)).json();
        expect(now).toMatchObject({ on: true, failed: null });
        expect(now.setAside).toMatch(/^monitor\.db\.broken-\d{8}T\d{6}Z$/);
        expect(readFileSync(join(data, now.setAside), "utf8")).toBe(garbage);
        // Its log went with it: none of the old file is left under the new database's name.
        expect(existsSync(join(data, `${now.setAside}-wal`))).toBe(true);
        expect(readFileSync(join(data, "monitor.db-wal"), "latin1")).not.toContain("nor was this its log");
        const events = (await (await fetch(`${server.base}/api/monitor/page/events?hours=1`)).json()) as { kind: string; label: string }[];
        expect(events.filter((e) => e.kind === "monitor").map((e) => e.label)).toEqual([`The monitor's database could not be read and was set aside as ${now.setAside}. Recording began anew.`]);
        expect((await (await fetch(`${server.base}/api/monitor/page/now`)).json()).now.state).toBeGreaterThanOrEqual(0);
        const own = new Database(join(data, "monitor.db"), { readonly: true });
        expect((own.query("SELECT COUNT(*) AS n FROM host_raw").get() as { n: number }).n).toBeGreaterThan(0);
        own.close();
      } finally {
        await server.stop();
      }
    },
    30_000,
  );

  // Only the monitor's own file is in the way: hud.db is made beside it as ever.
  const BLOCKED: [string, (path: string) => void][] = [
    ["is a folder", (path) => mkdirSync(path)],
    ["may not be written", (path) => (writeFileSync(path, ""), chmodSync(path, 0o444))],
  ];
  for (const [how, block] of BLOCKED) {
    test.skipIf(process.platform !== "darwin")(
      `a monitor.db that ${how} cannot be opened: the server runs, and the monitor is off and says why`,
      async () => {
        const data = scratch();
        block(join(data, "monitor.db"));
        const before = statSync(join(data, "monitor.db"));
        const server = await serve(data, stubHerdr().bin, "1");
        try {
          const state = await stateOf(server.base);
          expect(state.config).toBeDefined();
          expect("monitor" in state).toBe(false);
          const now = (await (await fetch(`${server.base}/api/monitor/now`)).json()) as { on: boolean; failed: string };
          expect(now.on).toBe(false);
          expect(now.failed).toMatch(/^The monitor's database, monitor\.db in the data folder, could not be opened \(.+\), so the monitor is off and there is nothing to draw\. The rest of HQ Office runs as usual\./);
          for (const path of PARTS) expect(await (await fetch(`${server.base}/api/monitor/page/${path}`)).json()).toEqual({ on: false, failed: now.failed });
          const marked = await fetch(`${server.base}/api/monitor/marks`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ text: "not kept" }) });
          expect(await marked.json()).toEqual({ ok: true, kept: false });
          expect(await (await fetch(`${server.base}/api/monitor/marks`)).json()).toEqual([]);
          isThePage(await pageOf(server.base));
          const after = statSync(join(data, "monitor.db"));
          expect([after.isDirectory(), after.size]).toEqual([before.isDirectory(), before.size]);
          expect(existsSync(join(data, "hud.db"))).toBe(true);
        } finally {
          await server.stop();
        }
      },
      30_000,
    );
  }
});

describe("a replay", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  // Told nothing about HUD_MONITOR: a replay samples nothing, so it needs no leave to.
  const replay = (folder: string, data: string) => {
    const { HUD_MONITOR: _, ...env } = process.env;
    return spawnServer({ cwd: ROOT, env: { ...env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: stubHerdr().bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_MONITOR_DISK: "0", HUD_MONITOR_REPLAY: folder } });
  };
  const counts = (file: string) => {
    const db = new Database(file, { readonly: true });
    const n = Object.fromEntries(["host_raw", "raw", "host_roll", "roll", "series", "marks", "growers"].map((table) => [table, (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
    db.close();
    return n;
  };

  test(
    "the recorded hour is shown as if its newest sample were now, the same on every run, and nothing is sampled",
    async () => {
      const [folder, data] = [scratch(), scratch()];
      const { file } = writeFixture(folder, "capped");
      const before = counts(file);
      const server = await replay(folder, data);
      try {
        const part = async (path: string) => (await fetch(`${server.base}/api/monitor/page/${path}`)).json() as Promise<any>;
        const seen = await part("now");
        expect([seen.asOf, seen.now.t]).toEqual([FIXTURE_END, FIXTURE_END]);
        expect(seen.now).toMatchObject({ state: 2, limiter: "memory", kernelLevel: "critical" });
        // The HUD's state says of this machine what the monitor's page says, for MACHINES in the top bar.
        expect(((await (await fetch(`${server.base}/api/state`)).json()) as any).monitor).toEqual({ machine: "local", state: seen.now.state, said: "Capped by memory" });
        expect(seen.now.sentence).toMatch(/^Lane builder \(\d+\.\d GB\)/);
        // The colours are given at once, to the largest: there is no first quarter of an hour to wait for.
        expect(seen.holders.find((h: any) => h.id === "lane:builder").slot).toBe(1);
        const hour = await part("range?key=hour");
        expect(hour.t0 + (hour.n - 1) * hour.step).toBe(FIXTURE_END - 60_000);
        expect(hour.host.held.every((v: number | null) => v !== null)).toBe(true);
        expect([hour.host.state.at(-1), hour.host.limiter.at(-1), hour.host.level.at(-1)]).toEqual([2, 1, 2]);
        expect((await part("incidents")).incidents.map((i: any) => [i.resource, i.severity])).toEqual([["memory", 2]]);
        expect((await part("events?hours=2")).map((e: any) => [e.kind, e.label])).toEqual([["test-run", "Full suite started"]]);
        const grown = await part("growers");
        expect(grown.map((g: any) => [g.name, g.overDays])).toEqual([["~/Library/Caches", 20], ["Xcode DerivedData", 20], ["Package caches", 20], ["Temp folders", 20]]);
        expect((await part(`moment?key=hour&t=${FIXTURE_END - 30 * 60_000}`)).holders.length).toBeGreaterThan(0);
        // No sampler: nothing of this machine's, and a mark is not kept.
        expect(await (await fetch(`${server.base}/api/monitor/now`)).json()).toEqual({ on: false });
        const marked = await fetch(`${server.base}/api/monitor/marks`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ text: "not kept" }) });
        expect(await marked.json()).toEqual({ ok: true, kept: false });
        expect(existsSync(join(data, "monitor.db"))).toBe(false);
        const again = await part("now");
        expect(again.now).toEqual(seen.now);
      } finally {
        await server.stop();
      }
      expect(counts(file)).toEqual(before);
    },
    30_000,
  );

  test("the calm hour has nothing short in it", async () => {
    const [folder, data] = [scratch(), scratch()];
    writeFixture(folder, "calm");
    const server = await replay(folder, data);
    try {
      const part = async (path: string) => (await fetch(`${server.base}/api/monitor/page/${path}`)).json() as Promise<any>;
      expect((await part("now")).now).toMatchObject({ t: FIXTURE_END, state: 0, limiter: null, kernelLevel: "normal" });
      expect(new Set((await part("range?key=hour")).host.state)).toEqual(new Set([0]));
      expect((await part("incidents")).incidents).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe("hud monitor mark", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const mark = async (url: string, ...args: string[]) => {
    const began = performance.now();
    const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), "monitor", ...args], { env: { ...process.env, HUD_URL: url }, stdout: "ignore", stderr: "ignore" });
    return { code: await proc.exited, ms: performance.now() - began };
  };

  test("with no HUD there, it still ends well and at once", async () => {
    const { code, ms } = await mark("http://127.0.0.1:9", "mark", "full suite started");
    expect(code).toBe(0);
    expect(ms).toBeLessThan(3000);
  });

  test("with a HUD that never answers, it gives up after a second and a half and still ends well", async () => {
    const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
    try {
      const { code, ms } = await mark(`http://127.0.0.1:${silent.port}`, "mark", "full suite started");
      expect(code).toBe(0);
      expect(ms).toBeLessThan(4000);
    } finally {
      silent.stop(true);
    }
  });

  test("called without a text, it says how and still ends well", async () => {
    expect((await mark("http://127.0.0.1:9", "mark")).code).toBe(0);
  });
});
