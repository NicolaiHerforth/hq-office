// Updates from HQ (the FROM HQ tab): posting one, unread counts in /api/state, reading one or all, the guards,
// and hud tell with its alias hud say. A server on a spare port with a throwaway data dir.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
let BASE = "";
const DATA = mkdtempSync(join(tmpdir(), "hq-updates-test-"));
let server: Awaited<ReturnType<typeof spawnServer>>;

beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local" },
  });
  BASE = server.base;
});

afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string> = { "x-hud": "1" }) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const hud = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`hud ${args.join(" ")}: ${err}`);
};

test("an update from HQ shows in state as unread, and reading clears it", async () => {
  const first = await (await post("/api/updates", { title: "PR is up", body: "details", lane: "build" })).json();
  await post("/api/updates", { title: "Second" });
  let s = await state();
  expect(s.updatesUnread).toBe(2);
  expect(s.updates.map((u: any) => u.title)).toEqual(["Second", "PR is up"]);
  expect(s.updates[1]).toMatchObject({ lane: "build", body: "details", read_at: null });

  await post(`/api/updates/${first.id}/read`, {});
  s = await state();
  expect(s.updatesUnread).toBe(1);

  await post("/api/updates/read-all", {});
  s = await state();
  expect(s.updatesUnread).toBe(0);
});

test("an update needs a title and the x-hud header", async () => {
  expect((await post("/api/updates", { body: "no title" })).status).toBe(400);
  expect((await post("/api/updates", { title: "x" }, {})).status).toBe(403);
});

test("hud tell and hud say both post an update", async () => {
  await hud("tell", "--title", "Told", "--lane", "build");
  await hud("say", "--title", "Said", "--body", "the alias");
  const s = await state();
  expect(s.updates.slice(0, 2).map((u: any) => [u.title, u.lane, u.body])).toEqual([["Said", null, "the alias"], ["Told", "build", null]]);
  expect(s.updatesUnread).toBe(2);
});

// Scoped reading: a floor's or an agent's updates, not everyone's. Lanes gen > mid > eng make gen a floor; an update
// with no lane, or from a lane that is gone, is on HQ's floor.
test("read-all with a floor or a lane marks only those updates; with nothing it marks all", async () => {
  const lane = (name: string, parent?: string) => post("/api/lanes", { name, parent });
  await lane("gen");
  await lane("mid", "gen");
  await lane("eng", "mid");
  await lane("solo");
  const seed = async () => {
    await post("/api/updates/read-all", {});
    for (const lane of ["gen", "eng", "solo", "ghost", undefined]) await post("/api/updates", { title: `from ${lane ?? "nobody"}`, lane });
  };
  const unread = async () => ((await state()).updates as any[]).filter((u) => !u.read_at).map((u) => u.lane ?? "").sort();

  await seed();
  await post("/api/updates/read-all", { floor: "gen" });
  expect(await unread()).toEqual(["", "ghost", "solo"]);

  await seed();
  await post("/api/updates/read-all", { floor: "hq" });
  expect(await unread()).toEqual(["eng", "gen"]);

  await seed();
  await post("/api/updates/read-all", { lane: "eng" });
  expect(await unread()).toEqual(["", "gen", "ghost", "solo"]);

  await seed();
  await post("/api/updates/read-all", {});
  expect(await unread()).toEqual([]);
});

test("the per-lane unread counts add up to updatesUnread", async () => {
  await post("/api/updates/read-all", {});
  for (const lane of ["solo", "solo", "eng", undefined]) await post("/api/updates", { title: "n", lane });
  const s = await state();
  expect(s.updatesUnreadByLane).toEqual({ solo: 2, eng: 1, "": 1 });
  expect(Object.values(s.updatesUnreadByLane as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(s.updatesUnread);
});
