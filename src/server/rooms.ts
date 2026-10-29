// Conference rooms: one place per piece of work where the owner talks straight to the lane that owns it, or to any
// lane in it. A room has an owning lane, member lanes, linked work (issue keys and PRs), a pinned brief (replaced as
// a whole), a shelf of artifacts and a thread. The owner's messages are typed into the lane they are addressed to;
// one for a lane that is away is kept and typed in when herdr sees the lane again. Nothing in a thread is ever lost.
import { CONFIG, OWNER } from "./config.ts";
import { db } from "./db.ts";
import { bump, listeners } from "./push.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { parsePr } from "./board.ts";
import { promptAgent } from "./herdr.ts";
import { notifyHq } from "./hq-link.ts";
import { floorOr, hqOf, laneFloor } from "./floors.ts";
import { ensureFolder, reconcileRoom, removeItem, roomDir, saveFile, startFolders, unwatchRoom, watchRoom, writeBrief, writeShelf } from "./room-folder.ts";
import { refusal, safeName } from "./attachments.ts";

export const MAX_ROOM_FILE = 25 * 1024 * 1024;
const KINDS = ["claude-artifact", "link", "image", "file"];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)(\?|#|$)/i;
const THREAD_SHOWN = 300;

type Room = { slug: string; title: string; owner: string; brief: string | null; brief_at: number | null; brief_by: string | null; created_at: number; rev: number; archived_at: number | null; floor: string | null };
type Msg = { id: number; slug: string; at: number; author: string | null; to_lane: string | null; text: string; reply_to: number | null; delivery: string | null; delivered_at: number | null; error: string | null; read_at: number | null };

const str = (v: unknown) => (v == null ? "" : String(v).trim());
const list = (v: unknown) => (v == null ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean));
const isHq = (name: string) => name.toLowerCase() === "hq";

export function slugOf(v: unknown) {
  const slug = str(v).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug)) throw new Error("a room's slug is 1 to 48 lowercase letters, digits and dashes, such as ope-12-auth");
  return slug;
}
const room = (slug: string) => db.query("SELECT * FROM rooms WHERE slug = ?").get(slug) as Room | null;
function mustRoom(v: unknown) {
  const r = room(slugOf(v));
  if (!r) throw new Error(`no room ${str(v)}: hud room create ${str(v)} --title T --owner LANE`);
  return r;
}
const members = (slug: string) => (db.query("SELECT lane FROM room_members WHERE slug = ? ORDER BY added_at, lane").all(slug) as { lane: string }[]).map((r) => r.lane);
const inRoom = (r: Room, lane: string) => lane === r.owner || members(r.slug).includes(lane) || isHq(lane);
// A lane a room names is registered (hud lane NAME), or HQ itself.
function mustLane(name: string) {
  if (isHq(name)) return "hq";
  if (!db.query("SELECT 1 FROM lanes WHERE name = ?").get(name)) throw new Error(`no lane named ${name}: register it first with hud lane ${name}`);
  return name;
}
function touch(slug: string) {
  db.query("UPDATE rooms SET rev = rev + 1 WHERE slug = ?").run(slug);
}

// ---- writes ----

// Create a room, or change one: a new title or owner, more members and more linked work. It also reopens an
// archived room. A lane that stops owning the room stays in it as a member. A room is on its owning lane's floor; one
// HQ owns is on the caller's floor (and stays where it is when changed).
// A slug from a title the owner typed on the page: lowercase words joined by dashes, and the next free one
// (-2, -3...) when a room, open or archived, already has it.
function freeSlug(title: string) {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44).replace(/-+$/, "");
  if (!base) throw new Error("give the room a title with letters or digits");
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!room(slug)) return slug;
  }
}

