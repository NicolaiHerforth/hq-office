// REQUESTS: what the owner asked for, tracked until delivered. Two layers, as the board's tests:
//   1. requests.ts on an in-memory database with a clock the test moves: every status move and every refusal, the
//      acknowledgement filter, attach, the 24 h and 7 d close, the sweep's lines, the import.
//   2. server.ts and hud.ts end to end, on a spare port with a throwaway data dir and a stub herdr: a note files a
//      request and HQ's line ends with it, the owner's routes, hud work, an answer frees a waiting request.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { createRequests, isAcknowledgement, KEEP_MS, SEEN_CLOSE_MS, sortHint } from "../../src/server/requests.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCHEMA = join(ROOT, "src", "server", "schema");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const HQ = { by: "hq", floor: "main" };

// The request tables as the server makes them, and the three it reads: asks, notes and floors.
function setup() {
  const db = new Database(":memory:");
  for (const f of ["requests.sql", "request_moves.sql"]) db.exec(readFileSync(join(SCHEMA, f), "utf8"));
  db.exec(`
    CREATE TABLE asks (id INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', floor TEXT, answer TEXT, created_at INTEGER NOT NULL DEFAULT 0, answered_at INTEGER);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, text TEXT NOT NULL, floor TEXT);
    CREATE TABLE floors (id TEXT PRIMARY KEY);
    INSERT INTO floors (id) VALUES ('main'), ('other');
  `);
  const clock = { t: Date.parse("2026-03-10T09:00:00Z") };
  const requests = createRequests({ db, now: () => clock.t, firstFloor: () => "main" });
  let notes = 0;
  const note = (text: string, floor = "main") => requests.fileNote({ floor, text, note: ++notes });
  const ask = (id: number, floor = "main") => db.query("INSERT INTO asks (id, floor) VALUES (?, ?)").run(id, floor);
  const settle = (id: number, status: string, answer: string | null = null) => db.query("UPDATE asks SET status = ?, answer = ? WHERE id = ?").run(status, answer, id);
  const status = (id: number) => requests.show(id).request.status;
  const kinds = (id: number) => requests.show(id).moves.map((m) => m.kind);
  const open = () => requests.view().map((r) => r.id);
  return { db, clock, requests, note, ask, settle, status, kinds, open };
}

describe("a note becomes a request", () => {
  test("a note files a new request with his words, its note as the ref, and a hint for HQ", () => {
    const s = setup();
    const r = s.note("get the deploys to run before hours");
    expect(r).toMatchObject({ id: 1, floor: "main", status: "new", words: "get the deploys to run before hours", source: "note", ref: "note:1", lane: null, moved: null });
    expect(sortHint(r)).toBe(" (request #1: sort it with hud work assign 1 LANE | attach 1 OTHER | drop 1 WHY)");
    expect(s.requests.view()).toHaveLength(1);
  });

  test("an acknowledgement is filed closed: it exists but makes no row, and HQ gets no hint", () => {
    const s = setup();
    const acks = ["ok", "OK!", "Okay.", "thanks", "Thank you!!", "ty", "nice", "Great", "perfect 👍", "cool", "👍", "✅", "👍🏽", "got it", "Sounds good.", "yes", "No", "  thanks 🙏  "];
    for (const text of acks) {
      expect([text, isAcknowledgement(text)]).toEqual([text, true]);
      const r = s.note(text);
      expect(r).toMatchObject({ status: "closed", closed_why: "acknowledgement", words: text.trim() === text ? text : r.words });
      expect(sortHint(r)).toBe("");
    }
    expect(s.requests.view()).toEqual([]);
    expect(s.requests.list({ floor: "main", closed: true })).toHaveLength(acks.length);
  });

  test("anything more than an acknowledgement is a request", () => {
    const s = setup();
    const asks = ["ok do it now", "yes, and also fix the login", "thanks, now ship it", "no, the other one", "re: #12 ok", "okay but why is it red", "great job on that but the header is off", "!!!", "🔥", "ok ok", "ok then, do the long one today please", "ok?", "yes?", "no?", "thanks?"];
    for (const text of asks) {
      expect([text, isAcknowledgement(text)]).toEqual([text, false]);
      expect(s.note(text).status).toBe("new");
    }
    expect(s.requests.view()).toHaveLength(asks.length);
  });

  test("a reply to an update is filed new like any other note: HQ sorts it", () => {
    const s = setup();
    expect(s.note("re: #4 (the deploy summary) do the second option").status).toBe("new");
  });
});

describe("every status move", () => {
  test("new -> assigned -> waiting -> assigned -> delivered, each one a line in the history", () => {
    const s = setup();
    s.note("make the admin panel fast");
    expect(s.requests.assign(1, { lane: "admin-perf", issue: "ABC-7", pr: "#12" }, HQ).line).toBe("request #1 assigned to admin-perf, ABC-7, PR #12 (was new)");
    expect(s.requests.show(1).request).toMatchObject({ status: "assigned", lane: "admin-perf", issue: "ABC-7", pr: "12", moved: "assigned to admin-perf, ABC-7, PR #12" });
    s.ask(40);
    expect(s.requests.wait(1, 40, HQ).line).toBe("request #1 waits on the owner: ask #40 (was assigned)");
    expect(s.requests.show(1).request).toMatchObject({ status: "waiting", ask: 40, lane: "admin-perf" });
    s.requests.assign(1, { lane: "admin-perf" }, HQ);
    expect(s.requests.show(1).request).toMatchObject({ status: "assigned", ask: null, issue: "ABC-7", pr: "12" });
    s.clock.t += HOUR;
    expect(s.requests.move(1, "PR #12 in review", HQ).line).toBe("request #1 moved: PR #12 in review");
    expect(s.requests.show(1).request).toMatchObject({ status: "assigned", moved: "PR #12 in review", movedAt: s.clock.t });
    expect(s.requests.deliver(1, "https://example.test/pr/12", "merged and live", HQ).line).toContain("request #1 delivered: merged and live (https://example.test/pr/12)");
    expect(s.requests.show(1).request).toMatchObject({ status: "delivered", link: "https://example.test/pr/12", line: "merged and live", seenAt: null });
    expect(s.kinds(1)).toEqual(["assigned", "waiting", "assigned", "moved", "delivered"]);
    expect(s.requests.show(1).moves.every((m) => m.by === "hq")).toBe(true);
  });

  test("assign takes hq as the lane, and works from open and from waiting", () => {
    const s = setup();
    const { request } = s.requests.add({ floor: "main", text: "never drop a ball" });
    expect(request).toMatchObject({ status: "open", source: "hand", ref: null });
    expect(s.requests.assign(request.id, { lane: "hq" }, HQ).request).toMatchObject({ status: "assigned", lane: "hq" });
    s.ask(41);
    s.requests.wait(request.id, 41, HQ);
    expect(s.requests.assign(request.id, { lane: "tooling" }, HQ).request).toMatchObject({ status: "assigned", lane: "tooling", ask: null });
  });

  test("a new request can be delivered, withdrawn, moved or made to wait without an owner", () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.note(`request ${i}`);
    s.ask(50);
    expect(s.requests.deliver(1, "#brief/3", "answered in the brief", HQ).request.status).toBe("delivered");
    expect(s.requests.withdraw(2, "superseded by #1", HQ).request).toMatchObject({ status: "withdrawn", line: "superseded by #1", link: null });
    expect(s.requests.move(3, "reading it", HQ).request.status).toBe("new");
    expect(s.requests.wait(4, 50, HQ).request).toMatchObject({ status: "waiting", ask: 50, lane: null });
  });

  test("drop closes a new request with its reason; it leaves every list and stays in the table", () => {
    const s = setup();
    s.note("haha that was close");
    expect(s.requests.drop(1, "chatter, nothing to do", HQ).line).toBe("request #1 dropped as not work: chatter, nothing to do");
    expect(s.open()).toEqual([]);
    expect(s.requests.show(1).request).toMatchObject({ status: "closed", closedWhy: "dropped: chatter, nothing to do", closedAt: s.clock.t });
    expect(s.requests.list({ floor: "main", closed: true }).map((r) => r.id)).toEqual([1]);
  });

  test("attach: a repeat closes, and its words become a line on the request it repeats, at the time he sent them", () => {
    const s = setup();
    s.note("get the deploys to run before hours");
    s.requests.assign(1, { lane: "deploy-window" }, HQ);
    const assignedAt = s.clock.t;
    s.clock.t += 2 * DAY;
    s.note("deploys still not before hours??");
    const saidAt = s.clock.t;
    s.clock.t += HOUR;
    expect(s.requests.attach(2, 1, HQ).line).toBe("request #2 closed as a repeat: its words are attached to #1");
    expect(s.requests.show(2).request).toMatchObject({ status: "closed", closedWhy: "attached to #1" });
    const last = s.requests.show(1).moves.at(-1)!;
    expect(last).toMatchObject({ kind: "attached", by: "owner", at: saidAt, text: "deploys still not before hours?? (request #2, note:2)" });
    // The owner asking again is not progress: the request it repeats has not moved.
    expect(s.requests.show(1).request).toMatchObject({ status: "assigned", movedAt: assignedAt, moved: "assigned to deploy-window" });
    expect(s.open()).toEqual([1]);
  });

  test("the owner reopens a delivered request: back to its lane with his words, and to no owner when it had none", () => {
    const s = setup();
    s.note("first");
    s.note("second");
    s.requests.assign(1, { lane: "alpha" }, HQ);
    s.requests.deliver(1, "L1", "done", HQ);
    s.requests.seen([1]);
    s.requests.withdraw(2, "not doing it", HQ);
    expect(s.requests.reopen(1, "still broken on the phone")).toMatchObject({ status: "assigned", lane: "alpha", link: null, line: null, seenAt: null, moved: "reopened: still broken on the phone" });
    expect(s.requests.reopen(2, "no, I do want it")).toMatchObject({ status: "open", lane: null });
    expect(s.requests.show(1).moves.at(-1)).toMatchObject({ kind: "reopened", by: "owner", text: "reopened: still broken on the phone" });
  });

  test("the owner closes any request that is not closed, with or without a reason", () => {
    const s = setup();
    s.note("one");
    s.note("two");
    s.requests.assign(2, { lane: "alpha" }, HQ);
    expect(s.requests.close(1, "")).toMatchObject({ status: "closed" });
    expect(s.requests.show(1).request.closedWhy).toBe("closed by the owner");
    s.requests.close(2, "changed my mind");
    expect(s.requests.show(2).request.closedWhy).toBe("changed my mind");
    expect(s.open()).toEqual([]);
  });
});

