// herdr: which lanes are live, idle or gone, polled every 20 s, and typing answers and notes into HQ.
import { HERDR, LOCAL, MACHINES } from "./config.ts";
import { db } from "./db.ts";
import type { Lane } from "./types.ts";
import { bump } from "./push.ts";
import { event } from "./events.ts";
import { UNREAD, promptIn } from "./prompt.ts";
import { checkHq, notifyHq } from "./hq-link.ts";
import { sweep } from "./hq-sweep.ts";
import { checkFolders } from "./room-folder.ts";
import { isHqAgent, setPanes } from "./floors.ts";

export let untracked: { name: string; machine: string; status: string }[] = [];
// Every named agent herdr runs, lanes too, from the last sync. A floor's HQ is one of those on this machine (the HUD
// types into HQ here): runningHere.
export let live: { name: string; machine: string; status: string; kind: string | null; lane: boolean }[] = [];
// Whether an agent runs in herdr on this machine, at the last sync: null when it does not run at all, else where.
export function whereRuns(name: string): string | null {
  const a = live.find((x) => x.name === name && x.status !== "gone");
  return a ? a.machine : null;
}
export let lastSync: { at: number; errors: string[] } = { at: 0, errors: [] };

// Every pane herdr has on this machine, agent or not, so a pane hud names that herdr does not have is known for what it
// is (floors.ts callerOf). null when herdr does not say.
async function localPaneIds(): Promise<Set<string> | null> {
  try {
    const proc = Bun.spawn([HERDR, "pane", "list"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    const panes = JSON.parse(out).result?.panes;
    return Array.isArray(panes) ? new Set(panes.map((p: any) => String(p.pane_id))) : null;
  } catch {
    return null;
  }
}

export async function herdrList(machine: string): Promise<any[]> {
  const args = machine === LOCAL ? [HERDR, "agent", "list"] : [HERDR, "--machine", machine, "agent", "list"];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const out = await new Response(proc.stdout).text();
  clearTimeout(timer);
  await proc.exited;
  return JSON.parse(out).result.agents;
}

// An idle agent can still be working. Its pane's tail says so: "· 2 shells still running", "monitor still running",
// a status bar with "← 1 agent" or "1 shell, 1 monitor", or a running subagent listed as "◯ general-purpose  <task>  34m 0s".
const BG = /(←\s*\d+\s+agents?|\d+\s+shells?(?:,\s*\d+\s+monitors?)?(?:\s+still running)?|\d+\s+monitors?|monitors?\s+still running)/i;
const SUBAGENT = /^\s*◯\s+([\w.-]+)\s/m;
// One pane read for a lane that is not working: what still runs in the background (the last 10 lines, as before),
// and the prompt it waits on, if any (the last 30 lines; see prompt.ts).
async function readPane(machine: string, pane: string, blocked: boolean): Promise<{ bg: string | null; prompt: string | null }> {
  const args = machine === LOCAL ? [HERDR, "pane", "read", pane, "--lines", "30"] : [HERDR, "--machine", machine, "pane", "read", pane, "--lines", "30"];
  let out = "";
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 8_000);
    out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
  } catch {
    return { bg: null, prompt: blocked ? UNREAD : null };
  }
  const tail = out.replace(/\n+$/, "").split("\n").slice(-10).join("\n");
  const sub = tail.match(SUBAGENT)?.[1];
  const bg = tail.match(BG)?.[1].replace(/\s+/g, " ") ?? (sub ? `subagent ${sub} running` : null);
  return { bg, prompt: promptIn(out, blocked) ?? (blocked ? UNREAD : null) };
}

