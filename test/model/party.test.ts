// PARTY's data (src/client/core/floors.js): the lanes in scope by floor, each with its status, and the WORKING n/m the strip
// shows for the same scope; and PARTY's turn among the panels over the room. No browser.
import { describe, expect, test } from "bun:test";
import { on } from "../../src/client/core/bus.js";
import { closePanel, openPanel, showPanel } from "../../src/client/core/panel.js";
import { counts, escapeAction, party } from "../../src/client/core/floors.js";

const lane = (name: string, status: string, floor: string, extra: object = {}) => ({ name, floor, heads: false, status, title: `${name} title`, ...extra });
const S: any = {
  lanes: [
    lane("pm", "moving", "hq"), lane("api", "moving", "hq"), lane("web", "blocked", "hq"), lane("ops", "parked", "hq"), lane("ci", "waiting", "hq"),
    lane("sales", "hq_turn", "sales", { heads: true }), lane("outb", "needs_you", "sales"), lane("lead", "moving", "sales"), lane("done-one", "done", "sales"),
    lane("fin", "hq_turn", "fin", { heads: true }), lane("recon", "stale", "fin"),
  ],
  open: [], updates: [], updatesUnread: 0,
};
const ALL = { floor: null, agent: null };
const names = (p: any) => p.groups.map((g: any) => [g.id, g.lanes.map((l: any) => l.name)]);

describe("PARTY's rows", () => {
  test("every lane by floor, HQ's floor first and then by name; a floor's general first, then its lanes by name", () => {
    expect(names(party(S, ALL))).toEqual([
      ["hq", ["api", "ci", "ops", "pm", "web"]],
      ["fin", ["fin", "recon"]],
      ["sales", ["sales", "done-one", "lead", "outb"]],
    ]);
  });

  test("each row has its status and title, and says whether it is a general", () => {
    const sales = party(S, ALL).groups[2].lanes;
    expect(sales[0]).toEqual({ name: "sales", status: "hq_turn", head: true, title: "sales title" });
    expect(sales.find((l: any) => l.name === "outb")).toMatchObject({ status: "needs_you", head: false });
    expect(party(S, ALL).groups[0].lanes.find((l: any) => l.name === "web").status).toBe("blocked");
  });

  test("a floor with no lane in scope is left out", () => {
    expect(party({ ...S, lanes: S.lanes.filter((l: any) => l.floor !== "fin") }, ALL).groups.map((g: any) => g.id)).toEqual(["hq", "sales"]);
  });

  test("a lane with no floor field is on HQ's floor, as everywhere", () => {
    const { floor, ...bare } = lane("x", "moving", "hq");
    expect(party({ ...S, lanes: [bare] }, ALL).groups.map((g: any) => g.id)).toEqual(["hq"]);
  });
});

describe("PARTY scoped", () => {
  test("a floor in scope lists that floor's lanes alone", () => {
    expect(names(party(S, { floor: "sales", agent: null }))).toEqual([["sales", ["sales", "done-one", "lead", "outb"]]]);
  });
  test("an agent in scope lists that lane alone", () => {
    expect(names(party(S, { floor: "sales", agent: "outb" }))).toEqual([["sales", ["outb"]]]);
  });
  test("with one floor an agent scope lists the lane and an unscoped view lists them all", () => {
    const one: any = { ...S, lanes: S.lanes.filter((l: any) => l.floor === "hq") };
    expect(names(party(one, { floor: null, agent: "web" }))).toEqual([["hq", ["web"]]]);
    expect(party(one, ALL).groups[0].lanes.length).toBe(5);
  });
});

describe("PARTY's count is the strip's", () => {
  const views = [ALL, { floor: "hq", agent: null }, { floor: "sales", agent: null }, { floor: "fin", agent: null }, { floor: "sales", agent: "lead" }, { floor: "hq", agent: "ops" }];
  test("WORKING n/m agrees with the top bar for every view", () => {
    for (const v of views) {
      const p = party(S, v), c = counts(S, v);
      expect({ v, working: p.working, live: p.live }).toEqual({ v, working: c.working, live: c.live });
    }
  });
  test("and the numbers are what the lanes say: moving over those not done or parked", () => {
    expect([party(S, ALL).working, party(S, ALL).live]).toEqual([3, 9]);
    expect([party(S, { floor: "sales", agent: null }).working, party(S, { floor: "sales", agent: null }).live]).toEqual([1, 3]);
    expect([party(S, { floor: "hq", agent: "ops" }).working, party(S, { floor: "hq", agent: "ops" }).live]).toEqual([0, 0]);
  });
  test("unscoped, every lane the state has is a row, done and parked ones too", () => {
    expect(party(S, ALL).groups.flatMap((g: any) => g.lanes).length).toBe(S.lanes.length);
  });
});

describe("PARTY takes its turn among the panels over the room", () => {
  test("opening it announces it, so an open RUNDOWN, project or ACCOUNTS closes itself; and the other way round", () => {
    showPanel(null);
    const ids: any[] = [];
    const off = on("panel", (id: any) => ids.push(id));
    showPanel("rundown");
    showPanel("party");
    expect(openPanel()).toBe("party");
    showPanel("rundown");
    expect(openPanel()).toBe("rundown");
    expect(ids).toEqual(["rundown", "party", "rundown"]);
    showPanel(null);
    off();
  });

  test("a conference room opening closes PARTY only while it is the one open", () => {
    showPanel(null);
    showPanel("rundown");
    closePanel("party");
    expect(openPanel()).toBe("rundown");
    showPanel("party");
    closePanel("party");
    expect(openPanel()).toBeNull();
  });

  test("Escape closes PARTY before it touches the scope", () => {
    const quiet = { stage: false, settings: false, dialog: false, typing: false };
    const scoped = { floor: "sales", agent: "outb", all: false };
    showPanel(null);
    showPanel("party");
    expect(escapeAction(scoped, { ...quiet, panel: openPanel() !== null })).toBe("panel");
    closePanel();
    expect(escapeAction(scoped, { ...quiet, panel: openPanel() !== null })).toBe("out");
  });
});