describe("every refusal", () => {
  test("an unknown id", () => {
    const s = setup();
    for (const run of [() => s.requests.assign(9, { lane: "a" }, HQ), () => s.requests.move("x", "t", HQ), () => s.requests.show(9), () => s.requests.close(9, ""), () => s.requests.reopen(9, "t")]) expect(run).toThrow(/^no request #/);
  });

  test("another floor's request, unless the caller asks for every floor", () => {
    const s = setup();
    s.note("theirs", "other");
    expect(() => s.requests.assign(1, { lane: "a" }, HQ)).toThrow("request #1 is on floor other, not yours (main): its HQ moves it, or add --all");
    expect(() => s.requests.show(1, HQ)).toThrow("is on floor other");
    expect(s.requests.assign(1, { lane: "a" }, { by: "hq", floor: null }).request.status).toBe("assigned");
  });

  test("a wrong status, for each command", () => {
    const s = setup();
    s.note("sorted");
    s.requests.assign(1, { lane: "alpha" }, HQ);
    expect(() => s.requests.drop(1, "why", HQ)).toThrow("request #1 is assigned: drop needs new; a sorted request is given up with hud work withdraw ID WHY");
    expect(() => s.requests.attach(1, 1, HQ)).toThrow("request #1 is assigned: attach needs new");
    expect(() => s.requests.reopen(1, "more")).toThrow("request #1 is assigned: reopen needs delivered or withdrawn");
    s.requests.deliver(1, "L", "done", HQ);
    for (const run of [() => s.requests.assign(1, { lane: "b" }, HQ), () => s.requests.wait(1, 1, HQ), () => s.requests.move(1, "t", HQ), () => s.requests.deliver(1, "L", "t", HQ), () => s.requests.withdraw(1, "w", HQ)]) {
      expect(run).toThrow(/^request #1 is delivered: \w+ needs new, open, assigned or waiting$/);
    }
    s.requests.close(1, "");
    expect(() => s.requests.close(1, "")).toThrow("request #1 is closed: close needs");
    expect(() => s.requests.reopen(1, "again")).toThrow("request #1 is closed: reopen needs delivered or withdrawn");
    expect(() => s.requests.move(1, "t", HQ)).toThrow("request #1 is closed");
  });

  test("a missing reason, lane, link or text", () => {
    const s = setup();
    s.note("one");
    expect(() => s.requests.drop(1, "  ", HQ)).toThrow("say why it is not work: hud work drop ID WHY");
    expect(() => s.requests.withdraw(1, "", HQ)).toThrow("say why you give it up: hud work withdraw ID WHY");
    expect(() => s.requests.assign(1, {}, HQ)).toThrow("name the lane that owns it");
    expect(() => s.requests.move(1, "", HQ)).toThrow("say what moved");
    expect(() => s.requests.deliver(1, "https://example.test", "", HQ)).toThrow("a delivery is a link and one line");
    expect(() => s.requests.deliver(1, "", "done", HQ)).toThrow("a delivery is a link and one line");
    expect(() => s.requests.add({ floor: "main", text: " " })).toThrow("say what the owner asked for");
    s.requests.deliver(1, "L", "done", HQ);
    expect(() => s.requests.reopen(1, "")).toThrow("say what is still missing");
    expect(s.status(1)).toBe("delivered");
  });

  test("wait: the ask must exist, be open and be on the request's floor", () => {
    const s = setup();
    s.note("one");
    s.ask(60);
    s.ask(61, "other");
    s.ask(62);
    s.settle(62, "answered", "yes");
    expect(() => s.requests.wait(1, 99, HQ)).toThrow("no ask 99");
    expect(() => s.requests.wait(1, "", HQ)).toThrow("no ask ");
    expect(() => s.requests.wait(1, 62, HQ)).toThrow("ask 62 is answered: a request waits on an open question");
    expect(() => s.requests.wait(1, 61, HQ)).toThrow("ask 61 is on floor other, request #1 on main");
    expect(s.status(1)).toBe("new");
    expect(s.requests.wait(1, 60, HQ).request.status).toBe("waiting");
  });

  test("attach: only to a request that is not closed, on the same floor, and never to itself", () => {
    const s = setup();
    s.note("the first");
    s.note("a repeat");
    s.note("theirs", "other");
    expect(() => s.requests.attach(2, 2, HQ)).toThrow("request #2 cannot be attached to itself");
    expect(() => s.requests.attach(2, 9, HQ)).toThrow("no request #9");
    expect(() => s.requests.attach(2, 3, { by: "hq", floor: null })).toThrow("request #3 is on floor other, #2 on main");
    s.requests.drop(1, "not work", HQ);
    expect(() => s.requests.attach(2, 1, HQ)).toThrow("request #1 is closed: attach to a request that is still open");
    expect(s.status(2)).toBe("new");
  });

  test("attach: not to a delivered or withdrawn request, which would close and take the repeat with it", () => {
    const s = setup();
    for (const text of ["deploys before hours", "the logo", "the deploys still fail", "and the logo?"]) s.note(text);
    s.requests.deliver(1, "L", "done", HQ);
    s.requests.withdraw(2, "not doing it", HQ);
    expect(() => s.requests.attach(3, 1, HQ)).toThrow("request #1 is delivered: he asks again after it, so #3 is work of its own (hud work assign 3 LANE)");
    expect(() => s.requests.attach(4, 2, HQ)).toThrow("request #2 is withdrawn: he asks again after it");
    expect(s.open()).toEqual([1, 2, 3, 4]);
    expect(s.status(3)).toBe("new");
  });
});

describe("what is stored is never cut", () => {
  test("a long movement and a long answer are kept whole; only the list shortens them", () => {
    const s = setup();
    const long = `the migration ran ${"and ran ".repeat(60)}to the end`;
    s.note("migrate the tables");
    s.requests.assign(1, { lane: "alpha" }, HQ);
    s.requests.move(1, long, HQ);
    expect(s.requests.view()[0].moved).toBe(long);
    expect(s.requests.listText({ floor: "main" }).length).toBeLessThan(260);
    s.ask(30);
    s.requests.wait(1, 30, HQ);
    s.settle(30, "answered", long);
    s.requests.askSettled(30);
    expect(s.requests.view()[0].moved).toBe(`the owner answered #30: ${long}`);
    expect(s.requests.show(1).moves.at(-1)!.text).toBe(`the owner answered #30: ${long}`);
  });
});

describe("hud work add --from", () => {
  test("work filed out of a note or an answer takes its time and its reference", () => {
    const s = setup();
    s.db.query("INSERT INTO notes (id, at, text, floor) VALUES (7, 1000, 'two things in one note', 'main')").run();
    s.db.query("INSERT INTO asks (id, status, floor, answer, created_at, answered_at) VALUES (70, 'answered', 'main', 'B, and add a dark mode', 500, 2000)").run();
    expect(s.requests.add({ floor: "main", text: "the second thing", from: "n:7" }).request).toMatchObject({ status: "open", source: "note", ref: "note:7", at: 1000 });
    const fromAnswer = s.requests.add({ floor: "main", text: "add a dark mode", from: "a:70" });
    expect(fromAnswer.request).toMatchObject({ status: "open", source: "answer", ref: "ask:70", at: 2000 });
    expect(fromAnswer.line).toBe('request #2 added, open: "add a dark mode". Give it an owner: hud work assign 2 LANE');
    expect(() => s.requests.add({ floor: "main", text: "t", from: "n:99" })).toThrow("no note 99");
    expect(() => s.requests.add({ floor: "main", text: "t", from: "a:99" })).toThrow("no ask 99");
    expect(() => s.requests.add({ floor: "main", text: "t", from: "note 7" })).toThrow("--from is a note or an answer: n:ID or a:ID");
  });
});

describe("a waiting request and its ask", () => {
  test("an answer moves it back to its lane, a withdrawn ask too; with no lane it goes back to open", () => {
    const s = setup();
    for (const text of ["with a lane", "without a lane", "its ask is withdrawn", "still waiting"]) s.note(text);
    for (const id of [80, 81, 82, 83]) s.ask(id);
    s.requests.assign(1, { lane: "alpha" }, HQ);
    s.requests.wait(1, 80, HQ);
    s.requests.wait(2, 81, HQ);
    s.requests.wait(3, 82, HQ);
    s.requests.wait(4, 83, HQ);
    s.settle(80, "answered", "option B, and keep the old\nname");
    expect(s.requests.askSettled(80)).toBe(1);
    expect(s.requests.show(1).request).toMatchObject({ status: "assigned", lane: "alpha", ask: null, moved: "the owner answered #80: option B, and keep the old name" });
    expect(s.requests.show(1).moves.at(-1)).toMatchObject({ kind: "answered", by: "hud" });
    s.settle(81, "answered", "yes");
    s.settle(82, "withdrawn", "withdrawn by HQ");
    // The sync finds every ask that closed, however it closed.
    expect(s.requests.housekeep()).toBe(2);
    expect(s.requests.show(2).request).toMatchObject({ status: "open", ask: null, moved: "the owner answered #81: yes" });
    expect(s.requests.show(3).request).toMatchObject({ status: "open", moved: "ask #82 was withdrawn" });
    expect(s.requests.show(4).request).toMatchObject({ status: "waiting", ask: 83 });
    expect(s.requests.housekeep()).toBe(0);
  });
});

describe("housekeeping", () => {
  test("a delivered request closes 24 h after the owner first saw it, not before", () => {
    const s = setup();
    s.note("one");
    s.requests.deliver(1, "L", "done", HQ);
    s.clock.t += 3 * DAY;
    expect(s.requests.housekeep()).toBe(0);
    expect(s.requests.seen([1])).toBe(1);
    const seenAt = s.clock.t;
    expect(s.requests.show(1).request.seenAt).toBe(seenAt);
    s.clock.t += HOUR;
    // Seen again: counted once, and the 24 h do not start over.
    expect(s.requests.seen([1])).toBe(0);
    expect(s.requests.show(1).request.seenAt).toBe(seenAt);
    s.clock.t = seenAt + SEEN_CLOSE_MS - 1;
    expect(s.requests.housekeep()).toBe(0);
    expect(s.status(1)).toBe("delivered");
    s.clock.t = seenAt + SEEN_CLOSE_MS;
    expect(s.requests.housekeep()).toBe(1);
    expect(s.requests.show(1).request).toMatchObject({ status: "closed", closedWhy: "delivered and seen by the owner", closedAt: s.clock.t });
    expect(s.requests.show(1).moves.at(-1)).toMatchObject({ kind: "closed", by: "hud" });
    expect(s.open()).toEqual([]);
    expect(s.requests.housekeep()).toBe(0);
  });

  test("never seen, it closes 7 days after delivery, not before", () => {
    const s = setup();
    s.note("one");
    s.clock.t += 5 * DAY;
    s.requests.deliver(1, "L", "done", HQ);
    const deliveredAt = s.clock.t;
    s.clock.t = deliveredAt + KEEP_MS - 1;
    expect(s.requests.housekeep()).toBe(0);
    s.clock.t = deliveredAt + KEEP_MS;
    expect(s.requests.housekeep()).toBe(1);
    expect(s.requests.show(1).request).toMatchObject({ status: "closed", closedWhy: "delivered 7 days ago" });
  });

  test("seen on day 6.5, it still closes 7 days after delivery", () => {
    const s = setup();
    s.note("one");
    s.requests.deliver(1, "L", "done", HQ);
    const deliveredAt = s.clock.t;
    s.clock.t = deliveredAt + KEEP_MS - 12 * HOUR;
    s.requests.seen([1]);
    s.clock.t = deliveredAt + KEEP_MS;
    expect(s.requests.housekeep()).toBe(1);
  });

  test("a withdrawn request is shown like a delivered one, then closes once seen", () => {
    const s = setup();
    s.note("one");
    s.requests.withdraw(1, "the vendor dropped the feature", HQ);
    expect(s.requests.view()[0]).toMatchObject({ status: "withdrawn", line: "the vendor dropped the feature" });
    s.requests.seen([1]);
    s.clock.t += SEEN_CLOSE_MS;
    expect(s.requests.housekeep()).toBe(1);
    expect(s.requests.show(1).request.closedWhy).toBe("withdrawn and seen by the owner");
  });

  test("seen counts only delivered and withdrawn requests; a reopened one starts over", () => {
    const s = setup();
    s.note("one");
    s.note("two");
    expect(s.requests.seen([1, 2, 99, "x"])).toBe(0);
    s.requests.deliver(1, "L", "done", HQ);
    s.requests.seen([1]);
    s.requests.reopen(1, "not yet right");
    s.clock.t += 30 * DAY;
    expect(s.requests.housekeep()).toBe(0);
    expect(s.status(1)).toBe("open");
    s.requests.deliver(1, "L2", "done again", HQ);
    s.clock.t += SEEN_CLOSE_MS + 1;
    expect(s.requests.housekeep()).toBe(0); // not seen since the second delivery
  });

  test("requests on a floor that was removed move to the first floor", () => {
    const s = setup();
    s.note("theirs", "other");
    s.db.query("DELETE FROM floors WHERE id = 'other'").run();
    expect(s.requests.housekeep()).toBe(1);
    expect(s.requests.view()[0].floor).toBe("main");
  });
});

describe("the sweep's lines", () => {
  test("requests to sort are always listed, words cut to 60 characters", () => {
    const s = setup();
    s.note("short one");
    s.note("a very long request that goes on and on about the deploys and the hours and the rest of it");
    const lines = s.requests.sweepLines("main", Infinity);
    expect(lines.sort).toBe('requests to sort 2: #1 "short one", #2 "a very long request that goes on and on about the deploys a…"');
    expect(lines.unmoved).toBeNull();
    expect(lines.waiting).toBeNull();
  });

  test("before the first sweep every open and assigned request is unmoved; after it, only the ones that did not move since", () => {
    const s = setup();
    s.note("deploys before hours");
    s.note("the admin panel");
    s.requests.add({ floor: "main", text: "no owner yet" });
    s.requests.assign(1, { lane: "deploy-window" }, HQ);
    s.requests.assign(2, { lane: "admin-perf" }, HQ);
    expect(s.requests.sweepLines("main", Infinity).unmoved).toBe('requests with no movement since the last sweep 3: #1 (assigned deploy-window, now) "deploys before hours", #2 (assigned admin-perf, now) "the admin panel", #3 (open, now) "no owner yet"');
    const nudge = (s.clock.t += HOUR);
    s.clock.t += 3 * DAY;
    s.requests.move(2, "PR in review", HQ);
    expect(s.requests.sweepLines("main", nudge).unmoved).toBe('requests with no movement since the last sweep 2: #1 (assigned deploy-window, 3d) "deploys before hours", #3 (open, 3d) "no owner yet"');
    s.requests.move(1, "found the cron bug", HQ);
    s.requests.assign(3, { lane: "hq" }, HQ);
    expect(s.requests.sweepLines("main", nudge).unmoved).toBeNull();
  });

  test("waiting on the owner names each ask; closed, delivered and other floors' requests are in no line", () => {
    const s = setup();
    for (const text of ["waits", "delivered", "dropped", "waits with no lane"]) s.note(text);
    s.note("theirs", "other");
    s.ask(90);
    s.ask(91);
    s.requests.wait(1, 90, HQ);
    s.requests.deliver(2, "L", "done", HQ);
    s.requests.drop(3, "chatter", HQ);
    s.requests.wait(4, 91, HQ);
    expect(s.requests.sweepLines("main", Infinity, "Owner")).toEqual({ sort: null, unmoved: null, waiting: "waiting on Owner 2: #1 (ask 90), #4 (ask 91)" });
    expect(s.requests.sweepLines("other", Infinity).sort).toBe('requests to sort 1: #5 "theirs"');
  });

  test("a request that waits with no ask is HQ's to move: it is named as unmoved, not as waiting on the owner", () => {
    const s = setup();
    s.requests.importLedger("| # | Request | Owner | Status | Next step |\n|---|---|---|---|---|\n| R1 | the EU site live | eu-site | WAITING-OWNER | add the records |\n", { floor: "main", by: "hq" });
    expect(s.requests.sweepLines("main", Infinity)).toEqual({ sort: null, unmoved: 'requests with no movement since the last sweep 1: #1 (waiting with no ask eu-site, now) "the EU site live"', waiting: null });
    s.ask(95);
    s.requests.wait(1, 95, HQ);
    expect(s.requests.sweepLines("main", Infinity)).toEqual({ sort: null, unmoved: null, waiting: "waiting on the owner 1: #1 (ask 95)" });
  });

  test("a long list names eight and counts the rest", () => {
    const s = setup();
    for (let i = 1; i <= 11; i++) s.note(`request ${i}`);
    expect(s.requests.sweepLines("main", Infinity).sort).toMatch(/^requests to sort 11: #1 "request 1", .*#8 "request 8", \+3 more \(hud work\)$/);
  });
});

// A ledger of the shape HQ kept by hand, with made-up rows: 13 of them, every status, dates and next steps as written.
const LEDGER = `# The owner's requests: the ledger

Status: OPEN (no owner yet) · ASSIGNED (lane named) · WAITING-OWNER (his step named) · DELIVERED (link) · DROPPED (his words)

| # | Date | Request (his words, short) | Owner | Status | Next step | Last moved |
|---|---|---|---|---|---|---|
| R1 | ~4 to 8 Mar | "getting our deploys to run before hours" | deploy-window (new lane) | ASSIGNED | Find why scheduled releases do not happen; prove with a scheduled run | 9 Mar 23:00 |
| R2 | 9 Mar | Partner controls: "ensure that its captured" | partner-slice1 | ASSIGNED | Slice 1 PR (ABC-4945/4946) + backfill job | 9 Mar 22:40 |
| R3 | 9 Mar | Question design: "build it" | question-design | ASSIGNED | Draft #4900; waits #4826 on main | 9 Mar 22:50 |
| R4 | 9 Mar | #4872 "extremely important" | threads-link | ASSIGNED | Built on #4838 | 9 Mar 22:20 |
| R5 | 9 Mar | Admin panel slow | admin-perf | ASSIGNED | #4894 then the index PR (A, ask 1035) | 9 Mar 22:30 |
| R6 | 9 Mar | Mail for the team | email-move | WAITING-OWNER | Ask 1014 (five calls) | 9 Mar 22:45 |
| R7 | 9 Mar | The EU site live | eu-site | WAITING-OWNER | Resend: option (a) add the records, or (b) | 9 Mar 20:30 |
| R8 | 9 Mar | Calendar writes | calendar | WAITING-OWNER | Ask 1042: add 8 scopes; then #4641, #4659 | 9 Mar 22:55 |
| R9 | 9 Mar | Timings in admin (option B) | kpis | DELIVERED | Live: https://example.test/admin/timings | 9 Mar 23:30 |
| R10 | 9 Mar | Three high bugs (ABC-4907, 4914, 4916) | bugs-4907/4914/4916 | ASSIGNED | Each: draft PR | 9 Mar 22:40 |
| R11 | 9 Mar | "never drop a ball" | HQ | ASSIGNED | This ledger + the tracker | 9 Mar 23:00 |
| R12 | sometime | A debrief with voice | | OPEN | Nobody has it yet | |
| R13 | 9 Mar | "make the logo bigger" | - | DROPPED | "forget it" | 9 Mar 22:58 |
`;

describe("hud work import", () => {
  test("13 rows, each with its status, owner, issue, PR, ask and dates; a second import adds nothing", () => {
    const s = setup();
    s.ask(1014);
    s.ask(1042);
    s.settle(1042, "answered", "done");
    const year = new Date(s.clock.t).getFullYear();
    const dry = s.requests.importLedger(LEDGER, { floor: "main", dryRun: true, by: "hq" });
    expect(dry.added).toHaveLength(13);
    expect(dry.line).toBe("would import 13 requests on floor main (7 assigned, 3 waiting, 1 delivered, 1 open, 1 closed); 0 already there; nothing written");
    expect(s.requests.list({ floor: null })).toEqual([]);

    const first = s.requests.importLedger(LEDGER, { floor: "main", by: "hq" });
    expect(first.line).toBe("imported 13 requests on floor main (7 assigned, 3 waiting, 1 delivered, 1 open, 1 closed); 0 already there");
    expect(first.added).toEqual(dry.added);
    const rows = Object.fromEntries(s.requests.list({ floor: "main" }).map((r) => [r.ref, r]));
    expect(Object.keys(rows)).toHaveLength(12);
    expect(rows.R1).toMatchObject({ status: "assigned", lane: "deploy-window", source: "import", words: '"getting our deploys to run before hours"', at: new Date(year, 2, 4).getTime(), movedAt: new Date(year, 2, 9, 23, 0).getTime(), moved: "imported: next step: Find why scheduled releases do not happen; prove with a scheduled run" });
    expect(rows.R2).toMatchObject({ status: "assigned", lane: "partner-slice1", issue: "ABC-4945", pr: null, at: new Date(year, 2, 9).getTime() });
    expect(rows.R3).toMatchObject({ lane: "question-design", pr: "4900" });
    expect(rows.R4).toMatchObject({ lane: "threads-link", pr: "4872" });
    expect(rows.R6).toMatchObject({ status: "waiting", lane: "email-move", ask: 1014 });
    expect(rows.R7).toMatchObject({ status: "waiting", lane: "eu-site", ask: null });
    // Ask 1042 is answered: the row still waits, with no ask.
    expect(rows.R8).toMatchObject({ status: "waiting", ask: null, pr: "4641" });
    expect(rows.R9).toMatchObject({ status: "delivered", link: "https://example.test/admin/timings", line: "Live: https://example.test/admin/timings", lane: null });
    expect(rows.R10).toMatchObject({ lane: "bugs-4907/4914/4916", issue: "ABC-4907" });
    expect(rows.R11).toMatchObject({ status: "assigned", lane: "hq" });
    // An unreadable date is the time of the import; an open row has no owner.
    expect(rows.R12).toMatchObject({ status: "open", lane: null, at: s.clock.t, movedAt: s.clock.t });
    const [dropped] = s.requests.list({ floor: "main", closed: true });
    expect(dropped).toMatchObject({ ref: "R13", status: "closed", closedWhy: 'dropped (imported): "forget it"' });
    expect(s.requests.show(rows.R1.id).moves).toMatchObject([{ kind: "imported", by: "hq", text: "imported: next step: Find why scheduled releases do not happen; prove with a scheduled run" }]);

    const again = s.requests.importLedger(LEDGER, { floor: "main", by: "hq" });
    expect(again.added).toEqual([]);
    expect(again.line).toBe("imported 0 requests on floor main; 13 already there");
    expect(s.requests.list({ floor: "main" })).toHaveLength(12);
    // The same file on another floor is that floor's own import.
    expect(s.requests.importLedger(LEDGER, { floor: "other", dryRun: true, by: "hq" }).added).toHaveLength(13);
  });

  test("dates: the day next to the month, a year when given, last year for a day still ahead; a word like maybe is no month", () => {
    const s = setup(); // the clock says 10 March 2026
    const table = (rows: string[]) => `| # | Date | Request | Status | Last moved |\n|---|---|---|---|---|\n${rows.map((r, i) => `| D${i + 1} | ${r} | thing ${i + 1} | OPEN | |`).join("\n")}\n`;
    s.requests.importLedger(table(["maybe 5 Mar", "2 lanes, 6 Mar", "4 Nov 2025", "28 Dec", "Mar 7, 2026", "2026-03-08 14:30", "March 9", "next week"]), { floor: "main", by: "hq" });
    const at = Object.fromEntries(s.requests.view().map((r) => [r.ref, r.at]));
    expect(at).toEqual({
      D1: new Date(2026, 2, 5).getTime(), D2: new Date(2026, 2, 6).getTime(), D3: new Date(2025, 10, 4).getTime(), D4: new Date(2025, 11, 28).getTime(),
      D5: new Date(2026, 2, 7).getTime(), D6: new Date(2026, 2, 8, 14, 30).getTime(), D7: new Date(2026, 2, 9).getTime(), D8: s.clock.t,
    });
  });

  test("an ask's number is not a PR, and a second table's header is not a request", () => {
    const s = setup();
    const out = s.requests.importLedger("| # | Request | Owner | Status | Next step |\n|---|---|---|---|---|\n| R1 | Calendar writes | calendar | WAITING-OWNER | Ask #1042: add 8 scopes |\n\nDone earlier:\n\n| # | Request | Owner | Status | Next step |\n|---|---|---|---|---|\n| R2 | the old thing | alpha | ASSIGNED | PR #77 |\n", { floor: "main", by: "hq" });
    expect(out.added).toEqual(["R1 -> waiting calendar, no open ask named: Calendar writes", "R2 -> assigned alpha, PR #77: the old thing"]);
    expect(s.requests.view().map((r) => [r.ref, r.pr])).toEqual([["R1", null], ["R2", "77"]]);
  });

  test("an imported delivery last moved long ago is still shown: its 7 days count from the import", () => {
    const s = setup();
    s.requests.importLedger("| # | Request | Status | Next step | Last moved |\n|---|---|---|---|---|\n| R1 | timings in admin | DELIVERED | live | 2 Jan |\n", { floor: "main", by: "hq" });
    expect(s.requests.housekeep()).toBe(0);
    expect(s.requests.view()[0]).toMatchObject({ status: "delivered", movedAt: new Date(2026, 0, 2).getTime() });
    s.clock.t += KEEP_MS;
    expect(s.requests.housekeep()).toBe(1);
  });

  test("a status it does not know is filed as open and said; a file with no table is refused", () => {
    const s = setup();
    const out = s.requests.importLedger("| # | Request | Status |\n|---|---|---|\n| R1 | do the thing | PARKED |\n", { floor: "main", by: "hq" });
    expect(out.added).toEqual(["R1 -> open (status PARKED not known: filed as open): do the thing"]);
    expect(s.requests.view()[0]).toMatchObject({ status: "open", words: "do the thing" });
    expect(() => s.requests.importLedger("just some notes\n", { floor: "main", by: "hq" })).toThrow("no ledger table in the file");
  });
});

// ---- end to end: server.ts and hud.ts on a spare port, a throwaway data dir and a stub herdr ----

const data = mkdtempSync(join(tmpdir(), "hq-requests-test-"));
const herdr = join(data, "herdr");
const log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w1:p1","agent":"claude"},{"name":"hq-two","agent_status":"idle","pane_id":"w1:p2","agent":"claude"}]}}' ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);

let server: Awaited<ReturnType<typeof spawnServer>>;
const ENV = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_OWNER: "Owner", HERDR_PANE_ID: "", TZ: "UTC" };
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: ENV });
  await post("/api/sync");
  await post("/api/floors", { id: "two", name: "Two", hq: "hq-two" });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