export async function syncHerdr() {
  const errors: string[] = [];
  const seen = new Map<string, { machine: string; agent: any }>();
  // Every named agent's pane, so the server knows who calls hud (floors.ts).
  const named: { machine: string; pane: string; name: string; cwd?: string[]; session?: string | null }[] = [];
  const cwdOf = (a: any) => [a.cwd, a.foreground_cwd].filter((d) => typeof d === "string" && d);
  let local: any[] | null = null;
  await Promise.all(
    MACHINES.map(async (machine) => {
      try {
        const agents = await herdrList(machine);
        if (machine === LOCAL) local = agents;
        for (const agent of agents) {
          if (agent.name) seen.set(agent.name, { machine, agent });
          if (agent.name && agent.pane_id) named.push({ machine, pane: agent.pane_id, name: agent.name, cwd: cwdOf(agent), session: agent.agent_session?.value ?? null });
        }
      } catch (e) {
        errors.push(`${machine}: ${(e as Error).message}`);
      }
    }),
  );
  const now = Date.now();
  const lanes = db.query("SELECT * FROM lanes").all() as Lane[];
  const known = new Set(lanes.map((l) => l.name));
  // Only lanes that would otherwise read as HQ's turn or stale: any phase but done, parked or waiting (a phase HQ set
  // that the status does not know, such as "paused", also falls through to HQ's turn), agent not working, and no
  // open question waiting on the owner.
  const asking = new Set((db.query("SELECT DISTINCT lane FROM asks WHERE status = 'open' AND lane IS NOT NULL").all() as { lane: string }[]).map((r) => r.lane));
  // A lane herdr reports blocked (at an approval or question UI) is read whatever its phase or asks: the read gives
  // the excerpt of what it asks. A working agent's pane is never read.
  const pane = new Map<string, { bg: string | null; prompt: string | null }>();
  await Promise.all(
    lanes.map(async (lane) => {
      const hit = seen.get(lane.name);
      if (!hit || hit.agent.agent_status === "working") return;
      const blocked = hit.agent.agent_status === "blocked";
      if (!blocked && (["done", "parked", "waiting"].includes(lane.phase) || asking.has(lane.name))) return;
      pane.set(lane.name, await readPane(hit.machine, hit.agent.pane_id, blocked));
    }),
  );
  const nowBlocked: Lane[] = [];
  let changed = false;
  // One transaction for the whole sync: one write to disk instead of one per lane, three times a minute.
  db.transaction(() => {
    for (const lane of lanes) {
      const hit = seen.get(lane.name);
      if (!hit) {
        // Only call a lane gone when its machine answered.
        const machineAnswered = !errors.some((e) => e.startsWith(`${lane.machine}:`));
        if (machineAnswered && lane.herdr !== "gone") {
          db.query("UPDATE lanes SET herdr = 'gone', herdr_since = ?, prompt = NULL WHERE name = ?").run(now, lane.name);
          changed = true;
        }
        continue;
      }
      const status = hit.agent.agent_status as string;
      if (status !== lane.herdr || hit.agent.pane_id !== lane.pane || hit.machine !== lane.machine) {
        db.query(
          "UPDATE lanes SET herdr = ?, herdr_since = CASE WHEN herdr = ? THEN herdr_since ELSE ? END, pane = ?, machine = ?, agent = ? WHERE name = ?",
        ).run(status, status, now, hit.agent.pane_id, hit.machine, hit.agent.agent, lane.name);
        changed = true;
      }
      const work = pane.get(lane.name)?.bg ?? null;
      if (work !== (lane.bg ?? null)) {
        db.query("UPDATE lanes SET bg = ? WHERE name = ?").run(work, lane.name);
        changed = true;
      }
      // The prompt it waits on: set while it shows, cleared the moment the lane moves on.
      // Read again here, not from the list above: two syncs can overlap (the timer and `hud sync`), and only the
      // one that writes the change tells HQ.
      const prompt = pane.get(lane.name)?.prompt ?? null;
      const was = (db.query("SELECT prompt FROM lanes WHERE name = ?").get(lane.name) as { prompt: string | null } | null)?.prompt ?? null;
      if (prompt !== was) {
        db.query("UPDATE lanes SET prompt = ? WHERE name = ?").run(prompt, lane.name);
        if (prompt && !was) nowBlocked.push({ ...lane, machine: hit.machine, pane: hit.agent.pane_id, prompt });
        changed = true;
      }
      db.query("UPDATE lanes SET herdr_seen = ? WHERE name = ?").run(now, lane.name);
    }
  })();
  untracked = [...seen.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, { machine, agent }]) => ({ name, machine, status: agent.agent_status }));
  live = [...seen.entries()].map(([name, { machine, agent }]) => ({ name, machine, status: agent.agent_status, kind: agent.agent ?? null, lane: known.has(name) }));
  lastSync = { at: now, errors };
  // HQ is typed into on this machine: check it there even when this machine's lanes are not tracked.
  if (!MACHINES.includes(LOCAL)) local = await herdrList(LOCAL).catch((e) => (errors.push(`${LOCAL}: ${(e as Error).message}`), null));
  if (!MACHINES.includes(LOCAL) && local) for (const a of local as any[]) if (a.name && a.pane_id) named.push({ machine: LOCAL, pane: a.pane_id, name: a.name, cwd: cwdOf(a), session: a.agent_session?.value ?? null });
  // A floor's HQ runs on this machine: its agents are offered even when its lanes are not tracked.
  if (!MACHINES.includes(LOCAL) && local) for (const a of local as any[]) if (a.name && !seen.has(a.name)) live.push({ name: a.name, machine: LOCAL, status: a.agent_status, kind: a.agent ?? null, lane: known.has(a.name) });
  // A machine that did not answer keeps the panes it had.
  setPanes(named, (machine) => errors.some((e) => e.startsWith(`${machine}:`)), await localPaneIds());
  await checkHq(local, errors.find((e) => e.startsWith(`${LOCAL}:`))?.slice(LOCAL.length + 2));
  await sweep();
  checkFolders(); // rooms' folders, in case the system's file events stalled (room-folder.ts)
  for (const lane of nowBlocked) tellBlocked(lane);
  if (changed) bump();
}

