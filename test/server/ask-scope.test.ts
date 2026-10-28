// An open ask holds only what it is about. Named work waits on the owner; a question on a lane that names no
// tracked work holds that lane's work only while the lane is not working; a working lane with a question open still
// reads as working. Two layers:
//   1. board.ts on an in-memory database with a fake clock.
//   2. server.ts and hud.ts end to end, with a stub herdr that reports one working and one idle agent.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { createBoard } from "../../src/server/board.ts";

const MIN = 60_000;

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lanes (name TEXT PRIMARY KEY, herdr TEXT, herdr_since INTEGER, bg TEXT, issue TEXT, pr TEXT, parent TEXT);
    CREATE TABLE asks (id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, answered_at INTEGER, recipient TEXT NOT NULL DEFAULT 'owner');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT, who TEXT NOT NULL, text TEXT NOT NULL);
  `);
  const clock = { t: Date.parse("2026-01-05T09:00:00Z") };
  const board = createBoard({ db, now: () => clock.t, gh: async () => { throw new Error("no gh in this test"); } });
  const item = (issue: string) => board.view().items.find((i) => i.issue === issue)!;
  const lane = (name: string, herdr: string | null, bg: string | null = null) =>
    db.query("INSERT INTO lanes (name, herdr, herdr_since, bg) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET herdr = excluded.herdr, bg = excluded.bg").run(name, herdr, clock.t - 90 * MIN, bg);
  const ask = (laneName: string | null, title: string, body: string | null = null) =>
    Number(db.query("INSERT INTO asks (lane, title, body, created_at) VALUES (?, ?, ?, ?)").run(laneName, title, body, clock.t - 90 * MIN).lastInsertRowid);
  return { db, clock, board, item, lane, ask };
}

describe("board.ts: which work an open ask holds", () => {
  test("the live case: a working lane with a question that names nothing keeps both its issues moving", () => {
    const s = setup();
    s.lane("app", "working");
    s.board.track({ issue: "OPE-1934", lane: "app" });
    s.board.track({ issue: "OPE-1935", lane: "app" });
    s.ask("app", "Go live?", "Waiting on the reviewer login.");
    for (const issue of ["OPE-1934", "OPE-1935"]) {
      expect(s.item(issue).state).toBe("moving");
      expect(s.item(issue).openAsks).toEqual([]);
    }
    s.board.stop();
  });

  test("an ask naming one item holds only that item, not another on the same lane", () => {
    const s = setup();
    s.lane("app", "working");
    s.board.track({ issue: "OPE-10", lane: "app" });
    s.board.track({ issue: "OPE-11", lane: "app" });
    const id = s.ask("app", "Merge OPE-10 now?");
    expect(s.item("OPE-10").state).toBe("owner");
    expect(s.item("OPE-10").why).toBe(`ask #${id}: Merge OPE-10 now?`);
    expect(s.item("OPE-11").state).toBe("moving");
    // Still only the named item once the lane goes idle: the ask is about OPE-10, not the lane.
    s.lane("app", "idle");
    expect(s.item("OPE-10").state).toBe("owner");
    expect(s.item("OPE-11").state).not.toBe("owner");
    // By PR number in the body, too.
    s.board.track({ issue: "OPE-12", lane: "app", prs: ["4242"] });
    const pr = s.ask("app", "Which way?", "see #4242");
    expect(s.item("OPE-12").why).toBe(`ask #${pr}: Which way?`);
    expect(s.item("OPE-11").state).not.toBe("owner");
    s.board.stop();
  });

  test("a question on the lane that names nothing holds its work only while the lane is not working", () => {
    const s = setup();
    s.lane("app", "idle");
    s.board.track({ issue: "OPE-20", lane: "app" });
    s.board.track({ issue: "OPE-21", lane: "app" });
    const id = s.ask("app", "Anything");
    for (const issue of ["OPE-20", "OPE-21"]) {
      expect(s.item(issue).state).toBe("owner");
      expect(s.item(issue).why).toBe(`ask #${id}: Anything`);
    }
    s.lane("app", "working");
    expect(s.item("OPE-20").state).toBe("moving");
    // Background work counts as working.
    s.lane("app", "idle", "2 shells still running");
    expect(s.item("OPE-21").state).toBe("moving");
    s.lane("app", "gone");
    expect(s.item("OPE-21").state).toBe("owner");
    s.board.stop();
  });
});

