// GET /api/lanes/NAME/live, for the agent drawer: the lane's terminal tail (herdr pane read, 30 lines, on its own
// machine) with secret values blanked out, and what it last said, newest first. A stub herdr answers pane reads.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-lane-live-"));
const SECRET = "tok_live_9f8e7d6c5b4a";
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "api", agent_status: "working", pane_id: "w1:p2", agent: "codex" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const live = async (name: string) => { const r = await fetch(`${server.base}/api/lanes/${name}/live`); return { status: r.status, ...(await r.json()) }; };

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "api", title: "Token refresh", machine: "local" });
  await post("/api/lanes", { name: "quiet", title: "Not seen yet", machine: "local" });
  await post("/api/sync");
  // the pane shows a secret the HUD holds
  writeFileSync(join(dir, "block-start"), `• Ran curl -H "Authorization: Bearer ${SECRET}" https://api.example.com\n  └ 200 OK\n• Ran bun test\n  └ 14 pass, 0 fail\n`);
  expect((await post("/api/secrets", { name: "API_TOKEN", value: SECRET, minutes: 5, by: "owner" })).status).toBe(200);
  await post("/api/updates", { lane: "api", title: "Token refresh is up for review", body: "Sessions renew early." });
  await post("/api/asks", { lane: "api", kind: "decision", title: "Ship on Friday?", options: ["Yes", "No"] });
  await post("/api/rooms", { slug: "auth", title: "Auth", owner: "api" });
  await post("/api/rooms/auth/say", { text: "Tests pass locally.", as: "api" });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the terminal tail, read from the lane's pane, with the secret's value blanked out", async () => {
  const r = await live("api");
  expect(r.status).toBe(200);
  expect(r).toMatchObject({ name: "api", pane: "w1:p2", machine: "local" });
  expect(r.terminal.error).toBeNull();
  expect(r.terminal.text).toContain("14 pass, 0 fail");
  expect(r.terminal.text).toContain("Bearer [secret API_TOKEN]");
  expect(JSON.stringify(r)).not.toContain(SECRET);
  const read = herdr.calls().filter((c) => c[0] === "pane" && c[1] === "read").at(-1)!;
  expect(read).toEqual(["pane", "read", "w1:p2", "--lines", "30"]);
});

test("what it last said: its room message, question and update, newest first", async () => {
  const r = await live("api");
  const kinds = r.said.map((s: any) => s.kind);
  expect(kinds).toContain("update");
  expect(kinds).toContain("question");
  expect(kinds).toContain("room");
  expect(r.said.find((s: any) => s.kind === "room")).toMatchObject({ room: "auth", text: "Tests pass locally." });
  expect(r.said.find((s: any) => s.kind === "question")).toMatchObject({ title: "Ship on Friday?" });
  // the events that only echo the update and the question are left out
  expect(r.said.some((s: any) => s.kind === "event" && /^(update|asked): /.test(s.text))).toBe(false);
  expect(r.said.map((s: any) => s.at)).toEqual([...r.said.map((s: any) => s.at)].sort((a: number, b: number) => b - a));
});

test("two reads within a second and a half share one pane read", async () => {
  const before = herdr.calls().filter((c) => c[1] === "read").length;
  await Bun.sleep(1600);
  await Promise.all([live("api"), live("api"), live("api")]);
  expect(herdr.calls().filter((c) => c[1] === "read").length - before).toBe(1);
});

test("a lane herdr has not seen says so; an unknown lane is refused", async () => {
  const q = await live("quiet");
  expect(q.terminal).toMatchObject({ text: null, error: "herdr has not seen this lane's pane yet" });
  expect((await live("nobody")).status).toBeGreaterThanOrEqual(400);
});
