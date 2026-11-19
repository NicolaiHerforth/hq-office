// SHIP: the PRs agents want the owner to merge, one row per PR ever filed (docs/ship.md). A lane or HQ files a PR,
// GitHub's facts and the sorter's answers are put on it, and it leaves SHIP when it is merged, closed or sent back.
// FROM below is the whole status machine. Filing a PR that has a row opens it again.
//
// A press the owner can still UNDO is a hold on the row (hold_*): it runs once its time has come, and from then on it
// cannot be taken back. DONE is what left by a merge or a SEND BACK in the last 24 hours, with how (ended_how).
//
// createShip runs on a database and a clock, so a test runs it in memory and moves the clock. The server's one
// instance, and everything that reads GitHub, runs the sorter or runs a hold, is in ship-server.ts.
import type { Database } from "bun:sqlite";
import { verdict } from "../client/ship/model.js";

export type Status = "open" | "merged" | "closed" | "sent_back";
export type Urgency = "URGENT" | "NORMAL" | "LOW";
export const URGENCIES: Urgency[] = ["URGENT", "NORMAL", "LOW"];
export type Facts = {
  state: "OPEN" | "MERGED" | "CLOSED"; title: string; branch: string; base: string; sha: string; draft: boolean;
  checks: "passing" | "pending" | "failing" | "none"; review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: string; mergeState: string; additions: number; deletions: number; files: number;
  methods: string[]; autoMergeAllowed: boolean; autoMerge: boolean;
};
// What one read of GitHub says about one PR: its facts, or why it could not be read.
export type Read = Facts | { error: string };
export type SortAnswer = { id: number; domain: string; urgency: Urgency; why: string | null };
// How a PR left SHIP. merged: the owner merged it from the page; self: merged on GitHub (auto-merge finished, or by
// hand there); back: sent back; closed: closed on GitHub without a merge.
export type EndedHow = "merged" | "self" | "back" | "closed";
export type HoldVerb = "merge" | "auto" | "back";
export type Hold = { verb: HoldVerb; until: number; sha: string; note: string | null };
export type Row = {
  id: number; repo: string; number: number; status: Status; floor: string; lane: string | null; filer: string | null;
  note: string | null; urgent_why: string | null; at: number; filed_at: number; domain: string | null; urgency: Urgency | null;
  why: string | null; sorted_at: number | null; gh: string | null; gh_error: string | null; gh_read_at: number | null;
  merge_error: string | null; merge_asked_at: number | null; back_note: string | null; ended_at: number | null; ended_how: EndedHow | null;
  hold_verb: HoldVerb | null; hold_until: number | null; hold_sha: string | null; hold_note: string | null;
};
const NO_HOLD = { hold_verb: null, hold_until: null, hold_sha: null, hold_note: null } satisfies Partial<Row>;
export const HOLD_MS = 5000;
const DONE_MS = 24 * 3_600_000;
export type Item = ReturnType<ReturnType<typeof createShip>["view"]>["items"][number];

// The statuses each change may start from.
const FROM = {
  file: ["open", "merged", "closed", "sent_back"],
  end: ["open"],
  merge: ["open"],
  back: ["open"],
} satisfies Record<string, Status[]>;
type Verb = keyof typeof FROM;