// ---- end to end ----

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-ask-scope-test-"));
let BASE = "";
let server: Awaited<ReturnType<typeof spawnServer>>;

const post = async (path: string, body: unknown) => (await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) })).json();
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const laneOf = async (name: string) => (await state()).lanes.find((l: any) => l.name === name);
const askOf = async (id: number) => (await state()).open.find((a: any) => a.id === id);
const hud = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe("server and hud CLI: a lane with a question and work at once", () => {
  beforeAll(async () => {
    const herdr = join(DATA, "herdr");
    writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"busy","agent_status":"working","pane_id":"p1","agent":"claude"},{"name":"idle","agent_status":"idle","pane_id":"p2","agent":"claude"}]}}' ;;\nesac\nexit 0\n`);
    chmodSync(herdr, 0o755);
    server = await spawnServer({
      cwd: ROOT,
      env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_GH_BIN: join(ROOT, "test", "fake-gh.ts"), FAKE_GH_DATA: join(DATA, "gh.json") },
    });
    BASE = server.base;
    writeFileSync(join(DATA, "gh.json"), "{}");
    for (const name of ["busy", "idle"]) await post("/api/lanes", { name, machine: "local" });
    await post("/api/sync", {});
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });

  test("the live case: a working lane reads moving with asks 1, and neither of its issues waits on the owner", async () => {
    await post("/api/board/track", { issue: "OPE-1934", lane: "busy" });
    await post("/api/board/track", { issue: "OPE-1935", lane: "busy" });
    await post("/api/asks", { lane: "busy", title: "Go live?", body: "Waiting on the reviewer login." });
    const s = await state();
    const busy = s.lanes.find((l: any) => l.name === "busy");
    expect(busy.status).toBe("moving");
    expect(busy.asks).toBe(1);
    for (const issue of ["OPE-1934", "OPE-1935"]) expect(s.board.items.find((i: any) => i.issue === issue).state).toBe("moving");
    // The top bar's count is every open question, a working lane's included.
    expect(s.open.length).toBe(1);
  });

  test("an idle lane with an open ask still reads needs_you; a lane without one reads asks 0", async () => {
    expect((await laneOf("idle")).status).toBe("hq_turn");
    expect((await laneOf("idle")).asks).toBe(0);
    await post("/api/asks", { lane: "idle", title: "Which one?" });
    expect((await laneOf("idle")).status).toBe("needs_you");
    expect((await laneOf("idle")).asks).toBe(1);
  });

  test("hud update --lane moves a question to another lane, and --lane hq or \"\" takes it off every lane", async () => {
    const { id } = await post("/api/asks", { lane: "busy", title: "Move me" });
    const moved = await hud("update", String(id), "--lane", "idle");
    expect(moved.code).toBe(0);
    expect((await askOf(id)).lane).toBe("idle");
    expect((await laneOf("idle")).asks).toBe(2);
    expect((await askOf(id)).title).toBe("Move me");
    await hud("update", String(id), "--lane", "hq");
    expect((await askOf(id)).lane).toBeNull();
    expect((await laneOf("idle")).asks).toBe(1);
    await hud("update", String(id), "--lane", "busy");
    expect((await askOf(id)).lane).toBe("busy");
    await hud("update", String(id), "--lane", "");
    expect((await askOf(id)).lane).toBeNull();
    // A lane that does not exist is refused and changes nothing.
    const typo = await hud("update", String(id), "--lane", "no-such-lane");
    expect(typo.code).not.toBe(0);
    expect(typo.err).toContain("no lane named no-such-lane");
    expect((await askOf(id)).lane).toBeNull();
  });
});
