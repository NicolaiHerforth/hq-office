// The pure side of floors and the scope (src/client/core/floors.js): floor lists, what a scope lets through, the
// counts and lines every panel shows, and a scope that still holds after the lanes change. No browser.
import { describe, expect, test } from "bun:test";
import {
  canvasId, counts, escapeAction, floorFromPath, floorLanes, floorList, floorOfLane, floorTagShown, askScope, hasLane, helpStrip, inScope, jumpAsk, marksRead,
  needHelp, normalizeScope, nothingLine, othersLine, readAllBody, tellRecipient, terminalName, viewOf, chipText,
} from "../../src/client/core/floors.js";

const lane = (name: string, floor = "hq", extra: object = {}) => ({ name, floor, heads: false, status: "moving", ...extra });
// Two floors: HQ's (pm, solo) and G's (g at the terminal, g-pm, g-eng).
const two: any = {
  lanes: [lane("pm"), lane("solo", "hq", { status: "needs_you" }), lane("g", "g", { heads: true }), lane("g-pm", "g", { status: "stale" }), lane("g-eng", "g", { status: "needs_you" })],
  open: [{ id: 1, lane: "pm", created_at: 300 }, { id: 2, lane: "g-eng", created_at: 100 }, { id: 3, lane: "g-eng", created_at: 200 }, { id: 4, lane: null, created_at: 400 }],
  updates: [{ id: 1, lane: "pm", read_at: null }, { id: 2, lane: "g-pm", read_at: null }, { id: 3, lane: null, read_at: null }, { id: 4, lane: "g-pm", read_at: 5 }],
  updatesUnread: 5,
  updatesUnreadByLane: { pm: 1, "g-pm": 3, "": 1 },
};
const one: any = { lanes: [lane("a"), lane("b")], open: [], updates: [], updatesUnread: 0 };
const g = { floor: "g", agent: null };
const hq = { floor: "hq", agent: null };

describe("floors", () => {
  test("a copy's floor comes from its URL, and only HQ's draws on the page's canvas", () => {
    expect(floorFromPath("http://x/floor/g/src/client/room/loop.js")).toBe("g");
    expect(floorFromPath("/src/client/room/loop.js")).toBe("hq");
    expect(canvasId("hq")).toBe("room");
    expect(canvasId("g")).toBe("room-g");
  });

  test("HQ's floor comes first, the others by name; lanes of a floor leave out its head", () => {
    expect(floorList(two).map((f: any) => f.id)).toEqual(["hq", "g"]);
    expect(floorList(one).map((f: any) => f.id)).toEqual(["hq"]);
    expect(floorLanes(two, "g").map((l: any) => l.name)).toEqual(["g-pm", "g-eng"]);
    expect(floorOfLane(two, "g-pm")).toBe("g");
    expect(floorOfLane(two, "vanished")).toBe("hq");
    expect(terminalName(two, "hq")).toBe("HQ");
    expect(terminalName(two, "a-very-long-general-name")).toBe("A-VERY-LONG-G…");
    expect(floorTagShown(one)).toBe(false);
    expect(floorTagShown(two)).toBe(true);
  });

  test("Tell goes to HQ in every scope", () => {
    expect(tellRecipient(two, g)).toBe("HQ");
  });
});

