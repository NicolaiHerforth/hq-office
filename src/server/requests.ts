// REQUESTS: what the owner asked for, each one tracked from the moment it arrives until it is delivered. A request is
// his words with an id and a status. Every owner note files one, HQ sorts and moves it (hud work ...), and nothing is
// ever deleted: a closed request leaves every list but stays in the table. FROM below is the whole status machine.
// Fewer, truer rows beat a complete log: an acknowledgement files closed, a repeat is attached to the request it
// repeats, and a delivered request closes itself once the owner has seen it.
//
// createRequests runs on a database and a clock, so a test runs it in memory and moves the clock. The server's one
// instance is in owner-requests.ts.
import type { Database } from "bun:sqlite";

export type Status = "new" | "open" | "assigned" | "waiting" | "delivered" | "withdrawn" | "closed";
export type Source = "note" | "answer" | "hand" | "import";
export type Row = {
  id: number; floor: string; at: number; words: string; source: Source; ref: string | null; status: Status;
  lane: string | null; issue: string | null; pr: string | null; ask: number | null; link: string | null; line: string | null;
  moved_at: number; moved: string | null; seen_at: number | null; closed_at: number | null; closed_why: string | null;
};
export type Move = { id: number; request: number; at: number; by: string; kind: string; text: string };
// Who runs a command: its name in the history, and the one floor it may touch (null: every floor, --all).
export type Actor = { by: string; floor: string | null };

// A delivered or withdrawn request closes itself this long after the owner first saw it, and in any case this long
// after it was delivered.
export const SEEN_CLOSE_MS = 24 * 3600_000;
export const KEEP_MS = 7 * 24 * 3600_000;

const LIVE: Status[] = ["new", "open", "assigned", "waiting"];
// The statuses each command may start from.
const FROM = {
  assign: LIVE,
  wait: LIVE,
  move: LIVE,
  deliver: LIVE,
  withdraw: LIVE,
  attach: ["new"],
  drop: ["new"],
  reopen: ["delivered", "withdrawn"],
  close: [...LIVE, "delivered", "withdrawn"],
} satisfies Record<string, Status[]>;
type Verb = keyof typeof FROM;
const INSTEAD: Partial<Record<Verb, string>> = {
  attach: "; a sorted request is given up with hud work withdraw ID WHY",
  drop: "; a sorted request is given up with hud work withdraw ID WHY",
  reopen: "; only a delivered or withdrawn request is reopened",
};

// A note that is only an acknowledgement makes no row: at most 24 characters and one of these, in any case, with
// trailing punctuation or emoji. "ok do it now" is a request, and so is "ok?": a question wants an answer.
const ACK_WORDS = new Set(["ok", "okay", "thanks", "thank you", "ty", "nice", "great", "perfect", "cool", "got it", "sounds good", "yes", "no"]);
const ACK_MARKS = ["👍", "✅"];
const TRAILING = /[\s.,!;:)\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]+$/u;
export function isAcknowledgement(text: string) {
  const t = text.trim();
  if (!t || [...t].length > 24) return false;
  const words = t.toLowerCase().replace(TRAILING, "");
  return words ? ACK_WORDS.has(words) : ACK_MARKS.some((m) => t.includes(m));
}

// What HQ is told with a note: the request it filed and how to sort it. Nothing for one filed closed.
export const sortHint = (r: { id: number; status: Status }) =>
  r.status === "new" ? ` (request #${r.id}: sort it with hud work assign ${r.id} LANE | attach ${r.id} OTHER | drop ${r.id} WHY)` : "";

const chars = (s: string) => [...s];
// One line, cut to n characters. Only what is shown or typed is cut: stored text never is, since hud secret redact
// replaces a whole value and a cut could keep part of one.
export const oneLine = (s: string, n = Infinity) => {
  const t = s.replace(/\s+/g, " ").trim();
  return chars(t).length > n ? `${chars(t).slice(0, n - 1).join("")}…` : t;
};
const age = (ms: number) => (ms < 60_000 ? "now" : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);
const ago = (ms: number) => (ms < 60_000 ? "just now" : `${age(ms)} ago`);
const orList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}` : xs[0]);
const prText = (pr: string) => (/^\d+$/.test(pr) ? `PR #${pr}` : pr);
const ownerOf = (r: Row) => [r.lane, r.issue, r.pr && prText(r.pr)].filter(Boolean).join(", ");
const said = (v: unknown, what: string) => {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(what);
  return s;
};

