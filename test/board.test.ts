// The work board derives each item's state from facts. Two layers:
//   1. board.ts on an in-memory database, with a fake gh and a fake clock.
//   2. server.ts and hud.ts end to end, on a spare port with a throwaway data dir and a fake gh binary.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../scripts/room-hash.ts";
import { boardText, createBoard, GH_REFRESH_MS, STALL_MS } from "../src/server/board.ts";

const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();
const check = (status: string, conclusion = "", startedAt = "") => ({ __typename: "CheckRun", name: "ci", status, conclusion, startedAt });
const pr = (over: Record<string, any> = {}) => ({ state: "OPEN", isDraft: false, statusCheckRollup: [], mergedAt: null, closedAt: null, updatedAt: null, ...over });

// The tables board.ts reads from the server's database: lanes, asks and events.
function memoryDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lanes (name TEXT PRIMARY KEY, herdr TEXT, herdr_since INTEGER, issue TEXT, pr TEXT);
    CREATE TABLE asks (id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, answered_at INTEGER, recipient TEXT NOT NULL DEFAULT 'owner');
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT, who TEXT NOT NULL, text TEXT NOT NULL);
  `);
  return db;
}

function setup(prs: Record<number, any>) {
  const db = memoryDb();
  const clock = { t: Date.parse("2026-01-05T09:00:00Z") };
  const calls: number[] = [];
  const board = createBoard({
    db,
    now: () => clock.t,
    gh: async (ref) => {
      calls.push(ref.number);
      if (!prs[ref.number]) throw new Error("no such PR");
      return prs[ref.number];
    },
  });
  const item = (issue: string) => board.view().items.find((i) => i.issue === issue)!;
  return { db, clock, calls, board, item, prs };
}

describe("board.ts with a fake gh and a fake clock", () => {
  test("a) an item whose PR merged shows done", async () => {
    const s = setup({ 11: pr({ state: "MERGED", mergedAt: iso(Date.parse("2026-01-05T08:30:00Z")) }) });
    s.board.track({ issue: "OPE-1", lane: "alpha", prs: ["11"] });
    await s.board.refresh(0);
    expect(s.item("OPE-1").state).toBe("done");
    s.board.stop();
  });

  test("b) an item with an open ask naming it shows waiting on the owner", async () => {
    const s = setup({ 21: pr({ updatedAt: iso(Date.parse("2026-01-05T06:00:00Z")) }), 22: pr() });
    s.board.track({ issue: "OPE-2", lane: "beta", prs: ["21"] });
    s.board.track({ issue: "OPE-3", lane: "gamma", prs: ["22"] });
    await s.board.refresh(0);
    // By issue key in the title, from another lane.
    s.db.query("INSERT INTO asks (lane, title, created_at) VALUES (?, ?, ?)").run("other", "Ship OPE-2 today?", s.clock.t - 90 * MIN);
    // By PR number in the body.
    s.db.query("INSERT INTO asks (lane, title, body, created_at) VALUES (?, ?, ?, ?)").run(null, "Which way?", "see #22", s.clock.t - 90 * MIN);
    expect(s.item("OPE-2").state).toBe("owner");
    expect(s.item("OPE-3").state).toBe("owner");
    // By lane.
    s.board.track({ issue: "OPE-4", lane: "delta" });
    s.db.query("INSERT INTO asks (lane, title, created_at) VALUES (?, ?, ?)").run("delta", "Anything", s.clock.t - 90 * MIN);
    expect(s.item("OPE-4").state).toBe("owner");
    // An answered ask no longer holds it.
    s.db.query("UPDATE asks SET status = 'answered', answered_at = ?").run(s.clock.t - 80 * MIN);
    expect(s.item("OPE-2").state).toBe("stalled");
    s.board.stop();
  });

  test("c) an item with a running check shows waiting on CI", async () => {
    const old = iso(Date.parse("2026-01-05T06:00:00Z"));
    const s = setup({ 31: pr({ updatedAt: old, statusCheckRollup: [check("COMPLETED", "SUCCESS", old), check("IN_PROGRESS", "", old)] }) });
    s.board.track({ issue: "OPE-5", lane: "eps", prs: ["#31"] });
    await s.board.refresh(0);
    expect(s.item("OPE-5").state).toBe("ci");
    expect(s.item("OPE-5").prs[0].ci).toBe("running");
    s.board.stop();
  });

  test("c2) a cancelled run superseded at the same head does not make CI red; a failed CI gate does", async () => {
    const run = (name: string, conclusion: string, at: string) => ({ __typename: "CheckRun", name, workflowName: "PR checks", status: "COMPLETED", conclusion, startedAt: at });
    const old = "2026-01-05T06:00:00Z";
    const good = [run("Static", "CANCELLED", "2026-01-05T06:01:00Z"), run("Static", "SUCCESS", "2026-01-05T06:05:00Z"), run("CI gate", "SUCCESS", "2026-01-05T06:09:00Z")];
    const bad = [run("Static", "SUCCESS", "2026-01-05T06:05:00Z"), run("CI gate", "FAILURE", "2026-01-05T06:09:00Z")];
    const noGate = [run("Static", "FAILURE", "2026-01-05T06:01:00Z"), run("Static", "SUCCESS", "2026-01-05T06:05:00Z")];
    const s = setup({ 51: pr({ updatedAt: old, statusCheckRollup: good }), 52: pr({ updatedAt: old, statusCheckRollup: bad }), 53: pr({ updatedAt: old, statusCheckRollup: noGate }) });
    s.board.track({ issue: "OPE-8", lane: "g", prs: ["51", "52", "53"] });
    await s.board.refresh(0);
    expect(s.item("OPE-8").prs.map((p: any) => p.ci)).toEqual(["passed", "failed", "passed"]);
    s.board.stop();
  });

  test("d) no movement and no reason past the threshold shows stalled, first in hud board", async () => {
    const s = setup({ 41: pr({ isDraft: true }), 42: pr({ statusCheckRollup: [check("QUEUED")] }) });
    s.board.track({ issue: "OPE-6", lane: "zeta", prs: ["41"] });
    s.board.track({ issue: "OPE-7", lane: "eta", prs: ["42"] });
    // The PR and the lane move now: moving.
    s.prs[41].updatedAt = iso(s.clock.t);
    s.db.query("INSERT INTO lanes (name, herdr, herdr_since) VALUES ('zeta', 'idle', ?)").run(s.clock.t);
    await s.board.refresh(0);
    expect(s.item("OPE-6").state).toBe("moving");
    // Just under the threshold: still moving.
    s.clock.t += STALL_MS - MIN;
    expect(s.item("OPE-6").state).toBe("moving");
    // Past it, with nothing new: stalled, with what last happened and its age.
    s.clock.t += 2 * MIN;
    const it = s.item("OPE-6");
    expect(it.state).toBe("stalled");
    expect(it.last!.age).toBeGreaterThanOrEqual(STALL_MS);
    expect(it.prs[0].draft).toBe(true);
    // The board lists it first, and so does the text HQ reads.
    const v = s.board.view();
    expect(v.items[0].issue).toBe("OPE-6");
    expect(v.counts.stalled).toBe(1);
    const lines = boardText(v).split("\n");
    expect(lines[0]).toContain("1 stalled");
    expect(lines[2]).toStartWith("STALLED");
    expect(lines[3]).toContain("OPE-6");
    expect(lines[3]).toContain("lane zeta");
    expect(lines[3]).toContain("#41 draft");
    expect(lines[3]).toMatch(/last: .*ago/);
    expect(boardText(v).indexOf("OPE-6")).toBeLessThan(boardText(v).indexOf("OPE-7"));
    // A lane that just went away is what last happened, but it is not movement.
    s.db.query("UPDATE lanes SET herdr = 'gone', herdr_since = ? WHERE name = 'zeta'").run(s.clock.t);
    expect(s.item("OPE-6").state).toBe("stalled");
    expect(s.item("OPE-6").last!.what).toBe("lane went gone");
    // A working lane is moving, whatever the clock says.
    s.db.query("UPDATE lanes SET herdr = 'working', herdr_since = ? WHERE name = 'zeta'").run(s.clock.t - 3 * STALL_MS);
    expect(s.item("OPE-6").state).toBe("moving");
    s.board.stop();
  });

  test("e) paused with a reason shows paused, not stalled", async () => {
    const s = setup({ 51: pr({ updatedAt: iso(Date.parse("2026-01-01T00:00:00Z")) }) });
    s.board.track({ issue: "OPE-8", lane: "theta", prs: ["51"] });
    await s.board.refresh(0);
    expect(s.item("OPE-8").state).toBe("stalled");
    expect(() => s.board.pause({ issue: "OPE-8" })).toThrow();
    s.board.pause({ issue: "ope-8", reason: "waiting for the vendor" });
    expect(s.item("OPE-8").state).toBe("paused");
    expect(s.item("OPE-8").why).toBe("waiting for the vendor");
    s.board.resume({ issue: "OPE-8" });
    expect(s.item("OPE-8").state).toBe("stalled");
    s.board.stop();
  });

  test("hud done closes an item; the GitHub cache and poll only run while something is open", async () => {
    const s = setup({ 61: pr() });
    s.board.track({ issue: "OPE-9", lane: "iota", prs: ["61"] });
    await s.board.refresh(0);
    const n = s.calls.length;
    // Inside the cache window nothing is fetched again.
    await s.board.refresh();
    expect(s.calls.length).toBe(n);
    s.board.done({ issue: "OPE-9" });
    expect(s.item("OPE-9").state).toBe("done");
    // Nothing open: refresh fetches nothing, even with an expired cache.
    s.clock.t += GH_REFRESH_MS * 2;
    await s.board.refresh(0);
    expect(s.calls.length).toBe(n);
    s.board.stop();
  });

  test("a lane's issue and PRs become an item owned by that lane", async () => {
    const s = setup({ 71: pr(), 72: pr() });
    s.db.query("INSERT INTO lanes (name, issue) VALUES ('kappa', 'OPE-10')").run();
    s.board.linkLane({ name: "kappa", issue: "OPE-10", pr: "71,72" });
    const it = s.item("OPE-10");
    expect(it.lane).toBe("kappa");
    expect(it.prs.map((p) => p.number)).toEqual([71, 72]);
    s.board.stop();
  });
});

// ---- end to end: server.ts + hud.ts, fake gh ----

const ROOT = join(import.meta.dir, "..");
let BASE = "";
const DATA = mkdtempSync(join(tmpdir(), "hq-board-test-"));
const GH_DATA = join(DATA, "gh.json");
let server: Awaited<ReturnType<typeof spawnServer>>;

const hud = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`hud ${args.join(" ")}: ${err}`);
  return out;
};

describe("server and hud CLI, with a fake gh binary", () => {
  beforeAll(async () => {
    const long = iso(Date.now() - 3 * 3600_000);
    writeFileSync(
      GH_DATA,
      JSON.stringify({
        101: pr({ state: "MERGED", mergedAt: long, updatedAt: long }),
        102: pr({ updatedAt: long }),
        103: pr({ updatedAt: long, statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING", startedAt: long }] }),
        104: pr({ updatedAt: long, isDraft: true }),
        105: pr({ updatedAt: long }),
      }),
    );
    server = await spawnServer({
      cwd: ROOT,
      env: {
        ...process.env,
        HUD_HOST: "127.0.0.1",
        HUD_DATA_DIR: DATA,
        HERDR_BIN: join(DATA, "no-such-herdr"),
        HUD_GH_BIN: join(ROOT, "test", "fake-gh.ts"),
        HUD_GITHUB_REPO: "example/repo",
        FAKE_GH_DATA: GH_DATA,
      },
    });
    BASE = server.base;
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });

  test("track, ask, pause, done, and board text and json", async () => {
    await hud("track", "OPE-101", "--lane", "one", "--pr", "101");
    await hud("track", "OPE-102", "--lane", "two", "--pr", "102");
    await hud("track", "OPE-103", "--lane", "three", "--pr", "103");
    await hud("lane", "four", "--issue", "OPE-104", "--pr", "104");
    await hud("track", "OPE-105", "--lane", "five", "--pr", "105");
    await hud("ask", "--lane", "elsewhere", "--title", "Is OPE-102 the right fix?");
    await hud("pause", "OPE-105", "blocked", "on", "a", "vendor");

    const v = JSON.parse(await hud("board", "--json"));
    const st = Object.fromEntries(v.items.map((i: any) => [i.issue, i.state]));
    expect(st).toEqual({ "OPE-101": "done", "OPE-102": "owner", "OPE-103": "ci", "OPE-104": "stalled", "OPE-105": "paused" });
    expect(v.items[0].issue).toBe("OPE-104");
    expect(v.items.find((i: any) => i.issue === "OPE-104").lane).toBe("four");

    const text = await hud("board");
    const lines = text.split("\n");
    expect(lines[0]).toContain("1 stalled");
    expect(lines[2]).toStartWith("STALLED");
    expect(lines[3]).toContain("OPE-104");
    expect(lines[3]).toContain("#104 draft");
    expect(lines[3]).toContain("last: #104 updated (3h 0m ago)");
    expect(text).toContain("blocked on a vendor");

    // The page gets the board inside the state it already loads; no extra fetch.
    const state = await (await fetch(`${BASE}/api/state`)).json();
    expect(state.board.counts.stalled).toBe(1);

    await hud("done", "OPE-104");
    const after = JSON.parse(await hud("board", "--json"));
    expect(after.items.find((i: any) => i.issue === "OPE-104").state).toBe("done");

    // Each PR was fetched once: tracking fetches it, and board reuses the minute-long cache.
    const calls = readFileSync(`${GH_DATA}.calls`, "utf8").trim().split("\n");
    expect(calls.filter((c) => c === "102").length).toBe(1);
  });
});

describe("tracking an item again", () => {
  test("reopens it as moving when its only PR closed, and a new PR then decides done", async () => {
    const closed = Date.parse("2026-01-05T08:00:00Z");
    const s = setup({ 51: pr({ state: "CLOSED", closedAt: iso(closed), updatedAt: iso(closed) }) });
    s.board.track({ issue: "OPE-51", lane: "omega", prs: ["51"] });
    await s.board.refresh(0);
    expect(s.item("OPE-51").state).toBe("done");

    s.clock.t += 5 * MIN;
    s.board.track({ issue: "OPE-51" }); // no PR: a new one is coming
    await s.board.refresh(0);
    expect(s.item("OPE-51").state).toBe("moving");
    expect(s.item("OPE-51").last?.what).toBe("tracked again");

    s.prs[52] = pr({ state: "OPEN", updatedAt: iso(s.clock.t) });
    s.board.track({ issue: "OPE-51", prs: ["52"] });
    await s.board.refresh(0);
    expect(s.item("OPE-51").state).not.toBe("done");

    s.clock.t += MIN;
    s.prs[52] = pr({ state: "MERGED", mergedAt: iso(s.clock.t), updatedAt: iso(s.clock.t) });
    await s.board.refresh(0);
    expect(s.item("OPE-51").state).toBe("done");
  });
});
