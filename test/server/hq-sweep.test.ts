// The HQ sweep nudge: with HQ SWEEP on in SETTINGS (off by default), the server types one "HUD sweep:" line into HQ
// when HQ is idle or done right now, is receiving, the interval has passed since the last nudge, and the hour is in
// the window. It lists what HQ should look at: idle or done lanes, lanes on HQ's turn, stalled board items,
// questions waiting on the owner, rooms with undelivered messages; with nothing to list it sends nothing. A nudge HQ
// does not act on doubles the wait (up to 2 h). Never queued: a nudge that cannot be sent is dropped.
// A stub herdr: agents.json is what `agent list` answers; prompts are logged. One minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-test-"));
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
const hq = (status: string) => ({ name: "hq", agent_status: status, pane_id: "w8:p1", agent: "claude" });
const lane = (name: string, status: string) => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude" });
const world = (hqStatus: string | null, lanes: [string, string][] = []) =>
  writeFileSync(agents, JSON.stringify([...(hqStatus ? [hq(hqStatus)] : []), ...lanes.map(([n, s]) => lane(n, s))]));
world("idle", [["alpha", "idle"], ["bravo", "working"]]);

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_SWEEP_MINUTE_MS: String(MINUTE), TZ: "UTC" } }); // the test runner's own clock is UTC: the same hours on both sides
  for (const name of ["alpha", "bravo"]) await post("/api/lanes", { name, machine: "local" });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return res.json();
}
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const nudges = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter((p) => p.startsWith("HUD sweep:")) : []);
const sync = () => post("/api/sync");
const settings = (s: Record<string, unknown>) => post("/api/settings", { settings: s });
const wait = (minutes: number) => Bun.sleep(minutes * MINUTE);

test("off by default: nothing is sent, and the state says so", async () => {
  await sync();
  await wait(1);
  expect(nudges()).toEqual([]);
  expect((await state()).sweep).toMatchObject({ on: false, minutes: 20, hours: "8-24" });
});

test("on, HQ idle, an idle lane: one nudge listing it, and an event", async () => {
  await settings({ hqSweep: true, hqSweepHours: "0-24" });
  await sync();
  expect(nudges()).toHaveLength(1);
  const [n] = nudges();
  expect(n).toContain("idle or done lanes 1: alpha");
  expect(n).not.toContain("bravo");
  const s = await state();
  expect(s.events.some((e: any) => e.text.startsWith("nudged HQ: "))).toBe(true);
  expect(s.sweep.lastAt).toBeGreaterThan(0);
});

test("not again within the interval", async () => {
  await sync();
  await sync();
  expect(nudges()).toHaveLength(1);
});

test("never while HQ is working, even after the interval; once HQ is idle again, it goes", async () => {
  world("working", [["alpha", "idle"]]);
  await wait(21);
  await sync();
  expect(nudges()).toHaveLength(1);
  world("done", [["alpha", "idle"]]);
  await sync();
  expect(nudges()).toHaveLength(2); // HQ worked since the last nudge: no backoff
});

test("a nudge HQ does not act on doubles the wait", async () => {
  await wait(21);
  await sync();
  expect(nudges()).toHaveLength(2); // HQ has not worked since the last nudge: 40 min now
  await wait(20);
  await sync();
  expect(nudges()).toHaveLength(3);
  expect((await state()).sweep.backoff).toBe(2);
});

test("nothing to look at: nothing is sent", async () => {
  // A lane's request waits in HQ's queue, not on the owner: the sweep must not count it as a question waiting on him.
  await post("/api/requests", { lane: "alpha", kind: "READY", text: "pushed" });
  world("working", []);
  await sync();
  world("idle", [["alpha", "working"], ["bravo", "working"]]);
  await wait(21);
  await sync();
  expect(nudges()).toHaveLength(3);
});

test("outside the hours window: nothing is sent", async () => {
  const h = new Date().getUTCHours();
  await settings({ hqSweepHours: `${(h + 1) % 24}-${(h + 2) % 24}` });
  world("idle", [["alpha", "idle"]]);
  await wait(21);
  await sync();
  expect(nudges()).toHaveLength(3);
});

test("HQ not receiving: nothing is sent and nothing is queued for later", async () => {
  await settings({ hqSweepHours: "0-24" });
  world(null, [["alpha", "idle"]]);
  await sync();
  world("idle", [["alpha", "idle"]]);
  await post("/api/hq/check");
  expect(nudges()).toHaveLength(4); // the one sent now, fresh; the missed one was never held
  expect((await state()).hq.held).toEqual([]);
});

test("switched off: nothing is sent", async () => {
  await settings({ hqSweep: false });
  await wait(41);
  await sync();
  expect(nudges()).toHaveLength(4);
});
