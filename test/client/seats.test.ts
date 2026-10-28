// A desk holds one worker. Each working lane keeps the desk its name points to unless another lane already has it,
// then takes the next free desk; with more workers at desks than desks, the rest stand in a row of their own by name.
// The owner: "agents can sit on top of each other at tables". Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-seats-"));
const herdr = join(dir, "herdr");
const agents = join(dir, "agents.json");
// 32 lanes: more than the office's 28 desks, all working (at their desks).
const NAMES = Array.from({ length: 32 }, (_, i) => `lane-${String(i + 1).padStart(2, "0")}`);
writeFileSync(agents, JSON.stringify([{ name: "hq", agent_status: "idle", pane_id: "p0", agent: "claude" }, ...NAMES.map((n, i) => ({ name: n, agent_status: "working", pane_id: `p${i + 1}`, agent: "claude" }))]));
writeFileSync(herdr, `#!/bin/sh\ncase "$1 $2" in\n  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;\nesac\nexit 0\n`);
chmodSync(herdr, 0o755);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const spots = `import("/src/client/room/workers.js").then(({ workers }) => JSON.stringify([...workers].map(([n, w]) => [n, w.target.x, w.target.y])))`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr });
  for (const name of NAMES) await server.post("/api/lanes", { name, machine: "local" });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === ${NAMES.length})`);
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("no two workers share a spot, with more workers than desks", async () => {
  const list: [string, number, number][] = JSON.parse(await page.evaluate(spots));
  const at = new Map<string, string[]>();
  for (const [n, x, y] of list) at.set(`${x},${y}`, [...(at.get(`${x},${y}`) ?? []), n]);
  expect([...at.values()].filter((v) => v.length > 1)).toEqual([]);
});

test.skipIf(!chromeFound)("a desk's worker keeps it when another lane comes or goes", async () => {
  const before = new Map<string, string>(JSON.parse(await page.evaluate(spots)).map(([n, x, y]: [string, number, number]) => [n, `${x},${y}`]));
  // lane-01 goes away: everyone else keeps their spot
  writeFileSync(agents, JSON.stringify([{ name: "hq", agent_status: "idle", pane_id: "p0", agent: "claude" }, ...NAMES.slice(1).map((n, i) => ({ name: n, agent_status: "working", pane_id: `p${i + 2}`, agent: "claude" }))]));
  await fetch(`${server.base}/api/lanes/delete`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ name: "lane-01" }) });
  await server.post("/api/sync", {});
  await until(`import("/src/client/room/workers.js").then(({ workers }) => !workers.has("lane-01"))`);
  const after = new Map<string, string>(JSON.parse(await page.evaluate(spots)).map(([n, x, y]: [string, number, number]) => [n, `${x},${y}`]));
  const desks = new Set<string>(JSON.parse(await page.evaluate(`import("/src/client/room/spots.js").then(({ SEATS }) => JSON.stringify(SEATS.map((s) => s.x + "," + s.y)))`)));
  // every worker that sat at a desk sits at the same desk; one from the aisle takes the freed one
  const moved = [...after].filter(([n, s]) => desks.has(before.get(n)!) && before.get(n) !== s).map(([n]) => n);
  expect(moved).toEqual([]);
  const freed = before.get("lane-01")!;
  expect([...after].filter(([, s]) => s === freed)).toHaveLength(1);
  expect(errors).toEqual([]);
});
