// herdr: which lanes are live, idle or gone, polled every 20 s (a lane's pane is read when its status changes and
// then once a minute), and typing answers and notes into HQ.
import { HERDR, LOCAL, MACHINES, SYNC_MS } from "./config.ts";
import { db } from "./db.ts";
import type { Lane } from "./types.ts";
import { bump } from "./push.ts";
import { event } from "./events.ts";
import { UNREAD, promptIn } from "./prompt.ts";
import { checkHq, notifyHq } from "./hq-link.ts";
import { sweep } from "./hq-sweep.ts";
import { kickQueue } from "./hq-queue.ts";
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
// When herdr last saw each lane, at the last sync that did. /api/state gives it as the lane's herdr_seen; the row in
// the database holds the time of the lane's last change of status, which is what a restart starts from.
export const herdrSeen = new Map<string, number>();

// Every pane herdr has on this machine, agent or not, so a pane hud names that herdr does not have is known for what it
// is (floors.ts callerOf). null when herdr does not say.
async function localPanes(): Promise<any[] | null> {
  try {
    const proc = Bun.spawn([HERDR, "pane", "list"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    const panes = JSON.parse(out).result?.panes;
    return Array.isArray(panes) ? panes : null;
  } catch {
    return null;
  }
}
// This machine's panes and agents as the last sync that got both read them: the monitor takes them from here and
// asks herdr for neither (monitor-panes.ts).
let lists: { at: number; panes: any[]; agents: any[] } | null = null;
export const localLists = () => lists;

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
// and the prompt it waits on, if any (the last 30 lines; see prompt.ts). ok: herdr answered.
type Reading = { bg: string | null; prompt: string | null };
async function readPane(machine: string, pane: string, blocked: boolean): Promise<Reading & { ok: boolean }> {
  const args = machine === LOCAL ? [HERDR, "pane", "read", pane, "--lines", "30"] : [HERDR, "--machine", machine, "pane", "read", pane, "--lines", "30"];
  let out = "";
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 8_000);
    out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0 && !out) return { ok: false, bg: null, prompt: blocked ? UNREAD : null };
  } catch {
    return { ok: false, bg: null, prompt: blocked ? UNREAD : null };
  }
  const tail = out.replace(/\n+$/, "").split("\n").slice(-10).join("\n");
  const sub = tail.match(SUBAGENT)?.[1];
  const bg = tail.match(BG)?.[1].replace(/\s+/g, " ") ?? (sub ? `subagent ${sub} running` : null);
  return { ok: true, bg, prompt: promptIn(out, blocked) ?? (blocked ? UNREAD : null) };
}

// A pane is read when its lane's status changes, and after that once a minute while the lane rests (not blocked, no
// prompt on its screen): a lane that has finished says the same thing sync after sync, and with twenty of them a read
// each every 20 s was most of what the server started (docs/footprint.md). So "2 shells still running" on a resting
// lane whose status did not change shows up to a minute late. A blocked lane, or one showing a prompt, is read at
// every sync.
// A read herdr did not answer is not kept: the next sync asks again. `hud sync` reads every pane it would have read.
const PANE_EVERY_MS = Number(process.env.HUD_PANE_EVERY_MS) || 60_000;
const readings = new Map<string, { key: string; at: number; value: Reading }>();
const reading = new Map<string, { key: string; read: ReturnType<typeof readPane> }>();

// Each named agent's machine and the folder it works in (herdr's cwd), from the last sync: the sweep names a done
// lane's worktree with it.
export let agentFolders = new Map<string, { machine: string; cwd: string }>();