// HQ (hud room create) names the slug and may reopen a room by it. The owner on the page (by: "owner") gives a title:
// the room is always a new one, HQ hears of it, and an optional first message (text) goes to the owning lane.
export function createRoom(body: any, callerFloor?: string) {
  const byOwner = body.by === "owner";
  if (byOwner && !str(body.title)) throw new Error("give the room a title");
  if (byOwner && !str(body.owner)) throw new Error("pick the lane that owns the room");
  const slug = byOwner && !str(body.slug) ? freeSlug(str(body.title)) : slugOf(body.slug);
  const before = room(slug);
  const title = str(body.title) || before?.title;
  if (!title) throw new Error("a title is required (--title T)");
  const ownerName = str(body.owner) || before?.owner;
  if (!ownerName) throw new Error("an owning lane is required (--owner LANE)");
  const owner = mustLane(ownerName);
  const add = list(body.members).map(mustLane).filter((l) => l !== owner);
  if (before && before.owner !== owner) add.push(before.owner);
  const issues = list(body.issues ?? body.issue).map((s) => s.toUpperCase());
  const prs = list(body.prs ?? body.pr).map((raw) => {
    const ref = parsePr(raw, CONFIG.githubRepo);
    if (!ref) throw new Error(`not a PR: ${raw}`);
    return ref.key;
  });
  const floor = (isHq(owner) ? null : laneFloor(owner)) ?? before?.floor ?? floorOr(callerFloor);
  const now = Date.now();
  db.transaction(() => {
    if (before) db.query("UPDATE rooms SET title = ?, owner = ?, archived_at = NULL, floor = ? WHERE slug = ?").run(title, owner, floor, slug);
    else db.query("INSERT INTO rooms (slug, title, owner, created_at, floor) VALUES (?, ?, ?, ?, ?)").run(slug, title, owner, now, floor);
    db.query("DELETE FROM room_members WHERE slug = ? AND lane = ?").run(slug, owner);
    for (const lane of add) db.query("INSERT OR IGNORE INTO room_members (slug, lane, added_at) VALUES (?, ?, ?)").run(slug, lane, now);
    for (const ref of issues) db.query("INSERT OR IGNORE INTO room_links (slug, kind, ref) VALUES (?, 'issue', ?)").run(slug, ref);
    for (const ref of prs) db.query("INSERT OR IGNORE INTO room_links (slug, kind, ref) VALUES (?, 'pr', ?)").run(slug, ref);
    touch(slug);
  })();
  // The room's folder: made with the room, watched while it is open.
  ensureFolder(slug);
  if (!before) { writeShelf(slug); writeBrief(slug); }
  if (before?.archived_at) reconcileRoom(slug);
  watchRoom(slug);
  if (!before) event(byOwner ? OWNER : "hq", `opened room ${slug}: ${title}`, isHq(owner) ? null : owner, floor);
  else if (before.archived_at) event("hq", `reopened room ${slug}`, isHq(owner) ? null : owner, floor);
  if (byOwner && !before) {
    const others = add.length ? `, with ${add.join(", ")}` : "";
    notifyHq(`HUD: ${OWNER} opened room ${slug} (${title}) on the page; ${isHq(owner) ? "you own it" : `${owner} owns it`}${others}. It is on the ROOMS tab; hud room read ${slug} shows it.`, undefined, floor);
    if (str(body.text)) ownerPost(slug, { text: body.text });
  }
  return { slug, created: !before, folder: roomDir(slug) };
}

export function setBrief(slugRaw: unknown, body: any) {
  const r = mustRoom(slugRaw);
  const text = String(body.body ?? "").replace(/\s+$/, "");
  // An empty brief clears the room's brief, so it has to be asked for: a client that sends nothing never wipes it.
  if (!text.trim() && body.clear !== true) throw new Error("the brief is empty: send clear: true to clear it (hud room brief SLUG --clear)");
  if (text.length > 100_000) throw new Error("the brief is over 100,000 characters");
  const by = str(body.as) || r.owner;
  db.query("UPDATE rooms SET brief = ?, brief_at = ?, brief_by = ? WHERE slug = ?").run(text || null, Date.now(), by, r.slug);
  touch(r.slug);
  writeBrief(r.slug);
}

