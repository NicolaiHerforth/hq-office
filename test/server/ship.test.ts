// SHIP's book (src/server/ship.ts) in memory, with a clock the test moves: filing and filing again, GitHub's facts,
// the sorter's answers, SEND BACK, and the view the page draws (docs/ship.md).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWS, createShip, notNow, parsePr, prLinks, type Facts } from "../../src/server/ship.ts";
import { methodOf } from "../../src/client/ship/model.js";

function book() {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "../../src/server/schema/ship.sql"), "utf8"));
  const clock = { t: 1_000_000 };
  const ship = createShip({ db, now: () => clock.t, mask: (s) => s.replaceAll("hunter2-value", "[secret PW]"), sampler: true });
  return { ship, clock, db };
}
const URL = "https://github.com/Acme/Web/pull/12";
const facts = (o: Partial<Facts> = {}): Facts => ({
  state: "OPEN", title: "Fix login", branch: "fix-login", base: "main", sha: "abc1234", draft: false, checks: "passing", review: "APPROVED",
  mergeable: "MERGEABLE", mergeState: "CLEAN", additions: 3, deletions: 1, files: 2, methods: ["squash"], autoMergeAllowed: true, autoMerge: false, ...o,
});

describe("a PR's address", () => {
  test("a PR link with whatever follows it is that PR; anything else is not one", () => {
    for (const u of [URL, `${URL}/files`, `${URL}#issuecomment-1`, `${URL}?w=1`, ` ${URL}/ `]) expect(parsePr(u)).toEqual({ repo: "acme/web", number: 12, url: "https://github.com/acme/web/pull/12" });
    for (const u of ["https://github.com/acme/web/issues/12", "https://gitlab.com/acme/web/pull/12", "acme/web#12", `${URL}3x`, ""]) expect(parsePr(u)).toBeNull();
  });
  test("a text's PR links, once each, in order", () => {
    expect(prLinks(`merge these:\n${URL}\nhttps://github.com/acme/api/pull/3/files and ${URL}/files`).map((p) => `${p.repo}#${p.number}`)).toEqual(["acme/web#12", "acme/api#3"]);
  });
});

describe("filing", () => {
  test("the same PR twice is one item: the new call's values replace the old, a flag left out keeps its value", () => {
    const { ship, clock } = book();
    const a = ship.file({ url: URL, floor: "hq", lane: "fixer", filer: "fixer", note: "first note", urgent: "prod is down" });
    expect(a.updated).toBe(false);
    clock.t += 60_000;
    const b = ship.file({ url: `${URL}/files`, floor: "hq", filer: null, note: "second note" });
    expect(b).toMatchObject({ updated: true, item: { id: a.item.id, lane: "fixer", filer: null, note: "second note", urgency: "URGENT", why: "prod is down", at: 1_000_000 } });
    expect(ship.view().items).toHaveLength(1);
  });

  test("a PR that left SHIP comes back new when filed again: waits from now, read and sorted again, old flags gone", () => {
    const { ship, clock } = book();
    const { item } = ship.file({ url: URL, floor: "hq", lane: "fixer", filer: "fixer", note: "n", urgent: "why" });
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    ship.applySort([{ id: item.id, domain: "auth", urgency: "LOW", why: null }]);
    ship.sendBack(item.id, "needs a test");
    expect(ship.view().items).toEqual([]);
    clock.t += 3_600_000;
    const again = ship.file({ url: URL, floor: "ops", filer: null });
    expect(again.updated).toBe(false);
    expect(again.item).toMatchObject({ id: item.id, floor: "ops", lane: null, note: null, urgency: "NORMAL", why: null, sorted: false, domain: null, gh: null, at: clock.t });
  });

  test("a link that is not a PR is refused in words", () => {
    expect(() => book().ship.file({ url: "https://github.com/acme/web", floor: "hq", filer: null })).toThrow("not a GitHub PR link");
  });

  test("secrets are masked in what is kept", () => {
    const { ship } = book();
    const { item } = ship.file({ url: URL, floor: "hq", filer: null, note: "the key is hunter2-value", urgent: "hunter2-value leaked" });
    expect(item.note).toBe("the key is [secret PW]");
    expect(item.why).toBe("[secret PW] leaked");
  });
});