export async function syncHerdr(opts: { readAll?: boolean } = {}) {
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
  const pane = new Map<string, Reading>();
  await Promise.all(
    lanes.map(async (lane) => {
      const hit = seen.get(lane.name);
      const blocked = hit?.agent.agent_status === "blocked";
      // A lane whose pane is not read now is read at once when it is to be read again.
      if (!hit || hit.agent.agent_status === "working" || (!blocked && (["done", "parked", "waiting"].includes(lane.phase) || asking.has(lane.name)))) return void readings.delete(lane.name);
      // herdr counts an agent's changes of status: the same count is the same stretch of the same status.
      const key = `${hit.machine} ${hit.agent.pane_id} ${hit.agent.agent_status} ${hit.agent.state_change_seq ?? ""}`;
      const had = readings.get(lane.name);
      // Only a resting lane is read once a minute: one that is not blocked and whose last reading showed no prompt.
      // A blocked lane, or one with a prompt on its screen (even one the reading could not make out, UNREAD), is read
      // at every sync, as before: that is the question panel, and its excerpt may not lag. A quarter of a sync short
      // of the minute: the sync a minute after a read comes a moment under a minute after it ended, and would
      // otherwise leave the read to the sync after.
      const resting = !blocked && !!had && had.value.prompt === null;
      if (!opts.readAll && resting && had.key === key && Date.now() - had.at < PANE_EVERY_MS - SYNC_MS / 4) return void pane.set(lane.name, had.value);
      // Two syncs can overlap (the timer and `hud sync`): the second takes the read the first one started.
      const going = reading.get(lane.name);
      const read = going?.key === key ? going.read : readPane(hit.machine, hit.agent.pane_id, blocked);
      if (going?.key !== key) reading.set(lane.name, { key, read });
      const { ok, ...value } = await read;
      if (reading.get(lane.name)?.read === read) {
        reading.delete(lane.name);
        if (ok) readings.set(lane.name, { key, at: Date.now(), value });
        else readings.delete(lane.name);
      }
      pane.set(lane.name, value);
    }),
  );
  const nowBlocked: Lane[] = [];
  let changed = false;
  // One transaction for the whole sync, and nothing written when nothing changed.
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
          "UPDATE lanes SET herdr = ?, herdr_since = CASE WHEN herdr = ? THEN herdr_since ELSE ? END, pane = ?, machine = ?, agent = ?, herdr_seen = ? WHERE name = ?",
        ).run(status, status, now, hit.agent.pane_id, hit.machine, hit.agent.agent, now, lane.name);
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
      // When herdr last saw it: memory, not a write per lane per sync. The row gets it when it changes otherwise.
      herdrSeen.set(lane.name, now);
    }
  })();
  untracked = [...seen.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, { machine, agent }]) => ({ name, machine, status: agent.agent_status }));
  if (!errors.length) agentFolders = new Map([...seen.entries()].filter(([, v]) => typeof (v.agent.cwd || v.agent.foreground_cwd) === "string").map(([name, v]) => [name, { machine: v.machine, cwd: v.agent.cwd || v.agent.foreground_cwd }]));
  live = [...seen.entries()].map(([name, { machine, agent }]) => ({ name, machine, status: agent.agent_status, kind: agent.agent ?? null, lane: known.has(name) }));
  lastSync = { at: now, errors };
  // HQ is typed into on this machine: check it there even when this machine's lanes are not tracked.
  if (!MACHINES.includes(LOCAL)) local = await herdrList(LOCAL).catch((e) => (errors.push(`${LOCAL}: ${(e as Error).message}`), null));
  if (!MACHINES.includes(LOCAL) && local) for (const a of local as any[]) if (a.name && a.pane_id) named.push({ machine: LOCAL, pane: a.pane_id, name: a.name, cwd: cwdOf(a), session: a.agent_session?.value ?? null });
  // A floor's HQ runs on this machine: its agents are offered even when its lanes are not tracked.
  if (!MACHINES.includes(LOCAL) && local) for (const a of local as any[]) if (a.name && !seen.has(a.name)) live.push({ name: a.name, machine: LOCAL, status: a.agent_status, kind: a.agent ?? null, lane: known.has(a.name) });
  // A machine that did not answer keeps the panes it had.
  const panes = await localPanes();
  if (panes && local) lists = { at: Date.now(), panes, agents: local };
  setPanes(named, (machine) => errors.some((e) => e.startsWith(`${machine}:`)), panes && new Set(panes.map((p: any) => String(p.pane_id))));
  await checkHq(local, errors.find((e) => e.startsWith(`${LOCAL}:`))?.slice(LOCAL.length + 2));
  await sweep();
  await kickQueue();
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