export function kindOf(url: string, kind?: unknown) {
  const k = str(kind).toLowerCase();
  if (k) {
    if (!KINDS.includes(k)) throw new Error(`kind is one of ${KINDS.join(", ")}`);
    return k;
  }
  let u: URL | null = null;
  try { u = new URL(url, "http://local"); } catch {}
  if (u && (/(^|\.)claude\.ai$/.test(u.hostname) && /\/artifacts?\//.test(u.pathname) || /(^|\.)claude\.site$/.test(u.hostname))) return "claude-artifact";
  if (IMAGE.test(url)) return "image";
  return url.startsWith("/room-files/") || url.startsWith("/rooms/") ? "file" : "link";
}

function addArtifact(r: Room, a: { title: string; url: string; kind: string; by: string; path?: string | null }) {
  const res = db.query("INSERT INTO room_artifacts (slug, at, by, kind, title, url, path) VALUES (?, ?, ?, ?, ?, ?, ?)").run(r.slug, Date.now(), a.by, a.kind, a.title, a.url, a.path ?? null);
  touch(r.slug);
  writeShelf(r.slug);
  return Number(res.lastInsertRowid);
}

// A link on the shelf: a Claude artifact, a page, an image somewhere else.
export function addLink(slugRaw: unknown, body: any) {
  const r = mustRoom(slugRaw);
  const title = str(body.title);
  if (!title) throw new Error("a title is required (--title T)");
  const url = str(body.url);
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error("the url must start with http:// or https://");
  return { id: addArtifact(r, { title, url, kind: kindOf(url, body.kind), by: str(body.as) || r.owner }) };
}

// A file on the shelf, uploaded as raw bytes: it lands in the room's files/ under its own name (see room-folder.ts).
// ?name= ?title= ?kind= ?as= describe it; as=owner is the owner, from the page.
export async function addFile(slugRaw: unknown, req: Request, url: URL) {
  const r = mustRoom(slugRaw);
  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) throw new Error("the file is empty");
  if (bytes.byteLength > MAX_ROOM_FILE) throw new Error("the file is over 25 MB");
  const given = str(url.searchParams.get("name")) || "file";
  // Attached to a message in the send box (?attach=1): only the kinds and sizes any attachment may have.
  const why = url.searchParams.get("attach") ? refusal(safeName(given), bytes.byteLength) : "";
  if (why) throw new Error(why);
  const kind = str(url.searchParams.get("kind")) ? kindOf("", url.searchParams.get("kind")) : undefined;
  const out = await saveFile(r.slug, given, bytes, { title: str(url.searchParams.get("title")), kind, by: str(url.searchParams.get("as")) || r.owner });
  return { id: out.id, url: out.url, path: out.path, name: out.name, kind: out.kind };
}

export function removeArtifact(slugRaw: unknown, id: number) {
  removeItem(mustRoom(slugRaw).slug, id);
}

function replyTarget(r: Room, reply: unknown) {
  if (reply == null || reply === "") return null;
  const id = Number(reply);
  if (!db.query("SELECT 1 FROM room_messages WHERE slug = ? AND id = ?").get(r.slug, id)) throw new Error(`no message #${reply} in room ${r.slug}`);
  return id;
}

// A lane writes in the thread (hud room say). The owning lane by default.
export function say(slugRaw: unknown, body: any) {
  const r = mustRoom(slugRaw);
  const text = String(body.text ?? "").trim();
  if (!text) throw new Error("say something: hud room say SLUG TEXT");
  if (text.length > 20_000) throw new Error("the message is over 20,000 characters");
  const author = str(body.as) || r.owner;
  if (!inRoom(r, author)) throw new Error(`${author} is not in room ${r.slug}: hud room create ${r.slug} --member ${author} adds it`);
  const res = db.query("INSERT INTO room_messages (slug, at, author, text, reply_to) VALUES (?, ?, ?, ?, ?)").run(r.slug, Date.now(), isHq(author) ? "hq" : author, text, replyTarget(r, body.reply));
  touch(r.slug);
  return { id: Number(res.lastInsertRowid) };
}

// The owner writes from the page, to the owning lane or to one lane in the room.
export function ownerPost(slugRaw: unknown, body: any) {
  const r = mustRoom(slugRaw);
  if (r.archived_at) throw new Error(`room ${r.slug} is archived`);
  const text = String(body.text ?? "").trim();
  if (!text) throw new Error("write something first");
  if (text.length > 20_000) throw new Error("the message is over 20,000 characters");
  const to = str(body.to) || r.owner;
  if (!inRoom(r, to)) throw new Error(`${to} is not in room ${r.slug}`);
  const res = db.query("INSERT INTO room_messages (slug, at, to_lane, text, reply_to, delivery) VALUES (?, ?, ?, ?, ?, 'sending')").run(r.slug, Date.now(), isHq(to) ? "hq" : to, text, replyTarget(r, body.reply));
  const id = Number(res.lastInsertRowid);
  touch(r.slug);
  deliver(id);
  return { id };
}

// Try a message that did not reach its lane again (the page's RETRY).
export function retry(slugRaw: unknown, id: number) {
  const r = mustRoom(slugRaw);
  const m = db.query("SELECT * FROM room_messages WHERE slug = ? AND id = ? AND author IS NULL").get(r.slug, id) as Msg | null;
  if (!m) throw new Error(`no message #${id} from ${OWNER} in room ${r.slug}`);
  if (m.delivery === "sent" || m.delivery === "sending") return;
  db.query("UPDATE room_messages SET delivery = 'sending', error = NULL WHERE id = ?").run(id);
  touch(r.slug);
  deliver(id);
}

// The owner has seen the room's thread: its lanes' messages are read.
export function seen(slugRaw: unknown) {
  const r = mustRoom(slugRaw);
  const res = db.query("UPDATE room_messages SET read_at = ? WHERE slug = ? AND author IS NOT NULL AND read_at IS NULL").run(Date.now(), r.slug);
  if (res.changes) touch(r.slug);
}

// Archives a room: `hud room archive` (HQ), or CLOSE ROOM on the page (by: "owner"), which HQ hears about.
export function archive(slugRaw: unknown, by?: unknown) {
  const r = mustRoom(slugRaw);
  if (r.archived_at) return;
  db.query("UPDATE rooms SET archived_at = ? WHERE slug = ?").run(Date.now(), r.slug);
  touch(r.slug);
  unwatchRoom(r.slug); // the folder stays; it is only no longer watched
  const lane = isHq(r.owner) ? null : r.owner;
  if (by !== "owner") return event("hq", `archived room ${r.slug}`, lane, r.floor);
  event(OWNER, `closed room ${r.slug}`, lane, r.floor);
  notifyHq(`HUD: ${OWNER} closed room ${r.slug} (${r.title}); reopen it with hud room create ${r.slug}`, undefined, r.floor ?? undefined);
}

// ---- delivery: an owner's message typed into its lane through herdr (promptAgent, the same helper as notifyHq) ----

type LaneRow = { name: string; machine: string | null; herdr: string | null };
const laneRow = (name: string) => db.query("SELECT name, machine, herdr FROM lanes WHERE name = ?").get(name) as LaneRow | null;
// Away: the lane is not registered any more, or herdr last found no agent by its name.
export const away = (name: string) => {
  if (isHq(name)) return false;
  const l = laneRow(name);
  return !l || l.herdr === "gone";
};
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const firstWords = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function promptText(r: Room, m: Msg, late: boolean) {
  const lane = m.to_lane!;
  const as = lane === r.owner ? "" : ` --as ${lane}`;
  const parent = m.reply_to ? (db.query("SELECT author, text FROM room_messages WHERE id = ?").get(m.reply_to) as { author: string | null; text: string } | null) : null;
  const head = [
    `HUD room ${r.slug} ("${r.title}"): ${OWNER} wrote to ${lane === r.owner ? "you, the room's owner" : "you"}`,
    late ? `, at ${hhmm(m.at)} while you were away` : "",
    parent ? `, replying to ${parent.author ? (parent.author === lane ? "your" : `${parent.author}'s`) : "their own"} message #${m.reply_to} ("${firstWords(parent.text)}")` : "",
    ` (message #${m.id}):`,
  ].join("");
  const keep = lane === r.owner ? "Keep the room's brief (hud room brief" : `${r.owner} owns the room and keeps its brief (hud room brief`;
  return `${head}\n${m.text}\nRoom folder: ${roomDir(r.slug)} (files/ is shared; anything you save there shows on the shelf)\nReply in the room, not only here: hud room say ${r.slug} "<your reply>"${as} [--reply ${m.id}]. ${keep} ${r.slug} --body ...) and artifacts (hud room artifact ${r.slug} --title T --url U | --file PATH) current; ${OWNER} reads the room, not this terminal.`;
}

function deliver(id: number) {
  const m = db.query("SELECT * FROM room_messages WHERE id = ?").get(id) as Msg | null;
  const r = m && room(m.slug);
  if (!m || !r || !m.to_lane) return;
  const set = (delivery: string, error: string | null = null) => {
    db.query("UPDATE room_messages SET delivery = ?, error = ?, delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END WHERE id = ?").run(delivery, error, delivery, Date.now(), id);
    touch(r.slug);
  };
  if (away(m.to_lane)) {
    if (m.delivery !== "away") set("away");
    return;
  }
  const late = m.delivery === "away";
  if (late) set("sending");
  const name = isHq(m.to_lane) ? hqOf(r.floor) : m.to_lane;
  promptAgent(name, promptText(r, m, late), isHq(m.to_lane) ? null : laneRow(m.to_lane)?.machine).then((res) => {
    if (res.ok) set("sent");
    else set("failed", res.error.slice(0, 200));
    bump();
  });
}

// A lane that was away is back when herdr sees it again: its kept messages go to it then, once each. Checked after
// every change of the state (herdr's sync bumps when a lane's status changes), never on a timer of its own.
let checkQueued = false;
listeners.add(() => {
  if (checkQueued) return;
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    const back = db
      .query("SELECT m.id FROM room_messages m JOIN lanes l ON l.name = m.to_lane WHERE m.delivery = 'away' AND l.herdr IS NOT NULL AND l.herdr != 'gone' ORDER BY m.id")
      .all() as { id: number }[];
    for (const { id } of back) deliver(id);
    if (back.length) bump();
  });
});

