// The ask ledger: HQ edits an open question in place, comments under it, and gives it a checklist whose items
// tick themselves as the PRs they name merge. A question whose items are all done closes itself. The owner can talk a
// question through too: a comment of the owner's to HQ or to the question's lane, which leaves the question open.
//
// None of this goes through answerAsk: HQ's comments and edits are information, and a closed checklist is not an answer
// from the owner, so nothing of those is typed into HQ's session. A checklist closed by a merge waits in hud inbox.
// The owner's comment is the exception: it is saved first, then typed into its recipient.
import { db } from "./db.ts";
import { CONFIG, OWNER } from "./config.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { board } from "./work-board.ts";
import { parsePr } from "./board.ts";
import { checkLink, createAsk, ownerAsk, roomOf } from "./asks.ts";
import { bump } from "./push.ts";
import { notifyHq } from "./hq-link.ts";
import { promptAgent } from "./herdr.ts";
import { away } from "./rooms.ts";
import type { Ask } from "./types.ts";
import { underHq } from "../lane-tree.ts";

type Item = { ask_id: number; n: number; text: string; pr: string | null; done_at: number | null; done_by: string | null };

function openAsk(id: number) {
  const ask = ownerAsk(id);
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
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v: string | null;
    if (f === "options") {
      const opts = (Array.isArray(body.options) ? body.options : [body.options]).map((o: unknown) => String(o).trim()).filter(Boolean);
      v = opts.length ? JSON.stringify(opts) : null;
    } else if (f === "link") v = checkLink(body.link);
    else v = String(body[f]).trim() || null;
    if (f === "title" && !v) throw new Error("title cannot be empty");
    set.push(`${f} = ?`);
    values.push(v);
  }
  // A row from before options were stored trimmed: a new pick is trimmed, so trim its options with it or the pick matches none.
  if (body.recommended !== undefined && body.options === undefined && ask.options) {
    set.push("options = ?");
    values.push(JSON.stringify((JSON.parse(ask.options) as string[]).map((o) => o.trim()).filter(Boolean)));
  }
  // --room SLUG names the room the question is about; --room "" clears it. Moving the question to another lane leaves it.
  if (body.room !== undefined) {
    set.push("room = ?");
    values.push(roomOf(body.room));
  }
  // --lane L moves the question to lane L; --lane hq (or "") takes it off every lane.
  let moved: string | null | undefined;
  if (body.lane !== undefined) {
    moved = underHq(body.lane) ? null : String(body.lane).trim();
    if (moved && !db.query("SELECT 1 FROM lanes WHERE name = ?").get(moved)) throw new Error(`no lane named ${moved}: register it first, or use --lane hq`);
    set.push("lane = ?");
    values.push(moved);
  }
  if (!set.length) throw new Error("nothing to change: give --title, --body, --opt, --rec, --link, --lane or --room");
  db.query(`UPDATE asks SET ${set.join(", ")} WHERE id = ?`).run(...values, id);
  db.query("INSERT INTO ask_edits (ask_id, edited_at) VALUES (?, ?) ON CONFLICT (ask_id) DO UPDATE SET edited_at = excluded.edited_at").run(id, Date.now());
  event("hq", `edited ask #${id} (${set.map((s) => s.split(" ")[0]).join(", ")}): ${body.title ?? ask.title}`, ask.lane);
  if (moved !== undefined && moved !== (ask.lane ?? null)) event("hq", `moved ask #${id} to ${moved ?? "HQ (no lane)"}`, moved ?? ask.lane);
}

// ---- comments ----

// `as` is the lane writing (hud comment ID TEXT --as LANE); without it the comment is HQ's (author NULL).
export function commentAsk(id: number, text: unknown, as?: unknown) {
  openAsk(id);
  const t = String(text ?? "").trim();
  if (!t) throw new Error("a comment needs text");
  const lane = as == null || String(as).trim() === "" ? null : String(as).trim();
  if (lane && !db.query("SELECT 1 FROM lanes WHERE name = ?").get(lane)) throw new Error(`no lane named ${lane}`);
  db.query("INSERT INTO ask_comments (ask_id, at, text, author) VALUES (?, ?, ?, ?)").run(id, Date.now(), t, lane);
}

// ---- the owner talks a question through ----

type Comment = { id: number; ask_id: number; at: number; text: string; author: string | null; to_lane: string | null; delivery: string | null; error: string | null };

