// THE MONITOR, what was used between two readings: each process's CPU and disk since the reading before, the CPU of
// children that came and went in between, summed into one row per owner and name, and the machine's own numbers.
// Pure: no I/O.
import type { HostUsage, Owner, Proc, Reading, Usage } from "./monitor-types.ts";

// A row below both is folded into its owner's "(small)" row: a row of its own has to matter, 1% of a core over a
// ten-second tick or 50 MB. On the machine this was built on that stores about 180 rows a tick instead of 250, and
// the folded rows hold under 3% of the CPU and 4% of the memory.
export const SMALL = { cpuMs: 100, memKb: 50_000 };

// One source derives a start from an elapsed time, so the same process's start moves by a second between readings.
const START_SLACK_S = 2;
// Two readings further apart than this are two stretches: the machine slept, or the monitor was stopped. A tick that
// ran long under pressure is well inside it and stays one tick.
export const MAX_GAP_MS = 120_000;
const SINCE_BOOT = ["busyMs", "idleMs", "pageins", "pageouts", "swapins", "swapouts"] as const;
const SUMMED = ["cpuMs", "memKb", "n", "readKb", "writtenKb"] as const;

const kb = (bytes: number) => Math.round(bytes / 1024);

// Whether two readings of one pid are one process. Without a start on both sides, a pid that kept its parent and its
// name and whose CPU did not go down is taken for the same one.
function same(was: Proc, now: Proc) {
  if (was.start && now.start) return Math.abs(now.start - was.start) <= START_SLACK_S;
  return was.ppid === now.ppid && was.name === now.name && now.cpuMs >= was.cpuMs;
}

// A total since boot that went down means another boot, a clock that did not move forward leaves no time in
// between, and after a long gap the time in between was not watched: nothing can be said about what was used.
// A total also goes down without a boot, when its counter wraps: the host's CPU times are 32-bit counts of
// hundredths of a second, summed over the cores (monitor-darwin.ts), so on 16 cores the idle count is back at
// nothing after about 31 days up, and the busy ones much later. The tick that sees it is taken for the first after
// a boot and says nothing about CPU, and the tick after it counts from the new total: one tick in a month.
const follows = (prev: Reading, cur: Reading) => cur.at > prev.at && cur.at - prev.at <= MAX_GAP_MS && SINCE_BOOT.every((field) => cur.host[field] >= prev.host[field]);

function add(rows: Map<string, Usage>, row: Usage) {
  const key = `${row.kind}\0${row.owner}\0${row.name}`;
  const into = rows.get(key);
  if (!into) rows.set(key, { ...row });
  else for (const field of SUMMED) into[field] += row[field];
}

