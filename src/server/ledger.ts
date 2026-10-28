// The ask ledger: HQ edits an open question in place, comments under it, and gives it a checklist whose items
// tick themselves as the PRs they name merge. A question whose items are all done closes itself.
//
// None of this goes through answerAsk: comments and edits are information, and a closed checklist is not an answer
// from the owner, so nothing here is typed into HQ's session. A checklist closed by a merge waits in hud inbox.
import { db } from "./db.ts";
import { CONFIG } from "./config.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { board } from "./work-board.ts";
import { parsePr } from "./board.ts";
import { createAsk, optionsOf, resolveRec } from "./asks.ts";
import type { Ask } from "./types.ts";
import { underHq } from "../lane-tree.ts";

type Item = { ask_id: number; n: number; text: string; pr: string | null; done_at: number | null; done_by: string | null };

function openAsk(id: number) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  return ask;
}

// The board's key for the first PR the text names: a pull request URL, owner/repo#N or #N.
export function prOf(text: string) {
  const m = text.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|(?:[\w.-]+\/[\w.-]+)?#\d+/);
  return m ? (parsePr(m[0], CONFIG.githubRepo)?.key ?? null) : null;
}

const merged = (pr: string | null) => !!pr && board.fact(pr)?.state === "MERGED";

// ---- edit in place ----

const FIELDS = ["title", "body", "options", "recommended", "link"] as const;

export function updateAsk(id: number, body: any) {
  const ask = openAsk(id);
  const set: string[] = [];
  const values: (string | null)[] = [];
  const newOpts = body.options === undefined ? null : optionsOf(body.options);
  const opts: string[] = newOpts ?? (ask.options ? JSON.parse(ask.options) : []);
  // New options must still hold the recommendation, or come with a new one: a stale HQ PICK would mark nothing.
  if (newOpts && body.recommended === undefined && ask.recommended && !opts.includes(ask.recommended))
    throw new Error(`the recommendation "${ask.recommended}" is not one of the new options: give --rec with them`);
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v: string | null;
    if (f === "options") v = opts.length ? JSON.stringify(opts) : null;
    else if (f === "recommended") v = resolveRec(body.recommended, opts);
    else v = String(body[f]).trim() || null;
    if (f === "title" && !v) throw new Error("title cannot be empty");
    set.push(`${f} = ?`);
    values.push(v);
  }
  // --lane L moves the question to lane L; --lane hq (or "") takes it off every lane.
  let moved: string | null | undefined;
  if (body.lane !== undefined) {
    moved = underHq(body.lane) ? null : String(body.lane).trim();
    if (moved && !db.query("SELECT 1 FROM lanes WHERE name = ?").get(moved)) throw new Error(`no lane named ${moved}: register it first, or use --lane hq`);
    set.push("lane = ?");
    values.push(moved);
    // A question moved to a lane goes to that lane's floor; taken off its lane, it stays where it is.
    const floor = moved ? (db.query("SELECT floor FROM lanes WHERE name = ?").get(moved) as { floor: string | null }).floor : null;
    if (floor) {
      set.push("floor = ?");
      values.push(floor);
    }
  }
  if (!set.length) throw new Error("nothing to change: give --title, --body, --opt, --rec, --link or --lane");
  db.query(`UPDATE asks SET ${set.join(", ")} WHERE id = ?`).run(...values, id);
  db.query("INSERT INTO ask_edits (ask_id, edited_at) VALUES (?, ?) ON CONFLICT (ask_id) DO UPDATE SET edited_at = excluded.edited_at").run(id, Date.now());
  event("hq", `edited ask #${id} (${set.map((s) => s.split(" ")[0]).filter((f) => f !== "floor").join(", ")}): ${body.title ?? ask.title}`, ask.lane);
  if (moved !== undefined && moved !== (ask.lane ?? null)) event("hq", `moved ask #${id} to ${moved ?? "HQ (no lane)"}`, moved ?? ask.lane);
}

// ---- comments ----

export function commentAsk(id: number, text: unknown) {
  openAsk(id);
  const t = String(text ?? "").trim();
  if (!t) throw new Error("a comment needs text");
  db.query("INSERT INTO ask_comments (ask_id, at, text) VALUES (?, ?, ?)").run(id, Date.now(), t);
}

// ---- checklist ----

