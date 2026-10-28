// The project panel's data, the links on a question, panels over the room taking turns, and what Escape closes first
// (src/client/core/floors.js and panel.js). No browser.
import { describe, expect, test } from "bun:test";
import { on } from "../../src/client/core/bus.js";
import { closePanel, openPanel, showPanel } from "../../src/client/core/panel.js";
import { askLinks, escapeAction, issueLink, prLink, projectView } from "../../src/client/core/floors.js";

const lane = (name: string, status = "moving", floor = "hq", extra: object = {}) => ({ name, floor, heads: false, status, title: `${name} title`, ...extra });
const room = (slug: string, owner: string, extra: object = {}) => ({ slug, title: slug.toUpperCase(), owner, members: [], issues: [], prs: [], createdAt: 1, archivedAt: null, ...extra });
const S: any = {
  lanes: [lane("pm", "moving", "hq", { issue: "REL-1 REL-2", pr: "12, acme-example/app#7" }), lane("api"), lane("web", "blocked"), lane("solo")],
  // api's second question names no room, so it is not the project's; the third names the room but is deferred.
  open: [{ id: 1, lane: "api", room: "release", title: "Ship?", created_at: 5 }, { id: 2, lane: "api", room: null, title: "Unnamed", created_at: 6 }, { id: 4, lane: null, room: "release", title: "From HQ", created_at: 7 }],
  deferred: [{ id: 3, lane: "api", room: "release", title: "Later", created_at: 8 }],
  rooms: [room("release", "pm", { members: ["api", "web"], issues: ["REL-1"], prs: ["acme-example/app#7"] }), room("old", "pm", { archivedAt: 9 }), room("other", "web")],
  board: { items: [{ issue: "REL-1", state: "ci", why: "a check is running", prs: [{ key: "acme-example/app#7", state: "OPEN", ci: "running", draft: false }] }] },
};
const CONFIG = { linearWorkspace: "acme-example", githubRepo: "acme-example/app" };

describe("links on a question", () => {
  test("the open project whose room the question names, and its lane's issue and pull requests", () => {
    const ask = (lane: string | null, room: string | null) => ({ lane, room });
    expect(askLinks(S, CONFIG, ask("api", "release")).projects.map((p: any) => p.slug)).toEqual(["release"]);
    expect(askLinks(S, CONFIG, ask(null, "release")).projects).toEqual([{ slug: "release", title: "RELEASE" }]);
    // a lane in two rooms gets the one its question names, not both
    expect(askLinks(S, CONFIG, ask("web", "other")).projects.map((p: any) => p.slug)).toEqual(["other"]);
    const pm = askLinks(S, CONFIG, ask("pm", "release"));
    expect(pm.issues).toEqual([{ key: "REL-1", href: "https://linear.app/acme-example/issue/REL-1" }, { key: "REL-2", href: "https://linear.app/acme-example/issue/REL-2" }]);
    expect(pm.prs.map((p: any) => [p.num, p.href])).toEqual([["12", "https://github.com/acme-example/app/pull/12"], ["7", "https://github.com/acme-example/app/pull/7"]]);
  });

  test("no tag for a question that names no room, a room that is gone or archived; no link without a workspace or repo", () => {
    expect(askLinks(S, CONFIG, { lane: "api", room: null })).toEqual({ projects: [], issues: [], prs: [] }); // api is in release, but this question does not name it
    expect(askLinks(S, CONFIG, { lane: null, room: null })).toEqual({ projects: [], issues: [], prs: [] });
    expect(askLinks(S, CONFIG, { lane: "api", room: "old" }).projects).toEqual([]);
    expect(askLinks(S, CONFIG, { lane: "api", room: "nope" }).projects).toEqual([]);
    expect(issueLink({}, "REL-1").href).toBeNull();
    expect(prLink({}, "12").href).toBeNull();
    expect(prLink({}, "acme-example/app#7").href).toBe("https://github.com/acme-example/app/pull/7");
    expect(prLink(CONFIG, "#12").key).toBe("12");
  });
});

describe("the project panel's data", () => {
  test("state, open calls, who is on it and the linked work with its board state", () => {
    const v = projectView(S, CONFIG, "release")!;
    expect(v.state).toBe("waiting");
    expect(v.calls.map((a: any) => a.id)).toEqual([1, 4]);
    expect(Object.keys(v).sort()).toEqual(["calls", "color", "floor", "issues", "lanes", "name", "prs", "room", "state"]);
    expect(v.lanes.map((l: any) => [l.name, l.owner, l.help])).toEqual([["pm", true, null], ["api", false, null], ["web", false, "blocked"]]);
    expect(v.issues[0]).toMatchObject({ key: "REL-1", board: { state: "ci" } });
    expect(v.prs[0]).toMatchObject({ key: "acme-example/app#7", num: "7", pr: { state: "OPEN" }, board: { issue: "REL-1" } });
    expect(v.floor).toBe("hq");
  });

  test("a room no question names has no open calls, and its state is not red", () => {
    const v = projectView(S, CONFIG, "other")!;
    expect(v.calls).toEqual([]);
    expect(v.state).toBe("blocked"); // its owner, web, is blocked
    expect(projectView({ ...S, open: [] }, CONFIG, "release")!.state).toBe("blocked"); // with no question naming it, release is its blocked member, web, and not red
  });

  test("no panel for a room that is archived or does not exist", () => {
    expect(projectView(S, CONFIG, "old")).toBeNull();
    expect(projectView(S, CONFIG, "nope")).toBeNull();
    expect(projectView({ ...S, rooms: undefined }, CONFIG, "release")).toBeNull();
  });
});