// The owner's comment on an open question, to HQ (the default) or to the question's lane. The question stays open. The comment
// is saved first and never lost: to HQ it goes through the outbox (held while HQ is down); to a lane it is typed into the
// lane's pane, and the comment says whether that worked (delivery sent or failed), so the owner can send it again.
export function talkAsk(id: number, body: any) {
  const ask = openAsk(id);
  const text = String(body.text ?? "").trim();
  if (!text) throw new Error("a comment needs text");
  const to = String(body.to ?? "hq").trim();
  const lane = underHq(to) ? null : to;
  if (lane && lane !== ask.lane) throw new Error(ask.lane ? `a comment goes to hq or to ${ask.lane}, the question's lane` : "this question has no lane: a comment goes to hq");
  const res = db
    .query("INSERT INTO ask_comments (ask_id, at, text, author, to_lane, delivery) VALUES (?, ?, ?, 'owner', ?, ?)")
    .run(id, Date.now(), text, lane, lane ? "sending" : null);
  const cid = Number(res.lastInsertRowid);
  event(OWNER, `commented on "${ask.title}" to ${lane ?? "HQ"}: ${text}`, ask.lane);
  deliver(cid);
  return { id: cid };
}

// Types a comment into its lane again after it failed.
export function resendComment(id: number, cid: number) {
  openAsk(id);
  const c = db.query("SELECT * FROM ask_comments WHERE id = ? AND ask_id = ?").get(cid, id) as Comment | null;
  if (!c) throw new Error(`ask ${id} has no comment ${cid}`);
  if (c.delivery !== "failed") throw new Error(`comment ${cid} was not a failed delivery`);
  db.query("UPDATE ask_comments SET delivery = 'sending', error = NULL WHERE id = ?").run(cid);
  deliver(cid);
}

function deliver(cid: number) {
  const c = db.query("SELECT * FROM ask_comments WHERE id = ?").get(cid) as Comment;
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(c.ask_id) as Ask;
  const where = ask.lane ? ` (${ask.lane})` : "";
  if (!c.to_lane) {
    notifyHq(`HUD comment on #${ask.id}${where}: "${ask.title}" -- ${OWNER} wrote: ${c.text}\nThe question stays open. Reply under it: hud comment ${ask.id} "<your reply>"`, `comment:${cid}`);
    return;
  }
  const settle = (delivery: "sent" | "failed", error: string | null = null) => {
    db.query("UPDATE ask_comments SET delivery = ?, error = ? WHERE id = ?").run(delivery, error, cid);
    bump();
  };
  if (away(c.to_lane)) return settle("failed", `${c.to_lane} is not running in herdr`);
  const machine = (db.query("SELECT machine FROM lanes WHERE name = ?").get(c.to_lane) as { machine: string | null }).machine;
  const text = `HUD question #${ask.id} ("${ask.title}"): ${OWNER} commented to you: ${c.text}\nThe question stays open. Reply under it: hud comment ${ask.id} "<your reply>" --as ${c.to_lane}; ${OWNER} reads the page, not this terminal.`;
  promptAgent(c.to_lane, text, machine).then((r) => (r.ok ? settle("sent") : settle("failed", r.error.slice(0, 200))));
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
  const out: Record<number, { editedAt: number | null; items: any[]; comments: any[] }> = {};
  const entry = (id: number) => (out[id] ??= { editedAt: null, items: [], comments: [] });
  const OPEN = "SELECT id FROM asks WHERE status = 'open'";
  for (const e of db.query(`SELECT * FROM ask_edits WHERE ask_id IN (${OPEN})`).all() as { ask_id: number; edited_at: number }[]) entry(e.ask_id).editedAt = e.edited_at;
  for (const i of db.query(`SELECT * FROM ask_items WHERE ask_id IN (${OPEN}) ORDER BY ask_id, n`).all() as Item[]) {
    const ref = i.pr ? parsePr(i.pr, CONFIG.githubRepo) : null;
    entry(i.ask_id).items.push({ n: i.n, text: i.text, done: !!i.done_at, by: i.done_by, pr: ref ? { number: ref.number, repo: ref.repo } : null });
  }
  // author: null is HQ, "owner" is the owner, else a lane. to: who the comment was addressed to (null: HQ).
  for (const c of db.query(`SELECT * FROM ask_comments WHERE ask_id IN (${OPEN}) ORDER BY at, id`).all() as Comment[])
    entry(c.ask_id).comments.push({ id: c.id, at: c.at, text: c.text, author: c.author, to: c.to_lane, delivery: c.delivery, error: c.error });
  return out;
}
addStatePart("ledger", ledgerView);

// hud ask ... --item T: the question and its checklist in one write.
export function createAskWithItems(body: any) {
  const items = (Array.isArray(body.items) ? body.items : []).map((t: unknown) => String(t ?? "").trim()).filter(Boolean);
  const id = createAsk(body);
  if (items.length) addItems(id, items);
  return id;
}
