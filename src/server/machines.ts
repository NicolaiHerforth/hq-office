// Machine health: CPU, memory and load per machine, sampled once a minute (machine-stats.sh).
import { DIR, HERDR, LOCAL, MACHINES } from "./config.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";

// The script runs here, or over ssh to a herdr machine. A failed sample is kept too, so a gap shows.
export const STATS_MS = 60_000;
const STATS_KEEP_MS = 2 * 86_400_000;
const STATS_SCRIPT = `${DIR}/src/server/machine-stats.sh`;

// herdr's machine list (each machine's ssh target) changes rarely: one call at a time, shared by every sampler, kept
// ten minutes. A call that fails, or does not answer in time (it is killed), or a list without the machine, is asked
// again after 30 seconds, not on the next tick: a herdr that hangs must not pile up one call per SUBS tick.
const LIST_MS = 600_000;
const RETRY_MS = 30_000;
const ASK_MS = Number(process.env.HUD_HERDR_ASK_MS ?? 10_000);
let listing: { until: number; targets: Promise<Map<string, string>> } | null = null;
function herdrTargets() {
  if (listing && Date.now() < listing.until) return listing.targets;
  const targets = askHerdr();
  const entry = (listing = { until: Date.now() + LIST_MS, targets });
  targets.catch(() => (entry.until = Math.min(entry.until, Date.now() + RETRY_MS)));
  return targets;
}
async function askHerdr() {
  const proc = Bun.spawn([HERDR, "machine", "list", "--json"], { stdout: "pipe", stderr: "ignore", timeout: ASK_MS });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`herdr machine list: ${proc.signalCode ?? `exit ${proc.exitCode}`}`);
  return new Map<string, string>(JSON.parse(out).map((m: any) => [m.label, m.target]));
}
async function sshTarget(machine: string): Promise<string> {
  const target = (await herdrTargets()).get(machine);
  if (target) return target;
  forgetTargets();
  throw new Error(`no herdr machine named ${machine}`);
}

// One ssh connection per machine, kept open between samples (it closes 3 minutes after the last one), instead of
// a new handshake every minute on both ends. The socket path must stay short, so it lives in /tmp.
const SSH_REUSE = ["-o", "ControlMaster=auto", "-o", `ControlPath=/tmp/hq-office-${process.getuid?.() ?? 0}-%C`, "-o", "ControlPersist=180"];
// The ssh command for a herdr machine, sharing that one connection; sub-usage.ts reads over it too. forgetTargets after
// a failure, so herdr is asked again within RETRY_MS.
export async function sshTo(machine: string): Promise<string[]> {
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...SSH_REUSE, await sshTarget(machine)];
}
export function forgetTargets() {
  if (listing) listing.until = Math.min(listing.until, Date.now() + RETRY_MS);
}
async function readStats(machine: string): Promise<Record<string, string>> {
  const local = machine === LOCAL;
  const args = local ? ["sh", STATS_SCRIPT] : [...(await sshTo(machine)), "sh", "-s"];
  const proc = Bun.spawn(args, { stdin: local ? "ignore" : Bun.file(STATS_SCRIPT), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    forgetTargets();
    throw new Error((await new Response(proc.stderr).text()).trim() || `exit ${code}`);
  }
  return Object.fromEntries(out.trim().split(/\s+/).map((kv) => kv.split("=") as [string, string]));
}

export async function sampleMachines() {
  const now = Date.now();
  const samples: [string, Record<string, string> | Error][] = [];
  for (const machine of MACHINES) {
    try {
      samples.push([machine, await readStats(machine)]);
    } catch (e) {
      samples.push([machine, e as Error]);
    }
  }
  // Written in one transaction: one write to disk a minute.
  db.transaction(() => {
    for (const [machine, s] of samples) {
      if (s instanceof Error) db.query("INSERT INTO machine_stats (at, machine, ok, error) VALUES (?, ?, 0, ?)").run(now, machine, s.message.slice(0, 200));
      else
        db.query("INSERT INTO machine_stats (at, machine, ok, cores, load1, cpu_busy, mem_used) VALUES (?, ?, 1, ?, ?, ?, ?)").run(
          now,
          machine,
          Number(s.cores),
          Number(s.load1),
          Number(s.cpu_busy),
          Number(s.mem_used),
        );
    }
    db.query("DELETE FROM machine_stats WHERE at < ?").run(now - STATS_KEEP_MS);
  })();
  bump();
}

// The latest sample per machine. A machine is "ok" only if its last sample succeeded and is recent.
export function machineHealth() {
  return MACHINES.map((machine) => {
    const last = db.query("SELECT * FROM machine_stats WHERE machine = ? ORDER BY at DESC LIMIT 1").get(machine) as Record<string, any> | null;
    const age = last ? Date.now() - last.at : null;
    return { machine, sample: last, age, ok: !!last?.ok && age !== null && age < 3 * STATS_MS };
  });
}

export function machineHistory(hours: number) {
  return db
    .query("SELECT at, machine, ok, cores, load1, cpu_busy, mem_used, error FROM machine_stats WHERE at >= ? ORDER BY machine, at")
    .all(Date.now() - hours * 3600_000);
}
