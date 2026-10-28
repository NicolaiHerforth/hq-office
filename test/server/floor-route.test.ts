// A floor's copy of the room modules: /floor/<id>/src/client/... answers with the same bytes and type as the page's own
// file, and cannot reach outside src/client. A server on a spare port with a throwaway data dir.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-floor-route-"));
let server: Awaited<ReturnType<typeof spawnServer>>;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr") } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("a floor's copy of a file is the page's own file", async () => {
  for (const file of ["room/loop.js", "room/here.js", "room/room.css"]) {
    const own = await fetch(`${server.base}/src/client/${file}`);
    const copy = await fetch(`${server.base}/floor/g/src/client/${file}`);
    expect(copy.status).toBe(200);
    expect(copy.headers.get("content-type")).toBe(own.headers.get("content-type"));
    expect(await copy.text()).toBe(await own.text());
  }
});

test("a floor's path cannot leave src/client, and a missing file is a 404", async () => {
  for (const path of ["/floor/g/src/client/..%2f..%2fserver.ts", "/floor/g/src/client/%2e%2e%2f%2e%2e%2fpackage.json", "/floor/g/src/client/room/nope.js", "/floor/g/server.ts", "/floor//src/client/room/loop.js"]) {
    expect((await fetch(`${server.base}${path}`)).status).toBe(404);
  }
});
