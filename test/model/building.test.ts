// The building and the floor tags (src/client/core/floors.js and scope.js): which floors show and draw, whether the
// page opens zoomed in or out, what BUILDING and ◀ ALL FLOORS do to the scope, and when a floor tag shows. No browser.
import { beforeEach, describe, expect, test } from "bun:test";
import { setS } from "../../src/client/core/state.js";
import { allFloors, chooseAgent, restore, scope, setFloor, toggleAll, view } from "../../src/client/core/scope.js";
import { floorTagHTML } from "../../src/client/floors/tag.js";
import { floorLabel, floorList, floorOfLane, floorTag, floorsInView, stageBar, stageMode } from "../../src/client/core/floors.js";

const lane = (name: string, floor = "hq", extra: object = {}) => ({ name, floor, heads: false, status: "moving", ...extra });
// Three floors: HQ's (pm, solo), FIN's (fin at the terminal, fin-pm, fin-eng) and SALES' (sales, sales-pm).
const three: any = {
  lanes: [
    lane("pm"), lane("solo", "hq", { status: "blocked" }),
    lane("fin", "fin", { heads: true }), lane("fin-pm", "fin", { status: "stale" }), lane("fin-eng", "fin", { status: "needs_you" }),
    lane("sales", "sales", { heads: true }), lane("sales-pm", "sales"),
  ],
  open: [{ id: 1, lane: "pm" }, { id: 2, lane: "fin-eng" }, { id: 3, lane: "fin-eng" }, { id: 4, lane: null }],
  updates: [{ id: 1, lane: "sales-pm" }, { id: 2, lane: null }],
};
const one: any = { lanes: [lane("a"), lane("b")], open: [{ id: 1, lane: "a" }], updates: [{ id: 1, lane: "a" }] };
const OUT = { floor: null, agent: null, all: false };
const store = new Map<string, string>();
(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };

describe("which floors show, and which draw", () => {
  test("one floor adds nothing: no building, no bar, HQ's room draws as it always did", () => {
    expect(stageMode(one, OUT)).toBe("single");
    expect(stageMode(one, { floor: "hq", agent: null, all: false })).toBe("single");
    expect(stageBar(one, OUT)).toBeNull();
    expect(floorsInView(one, OUT)).toEqual(["hq"]);
  });

  test("two or more floors: zoomed out is the building, every floor draws, BUILDING is marked and there is no way back", () => {
    expect(stageMode(three, OUT)).toBe("out");
    expect(floorsInView(three, OUT)).toEqual(["hq", "fin", "sales"]);
    expect(stageBar(three, OUT)).toEqual({ back: false, building: true });
  });

  test("zoomed into a floor, only that floor draws and ◀ ALL FLOORS shows", () => {
    const into = { floor: "fin", agent: null, all: false };
    expect(stageMode(three, into)).toBe("in");
    expect(floorsInView(three, into)).toEqual(["fin"]);
    expect(stageBar(three, into)).toEqual({ back: true, building: false });
    // an agent keeps its floor in view; SHOW ALL lifts the lists, not the zoom
    expect(floorsInView(three, { floor: "fin", agent: "fin-pm", all: false })).toEqual(["fin"]);
    expect(stageMode(three, { floor: "fin", agent: null, all: true })).toBe("in");
  });

  test("a tile's label: tag, what waits on you there, and who needs help, worst first", () => {
    const fin = floorLabel(three, "fin");
    expect(fin).toMatchObject({ id: "fin", label: "FIN", color: floorList(three)[1].color, waiting: 2 });
    expect(fin.help.map((h: any) => h.lane + ":" + h.state)).toEqual(["fin-eng:waiting", "fin-pm:stalled"]);
    // HQ's floor owns the question with no lane, and a blocked lane heads its help
    const hq = floorLabel(three, "hq");
    expect(hq.waiting).toBe(2);
    expect(hq.help.map((h: any) => h.state)).toEqual(["blocked"]);
    expect(floorLabel(three, "sales").waiting).toBe(0);
  });
});