describe("GitHub's facts", () => {
  test("an open PR gets its facts; an error keeps the last facts and says why", () => {
    const { ship } = book();
    ship.file({ url: URL, floor: "hq", filer: null });
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    expect(ship.view()).toMatchObject({ items: [{ gh: facts(), ghError: null }] });
    ship.applyFacts(new Map([["acme/web#12", { error: "HTTP 502" }]]));
    expect(ship.view()).toMatchObject({ items: [{ gh: facts(), ghError: "HTTP 502" }] });
  });

  test("a read that finds nothing new writes nothing", () => {
    const { ship, db } = book();
    ship.file({ url: URL, floor: "hq", filer: null });
    ship.file({ url: "https://github.com/acme/web/pull/13", floor: "hq", filer: null });
    const read = new Map<string, Facts | { error: string }>([["acme/web#12", facts()], ["acme/web#13", { error: "HTTP 502" }]]);
    ship.applyFacts(read);
    const writes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = writes();
    expect(ship.applyFacts(read).changed).toBe(0);
    expect(writes()).toBe(before);
    expect(ship.applyFacts(new Map([["acme/web#12", facts({ checks: "failing" })]])).changed).toBe(1);
    expect(writes()).toBe(before + 1);
  });

  test("merged or closed on GitHub leaves SHIP, saying whether the owner had asked for the merge", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: null }).item;
    const b = ship.file({ url: "https://github.com/acme/web/pull/13", floor: "hq", filer: null }).item;
    ship.applyFacts(new Map([["acme/web#12", facts({ checks: "pending" })]]));
    ship.autoAsked(a.id);
    const { ended } = ship.applyFacts(new Map([["acme/web#12", facts({ state: "MERGED" })], ["acme/web#13", facts({ state: "CLOSED" })]]));
    expect(ended.map((e) => [e.item.id, e.how, e.asked])).toEqual([[a.id, "merged", true], [b.id, "closed", false]]);
    expect(ship.view().items).toEqual([]);
  });
});

describe("the owner's", () => {
  test("SEND BACK needs a note, and only an item in SHIP goes back", () => {
    const { ship } = book();
    const { item } = ship.file({ url: URL, floor: "hq", filer: null });
    expect(() => ship.sendBack(item.id, " ")).toThrow("say why it goes back");
    ship.sendBack(item.id, "rebase it");
    expect(() => ship.sendBack(item.id, "again")).toThrow("acme/web#12 is sent back, no longer in MERGE");
  });

  test("a merge leaves SHIP; MERGE WHEN GREEN stays with auto-merge on; a failed merge stays and says why", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: null }).item;
    const b = ship.file({ url: "https://github.com/acme/web/pull/13", floor: "hq", filer: null }).item;
    ship.applyFacts(new Map([["acme/web#12", facts()], ["acme/web#13", facts()]]));
    ship.setMergeError(b.id, "Head branch was modified");
    expect(ship.openItem(b.id)!.mergeError).toBe("Head branch was modified");
    ship.autoAsked(b.id);
    expect(ship.openItem(b.id)).toMatchObject({ mergeError: null, gh: { autoMerge: true } });
    expect(ship.markMerged(a.id).gh!.state).toBe("MERGED");
    expect(ship.view().items.map((i) => i.id)).toEqual([b.id]);
  });
  test("gh's merge is recorded whatever the row says by then: found merged by a read meanwhile, it is the owner's merge", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: null }).item;
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    ship.applyFacts(new Map([["acme/web#12", facts({ state: "MERGED" })]]));
    expect(ship.markMerged(a.id)).toMatchObject({ id: a.id, gh: { state: "MERGED" } });
    expect(ship.view().done).toMatchObject([{ id: a.id, how: "merged" }]);
    ship.setMergeError(a.id, "too late");
    ship.autoAsked(a.id);
    expect(ship.view().items).toEqual([]);
  });

  test("a held MERGE that a read found merged is the owner's already: gh's answer records nothing new, so nobody is told twice", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: "fixer" }).item;
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    ship.hold(a.id, { verb: "merge", sha: "abc1234" });
    expect(ship.applyFacts(new Map([["acme/web#12", facts({ state: "MERGED" })]])).ended).toMatchObject([{ how: "merged", asked: true }]);
    expect(ship.markMerged(a.id)).toBeNull();
    expect(ship.view().done).toMatchObject([{ id: a.id, how: "merged" }]);
  });
  test("a failed merge's reason stays while the head is the same, and goes once the PR is pushed to", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: null }).item;
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    ship.setMergeError(a.id, "pushed to since you looked");
    ship.applyFacts(new Map([["acme/web#12", facts()]]));
    expect(ship.openItem(a.id)!.mergeError).toBe("pushed to since you looked");
    ship.applyFacts(new Map([["acme/web#12", facts({ sha: "def5678" })]]));
    expect(ship.openItem(a.id)!.mergeError).toBeNull();
  });
});

