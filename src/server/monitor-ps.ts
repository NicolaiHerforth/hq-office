// THE MONITOR's portable reader: the rows of one `ps`, parsed. On macOS it supplies the processes of other users
// (monitor-darwin.ts); it is also what a reader over ssh would parse, since `ps` is on every machine.
import type { Proc } from "./monitor-types.ts";

// No path column: on macOS printing it makes ps read every process's arguments, ten times the cost.
const COLUMNS = "pid=,ppid=,uid=,etime=,time=,rss=,ucomm=";
export const PS_ARGS = ["-axo", COLUMNS];
// The processes of these users, and these single processes, only: ps spends its time per process it prints. A user
// id ps cannot name makes it print nothing and fail, so whoever uses this falls back to PS_ARGS.
export const psArgsFor = (users: string[], pids: number[]) => ["-xo", COLUMNS, ...(users.length ? ["-U", users.join(",")] : []), ...(pids.length ? ["-p", pids.join(",")] : [])];

// "[days-][hours:]minutes:seconds[.hundredths]" as seconds.
function seconds(clock: string): number {
  const [days, rest] = clock.includes("-") ? clock.split("-") : ["0", clock];
  return Number(days) * 86_400 + rest.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

// ps gives the resident size, and how long ago a process started in whole seconds: the start is right to a second.
export function parsePs(out: string, at: number): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    const [, pid, ppid, uid, etime, time, rss, name] = m;
    const cpuMs = seconds(time) * 1000;
    const start = Math.round(at / 1000 - seconds(etime));
    if (!Number.isFinite(cpuMs) || !Number.isFinite(start)) continue;
    procs.push({ pid: Number(pid), ppid: Number(ppid), uid: Number(uid), name, path: null, start, cpuMs, childCpuMs: null, mem: Number(rss) * 1024, exact: false, read: null, written: null });
  }
  return procs;
}
