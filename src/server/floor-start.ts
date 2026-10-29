// START A NEW HQ: the server opens a herdr tab for a new floor's HQ and starts an agent in it, named hq-<id>, of the
// herdr agent kind the owner picked (any kind `herdr agent start --help` lists; by default the kind the first floor's
// HQ runs). Nothing here assumes a provider: herdr starts the agent and says when it is ready. The tab goes in the
// workspace of the first floor's HQ, in that HQ's working directory, so the new HQ works on the same project. An
// agent that stops at a question while it starts (an update notice, trusting the folder) is kept: its excerpt comes
// back as `waiting`, the floor shows its HQ at a prompt, and the guide waits until it can take input. On any other
// failure the tab is closed again and the floor is not added. The route adds the floor and sends the new HQ its guide
// (routes/floors.ts).
import { HERDR, LOCAL } from "./config.ts";
import { herdrList } from "./herdr.ts";
import { floorList } from "./floors.ts";
import { promptIn, UNREAD } from "./prompt.ts";

type Run = { ok: boolean; out: string; err: string };
async function run(args: string[], ms: number): Promise<Run> {
  try {
    const proc = Bun.spawn([HERDR, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), ms);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { ok: code === 0, out, err: err.trim() || (code === 0 ? "" : `exit ${code}`) };
  } catch (e) {
    return { ok: false, out: "", err: (e as Error).message };
  }
}
// herdr's errors are JSON on stderr; the message is what the owner reads.
function said(err: string) {
  try {
    return JSON.parse(err).error?.message ?? err;
  } catch {
    return err;
  }
}
const codeOf = (err: string) => {
  try {
    return String(JSON.parse(err).error?.code ?? "");
  } catch {
    return "";
  }
};

// A herdr agent kind as herdr names it (`herdr agent start --help` lists them): herdr itself says whether it can run it.
export function agentKind(kind: unknown): string | undefined {
  const k = String(kind ?? "").trim().toLowerCase();
  if (!k) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(k)) throw new Error(`${k} is not an agent kind as herdr names them (herdr agent start --help lists them)`);
  return k;
}

// What START A NEW HQ offers: every kind herdr can start (from its own help), the ones whose herdr integration is
// installed first (herdr reads their state: working, blocked, idle), and the kind the first floor's HQ runs (the
// default). Read from herdr once per server run.
let kinds: Promise<{ kinds: string[]; ready: string[] }> | null = null;
export async function agentKinds() {
  kinds ??= (async () => {
    const help = await run(["agent", "start", "--help"], 10_000);
    const all = /possible values:\s*([^\]]+)\]/.exec(help.out)?.[1].split(",").map((k) => k.trim()).filter(Boolean) ?? [];
    const status = await run(["integration", "status"], 10_000);
    const ready = [...status.out.matchAll(/^([a-z0-9_-]+)(?: \([^)]*\))?: current\b/gm)].map((m) => m[1]);
    return { kinds: all, ready };
  })();
  const got = await kinds;
  if (!got.kinds.length) kinds = null; // herdr did not answer: ask again next time
  const lead = (await herdrList(LOCAL).catch(() => [])).find((a: any) => a.name === floorList()[0]?.hq);
  return { ...got, lead: lead?.agent ? String(lead.agent) : null };
}

export async function startHq(floor: { id: string; name: string; hq: string }, kind?: string): Promise<{ pane: string; tab: string | null; kind: string; waiting: string | null }> {
  const lead = floorList()[0];
  let agents: any[];
  try {
    agents = await herdrList(LOCAL);
  } catch (e) {
    throw new Error(`herdr did not answer on this machine (${(e as Error).message}). Is herdr running here? Try again once it is, or USE AN AGENT that runs.`);
  }
  if (agents.some((a) => a.name === floor.hq)) throw new Error(`an agent named ${floor.hq} already runs in herdr: pick it under USE AN AGENT (or PICK ANOTHER)`);
  const first = agents.find((a) => a.name === lead.hq);
  if (!first) throw new Error(`the first floor's HQ, ${lead.hq}, is not running in herdr on this machine, so there is no workspace to open the new HQ beside. Start ${lead.hq} first, or USE AN AGENT that runs.`);
  const as = kind ?? (first.agent ? String(first.agent) : undefined);
  if (!as) throw new Error(`herdr did not say which kind of agent ${lead.hq} is, so pick the agent kind for the new HQ`);
  if (!first.workspace_id) throw new Error(`herdr did not say which workspace ${lead.hq} is in, so the new HQ has nowhere to open. Update herdr, or start the new HQ yourself and USE AN AGENT.`);
  const tab = await run(["tab", "create", "--workspace", first.workspace_id, ...(first.cwd ? ["--cwd", first.cwd] : []), "--label", `${floor.name} HQ`, "--no-focus"], 15_000);
  if (!tab.ok) throw new Error(`herdr could not open a tab next to ${lead.hq}: is its workspace still open? Try again, or USE AN AGENT instead. (herdr said: ${said(tab.err)})`);
  let made: any = {};
  try {
    made = JSON.parse(tab.out).result ?? {};
  } catch {}
  const pane = made.root_pane?.pane_id ?? made.root_pane?.id;
  const tabId = made.tab?.tab_id ?? made.tab?.id;
  if (!pane) {
    if (tabId) await run(["tab", "close", tabId], 10_000);
    throw new Error("herdr opened a tab but did not say which pane it holds, so the new HQ could not start. The tab was closed again; try again, or USE AN AGENT instead.");
  }
  const started = await run(["agent", "start", floor.hq, "--kind", as, "--pane", pane, "--timeout", "60000"], 75_000);
  if (!started.ok && codeOf(started.err) === "agent_not_ready" && (await herdrList(LOCAL).catch(() => [])).some((a: any) => a.name === floor.hq)) {
    // Up, but stopped at a question while starting: the owner answers it in the pane, the HUD waits for it.
    const read = await run(["pane", "read", pane], 10_000);
    return { pane, tab: tabId ?? null, kind: as, waiting: (read.ok && promptIn(read.out, true)) || UNREAD };
  }
  if (!started.ok) {
    if (tabId) await run(["tab", "close", tabId], 10_000);
    throw new Error(`herdr could not start ${floor.hq}: ${said(started.err)}. The tab was closed again; try again, or USE AN AGENT that runs.`);
  }
  return { pane, tab: tabId ?? null, kind: as, waiting: null };
}
