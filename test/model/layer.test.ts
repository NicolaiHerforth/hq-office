// The layer over the room (src/client/core/floors.js and src/client/layer/place.js): who gets a marker, which projects
// hang on which floor and in what colour, where markers and frames may go, and the NEED HELP strip in a scope. No browser.
import { beforeEach, describe, expect, test } from "bun:test";
import { setS } from "../../src/client/core/state.js";
import { allFloors, chooseAgent, scope, setFloor } from "../../src/client/core/scope.js";
import { KEEP_CLEAR, MARK_SIZE, RH, RW, TERMINAL, WALL, figure, frameBox, frameSlots, meets, placeMarks } from "../../src/client/layer/place.js";
import {
  FRAMES_MAX, HELP_COLORS, PROJECT_COLORS, floorLabel, floorRooms, frameName, frames, helpMarks, helpStrip, needHelp, projectState, roomCalls,
} from "../../src/client/core/floors.js";

const store = new Map<string, string>();
(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

const lane = (name: string, status = "moving", floor = "hq", heads = false) => ({ name, floor, heads, status });
// HQ's floor: pm (moving), web (blocked), ops (waiting on you), idle (waiting on HQ). G's floor: g at the terminal (waiting on
// HQ), g-pm (moving), g-books (stalled), g-eng (blocked).
const S: any = {
  lanes: [
    lane("pm"), lane("web", "blocked"), lane("ops", "needs_you"), lane("idle", "hq_turn"),
    lane("g", "hq_turn", "g", true), lane("g-pm", "moving", "g"), lane("g-books", "stale", "g"), lane("g-eng", "blocked", "g"),
  ],
  // ops waits on you with two questions: one names room "a", one names none (so it belongs to no project).
  open: [{ id: 1, lane: "ops", room: "a", created_at: 1 }, { id: 2, lane: "ops", room: null, created_at: 2 }],
  deferred: [{ id: 3, lane: "ops", room: "a", created_at: 3 }],
  rooms: [],
  board: { items: [] },
};
const room = (slug: string, owner: string, extra: object = {}) => ({ slug, title: slug.toUpperCase(), owner, members: [], issues: [], prs: [], createdAt: 100, archivedAt: null, ...extra });

describe("who gets a marker", () => {
  const who = (floor: string, zoomedIn: boolean) => helpMarks(S, floor, zoomedIn).map((m: any) => `${m.lane}:${m.state}${m.head ? ":head" : ""}`);

  test("zoomed out, every agent that needs help, worst first", () => {
    expect(who("hq", false)).toEqual(["web:blocked", "ops:waiting", "idle:hq"]);
    expect(who("g", false)).toEqual(["g-eng:blocked", "g-books:stalled"]);
  });

  test("zoomed in, only blocked and stalled workers, so a worker waiting on you or HQ does not get a second sign", () => {
    expect(who("hq", true)).toEqual(["web:blocked"]);
    expect(who("g", true)).toEqual(["g-eng:blocked", "g-books:stalled"]);
  });

  // A general idle at its terminal waits on HQ, and after 15 idle minutes the server calls it stale: both are its normal
  // state, not a call for help.
  test("the general at the terminal is marked when blocked or waiting on you, never when idle (waiting on HQ, or stale)", () => {
    const as = (status: string) => ({ ...S, lanes: S.lanes.map((l: any) => (l.name === "g" ? { ...l, status } : l)) });
    for (const zoomedIn of [true, false]) {
      for (const status of ["hq_turn", "stale"]) {
        expect(helpMarks(as(status), "g", zoomedIn).some((m: any) => m.lane === "g")).toBe(false);
        expect(needHelp(as(status), { floor: "g", agent: null }).map((r: any) => r.lane)).not.toContain("g");
        expect(floorLabel(as(status), "g").help.map((r: any) => r.lane)).not.toContain("g");
      }
      for (const [status, state] of [["blocked", "blocked"], ["needs_you", "waiting"]]) {
        expect(helpMarks(as(status), "g", zoomedIn).find((m: any) => m.lane === "g")).toMatchObject({ state, head: true });
      }
    }
  });

  test("a blocked general also gets a NEED HELP row and a dot on its floor's tile; an idle one gets neither", () => {
    const blocked = { ...S, lanes: S.lanes.map((l: any) => (l.name === "g" ? { ...l, status: "blocked" } : l)) };
    expect(needHelp(blocked, { floor: "g", agent: null }).map((r: any) => r.lane)).toContain("g");
    expect(floorLabel(blocked, "g").help.map((r: any) => r.lane)).toContain("g");
    expect(needHelp(S, { floor: "g", agent: null }).map((r: any) => r.lane)).not.toContain("g");
    expect(floorLabel(S, "g").help.map((r: any) => r.lane)).not.toContain("g");
  });

  test("a blocked general shows on its floor: a marker at its terminal, zoomed in and zoomed out", () => {
    const blocked = { ...S, lanes: S.lanes.map((l: any) => (l.name === "g" ? { ...l, status: "blocked" } : l)) };
    for (const zoomedIn of [true, false]) {
      const marks = helpMarks(blocked, "g", zoomedIn);
      expect(marks.find((m: any) => m.lane === "g")).toMatchObject({ state: "blocked", head: true });
      const placed = placeMarks({ agents: marks.filter((m: any) => m.head).map((m: any) => ({ ...m, ...TERMINAL })), zoomedIn });
      expect(placed).toHaveLength(1);
      expect(Math.abs(placed[0].box.x - TERMINAL.sx) < 40 && Math.abs(placed[0].box.y - TERMINAL.sy) < 40).toBe(true);
    }
    expect(helpMarks(blocked, "hq", false).map((m: any) => m.lane)).not.toContain("g");
  });

  test("help states rank blocked, waiting on you, stalled, waiting on HQ", () => {
    const ranked = { ...S, lanes: [lane("a", "hq_turn"), lane("b", "stale"), lane("c", "needs_you"), lane("d", "blocked")] };
    expect(helpMarks(ranked, "hq", false).map((m: any) => m.state)).toEqual(["blocked", "waiting", "stalled", "hq"]);
  });
});

describe("which projects hang on which floor", () => {
  test("a project hangs on its owner's floor, and on HQ's when the owner is HQ or gone", () => {
    const withRooms = { ...S, rooms: [room("a", "pm"), room("b", "g-pm"), room("c", "hq"), room("d", "vanished"), room("e", "g")] };
    expect(floorRooms(withRooms, "hq").map((r: any) => r.slug)).toEqual(["a", "c", "d"]);
    expect(floorRooms(withRooms, "g").map((r: any) => r.slug)).toEqual(["b", "e"]);
  });

  test("archived rooms are not on the wall, the oldest hang first, and no floor has more than seven", () => {
    const many = Array.from({ length: 9 }, (_, i) => room(`r${i}`, "pm", { createdAt: 900 - i }));
    const withRooms = { ...S, rooms: [...many, room("old", "pm", { archivedAt: 5, createdAt: 1 })] };
    const hung = floorRooms(withRooms, "hq");
    expect(hung).toHaveLength(FRAMES_MAX);
    expect(hung.map((r: any) => r.slug)).toEqual(["r8", "r7", "r6", "r5", "r4", "r3", "r2"]);
  });
});

describe("a frame's colour is its project's state", () => {
  const item = (state: string, extra: object = {}) => ({ issue: "X-1", prs: [{ key: "9" }], state, ...extra });

  test("a question that names the room waits on you: red, over everything else", () => {
    const r = room("a", "pm", { members: ["web"] });
    expect(projectState({ ...S, rooms: [r] }, r)).toBe("waiting");
  });

  // Red means "a question about this project waits on you", so a room lane waiting on you with no question that names
  // the room leaves the frame whatever else it was: moving, blocked or stalled.
  test("a lane waiting on you without a question naming the room does not turn the frame red", () => {
    const noRoomQuestion = { ...S, open: S.open.filter((a: any) => a.room !== "a") };
    expect(projectState(noRoomQuestion, room("a", "pm", { members: ["ops"] }))).toBe("moving");
    expect(projectState(noRoomQuestion, room("a", "ops"))).toBe("moving");
    expect(projectState(noRoomQuestion, room("a", "pm", { members: ["ops", "web"] }))).toBe("blocked");
    expect(projectState(noRoomQuestion, room("a", "pm", { members: ["ops", "g-books"] }))).toBe("stalled");
    expect(projectState({ ...noRoomQuestion, board: { items: [item("ci")] } }, room("a", "pm", { members: ["ops"], issues: ["X-1"] }))).toBe("ci");
  });

  test("a question naming another room, or a deferred one, does not turn the frame red", () => {
    const other = { ...S, open: [{ id: 5, lane: "pm", room: "b", created_at: 1 }], deferred: [] };
    expect(projectState(other, room("a", "pm"))).toBe("moving");
    expect(projectState({ ...S, open: [] }, room("a", "pm"))).toBe("moving"); // the deferred one stays out of S.open
  });

  test("blocked beats stalled beats CI beats moving", () => {
    const base = { ...S, open: [] };
    const ci = { ...base, board: { items: [item("ci")] } };
    expect(projectState(base, room("m", "pm"))).toBe("moving");
    expect(projectState(ci, room("c", "pm", { issues: ["X-1"] }))).toBe("ci");
    expect(projectState(ci, room("s", "pm", { issues: ["X-1"], members: ["g-books"] }))).toBe("stalled");
    expect(projectState({ ...base, board: { items: [item("stalled")] } }, room("t", "pm", { issues: ["X-1"] }))).toBe("stalled");
    expect(projectState(base, room("b", "pm", { members: ["web", "g-books"] }))).toBe("blocked");
  });

  test("work on the board counts through its issue or any of its pull requests, and work waiting on you is waiting", () => {
    const base = { ...S, open: [], board: { items: [item("owner")] } };
    expect(projectState(base, room("i", "pm", { issues: ["X-1"] }))).toBe("waiting");
    expect(projectState(base, room("p", "pm", { prs: ["9"] }))).toBe("waiting");
    expect(projectState(base, room("n", "pm", { issues: ["Y-2"], prs: ["10"] }))).toBe("moving");
  });

  test("a lane waiting on HQ does not colour a project, and a lane that is gone does not throw", () => {
    expect(projectState({ ...S, open: [] }, room("h", "idle", { members: ["ghost"] }))).toBe("moving");
  });

  test("frames carry the colour of their state and the questions that name the room, and say so", () => {
    const r = room("a", "pm", { members: ["ops"] });
    const f = frames({ ...S, rooms: [r, room("b", "web")] }, "hq");
    expect(f).toEqual([
      { slug: "a", title: "A", state: "waiting", color: PROJECT_COLORS.waiting, calls: 1 },
      { slug: "b", title: "B", state: "blocked", color: PROJECT_COLORS.blocked, calls: 0 },
    ]);
    expect(f.map(frameName)).toEqual(["A: WAITING ON YOU, 1 for you", "B: BLOCKED AT A PROMPT"]);
    expect(new Set(Object.values(PROJECT_COLORS)).size).toBe(Object.keys(PROJECT_COLORS).length);
    expect(PROJECT_COLORS.blocked).toBe(HELP_COLORS.blocked);
  });
});

describe("a project's questions", () => {
  test("only open questions that name the room count: not its lanes' unnamed ones, not another room's, not a deferred one", () => {
    const r = room("a", "pm", { members: ["ops"] });
    const asks = [
      { id: 1, lane: "ops", room: "a" }, { id: 2, lane: "ops", room: null }, { id: 3, lane: "pm", room: "b" },
      { id: 4, lane: null, room: "a" }, { id: 5, lane: "pm" },
    ];
    expect(roomCalls({ ...S, open: asks, deferred: [{ id: 6, lane: "ops", room: "a" }] }, r).map((a: any) => a.id)).toEqual([1, 4]);
    expect(roomCalls({ ...S, open: [] }, r)).toEqual([]);
  });

  test("the count and the name agree; red means something waits on you: a question, or a board item with no count", () => {
    const r = room("a", "pm", { members: ["ops"] });
    for (const [open, n] of [[[], 0], [[{ id: 1, lane: "ops", room: "a" }], 1], [[{ id: 1, lane: "ops", room: "a" }, { id: 2, lane: null, room: "a" }], 2]] as const) {
      const [f] = frames({ ...S, open, rooms: [r] }, "hq");
      expect(f.calls).toBe(n);
      expect(f.state === "waiting").toBe(n > 0);
      expect(frameName(f).endsWith(`, ${n} for you`)).toBe(n > 0);
    }
    // its linked work waits on you on the board: red, with no question to count
    const linked = room("b", "pm", { issues: ["X-1"] });
    const [f] = frames({ ...S, open: [], rooms: [linked], board: { items: [{ issue: "X-1", prs: [], state: "owner" }] } }, "hq");
    expect([f.state, f.calls, frameName(f)]).toEqual(["waiting", 0, "B: WAITING ON YOU"]);
  });
});

describe("the NEED HELP strip in a scope", () => {
  beforeEach(() => {
    setS(S);
    allFloors();
  });

  test("unscoped it lists every worker that needs help, worst first; scoped to a floor, that floor's alone", () => {
    expect(needHelp(S, { floor: null, agent: null }).map((r: any) => r.lane)).toEqual(["g-eng", "web", "ops", "g-books", "idle"]);
    const strip = helpStrip(S, { floor: "g", agent: null });
    expect(strip.count).toBe(2);
    expect(strip.rows.map((r: any) => r.lane)).toEqual(["g-eng", "g-books"]);
    expect(strip.disabled).toBe(false);
  });

  test("a scope with nobody needing help is disabled with no rows", () => {
    expect(helpStrip(S, { floor: "g", agent: "g-pm" })).toEqual({ count: 0, rows: [], disabled: true });
    expect(helpStrip(S, { floor: "hq", agent: "pm" })).toEqual({ count: 0, rows: [], disabled: true });
  });

  test("choosing a row inside a floor scope never leaves the floor", () => {
    setFloor("g");
    for (const row of helpStrip(S, { floor: "g", agent: null }).rows) {
      chooseAgent(row.lane, { jump: true });
      expect(scope().floor).toBe("g");
      setFloor("g");
    }
  });
});

describe("where frames and markers may go", () => {
  const wall = KEEP_CLEAR.map(([x, y, w, h]) => ({ x, y, w, h }));
  const agent = (sx: number, sy: number, lane = "a", state = "blocked") => ({ lane, state, sx, sy });

  test("seven frames hang on the wall, none over a window, the sign, the counter or the terminal, none over another", () => {
    expect(frameSlots(9)).toHaveLength(WALL.length);
    expect(WALL).toHaveLength(FRAMES_MAX);
    const boxes = frameSlots(FRAMES_MAX).map(frameBox);
    for (const b of boxes) {
      expect(b.x >= 0 && b.x + b.w <= RW && b.y >= 0 && b.y + b.h <= RH).toBe(true);
      expect(wall.filter((w) => meets(w, b, 0))).toEqual([]);
    }
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(meets(a, b, 0)).toBe(false)));
  });

  test("a marker sits beside its agent: zoomed in a small one, zoomed out a bigger one", () => {
    const [near] = placeMarks({ agents: [agent(100, 100)], zoomedIn: true });
    expect(near.box).toMatchObject(MARK_SIZE.in);
    expect(Math.abs(near.box.x - 100) < 24 && Math.abs(near.box.y - 100) < 24).toBe(true);
    const [big] = placeMarks({ agents: [agent(100, 100)], zoomedIn: false });
    expect(big.box).toMatchObject(MARK_SIZE.out);
  });

  test("a marker keeps off a name label: the nearest spot is taken by one, so it moves", () => {
    for (const zoomedIn of [true, false]) {
      const [free] = placeMarks({ agents: [agent(100, 100)], zoomedIn });
      const [moved] = placeMarks({ agents: [agent(100, 100)], labels: [{ ...free.box }], zoomedIn });
      expect(meets(free.box, moved.box, 1)).toBe(false);
    }
  });

  test("a marker keeps off other sprites and their bubbles, and off the markers already placed", () => {
    const [free] = placeMarks({ agents: [agent(100, 100)], zoomedIn: true });
    const other = { sx: free.box.x - 4, sy: free.box.y - 6 };
    const [moved] = placeMarks({ agents: [agent(100, 100)], sprites: [other], zoomedIn: true });
    expect(meets(figure(other.sx, other.sy), moved.box, 1)).toBe(false);
    const two = placeMarks({ agents: [agent(100, 100, "a"), agent(100, 100, "b")], zoomedIn: true });
    expect(two).toHaveLength(2);
    expect(meets(two[0].box, two[1].box, 1)).toBe(false);
  });

  test("wherever the agent stands, a marker stays in the room and off the wall pieces and the terminal", () => {
    for (const zoomedIn of [true, false]) {
      for (let sx = 0; sx <= RW - 16; sx += 8) {
        for (let sy = 8; sy <= RH - 16; sy += 8) {
          for (const m of placeMarks({ agents: [agent(sx, sy)], zoomedIn })) {
            const b = m.box;
            expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= RW && b.y + b.h <= RH).toBe(true);
            expect([...wall, figure(TERMINAL.sx, TERMINAL.sy)].filter((w) => meets(w, b, 1))).toEqual([]);
          }
        }
      }
    }
  });

  test("an agent with no clear spot gets no marker rather than one over something", () => {
    const boxed = placeMarks({ agents: [agent(100, 100)], labels: [{ x: 0, y: 0, w: RW, h: RH }], zoomedIn: true });
    expect(boxed).toEqual([]);
  });
});