// What each press needs the PR's verdict (model.js) to allow. A group's MERGE N takes only ready PRs; one unchecked PR
// merges alone, after the page asked; MERGE WHEN CHECKS PASS needs checks running. A held press: MERGE on a ready PR,
// MERGE WHEN CHECKS PASS, or SEND BACK, which any PR in SHIP may get (null: no verdict needed).
export const ALLOWS = { group: ["merge"], one: ["merge", "check"], auto: ["auto"] };
const HOLDS: Record<HoldVerb, string[] | null> = { merge: ALLOWS.group, auto: ALLOWS.auto, back: null };
// What the owner is told when the verdict does not allow his press: its next move in his words, else the verdict's why.
const NOT_NOW: Record<string, string> = {
  merge: "its checks have passed: MERGE it now",
  auto: "its checks are still running: MERGE WHEN CHECKS PASS",
  queued: "auto-merge is already on: it merges by itself once its checks pass",
  check: "no checks ran on it: it merges only by its own button",
};
export function notNow(item: { gh: Facts | null; ghError: string | null; mergeError?: string | null }, allows: readonly string[]) {
  const v = verdict(item);
  return allows.includes(v.can) ? null : NOT_NOW[v.can] ?? v.why;
}
// UNDO's answer once there is nothing left to take back: the hold is running, or the PR has left SHIP.
const RUNNING: Record<HoldVerb, string> = {
  merge: "it is merging now: a merge cannot be taken back",
  auto: "auto-merge is being turned on now: turn it off on GitHub if it must not merge",
  back: "it is going back now: the note is on its way",
};
// A hold that was due long before the server came back is not run: the owner pressed it to happen then, not now.
export const LATE: Record<HoldVerb, string> = {
  merge: "Not merged: the HUD was down when this merge was due, so it was not made. MERGE it again if it should still go in.",
  auto: "MERGE WHEN CHECKS PASS was not turned on: the HUD was down when it was due. Press it again if it should.",
  back: "Not sent back: the HUD was down when it was due. SEND it BACK again if it should go.",
};
const GONE: Record<Exclude<Status, "open">, string> = {
  merged: "it is merged already: a merge cannot be taken back",
  closed: "it was closed on GitHub",
  sent_back: "it was sent back already",
};

// A PR's address on GitHub, with whatever follows it (/files, #discussion, ?query). Owner and name are kept to the
// characters GitHub allows, so they can go into a query as they are.
const PR = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?![\d])/;
export type Pr = { repo: string; number: number; url: string };
const pr = (owner: string, name: string, n: string): Pr => {
  const repo = `${owner}/${name}`.toLowerCase();
  return { repo, number: Number(n), url: `https://github.com/${repo}/pull/${Number(n)}` };
};
export function parsePr(url: unknown): Pr | null {
  const m = String(url ?? "").trim().match(new RegExp(`^${PR.source}(?:[/?#].*)?$`));
  return m ? pr(m[1], m[2], m[3]) : null;
}
// Every PR a text links to, once each, in order.
export function prLinks(text: string): Pr[] {
  const seen = new Map<string, Pr>();
  for (const m of text.matchAll(new RegExp(PR.source, "g"))) {
    const p = pr(m[1], m[2], m[3]);
    seen.set(keyOf(p), seen.get(keyOf(p)) ?? p);
  }
  return [...seen.values()];
}
export const keyOf = (p: { repo: string; number: number }) => `${p.repo}#${p.number}`;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const given = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
};

