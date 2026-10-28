// The ask ledger: HQ edits an open question in place, comments under it, and gives it a checklist that ticks
// itself as PRs merge. Two layers:
//   1. board.ts's follow/onFacts hooks on an in-memory database with a fake gh.
//   2. server.ts and hud.ts end to end on a spare port, with a throwaway data dir, a fake herdr that logs what it is
//      asked (so a prompt into HQ's session would show) and the fake gh binary.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { createBoard } from "../../src/server/board.ts";

const pr = (over: Record<string, any> = {}) => ({ state: "OPEN", isDraft: false, statusCheckRollup: [], mergedAt: null, closedAt: null, updatedAt: null, ...over });

describe("board.ts: PRs another feature follows", () => {
  function setup(prs: Record<number, any>) {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE lanes (name TEXT PRIMARY KEY, herdr TEXT, herdr_since INTEGER, issue TEXT, pr TEXT);
      CREATE TABLE asks (id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, answered_at INTEGER, recipient TEXT NOT NULL DEFAULT 'owner');
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT, who TEXT NOT NULL, text TEXT NOT NULL);
    `);
    const clock = { t: Date.parse("2026-01-05T09:00:00Z") };
    const calls: number[] = [];
    const board = createBoard({ db, now: () => clock.t, gh: async (ref) => (calls.push(ref.number), prs[ref.number]) });
    return { board, calls, clock, prs };
  }

  test("a followed PR rides on the refresh, its merge is heard, and nothing followed fetches nothing", async () => {
    const s = setup({ 77: pr() });
    let keys: string[] = [];
    let heard = 0;
    s.board.follow(() => keys);
    s.board.onFacts(() => heard++);
    // e) Nothing followed, nothing tracked: no gh call at all.
    await s.board.refresh(0);
    expect(s.calls).toEqual([]);
    keys = ["77"];
    await s.board.refresh(0);
    expect(s.calls).toEqual([77]);
    expect(s.board.fact("77")?.state).toBe("OPEN");
    expect(heard).toBe(1);
    // Inside the cache window: no second fetch.
    await s.board.refresh();
    expect(s.calls).toEqual([77]);
    s.prs[77] = pr({ state: "MERGED" });
    s.clock.t += 61_000;
    await s.board.refresh();
    expect(s.board.fact("77")?.state).toBe("MERGED");
    expect(heard).toBe(2);
    // Merged never changes again: never fetched again.
    s.clock.t += 3600_000;
    await s.board.refresh(0);
    expect(s.calls).toEqual([77, 77]);
    keys = [];
    await s.board.refresh(0);
    expect(s.calls).toEqual([77, 77]);
    s.board.stop();
  });
});

// ---- end to end ----

const ROOT = join(import.meta.dir, "..", "..");
let BASE = "";
const DATA = mkdtempSync(join(tmpdir(), "hq-ledger-test-"));
const GH_DATA = join(DATA, "gh.json");
const HERDR_LOG = join(DATA, "herdr.log");
let server: Awaited<ReturnType<typeof spawnServer>>;

const hud = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`hud ${args.join(" ")}: ${err}`);
  return out;
};
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const inbox = async () => (await fetch(`${BASE}/api/inbox`)).json();
const askId = (out: string) => Number(out.match(/ask #(\d+)/)![1]);
const ghCalls = () => (existsSync(`${GH_DATA}.calls`) ? readFileSync(`${GH_DATA}.calls`, "utf8").trim().split("\n").filter(Boolean) : []);
const prompts = () => (existsSync(HERDR_LOG) ? readFileSync(HERDR_LOG, "utf8").split("\n").filter((l) => l.startsWith("agent prompt")) : []);
const setGh = (prs: Record<number, any>) => writeFileSync(GH_DATA, JSON.stringify(prs));
const HERDR = join(DATA, "herdr");

async function start() {
  server = await spawnServer({
    cwd: ROOT,
    env: {
      ...process.env,
      HUD_HOST: "127.0.0.1",
      HUD_DATA_DIR: DATA,
      HERDR_BIN: HERDR,
      HUD_MACHINES: "local",
      HUD_LOCAL_MACHINE: "local",
      HUD_HQ_AGENT: "hq",
      HUD_GH_BIN: join(ROOT, "test", "fake-gh.ts"),
      HUD_GITHUB_REPO: "example/repo",
      FAKE_GH_DATA: GH_DATA,
    },
  });
  BASE = server.base;
}
async function restart() {
  await server.stop();
  await start();
}

describe("server and hud CLI: the ask ledger", () => {
  beforeAll(async () => {
    setGh({ 1234: pr(), 1235: pr() });
    writeFileSync(HERDR, `#!/bin/sh\necho "$*" >> "${HERDR_LOG}"\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[]}}' ;;\nesac\nexit 0\n`);
    chmodSync(HERDR, 0o755);
    await start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });

  test("a) update changes only the fields given, keeps the timer, and the state shows the edit", async () => {
    const id = askId(await hud("ask", "--lane", "one", "--title", "Which way?", "--body", "Two roads.", "--opt", "Left", "--opt", "Middle", "--opt", "Right", "--rec", "Middle", "--link", "https://example.com/a"));
    const before = (await state()).open.find((a: any) => a.id === id);
    expect((await state()).ledger[id]).toBeUndefined();
    await hud("update", String(id), "--title", "Which way now?", "--opt", "Left", "--opt", "Right");
    const s = await state();
    const after = s.open.find((a: any) => a.id === id);
    expect(after.title).toBe("Which way now?");
    expect(after.options).toEqual(["Left", "Right"]);
    expect(after.body).toBe("Two roads.");
    expect(after.recommended).toBe("Middle");
    expect(after.link).toBe("https://example.com/a");
    expect(after.created_at).toBe(before.created_at);
    expect(after.status).toBe("open");
    expect(typeof s.ledger[id].editedAt).toBe("number");
    await hud("update", String(id), "--body", "One road.", "--rec", "Left");
    const again = (await state()).open.find((a: any) => a.id === id);
    expect([again.title, again.body, again.recommended]).toEqual(["Which way now?", "One road.", "Left"]);
    // Nothing given, or a question that is not open: refused.
    await expect(hud("update", String(id))).rejects.toThrow(/nothing to change/);
    await hud("withdraw", String(id));
    await expect(hud("update", String(id), "--title", "x")).rejects.toThrow(/already withdrawn/);
  });

  test("b) a comment shows under its question and never reaches the inbox, the score or the timer", async () => {
    const id = askId(await hud("ask", "--lane", "two", "--title", "Merge order?"));
    const box = await inbox();
    const s0 = await state();
    await hud("comment", String(id), "#1234", "is", "rebased");
    await hud("comment", String(id), "CI is green");
    const s = await state();
    expect(s.ledger[id].comments.map((c: any) => c.text)).toEqual(["#1234 is rebased", "CI is green"]);
    expect(s.ledger[id].comments[0].at).toBeLessThanOrEqual(s.ledger[id].comments[1].at);
    expect(s.ledger[id].editedAt).toBeNull();
    expect(await inbox()).toEqual(box);
    expect(s.open.find((a: any) => a.id === id).created_at).toBe(s0.open.find((a: any) => a.id === id).created_at);
    expect(s.score.lost).toBe(s0.score.lost);
    expect(s.score.burnPerMin).toBe(s0.score.burnPerMin);
    await hud("withdraw", String(id));
  });

  test("c) items tick by hand, untick and grow; the last tick by hand closes the question, acked", async () => {
    const id = askId(await hud("ask", "--lane", "three", "--kind", "action", "--title", "Release steps", "--item", "Write the notes", "--item", "Tag the release"));
    const items = async () => (await state()).ledger[id]?.items;
    expect((await items()).map((i: any) => [i.n, i.text, i.done])).toEqual([[1, "Write the notes", false], [2, "Tag the release", false]]);
    await hud("item", String(id), "1", "done");
    expect((await items())[0]).toMatchObject({ done: true, by: "hq" });
    await hud("item", String(id), "1", "undo");
    expect((await items())[0].done).toBe(false);
    expect((await hud("item", String(id), "add", "Tell", "the", "team")).trim()).toBe("item 3");
    expect((await items()).length).toBe(3);
    await expect(hud("item", String(id), "9", "done")).rejects.toThrow(/no item 9/);
    for (const n of ["1", "2"]) await hud("item", String(id), n, "done");
    expect((await state()).open.some((a: any) => a.id === id)).toBe(true);
    await hud("item", String(id), "3", "done");
    const s = await state();
    expect(s.open.some((a: any) => a.id === id)).toBe(false);
    const closed = s.answered.find((a: any) => a.id === id);
    expect(closed.status).toBe("answered");
    expect(closed.answer).toBe("all done");
    expect(closed.acked_at).not.toBeNull();
    expect(s.events.some((e: any) => e.text.includes('closed "Release steps"'))).toBe(true);
    expect((await inbox()).answers.some((a: any) => a.id === id)).toBe(false);
    // A closed question takes no more ticks.
    await expect(hud("item", String(id), "3", "undo")).rejects.toThrow(/already answered/);
  });

  test("e) with no open question naming PRs, the board makes no gh call", async () => {
    // Questions with items but no PR, and no tracked work: a board refresh fetches nothing.
    await hud("ask", "--title", "No PRs here", "--item", "Just a step");
    await hud("board", "--json");
    expect(ghCalls()).toEqual([]);
  });

  test("d) an item naming a PR ticks itself on merge; the close is not acked, waits in the inbox, and is never typed into HQ", async () => {
    setGh({ 1234: pr({ state: "MERGED" }), 1235: pr() });
    const id = askId(await hud("ask", "--lane", "four", "--title", "Land the pair", "--item", "Write the notes", "--item", "Land #1234", "--item", "Land https://github.com/other/thing/pull/1235"));
    const items = async () => (await state()).ledger[id]?.items;
    expect((await items()).map((i: any) => i.pr)).toEqual([null, { number: 1234, repo: "example/repo" }, { number: 1235, repo: "other/thing" }]);
    // Created without a fetch: the board picks the PRs up on its next refresh (here, HQ's hud board).
    expect(ghCalls()).toEqual([]);
    await hud("item", String(id), "1", "done");
    await hud("board", "--json");
    expect(ghCalls().sort()).toEqual(["1234", "1235"]);
    expect((await items()).map((i: any) => [i.done, i.by])).toEqual([[true, "hq"], [true, "github"], [false, null]]);
    expect((await state()).open.some((a: any) => a.id === id)).toBe(true);
    // 1235 merges. The cache holds facts for a minute, so the next refresh here is the one a restart runs.
    setGh({ 1234: pr({ state: "MERGED" }), 1235: pr({ state: "MERGED" }) });
    await restart();
    for (const end = Date.now() + 8000; Date.now() < end && (await state()).open.some((a: any) => a.id === id); ) await Bun.sleep(100);
    const s = await state();
    const closed = s.answered.find((a: any) => a.id === id);
    expect(closed).toMatchObject({ status: "answered", answer: "all done", acked_at: null });
    expect(s.events.some((e: any) => e.who === "board" && e.text.includes('closed "Land the pair"'))).toBe(true);
    // 1234 merged long ago: never fetched again.
    expect(ghCalls().filter((c) => c === "1234").length).toBe(1);
    expect((await inbox()).answers.map((a: any) => a.id)).toContain(id);
    expect(prompts()).toEqual([]);
    // An answer from the owner still reaches HQ at once, as before.
    const q = askId(await hud("ask", "--title", "Go?"));
    await fetch(`${BASE}/api/asks/${q}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ answer: "yes" }) });
    for (const end = Date.now() + 4000; Date.now() < end && !prompts().length; ) await Bun.sleep(50);
    expect(prompts().length).toBe(1);
    expect(prompts()[0]).toContain(`HUD answer #${q}`);
  });

  test("e) after the PR question closed, a board refresh makes no gh call", async () => {
    const n = ghCalls().length;
    await hud("board", "--json");
    expect(ghCalls().length).toBe(n);
  });
});
