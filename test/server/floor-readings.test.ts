// The three readings per floor and for the whole office (docs/floors.md, "Three readings"): what waits on the owner
// (blocking, since oldestWaitAt), whether work happens (working of active), and since when nothing has moved
// (idleSince: null while a lane works, else when the last lane stopped working). S.floors[].counts and S.office use
// the same definitions, so the top bar, the switcher and the tiles agree. A stub herdr (test/fake-herdr.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-floor-readings-"));
const agent = (name: string, status = "idle") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude" });
const herdr = fakeHerdr(data, [agent("hq"), agent("hq-b"), agent("a1", "working"), agent("a2"), agent("b1"), agent("b2"), agent("b3")]);

let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const counts = async (id: string) => (await state()).floors.find((f: any) => f.id === id).counts;
const sync = () => post("/api/sync");

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false" } });
  await sync();
  expect((await post("/api/floors", { id: "b", name: "B", hq: "hq-b" })).status).toBe(200);
  for (const name of ["a1", "a2"]) await post("/api/lanes", { name, machine: "local", floor: "hq" });
  for (const name of ["b1", "b2", "b3"]) await post("/api/lanes", { name, machine: "local", floor: "b" });
  await post("/api/lanes", { name: "b3", phase: "done" });
  await sync();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

test("BLOCKING and WORK HAPPENING: questions and TO DOs waiting, the oldest, and working of active", async () => {
  const before = Date.now();
  await post("/api/asks", { lane: "a2", kind: "decision", title: "Pick", options: ["A", "B"] });
  await post("/api/asks", { lane: "a2", kind: "action", title: "Do it" });
  const a = await counts("hq");
  expect(a).toMatchObject({ blocking: 2, needsYou: 2, working: 1, active: 2, idleSince: null, lanes: 2 });
  expect(a.oldestWaitAt).toBeGreaterThanOrEqual(before - 1000);
  const b = await counts("b");
  expect(b).toMatchObject({ blocking: 0, oldestWaitAt: null, working: 0, active: 2, lanes: 3 }); // b3 is done: not active
});

test("NOTHING MOVING: idleSince is when the last lane stopped working, null while one works", async () => {
  const b = await counts("b");
  expect(b.idleSince).toBeGreaterThan(0);
  herdr.world([...herdr.agents().filter((x) => x.name !== "b1"), agent("b1", "working")]);
  await sync();
  expect((await counts("b")).idleSince).toBeNull();
  const stopped = Date.now();
  herdr.world([...herdr.agents().filter((x) => x.name !== "b1"), agent("b1")]);
  await sync();
  const idle = (await counts("b")).idleSince;
  expect(idle).toBeGreaterThanOrEqual(stopped - 50);
  expect(idle).toBeLessThanOrEqual(Date.now());
});

test("the whole office (S.office) uses the same definitions: the sums, and idle only when no floor works", async () => {
  const s = await state();
  const sum = (k: string) => s.floors.reduce((n: number, f: any) => n + f.counts[k], 0);
  expect(s.office).toMatchObject({ blocking: sum("blocking"), working: sum("working"), active: sum("active"), lanes: sum("lanes"), idleSince: null });
  expect(s.office.blocking).toBe(s.open.length);
  expect(s.office.oldestWaitAt).toBe(Math.min(...s.open.map((a: any) => a.created_at)));
  // a1 stops: nothing works anywhere, and the office is idle since a1 stopped.
  herdr.world([...herdr.agents().filter((x) => x.name !== "a1"), agent("a1")]);
  await sync();
  const o = (await state()).office;
  expect(o.working).toBe(0);
  expect(o.idleSince).toBeGreaterThan(0);
});