// The server merges only what model.js's verdict allows (notNow, ALLOWS) with the method methodOf picks. These pin the
// rules here, on the server's side, so a change to the page's model cannot loosen what merges without a test failing.
describe("the merge guard", () => {
  const item = (o: Partial<Facts> | null) => ({ gh: o === null ? null : facts(o), ghError: null });
  const notReady: [string, Partial<Facts> | null][] = [
    ["not read", null], ["merged", { state: "MERGED" }], ["closed", { state: "CLOSED" }], ["auto-merge on", { autoMerge: true }],
    ["draft", { draft: true }], ["draft state", { mergeState: "DRAFT" }], ["conflicting", { mergeable: "CONFLICTING" }],
    ["dirty", { mergeState: "DIRTY" }], ["changes requested", { review: "CHANGES_REQUESTED" }], ["checks failing", { checks: "failing" }],
    ["no merge method", { methods: [] }], ["checks running", { checks: "pending" }], ["behind", { mergeState: "BEHIND" }],
    ["blocked", { mergeState: "BLOCKED" }], ["review required", { mergeState: "BLOCKED", review: "REVIEW_REQUIRED" }],
    ["mergeable unknown", { mergeable: "UNKNOWN" }], ["merge state unknown", { mergeState: "UNKNOWN" }],
  ];

  test("a group, one press and a held MERGE refuse every PR that is not ready", () => {
    for (const [why, o] of notReady) {
      expect([why, notNow(item(o), ALLOWS.group)]).toEqual([why, expect.any(String)]);
      expect([why, notNow(item(o), ALLOWS.one)]).toEqual([why, expect.any(String)]);
    }
    expect(notNow(item({}), ALLOWS.group)).toBeNull();
    expect(notNow(item({}), ALLOWS.one)).toBeNull();
  });

  test("a PR whose facts GitHub left out or gave unknown is refused by a group, one press, MERGE WHEN CHECKS PASS and a hold", () => {
    const unclear: Partial<Facts>[] = [{ checks: undefined }, { mergeable: null as any }, { mergeState: "QUEUED" }, { methods: undefined }, { checks: "none", mergeable: null as any }, { checks: "pending", mergeState: "QUEUED" }];
    for (const o of unclear) {
      for (const allows of [ALLOWS.group, ALLOWS.one, ALLOWS.auto]) expect([o, notNow(item(o), allows)]).toEqual([o, expect.stringContaining("unclear from GitHub")]);
      const { ship } = book();
      const { item: it } = ship.file({ url: URL, floor: "hq", filer: null });
      // as the server stores it: a field GitHub left out is not in the row at all
      ship.applyFacts(new Map([["acme/web#12", facts(o)]]));
      for (const verb of ["merge", "auto"]) expect(() => ship.hold(it.id, { verb, sha: "abc1234" })).toThrow("unclear from GitHub");
      expect(ship.nextHold()).toBeNull();
    }
  });

  test("a PR no checks ran on merges by one press only, never in a group", () => {
    expect(notNow(item({ checks: "none" }), ALLOWS.one)).toBeNull();
    expect(notNow(item({ checks: "none" }), ALLOWS.group)).toBe("no checks ran on it: it merges only by its own button");
  });

  test("MERGE WHEN CHECKS PASS only while checks run, on a repo that allows auto-merge, on a PR nothing else stops", () => {
    expect(notNow(item({ checks: "pending" }), ALLOWS.auto)).toBeNull();
    for (const o of [{}, { checks: "none" }, { checks: "pending", autoMergeAllowed: false }, { checks: "pending", draft: true }, { checks: "pending", mergeable: "CONFLICTING" }, { checks: "pending", autoMerge: true }] as Partial<Facts>[]) {
      expect([o, notNow(item(o), ALLOWS.auto)]).toEqual([o, expect.any(String)]);
    }
  });

  test("the merge method is the repo's first allowed of squash, merge, rebase, and none when it allows none", () => {
    expect(methodOf(item({ methods: ["rebase", "merge", "squash"] }))).toBe("squash");
    expect(methodOf(item({ methods: ["rebase", "merge"] }))).toBe("merge");
    expect(methodOf(item({ methods: ["rebase"] }))).toBe("rebase");
    expect(methodOf(item({ methods: [] }))).toBeNull();
  });
});

