// Machine health: CPU, memory and load per machine, sampled once a minute (machine-stats.sh).
import { DIR, HERDR, LOCAL, MACHINES } from "./config.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";

// The script runs here, or over ssh to a herdr machine. A failed sample is kept too, so a gap shows.
export const STATS_MS = 60_000;
const STATS_KEEP_MS = 2 * 86_400_000;
const STATS_SCRIPT = `${DIR}/src/server/machine-stats.sh`;

// herdr's machine list changes rarely: asked again after ten minutes, or after a sample over ssh fails.
const targets = new Map<string, { target: string; at: number }>();
export async function sshTarget(machine: string): Promise<string> {
  const hit = targets.get(machine);
  if (hit && Date.now() - hit.at < 600_000) return hit.target;
  const proc = Bun.spawn([HERDR, "machine", "list", "--json"], { stdout: "pipe", stderr: "ignore" });
  const list = JSON.parse(await new Response(proc.stdout).text());
  await proc.exited;
  const target = list.find((m: any) => m.label === machine)?.target;
  if (!target) throw new Error(`no herdr machine named ${machine}`);
  targets.set(machine, { target, at: Date.now() });
  return target;
}

// One ssh connection per machine, kept open between samples (it closes 3 minutes after the last one), instead of
// a new handshake every minute on both ends. The socket path must stay short, so it lives in /tmp.
export const SSH_REUSE = ["-o", "ControlMaster=auto", "-o", `ControlPath=/tmp/hq-office-${process.getuid?.() ?? 0}-%C`, "-o", "ControlPersist=180"];
async function readStats(machine: string): Promise<Record<string, string>> {
  const local = machine === LOCAL;
  const args = local ? ["sh", STATS_SCRIPT] : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...SSH_REUSE, await sshTarget(machine), "sh", "-s"];
  const proc = Bun.spawn(args, { stdin: local ? "ignore" : Bun.file(STATS_SCRIPT), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    targets.delete(machine);
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
