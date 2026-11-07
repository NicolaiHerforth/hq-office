// The HQ sweep and a parked lane: parked says why it is idle, so the sweep does not list it. An idle lane that is not
// parked still is. A stub herdr as in hq-sweep.test.ts; one minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-parked-"));
const herdr = join(data, "herdr");
const agents = join(data, "agents.json");
const log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
const agent = (name: string, s: string) => ({ name, agent_status: s, pane_id: `p-${name}`, agent: "claude" });
writeFileSync(agents, JSON.stringify([agent("hq", "idle"), agent("resting", "idle"), agent("alpha", "idle")]));

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_SWEEP_MINUTE_MS: "40", TZ: "UTC" } });
  await post("/api/lanes", { name: "resting", machine: "local", phase: "parked" });
  await post("/api/lanes", { name: "alpha", machine: "local" });
  await post("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});
async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return res.json();
}
const nudges = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter((p) => p.startsWith("HUD sweep:")) : []);

test("the idle lane is listed and the parked one is not", async () => {
  await post("/api/sync");
  for (let i = 0; i < 100 && !nudges().length; i++) await Bun.sleep(20);
  expect(nudges()[0]).toContain("idle or done lanes 1: alpha");
  expect(nudges()[0]).not.toContain("resting");
});
