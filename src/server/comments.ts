// COMMENTS: a thread on a brief or a room's HTML page, the way viewers comment on a Claude artifact. The thread is
// keyed by the page: briefs/ID (a floor's brief, markdown or a page), rooms/SLUG/brief (a room's brief that is a page)
// or rooms/SLUG/files/NAME (a page on a room's shelf). The owner writes on the page, optionally quoting a passage; each
// comment is typed into the page's author: the agent named in the brief's by (a lane), else the floor's HQ; for a
// room's page, the room's owner. A lane gets it the way room messages go (DELIVERED, or AWAY · KEPT and sent once when
// herdr sees it again); an HQ through its outbox (hq-link.ts). Authors answer from the CLI (hud brief reply, hud page
// reply); an answer shows in the thread, marks the brief's row in BRIEFS (S.comments) and puts one line in MESSAGES.
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { bump, listeners } from "./push.ts";
import { addStatePart } from "./state.ts";
import { promptAgent } from "./herdr.ts";
import { notifyHq } from "./hq-link.ts";
import { floorOr, hqOf, isHqAgent } from "./floors.ts";
import { postUpdate } from "./updates.ts";
import { away } from "./rooms.ts";
import { HTML_EXT } from "./pages.ts";

const MAX_TEXT = 20_000, MAX_QUOTE = 2_000, SHOWN = 300;

type Row = { id: number; page: string; at: number; author: string | null; to_agent: string | null; text: string; quote: string | null; reply_to: number | null; delivery: string | null; delivered_at: number | null; error: string | null; read_at: number | null; floor: string | null };
// A page that takes comments. to: the lane its comments go to, or "hq" for its floor's HQ. link: where the page opens
// it. read and reply: the CLI that reads the thread and answers in it.
// what: the page, as a prompt names it.
type Page = { key: string; kind: "brief" | "page"; title: string; what: string; floor: string; to: string; link: string; read: string; reply: string };

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const isHq = (name: string) => name.toLowerCase() === "hq";
const SLUG = "([a-z0-9][a-z0-9-]{0,47})";
const firstWords = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// The agent a brief's comments go to: the lane that posted it, else (an HQ posted it, or the lane is not registered)
// the floor's HQ.
function authorOf(by: string) {
  if (!by || isHq(by) || isHqAgent(by)) return "hq";
  return db.query("SELECT 1 FROM lanes WHERE name = ?").get(by) ? by : "hq";
}

