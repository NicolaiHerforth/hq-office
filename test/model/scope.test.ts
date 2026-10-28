// The scope itself (src/client/core/scope.js): choosing an agent, going out a level, SHOW ALL, and keeping the scope
// in the tab across a reload. No browser: a sessionStorage stub and a state set by hand.
import { beforeEach, expect, test } from "bun:test";
import { on } from "../../src/client/core/bus.js";
import { setS } from "../../src/client/core/state.js";
import { allFloors, chooseAgent, normalize, outOne, restore, scope, setFloor, toggleAll, view } from "../../src/client/core/scope.js";

const lane = (name: string, floor = "hq", heads = false) => ({ name, floor, heads, status: "moving" });
const TWO = { lanes: [lane("pm"), lane("g", "g", true), lane("g-pm", "g")], open: [], updates: [] };
const ONE = { lanes: [lane("pm"), lane("b")], open: [], updates: [] };

const store = new Map<string, string>();
(globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
const events: any[] = [];
on("scope", (e: any) => events.push(e));

beforeEach(() => {
  setS(TWO);
  allFloors();
  events.length = 0;
});

test("choosing an agent scopes to the agent's floor; with one floor, to the agent alone", () => {
  chooseAgent("g-pm", { jump: true });
  expect(scope()).toEqual({ floor: "g", agent: "g-pm", all: false });
  expect(events.at(-1).jump).toBe(true);
  setS(ONE);
  chooseAgent("pm");
  expect(scope()).toEqual({ floor: null, agent: "pm", all: false });
});

test("a lane the state does not have is not chosen", () => {
  chooseAgent("g-pm");
  events.length = 0;
  chooseAgent("nobody", { jump: true });
  expect(scope()).toEqual({ floor: "g", agent: "g-pm", all: false });
  expect(events).toEqual([]);
});

test("out one goes agent, floor, none; with one floor, agent, none", () => {
  chooseAgent("g-pm");
  outOne();
  expect(scope()).toEqual({ floor: "g", agent: null, all: false });
  outOne();
  expect(scope()).toEqual({ floor: null, agent: null, all: false });
  setS(ONE);
  chooseAgent("pm");
  outOne();
  expect(scope()).toEqual({ floor: null, agent: null, all: false });
});

test("setFloor clears the agent; SHOW ALL lifts the view and brings it back", () => {
  chooseAgent("g-pm");
  setFloor("g");
  expect(scope()).toEqual({ floor: "g", agent: null, all: false });
  toggleAll();
  expect(view()).toEqual({ floor: null, agent: null });
  expect(scope().floor).toBe("g");
  toggleAll();
  expect(view()).toEqual({ floor: "g", agent: null });
});

test("SHOW ALL with nothing scoped does nothing", () => {
  toggleAll();
  expect(scope().all).toBe(false);
  expect(events).toEqual([]);
});

test("every change emits scope once, and no change emits nothing", () => {
  setFloor("g");
  setFloor("g");
  expect(events.length).toBe(1);
});

test("normalize drops a lane that has gone and a floor that has gone", () => {
  chooseAgent("g-pm");
  normalize({ ...TWO, lanes: TWO.lanes.filter((l) => l.name !== "g-pm") });
  expect(scope()).toEqual({ floor: "g", agent: null, all: false });
  normalize(ONE);
  expect(scope()).toEqual({ floor: null, agent: null, all: false });
});

test("the scope survives a reload in the same tab, checked against the lanes", () => {
  chooseAgent("g-pm");
  expect(JSON.parse(store.get("hq-scope")!)).toEqual({ floor: "g", agent: "g-pm", all: false });
  restore(); // the page, loaded again, reads it back
  expect(scope()).toEqual({ floor: "g", agent: "g-pm", all: false });
  setS(ONE);
  restore();
  expect(scope()).toEqual({ floor: null, agent: null, all: false });
  store.set("hq-scope", "not json");
  restore();
  expect(scope()).toEqual({ floor: null, agent: null, all: false });
});
