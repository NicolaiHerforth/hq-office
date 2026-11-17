// A push costs what changed, not the size of the history (docs/footprint.md, "A push"):
// - a POST that left the database as it was does not bump the version, and sends nothing;
// - a part that reads only some tables (the briefs list) is built again only after a write to one of them, or
//   after a secret changed, since its first lines are masked with the secrets;
// - a write a page shows arrives as that part alone, and one no page shows sends nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-push-parts-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = (path: string, body: object) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
const get = (path: string) => fetch(`${server.base}${path}`).then((r) => r.json() as any);
const until = async (check: () => Promise<boolean> | boolean, what: string) => { for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error(`never: ${what}`); };
// Longer than the stream waits before it looks (250 ms).
const settle = () => Bun.sleep(700);

// One open page: every message's parts, by name.
const pushes: string[][] = [];
let reader: ReadableStreamDefaultReader<Uint8Array>;
async function listen() {
  reader = (await fetch(`${server.base}/api/stream`)).body!.getReader();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith("data: ")) pushes.push(Object.keys(JSON.parse(buf.slice(6, i))));
    }
  })().catch(() => {});
  await until(() => pushes.length === 1, "the whole state");
}

beforeAll(async () => {
  fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" }]);
  // No sampler bumps while the test counts: the machines and the subscriptions are read once, at the start.
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: join(dir, "herdr"), HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_STATS_MS: "86400000", HUD_SUBS_MS: "86400000", HUD_MONITOR: "0" } });
  await until(async () => (await get("/api/state")).hq?.ok === true, "herdr shows HQ");
    await until(async () => !!(await get("/api/state")).machines?.[0]?.sample && Object.keys((await get("/api/push")).bumps).some((b) => b.includes("the machines' sample")), "the first machine sample and its bump");
  await post("/api/briefs", { title: "A page", body: "<!doctype html><html><body><p>The password is TEST_ONLY_PUSH_PARTS_7c2a, keep it.</p></body></html>" });
  await listen();
  await settle();
});
afterAll(async () => {
  await reader?.cancel().catch(() => {});
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("a POST that wrote nothing does not bump the version and sends nothing", async () => {
  const before = await get("/api/push"), sent = pushes.length;
  // A mark for the monitor's timeline, with the monitor off: nothing is kept, in any database.
  expect(await post("/api/monitor/marks", { text: "a test run started" })).toEqual({ ok: true, kept: false });
  await settle();
  const after = await get("/api/push");
  expect(after.version).toBe(before.version);
  expect(after.touches["POST /api/monitor/marks"]).toBe((before.touches["POST /api/monitor/marks"] ?? 0) + 1);
  expect(after.bumps["POST /api/monitor/marks"]).toBeUndefined();
  // The page looked, found nothing changed and was sent nothing.
  expect(after.looks).toBe(before.looks + 1);
  expect(after.quiet).toBe(before.quiet + 1);
  expect(pushes.length).toBe(sent);
});

test("a write no page shows bumps, and sends nothing", async () => {
  const before = await get("/api/push"), sent = pushes.length;
  await post("/api/events", { who: "hq", text: "for the log only" });
  await settle();
  const after = await get("/api/push");
  expect(after.version).toBe(before.version + 1);
  expect(after.bumps["POST /api/events"]).toBe((before.bumps["POST /api/events"] ?? 0) + 1);
  expect(pushes.length).toBe(sent);
  // HQ still reads it where it always did.
  expect((await get("/api/state")).events[0].text).toBe("for the log only");
});

test("a write a page shows arrives as its part, with the version", async () => {
  const sent = pushes.length;
  await post("/api/notes", { text: "Keep going." });
  await until(() => pushes.length > sent, "the push");
  const parts = pushes.slice(sent).flat();
  expect(parts).toContain("version");
  expect(parts).toContain("notes");
  for (const untouched of ["briefs", "board", "machines", "updates", "open", "answered", "rooms"]) expect(parts).not.toContain(untouched);
});

test("the briefs list is built again after a brief is written or a secret changed, and not otherwise", async () => {
  const built = async () => (await get("/api/push")).partsBuilt.briefs as number;
  const lead = async () => ((await get("/api/state")).briefs as { title: string; lead: string }[]).find((b) => b.title === "A page")!.lead;
  const start = await built();
  // Looks without a write: a POST that writes nothing, and reads of the whole state.
  for (let i = 0; i < 3; i++) await post("/api/monitor/marks", { text: `mark ${i}` });
  await settle();
  expect(await lead()).toContain("TEST_ONLY_PUSH_PARTS_7c2a");
  expect(await built()).toBe(start);
  // A write to another table: still not built.
  await post("/api/notes", { text: "Another." });
  await settle();
  await get("/api/state");
  expect(await built()).toBe(start);
  // A write to its own table: built once, however many looks follow.
  await post("/api/briefs", { title: "A second one", body: "Plain words." });
  await settle();
  await get("/api/state");
  await get("/api/state");
  expect(await built()).toBe(start + 1);
  expect((await get("/api/state")).briefs.map((b: { title: string }) => b.title)).toEqual(["A second one", "A page"]);
  expect((await get("/api/push")).writesNoTableNamed).toBe(0);
  // A secret with that value: the list is made again and the value is masked in it, on the page too.
  const sent = pushes.length;
  expect((await post("/api/secrets", { name: "PAGE_PASS", value: "TEST_ONLY_PUSH_PARTS_7c2a", minutes: 5, by: "owner" })).error).toBeUndefined();
  await until(async () => !(await lead()).includes("TEST_ONLY_PUSH_PARTS_7c2a"), "the first lines masked");
  await until(() => pushes.slice(sent).flat().includes("briefs"), "the masked list on the page");
  expect(await built()).toBeGreaterThan(start + 1);
});
