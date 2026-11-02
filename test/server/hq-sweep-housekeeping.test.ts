// The HQ sweep asks for housekeeping too: every "HUD sweep:" line ends by asking HQ to close lanes whose work is merged
// or done, stop their stacks and test containers, and prune their worktrees on each machine. Lanes the HUD knows are
// done with nothing open (no open question) are named, with the folder their agent works in when herdr reports one;
// such lanes are reason enough for a sweep. A stub herdr; one minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-house-"));
const herdr = join(data, "herdr"), agents = join(data, "agents.json"), log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
const a = (name: string, status: string, cwd?: string) => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude", ...(cwd ? { cwd } : {}) });
const world = (list: object[]) => writeFileSync(agents, JSON.stringify(list));
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: unknown = {}) => (await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) })).json();
const nudges = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter((p) => p.startsWith("HUD sweep:")) : []);
const HOUSE = "Housekeeping too: close lanes whose work is merged or done, stop their stacks and test containers, and prune their worktrees on each machine.";

beforeAll(async () => {
  world([a("hq", "idle"), a("merged-one", "idle", "/home/dev/wt/merged-one"), a("done-asks", "idle"), a("busy", "working")]);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_SWEEP_MINUTE_MS: "40", TZ: "UTC" } });
  for (const [name, phase] of [["merged-one", "done"], ["gone-done", "done"], ["done-asks", "done"], ["busy", "running"]]) await post("/api/lanes", { name, phase, machine: "local" });
  await post("/api/asks", { lane: "done-asks", kind: "decision", title: "Keep the branch?", options: ["yes", "no"] });
  await post("/api/sync");
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

test("done lanes with nothing open are reason enough for a sweep, named with their folders; the line asks for housekeeping", async () => {
  await post("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
  await post("/api/sync");
  const [n] = nudges();
  expect(n).toContain("done lanes to close 2: gone-done, merged-one (~/wt/merged-one on local)");
  expect(n).not.toMatch(/done lanes to close[^;]*done-asks/); // its question is still open
  expect(n).not.toContain("busy");
  expect(n).not.toMatch(/idle or done lanes[^;]*merged-one/); // listed once, as one to close
  expect(n.split("\n")[0].endsWith(HOUSE)).toBe(true); // one line, the ask at its end
});