describe("what a scope lets through", () => {
  test("no scope lets everything through; a floor lets its own; no lane is HQ's floor", () => {
    expect(two.open.every((a: any) => inScope(two, a, { floor: null, agent: null }))).toBe(true);
    expect(two.open.filter((a: any) => inScope(two, a, g)).map((a: any) => a.id)).toEqual([2, 3]);
    expect(two.open.filter((a: any) => inScope(two, a, hq)).map((a: any) => a.id)).toEqual([1, 4]);
    expect(two.open.filter((a: any) => inScope(two, a, { floor: "g", agent: "g-eng" })).map((a: any) => a.id)).toEqual([2, 3]);
    expect(inScope(two, { lane: "g-pm" }, { floor: "g", agent: "g-eng" })).toBe(false);
  });

  test("counts do not leak across floors, and unscoped they are today's", () => {
    expect(counts(two, g)).toMatchObject({ waiting: 2, oldest: 100, otherWaiting: 2, working: 1, live: 3, onHq: 1, unread: 3, otherUnread: 2 });
    expect(counts(two, hq)).toMatchObject({ waiting: 2, oldest: 300, working: 1, live: 2, onHq: 0, unread: 2 });
    expect(counts(two, viewOf({ floor: "g", agent: null, all: true }))).toMatchObject({ waiting: 4, oldest: 100, unread: 5, otherWaiting: 0 });
  });

  test("with no scope the counts are what the top bar showed before floors", () => {
    const none = { floor: null, agent: null };
    expect(counts(two, none)).toMatchObject({ waiting: two.open.length, oldest: 100, working: 2, live: 5, onHq: 1, unread: two.updatesUnread, otherWaiting: 0, otherUnread: 0 });
    expect(counts(one, none)).toMatchObject({ waiting: 0, oldest: null, working: 2, live: 2, onHq: 0, unread: 0 });
  });

  test("SHOW ALL turns the view off", () => {
    expect(viewOf({ floor: "g", agent: "g-pm", all: true })).toEqual({ floor: null, agent: null });
    expect(viewOf({ floor: "g", agent: "g-pm", all: false })).toEqual({ floor: "g", agent: "g-pm" });
  });
});

describe("the words of a scope", () => {
  test("the +N line at each level, the SHOW ALL line, and nothing when nothing is hidden", () => {
    expect(othersLine(two, { ...g, all: false }, 2)).toBe("+2 ON OTHER FLOORS · SHOW ALL");
    expect(othersLine(two, { floor: "g", agent: "g-pm", all: false }, 3)).toBe("+3 FROM OTHER AGENTS · SHOW ALL");
    expect(othersLine(two, { ...g, all: false }, 2, "1 NEW")).toBe("+2 ON OTHER FLOORS · 1 NEW");
    expect(othersLine(two, { ...g, all: true }, 2)).toBe("ALL FLOORS · ONLY G FLOOR");
    expect(othersLine(one, { floor: null, agent: "a", all: true }, 0)).toBe("ALL AGENTS · ONLY a");
    expect(othersLine(two, { ...g, all: false }, 0)).toBe("");
    expect(othersLine(two, { floor: null, agent: null, all: false }, 4)).toBe("");
  });

  test("the chip and the empty heading name the scope", () => {
    expect(chipText(two, { ...hq, all: false })).toBe("HQ FLOOR ✕");
    expect(chipText(two, { floor: "g", agent: "g-pm", all: false })).toBe("G FLOOR › g-pm ✕");
    expect(chipText(one, { floor: null, agent: "a", all: false })).toBe("a ✕");
    expect(chipText(two, { ...g, all: true })).toBe("");
    expect(nothingLine(two, { ...g, all: false })).toBe("NOTHING FROM G FLOOR WAITS ON YOU");
    expect(nothingLine(two, { floor: null, agent: null, all: false })).toBe("");
  });
});

describe("a scope that still holds", () => {
  const s = (floor: string | null, agent: string | null, all = false) => ({ floor, agent, all });
  test("a lane that has gone drops the agent", () => {
    expect(normalizeScope(two, s("g", "ghost"))).toEqual(s("g", null));
  });
  test("a floor that has gone zooms out", () => {
    expect(normalizeScope(one, s("g", null))).toEqual(s(null, null));
    expect(normalizeScope(two, s("zzz", null))).toEqual(s(null, null));
  });
  test("an agent that moved floors takes its scope with it", () => {
    expect(normalizeScope(two, s("hq", "g-pm"))).toEqual(s("g", "g-pm"));
  });
  test("one floor becoming two keeps the agent and gives it its floor", () => {
    expect(normalizeScope(one, s(null, "a"))).toEqual(s(null, "a"));
    const grown = { ...two, lanes: [...two.lanes, lane("a")] };
    expect(normalizeScope(grown, s(null, "a"))).toEqual(s("hq", "a"));
  });
  test("SHOW ALL means nothing with nothing scoped", () => {
    expect(normalizeScope(two, s(null, null, true))).toEqual(s(null, null));
    expect(normalizeScope(two, s("g", null, true))).toEqual(s("g", null, true));
  });
});

