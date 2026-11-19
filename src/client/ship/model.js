// MERGE (the tab; "ship" inside the code), the part with no page in it: whose move a PR is and why, the groups and
// their order, the tab's counts, who is idle until a merge, what is stuck. Pure functions of S.ship's items
// (docs/ship.md), so the page, the server's merge guard and the tests agree.

export const METHODS = ["squash", "merge", "rebase"];
export const URGENCIES = ["URGENT", "NORMAL", "LOW"];

// Every PR is on one pile, named by whose move it is:
//   ready: its checks passed and nothing stops it. It merges with its group's button, or by one press with UNDO.
//   check: it can merge, but no checks ran on it. It merges only by its own button, which asks first; never in a group.
//   wait:  someone else has the next move (the agent, a reviewer, the checks, GitHub). No merge button.
// can: merge | check | auto (checks running; MERGE WHEN CHECKS PASS) | queued (auto-merge is on) | no.
// why: the short words that stand where a button would be. tone: ok (green), wait (amber), bad (red: the PR itself has
// to change), "" (neutral). move: who has the next move: owner, lane (whoever filed it), review (a reviewer on
// GitHub), checks, github, or null when nobody can tell.
const wait = (can, why, tone, move) => ({ can, pile: "wait", why, tone, move });
// Every fact the verdict reads, the values GitHub can give it (ship-gh.ts), and its name in the owner's words. A fact
// left out or not among them makes the PR nobody's move but GitHub's: no merge is allowed on a guess.
const FACTS = {
  state: [["OPEN", "MERGED", "CLOSED"], "whether it is open"],
  draft: [[true, false], "whether it is a draft"],
  autoMerge: [[true, false], "whether auto-merge is on"],
  autoMergeAllowed: [[true, false], "whether the repo allows auto-merge"],
  checks: [["passing", "pending", "failing", "none"], "its checks"],
  review: [["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null], "its review"],
  mergeable: [["MERGEABLE", "CONFLICTING", "UNKNOWN"], "whether it can merge"],
  mergeState: [["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"], "whether anything blocks it"],
};
const unclear = (g) => {
  const field = Object.keys(FACTS).find((k) => !FACTS[k][0].includes(g[k]));
  if (field) return FACTS[field][1];
  return Array.isArray(g.methods) ? null : "the repo's merge methods";
};
export function verdict(item) {
  const g = item.gh;
  if (!g) return wait("no", item.ghError ? "GitHub could not be read" : "not read from GitHub yet", "", "github");
  const what = unclear(g);
  if (what) return wait("no", `unclear from GitHub: ${what}`, "", "github");
  if (g.state === "MERGED") return wait("no", "already merged", "", null);
  if (g.state === "CLOSED") return wait("no", "closed on GitHub", "", null);
  if (g.autoMerge) return wait("queued", "merges by itself", "ok", "checks");
  if (g.draft || g.mergeState === "DRAFT") return wait("no", "draft", "", "lane");
  if (g.mergeable === "CONFLICTING" || g.mergeState === "DIRTY") return wait("no", `conflicts with ${g.base || "its base"}`, "bad", "lane");
  if (g.review === "CHANGES_REQUESTED") return wait("no", "changes requested", "bad", "lane");
  if (g.checks === "failing") return wait("no", "checks failing", "bad", "lane");
  if (!methodOf(item)) return wait("no", "the repo allows no merge method", "", null);
  if (g.checks === "pending") return wait(g.autoMergeAllowed ? "auto" : "no", "checks running", "wait", "checks");
  if (g.mergeState === "BEHIND") return wait("no", `behind ${g.base || "its base"}`, "wait", "lane");
  if (g.mergeState === "BLOCKED") return g.review === "REVIEW_REQUIRED" ? wait("no", "needs a review", "wait", "review") : wait("no", "blocked by branch rules", "wait", null);
  if (g.mergeable === "UNKNOWN" || g.mergeState === "UNKNOWN") return wait("no", "GitHub is still checking", "", "github");
  const open = g.state === "OPEN" && g.mergeable === "MERGEABLE";
  if (open && g.checks === "none") return { can: "check", pile: "check", why: "no checks ran", tone: "wait", move: "owner" };
  if (open && g.checks === "passing") return { can: "merge", pile: "ready", why: "", tone: "ok", move: "owner" };
  // Not reached by any fact above; a value added to FACTS without a rule of its own lands here, not on a merge.
  return wait("no", `unclear from GitHub: ${FACTS.mergeable[1]}`, "", "github");
}
export const pileOf = (item) => verdict(item).pile;
export const ready = (item) => pileOf(item) === "ready";

// The repo's allowed method, squash before merge before rebase.
export const methodOf = (item) => METHODS.find((m) => item.gh?.methods?.includes(m)) ?? null;

// What a group is called: the sorter's domain, else the repo's name (the fallback, and what shows before sorting).
export const domainOf = (item) => item.domain || String(item.repo ?? "").split("/").pop() || "other";

// Ready, then to check, then not ready; inside each, the longest waiting first.
const PILE = { ready: 0, check: 1, wait: 2 };
const order = (a, b) => PILE[pileOf(a)] - PILE[pileOf(b)] || a.at - b.at || a.id - b.id;

// In the order of the work: URGENT (what cannot wait), a group per domain by name and LOW (what goes by the group),
// CHECK THESE YOURSELF (what takes thought). URGENT and CHECK hold PRs decided one at a time: one: true, each row has
// its own button, and the group has none. An urgent PR with no checks stays in URGENT. Each: { key, label, one, items }.
export function groups(items) {
  const urgent = [], check = [], low = [], byDomain = new Map();
  for (const it of items) {
    if (it.urgency === "URGENT") urgent.push(it);
    else if (pileOf(it) === "check") check.push(it);
    else if (it.urgency === "LOW") low.push(it);
    else {
      const d = domainOf(it);
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(it);
    }
  }
  const out = [];
  if (urgent.length) out.push({ key: "urgent", label: "URGENT", one: true, items: urgent.sort(order) });
  for (const d of [...byDomain.keys()].sort((a, b) => a.localeCompare(b))) out.push({ key: `d:${d}`, label: d, one: false, items: byDomain.get(d).sort(order) });
  if (low.length) out.push({ key: "low", label: "LOW PRIORITY", one: false, items: low.sort(order) });
  if (check.length) out.push({ key: "check", label: "CHECK THESE YOURSELF", one: true, items: check.sort(order) });
  return out;
}

// The tab's counts and the top line: ready, to check yourself, and the urgent ones the owner can still act on (one
// with auto-merge on merges by itself).
export function counts(items) {
  const c = { ready: 0, check: 0, wait: 0, urgent: 0 };
  for (const it of items) {
    const v = verdict(it);
    c[v.pile] += 1;
    if (it.urgency === "URGENT" && v.can !== "queued") c.urgent += 1;
  }
  return c;
}

// Idle until you merge: the PR's lane is on the page and not working, at a prompt or gone, and the PR is the owner's
// move (ready, or his to check).
const BUSY = new Set(["moving", "blocked", "gone"]);
const laneOf = (name, lanes) => (lanes ?? []).find((x) => x.name === name);
export const laneIdle = (name, lanes) => {
  const l = name ? laneOf(name, lanes) : null;
  return !!l && !BUSY.has(l.status);
};
export const idleOn = (item, lanes) => (pileOf(item) !== "wait" && laneIdle(item.lane, lanes) ? item.lane : null);
// Every lane idle until the owner merges, with how many of its PRs are his move: most first, then by name.
export function idle(items, lanes) {
  const n = new Map();
  for (const it of items) {
    const l = idleOn(it, lanes);
    if (l) n.set(l, (n.get(l) ?? 0) + 1);
  }
  return [...n].map(([lane, count]) => ({ lane, count })).sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane));
}

// Stuck, nobody moving: not his move, and whoever has it is not moving either. "lane": the lane with the next move is
// idle (as above); "review": it needs an approving review, which the page cannot see under way and which in a
// one-owner outfit is usually his. null for the rest: his move, moving by itself (checks, GitHub), or nobody can tell.
export function stuckOn(item, lanes) {
  const v = verdict(item);
  if (v.pile !== "wait") return null;
  if (v.move === "review") return "review";
  return v.move === "lane" && laneIdle(item.lane, lanes) ? "lane" : null;
}
// Every idle lane with the next move on PRs, with how many (most first, then by name), and how many need a review.
export function stuck(items, lanes) {
  const n = new Map();
  let review = 0;
  for (const it of items) {
    const s = stuckOn(it, lanes);
    if (s === "review") review += 1;
    else if (s === "lane") n.set(it.lane, (n.get(it.lane) ?? 0) + 1);
  }
  return { lanes: [...n].map(([lane, count]) => ({ lane, count })).sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane)), review };
}