describe("the sort", () => {
  test("answers land on items not yet sorted; the filer's --urgent wins over the model", () => {
    const { ship } = book();
    const a = ship.file({ url: URL, floor: "hq", filer: null }).item;
    const b = ship.file({ url: "https://github.com/acme/web/pull/13", floor: "hq", filer: null, urgent: "blocks the release" }).item;
    expect(ship.applySort([{ id: a.id, domain: "auth", urgency: "URGENT", why: "login broken" }, { id: b.id, domain: "auth", urgency: "LOW", why: null }])).toBe(2);
    expect(ship.applySort([{ id: a.id, domain: "other", urgency: "LOW", why: null }])).toBe(0);
    expect(ship.view().items.map(({ domain, urgency, why, sorted }) => ({ domain, urgency, why, sorted }))).toEqual([
      { domain: "auth", urgency: "URGENT", why: "login broken", sorted: true },
      { domain: "auth", urgency: "URGENT", why: "blocks the release", sorted: true },
    ]);
    expect(ship.domainsInUse()).toEqual(["auth"]);
  });
});

describe("UNDO: the hold", () => {
  const held = (o: Partial<Facts> = {}) => {
    const b = book();
    const { item } = b.ship.file({ url: URL, floor: "hq", lane: "fixer", filer: "fixer" });
    b.ship.applyFacts(new Map([["acme/web#12", facts(o)]]));
    return { ...b, id: item.id };
  };

  test("a press is held for 5 s, shown on the item, and UNDO inside it takes it back", () => {
    const { ship, clock, id } = held();
    expect(ship.hold(id, { verb: "merge", sha: "abc1234" })).toEqual({ until: clock.t + 5000 });
    expect(ship.openItem(id)!.hold).toEqual({ verb: "merge", until: clock.t + 5000, note: null });
    clock.t += 4999;
    expect(ship.undo(id)).toEqual({ undone: true });
    expect(ship.openItem(id)!.hold).toBeNull();
    expect(ship.nextHold()).toBeNull();
  });

  test("the same press again answers the same time; another press while held is refused", () => {
    const { ship, clock, id } = held();
    const first = ship.hold(id, { verb: "merge", sha: "abc1234" });
    clock.t += 2000;
    expect(ship.hold(id, { verb: "merge", sha: "abc1234" })).toEqual(first);
    expect(() => ship.hold(id, { verb: "back", sha: "abc1234", note: "no" })).toThrow("held to merge already");
    expect(ship.openItem(id)!.hold!.verb).toBe("merge");
  });

  test("past its time it runs and cannot be undone; UNDO says why in words", () => {
    const { ship, clock, id } = held();
    ship.hold(id, { verb: "merge", sha: "abc1234" });
    clock.t += 5000;
    expect(ship.undo(id)).toEqual({ undone: false, why: "it is merging now: a merge cannot be taken back" });
    expect(ship.dueHolds().map((h) => [h.id, h.verb, h.sha])).toEqual([[id, "merge", "abc1234"]]);
    ship.markMerged(id);
    expect(ship.undo(id)).toEqual({ undone: false, why: "it is merged already: a merge cannot be taken back" });
  });

  test("a hold is refused when the PR's verdict does not allow that press now", () => {
    expect(() => held({ checks: "pending" }).ship.hold(1, { verb: "merge", sha: "abc1234" })).toThrow("MERGE WHEN CHECKS PASS");
    expect(() => held({ checks: "failing" }).ship.hold(1, { verb: "merge", sha: "abc1234" })).toThrow("checks failing");
    expect(() => held().ship.hold(1, { verb: "auto", sha: "abc1234" })).toThrow("MERGE it now");
    expect(() => held({ checks: "none" }).ship.hold(1, { verb: "merge", sha: "abc1234" })).toThrow("merges only by its own button");
    expect(held({ checks: "pending" }).ship.hold(1, { verb: "auto", sha: "abc1234" })).toEqual({ until: 1_005_000 });
  });

  test("SEND BACK's hold needs a note, and a merge's needs the head the page showed", () => {
    const { ship, id } = held({ checks: "failing" });
    expect(() => ship.hold(id, { verb: "back", sha: "" })).toThrow("say why it goes back");
    expect(() => ship.hold(id, { verb: "merge", sha: "" })).toThrow("no head commit");
    expect(() => ship.hold(id, { verb: "launch" as any, sha: "abc1234" })).toThrow("merge, auto or back");
    ship.hold(id, { verb: "back", sha: "", note: "the token is hunter2-value" });
    expect(ship.openItem(id)!.hold).toMatchObject({ verb: "back", note: "the token is [secret PW]" });
  });

  test("the earliest hold is the next one due; a PR that leaves SHIP takes its hold with it", () => {
    const { ship, clock, id } = held();
    clock.t += 1000;
    const other = ship.file({ url: "https://github.com/acme/web/pull/13", floor: "hq", filer: null }).item;
    ship.applyFacts(new Map([["acme/web#13", facts()]]));
    ship.hold(other.id, { verb: "merge", sha: "abc1234" });
    clock.t += 1000;
    ship.hold(id, { verb: "merge", sha: "abc1234" });
    expect(ship.nextHold()).toBe(1_001_000 + 5000);
    ship.applyFacts(new Map([["acme/web#13", facts({ state: "CLOSED" })]]));
    expect(ship.nextHold()).toBe(1_002_000 + 5000);
    expect(ship.undo(other.id)).toEqual({ undone: false, why: "it was closed on GitHub" });
  });

  test("a PR found merged on GitHub while a merge was held counts as the owner's, and its filer is told", () => {
    const { ship, id } = held();
    ship.hold(id, { verb: "merge", sha: "abc1234" });
    const { ended } = ship.applyFacts(new Map([["acme/web#12", facts({ state: "MERGED" })]]));
    expect(ended.map((e) => [e.how, e.asked])).toEqual([["merged", true]]);
    expect(ship.view().done).toMatchObject([{ id, how: "merged" }]);
  });
});