describe("zoomed in or out at load", () => {
  beforeEach(() => {
    store.clear();
    setS(three);
    allFloors();
  });
  const reload = (S: any) => {
    setS(S);
    restore();
    return stageMode(S, scope());
  };

  test("a new tab with two floors opens zoomed out", () => {
    expect(reload(three)).toBe("out");
  });

  test("a reload with a floor in the tab opens zoomed in on it, and an agent keeps its floor", () => {
    setFloor("fin");
    expect(reload(three)).toBe("in");
    expect(scope().floor).toBe("fin");
    chooseAgent("sales-pm");
    expect(reload(three)).toBe("in");
    expect(scope().floor).toBe("sales");
  });

  test("a floor that has gone since opens zoomed out, and one floor never opens zoomed in", () => {
    setFloor("fin");
    const gone = { ...three, lanes: three.lanes.filter((l: any) => !l.name.startsWith("fin")) };
    expect(reload(gone)).toBe("out");
    setS(three);
    setFloor("fin");
    expect(reload(one)).toBe("single");
    expect(scope()).toEqual(OUT);
  });
});

describe("BUILDING and ◀ ALL FLOORS", () => {
  beforeEach(() => {
    store.clear();
    setS(three);
    allFloors();
  });

  test("from a floor, an agent or SHOW ALL they go all the way out, to the building with nothing scoped", () => {
    setFloor("fin");
    setFloor(null);
    expect(scope()).toEqual(OUT);
    chooseAgent("fin-eng");
    setFloor(null);
    expect(scope()).toEqual(OUT);
    setFloor("sales");
    toggleAll();
    expect(view()).toEqual({ floor: null, agent: null });
    setFloor(null);
    expect(scope()).toEqual(OUT);
    expect(stageMode(three, scope())).toBe("out");
  });

  test("a click on a floor's tile zooms in and scopes in one action, dropping the agent and SHOW ALL", () => {
    chooseAgent("fin-eng");
    toggleAll();
    setFloor("sales");
    expect(scope()).toEqual({ floor: "sales", agent: null, all: false });
    expect(view()).toEqual({ floor: "sales", agent: null });
  });
});

describe("floor tags", () => {
  test("none with one floor, where every row would carry the same one", () => {
    expect(floorTag(one, one.open[0])).toBeNull();
    expect(floorTag(one, one.updates[0])).toBeNull();
  });

  test("with two or more floors a question and an update carry their lane's floor, in its colour", () => {
    const colors = Object.fromEntries(floorList(three).map((f: any) => [f.id, f.color]));
    expect(floorTag(three, three.open[1])).toEqual({ id: "fin", label: "FIN", color: colors.fin });
    expect(floorTag(three, three.updates[0])).toEqual({ id: "sales", label: "SALES", color: colors.sales });
    expect(floorTag(three, three.open[0])).toEqual({ id: "hq", label: "HQ", color: colors.hq });
  });

  test("a question or an update with no lane, or a lane that is gone, and your notes, are on HQ's floor", () => {
    expect(floorTag(three, three.open[3])?.id).toBe("hq");
    expect(floorTag(three, { lane: "vanished" })?.id).toBe("hq");
    expect(floorTag(three, { text: "a note", at: 1 })?.id).toBe("hq");
    expect(floorOfLane(three, undefined)).toBe("hq");
  });
});

describe("the tag as markup", () => {
  test("a row's meta line gets no markup at all with one floor", () => {
    expect(floorTagHTML(one, one.open[0])).toBe("");
    expect(floorTagHTML(one, one.updates[0])).toBe("");
  });

  test("with two floors it names the floor in its colour, and a floor's name cannot break the markup", () => {
    const html = floorTagHTML(three, three.open[1]);
    expect(html).toContain(">FIN</span>");
    expect(html).toContain(`background:${floorList(three)[1].color}`);
    const odd: any = { lanes: [lane("pm"), lane("a<b>", "a<b>", { heads: true }), lane("x", "a<b>")], open: [], updates: [] };
    const tag = floorTagHTML(odd, { lane: "x" });
    expect(tag).toContain("A&lt;B&gt;");
    expect(tag).not.toContain("<b>");
  });
});