// The lane's floor's HQ hears of a block once, when it starts; the same block never again until it clears.
// HUD_HQ_BLOCKED=0: never.
function tellBlocked(lane: Lane) {
  event("herdr", `blocked on a prompt: ${lane.prompt.split("\n").join(" / ")}`, lane.name);
  if (process.env.HUD_HQ_BLOCKED === "0" || isHqAgent(lane.name)) return;
  notifyHq(`Lane ${lane.name} is blocked on a prompt in herdr (${lane.machine}, ${lane.pane}): ${lane.prompt.split("\n").join(" / ")}`, undefined, lane.floor);
}

// Types text into an agent's session through herdr (on another machine with `machine`). The one way the server
// prompts an agent: HQ (notifyHq) and a lane in a conference room (rooms.ts). It never throws: what it says is saved
// first, and a herdr that cannot even start must not turn that into an error for the page. Resolves once herdr is done.
// With confirm (for an idle agent), herdr waits until the agent starts working on it, and fails with
// agent_prompt_stalled if it does not: proof that the agent took the text.
export function promptAgent(name: string, text: string, machine?: string | null, opts: { confirm?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const on = machine && machine !== LOCAL ? ["--machine", machine] : [];
  const wait = opts.confirm ? ["--wait", "--until", "working", "--timeout", "15000"] : [];
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([HERDR, ...on, "agent", "prompt", name, text, ...wait], { stdout: "ignore", stderr: "pipe" });
  } catch (e) {
    return Promise.resolve({ ok: false, error: (e as Error).message });
  }
  const timer = setTimeout(() => proc.kill(), 30_000);
  return proc.exited.then(async (code) => {
    clearTimeout(timer);
    return code === 0 ? { ok: true as const } : { ok: false as const, error: (await new Response(proc.stderr as ReadableStream).text()).trim() || `exit ${code}` };
  });
}

// The first floor's HQ agent when none is stored (floors.ts reads the same setting): the agent the owner's answers and
// notes are typed into, with a one-line reminder to reply through the HUD (the owner does not read HQ's terminal;
// HUD_HQ_HINT=0 leaves it out). The sending, and holding, is hq-link.ts; each floor has its own HQ.
export const HQ_AGENT = process.env.HUD_HQ_AGENT || "hq";
