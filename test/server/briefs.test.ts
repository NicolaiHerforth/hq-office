// BRIEFS: a floor's HQ posts a brief (a title and a markdown body) with hud brief; the floor's BRIEFS page lists them
// newest first, and MESSAGES gets one short line linking to it. Each HQ's brief lands on its own floor. A stub herdr
// gives the HQs their panes, so hud's caller is found the way it is live.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-briefs-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "codex" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string) => { const r = await fetch(`${server.base}${p}`); return { status: r.status, ...(await r.json()) }; };
const hud = (args: string[], pane: string, stdin?: string) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
const BODY = "## Where we are\n\n| Lane | State |\n| --- | --- |\n| api | merged |\n\n- one\n- two";

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/sync");
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("hud brief --title --body: the brief, on the caller's floor, with a line in MESSAGES linking to it", async () => {
  const p = hud(["brief", "--title", "Weekly: pricing work", "--body", BODY], "w1:p1");
  expect(p.stderr.toString()).toBe("");
  expect(p.stdout.toString()).toMatch(/^brief #\d+ posted on HQ: Weekly: pricing work/);
  const s = await get("/api/state");
  const b = s.briefs[0];
  expect(b).toMatchObject({ floor: "hq", title: "Weekly: pricing work", by: "hq", read: false });
  expect(b.body).toBeUndefined(); // the state carries no bodies
  const full = await get(`/api/briefs/${b.id}`);
  expect(full).toMatchObject({ id: b.id, title: "Weekly: pricing work", body: BODY, floor: "hq" });
  const u = s.updates.find((x: any) => x.title === "New brief: Weekly: pricing work");
  expect(u).toMatchObject({ floor: "hq", body: `[Read the brief](#brief/${b.id})` });
});

test("--file and stdin give the body too; another floor's HQ posts on its floor", async () => {
  const file = join(DATA, "brief.md");
  writeFileSync(file, "# From a file\n\nText.\n");
  expect(hud(["brief", "--title", "From a file", "--file", file], "w1:p2").exitCode).toBe(0);
  expect(hud(["brief", "--title", "From stdin"], "w1:p1", "Piped **body**").exitCode).toBe(0);
  const s = await get("/api/state");
  expect(s.briefs.map((b: any) => [b.title, b.floor])).toEqual([["From stdin", "hq"], ["From a file", "crm"], ["Weekly: pricing work", "hq"]]);
  expect((await get(`/api/briefs/${s.briefs[1].id}`)).body).toBe("# From a file\n\nText.");
  expect((await get(`/api/briefs/${s.briefs[0].id}`)).body).toBe("Piped **body**");
});

test("refused without a title or a body; read marks it read; an unknown brief is 404", async () => {
  expect(hud(["brief", "--body", "x"], "w1:p1").exitCode).not.toBe(0);
  expect(hud(["brief", "--title", "Empty"], "w1:p1").exitCode).not.toBe(0);
  expect((await post("/api/briefs", { title: "x".repeat(201), body: "b" })).status).toBe(400);
  const id = (await get("/api/state")).briefs[0].id;
  expect((await post(`/api/briefs/${id}/read`)).status).toBe(200);
  expect((await get("/api/state")).briefs[0].read).toBe(true);
  expect((await get("/api/briefs/99999")).status).toBe(404);
});