describe("DONE", () => {
  test("the last 24 h of merges and SEND BACKs, newest first, saying how each left; a closed PR is not in it", () => {
    const { ship, clock } = book();
    const n = (k: number) => ship.file({ url: `https://github.com/acme/web/pull/${k}`, floor: k === 4 ? "ops" : "hq", lane: "fixer", filer: "fixer" }).item.id;
    const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(n);
    ship.applyFacts(new Map([1, 2, 3, 4, 5].map((k) => [`acme/web#${k}`, facts({ title: `PR ${k} hunter2-value` })])));
    ship.markMerged(a);
    clock.t += 60_000;
    ship.applyFacts(new Map([["acme/web#2", facts({ state: "MERGED", title: "PR 2" })], ["acme/web#5", facts({ state: "CLOSED" })]]));
    clock.t += 60_000;
    ship.sendBack(c, "add a test for hunter2-value");
    clock.t += 60_000;
    ship.markMerged(d);
    expect(ship.view().done).toEqual([
      { id: d, floor: "ops", repo: "acme/web", number: 4, url: "https://github.com/acme/web/pull/4", lane: "fixer", title: "PR 4 [secret PW]", how: "merged", at: 1_180_000, note: null },
      { id: c, floor: "hq", repo: "acme/web", number: 3, url: "https://github.com/acme/web/pull/3", lane: "fixer", title: "PR 3 [secret PW]", how: "back", at: 1_120_000, note: "add a test for [secret PW]" },
      { id: b, floor: "hq", repo: "acme/web", number: 2, url: "https://github.com/acme/web/pull/2", lane: "fixer", title: "PR 2", how: "self", at: 1_060_000, note: null },
      { id: a, floor: "hq", repo: "acme/web", number: 1, url: "https://github.com/acme/web/pull/1", lane: "fixer", title: "PR 1 [secret PW]", how: "merged", at: 1_000_000, note: null },
    ]);
    expect(ship.view().done.map((x) => x.id)).not.toContain(e);
    clock.t = 1_000_000 + 24 * 3_600_000 + 1;
    expect(ship.view().done.map((x) => x.id)).toEqual([d, c, b]);
    ship.file({ url: "https://github.com/acme/web/pull/4", floor: "hq", filer: null });
    expect(ship.view().done.map((x) => x.id)).toEqual([c, b]);
  });

  test("a PR that left before it was ever read has no title", () => {
    const { ship } = book();
    const { item } = ship.file({ url: URL, floor: "hq", filer: null });
    ship.sendBack(item.id, "wrong repo");
    expect(ship.view().done).toMatchObject([{ id: item.id, title: null, how: "back", note: "wrong repo" }]);
  });
});

describe("what gh says when it will not merge, in the owner's words", () => {
  test("the refusals he meets are plain words; anything else keeps GitHub's own line", async () => {
    const { MOVED, refusalWords } = await import("../../src/server/ship-gh.ts");
    expect(refusalWords("GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)")).toBe(MOVED);
    expect(MOVED).toBe("Not merged: new commits came in while it waited here, and a merge only takes what this page showed you.");
    expect(refusalWords("GraphQL: Pull Request has merge conflicts (mergePullRequest)")).toContain("conflicts with its base branch");
    expect(refusalWords("GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)")).toContain("approving review");
    expect(refusalWords("GraphQL: 2 of 2 required status checks are expected. (mergePullRequest)")).toContain("checks the branch requires");
    expect(refusalWords("GraphQL: Base branch policy prohibits the merge (mergePullRequest)")).toContain("branch's rules");
    expect(refusalWords("GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)")).toContain("does not allow auto-merge");
    expect(refusalWords("gh took over 30 s")).toBe("Not merged: GitHub said: gh took over 30 s");
  });
});
