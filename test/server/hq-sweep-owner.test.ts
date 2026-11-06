// The HQ sweep and questions only the owner can answer: a sweep that would list nothing else goes once, not every
// interval, and again when the questions change; a lane to look at brings them back into the line. A stub herdr as in
// hq-sweep.test.ts; one minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-owner-"));
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
  world("idle", [["alpha", "working"]]);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_OWNER: "Owner", HUD_SWEEP_MINUTE_MS: String(MINUTE), TZ: "UTC" } });
  await post("/api/lanes", { name: "alpha", machine: "local" });
  await post("/api/asks", { title: "one question" });
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
// A sync can step aside while another one is typing the nudge in: wait for the count, then give an extra one a moment.
async function settle(n: number) {
  for (let i = 0; i < 100 && nudges().length < n; i++) await Bun.sleep(20);
  await Bun.sleep(80);
  expect(nudges()).toHaveLength(n);
}

test("only a question waiting on the owner: one nudge, not one every interval", async () => {
  await sync();
  await settle(1);
  expect(nudges()[0]).toContain("questions waiting on Owner 1");
  await wait(21);
  await sync();
  await wait(41);
  await sync();
  await settle(1);
});

test("a new question changes the list: it goes once more", async () => {
  await post("/api/asks", { title: "another question" });
  await wait(121);
  await sync();
  await settle(2);
  expect(nudges()[1]).toContain("questions waiting on Owner 2");
  await wait(121);
  await sync();
  await settle(2);
}, 20_000);

test("an idle lane besides the questions: the sweep goes, questions and all", async () => {
  world("idle", [["alpha", "idle"]]);
  await wait(121);
  await sync();
  await settle(3);
  expect(nudges()[2]).toContain("idle or done lanes 1: alpha; questions waiting on Owner 2");
}, 20_000);