describe("panels over the room take turns", () => {
  // Two panels as the page writes them: each closes when another opens.
  const make = (id: string) => {
    const p = { id, open: false };
    on("panel", (now: string | null) => { if (p.open && now !== id) p.open = false; });
    return { p, show: () => { p.open = true; showPanel(id); } };
  };
  const a = make("accounts"), b = make("project");

  test("opening one closes the other, so only one is ever open", () => {
    a.show();
    expect([a.p.open, b.p.open, openPanel()]).toEqual([true, false, "accounts"]);
    b.show();
    expect([a.p.open, b.p.open, openPanel()]).toEqual([false, true, "project"]);
  });

  test("closing a panel that is not the open one leaves the open one; closing with no id closes whichever", () => {
    closePanel("accounts");
    expect([b.p.open, openPanel()]).toEqual([true, "project"]);
    closePanel();
    expect([b.p.open, openPanel()]).toEqual([false, null]);
  });
});

describe("Escape", () => {
  const idle = { stage: false, settings: false, dialog: false, typing: false, panel: false };
  const scoped = { floor: "g", agent: "g-pm", all: false };

  test("an open panel closes before the scope is touched, then the scope steps out", () => {
    expect(escapeAction(scoped, { ...idle, panel: true })).toBe("panel");
    expect(escapeAction(scoped, idle)).toBe("out");
    expect(escapeAction({ floor: null, agent: null, all: false }, { ...idle, panel: true })).toBe("panel");
  });

  test("a room on the stage, SETTINGS, a dialog or a text field keep the key even with a panel open", () => {
    for (const busy of ["stage", "settings", "dialog", "typing"]) expect(escapeAction(scoped, { ...idle, panel: true, [busy]: true })).toBeNull();
  });
});

describe("the project panel's shelf", () => {
  const { shelfLoader } = require("../../src/client/project/shelf.js");
  const settle = () => new Promise((r) => setTimeout(r, 5));

  test("a failing fetch is asked once per room revision, kept as failed, and asked again on a new revision or a reset", async () => {
    let calls = 0, renders = 0;
    let r = { slug: "release", rev: 1 }; // the room as the page has it now
    const s: any = shelfLoader(async () => { calls++; throw new Error("503"); }, () => { renders++; s.of(r); }); // changed() renders, as the panel does
    expect(s.of(r)).toMatchObject({ list: null, failed: false });
    await settle();
    expect(s.of(r)).toMatchObject({ list: null, failed: true });
    expect([calls, renders]).toEqual([1, 1]); // the render after the failure does not ask again
    r = { ...r, rev: 2 };
    s.of(r);
    await settle();
    expect([calls, renders]).toEqual([2, 2]);
    s.reset();
    s.of(r);
    await settle();
    expect(calls).toBe(3);
  });

  test("a fetched list is kept, and stays shown while the next revision loads", async () => {
    let calls = 0;
    const s = shelfLoader(async () => [{ title: `a${++calls}` }], () => {});
    s.of({ slug: "release", rev: 1 });
    await settle();
    expect(s.of({ slug: "release", rev: 1 }).list).toEqual([{ title: "a1" }]);
    expect(s.of({ slug: "release", rev: 2 }).list).toEqual([{ title: "a1" }]);
    await settle();
    expect(s.of({ slug: "release", rev: 2 }).list).toEqual([{ title: "a2" }]);
    expect(s.of({ slug: "other", rev: 1 })).toMatchObject({ list: null });
    expect(calls).toBe(3);
  });
});

describe("a question's OPEN LINK", () => {
  const { openLinkHTML } = require("../../src/client/questions/links.js");
  test("only for a web address; nothing for any other link a question stored before the server refused them", () => {
    expect(openLinkHTML({ link: "https://example.com/a?b=1&c" })).toContain('href="https://example.com/a?b=1&amp;c"');
    expect(openLinkHTML({ link: "HTTP://example.com" })).toContain("OPEN LINK");
    for (const link of ["javascript:void(0)", " javascript:void(0)", "javascript:alert('https://x')", "data:text/html,x", "ftp://example.com", "example.com", "", null]) expect(openLinkHTML({ link })).toBe("");
  });
});

describe("the project panel's shelf, shown again", () => {
  const { shelfLoader } = require("../../src/client/project/shelf.js");
  const settle = () => new Promise((r) => setTimeout(r, 5));
  test("a failed shelf is asked for again when its project is shown again, at the same revision; a loaded one is not", async () => {
    let calls = 0, up = false;
    const s = shelfLoader(async () => { calls++; if (!up) throw new Error("down"); return [{ title: "a" }]; }, () => {});
    const r = { slug: "release", rev: 1 };
    s.of(r);
    await settle();
    expect(s.of(r).failed).toBe(true);
    up = true;
    s.retry();
    s.of(r);
    await settle();
    expect(s.of(r)).toMatchObject({ failed: false, list: [{ title: "a" }] });
    s.retry();
    s.of(r);
    expect(calls).toBe(2);
  });
});
