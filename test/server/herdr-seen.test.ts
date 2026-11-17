// When herdr last saw a lane is kept in memory, and a floor's HQ pane is written only when it changes: a sync that
// finds nothing changed writes nothing to the database
// (docs/footprint.md), and /api/state still says when each lane was last seen. A sync comes every 300 ms here.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-herdr-seen-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
let herdr: ReturnType<typeof fakeHerdr>;
const get = (path: string) => fetch(`${server.base}${path}`).then((r) => r.json() as any);
const post = (path: string, body: object = {}) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
const until = async (check: () => Promise<boolean> | boolean, what: string) => { for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error(`never: ${what}`); };
const lane = async () => (await get("/api/state")).lanes.find((l: { name: string }) => l.name === "rest");
const syncs = () => herdr.calls().filter((c) => c[0] === "agent" && c[1] === "list").length;
// The row as the database file has it, read from outside (a throwaway file: this test's own).
const row = () => {
  const db = new Database(join(dir, "hud.db"), { readonly: true });
  try { return db.query("SELECT herdr, herdr_seen FROM lanes WHERE name = 'rest'").get() as { herdr: string; herdr_seen: number | null }; } finally { db.close(); }
};
const agents = (status: string) => [{ name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" }, { name: "rest", agent_status: status, pane_id: "p-rest", agent: "claude" }];

beforeAll(async () => {
  herdr = fakeHerdr(dir, agents("working"));
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_SYNC_MS: "300", HUD_STATS_MS: "86400000", HUD_SUBS_MS: "86400000", HUD_MONITOR: "0" } });
  await post("/api/lanes", { name: "rest", phase: "running", machine: "local" });
  await until(async () => (await lane())?.herdr === "working", "herdr shows the lane");
  // The one machine sample of this run (it bumps) is over before the test counts.
  await until(async () => !!(await get("/api/state")).machines?.[0]?.sample && Object.keys((await get("/api/push")).bumps).some((b) => b.includes("the machines' sample")), "the first machine sample and its bump");
});
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("syncs that change nothing write nothing, and the state still says when the lane was last seen", async () => {
  const stored = row(), seen = (await lane()).herdr_seen as number, before = await get("/api/push"), at = syncs();
  await until(() => syncs() >= at + 5, "five more syncs");
  // The page's state moves on with every sync.
  const later = (await lane()).herdr_seen as number;
  expect(later).toBeGreaterThan(seen);
  expect(Date.now() - later).toBeLessThan(3000);
  // The database does not: the row is as it was, no table was written to, and no sync bumped.
  expect(row()).toEqual(stored);
  expect((await get("/api/push")).writes).toEqual(before.writes);
  const after = await get("/api/push");
  expect(after.bumps).toEqual(before.bumps);
  expect(after.version).toBe(before.version);
}, 30_000);

test("a change of status writes the row, with when it was seen", async () => {
  const stored = row();
  herdr.world(agents("idle"));
  await until(async () => (await lane()).herdr === "idle", "the new status");
  expect(row().herdr).toBe("idle");
  expect(row().herdr_seen).toBeGreaterThan(stored.herdr_seen ?? 0);
}, 30_000);
