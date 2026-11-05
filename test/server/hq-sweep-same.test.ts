// The HQ sweep and a list HQ cannot change: when HQ works after a nudge but the next sweep would list the same things
// (a question only the owner can answer, a lane idle for a reason), the wait still doubles. A list that changed starts
// the wait over. A stub herdr as in hq-sweep.test.ts; one minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-same-"));
const herdr = join(data, "herdr");
const agents = join(data, "agents.json");
const log = join(data, "prompts.log");
const MINUTE = 40;
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
const world = (hqStatus: string, lanes: [string, string][]) =>
  writeFileSync(agents, JSON.stringify([{ name: "hq", agent_status: hqStatus, pane_id: "w8:p1", agent: "claude" }, ...lanes.map(([name, s]) => ({ name, agent_status: s, pane_id: `p-${name}`, agent: "claude" }))]));

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  world("idle", [["alpha", "idle"], ["bravo", "working"]]);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_SWEEP_MINUTE_MS: String(MINUTE), TZ: "UTC" } });
  for (const name of ["alpha", "bravo"]) await post("/api/lanes", { name, machine: "local" });
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
const sync = () => post("/api/sync");
const wait = (minutes: number) => Bun.sleep(minutes * MINUTE);
// A sync can step aside while another one is typing the nudge in, so wait for the count instead of reading it at once,
// then give an extra one a moment to show.
async function settle(n: number) {
  for (let i = 0; i < 100 && nudges().length < n; i++) await Bun.sleep(20);
  await Bun.sleep(80);
  expect(nudges()).toHaveLength(n);
}
// HQ takes a turn, as it does when it answers a sweep: working at one sync, done at the next.
async function hqWorks(lanes: [string, string][]) {
  world("working", lanes);
  await sync();
  world("done", lanes);
}

test("the first nudge, and the same list again once the interval has passed", async () => {
  await sync();
  await settle(1);
  await hqWorks([["alpha", "idle"], ["bravo", "working"]]);
  await wait(21);
  await sync();
  await settle(2);
});

test("HQ answered, but the list is the same: the wait doubles instead of starting over", async () => {
  await hqWorks([["alpha", "idle"], ["bravo", "working"]]);
  await wait(21);
  await sync();
  await settle(2); // 40 min now, not 20
  await wait(20);
  await sync();
  await settle(3);
});

test("HQ answered and the list changed: the wait starts over", async () => {
  const changed: [string, string][] = [["alpha", "idle"], ["bravo", "idle"]];
  await hqWorks(changed);
  await wait(21);
  await sync();
  await settle(4);
  expect(nudges()[3]).toContain("alpha, bravo");
});
