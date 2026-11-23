// THE MONITOR: where this machine's CPU, memory, swap and disk go, by lane, app, HQ Office and the system, every
// ten seconds, into a database of its own (monitor.db in the data folder, never hud.db). One tick reads the machine
// (monitor-darwin.ts), finds each process's owner (monitor-attribution.ts), works out what was used since the tick
// before (monitor-usage.ts) and stores it (monitor-store.ts). It knows nothing of the server: the route file starts
// it, and scripts/monitor-probe.ts runs it alone. docs/monitor.md has the model and the arithmetic.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { attribute } from "./monitor-attribution.ts";
import { asProcs, ownerByFolder, type Container } from "./monitor-containers.ts";
import { createDisk, type Spawn } from "./monitor-disk.ts";
import { createPanes, type Lists } from "./monitor-panes.ts";
import { openOrRenew } from "./monitor-store.ts";
import type { HostUsage, Lookup, Owner, Proc, Reading, Usage } from "./monitor-types.ts";
import { usage } from "./monitor-usage.ts";

// Ten seconds: a tick costs about 30 ms of CPU, so 8640 ticks a day are 0.3% of one core, inside the limit of 0.5%.
// Five seconds would break the limit; thirty would average away a test run's spikes.
export const TICK_MS = 10_000;
const PRUNE_MS = 15 * 60_000;
// What one tick's prune may do: about the rows of a quarter of an hour (224 series a tick here) and 8 MB given back.
// A prune that is behind (the first after days away) takes a step every tick until it has caught up.
const PRUNE_STEP = { rows: 25_000, pages: 2_048 };

export type Tick = { at: number; host: HostUsage; rows: Usage[] };
// A source reads the machine: one reading with the CPU the processes it started used, what attribution may ask
// about single processes, and, where there is a virtual machine with containers, what runs inside it.
export type Source = {
  read: (now: () => number) => Promise<{ reading: Reading; childCpuMs: number }>;
  lookup: Lookup;
  containers?: () => Promise<{ machine: string; containers: Container[] } | null>;
};

// The pane a process was started from and the app responsible for it do not change while it lives: each is asked
// once per process, and forgotten when the process is gone.
function remembering(lookup: Lookup) {
  const panes = new Map<string, string | null>();
  const responsible = new Map<string, number | null>();
  const key = (p: Proc) => `${p.pid}:${p.start}`;
  const once = <T>(memo: Map<string, T>, ask: (p: Proc) => T) => (p: Proc) => {
    const k = key(p);
    if (!memo.has(k)) memo.set(k, ask(p));
    return memo.get(k) as T;
  };
  return {
    lookup: { launchPane: once(panes, lookup.launchPane), responsible: once(responsible, lookup.responsible), cwd: lookup.cwd },
    forget(alive: Proc[]) {
      const keys = new Set(alive.map(key));
      for (const memo of [panes, responsible]) for (const k of memo.keys()) if (!keys.has(k)) memo.delete(k);
    },
  };
}