describe("help", () => {
  test("worst first, only the scope's, never the head; nobody needing help is disabled with no rows", () => {
    expect(needHelp(two, g).map((r: any) => [r.lane, r.state])).toEqual([["g-eng", "waiting"], ["g-pm", "stalled"]]);
    expect(helpStrip(one, { floor: null, agent: null })).toEqual({ count: 0, rows: [], disabled: true });
  });
});

describe("reading updates in a scope", () => {
  test("marksRead returns only the unread update ids in scope", () => {
    expect(marksRead(two, g)).toEqual([2]);
    expect(marksRead(two, hq)).toEqual([1, 3]);
    expect(marksRead(two, { floor: null, agent: null })).toEqual([1, 2, 3]);
  });
  test("readAllBody is empty unscoped", () => {
    expect(readAllBody({ floor: null, agent: null })).toEqual({});
    expect(readAllBody(g)).toEqual({ floor: "g" });
    expect(readAllBody({ floor: "g", agent: "g-pm" })).toEqual({ floor: "g", lane: "g-pm" });
  });
});

describe("escape and the jump", () => {
  const idle = { stage: false, settings: false, dialog: false, typing: false };
  test("Escape steps out of any scope, and leaves the key alone when nothing is scoped", () => {
    expect(escapeAction({ floor: null, agent: "a", all: false }, idle)).toBe("out");
    expect(escapeAction({ floor: "g", agent: null, all: false }, idle)).toBe("out");
    expect(escapeAction({ floor: null, agent: "a", all: true }, idle)).toBe("out");
    expect(escapeAction({ floor: null, agent: null, all: false }, idle)).toBeNull();
  });
  test("a room, SETTINGS, a dialog or a text field keeps the key", () => {
    const scoped = { floor: null, agent: "a", all: false };
    for (const busy of ["stage", "settings", "dialog", "typing"]) expect(escapeAction(scoped, { ...idle, [busy]: true })).toBeNull();
  });
  test("a jump goes to the lane's first open question, and nowhere for a lane that is gone", () => {
    expect(jumpAsk(two, "g-eng")?.id).toBe(2);
    expect(jumpAsk(two, "solo")).toBeNull();
    expect(jumpAsk({ ...two, lanes: [] }, "g-eng")).toBeNull();
    expect(jumpAsk(two, null)).toBeNull();
    expect(hasLane(two, "pm")).toBe(true);
    expect(hasLane(two, "nobody")).toBe(false);
  });
  test("a jump with a question's id goes to that question, not the lane's first; one that is gone goes nowhere", () => {
    expect(jumpAsk(two, "g-eng", 3)?.id).toBe(3);
    expect(jumpAsk(two, null, 4)?.id).toBe(4);
    expect(jumpAsk(two, "g-eng", 99)).toBeNull();
  });
  test("a question opens in its lane's scope, or with no lane (or one that is gone) on HQ's floor; one floor has no floor to scope to", () => {
    expect(askScope(two, two.open[2])).toEqual({ floor: "g", agent: "g-eng", all: false });
    expect(askScope(two, two.open[3])).toEqual({ floor: "hq", agent: null, all: false });
    expect(askScope(two, { id: 5, lane: "left" })).toEqual({ floor: "hq", agent: null, all: false });
    expect(askScope(one, { id: 5, lane: "a" })).toEqual({ floor: null, agent: "a", all: false });
    expect(askScope(one, { id: 6, lane: null })).toEqual({ floor: null, agent: null, all: false });
  });
  test("the chip reads the lane alone with one floor, and the floor and lane with two", () => {
    expect(chipText(one, { floor: null, agent: "a", all: false })).toBe("a ✕");
    expect(chipText(two, { floor: "g", agent: "g-eng", all: false })).toBe("G FLOOR › g-eng ✕");
  });
});