export function usage(prev: Reading | null, cur: Reading, owners: Map<number, Owner>, self: { cpuMs: number; memKb: number }): { host: HostUsage; rows: Usage[] } {
  const base = prev && follows(prev, cur) ? prev : null;
  const before = new Map(base?.procs.map((p) => [p.pid, p]));
  const after = new Map(cur.procs.map((p) => [p.pid, p]));
  const ownerOf = (p: Proc): Owner => owners.get(p.pid) ?? { kind: "other", owner: "other", name: p.name };

  const goneUnder = new Map<number, Proc[]>();
  for (const q of base?.procs ?? []) {
    const still = after.get(q.pid);
    if (still && same(q, still)) continue;
    const siblings = goneUnder.get(q.ppid);
    if (siblings) siblings.push(q);
    else goneUnder.set(q.ppid, [q]);
  }
  // The CPU already counted, in earlier ticks, for everything under a pid that is gone now. A tree that exits at once
  // is collected through its root, so the walk goes down through the gone ones. Each list is taken once, so a table
  // that is not a tree cannot hang it.
  const counted = (pid: number) => {
    let ms = 0;
    for (const todo = [pid]; todo.length; ) {
      const parent = todo.pop()!;
      for (const q of goneUnder.get(parent) ?? []) {
        ms += q.cpuMs + (q.childCpuMs ?? 0);
        todo.push(q.pid);
      }
      goneUnder.delete(parent);
    }
    return ms;
  };

  // Bytes and fractions of a millisecond are summed as they are and rounded once per row.
  const exact = new Map<string, Usage>();
  const own = new Map<number, Usage>();
  for (const p of cur.procs) {
    const seen = before.get(p.pid);
    const was = seen && same(seen, p) ? seen : null;
    const born = !!base && !was && (p.start === 0 || p.start * 1000 >= base.at - START_SLACK_S * 1000);
    // What a total that only grows added in the tick. All of it for a process born in the tick. Nothing for one the
    // reading before missed: its total is its whole life. Nothing for a total that could not be read on either side.
    const grew = (total: (p: Proc) => number | null) => {
      const now = total(p);
      const then = was ? total(was) : born ? 0 : null;
      return now === null || then === null ? 0 : Math.max(0, now - then);
    };
    own.set(p.pid, { ...ownerOf(p), cpuMs: grew((x) => x.cpuMs), memKb: p.mem / 1024, n: 1, readKb: grew((x) => x.read) / 1024, writtenKb: grew((x) => x.written) / 1024 });
    // Children that came and went between two readings, and the last stretch of the ones that were seen.
    const exited = grew((x) => x.childCpuMs) - counted(p.pid);
    if (exited > 0) add(exact, { ...ownerOf(p), name: "(exited)", cpuMs: exited, memKb: 0, n: 0, readKb: 0, writtenKb: 0 });
  }

  // What runs inside a process is part of that process's figures: it gets its own row, and the process keeps the
  // rest. Never below nothing: the two are read a moment apart and measured in different ways.
  for (const p of cur.procs) {
    const around = p.inside === undefined ? undefined : own.get(p.inside);
    if (!around) continue;
    const within = own.get(p.pid)!;
    around.cpuMs = Math.max(0, around.cpuMs - within.cpuMs);
    around.memKb = Math.max(0, around.memKb - within.memKb);
  }
  for (const row of own.values()) add(exact, row);

  const folded = new Map<string, Usage>();
  for (const row of exact.values()) {
    for (const field of SUMMED) row[field] = Math.round(row[field]);
    add(folded, row.cpuMs < SMALL.cpuMs && row.memKb < SMALL.memKb ? { ...row, name: "(small)" } : row);
  }
  const rows = [...folded.values()];

  const sinceBase = (field: (typeof SINCE_BOOT)[number]) => (base ? cur.host[field] - base.host[field] : 0);
  const lost = Math.round(sinceBase("busyMs") - rows.reduce((ms, row) => ms + row.cpuMs, 0));
  // The kernel's own work is most of it: no reader without root sees the kernel as a process.
  if (lost > 0) rows.push({ kind: "lost", owner: "kernel and unattributed", name: "(unattributed)", cpuMs: lost, memKb: 0, n: 0, readKb: 0, writtenKb: 0 });

  const h = cur.host;
  const host: HostUsage = {
    dtMs: base ? cur.at - base.at : 0,
    cores: h.cores,
    busyMs: sinceBase("busyMs"),
    load1: h.load1,
    memTotalKb: kb(h.memTotal),
    memFreeKb: kb(h.memFree),
    memWiredKb: kb(h.memWired),
    memAppKb: kb(h.memApp),
    memCachedKb: kb(h.memCached),
    memCompressedKb: kb(h.memCompressed),
    memStoredKb: kb(h.memStored),
    swapTotalKb: kb(h.swapTotal),
    swapUsedKb: kb(h.swapUsed),
    pressure: h.pressure,
    available: h.available,
    pageins: sinceBase("pageins"),
    pageouts: sinceBase("pageouts"),
    swapins: sinceBase("swapins"),
    swapouts: sinceBase("swapouts"),
    thermal: h.thermal,
    diskTotalKb: h.diskTotal === null ? null : kb(h.diskTotal),
    diskFreeKb: h.diskFree === null ? null : kb(h.diskFree),
    bootAt: h.bootAt,
    heldKb: rows.reduce((kb, row) => kb + row.memKb, 0),
    selfCpuMs: self.cpuMs,
    selfMemKb: self.memKb,
  };
  return { host, rows };
}