// A page's key from what the page or the CLI gives: the key itself, or the page's address (#brief/ID, #page/KEY, a
// whole URL with either).
export function pageOf(raw: unknown): Page {
  let key = str(raw).replace(/^.*?#/, "#").replace(/^#page\//, "").replace(/^#brief\//, "briefs/").replace(/^\/+/, "");
  const brief = key.match(/^briefs\/(\d{1,9})$/);
  if (brief) {
    const b = db.query("SELECT id, floor, by, title FROM briefs WHERE id = ?").get(Number(brief[1])) as { id: number; floor: string; by: string; title: string } | null;
    if (!b) throw new Error(`no brief #${brief[1]}`);
    return { key: `briefs/${b.id}`, kind: "brief", title: b.title, what: `brief #${b.id} ("${b.title}")`, floor: floorOr(b.floor), to: authorOf(b.by), link: `#brief/${b.id}`, read: `hud brief comments ${b.id}`, reply: `hud brief reply ${b.id}` };
  }
  const m = key.match(new RegExp(`^rooms/${SLUG}/(brief|files/([^/]+))$`));
  if (!m) throw new Error(`not a page with comments: ${str(raw) || "(none)"}. A page is briefs/ID, rooms/SLUG/brief or rooms/SLUG/files/NAME.html`);
  const r = db.query("SELECT slug, title, owner, floor FROM rooms WHERE slug = ?").get(m[1]) as { slug: string; title: string; owner: string; floor: string | null } | null;
  if (!r) throw new Error(`no room ${m[1]}`);
  let name = "";
  if (m[3]) {
    try { name = decodeURIComponent(m[3]); } catch { name = m[3]; }
    if (!HTML_EXT.test(name) || name.startsWith(".") || /[\\\0]/.test(name)) throw new Error(`not a page: ${name} (a page on a room's shelf is a .html file)`);
  }
  key = name ? `rooms/${r.slug}/files/${name}` : `rooms/${r.slug}/brief`;
  const title = name ? `${name} in room ${r.slug}` : `the brief of room ${r.slug}`;
  const link = name ? `#page/rooms/${r.slug}/files/${encodeURIComponent(name)}` : `#page/rooms/${r.slug}/brief`;
  return { key, kind: "page", title, what: name ? `the page ${title}` : title, floor: floorOr(r.floor), to: isHq(r.owner) ? "hq" : r.owner, link, read: `hud page comments ${key}`, reply: `hud page reply ${key}` };
}
const nameOf = (p: Page) => (p.to === "hq" ? hqOf(p.floor) : p.to);

function replyTarget(p: Page, reply: unknown) {
  if (reply == null || reply === "") return null;
  const id = Number(reply);
  if (!db.query("SELECT 1 FROM page_comments WHERE page = ? AND id = ?").get(p.key, id)) throw new Error(`no comment #${reply} on ${p.key}`);
  return id;
}
function textOf(v: unknown, empty: string) {
  const text = String(v ?? "").trim();
  if (!text) throw new Error(empty);
  if (text.length > MAX_TEXT) throw new Error(`a comment is at most ${MAX_TEXT.toLocaleString("en")} characters`);
  return text;
}

// ---- writes ----

// The owner comments from the page; quote is the passage selected in the brief, if any.
export function ownerComment(body: any) {
  const p = pageOf(body.page);
  const text = textOf(body.text, "write a comment first");
  const quote = str(body.quote).slice(0, MAX_QUOTE) || null;
  const res = db.query("INSERT INTO page_comments (page, at, to_agent, text, quote, reply_to, delivery, floor) VALUES (?, ?, ?, ?, ?, ?, 'sending', ?)").run(p.key, Date.now(), p.to, text, quote, replyTarget(p, body.reply), p.floor);
  const id = Number(res.lastInsertRowid);
  deliver(id);
  return { id, to: nameOf(p) };
}

// An author answers (hud brief reply, hud page reply): the calling agent, --as, else the page's author.
export function authorReply(body: any, agent: string | null) {
  const p = pageOf(body.page);
  const text = textOf(body.text, `answer something: ${p.reply} TEXT`);
  const who = str(body.as) || agent || nameOf(p);
  const res = db.query("INSERT INTO page_comments (page, at, author, text, reply_to, floor) VALUES (?, ?, ?, ?, ?, ?)").run(p.key, Date.now(), who, text, replyTarget(p, body.reply), p.floor);
  postUpdate({ title: `${who} answered on ${p.kind === "brief" ? `brief: ${p.title}` : p.title}`, body: `${firstWords(text, 200)}\n\n[Open the comments](${p.link})` }, p.floor);
  return { id: Number(res.lastInsertRowid), page: p.key };
}

// The owner has seen the thread: its answers are read.
export function seen(page: unknown) {
  const p = pageOf(page);
  db.query("UPDATE page_comments SET read_at = ? WHERE page = ? AND author IS NOT NULL AND read_at IS NULL").run(Date.now(), p.key);
}

// Try a comment that did not reach its lane again (the page's RETRY).
export function retry(id: number) {
  const c = db.query("SELECT * FROM page_comments WHERE id = ? AND author IS NULL").get(id) as Row | null;
  if (!c) throw new Error(`no comment #${id} from ${OWNER}`);
  if (c.delivery !== "failed") return;
  db.query("UPDATE page_comments SET delivery = 'sending', error = NULL WHERE id = ?").run(id);
  deliver(id);
}

// ---- delivery ----

export function promptText(p: Page, c: Row, late: boolean) {
  const lane = nameOf(p);
  const parent = c.reply_to ? (db.query("SELECT author, text FROM page_comments WHERE id = ?").get(c.reply_to) as { author: string | null; text: string } | null) : null;
  const head = [
    `HUD comment on ${p.what}: ${OWNER} commented`,
    late ? ` at ${hhmm(c.at)} while you were away` : "",
    parent ? `, replying to ${parent.author ? (parent.author === lane ? "your" : `${parent.author}'s`) : "their own"} comment #${c.reply_to} ("${firstWords(parent.text)}")` : "",
    ` (comment #${c.id}):`,
  ].join("");
  const quote = c.quote ? `${c.quote.split("\n").map((l) => `> ${l}`).join("\n")}\n` : "";
  return `${head}\n${quote}${c.text}\nAnswer in the thread, not only here: ${p.reply} "<your answer>" --reply ${c.id}. The whole thread: ${p.read}. ${OWNER} reads the comments on the page, not this terminal.`;
}

function deliver(id: number) {
  const c = db.query("SELECT * FROM page_comments WHERE id = ?").get(id) as Row | null;
  if (!c || !c.to_agent) return;
  const set = (delivery: string, error: string | null = null) =>
    db.query("UPDATE page_comments SET delivery = ?, error = ?, delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END WHERE id = ?").run(delivery, error, delivery, Date.now(), id);
  let p: Page;
  try { p = pageOf(c.page); } catch (e) { set("failed", (e as Error).message.slice(0, 200)); return; }
  // An HQ: through its outbox, which holds it while HQ cannot take it and sends it once it can.
  if (c.to_agent === "hq") {
    set("hq");
    notifyHq(promptText(p, c, false), `comment:${c.id}`, p.floor);
    return;
  }
  if (away(c.to_agent)) {
    if (c.delivery !== "away") set("away");
    return;
  }
  const late = c.delivery === "away";
  if (late) set("sending");
  const machine = (db.query("SELECT machine FROM lanes WHERE name = ?").get(c.to_agent) as { machine: string | null } | null)?.machine;
  promptAgent(c.to_agent, promptText(p, c, late), machine).then((res) => {
    if (res.ok) set("sent");
    else set("failed", res.error.slice(0, 200));
    bump();
  });
}

// A comment for an HQ is delivered once the outbox has typed it in (hq_outbox, ref comment:ID).
function settleHq() {
  const rows = db.query("SELECT c.id, o.sent_at, o.error FROM page_comments c JOIN hq_outbox o ON o.ref = 'comment:' || c.id WHERE c.delivery = 'hq'").all() as { id: number; sent_at: number | null; error: string | null }[];
  for (const r of rows) {
    if (r.sent_at) db.query("UPDATE page_comments SET delivery = 'sent', delivered_at = ?, error = NULL WHERE id = ?").run(r.sent_at, r.id);
    else db.query("UPDATE page_comments SET error = ? WHERE id = ?").run(r.error?.slice(0, 200) ?? null, r.id);
  }
}

// A lane that was away is back when herdr sees it again: its kept comments go to it then, once each. Checked after
// every change of the state (as rooms.ts does), never on a timer of its own.
let checkQueued = false;
listeners.add(() => {
  if (checkQueued) return;
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    const back = db.query("SELECT c.id FROM page_comments c JOIN lanes l ON l.name = c.to_agent WHERE c.delivery = 'away' AND l.herdr IS NOT NULL AND l.herdr != 'gone' ORDER BY c.id").all() as { id: number }[];
    for (const { id } of back) deliver(id);
    if (back.length) bump();
  });
});

