// The owner's settings live in the data directory: set them, restart the server on the same data, read them back.
// Writes need the x-hud header; a migration (ifEmpty) only lands on a server with no settings; bad values are refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-office-settings-"));
let BASE = "";
let server: Awaited<ReturnType<typeof spawnServer>> | null = null;

async function start() {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_MACHINES: "local" },
  });
  BASE = server.base;
}
async function stop() {
  await server?.stop();
  server = null;
}
const post = (body: object, headers: Record<string, string> = { "x-hud": "1" }) =>
  fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const stateSettings = async () => (await (await fetch(`${BASE}/api/state`)).json()).settings;

beforeAll(start);
afterAll(async () => {
  await stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("a new server has no settings, in the state and on GET", async () => {
  expect(await stateSettings()).toEqual({});
  expect(await (await fetch(`${BASE}/api/settings`)).json()).toEqual({ settings: {} });
});

test("a write without the x-hud header is refused and changes nothing", async () => {
  expect((await post({ settings: { hero: "IVY" } }, {})).status).toBe(403);
  expect(await stateSettings()).toEqual({});
});

test("a migration lands on a server with no settings", async () => {
  const res = await post({ settings: { hero: "IVY", season: "auto", hat: "auto", sound: true }, ifEmpty: true });
  expect(res.status).toBe(200);
  expect((await res.json()).settings).toEqual({ hero: "IVY", season: "auto", hat: "auto", sound: true });
});

test("a second migration does not overwrite what is there", async () => {
  const res = await post({ settings: { hero: "YOU", sound: false }, ifEmpty: true });
  expect((await res.json()).settings.hero).toBe("IVY");
  expect((await stateSettings()).sound).toBe(true);
});

test("a change sets only the keys given; null goes back to the default", async () => {
  const res = await post({ settings: { season: "winter", hat: null, performance: "saver" } });
  expect((await res.json()).settings).toEqual({ hero: "IVY", season: "winter", sound: true, performance: "saver" });
  expect(await stateSettings()).toEqual({ hero: "IVY", season: "winter", sound: true, performance: "saver" });
});

test("bad names and values are refused", async () => {
  for (const settings of [null, [1], { "": 1 }, { "bad key": 1 }, { hero: { nested: true } }, { n: [1] }]) {
    const res = await post({ settings });
    expect({ settings, status: res.status }).toEqual({ settings, status: 400 });
  }
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
  expect((await post({ settings: many })).status).toBe(400);
  expect(await stateSettings()).toEqual({ hero: "IVY", season: "winter", sound: true, performance: "saver" });
});

test("a long text is kept whole: no setting has a length limit", async () => {
  const long = "x".repeat(5000);
  expect((await post({ settings: { levels: long } })).status).toBe(200);
  expect((await stateSettings()).levels).toBe(long);
  expect((await post({ settings: { levels: null } })).status).toBe(200);
  expect(await stateSettings()).toEqual({ hero: "IVY", season: "winter", sound: true, performance: "saver" });
});

test("settings survive a restart", async () => {
  await stop();
  await start();
  expect(await stateSettings()).toEqual({ hero: "IVY", season: "winter", sound: true, performance: "saver" });
});
