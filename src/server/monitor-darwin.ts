// THE MONITOR's reader on macOS: the process table and the host's counters, read in this process through libproc
// and Mach (bun:ffi), with one `ps` for the processes of other users. docs/monitor.md says why it is not `ps` alone:
// a pass through libproc costs about 3 ms of CPU where the cheapest `ps` costs 10 to 20, and only libproc gives a
// process's footprint. Resident size leaves out compressed and swapped memory, which is most of what a machine
// under pressure holds.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { statfsSync } from "node:fs";
import { homedir, loadavg, totalmem, userInfo } from "node:os";
import { basename } from "node:path";
import { PS_ARGS, parsePs, psArgsFor } from "./monitor-ps.ts";
import type { Host, Lookup, Proc, Reading } from "./monitor-types.ts";

const { i32, u32, u64, ptr: pointer } = FFIType;
const proc = dlopen("/usr/lib/libproc.dylib", {
  proc_listallpids: { args: [pointer, i32], returns: i32 },
  proc_pidinfo: { args: [i32, i32, u64, pointer, i32], returns: i32 },
  proc_pid_rusage: { args: [i32, i32, pointer], returns: i32 },
  proc_pidpath: { args: [i32, pointer, u32], returns: i32 },
}).symbols;
const sys = dlopen("/usr/lib/libSystem.B.dylib", {
  mach_host_self: { args: [], returns: u32 },
  mach_timebase_info: { args: [pointer], returns: i32 },
  host_statistics64: { args: [u32, i32, pointer, pointer], returns: i32 },
  sysctlbyname: { args: [pointer, pointer, pointer, pointer, u64], returns: i32 },
  sysctl: { args: [pointer, u32, pointer, pointer, pointer, u64], returns: i32 },
  responsibility_get_pid_responsible_for_pid: { args: [i32], returns: i32 },
  notify_register_check: { args: [pointer, pointer], returns: u32 },
  notify_get_state: { args: [i32, pointer], returns: u32 },
}).symbols;

const dec = new TextDecoder();
const cstring = (s: string) => new Uint8Array(Buffer.from(`${s}\0`));
const text = (b: Uint8Array, from: number, max: number) => {
  let end = from;
  while (end < from + max && b[end]) end++;
  return dec.decode(b.subarray(from, end));
};

// Offsets into the structs of <sys/proc_info.h>, <sys/resource.h> and <mach/vm_statistics.h>. They are part of the
// kernel's ABI: a struct only ever grows at its end.
const BSDINFO = { flavor: 3, size: 136, ppid: 16, uid: 20, comm: 48, name: 64, start: 120 };
const SHORTINFO = { flavor: 13, size: 64, ppid: 4, comm: 16, uid: 36, ruid: 44 };
const RUSAGE = { flavor: 4, size: 296, user: 16, system: 24, footprint: 72, childUser: 96, childSystem: 104, read: 144, written: 152 };
const CPU_LOAD = { flavor: 3, count: 4 };
const VM = { flavor: 4, count: 38, free: 0, wired: 12, pageins: 32, pageouts: 40, purgeable: 88, speculative: 92, swapins: 112, swapouts: 120, compressor: 128, external: 136, internal: 140, stored: 144 };
const TICK_MS = 10;

const host = sys.mach_host_self();
// CPU times come in Mach time units: 125/3 ns each on Apple silicon, 1 ns on Intel.
const toMs = (() => {
  const tb = new Uint32Array(2);
  sys.mach_timebase_info(ptr(tb));
  return tb[0] / tb[1] / 1e6;
})();

const pids = new Int32Array(16384);
const buf = new Uint8Array(4096);
const view = new DataView(buf.buffer);
const big = (at: number) => Number(view.getBigUint64(at, true));

const NAMES = { boot: cstring("kern.boottime"), pressure: cstring("kern.memorystatus_vm_pressure_level"), available: cstring("kern.memorystatus_level"), swap: cstring("vm.swapusage"), page: cstring("hw.pagesize") };
const len = new BigUint64Array(1);
function sysctl(name: Uint8Array, size: number): boolean {
  len[0] = BigInt(size);
  return sys.sysctlbyname(ptr(name), ptr(buf), ptr(len), null, 0n) === 0;
}
const pageSize = sysctl(NAMES.page, 8) ? view.getUint32(0, true) : 16384;

// The thermal pressure level is published as a notification's state; no sysctl has it on Apple silicon.
const thermalToken = (() => {
  const token = new Int32Array(1);
  return sys.notify_register_check(ptr(cstring("com.apple.system.thermalpressurelevel")), ptr(token)) === 0 ? token[0] : null;
})();

