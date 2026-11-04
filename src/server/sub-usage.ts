// SUBS: how much of each subscription's 5-hour and weekly window is left and when each resets, from what the agents
// last reported on each machine (sub-usage.sh, read once a minute over the machines' ssh). In memory only: a restart
// refills it within a minute. A machine without grazr, Codex or python3 is "no source" for it, quietly.
import { DIR, LOCAL, MACHINES } from "./config.ts";
import { forgetTargets, sshTo } from "./machines.ts";
import { bump } from "./push.ts";
import { addStatePart } from "./state.ts";
import { list, merge, sources, type MachineUsage } from "./sub-usage-merge.ts";

export const SUBS_MS = Number(process.env.HUD_SUBS_MS ?? 60_000);
const SCRIPT = `${DIR}/src/server/sub-usage.sh`;
// Tests read this machine's usage from a home of their own (test/no-real-usage.ts), never the owner's.
const HOME = process.env.HUD_SUBS_HOME;

async function readUsage(machine: string): Promise<MachineUsage> {
  const local = machine === LOCAL;
  const quiet: MachineUsage = { machine, ok: false, python: false, claude: null, codex: null };
  try {
    const args = local ? ["sh", SCRIPT] : [...(await sshTo(machine)), "sh", "-s"];
    const env = local && HOME ? { HOME, PATH: process.env.PATH ?? "/usr/bin:/bin" } : process.env;
    const proc = Bun.spawn(args, { stdin: local ? "ignore" : Bun.file(SCRIPT), stdout: "pipe", stderr: "ignore", env });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) {
      if (!local) forgetTargets();
      return quiet;
    }
    const said = JSON.parse(out.trim().split("\n").pop() ?? "");
    return { machine, ok: true, python: said.python === true, claude: list(said.claude), codex: list(said.codex) };
  } catch {
    return quiet;
  }
}

// The last answer per machine: a machine that does not answer keeps what it said before, with its age on it.
const last = new Map<string, MachineUsage>();
let view: { list: Sub[]; sources: ReturnType<typeof sources> } = { list: [], sources: [] };

export async function sampleSubs() {
  const fresh = await Promise.all(MACHINES.map(readUsage));
  for (const m of fresh) {
    const before = last.get(m.machine);
    last.set(m.machine, m.ok || !before ? m : { ...before, ok: false });
  }
  const machines = MACHINES.map((m) => last.get(m)!).filter(Boolean);
  const next = { list: merge(machines), sources: sources(machines) };
  // A push only when something changed; the page counts the resets down itself.
  if (JSON.stringify(next) === JSON.stringify(view)) return;
  view = next;
  bump();
}

export const subsView = () => view;
addStatePart("subs", subsView);

let started = false;
export function startSubs() {
  if (started) return;
  started = true;
  void sampleSubs();
  setInterval(() => void sampleSubs(), SUBS_MS);
}
