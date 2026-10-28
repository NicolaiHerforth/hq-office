// START A NEW HQ: the server opens a herdr tab for a new floor's HQ and starts a Claude agent in it, named hq-<id>.
// The tab goes in the workspace of the first floor's HQ, in that HQ's working directory, so the new HQ works on the
// same project. Nothing is stored until herdr says the agent is ready: on any failure the tab is closed again and the
// floor is not added. The route adds the floor and sends the new HQ its guide (routes/floors.ts).
import { HERDR, LOCAL } from "./config.ts";
import { herdrList } from "./herdr.ts";
import { floorList } from "./floors.ts";

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

export async function startHq(floor: { id: string; name: string; hq: string }) {
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
  const started = await run(["agent", "start", floor.hq, "--kind", "claude", "--pane", pane, "--timeout", "60000"], 75_000);
  if (!started.ok) {
    if (tabId) await run(["tab", "close", tabId], 10_000);
    throw new Error(`herdr could not start ${floor.hq}: ${said(started.err)}. The tab was closed again; try again, or USE AN AGENT that runs.`);
  }
  return { pane, tab: tabId ?? null };
}
