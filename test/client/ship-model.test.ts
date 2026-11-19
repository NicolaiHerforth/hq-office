// MERGE's pure part (src/client/ship/model.js): whose move a PR is and why, the groups and their order, the tab's
// counts and who is idle until a merge. The page draws from these and the server's merge guard runs verdict(), so
// each rule here is one the owner sees.
import { expect, test } from "bun:test";
import { counts, domainOf, groups, idle, idleOn, methodOf, pileOf, ready, stuck, stuckOn, verdict } from "../../src/client/ship/model.js";

let next = 1;
const gh = (o: Record<string, unknown> = {}) => ({
  state: "OPEN", title: "Fix the thing", branch: "fix/thing", base: "main", sha: "abc123", draft: false,
  checks: "passing", review: "APPROVED", mergeable: "MERGEABLE", mergeState: "CLEAN",
  additions: 3, deletions: 1, files: 1, methods: ["squash", "merge"], autoMergeAllowed: true, autoMerge: false, ...o,
});
const pr = (o: Record<string, unknown> = {}, g: Record<string, unknown> | null = {}) => {
  const id = next++;
  return { id, floor: "hq", repo: "acme/web", number: id, url: `https://github.com/acme/web/pull/${id}`, lane: null, filer: null, note: "", at: 1000 + id, domain: null, urgency: "NORMAL", why: null, sorted: true, gh: g && gh(g), ghError: null, mergeError: null, hold: null, ...o };
};

test("a clean, approved PR whose checks passed is ready: the owner's move", () => {
  expect(verdict(pr())).toEqual({ can: "merge", pile: "ready", why: "", tone: "ok", move: "owner" });
  expect(ready(pr())).toBe(true);
});

test("a PR no checks ran on can merge, but only by its own button: it is the owner's to check", () => {
  expect(verdict(pr({}, { checks: "none" }))).toEqual({ can: "check", pile: "check", why: "no checks ran", tone: "wait", move: "owner" });
  expect(ready(pr({}, { checks: "none" }))).toBe(false);
  // whatever else stops it still wins: a draft with no checks is the agent's move
  expect(verdict(pr({}, { checks: "none", draft: true })).pile).toBe("wait");
});

test("every PR that is not the owner's move says why in a few words, and whose move it is", () => {
  const cases: [Record<string, unknown> | null, Record<string, unknown>, string, string, string, string | null][] = [
    [null, {}, "no", "not read from GitHub yet", "", "github"],
    [null, { ghError: "gh is not logged in" }, "no", "GitHub could not be read", "", "github"],
    [{ state: "MERGED" }, {}, "no", "already merged", "", null],
    [{ state: "CLOSED" }, {}, "no", "closed on GitHub", "", null],
    [{ checks: "pending", autoMerge: true }, {}, "queued", "merges by itself", "ok", "checks"],
    [{ draft: true }, {}, "no", "draft", "", "lane"],
    [{ mergeable: "CONFLICTING", base: "release" }, {}, "no", "conflicts with release", "bad", "lane"],
    [{ review: "CHANGES_REQUESTED" }, {}, "no", "changes requested", "bad", "lane"],
    [{ checks: "failing" }, {}, "no", "checks failing", "bad", "lane"],
    [{ methods: [] }, {}, "no", "the repo allows no merge method", "", null],
    [{ checks: "pending" }, {}, "auto", "checks running", "wait", "checks"],
    [{ checks: "pending", autoMergeAllowed: false }, {}, "no", "checks running", "wait", "checks"],
    [{ mergeState: "BEHIND" }, {}, "no", "behind main", "wait", "lane"],
    [{ mergeState: "BLOCKED", review: "REVIEW_REQUIRED" }, {}, "no", "needs a review", "wait", "review"],
    [{ mergeState: "BLOCKED" }, {}, "no", "blocked by branch rules", "wait", null],
    [{ mergeable: "UNKNOWN" }, {}, "no", "GitHub is still checking", "", "github"],
  ];
  for (const [g, o, can, why, tone, move] of cases) {
    const item = g === null ? pr(o, null) : pr(o, g);
    expect({ why, v: verdict(item) }).toStrictEqual({ why, v: { can, pile: "wait", why, tone, move } });
    expect(ready(item)).toBe(false);
  }
});

