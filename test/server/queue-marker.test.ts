// HQ's queue hook tests for a file before it starts anything (bin/queue-hook.ts): the server keeps that file there
// exactly while HQ QUEUE is off, from its start and at every change of the setting. Only that file skips the hook, so
// a write that fails leaves the hook running, and says so in the log.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { queueMarker } from "../../bin/queue-hook.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-queue-marker-"));
const marker = queueMarker(dir);
const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: join(dir, "no-herdr"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_MONITOR: "0" };
let server: Awaited<ReturnType<typeof spawnServer>>;
const set = (hqQueue: boolean) => fetch(`${server.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ settings: { hqQueue } }) }).then((r) => r.json());

beforeAll(async () => { server = await spawnServer({ cwd: ROOT, env }); });
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the off-marker is there while HQ QUEUE is off, and only then", async () => {
  expect(marker).toBe(join(dir, "hq-queue.off"));
  // Off by default: written at the start.
  expect(existsSync(marker)).toBe(true);
  await set(true);
  expect(existsSync(marker)).toBe(false);
  await set(false);
  expect(existsSync(marker)).toBe(true);
}, 30_000);

test("a server that starts with the queue off puts the marker back, and removes the old on-marker", async () => {
  await set(false);
  await server.stop();
  rmSync(marker);
  writeFileSync(join(dir, "hq-queue.on"), "from before\n");
  server = await spawnServer({ cwd: ROOT, env });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(join(dir, "hq-queue.on"))).toBe(false);
}, 30_000);

test("a marker that cannot be written leaves the hook running, and the log says why", async () => {
  await server.stop();
  rmSync(marker);
  // The old on-marker as a folder with something in it: removing it throws before the off-marker is written.
  mkdirSync(join(dir, "hq-queue.on", "in-the-way"), { recursive: true });
  const said: string[] = [];
  server = await spawnServer({ cwd: ROOT, env, out: (c) => said.push(new TextDecoder().decode(c)) });
  expect(existsSync(marker)).toBe(false);
  expect(said.join("")).toContain("could not write or remove");
  rmSync(join(dir, "hq-queue.on"), { recursive: true, force: true });
}, 30_000);