// The page's calls carry no caller headers; hud's carry where it runs.
async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
}
const get = async (path: string) => (await fetch(`${server.base}${path}`)).json();
const state = () => get("/api/state");
const typed = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
async function typedWith(part: string) {
  for (let i = 0; i < 100 && !typed().some((p) => p.includes(part)); i++) await Bun.sleep(20);
  return typed().find((p) => p.includes(part));
}
// hud as HQ's commands run it, on the first floor (no pane: the first floor's caller).
const hud = (...args: string[]) => hudAs({}, ...args);
async function hudAs(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { cwd: data, env: { ...ENV, HUD_URL: server.base, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}
const FIRST = () => state().then((s) => s.floors[0].id as string);

describe("the server", () => {
  test("a note files a new request on its floor, in S.requests, and the line typed into HQ ends with it", async () => {
    const r = await post("/api/notes", { text: "get the deploys to run before hours" });
    expect(r).toMatchObject({ ok: true, request: 1 });
    const s = await state();
    expect(s.requests).toEqual([{ id: 1, floor: await FIRST(), at: expect.any(Number), words: "get the deploys to run before hours", source: "note", ref: `note:${s.notes[0].id}`, status: "new", lane: null, issue: null, pr: null, ask: null, link: null, line: null, movedAt: expect.any(Number), moved: null, seenAt: null }]);
    expect(await typedWith("deploys to run")).toBe("HUD note from Owner: get the deploys to run before hours (request #1: sort it with hud work assign 1 LANE | attach 1 OTHER | drop 1 WHY)");
  });

  test("an acknowledgement is filed closed: no row, and HQ's line carries no request", async () => {
    expect(await post("/api/notes", { text: "Thanks!" })).toMatchObject({ ok: true, request: null });
    expect((await state()).requests.map((r: any) => r.id)).toEqual([1]);
    expect(await typedWith("Thanks!")).toBe("HUD note from Owner: Thanks!");
    expect((await get("/api/requests/2")).request).toMatchObject({ status: "closed", closedWhy: "acknowledgement", words: "Thanks!" });
    expect(await post("/api/notes", { text: "ok do it now" })).toMatchObject({ request: 3 });
  });

  test("a note to another floor is that floor's request; an urgent one too", async () => {
    expect(await post("/api/notes", { text: "floor two, look at the bill", floor: "two", urgent: true })).toMatchObject({ request: 4 });
    expect((await state()).requests.find((r: any) => r.id === 4)).toMatchObject({ floor: "two", status: "new" });
    expect(await typedWith("look at the bill")).toBe("HUD note from Owner (URGENT): floor two, look at the bill (request #4: sort it with hud work assign 4 LANE | attach 4 OTHER | drop 4 WHY)");
  });

  test("GET /api/requests/ID answers the request and its moves; an unknown id is refused", async () => {
    await post("/api/requests/1/assign", { lane: "deploy-window", issue: "ABC-1" });
    const one = await get("/api/requests/1");
    expect(one.request).toMatchObject({ id: 1, status: "assigned", lane: "deploy-window", issue: "ABC-1", closedAt: null, closedWhy: null });
    expect(one.moves).toMatchObject([{ id: expect.any(Number), at: expect.any(Number), by: "hq", kind: "assigned", text: "assigned to deploy-window, ABC-1" }]);
    expect(await get("/api/requests/999")).toEqual({ error: "no request #999" });
  });

  test("the owner's routes: seen, reopen (HQ is told like a note) and close", async () => {
    await post("/api/requests/1/deliver", { link: "https://example.test/pr/12", text: "runs at 05:00 now" });
    expect(await post("/api/requests/seen", { ids: [1, 3] })).toMatchObject({ ok: true, seen: 1 });
    // Reported again (the page redraws): nothing changes, so no page is woken.
    const { version } = await state();
    expect(await post("/api/requests/seen", { ids: [1, 3] })).toMatchObject({ ok: true, seen: 0 });
    expect((await state()).version).toBe(version);
    expect((await state()).requests.find((r: any) => r.id === 1)).toMatchObject({ status: "delivered", link: "https://example.test/pr/12", line: "runs at 05:00 now", seenAt: expect.any(Number) });
    expect(await post("/api/requests/1/reopen", { text: " " })).toMatchObject({ status: 400, error: "say what is still missing" });
    expect(await post("/api/requests/1/reopen", { text: "it ran at 09:00 today" })).toMatchObject({ ok: true, request: { id: 1, status: "assigned", lane: "deploy-window", seenAt: null } });
    expect(await typedWith("reopened request")).toBe("HUD: Owner reopened request #1: it ran at 09:00 today");
    expect((await get("/api/requests/1")).moves.at(-1)).toMatchObject({ by: "owner", kind: "reopened", text: "reopened: it ran at 09:00 today" });
    expect(await post("/api/requests/3/close", { why: "never mind" })).toMatchObject({ ok: true, request: { id: 3, status: "closed" } });
    expect((await state()).requests.map((r: any) => r.id)).toEqual([1, 4]);
    expect(await post("/api/requests/3/close", {})).toMatchObject({ status: 400, error: expect.stringContaining("request #3 is closed") });
  });

  test("an agent's hud call cannot use the owner's routes", async () => {
    const asAgent = { "x-hud-cwd": encodeURIComponent(data), "x-hud-pane": "w1:p1" };
    for (const [path, body] of [["/api/requests/seen", { ids: [1] }], ["/api/requests/1/close", {}], ["/api/requests/1/reopen", { text: "x" }]] as const) {
      expect(await post(path, body, asAgent)).toMatchObject({ status: 400, error: expect.stringContaining("only the owner does this, from the page") });
      expect(await post(path, body, { "x-hud-cwd": encodeURIComponent(data) })).toMatchObject({ status: 400 });
    }
    expect((await get("/api/requests/1")).request.status).toBe("assigned");
  });
});

describe("hud work", () => {
  const one = async (id: number) => (await get(`/api/requests/${id}`)).request;
  const note = async (text: string, floor?: string) => (await post("/api/notes", { text, ...(floor ? { floor } : {}) })).request as number;
  let n = 0;

  test("list: your floor's not-closed requests, oldest first; --all every floor's; --closed the closed ones", async () => {
    const mine = await hud("work");
    expect(mine.code).toBe(0);
    expect(mine.out.split("\n")).toEqual([expect.stringMatching(/^#1 assigned · deploy-window, ABC-1 · "get the deploys to run before hours" · reopened: it ran at 09:00 today, (just now|1m ago)$/)]);
    expect((await hud("work", "list")).out).toBe(mine.out);
    const all = (await hud("work", "list", "--all")).out.split("\n");
    expect(all).toHaveLength(2);
    expect(all[1]).toMatch(/^#4 \[two\] new, to sort · "floor two, look at the bill" · nothing yet, (just now|1m ago)$/);
    const closed = (await hud("work", "list", "--closed")).out;
    expect(closed).toContain('#2 closed · "Thanks!" · acknowledgement');
    expect(closed).toContain('#3 closed · "ok do it now" · never mind');
    expect(closed).not.toContain("#1 ");
  });

  test("add, assign, move: each reply is one line saying what changed", async () => {
    const added = await hud("work", "add", "rotate", "the", "signing", "keys");
    n = Number(added.out.match(/#(\d+)/)?.[1]);
    expect(added).toEqual({ code: 0, err: "", out: `request #${n} added, open: "rotate the signing keys". Give it an owner: hud work assign ${n} LANE` });
    expect(await one(n)).toMatchObject({ status: "open", source: "hand", words: "rotate the signing keys" });
    expect(await hud("work", "assign", String(n), "tooling", "--issue", "ABC-9", "--pr", "31")).toMatchObject({ code: 0, out: `request #${n} assigned to tooling, ABC-9, PR #31 (was open)` });
    expect(await hud("work", "move", String(n), "PR", "31", "in", "review")).toMatchObject({ code: 0, out: `request #${n} moved: PR 31 in review` });
    expect(await one(n)).toMatchObject({ status: "assigned", lane: "tooling", issue: "ABC-9", pr: "31", moved: "PR 31 in review" });
  });

  test("wait, and the owner's answer moves it back to its lane at once", async () => {
    const { id: ask } = await post("/api/asks", { title: "Which key size?", options: ["2048", "4096"] });
    expect(await hud("work", "wait", String(n), String(ask))).toMatchObject({ code: 0, out: `request #${n} waits on the owner: ask #${ask} (was assigned)` });
    expect((await state()).requests.find((r: any) => r.id === n)).toMatchObject({ status: "waiting", ask, lane: "tooling" });
    await post(`/api/asks/${ask}/answer`, { answer: "4096" });
    expect(await one(n)).toMatchObject({ status: "assigned", lane: "tooling", ask: null, moved: `the owner answered #${ask}: 4096` });
  });

  test("a withdrawn ask frees it too; an ask that closes itself (all its items done) frees it at the next sync", async () => {
    const { id: gone } = await post("/api/asks", { title: "Never mind this one" });
    await hud("work", "wait", String(n), String(gone));
    await post(`/api/asks/${gone}/withdraw`, {});
    expect(await one(n)).toMatchObject({ status: "assigned", ask: null, moved: `ask #${gone} was withdrawn` });
    const { id: list } = await post("/api/ledger/asks", { title: "Merge the PR", items: ["merge it"] });
    await hud("work", "wait", String(n), String(list));
    await post(`/api/asks/${list}/items/1`, { done: true });
    expect((await one(n)).status).toBe("waiting");
    await post("/api/sync");
    expect(await one(n)).toMatchObject({ status: "assigned", ask: null, moved: `the owner answered #${list}: all done` });
  });

  test("deliver and show", async () => {
    expect(await hud("work", "deliver", String(n), "https://example.test/pr/31", "keys", "rotated")).toMatchObject({ code: 0, out: `request #${n} delivered: keys rotated (https://example.test/pr/31). It closes once the owner has seen it` });
    const shown = (await hud("work", "show", String(n))).out.split("\n");
    expect(shown[0]).toMatch(new RegExp(`^#${n} delivered · tooling, ABC-9, PR #31 · floor \\S+ · hand, .+ · https://example.test/pr/31$`));
    expect(shown[1]).toBe("rotate the signing keys");
    expect(shown.slice(2).map((l) => l.replace(/^ {2}.+?:\d\d {2}/, ""))).toEqual([
      "hq  assigned to tooling, ABC-9, PR #31",
      "hq  PR 31 in review",
      expect.stringMatching(/^hq  waiting on the owner: ask #\d+$/),
      expect.stringMatching(/^hud  the owner answered #\d+: 4096$/),
      expect.stringMatching(/^hq  waiting on the owner: /),
      expect.stringMatching(/^hud  ask #\d+ was withdrawn$/),
      expect.stringMatching(/^hq  waiting on the owner: /),
      expect.stringMatching(/^hud  the owner answered #\d+: all done$/),
      "hq  delivered: keys rotated (https://example.test/pr/31)",
    ]);
  });

  test("attach and drop sort a new note away; withdraw gives a request up", async () => {
    const repeat = await note("the deploys ran late AGAIN");
    expect(await hud("work", "attach", String(repeat), "1")).toMatchObject({ code: 0, out: `request #${repeat} closed as a repeat: its words are attached to #1` });
    expect((await get("/api/requests/1")).moves.at(-1)).toMatchObject({ kind: "attached", by: "owner", text: expect.stringContaining("the deploys ran late AGAIN (request #") });
    const chatter = await note("haha what a day");
    expect(await hud("work", "drop", String(chatter))).toMatchObject({ code: 2, out: "", err: "say why it is not work: hud work drop ID WHY" });
    expect(await hud("work", "drop", String(chatter), "chatter,", "nothing", "to", "do")).toMatchObject({ code: 0, out: `request #${chatter} dropped as not work: chatter, nothing to do` });
    const given = await note("buy the other domain too");
    expect(await hud("work", "withdraw", String(given), "it", "is", "taken")).toMatchObject({ code: 0, out: `request #${given} withdrawn: it is taken. The owner sees the reason, then it closes` });
    expect((await state()).requests.find((r: any) => r.id === given)).toMatchObject({ status: "withdrawn", line: "it is taken", link: null });
  });

  test("an unknown id, another floor's request, a wrong status, a missing ask or an unknown command exits 2 and says why", async () => {
    expect(await hud("work", "show", "999")).toMatchObject({ code: 2, out: "", err: "no request #999" });
    expect(await hud("work", "move", "999", "x")).toMatchObject({ code: 2, err: "no request #999" });
    expect(await hud("work", "assign", "4", "alpha")).toMatchObject({ code: 2, err: expect.stringMatching(/^request #4 is on floor two, not yours \(\S+\): its HQ moves it, or add --all$/) });
    expect(await hud("work", "show", "4")).toMatchObject({ code: 2, err: expect.stringContaining("request #4 is on floor two") });
    expect(await hud("work", "drop", String(n), "why")).toMatchObject({ code: 2, err: `request #${n} is delivered: drop needs new; a sorted request is given up with hud work withdraw ID WHY` });
    expect(await hud("work", "move", String(n), "more")).toMatchObject({ code: 2, err: `request #${n} is delivered: move needs new, open, assigned or waiting` });
    expect(await hud("work", "wait", "1", "99999")).toMatchObject({ code: 2, err: expect.stringContaining("no ask 99999") });
    expect(await hud("work", "close", "1")).toMatchObject({ code: 2, out: "", err: expect.stringContaining("usage: hud work") });
    for (const args of [["show"], ["assign"], ["move", "soon"]]) expect(await hud("work", ...args)).toMatchObject({ code: 2, out: "", err: expect.stringContaining("usage: hud work") });
    expect((await hud("work", "close", "1")).err).not.toContain("| close");
    expect((await one(1)).status).toBe("assigned");
  });

  test("--floor and --all reach another floor's request; as its own HQ no flag is needed", async () => {
    expect(await hud("work", "assign", "4", "billing", "--floor", "two")).toMatchObject({ code: 0, out: "request #4 assigned to billing (was new)" });
    expect(await hud("work", "move", "4", "asked", "the", "bank", "--all")).toMatchObject({ code: 0 });
    const asTwo = { HERDR_PANE_ID: "w1:p2" };
    expect((await hudAs(asTwo, "work")).out).toMatch(/^#4 assigned · billing · "floor two, look at the bill" · asked the bank, (just now|1m ago)$/);
    expect(await hudAs(asTwo, "work", "move", "4", "the", "bank", "answered")).toMatchObject({ code: 0, out: "request #4 moved: the bank answered" });
    expect((await get("/api/requests/4")).moves.at(-1)).toMatchObject({ by: "hq-two", kind: "moved" });
    expect(await hudAs(asTwo, "work", "move", "1", "x")).toMatchObject({ code: 2, err: expect.stringContaining("request #1 is on floor") });
  });

  test("import: --dry-run writes nothing, the import files 13 rows, and a second import adds nothing", async () => {
    const file = join(data, "ledger.md");
    writeFileSync(file, LEDGER);
    const before = (await state()).requests.length;
    const dry = await hud("work", "import", file, "--dry-run", "--floor", "two");
    expect(dry.code).toBe(0);
    const lines = dry.out.split("\n");
    expect(lines).toHaveLength(14);
    expect(lines[0]).toBe('R1 -> assigned deploy-window: "getting our deploys to run before hours"');
    expect(lines[5]).toBe("R6 -> waiting email-move, no open ask named: Mail for the team");
    expect(lines[13]).toBe("would import 13 requests on floor two (7 assigned, 3 waiting, 1 delivered, 1 open, 1 closed); 0 already there; nothing written");
    expect((await state()).requests).toHaveLength(before);
    expect(await hud("work", "import", "--dry-run", file, "--floor", "two")).toMatchObject({ code: 0, out: dry.out });
    expect(await hud("work", "import", file, "--floor", "two")).toMatchObject({ code: 0, out: "imported 13 requests on floor two (7 assigned, 3 waiting, 1 delivered, 1 open, 1 closed); 0 already there" });
    const s = await state();
    expect(s.requests).toHaveLength(before + 12);
    expect(s.requests.filter((r: any) => r.source === "import").every((r: any) => r.floor === "two")).toBe(true);
    // Oldest first: the imported rows are from March, before anything this test sent.
    expect(s.requests[0]).toMatchObject({ ref: "R1", status: "assigned", lane: "deploy-window" });
    expect(await hud("work", "import", file, "--floor", "two")).toMatchObject({ code: 0, out: "imported 0 requests on floor two; 13 already there" });
    expect((await state()).requests).toHaveLength(before + 12);
    expect(await hud("work", "import", join(data, "missing.md"))).toMatchObject({ code: 2, err: expect.stringContaining("no file") });
    expect(await hud("work", "import", "--all", file)).toMatchObject({ code: 2, err: "an import goes to one floor: --floor F, or none for yours" });
  });

  test("with the HQ QUEUE on, hud req next names the note's request; an acknowledgement has none; a reopen is queued", async () => {
    const asHq = { HERDR_PANE_ID: "w1:p1" };
    await post("/api/settings", { settings: { hqQueue: true } });
    try {
      const id = await note("make the invoices export to CSV");
      await post("/api/notes", { text: "ty!" });
      const first = (await hudAs(asHq, "req", "next")).out;
      expect(first).toContain("make the invoices export to CSV");
      expect(first).toContain(`request #${id}: sort it with hud work assign ${id} LANE | attach ${id} OTHER | drop ${id} WHY`);
      const second = (await hudAs(asHq, "req", "next")).out;
      expect(second).toContain("ty!");
      expect(second).not.toContain("sort it with");
      await post(`/api/requests/${n}/reopen`, { text: "the old key still works" });
      expect((await hudAs(asHq, "req", "next")).out).toContain(`HUD: Owner reopened request #${n}: the old key still works`);
      expect(typed().some((t) => t.includes("invoices export") || t.includes("the old key still works"))).toBe(false);
    } finally {
      await post("/api/settings", { settings: { hqQueue: false } });
    }
  });

  test("a secret's value typed into a note is redacted from the request and its history too", async () => {
    const VALUE = "TEST_ONLY_REQUEST_VALUE_81c3";
    await post("/api/secrets", { name: "DEPLOY_KEY", value: VALUE, minutes: 60, by: "owner" });
    const id = await note(`use ${VALUE} for the deploy and tell me when it is live`);
    await hud("work", "assign", String(id), "deploy-window");
    await hud("work", "move", String(id), `tried ${VALUE}, it works`);
    expect((await post("/api/secrets/redact", { name: "DEPLOY_KEY" })).status).toBe(200);
    const shown = JSON.stringify(await get(`/api/requests/${id}`));
    expect(shown).toContain("use [secret DEPLOY_KEY] for the deploy");
    expect(shown).toContain("tried [secret DEPLOY_KEY], it works");
    for (const text of [shown, JSON.stringify(await state()), (await hud("work", "list", "--all")).out, (await hud("work", "show", String(id))).out]) expect(text.includes(VALUE)).toBe(false);
    expect(readdirSync(data).filter((f) => f.startsWith("hud.db") && readFileSync(join(data, f)).toString("latin1").includes(VALUE))).toEqual([]);
  });
});

// The sweep on a server: a stub herdr with two idle HQs (one per floor) that logs who was typed into. One minute is
// 40 ms here, as in the sweep's own tests.
describe("the sweep", () => {
  const MINUTE = 40;
  const dir = mkdtempSync(join(tmpdir(), "hq-requests-sweep-"));
  const bin = join(dir, "herdr");
  const prompts = join(dir, "prompts.log");
  const agents = join(dir, "agents.json");
  const world = (hqStatus: string) => writeFileSync(agents, JSON.stringify([{ name: "hq", agent_status: hqStatus, pane_id: "w1:p1", agent: "claude" }, { name: "hq-two", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]));
  world("idle");
  writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s|%s\\n<<END>>\\n' "$3" "$4" >> "${prompts}" ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  let office: Awaited<ReturnType<typeof spawnServer>>;
  const send = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    (await fetch(`${office.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) })).json();
  const nudges = (agent: string) => (existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n<<END>>\n") : []).filter((p) => p.startsWith(`${agent}|HUD sweep:`));
  // A sync can step aside while another types the nudge in: wait for the count, then give an extra one a moment.
  async function settle(agent: string, count: number) {
    for (let i = 0; i < 150 && nudges(agent).length < count; i++) await Bun.sleep(20);
    await Bun.sleep(80);
    expect(nudges(agent)).toHaveLength(count);
  }
  const interval = () => Bun.sleep(21 * MINUTE);
  let mine = 0, theirs = 0, ask = 0;

  beforeAll(async () => {
    office = await spawnServer({ cwd: ROOT, env: { ...ENV, HUD_DATA_DIR: dir, HERDR_BIN: bin, HUD_SWEEP_MINUTE_MS: String(MINUTE) } });
    await send("/api/sync");
    await send("/api/floors", { id: "two", name: "Two", hq: "hq-two" });
    await send("/api/sync");
    await send("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
  });
  afterAll(async () => {
    await office?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a request to sort makes the nudge go with nothing else to list, and the nudge names hud work", async () => {
    ask = (await send("/api/asks", { title: "Which bank?", floor: "two" })).id;
    theirs = (await send("/api/notes", { text: "open the second account", floor: "two" })).request;
    await send(`/api/requests/${theirs}/wait`, { ask }, { "x-hud-floor": "two" });
    mine = (await send("/api/notes", { text: "sort me please" })).request;
    await send("/api/sync");
    await settle("hq", 1);
    await settle("hq-two", 1);
    expect(nudges("hq")[0]).toStartWith(`hq|HUD sweep: requests to sort 1: #${mine} "sort me please". Sweep now (hud work, hud inbox, the rooms);`);
    expect(nudges("hq-two")[0]).toContain(`HUD sweep: waiting on Owner 1: #${theirs} (ask ${ask}); questions waiting on Owner 1 (oldest `);
  });

  test("a request that moved since the last nudge is not named; one that only waits on the owner does not repeat", async () => {
    await send(`/api/requests/${mine}/assign`, { lane: "alpha" });
    await interval();
    await send("/api/sync");
    await settle("hq", 1);
    await settle("hq-two", 1);
  });

  test("unmoved through a whole interval it is named, though no nudge went in between; an answered one comes back the same way", async () => {
    await send(`/api/asks/${ask}/answer`, { answer: "the green one" });
    await interval();
    await send("/api/sync");
    await settle("hq", 2);
    expect(nudges("hq")[1]).toMatch(new RegExp(`^hq\\|HUD sweep: requests with no movement since the last sweep 1: #${mine} \\(assigned alpha, (now|\\d+[mh])\\) "sort me please"\\. Sweep now`));
    await settle("hq-two", 1); // the owner's answer moved it since floor two's last sweep
    await interval();
    await send("/api/sync");
    await settle("hq-two", 2);
    expect(nudges("hq-two")[1]).toMatch(new RegExp(`HUD sweep: requests with no movement since the last sweep 1: #${theirs} \\(open, (now|\\d+[mh])\\) "open the second account"\\. Sweep now`));
  }, 20_000);

  test("HQ worked right after a nudge but did not move the request: the same list, so the wait keeps doubling", async () => {
    await interval();
    await send("/api/sync");
    await settle("hq", 3); // 40 minutes after the second: unanswered once
    expect(nudges("hq")[2]).toContain(`requests with no movement since the last sweep 1: #${mine} (assigned alpha, `);
    world("working");
    await send("/api/sync");
    world("idle");
    await interval();
    await send("/api/sync");
    await settle("hq", 3); // the next is due 80 minutes after the third, not 20
  }, 20_000);
});