test("what GitHub did not say, or said in a way not known, is never the owner's move: it says which fact is unclear", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ checks: undefined }, "its checks"],
    [{ checks: "skipped" }, "its checks"],
    [{ mergeable: null }, "whether it can merge"],
    [{ mergeState: "QUEUED" }, "whether anything blocks it"],
    [{ mergeState: undefined }, "whether anything blocks it"],
    [{ methods: undefined }, "the repo's merge methods"],
    [{ state: undefined }, "whether it is open"],
    [{ draft: undefined }, "whether it is a draft"],
    [{ review: "DISMISSED" }, "its review"],
    [{ autoMerge: undefined }, "whether auto-merge is on"],
    [{ autoMergeAllowed: null }, "whether the repo allows auto-merge"],
    // what else would decide (no checks ran, checks running) does not open a door the unclear fact keeps shut
    [{ checks: "none", mergeable: null }, "whether it can merge"],
    [{ checks: "pending", mergeState: "QUEUED" }, "whether anything blocks it"],
  ];
  for (const [g, what] of cases) {
    const item = pr({}, g);
    expect({ g, v: verdict(item) }).toStrictEqual({ g, v: { can: "no", pile: "wait", why: `unclear from GitHub: ${what}`, tone: "", move: "github" } });
    expect(ready(item)).toBe(false);
  }
  // every fact GitHub can say, said, keeps its own verdict
  expect(verdict(pr({}, { mergeState: "HAS_HOOKS", review: null })).pile).toBe("ready");
  expect(verdict(pr({}, { mergeState: "UNSTABLE" })).pile).toBe("ready");
});

test("a draft is not ready even when everything else is green, and conflicts win over failing checks", () => {
  expect(verdict(pr({}, { draft: true, checks: "failing" })).why).toBe("draft");
  expect(verdict(pr({}, { mergeState: "DIRTY", checks: "failing" })).why).toBe("conflicts with main");
});

test("the merge method is the repo's first allowed of squash, merge, rebase", () => {
  expect(methodOf(pr({}, { methods: ["rebase", "merge"] }))).toBe("merge");
  expect(methodOf(pr({}, { methods: ["rebase"] }))).toBe("rebase");
  expect(methodOf(pr({}, null))).toBe(null);
});

test("a group is the sorter's domain, else the repo's name", () => {
  expect(domainOf(pr({ domain: "billing" }))).toBe("billing");
  expect(domainOf(pr({ repo: "acme/api" }))).toBe("api");
});

test("URGENT, the domains by name, LOW PRIORITY, then CHECK THESE YOURSELF; ready, then to check, then not ready, longest waiting first", () => {
  const items = [
    pr({ domain: "ui", at: 50 }, { checks: "failing" }),
    pr({ domain: "billing", urgency: "LOW", at: 10 }),
    pr({ domain: "ui", at: 90 }),
    pr({ domain: "api", urgency: "URGENT", why: "checkout is down", at: 70 }),
    pr({ domain: "ui", urgency: "URGENT", why: "data loss", at: 20 }, { checks: "pending" }),
    pr({ domain: "api", at: 30 }),
    pr({ domain: "ui", at: 40 }, { checks: "failing" }),
    pr({ domain: "ui", at: 5 }, { checks: "none" }),
    pr({ domain: "api", urgency: "URGENT", why: "prod", at: 80 }, { checks: "none" }),
    pr({ domain: "billing", urgency: "LOW", at: 1 }, { checks: "none" }),
  ];
  const g = groups(items);
  expect(g.map((x) => [x.key, x.label, x.one])).toEqual([["urgent", "URGENT", true], ["d:api", "api", false], ["d:ui", "ui", false], ["low", "LOW PRIORITY", false], ["check", "CHECK THESE YOURSELF", true]]);
  // urgent: ready, then the one to check, then the one not ready; an urgent PR with no checks stays urgent
  expect(g[0].items.map((i) => i.at)).toEqual([70, 80, 20]);
  // ui: the ready one first though it is the newest, then the rest oldest first; its unchecked PR went to CHECK
  expect(g[2].items.map((i) => i.at)).toEqual([90, 40, 50]);
  // the unchecked ones, whatever their domain or urgency below URGENT
  expect(g[4].items.map((i) => i.at)).toEqual([1, 5]);
  expect(groups([])).toEqual([]);
});

