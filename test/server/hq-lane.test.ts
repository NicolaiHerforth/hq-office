// A lane promoted to run a floor (a floor's HQ that is also a registered lane, which keeps the rooms it owns
// delivering): its floor's sweep never reports it to itself as an idle, gone or done lane, and the office draws it at
// the terminal only, not also at a desk. A stub herdr; one minute is 40 ms here. The office check needs Chrome.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-lane-hq-"));
const herdr = join(data, "herdr"), agents = join(data, "agents.json"), log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s\\n%s\\n<<END>>\\n' "$3" "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
const a = (name: string, status: string) => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude" });
writeFileSync(agents, JSON.stringify([a("hq", "working"), a("ops-hq", "idle"), a("ops-idle", "idle")]));
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: unknown = {}) => (await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) })).json();
const sweepsTo = (agent: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter((p) => p.startsWith(`${agent}\nHUD sweep:`)) : []);

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_SWEEP_MINUTE_MS: "40", TZ: "UTC" } });
  await post("/api/sync");
  await post("/api/floors", { id: "ops", name: "Ops", hq: "ops-hq" });
  for (const name of ["ops-hq", "ops-idle"]) await post("/api/lanes", { name, floor: "ops", machine: "local" });
  await post("/api/sync");
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

test("the floor's sweep names its idle lane, never its HQ as one of its lanes", async () => {
  await post("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
  await post("/api/sync");
  const [n] = sweepsTo("ops-hq");
  expect(n).toContain("idle or done lanes 1: ops-idle");
  expect(n).not.toMatch(/lanes[^;]*ops-hq/);
});

test.skipIf(!findChrome())("the office draws the floor's HQ at the terminal only: no desk for it", async () => {
  const chrome = await startChrome();
  try {
    const page = await newSession(chrome.cdp, []);
    await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // in the ops floor (the page keeps the floor you are in in sessionStorage)
    await page.s("Page.navigate", { url: `${server.base}/` });
    await Bun.sleep(500);
    await page.evaluate(`sessionStorage.setItem("hq-scope", JSON.stringify({ floor: "ops", all: false })), true`);
    await page.s("Page.navigate", { url: `${server.base}/?again` });
    let names: string[] = [];
    for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(100)) {
      names = await page.evaluate(`import("/src/client/room/workers.js").then((m) => [...m.workers.keys()]).catch(() => [])`);
      if (names.includes("ops-idle")) break;
    }
    expect(names).toContain("ops-idle");
    expect(names).not.toContain("ops-hq");
  } finally {
    await chrome.close();
  }
}, 30_000);