// ---- reads ----

function links(slug: string) {
  const rows = db.query("SELECT kind, ref FROM room_links WHERE slug = ? ORDER BY rowid").all(slug) as { kind: string; ref: string }[];
  return { issues: rows.filter((l) => l.kind === "issue").map((l) => l.ref), prs: rows.filter((l) => l.kind === "pr").map((l) => l.ref) };
}

function summary(r: Room) {
  const last = db.query("SELECT * FROM room_messages WHERE slug = ? ORDER BY id DESC LIMIT 1").get(r.slug) as Msg | null;
  const art = db.query("SELECT COUNT(*) AS n, MAX(at) AS at FROM room_artifacts WHERE slug = ?").get(r.slug) as { n: number; at: number | null };
  const unread = (db.query("SELECT COUNT(*) AS n FROM room_messages WHERE slug = ? AND author IS NOT NULL AND read_at IS NULL").get(r.slug) as { n: number }).n;
  const pending = (db.query("SELECT COUNT(*) AS n FROM room_messages WHERE slug = ? AND author IS NULL AND delivery IN ('away', 'failed')").get(r.slug) as { n: number }).n;
  const at = [r.created_at, r.brief_at, art.at, last?.at].filter((t): t is number => !!t);
  return {
    slug: r.slug,
    title: r.title,
    owner: r.owner,
    floor: r.floor,
    members: members(r.slug),
    ...links(r.slug),
    createdAt: r.created_at,
    archivedAt: r.archived_at,
    rev: r.rev,
    briefAt: r.brief_at,
    artifacts: art.n,
    // The thread's last message: the room table in the office fills while this is recent.
    threadAt: last?.at ?? null,
    last: last ? { id: last.id, at: last.at, who: last.author ?? "owner", to: last.to_lane, text: firstWords(last.text, 120) } : null,
    lastAt: Math.max(...at),
    unread,
    undelivered: pending,
  };
}