export function createShip(deps: { db: Database; now?: () => number; mask?: (s: string) => string; sampler?: boolean; holdMs?: number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const holdMs = deps.holdMs ?? HOLD_MS;
  const mask = deps.mask ?? ((s: string) => s);

  const row = (id: number) => db.query("SELECT * FROM ship WHERE id = ?").get(id) as Row | null;
  const byPr = (p: Pr) => db.query("SELECT * FROM ship WHERE repo = ? AND number = ?").get(p.repo, p.number) as Row | null;
  const openRows = () => db.query("SELECT * FROM ship WHERE status = 'open' ORDER BY at, id").all() as Row[];
  function set(id: number, fields: Partial<Row>) {
    const cols = Object.keys(fields) as (keyof Row)[];
    db.query(`UPDATE ship SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => (fields[c] ?? null) as any), id);
  }
  function pick(id: unknown, verb: Verb): Row {
    const r = /^\d+$/.test(String(id ?? "")) ? row(Number(id)) : null;
    if (!r) throw new Error(`no PR #${String(id ?? "")} in MERGE`);
    if (!(FROM[verb] as Status[]).includes(r.status)) throw new Error(`${keyOf(r)} is ${r.status.replace("_", " ")}, no longer in MERGE`);
    return r;
  }
  const facts = (r: Row) => (r.gh ? (JSON.parse(r.gh) as Facts) : null);

  // What the page and the server get (docs/ship.md). The filer's --urgent makes it URGENT whatever the sorter said.
  const shape = (r: Row) => ({
    id: r.id, floor: r.floor, repo: r.repo, number: r.number, url: `https://github.com/${r.repo}/pull/${r.number}`,
    lane: r.lane, filer: r.filer, note: r.note === null ? null : mask(r.note), at: r.at, domain: r.domain,
    urgency: (r.urgent_why ? "URGENT" : r.urgency ?? "NORMAL") as Urgency,
    why: r.urgent_why ? mask(r.urgent_why) : r.urgency === "URGENT" ? r.why : null,
    sorted: r.sorted_at !== null, gh: facts(r), ghError: r.gh_error, mergeError: r.merge_error,
    hold: r.hold_verb ? { verb: r.hold_verb, until: r.hold_until!, note: r.hold_note === null ? null : mask(r.hold_note) } : null,
  });
  // DONE's entry: how it left and when; the owner's note for a SEND BACK.
  const doneShape = (r: Row) => ({
    id: r.id, floor: r.floor, repo: r.repo, number: r.number, url: `https://github.com/${r.repo}/pull/${r.number}`, lane: r.lane,
    title: facts(r)?.title ? mask(facts(r)!.title) : null, how: r.ended_how as Exclude<EndedHow, "closed">, at: r.ended_at!,
    note: r.ended_how === "back" && r.back_note !== null ? mask(r.back_note) : null,
  });

  // hud ship (and an ask that asks for a merge). The same PR again updates its item: a flag left out keeps its value
  // while the item is open; an item that had left SHIP comes back as new, to be read and sorted again.
  function file(o: { url: unknown; floor: string; lane?: unknown; filer: string | null; note?: unknown; urgent?: unknown }) {
    const p = parsePr(o.url);
    if (!p) throw new Error(`not a GitHub PR link: ${String(o.url ?? "").slice(0, 200) || "none given"} (it looks like https://github.com/OWNER/REPO/pull/N)`);
    const t = now();
    const lane = given(o.lane);
    const note = given(o.note) && mask(given(o.note)!);
    const urgent = given(o.urgent) && mask(oneLine(given(o.urgent)!));
    const old = byPr(p);
    if (!old) {
      const { lastInsertRowid } = db.query("INSERT INTO ship (repo, number, status, floor, lane, filer, note, urgent_why, at, filed_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)")
        .run(p.repo, p.number, o.floor, lane, o.filer, note, urgent, t, t);
      return { item: shape(row(Number(lastInsertRowid))!), updated: false };
    }
    pick(old.id, "file");
    // updated: it was in SHIP already. One that had left comes back as filed.
    if (old.status === "open") set(old.id, { floor: o.floor, lane: lane ?? old.lane, filer: o.filer, note: note ?? old.note, urgent_why: urgent ?? old.urgent_why, filed_at: t });
    else set(old.id, {
      status: "open", floor: o.floor, lane, filer: o.filer, note, urgent_why: urgent, at: t, filed_at: t, domain: null, urgency: null, why: null, sorted_at: null,
      gh: null, gh_error: null, gh_read_at: null, merge_error: null, merge_asked_at: null, back_note: null, ended_at: null, ended_how: null, ...NO_HOLD,
    });
    return { item: shape(row(old.id)!), updated: old.status === "open" };
  }

  // One read of GitHub for open items, keyed by repo#number. A PR merged or closed there leaves SHIP, with any hold on
  // it; what left is returned, with whether the owner had asked for the merge (MERGE WHEN CHECKS PASS that GitHub
  // finished, or a held MERGE whose run was cut off after gh merged it), and how many rows the read changed.
  function applyFacts(reads: Map<string, Read>) {
    const t = now();
    const ended: { item: ReturnType<typeof shape>; how: "merged" | "closed"; asked: boolean }[] = [];
    let changed = 0;
    for (const r of openRows()) {
      const got = reads.get(keyOf(r));
      if (!got) continue;
      // A read that says what the row already says writes nothing: a poll of a quiet SHIP costs no write and no push.
      if ("error" in got) {
        if (r.gh_error !== got.error) {
          set(r.id, { gh_error: got.error, gh_read_at: t });
          changed += 1;
        }
        continue;
      }
      const gh = JSON.stringify({ ...got, title: mask(got.title) });
      if (got.state === "OPEN") {
        if (gh === r.gh && r.gh_error === null) continue;
        // A new head is a new PR to judge: why the last merge failed was about the old one.
        const moved = facts(r)?.sha !== got.sha;
        set(r.id, { gh, gh_error: null, gh_read_at: t, ...(moved ? { merge_error: null } : {}) });
        changed += 1;
        continue;
      }
      pick(r.id, "end");
      const how = got.state === "MERGED" ? "merged" : "closed";
      set(r.id, { status: how, gh, gh_error: null, gh_read_at: t, ended_at: t, ended_how: how === "closed" ? "closed" : r.hold_verb === "merge" ? "merged" : "self", ...NO_HOLD });
      changed += 1;
      ended.push({ item: shape(row(r.id)!), how, asked: r.merge_asked_at !== null || r.hold_verb === "merge" || r.hold_verb === "auto" });
    }
    return { ended, changed };
  }

  // The sorter's answers, for items still open and not yet sorted.
  function applySort(answers: SortAnswer[]) {
    const t = now();
    let n = 0;
    for (const a of answers) {
      const r = row(a.id);
      if (!r || r.status !== "open" || r.sorted_at !== null) continue;
      set(r.id, { domain: a.domain, urgency: a.urgency, why: a.urgency === "URGENT" ? a.why : null, sorted_at: t });
      n += 1;
    }
    return n;
  }

  // The owner's: SEND BACK with a note, a merge done, a merge that failed, MERGE WHEN CHECKS PASS set.
  const BACK_NOTE = "say why it goes back: the note goes to whoever filed it";
  function sendBack(id: unknown, note: unknown) {
    const r = pick(id, "back");
    const words = given(note);
    if (!words) throw new Error(BACK_NOTE);
    set(r.id, { status: "sent_back", back_note: mask(words), ended_at: now(), ended_how: "back", ...NO_HOLD });
    return shape(row(r.id)!);
  }
  // What gh answered is recorded whatever the row says by then: a read during the merge may have found it merged on
  // GitHub and taken it for GitHub's own. Rows are never deleted. null: the read already counted it as the owner's (a
  // held MERGE), and told the filer.
  function markMerged(id: number) {
    const r = row(id)!;
    if (r.status === "merged" && r.ended_how === "merged") return null;
    const f = facts(r);
    set(r.id, { status: "merged", merge_error: null, merge_asked_at: now(), ended_at: r.ended_at ?? now(), ended_how: "merged", ...NO_HOLD, ...(f ? { gh: JSON.stringify({ ...f, state: "MERGED" }) } : {}) });
    return shape(row(r.id)!);
  }
  function autoAsked(id: number) {
    const r = row(id)!;
    const f = facts(r);
    set(r.id, { merge_error: null, merge_asked_at: now(), ...(f && r.status === "open" ? { gh: JSON.stringify({ ...f, autoMerge: true }) } : {}) });
  }
  // Only an item still in SHIP shows why its merge failed.
  function setMergeError(id: number, error: string) {
    if (row(id)?.status === "open") set(id, { merge_error: mask(error) });
  }

  // UNDO's hold: one press on one PR, run by the server once its time has come (holdMs after the press). The same
  // press again answers the same time, so a reloaded page pressing again does not double it; another press waits
  // until the first is undone or has run.
  function hold(id: unknown, o: { verb: unknown; sha?: unknown; note?: unknown }) {
    const r = pick(id, "merge");
    const verb = o.verb as HoldVerb;
    if (!Object.hasOwn(HOLDS, String(verb))) throw new Error("say what to hold: merge, auto or back");
    if (r.hold_verb === verb) return { until: r.hold_until! };
    if (r.hold_verb) throw new Error(`${keyOf(r)} is held to ${r.hold_verb === "back" ? "go back" : r.hold_verb === "auto" ? "merge when its checks pass" : "merge"} already: UNDO it first`);
    const sha = given(o.sha);
    const note = given(o.note);
    const allows = HOLDS[verb];
    if (!allows) {
      if (!note) throw new Error(BACK_NOTE);
    } else {
      if (!sha) throw new Error("the page sent no head commit: look again");
      const no = notNow(shape(r), allows);
      if (no) throw new Error(no);
    }
    const until = now() + holdMs;
    set(r.id, { hold_verb: verb, hold_until: until, hold_sha: verb === "back" ? null : sha, hold_note: verb === "back" ? mask(note!) : null });
    return { until };
  }
  function undo(id: unknown) {
    const r = /^\d+$/.test(String(id ?? "")) ? row(Number(id)) : null;
    if (!r) throw new Error(`no PR #${String(id ?? "")} in MERGE`);
    if (r.status !== "open") return { undone: false as const, why: GONE[r.status] };
    if (!r.hold_verb) return { undone: false as const, why: "nothing to undo: it was not held" };
    if (now() >= r.hold_until!) return { undone: false as const, why: RUNNING[r.hold_verb] };
    set(r.id, NO_HOLD);
    return { undone: true as const };
  }
  const holdOf = (r: Row): Hold & { id: number } => ({ id: r.id, verb: r.hold_verb!, until: r.hold_until!, sha: r.hold_sha ?? "", note: r.hold_note });
  // The holds whose time has come, earliest first; and when the next one is due (null: none, so no timer).
  const dueHolds = () => (db.query("SELECT * FROM ship WHERE status = 'open' AND hold_verb IS NOT NULL AND hold_until <= ? ORDER BY hold_until, id").all(now()) as Row[]).map(holdOf);
  const nextHold = () => (db.query("SELECT MIN(hold_until) AS t FROM ship WHERE status = 'open' AND hold_verb IS NOT NULL").get() as { t: number | null }).t;
  // A hold that has run, and left the PR in SHIP (refused, or auto-merge turned on).
  function clearHold(id: number) {
    const r = row(id);
    if (r?.hold_verb) set(id, NO_HOLD);
  }

  // An item that is in SHIP now, or null.
  const openItem = (id: number) => {
    const r = row(id);
    return r && r.status === "open" ? shape(r) : null;
  };
  const openItems = () => openRows().map(shape);
  const hasOpen = () => !!db.query("SELECT 1 FROM ship WHERE status = 'open' LIMIT 1").get();
  // The labels the sorter has used, most recently used first, so it reuses them.
  const domainsInUse = () => (db.query("SELECT domain FROM ship WHERE domain IS NOT NULL GROUP BY domain ORDER BY MAX(sorted_at) DESC LIMIT 60").all() as { domain: string }[]).map((r) => r.domain);

  const done = () => (db.query("SELECT * FROM ship WHERE ended_how IN ('merged', 'self', 'back') AND ended_at >= ? ORDER BY ended_at DESC, id DESC").all(now() - DONE_MS) as Row[]).map(doneShape);
  const view = () => ({ sampler: !!deps.sampler, items: openRows().map(shape), done: done() });

  return { file, applyFacts, applySort, sendBack, markMerged, autoAsked, setMergeError, hold, undo, dueHolds, nextHold, clearHold, openItem, openItems, hasOpen, domainsInUse, view };
}