function readHost(): Host {
  const count = new Uint32Array([CPU_LOAD.count]);
  // 32 bits each, of all cores together, so they wrap: usage() drops the one tick that sees it (monitor-usage.ts).
  const ticks = new Uint32Array(CPU_LOAD.count);
  if (sys.host_statistics64(host, CPU_LOAD.flavor, ptr(ticks), ptr(count)) !== 0) throw new Error("host cpu ticks unreadable");
  const [user, system, idle, nice] = ticks;
  count[0] = VM.count;
  if (sys.host_statistics64(host, VM.flavor, ptr(buf), ptr(count)) !== 0) throw new Error("host memory unreadable");
  const pages = (at: number) => view.getUint32(at, true) * pageSize;
  const vm = {
    // The free count includes speculative pages, which are file pages and already counted as cached.
    memFree: Math.max(0, pages(VM.free) - pages(VM.speculative)),
    memWired: pages(VM.wired),
    memApp: Math.max(0, pages(VM.internal) - pages(VM.purgeable)),
    memCached: pages(VM.external) + pages(VM.purgeable),
    memCompressed: pages(VM.compressor),
    memStored: big(VM.stored) * pageSize,
    pageins: big(VM.pageins),
    pageouts: big(VM.pageouts),
    swapins: big(VM.swapins),
    swapouts: big(VM.swapouts),
  };
  if (!sysctl(NAMES.swap, 32)) throw new Error("swap unreadable");
  const swap = { swapTotal: big(0), swapUsed: big(16) };
  const level = sysctl(NAMES.pressure, 4) ? view.getInt32(0, true) : null;
  const available = sysctl(NAMES.available, 4) ? view.getInt32(0, true) : null;
  let thermal: number | null = null;
  if (thermalToken !== null && sys.notify_get_state(thermalToken, ptr(buf)) === 0) thermal = big(0);
  const bootAt = sysctl(NAMES.boot, 16) ? big(0) : null;
  let disk: { diskTotal: number | null; diskFree: number | null } = { diskTotal: null, diskFree: null };
  try {
    const fs = statfsSync(homedir());
    disk = { diskTotal: Number(fs.blocks) * Number(fs.bsize), diskFree: Number(fs.bavail) * Number(fs.bsize) };
  } catch {}
  return {
    cores: navigator.hardwareConcurrency,
    busyMs: (user + system + nice) * TICK_MS,
    idleMs: idle * TICK_MS,
    load1: loadavg()[0],
    memTotal: totalmem(),
    ...vm,
    ...swap,
    pressure: level === 1 || level === 2 || level === 4 ? level : null,
    available,
    thermal,
    ...disk,
    bootAt,
  };
}

function pathOf(pid: number): string | null {
  const n = proc.proc_pidpath(pid, ptr(buf), buf.byteLength);
  return n > 0 ? dec.decode(buf.subarray(0, n)) : null;
}

// What libproc gives for a process of another user: who it is, not what it uses. ruid is the user ps knows it by.
type Stranger = { pid: number; ppid: number; uid: number; ruid: number; name: string; path: string | null };

// The user's processes at the reading before. One that has exited and waits for its parent to collect it answers
// only for what it used: who it was comes from here. It must stay in the table until it is collected: the parent's
// total of collected children grows by its whole life at that moment, and only a process that was seen can be
// taken off that total. One that was never seen alive is left out, and counts as a child that came and went.
let seen = new Map<number, Proc>();

// What a process used, when this user may read it.
function usageOf(pid: number) {
  if (proc.proc_pid_rusage(pid, RUSAGE.flavor, ptr(buf)) !== 0) return null;
  return {
    cpuMs: (big(RUSAGE.user) + big(RUSAGE.system)) * toMs,
    childCpuMs: (big(RUSAGE.childUser) + big(RUSAGE.childSystem)) * toMs,
    mem: big(RUSAGE.footprint),
    read: big(RUSAGE.read),
    written: big(RUSAGE.written),
  };
}

function readTable(): { mine: Proc[]; strangers: Map<number, Stranger> } {
  const n = proc.proc_listallpids(ptr(pids), pids.byteLength);
  const mine: Proc[] = [];
  const strangers = new Map<number, Stranger>();
  for (let i = 0; i < n; i++) {
    const pid = pids[i];
    if (proc.proc_pidinfo(pid, BSDINFO.flavor, 0n, ptr(buf), BSDINFO.size) === BSDINFO.size) {
      const ppid = view.getUint32(BSDINFO.ppid, true);
      const uid = view.getUint32(BSDINFO.uid, true);
      const short = text(buf, BSDINFO.name, 32) || text(buf, BSDINFO.comm, 16);
      const start = big(BSDINFO.start);
      const used = usageOf(pid);
      if (used) {
        const path = pathOf(pid);
        mine.push({ pid, ppid, uid, name: path ? basename(path) : short, path, start, exact: true, ...used });
        continue;
      }
    }
    // Another user's process, or one that has exited: that one says nothing about itself here either.
    if (proc.proc_pidinfo(pid, SHORTINFO.flavor, 0n, ptr(buf), SHORTINFO.size) !== SHORTINFO.size) {
      const was = seen.get(pid);
      const used = was && usageOf(pid);
      if (was && used) mine.push({ ...was, ...used, mem: 0 });
      continue;
    }
    const ppid = view.getUint32(SHORTINFO.ppid, true);
    const uid = view.getUint32(SHORTINFO.uid, true);
    const ruid = view.getUint32(SHORTINFO.ruid, true);
    const short = text(buf, SHORTINFO.comm, 16);
    const path = pathOf(pid);
    strangers.set(pid, { pid, ppid, uid, ruid, name: path ? basename(path) : short, path });
  }
  seen = new Map(mine.map((p) => [p.pid, p]));
  return { mine, strangers };
}

