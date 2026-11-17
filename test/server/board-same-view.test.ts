// The board's view gives what it gave in 0.44.2. Since then it no longer holds every ask against every item one
// pair at a time (docs/footprint.md): this runs the board as 0.44.2 built it (test/fixtures/board-0.44.2.ts, the
// file as it was) and the one in the tree on one database, one clock and one fake gh, and compares every field.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createBoard } from "../../src/server/board.ts";
import { createBoard as createBoardBefore } from "../fixtures/board-0.44.2.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-03-02T12:00:00Z");
// The same numbers on every run.
let seed = 20260302;
const rnd = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const pick = <T>(list: T[]) => list[rnd(list.length)];

// Keys that are the start of other keys, a key shorter than four characters, one with a space, one in another
// project; some with PRs, in every way a PR can be named.
const ISSUES = ["OPE-1", "OPE-12", "OPE-123", "OPE-124", "OPE-2", "OPE-20", "WRK-4000", "WRK-4001", "X-1", "X-10", "AB", "BIG ONE", ...Array.from({ length: 48 }, (_, i) => `OPE-${300 + i * 7}`)];
const LANES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", null];
// What an ask can say: keys in both cases, inside longer words and longer keys, numbers alone, with a #, inside
// words and longer numbers, at the start and the end, and nothing at all.
const SAYS = [
  (k: string, n: number) => `Ship ${k}?`,
  (k: string, n: number) => `about ${k.toLowerCase()} and the rest`,
  (k: string, n: number) => `${k}0 is another one`,
  (k: string, n: number) => `x${k}y`,
  (k: string, n: number) => `see #${n}`,
  (k: string, n: number) => `${n}`,
  (k: string, n: number) => `pr${n} is not it`,
  (k: string, n: number) => `${n}1 is not it either, nor 0${n}`,
  (k: string, n: number) => `(${n}) and [#${n}], then ${n}.`,
  (k: string, n: number) => `a#${n} and ${n}_b and _${n}`,
  (k: string, n: number) => `${k} with #${n}`,
  () => "Nothing named here, just a question about the lane.",
  () => "",
];

function world() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE lanes (name TEXT PRIMARY KEY, herdr TEXT, herdr_since INTEGER, issue TEXT, pr TEXT, bg TEXT, prompt TEXT, parent TEXT, floor TEXT, machine TEXT, pane TEXT);
    CREATE TABLE asks (id INTEGER PRIMARY KEY AUTOINCREMENT, lane TEXT, title TEXT NOT NULL, body TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, answered_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT, who TEXT NOT NULL, text TEXT NOT NULL);
  `);
  const prs: Record<number, any> = {};
  const gh = async (ref: { number: number }) => {
    if (!prs[ref.number]) throw new Error("no such PR");
    return prs[ref.number];
  };
  const boards = [createBoardBefore, createBoard].map((create) => create({ db, now: () => NOW, gh, repo: "owner/repo", firstFloor: () => "one" }));
  for (const [i, name] of LANES.entries()) {
    if (!name) continue;
    db.query("INSERT INTO lanes (name, herdr, herdr_since, bg, prompt, parent, floor, machine, pane) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      name, ["working", "idle", "done", "gone", "idle", "done", "idle", "blocked"][i], NOW - (i % 2 ? 20 : 200) * MIN, i === 5 ? "2 shells still running" : null, i === 7 ? "Allow this?\n1. Yes" : null, i > 3 ? LANES[i - 4] : null, i % 2 ? "one" : "two", "local", `p${i}`,
    );
  }
  for (const [i, issue] of ISSUES.entries()) {
    const numbers = i % 3 === 0 ? [] : i % 3 === 1 ? [40 + i] : [40 + i, 400 + i];
    for (const n of numbers) {
      const at = new Date(NOW - rnd(400) * MIN).toISOString(), k = n % 4;
      prs[n] = { state: k === 0 ? "MERGED" : k === 1 ? "CLOSED" : "OPEN", isDraft: k === 3, statusCheckRollup: k === 2 ? [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "", startedAt: at }] : [], mergedAt: k === 0 ? at : null, closedAt: k === 1 ? at : null, updatedAt: at };
    }
    db.query("INSERT INTO work_items (issue, lane, prs, created_at, done_at, paused_reason, paused_at, reopened_at, floor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      issue, pick(LANES), JSON.stringify(numbers.map((n, j) => (j ? `other/repo#${n}` : String(n)))), NOW - rnd(3000) * MIN,
      i % 9 === 0 ? NOW - rnd(3000) * MIN : null, i % 7 === 0 ? "waits on the vendor" : null, i % 7 === 0 ? NOW - rnd(200) * MIN : null, i % 11 === 0 ? NOW - rnd(100) * MIN : null, i % 2 ? "one" : "two",
    );
  }
  for (let i = 0; i < 700; i++) {
    const issue = pick(ISSUES), n = 40 + rnd(ISSUES.length), created = NOW - rnd(3000) * MIN;
    // Few are open, and none of those on the lanes named last: an open ask on a lane holds all of that lane's work.
    const lane = pick(LANES), status = rnd(40) === 0 && lane !== "eta" && lane !== "zeta" ? "open" : pick(["answered", "answered", "answered", "withdrawn"]);
    db.query("INSERT INTO asks (lane, title, body, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      lane, pick(SAYS)(issue, n), rnd(3) ? pick(SAYS)(pick(ISSUES), 400 + rnd(ISSUES.length)) : null, status, created, status === "answered" ? created + rnd(90) * MIN : null,
    );
  }
  // Events at times that repeat, on lanes and off them, some of them the board's own.
  for (let i = 0; i < 400; i++) db.query("INSERT INTO events (at, lane, who, text) VALUES (?, ?, ?, ?)").run(NOW - rnd(120) * MIN, pick(LANES), pick(["hq", "herdr", "board", "hud"]), `event ${i}`);
  return { db, boards };
}

test("the board's view is what 0.44.2 gave, field by field", async () => {
  const { boards: [before, after] } = world();
  await before.refresh(0);
  await after.refresh(0);
  before.stop();
  after.stop();
  for (const scope of [{}, { floor: "one" }, { floor: "two" }, { floor: "nobody" }]) {
    const was = before.view(scope), is = after.view(scope);
    expect(is).toEqual(was);
    expect(JSON.stringify(is)).toBe(JSON.stringify(was));
  }
  // The world is rich enough to mean something: every state is there, and asks hold items.
  const all = after.view();
  expect(all.items.length).toBeGreaterThan(40);
  expect(Object.entries(all.counts).filter(([, n]) => n > 0).map(([s]) => s).sort()).toEqual(["blocked", "ci", "done", "moving", "owner", "paused", "stalled"]);
  expect(all.items.filter((i) => i.openAsks.length).length).toBeGreaterThan(5);
});