// Every open room, and the rooms archived in the last week, most recent activity first. One floor's, or every floor's.
export function roomsView(all = false, floor: string | null = null) {
  const rows = (db.query(all ? "SELECT * FROM rooms" : "SELECT * FROM rooms WHERE archived_at IS NULL OR archived_at > ?").all(...(all ? [] : [Date.now() - 7 * 86_400_000])) as Room[]).filter((r) => !floor || r.floor === floor);
  return rows.map(summary).sort((a, b) => b.lastAt - a.lastAt);
}

const message = (m: Msg) => ({ id: m.id, at: m.at, who: m.author ?? "owner", to: m.to_lane, text: m.text, reply: m.reply_to, delivery: m.delivery, deliveredAt: m.delivered_at, error: m.error, read: !!m.read_at });

export function roomView(slugRaw: unknown) {
  const r = mustRoom(slugRaw);
  const msgs = (db.query("SELECT * FROM room_messages WHERE slug = ? ORDER BY id DESC LIMIT ?").all(r.slug, THREAD_SHOWN) as Msg[]).reverse();
  return {
    ...summary(r),
    brief: r.brief,
    briefBy: r.brief_by,
    folder: roomDir(r.slug),
    artifactList: db.query("SELECT id, at, by, kind, title, url, path FROM room_artifacts WHERE slug = ? ORDER BY id").all(r.slug),
    messages: msgs.map(message),
    earlier: Math.max(0, (db.query("SELECT COUNT(*) AS n FROM room_messages WHERE slug = ?").get(r.slug) as { n: number }).n - msgs.length),
  };
}