// A process's working folder is the first path in its vnode info.
const VNODE = { flavor: 9, size: 2352, cwd: 152, max: 1024 };
// KERN_PROCARGS2: a process's argument count, executable, arguments and environment, in one block.
const ARGS_MIB = new Int32Array([1, 49, 0]);
const PANE_KEY = new TextEncoder().encode("HERDR_PANE_ID=");
let argsBuf: Uint8Array | null = null;

// What attribution asks about single processes (monitor-types.ts). All three work on the user's own processes only.
export const lookup: Lookup = {
  cwd(p) {
    if (proc.proc_pidinfo(p.pid, VNODE.flavor, 0n, ptr(buf), VNODE.size) !== VNODE.size) return null;
    return text(buf, VNODE.cwd, VNODE.max) || null;
  },
  responsible(p) {
    const pid = sys.responsibility_get_pid_responsible_for_pid(p.pid);
    return pid > 0 ? pid : null;
  },
  // The block holds the command line and every variable, tokens among them. It is read into memory, the one
  // variable is taken out, and nothing else of it is kept or returned.
  launchPane(p) {
    const block = (argsBuf ??= new Uint8Array(1 << 20));
    ARGS_MIB[2] = p.pid;
    len[0] = BigInt(block.byteLength);
    if (sys.sysctl(ptr(ARGS_MIB), 3, ptr(block), ptr(len), null, 0n) !== 0) return null;
    const end = Number(len[0]);
    const argc = new DataView(block.buffer).getInt32(0, true);
    let at = 4;
    while (at < end && block[at]) at++;
    while (at < end && !block[at]) at++;
    for (let arg = 0; arg < argc && at < end; arg++) at = block.indexOf(0, at) + 1 || end;
    // A process that renamed itself leaves empty bytes where its arguments were.
    while (at < end && !block[at]) at++;
    let found: string | null = null;
    while (at < end && block[at]) {
      const stop = block.indexOf(0, at);
      const till = stop < 0 || stop > end ? end : stop;
      if (till - at > PANE_KEY.length && PANE_KEY.every((byte, i) => block[at + i] === byte)) {
        found = dec.decode(block.subarray(at + PANE_KEY.length, till));
        break;
      }
      at = till + 1;
    }
    block.fill(0, 0, end);
    return found;
  },
};

export { readContainers } from "./monitor-containers.ts";

// The user "nobody" has the largest user id, and ps takes it by name only.
const NOBODY = 4294967294;
const ME = userInfo().uid;
// Set once a ps limited to some users has failed (a user id it cannot name): from then on ps lists everyone.
let everyone = false;

// One reading of the machine. cost.childCpuMs is the CPU the `ps` it started used: part of what the monitor costs.
export async function readDarwin(now: () => number = Date.now): Promise<{ reading: Reading; childCpuMs: number }> {
  const at = now();
  const hostNow = readHost();
  const { mine, strangers } = readTable();
  let childCpuMs = 0;
  const ps = async (args: string[]) => {
    const run = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const out = await new Response(run.stdout).text();
    const failed = (await run.exited) !== 0 ? (run.signalCode ?? `exit ${run.exitCode}`) : null;
    childCpuMs += Number(run.resourceUsage()?.cpuTime.total ?? 0) / 1000;
    return { out, failed };
  };
  // Only what libproc may not read: ps costs per process it prints, and three in four are this user's own. A
  // process this user started that runs as another user is asked for by its pid, not by its user, or ps would
  // print every process of this user after all.
  const others = [...strangers.values()];
  const users = [...new Set(others.filter((s) => s.ruid !== ME).map((s) => (s.ruid === NOBODY ? "nobody" : String(s.ruid))))];
  const pids = others.filter((s) => s.ruid === ME).map((s) => s.pid);
  let listed = everyone || !others.length ? null : await ps(psArgsFor(users, pids));
  if (listed?.failed) everyone = true;
  if (!listed || listed.failed) listed = await ps(PS_ARGS);
  // A ps that failed or was stopped at its limit printed part of the table. Other users' processes would vanish
  // for a tick and come back as new: the reading fails instead, and the tick is a gap.
  if (listed.failed) throw new Error(`ps: ${listed.failed}`);
  const procs = mine;
  // ps is setuid, so it reads what libproc may not: CPU time and resident size. The name and the path stay libproc's,
  // since ps cuts a name at 16 characters and printing the path makes it ten times as costly.
  for (const row of parsePs(listed.out, at)) {
    const who = strangers.get(row.pid);
    if (who) procs.push({ ...row, ppid: who.ppid, uid: who.uid, name: who.name, path: who.path });
  }
  return { reading: { at, procs, host: hostNow }, childCpuMs };
}