// ---- reads ----

const comment = (c: Row) => ({ id: c.id, at: c.at, who: c.author ?? "owner", to: c.to_agent === "hq" ? hqOf(c.floor) : c.to_agent, text: c.text, quote: c.quote, reply: c.reply_to, delivery: c.author ? null : c.delivery === "hq" ? "held" : c.delivery, error: c.error, read: !!c.read_at });

// The thread (GET /api/comments?page=KEY, hud brief comments, hud page comments), oldest first; the last 300.
export function thread(raw: unknown) {
  const p = pageOf(raw);
  settleHq();
  const rows = (db.query("SELECT * FROM page_comments WHERE page = ? ORDER BY id DESC LIMIT ?").all(p.key, SHOWN) as Row[]).reverse();
  const total = (db.query("SELECT COUNT(*) AS n FROM page_comments WHERE page = ?").get(p.key) as { n: number }).n;
  return { page: p.key, kind: p.kind, title: p.title, link: p.link, to: nameOf(p), hq: p.to === "hq", away: p.to !== "hq" && away(p.to), reply: p.reply, comments: rows.map(comment), earlier: total - rows.length };
}

// S.comments: per page with comments, how many, how many answers the owner has not seen, and a rev that changes
// whenever the thread does (a new comment, a delivery), so an open thread reads it again only then.
addStatePart("comments", () => {
  settleHq();
  const rows = db.query(`SELECT page, COUNT(*) AS n, MAX(id) AS last, SUM(author IS NOT NULL AND read_at IS NULL) AS unread,
    SUM(delivery = 'sent') AS sent, SUM(delivery = 'away') AS away, SUM(delivery = 'failed') AS failed, SUM(read_at IS NOT NULL) AS seen
    FROM page_comments GROUP BY page`).all() as { page: string; n: number; last: number; unread: number; sent: number; away: number; failed: number; seen: number }[];
  return Object.fromEntries(rows.map((r) => [r.page, { n: r.n, unread: r.unread, rev: `${r.n}.${r.last}.${r.sent}.${r.away}.${r.failed}.${r.seen}` }]));
});