// What the page and hud get: the contract's field names.
const shape = (r: Row) => ({
  id: r.id, floor: r.floor, at: r.at, words: r.words, source: r.source, ref: r.ref, status: r.status, lane: r.lane, issue: r.issue,
  pr: r.pr, ask: r.ask, link: r.link, line: r.line, movedAt: r.moved_at, moved: r.moved, seenAt: r.seen_at,
});

export function createRequests(deps: { db: Database; now?: () => number; firstFloor?: () => string }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  const row = (id: number) => db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null;
  const logMove = (request: number, by: string, kind: string, text: string, at = now()) =>
    db.query("INSERT INTO request_moves (request, at, by, kind, text) VALUES (?, ?, ?, ?, ?)").run(request, at, by, kind, text);

  function insert(r: Pick<Row, "floor" | "words" | "source" | "status"> & Partial<Row>) {
    const t = now();
    const full = { at: t, ref: null, lane: null, issue: null, pr: null, ask: null, link: null, line: null, moved_at: t, moved: null, seen_at: null, closed_at: null, closed_why: null, ...r };
    const cols = Object.keys(full) as (keyof typeof full)[];
    const { lastInsertRowid } = db.query(`INSERT INTO requests (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => full[c] as any));
    return row(Number(lastInsertRowid))!;
  }

  // The request a command acts on: it exists, is on the actor's floor and is in a status the command starts from.
  function pick(id: unknown, verb: Verb, actor: Actor): Row {
    const r = readable(id, actor);
    if (!(FROM[verb] as Status[]).includes(r.status)) throw new Error(`request #${r.id} is ${r.status}: ${verb} needs ${orList(FROM[verb])}${INSTEAD[verb] ?? ""}`);
    return r;
  }
  function readable(id: unknown, actor: Actor): Row {
    const r = /^\d+$/.test(String(id ?? "")) ? row(Number(id)) : null;
    if (!r) throw new Error(`no request #${String(id ?? "")}`);
    if (actor.floor && r.floor !== actor.floor) throw new Error(`request #${r.id} is on floor ${r.floor}, not yours (${actor.floor}): its HQ moves it, or add --all`);
    return r;
  }

  // One movement: the row's new fields, its last movement, and a line in the history.
  function change(r: Row, set: Partial<Row>, by: string, kind: string, text: string) {
    const t = now();
    const next: Partial<Row> = { ...set, moved_at: t, moved: oneLine(text) };
    const cols = Object.keys(next) as (keyof Row)[];
    db.transaction(() => {
      db.query(`UPDATE requests SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => (next[c] ?? null) as any), r.id);
      logMove(r.id, by, kind, text, t);
    })();
    return row(r.id)!;
  }
  const closing = (why: string): Partial<Row> => ({ status: "closed", closed_at: now(), closed_why: why, ask: null });
  // Where a request goes when it stops waiting or is reopened: back to its lane, else to no owner.
  const back = (r: Row): Status => (r.lane ? "assigned" : "open");

  // ---- how requests are made ----

  // Every owner note. An acknowledgement is filed closed, so it exists but makes no row anywhere.
  function fileNote(o: { floor: string; text: string; note: number }) {
    const ref = `note:${o.note}`;
    if (!isAcknowledgement(o.text)) return insert({ floor: o.floor, words: o.text, source: "note", ref, status: "new" });
    return insert({ floor: o.floor, words: o.text, source: "note", ref, ...closing("acknowledgement"), status: "closed" });
  }

  // By hand (hud work add): the owner told HQ in the terminal, or HQ files work out of a note or an answer (from: n:ID
  // or a:ID, whose time and reference it takes).
  function add(o: { floor: string; text: unknown; from?: unknown }) {
    const words = said(o.text, "say what the owner asked for: hud work add TEXT [--from n:ID|a:ID]");
    let from: Partial<Row> = {};
    if (o.from !== undefined && o.from !== null && o.from !== "") {
      const m = String(o.from).match(/^([na]):(\d+)$/);
      if (!m) throw new Error("--from is a note or an answer: n:ID or a:ID");
      const id = Number(m[2]);
      if (m[1] === "n") {
        const note = db.query("SELECT at FROM notes WHERE id = ?").get(id) as { at: number } | null;
        if (!note) throw new Error(`no note ${id}`);
        from = { source: "note", ref: `note:${id}`, at: note.at };
      } else {
        const ask = db.query("SELECT created_at, answered_at FROM asks WHERE id = ?").get(id) as { created_at: number; answered_at: number | null } | null;
        if (!ask) throw new Error(`no ask ${id}`);
        from = { source: "answer", ref: `ask:${id}`, at: ask.answered_at ?? ask.created_at };
      }
    }
    const r = insert({ floor: o.floor, words, status: "open", source: "hand", ...from });
    return { request: shape(r), line: `request #${r.id} added, open: "${oneLine(words, 60)}". Give it an owner: hud work assign ${r.id} LANE` };
  }

  // ---- HQ's commands ----

  function assign(id: unknown, o: { lane?: unknown; issue?: unknown; pr?: unknown }, actor: Actor) {
    const r = pick(id, "assign", actor);
    const lane = said(o.lane, "name the lane that owns it (or hq): hud work assign ID LANE [--issue X] [--pr N]");
    const issue = String(o.issue ?? "").trim() || r.issue;
    const pr = String(o.pr ?? "").trim().replace(/^#/, "") || r.pr;
    const next = change(r, { status: "assigned", lane, issue, pr, ask: null }, actor.by, "assigned", `assigned to ${ownerOf({ ...r, lane, issue, pr })}`);
    return { request: shape(next), line: `request #${r.id} assigned to ${ownerOf(next)} (was ${r.status})` };
  }

  // ID repeats OTHER: ID closes, and its words become a line in OTHER's history, at the time the owner sent them.
  // Not a movement of OTHER: the owner asking again is not progress.
  function attach(id: unknown, other: unknown, actor: Actor) {
    const r = pick(id, "attach", actor);
    const to = readable(other, actor);
    if (to.id === r.id) throw new Error(`request #${r.id} cannot be attached to itself`);
    if (to.status === "closed") throw new Error(`request #${to.id} is closed: attach to a request that is still open, or sort #${r.id} on its own`);
    // A delivered request closes once seen, and the repeat would close with it: asking again after a delivery is
    // new work.
    if (!LIVE.includes(to.status)) throw new Error(`request #${to.id} is ${to.status}: he asks again after it, so #${r.id} is work of its own (hud work assign ${r.id} LANE)`);
    if (to.floor !== r.floor) throw new Error(`request #${to.id} is on floor ${to.floor}, #${r.id} on ${r.floor}: a repeat is attached on its own floor`);
    db.transaction(() => {
      change(r, closing(`attached to #${to.id}`), actor.by, "closed", `a repeat: attached to #${to.id}`);
      logMove(to.id, "owner", "attached", `${r.words} (request #${r.id}${r.ref ? `, ${r.ref}` : ""})`, r.at);
    })();
    return { request: shape(row(r.id)!), line: `request #${r.id} closed as a repeat: its words are attached to #${to.id}` };
  }

  function drop(id: unknown, why: unknown, actor: Actor) {
    const r = pick(id, "drop", actor);
    const reason = said(why, "say why it is not work: hud work drop ID WHY");
    change(r, closing(`dropped: ${reason}`), actor.by, "closed", `dropped as not work: ${reason}`);
    return { request: shape(row(r.id)!), line: `request #${r.id} dropped as not work: ${reason}` };
  }

  function wait(id: unknown, askId: unknown, actor: Actor) {
    const r = pick(id, "wait", actor);
    const ask = /^\d+$/.test(String(askId ?? "")) ? (db.query("SELECT id, status, floor FROM asks WHERE id = ?").get(Number(askId)) as { id: number; status: string; floor: string | null } | null) : null;
    if (!ask) throw new Error(`no ask ${String(askId ?? "")}: a request waits on an open question (hud ask), hud work wait ID ASK`);
    if (ask.status !== "open") throw new Error(`ask ${ask.id} is ${ask.status}: a request waits on an open question`);
    if (ask.floor && ask.floor !== r.floor) throw new Error(`ask ${ask.id} is on floor ${ask.floor}, request #${r.id} on ${r.floor}`);
    const next = change(r, { status: "waiting", ask: ask.id }, actor.by, "waiting", `waiting on the owner: ask #${ask.id}`);
    return { request: shape(next), line: `request #${r.id} waits on the owner: ask #${ask.id} (was ${r.status})` };
  }

  function move(id: unknown, text: unknown, actor: Actor) {
    const r = pick(id, "move", actor);
    const what = said(text, "say what moved: hud work move ID TEXT");
    const next = change(r, {}, actor.by, "moved", what);
    return { request: shape(next), line: `request #${r.id} moved: ${oneLine(what, 100)}` };
  }

  function deliver(id: unknown, link: unknown, text: unknown, actor: Actor) {
    const r = pick(id, "deliver", actor);
    const usage = "a delivery is a link and one line: hud work deliver ID LINK TEXT";
    const where = said(link, usage);
    const what = said(text, usage);
    const next = change(r, { status: "delivered", link: where, line: what, ask: null, seen_at: null }, actor.by, "delivered", `delivered: ${what} (${where})`);
    return { request: shape(next), line: `request #${r.id} delivered: ${oneLine(what, 100)} (${where}). It closes once the owner has seen it` };
  }

  function withdraw(id: unknown, why: unknown, actor: Actor) {
    const r = pick(id, "withdraw", actor);
    const reason = said(why, "say why you give it up: hud work withdraw ID WHY");
    const next = change(r, { status: "withdrawn", link: null, line: reason, ask: null, seen_at: null }, actor.by, "withdrawn", `withdrawn: ${reason}`);
    return { request: shape(next), line: `request #${r.id} withdrawn: ${oneLine(reason, 100)}. The owner sees the reason, then it closes` };
  }

  // ---- the owner's ----

  // The page drew these delivered or withdrawn requests while the owner could see them. Counted once.
  function seen(ids: unknown) {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      const r = /^\d+$/.test(String(id)) ? row(Number(id)) : null;
      if (!r || r.seen_at || !["delivered", "withdrawn"].includes(r.status)) continue;
      db.query("UPDATE requests SET seen_at = ? WHERE id = ?").run(now(), r.id);
      logMove(r.id, "owner", "seen", `seen by the owner, ${r.status}`);
      n += 1;
    }
    return n;
  }

  function close(id: unknown, why: unknown) {
    const r = pick(id, "close", { by: "owner", floor: null });
    const reason = String(why ?? "").trim();
    change(r, closing(reason || "closed by the owner"), "owner", "closed", reason ? `closed by the owner: ${reason}` : "closed by the owner");
    return shape(row(r.id)!);
  }

  // The owner is not done with a delivered or withdrawn request: back to its lane (or to no owner), with his words.
  function reopen(id: unknown, text: unknown) {
    const r = pick(id, "reopen", { by: "owner", floor: null });
    const words = said(text, "say what is still missing");
    return shape(change(r, { status: back(r), link: null, line: null, seen_at: null }, "owner", "reopened", `reopened: ${words}`));
  }

  // ---- housekeeping ----

  // A waiting request whose question is no longer open goes back to its lane. Called when an ask is answered or
  // withdrawn, and for every ask at each sync, so an ask that closed another way (its items all done) frees it too.
  function askSettled(askId?: number) {
    const rows = db.query(`SELECT r.*, a.id AS ask_id, a.status AS ask_status, a.answer AS ask_answer FROM requests r LEFT JOIN asks a ON a.id = r.ask
      WHERE r.status = 'waiting' AND r.ask IS NOT NULL AND (a.id IS NULL OR a.status != 'open')${askId === undefined ? "" : " AND r.ask = ?"}`).all(...(askId === undefined ? [] : [askId])) as (Row & { ask_id: number | null; ask_status: string | null; ask_answer: string | null })[];
    for (const r of rows) {
      const text = r.ask_id === null ? `ask #${r.ask} is gone` : r.ask_status === "answered" ? `the owner answered #${r.ask}: ${oneLine(r.ask_answer ?? "")}` : `ask #${r.ask} was ${r.ask_status}`;
      change(r, { status: back(r), ask: null }, "hud", "answered", text);
    }
    return rows.length;
  }

  // At each sync: waiting requests whose ask closed, delivered and withdrawn requests whose time is up, and requests
  // on a floor that was removed (they move to the first floor, as that floor's other things do). Returns what changed.
  function housekeep() {
    let n = askSettled();
    const t = now();
    const done = db.query(`SELECT r.*, COALESCE((SELECT MAX(m.at) FROM request_moves m WHERE m.request = r.id AND m.kind IN ('delivered', 'withdrawn', 'imported')), r.moved_at) AS done_at
      FROM requests r WHERE r.status IN ('delivered', 'withdrawn')`).all() as (Row & { done_at: number })[];
    for (const r of done) {
      const why = r.seen_at && t >= r.seen_at + SEEN_CLOSE_MS ? `${r.status} and seen by the owner` : t >= r.done_at + KEEP_MS ? `${r.status} 7 days ago` : null;
      if (!why) continue;
      db.transaction(() => {
        db.query("UPDATE requests SET status = 'closed', closed_at = ?, closed_why = ? WHERE id = ?").run(t, why, r.id);
        logMove(r.id, "hud", "closed", `closed: ${why}`, t);
      })();
      n += 1;
    }
    if (deps.firstFloor) n += db.query("UPDATE requests SET floor = ? WHERE floor NOT IN (SELECT id FROM floors)").run(deps.firstFloor()).changes;
    return n;
  }

  // ---- reading ----

  const view = () => (db.query("SELECT * FROM requests WHERE status != 'closed' ORDER BY at, id").all() as Row[]).map(shape);
  function list(o: { floor: string | null; closed?: boolean }) {
    const where = [o.closed ? "status = 'closed'" : "status != 'closed'", ...(o.floor ? ["floor = ?"] : [])].join(" AND ");
    return (db.query(`SELECT * FROM requests WHERE ${where} ORDER BY ${o.closed ? "closed_at DESC, id DESC LIMIT 200" : "at, id"}`).all(...(o.floor ? [o.floor] : [])) as Row[]).map((r) => ({ ...shape(r), closedAt: r.closed_at, closedWhy: r.closed_why }));
  }
  function show(id: unknown, actor: Actor = { by: "owner", floor: null }) {
    const r = readable(id, actor);
    const moves = db.query("SELECT id, at, by, kind, text FROM request_moves WHERE request = ? ORDER BY at, id").all(r.id) as Omit<Move, "request">[];
    return { request: { ...shape(r), closedAt: r.closed_at, closedWhy: r.closed_why }, moves };
  }
  const byRef = (ref: string) => (db.query("SELECT * FROM requests WHERE ref = ? ORDER BY id").all(ref) as Row[]).map(shape);

  // hud work list: one line per request, with its last movement and how old that is.
  function listText(o: { floor: string | null; closed?: boolean }) {
    const rows = list(o);
    if (!rows.length) return o.closed ? "no closed requests" : "no open requests";
    const t = now();
    return rows.map((r) => {
      const who = [r.lane, r.issue, r.pr && prText(r.pr)].filter(Boolean).join(", ");
      const state = r.status === "waiting" ? `waiting on the owner${r.ask ? ` (ask #${r.ask})` : " (no ask)"}` : r.status === "new" ? "new, to sort" : r.status;
      const last = r.status === "closed" ? `${r.closedWhy ?? "closed"}, ${ago(t - (r.closedAt ?? t))}` : r.moved ? `${oneLine(r.moved, 120)}, ${ago(t - r.movedAt)}` : `nothing yet, ${ago(t - r.at)}`;
      return `#${r.id}${o.floor ? "" : ` [${r.floor}]`} ${state}${who ? ` · ${who}` : ""} · "${oneLine(r.words, 80)}" · ${last}`;
    }).join("\n");
  }
  const stamp = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  function showText(id: unknown, actor: Actor) {
    const { request: r, moves } = show(id, actor);
    const who = [r.lane, r.issue, r.pr && prText(r.pr)].filter(Boolean).join(", ");
    const head = [`#${r.id} ${r.status}${r.status === "closed" && r.closedWhy ? ` (${r.closedWhy})` : ""}`, who, `floor ${r.floor}`, `${r.ref ?? r.source}, ${stamp(r.at)}`, r.ask ? `ask #${r.ask}` : "", r.link ?? ""].filter(Boolean).join(" · ");
    return [head, r.words, ...(moves.length ? moves.map((m) => `  ${stamp(m.at)}  ${m.by}  ${m.kind === "attached" ? "said again: " : ""}${m.text}`) : ["  no movement yet"])].join("\n");
  }

  // The sweep's lines for one floor (hq-sweep.ts): what to sort, what has not moved since `before` (the floor's last
  // sweep; Infinity before the first, so everything), and what waits on the owner. Null where there is nothing.
  // A request waiting with no ask (an imported one) is HQ's to move: the owner has no question to answer.
  function sweepLines(floor: string, before: number, owner = "the owner") {
    const rows = db.query("SELECT * FROM requests WHERE floor = ? AND status IN ('new', 'open', 'assigned', 'waiting') ORDER BY at, id").all(floor) as Row[];
    const t = now();
    const words = (r: Row) => `"${oneLine(r.words, 60)}"`;
    const some = (label: string, items: string[]) => (items.length ? `${label} ${items.length}: ${items.slice(0, 8).join(", ")}${items.length > 8 ? `, +${items.length - 8} more (hud work)` : ""}` : null);
    return {
      sort: some("requests to sort", rows.filter((r) => r.status === "new").map((r) => `#${r.id} ${words(r)}`)),
      unmoved: some("requests with no movement since the last sweep", rows.filter((r) => (r.status === "open" || r.status === "assigned" || (r.status === "waiting" && !r.ask)) && r.moved_at < before).map((r) => `#${r.id} (${r.status === "waiting" ? "waiting with no ask" : r.status}${r.lane ? ` ${r.lane}` : ""}, ${age(t - r.moved_at)}) ${words(r)}`)),
      waiting: some(`waiting on ${owner}`, rows.filter((r) => r.status === "waiting" && r.ask).map((r) => `#${r.id} (ask ${r.ask})`)),
    };
  }

  // ---- import ----

  // hud work import: a markdown table with the columns # | Date | Request | Owner | Status | Next step | Last moved.
  // A row whose # is already a request's ref on the floor is skipped, so importing a file twice adds nothing.
  function importLedger(text: unknown, o: { floor: string; dryRun?: boolean; by: string }) {
    const rows = parseLedger(String(text ?? ""));
    const t = now();
    const have = new Set((db.query("SELECT ref FROM requests WHERE floor = ? AND ref IS NOT NULL").all(o.floor) as { ref: string }[]).map((r) => r.ref));
    const added: string[] = [];
    const skipped: string[] = [];
    const counts = new Map<string, number>();
    const run = db.transaction(() => {
      for (const c of rows) {
        if (have.has(c.id)) { skipped.push(c.id); continue; }
        have.add(c.id);
        const kind = c.status.toUpperCase();
        const status: Status = kind === "ASSIGNED" ? "assigned" : kind.startsWith("WAITING") ? "waiting" : kind === "DELIVERED" ? "delivered" : kind === "DROPPED" ? "closed" : "open";
        const known = status !== "open" || kind === "OPEN";
        const owned = status === "assigned" || status === "waiting";
        const cells = `${c.request} ${c.next}`.replace(/\bask\s+#?\d+/gi, "");
        const asked = status === "waiting" ? Number(c.next.match(/\bask\s+#?(\d+)/i)?.[1] ?? 0) : 0;
        const ask = asked && (db.query("SELECT 1 FROM asks WHERE id = ? AND status = 'open' AND (floor IS NULL OR floor = ?)").get(asked, o.floor)) ? asked : null;
        const set: Partial<Row> = {
          at: Math.min(t, timeOf(c.date, t) ?? t), ref: c.id, lane: owned ? laneOf(c.owner) : null,
          issue: owned ? cells.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] ?? null : null, pr: owned ? cells.match(/#(\d+)/)?.[1] ?? null : null, ask,
          link: status === "delivered" ? c.next.match(/https?:\/\/\S+/)?.[0] ?? null : null, line: status === "delivered" ? c.next || null : null,
          moved_at: Math.min(t, timeOf(c.moved, t) ?? t), moved: oneLine(`imported: next step: ${c.next || "none"}`),
          ...(status === "closed" ? { closed_at: t, closed_why: `dropped (imported)${c.next ? `: ${c.next}` : ""}` } : {}),
        };
        counts.set(status, (counts.get(status) ?? 0) + 1);
        added.push(`${c.id} -> ${status}${set.lane ? ` ${set.lane}` : ""}${set.issue ? `, ${set.issue}` : ""}${set.pr ? `, ${prText(set.pr)}` : ""}${status === "waiting" ? (ask ? `, ask #${ask}` : ", no open ask named") : ""}${known ? "" : ` (status ${c.status || "missing"} not known: filed as open)`}: ${oneLine(c.request, 60)}`);
        if (o.dryRun) continue;
        const r = insert({ floor: o.floor, words: c.request, source: "import", status, ...set });
        logMove(r.id, o.by, "imported", `imported: next step: ${c.next || "none"}`, t);
      }
    });
    run();
    const tally = [...counts].map(([s, n]) => `${n} ${s}`).join(", ");
    const line = `${o.dryRun ? "would import" : "imported"} ${added.length} ${added.length === 1 ? "request" : "requests"} on floor ${o.floor}${tally ? ` (${tally})` : ""}; ${skipped.length} already there${o.dryRun ? "; nothing written" : ""}`;
    return { added, skipped, line };
  }

  return { fileNote, add, assign, attach, drop, wait, move, deliver, withdraw, seen, close, reopen, askSettled, housekeep, view, list, show, byRef, listText, showText, sweepLines, importLedger };
}

type LedgerRow = { id: string; date: string; request: string; owner: string; status: string; next: string; moved: string };
function parseLedger(text: string): LedgerRow[] {
  const table = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|")).map((l) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
  const at = table.findIndex((cells) => cells.includes("#") && cells.some((c) => /^status$/i.test(c)));
  const head = at < 0 ? [] : table[at].map((c) => c.toLowerCase());
  const col = (name: string) => head.findIndex((c) => c === name || c.startsWith(name));
  const cols = { id: col("#"), date: col("date"), request: col("request"), owner: col("owner"), status: col("status"), next: col("next step"), moved: col("last moved") };
  if (at < 0 || cols.request < 0) throw new Error("no ledger table in the file: it needs a markdown table with the columns # | Date | Request | Owner | Status | Next step | Last moved");
  const cell = (cells: string[], i: number) => (i < 0 ? "" : cells[i] ?? "");
  return table.slice(at + 1)
    .filter((cells) => !cells.every((c) => /^:?-*:?$/.test(c)) && cell(cells, cols.id) && cell(cells, cols.id) !== "#" && cell(cells, cols.request))
    .map((cells) => ({ id: cell(cells, cols.id), date: cell(cells, cols.date), request: cell(cells, cols.request), owner: cell(cells, cols.owner), status: cell(cells, cols.status), next: cell(cells, cols.next), moved: cell(cells, cols.moved) }));
}
// An owner cell as a lane: "deploy-window (new lane)" is deploy-window, HQ is hq.
function laneOf(owner: string) {
  const name = owner.replace(/\s*\(.*$/, "").trim();
  return !name || /^[-–—]+$/.test(name) ? null : /^hq$/i.test(name) ? "hq" : name;
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:\\s*(?:to|-|–)\\s*\\d{1,2})?\\s+${MONTH}\\b(?:,?\\s+(\\d{4})\\b)?`, "i");
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\b(?:,?\\s+(\\d{4})\\b)?`, "i");
// A date cell's first day, with its time when it has one: "~4 to 8 Nov" is 4 Nov, "11 Nov 23:00", "Nov 4, 2025",
// "2026-11-04". With no year it is this year's, or last year's when that day is still ahead. Null when it names no day.
function timeOf(cell: string, now: number): number | null {
  const clock = cell.match(/\b(\d{1,2}):(\d{2})\b/);
  const [h, min] = clock ? [Number(clock[1]), Number(clock[2])] : [0, 0];
  const iso = cell.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), h, min).getTime();
  const a = cell.match(DAY_MONTH), b = a ? null : cell.match(MONTH_DAY);
  const [day, month, year] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [];
  if (!day || !month) return null;
  const on = (y: number) => new Date(y, MONTHS.indexOf(month.slice(0, 3).toLowerCase()), Number(day), h, min).getTime();
  if (year) return on(Number(year));
  const thisYear = new Date(now).getFullYear();
  return on(thisYear) > now + 24 * 3600_000 ? on(thisYear - 1) : on(thisYear);
}
