// A room's folder stays right when the system stops reporting file changes (macOS's file event service can stall):
// every herdr sync checks each open room's files/ for a change and catches the shelf up. HUD_FOLDER_WATCH=0 turns
// the event watching off, as if the system were silent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-folder-net-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  const herdr = join(DATA, "herdr");
  writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"pm","agent_status":"idle","pane_id":"p0","agent":"claude"}]}}' ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_FOLDER_WATCH: "0" } });
  await post("/api/lanes", { name: "pm", machine: "local" });
  await post("/api/rooms", { slug: "net", title: "Safety net", owner: "pm" });
});
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});
const post = (path: string, body: unknown = {}) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
const shelf = async () => (await (await fetch(`${server.base}/api/rooms/net`)).json()).artifactList.map((a: any) => a.title);
// A sync that lands while the file is still being written leaves it to settle (400 ms) first: wait for the result.
const shelfBecomes = async (want: string[]) => {
  for (let i = 0; i < 60; i++) {
    if (JSON.stringify(await shelf()) === JSON.stringify(want)) return;
    if (i % 10 === 9) await post("/api/sync");
    await Bun.sleep(50);
  }
  expect(await shelf()).toEqual(want);
};

test("with no file events, a file saved into files/ joins the shelf on the next sync, and leaves when deleted", async () => {
  const file = join(DATA, "rooms", "net", "files", "notes.txt");
  writeFileSync(file, "saved by a lane");
  await Bun.sleep(600); // past the settling time
  await post("/api/sync");
  await shelfBecomes(["notes.txt"]);
  unlinkSync(file);
  await post("/api/sync");
  await shelfBecomes([]);
});