test("the counts: ready, to check, not ready, and the urgent ones the owner can still act on", () => {
  const items = [pr(), pr({}, { checks: "failing" }), pr({}, { checks: "none" }), pr({ urgency: "URGENT" }), pr({ urgency: "URGENT" }, { draft: true }), pr({ urgency: "URGENT" }, { checks: "pending", autoMerge: true })];
  expect(counts(items)).toEqual({ ready: 2, check: 1, wait: 3, urgent: 2 });
  expect(counts([])).toEqual({ ready: 0, check: 0, wait: 0, urgent: 0 });
});

test("idle until you merge: the PR's lane is not working, at a prompt or gone, and the PR is the owner's move", () => {
  const lanes = [
    { name: "a", status: "hq_turn" }, { name: "b", status: "done" }, { name: "c", status: "moving" },
    { name: "d", status: "blocked" }, { name: "e", status: "gone" },
  ];
  expect(["a", "b", "c", "d", "e", "zz"].map((lane) => idleOn(pr({ lane }), lanes))).toEqual(["a", "b", null, null, null, null]);
  expect(idleOn(pr({ lane: "a" }, { checks: "none" }), lanes)).toBe("a");
  expect(idleOn(pr({ lane: "a" }, { checks: "failing" }), lanes)).toBe(null);
  expect(idleOn(pr({ lane: null }), lanes)).toBe(null);
  expect(idleOn(pr({ lane: "a" }), undefined)).toBe(null);
  const items = [pr({ lane: "b" }), pr({ lane: "a" }), pr({ lane: "b" }, { checks: "none" }), pr({ lane: "a" }, { draft: true }), pr({ lane: "c" })];
  expect(idle(items, lanes)).toEqual([{ lane: "b", count: 2 }, { lane: "a", count: 1 }]);
  expect(pileOf(items[2])).toBe("check");
});

test("stuck, nobody moving: the lane with the next move is idle, or it needs a review on GitHub; never a PR that is his move or moving", () => {
  const lanes = [{ name: "a", status: "hq_turn" }, { name: "b", status: "moving" }, { name: "c", status: "blocked" }, { name: "d", status: "gone" }];
  // the lane's move: stuck only while that lane is on the page and idle
  for (const g of [{ mergeState: "BEHIND" }, { draft: true }, { mergeable: "CONFLICTING" }, { review: "CHANGES_REQUESTED" }, { checks: "failing" }]) {
    expect(["a", "b", "c", "d", "zz", null].map((lane) => stuckOn(pr({ lane }, g), lanes))).toEqual(["lane", null, null, null, null, null]);
  }
  // a review on GitHub: stuck whoever filed it, since the page cannot see a review under way
  expect(["a", "b", null].map((lane) => stuckOn(pr({ lane }, { mergeState: "BLOCKED", review: "REVIEW_REQUIRED" }), lanes))).toEqual(["review", "review", "review"]);
  // his move, or moving by itself, or nobody can tell: not stuck
  for (const [o, g] of [[{}, {}], [{}, { checks: "none" }], [{}, { checks: "pending" }], [{}, { checks: "pending", autoMerge: true }], [{}, { mergeable: "UNKNOWN" }], [{}, { mergeState: "BLOCKED" }], [{}, { state: "MERGED" }], [{}, null]] as [object, object | null][]) {
    expect(stuckOn(pr({ lane: "a", ...o }, g), lanes)).toBe(null);
  }
  const items = [pr({ lane: "a" }, { draft: true }), pr({ lane: "b" }, { draft: true }), pr({ lane: "a" }, { mergeState: "BEHIND" }), pr({ lane: "e" }, { checks: "failing" }), pr({ lane: "b" }, { mergeState: "BLOCKED", review: "REVIEW_REQUIRED" }), pr({ lane: "a" })];
  expect(stuck(items, lanes)).toEqual({ lanes: [{ lane: "a", count: 2 }], review: 1 });
  expect(stuck(items, [...lanes, { name: "e", status: "done" }])).toEqual({ lanes: [{ lane: "a", count: 2 }, { lane: "e", count: 1 }], review: 1 });
  expect(stuck([], lanes)).toEqual({ lanes: [], review: 0 });
});