// ticked is called after every tick that was stored, for whoever follows what the monitor says.
export function createMonitor(opts: { dir: string; herdr: string; now?: () => number; mask?: (text: string) => string; source?: Source; disk?: { home: string; spawn?: Spawn }; ticked?: () => void; lists?: () => Lists | null }) {
  const now = opts.now ?? Date.now;
  // The macOS source opens system libraries when it loads, so it loads at the first tick, not with this file: a
  // server on another system can still import the monitor and leave it off.
  let source: (Source & { known: ReturnType<typeof remembering> }) | null = opts.source ? { ...opts.source, known: remembering(opts.source.lookup) } : null;
  const collect = !opts.source;
  const mask = opts.mask ?? ((text: string) => text);
  const { store, setAside } = openOrRenew(join(opts.dir, "monitor.db"), now());
  // Said on the timeline too, at the place where the history ends that the new database does not have.
  if (setAside) store.mark(now(), "monitor", `The monitor's database could not be read and was set aside as ${setAside}. Recording began anew.`);
  const panes = createPanes(opts.herdr, now, opts.lists);
  const ctx = { self: process.pid, uid: userInfo().uid, home: homedir() };
  // The disk is read only when the caller says whose: a walk of the large folders costs a minute of CPU, and no
  // probe, test or server that is only being tried out should start one by leaving an option out.
  const disk = opts.disk ? createDisk({ store, now, ...opts.disk }) : null;
  const cpuNow = () => {
    const used = process.cpuUsage();
    return (used.user + used.system) / 1000;
  };
  let prev: Reading | null = null;
  let last: Tick | null = null;
  let failed: string | null = null;
  let pruned = -Infinity;
  let behind = false;
  // CPU not on any row yet: what the tick before spent after it had measured itself (its deltas, its write and its
  // rollups), and what a disk reading's child processes used.
  let carried = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    const began = cpuNow();
    if (!source) {
      const darwin = await import("./monitor-darwin.ts");
      source = { read: darwin.readDarwin, lookup: darwin.lookup, containers: darwin.readContainers, known: remembering(darwin.lookup) };
    }
    const { reading, childCpuMs } = await source.read(now);
    source.known.forget(reading.procs);
    // A virtual machine that does not answer leaves its process whole for this tick.
    const inside = (await source.containers?.().catch(() => null)) ?? null;
    const machine = inside && reading.procs.filter((p) => p.name === inside.machine).sort((a, b) => b.mem - a.mem)[0];
    const within = inside && machine ? asProcs(inside.containers, machine) : [];
    reading.procs.push(...within);
    const listed = await panes.panes(reading.procs);
    const owners = attribute(reading.procs, { ...ctx, panes: listed, lookup: source.known.lookup });
    if (inside && within.length) {
      // Where each lane and pane runs: its pane's folder, and the folder of every tree it started and detached.
      const running: { folder: string; owner: Owner }[] = [];
      for (const pane of listed) if (pane.cwd && owners.has(pane.shellPid)) running.push({ folder: pane.cwd, owner: owners.get(pane.shellPid)! });
      for (const p of reading.procs) {
        const owner = owners.get(p.pid)!;
        if (p.ppid > 1 || p.pid < 0 || (owner.kind !== "lane" && owner.kind !== "pane")) continue;
        const folder = source.known.lookup.cwd(p);
        if (folder) running.push({ folder, owner });
      }
      within.forEach((p, i) => {
        const owner = ownerByFolder(inside.containers[i].folder, running, ctx.home);
        if (owner) owners.set(p.pid, { kind: owner.kind, owner: owner.owner, name: p.name });
      });
    }
    const me = reading.procs.find((p) => p.pid === process.pid);
    // The process's CPU between two instants. Inside the server that includes whatever else the server did while
    // the tick waited for ps (about 20 ms of wall time): the figure errs upward, never downward.
    const after = cpuNow();
    const selfCpuMs = after - began + childCpuMs + panes.takeCpuMs() + carried;
    const { host, rows } = usage(prev, reading, owners, { cpuMs: selfCpuMs, memKb: Math.round((me?.mem ?? 0) / 1024) });
    const named = rows.map((row) => ({ ...row, owner: mask(row.owner), name: mask(row.name) }));
    store.write(reading.at, host, named);
    carried = 0;
    store.roll(reading.at);
    if (behind || reading.at - pruned >= PRUNE_MS) {
      pruned = reading.at;
      behind = !store.prune(reading.at, PRUNE_STEP);
    }
    prev = reading;
    last = { at: reading.at, host, rows: named };
    // Not waited for: a walk takes minutes, and a tick must not.
    if (disk?.due()) void disk.read().then((cpuMs) => (carried += cpuMs));
    // A tick leaves about a megabyte of garbage (the process table, ps's text, the rows), and the runtime let it pile
    // up for minutes: the monitor alone grew from 33 to 59 MB in four. Collected after every tick it stays at 31, for
    // 1 to 3 ms of CPU, counted in what the monitor costs. Only on this machine's reader: a test's ticks come by the
    // hundred.
    if (collect) Bun.gc(true);
    carried += cpuNow() - after;
  }

  // A reading that fails leaves no row: the gap shows as a gap. The reading after it starts a new stretch, so the
  // time in between is not counted as one long tick.
  async function safeTick() {
    try {
      await tick();
      failed = null;
    } catch (e) {
      failed = (e as Error).message;
      prev = null;
    }
    if (failed) return;
    // Whoever follows the ticks must not be able to stop them.
    try {
      opts.ticked?.();
    } catch {}
  }

  // One tick at a time. Whoever asks for a tick while one runs is given that one, so the tick start() begins with
  // and the timer's first cannot run beside each other and count the same stretch of time twice.
  let running: Promise<void> | null = null;
  const oneTick = () => (running ??= safeTick().finally(() => (running = null)));

  return {
    tick: oneTick,
    // One tick at once, so there is something to show right after a start, then ticks on the wall clock's multiples
    // of TICK_MS, so every minute holds the same six. A tick that runs long skips the ones it covered instead of
    // queueing them.
    start() {
      if (timer) return;
      void oneTick();
      const next = () => {
        timer = setTimeout(async () => {
          await oneTick();
          if (timer) next();
        }, TICK_MS - (now() % TICK_MS));
      };
      next();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      disk?.stop();
      store.close();
    },
    last: () => last,
    failed: () => failed,
    // The name a database that could not be read was given when this monitor set it aside, or null.
    setAside,
    store,
  };
}
