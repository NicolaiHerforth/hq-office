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
    throw new Error(`herdr did not answer on this machine: ${(e as Error).message}`);
  }
  if (agents.some((a) => a.name === floor.hq)) throw new Error(`an agent named ${floor.hq} already runs in herdr: pick it under USE AN AGENT`);
  const first = agents.find((a) => a.name === lead.hq);
  if (!first?.workspace_id) throw new Error(`the first floor's HQ, ${lead.hq}, is not running in herdr on this machine, so there is no workspace to open the new HQ in. Start it yourself and pick it under USE AN AGENT`);
  const tab = await run(["tab", "create", "--workspace", first.workspace_id, ...(first.cwd ? ["--cwd", first.cwd] : []), "--label", `${floor.name} HQ`, "--no-focus"], 15_000);
  if (!tab.ok) throw new Error(`herdr could not open a tab for the new HQ: ${said(tab.err)}`);
  let made: any = {};
  try {
    made = JSON.parse(tab.out).result ?? {};
  } catch {}
  const pane = made.root_pane?.pane_id ?? made.root_pane?.id;
  const tabId = made.tab?.tab_id ?? made.tab?.id;
  if (!pane) {
    if (tabId) await run(["tab", "close", tabId], 10_000);
    throw new Error("herdr opened a tab but did not say which pane it holds");
  }
  const started = await run(["agent", "start", floor.hq, "--kind", "claude", "--pane", pane, "--timeout", "60000"], 75_000);
  if (!started.ok) {
    if (tabId) await run(["tab", "close", tabId], 10_000);
    throw new Error(`herdr could not start ${floor.hq}: ${said(started.err)}`);
  }
  return { pane, tab: tabId ?? null };
}
