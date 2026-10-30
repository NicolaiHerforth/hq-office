// A page address listed in HUD_TRUSTED_ORIGINS (a phone over Tailscale serve) may read and write like the
// machine's own page; any other origin is still refused. Secrets save from a listed address too, behind the browser's
// same-origin mark and x-hud; no secret route gives a value to a page.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
let BASE = "";
const PHONE = "https://office.example.ts.net:4747";
const DATA = mkdtempSync(join(tmpdir(), "hq-office-origins-"));
let server: Awaited<ReturnType<typeof spawnServer>>;

beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_TRUSTED_ORIGINS: `${PHONE}/` },
  });
  BASE = server.base;
});

afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

const from = (origin: string, path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), origin } });

test("a listed page address reads and writes", async () => {
  expect((await from(PHONE, "/api/state")).status).toBe(200);
  const tell = await from(PHONE, "/api/updates", { method: "POST", headers: { "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify({ title: "from the phone" }) });
  expect(tell.status).not.toBe(403);
});

test("any other origin is still refused", async () => {
  expect((await from("https://elsewhere.example", "/api/state")).status).toBe(403);
});

// A save as a browser sends it from a page: its Origin, Sec-Fetch-Site and the page's x-hud.
const save = (origin: string, extra: Record<string, string> = {}, name = "DEMO_KEY") =>
  fetch(`${BASE}/api/secrets`, { method: "POST", headers: { origin, "sec-fetch-site": "same-origin", "x-hud": "1", "content-type": "application/json", ...extra }, body: JSON.stringify({ name, value: "not-a-real-value-123", minutes: 6000, by: "owner" }) });

test("a secret saves from a listed page address (the tailnet), as from the machine's own page", async () => {
  const r = await save(PHONE);
  expect(r.status).toBe(200);
  const m = await r.json();
  expect(m).toMatchObject({ name: "DEMO_KEY", by: "owner" });
  expect(JSON.stringify(m)).not.toContain("not-a-real-value-123");
  // its list of names (never a value) and DELETE work from there too
  const list = await fetch(`${BASE}/api/secrets`, { headers: { origin: PHONE, "sec-fetch-site": "same-origin" } });
  expect(list.status).toBe(200);
  const text = await list.text();
  expect(text).toContain("DEMO_KEY");
  expect(text).not.toContain("not-a-real-value-123");
  const rm = await fetch(`${BASE}/api/secrets/rm`, { method: "POST", headers: { origin: PHONE, "sec-fetch-site": "same-origin", "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "DEMO_KEY" }) });
  expect(rm.status).toBe(200);
});

test("over plain http a browser sends no Sec-Fetch-Site: a listed origin with x-hud still saves", async () => {
  const r = await fetch(`${BASE}/api/secrets`, { method: "POST", headers: { origin: PHONE, "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify({ name: "HTTP_KEY", value: "not-a-real-value-456", minutes: 5, by: "owner" }) });
  expect(r.status).toBe(200);
});

test("refused: an origin not listed, and a listed one marked cross-site or without x-hud (a forged form)", async () => {
  for (const r of [await save("https://elsewhere.example", {}, "A_KEY"), await save(PHONE, { "sec-fetch-site": "cross-site" }, "B_KEY"), await save(PHONE, { "x-hud": "0" }, "C_KEY")]) {
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("forbidden");
  }
  const names = await (await fetch(`${BASE}/api/secrets`)).text();
  for (const n of ["A_KEY", "B_KEY", "C_KEY"]) expect(names).not.toContain(n);
});
