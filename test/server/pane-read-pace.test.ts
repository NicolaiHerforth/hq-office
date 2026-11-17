// A lane's pane is read when its status changes, and after that once a minute, not at every sync
// (docs/footprint.md): a lane that has finished says the same thing sync after sync. `hud sync` reads at once.
// Here a sync comes every 300 ms and "a minute" is 3 s.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-pane-pace-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
let herdr: ReturnType<typeof fakeHerdr>;
const post = (path: string, body: object = {}) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
const lane = async (name: string) => ((await (await fetch(`${server.base}/api/state`)).json()) as any).lanes.find((l: { name: string }) => l.name === name);
const until = async (check: () => Promise<boolean> | boolean, what: string, tries = 100) => { for (let i = 0; i < tries; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error(`never: ${what}`); };
// How often a pane was read, and how often herdr was asked for its agents (a sync).
const reads = (pane: string) => herdr.calls().filter((c) => c[0] === "pane" && c[1] === "read" && c[2] === pane).length;
const syncs = () => herdr.calls().filter((c) => c[0] === "agent" && c[1] === "list").length;
const agents = (rest: string) => [
  { name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" },
  { name: "rest", agent_status: rest, pane_id: "p-rest", agent: "claude" },
  { name: "busy", agent_status: "working", pane_id: "p-busy", agent: "claude" },
];

beforeAll(async () => {
  herdr = fakeHerdr(dir, agents("idle"));
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_SYNC_MS: "300", HUD_PANE_EVERY_MS: "3000", HUD_STATS_MS: "86400000", HUD_SUBS_MS: "86400000", HUD_MONITOR: "0" } });
  await post("/api/lanes", { name: "rest", phase: "running", machine: "local" });
  await post("/api/lanes", { name: "busy", phase: "running", machine: "local" });
});
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("a lane whose status stays is read once, not at every sync; a working lane never", async () => {
  await until(() => reads("p-rest") >= 1, "the first read");
  const at = syncs();
  await until(() => syncs() >= at + 5, "five more syncs");
  expect(reads("p-rest")).toBe(1);
  expect(reads("p-busy")).toBe(0);
}, 30_000);

test("what the pane says is kept between reads", async () => {
  herdr.blockStart("some output\n· 2 shells still running\n");
  await post("/api/sync"); // by hand: read now
  expect((await lane("rest")).bg).toBe("2 shells still running");
  const read = reads("p-rest"), at = syncs();
  await until(() => syncs() >= at + 4, "four more syncs");
  // Not read again, and not forgotten.
  expect(reads("p-rest")).toBe(read);
  expect((await lane("rest")).bg).toBe("2 shells still running");
  herdr.blockStart(null);
}, 30_000);

test("it is read again when its time is up, and what changed shows then", async () => {
  const read = reads("p-rest");
  await until(() => reads("p-rest") === read + 1, "the read a 'minute' later", 60);
  await until(async () => (await lane("rest")).bg === null, "the background work gone");
}, 30_000);

test("a change of status is read at the next sync", async () => {
  const read = reads("p-rest");
  herdr.world(agents("done"));
  await until(() => reads("p-rest") === read + 1, "the read after the change", 20);
  const at = syncs();
  await until(() => syncs() >= at + 4, "four more syncs");
  expect(reads("p-rest")).toBe(read + 1);
}, 30_000);

test("a lane that starts working is not read, and is read at once when it stops", async () => {
  herdr.world(agents("working"));
  const at = syncs();
  await until(() => syncs() >= at + 3, "three syncs");
  const read = reads("p-rest");
  herdr.world(agents("idle"));
  await until(() => reads("p-rest") === read + 1, "the read when it stopped", 20);
}, 30_000);

test("hud sync reads at once, whatever the time", async () => {
  const read = reads("p-rest");
  await post("/api/sync");
  expect(reads("p-rest")).toBeGreaterThanOrEqual(read + 1);
}, 30_000);

// A blocked lane, or one with a prompt on its screen, is read at every sync: its excerpt is the question panel's.
// (Not every agent list the stub counts is a sync, so three counted are at least two: a resting lane is read none.)
// With and without herdr's count of status changes (state_change_seq), which decides when a reading is still the same.
for (const seq of [true, false]) {
  test(`a blocked lane and a lane showing a prompt are read at every sync (${seq ? "with" : "without"} state_change_seq)`, async () => {
    const lanes = (status: string, n: number) => [
      { name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" },
      { name: "rest", agent_status: status, pane_id: "p-rest", agent: "claude", ...(seq ? { state_change_seq: n } : {}) },
      { name: "busy", agent_status: "working", pane_id: "p-busy", agent: "claude" },
    ];
    // Blocked at a prompt herdr's reading cannot make out (UNREAD, from an empty screen), then at one it can.
    herdr.blockStart(null);
    herdr.world(lanes("blocked", 7));
    await until(async () => (await lane("rest")).prompt === "a prompt is open in its pane", "the generic reading");
    let read = reads("p-rest"), at = syncs();
    await until(() => syncs() >= at + 3, "three syncs");
    expect(reads("p-rest")).toBeGreaterThanOrEqual(read + 2);
    herdr.blockStart("Push the branch to origin\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n");
    await until(async () => ((await lane("rest")).prompt ?? "").includes("Push the branch to origin"), "the excerpt, at the next sync", 20);
    read = reads("p-rest"); at = syncs();
    await until(() => syncs() >= at + 3, "three syncs");
    expect(reads("p-rest")).toBeGreaterThanOrEqual(read + 2);
    // Idle again with the same prompt on screen: still read at every sync while the prompt shows.
    herdr.world(lanes("idle", 8));
    await until(() => reads("p-rest") > read + 3, "the read after the change", 20);
    read = reads("p-rest"); at = syncs();
    await until(() => syncs() >= at + 3, "three syncs");
    expect(reads("p-rest")).toBeGreaterThanOrEqual(read + 2);
    // The prompt is gone: one more read sees it gone, and then the lane rests: once a minute.
    herdr.blockStart(null);
    await until(async () => (await lane("rest")).prompt === null, "the prompt gone");
    read = reads("p-rest"); at = syncs();
    await until(() => syncs() >= at + 4, "four syncs");
    expect(reads("p-rest")).toBeLessThanOrEqual(read + 1);
  }, 60_000);
}