// The owner's messages after `since` (hud room read). With wait and no since, only the ones that come after now.
function ownerMessages(slug: string, since: number) {
  return (db.query("SELECT * FROM room_messages WHERE slug = ? AND author IS NULL AND id > ? ORDER BY id").all(slug, since) as Msg[]).map(message);
}
export async function readOwner(slugRaw: unknown, sinceRaw: string | null, waitMs: number) {
  const r = mustRoom(slugRaw);
  const latest = () => (db.query("SELECT COALESCE(MAX(id), 0) AS id FROM room_messages WHERE slug = ?").get(r.slug) as { id: number }).id;
  const since = sinceRaw != null && sinceRaw !== "" ? Number(sinceRaw) : waitMs > 0 ? latest() : 0;
  if (!Number.isFinite(since)) throw new Error("--since takes a message id");
  const deadline = Date.now() + waitMs;
  let found = ownerMessages(r.slug, since);
  while (!found.length && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const done = () => {
        listeners.delete(done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, deadline - Date.now());
      listeners.add(done);
    });
    found = ownerMessages(r.slug, since);
  }
  return { slug: r.slug, title: r.title, owner: r.owner, since, messages: found, last: Math.max(since, latest()) };
}

addStatePart("rooms", () => roomsView());
startFolders();