export function addItems(id: number, texts: unknown[]) {
  openAsk(id);
  const list = texts.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!list.length) throw new Error("an item needs text");
  let n = (db.query("SELECT COALESCE(MAX(n), 0) AS n FROM ask_items WHERE ask_id = ?").get(id) as { n: number }).n;
  let doneNow = false;
  for (const text of list) {
    const pr = prOf(text);
    // A PR the board already knows is merged is ticked at once.
    const done = merged(pr);
    doneNow ||= done;
    db.query("INSERT INTO ask_items (ask_id, n, text, pr, done_at, done_by) VALUES (?, ?, ?, ?, ?, ?)").run(id, ++n, text, pr, done ? Date.now() : null, done ? "github" : null);
  }
  if (doneNow) closeIfDone(id, "github");
  // A PR nobody tracked starts the board's own poll; nothing is fetched here.
  board.syncTimer();
  return n;
}

export function tickItem(id: number, n: number, done: boolean) {
  openAsk(id);
  const it = db.query("SELECT * FROM ask_items WHERE ask_id = ? AND n = ?").get(id, n) as Item | null;
  if (!it) throw new Error(`ask ${id} has no item ${n}`);
  db.query("UPDATE ask_items SET done_at = ?, done_by = ? WHERE ask_id = ? AND n = ?").run(done ? Date.now() : null, done ? "hq" : null, id, n);
  if (done) closeIfDone(id, "hq");
  board.syncTimer();
}

// Every item done: the question closes itself, without the answer path. Closed by HQ's own tick, it is already
// acked; closed by a merge, it waits in hud inbox (but is never typed into HQ's session).
function closeIfDone(id: number, by: "hq" | "github") {
  const items = db.query("SELECT done_at FROM ask_items WHERE ask_id = ?").all(id) as Item[];
  if (!items.length || items.some((i) => !i.done_at)) return;
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask;
  const now = Date.now();
  const res = db.query("UPDATE asks SET status = 'answered', answer = 'all done', answered_at = ?, acked_at = ? WHERE id = ? AND status = 'open'").run(now, by === "hq" ? now : null, id);
  if (res.changes) event(by === "hq" ? "hq" : "board", `closed "${ask.title}": all ${items.length} items done${by === "github" ? " (last one merged)" : ""}`, ask.lane);
}

// The board refreshes these with the work items' PRs, only while their question is open and the item not done.
function followed() {
  return (db.query("SELECT DISTINCT i.pr FROM ask_items i JOIN asks a ON a.id = i.ask_id WHERE a.status = 'open' AND i.done_at IS NULL AND i.pr IS NOT NULL").all() as { pr: string }[]).map((r) => r.pr);
}

// New facts from GitHub: tick every open item whose PR has merged, then close what that finished.
function onFacts() {
  const open = db.query("SELECT i.* FROM ask_items i JOIN asks a ON a.id = i.ask_id WHERE a.status = 'open' AND i.done_at IS NULL AND i.pr IS NOT NULL").all() as Item[];
  const touched = new Set<number>();
  for (const it of open) {
    if (!merged(it.pr)) continue;
    db.query("UPDATE ask_items SET done_at = ?, done_by = 'github' WHERE ask_id = ? AND n = ?").run(Date.now(), it.ask_id, it.n);
    touched.add(it.ask_id);
  }
  for (const id of touched) closeIfDone(id, "github");
}

board.follow(followed);
board.onFacts(onFacts);

// ---- the page's part: S.ledger[askId] for open asks that have any of it ----

export function ledgerView() {
  const out: Record<number, { editedAt: number | null; items: any[]; comments: { at: number; text: string }[] }> = {};
  const entry = (id: number) => (out[id] ??= { editedAt: null, items: [], comments: [] });
  const OPEN = "SELECT id FROM asks WHERE status = 'open'";
  for (const e of db.query(`SELECT * FROM ask_edits WHERE ask_id IN (${OPEN})`).all() as { ask_id: number; edited_at: number }[]) entry(e.ask_id).editedAt = e.edited_at;
  for (const i of db.query(`SELECT * FROM ask_items WHERE ask_id IN (${OPEN}) ORDER BY ask_id, n`).all() as Item[]) {
    const ref = i.pr ? parsePr(i.pr, CONFIG.githubRepo) : null;
    entry(i.ask_id).items.push({ n: i.n, text: i.text, done: !!i.done_at, by: i.done_by, pr: ref ? { number: ref.number, repo: ref.repo } : null });
  }
  for (const c of db.query(`SELECT ask_id, at, text FROM ask_comments WHERE ask_id IN (${OPEN}) ORDER BY at, id`).all() as { ask_id: number; at: number; text: string }[]) entry(c.ask_id).comments.push({ at: c.at, text: c.text });
  return out;
}
addStatePart("ledger", ledgerView);

// hud ask ... --item T: the question and its checklist in one write.
export function createAskWithItems(body: any, callerFloor?: string) {
  const items = (Array.isArray(body.items) ? body.items : []).map((t: unknown) => String(t ?? "").trim()).filter(Boolean);
  const id = createAsk(body, callerFloor);
  if (items.length) addItems(id, items);
  return id;
}
