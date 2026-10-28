// Before its first herdr sync the server cannot tell a gone lane from a live one, so it refuses to close a lane's
// request as gone. Own server, own data dir, a fake herdr whose agent list never answers in time.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const PORT = probe.port;
probe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "hq-office-first-sync-"));
let server: ReturnType<typeof Bun.spawn>;

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const get = async (path: string) => (await fetch(BASE + path)).json();

beforeAll(async () => {
  // `agent list` hangs past the test; anything else succeeds quietly.
  writeFileSync(join(DATA, "herdr"), `#!/bin/sh\ncase "$*" in\n*"agent list"*) sleep 10 ;;\nesac\nexit 0\n`);
  chmodSync(join(DATA, "herdr"), 0o755);
  server = Bun.spawn([process.execPath, "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, HUD_PORT: String(PORT), HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "herdr") },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await Bun.sleep(100)) {
    try {
      await get("/api/state");
      return;
    } catch {}
  }
  throw new Error(`server did not come up on port ${PORT}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(DATA, { recursive: true, force: true });
});

test("before the first sync a lane's request cannot be closed as gone; it stays open", async () => {
  expect((await get("/api/state")).sync.at).toBe(0);
  const filed = await post("/api/requests", { kind: "BLOCK", lane: "quiet-lane", text: "need the seeding answer" });
  expect(filed.status).toBe(200);
  const id = filed.body.id;
  const closed = await post(`/api/requests/${id}/close`, { reason: "the lane is gone" });
  expect(closed.status).not.toBe(200);
  expect(JSON.stringify(closed.body)).toContain("has not listed herdr's agents since it started");
  expect((await get("/api/requests")).some((r: any) => r.id === id)).toBe(true);
});
