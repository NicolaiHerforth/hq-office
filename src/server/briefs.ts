// BRIEFS: a floor's HQ posts a brief (hud brief: a title and a markdown body), a longer write-up than MESSAGES suits:
// a project update, a plan, a summary. It is on the caller's floor; MESSAGES gets one short line linking to it
// (#brief/ID), and the page lists the floor's briefs newest first. The state carries each brief's title and date, not
// its body; the page reads a body when it opens the brief (GET /api/briefs/ID).
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { postUpdate } from "./updates.ts";
import { floorOf, floorOr, type Caller } from "./floors.ts";
import { isPage, pageText, pageTitle } from "./pages.ts";

// A markdown brief is at most 200,000 characters; a brief that is a page (pages.ts: a whole HTML document or a fragment), 5 MB.
// The state carries each floor's newest 100, so a busy floor never pushes another floor's briefs out of its list.
const MAX_TITLE = 200, MAX_BODY = 200_000, MAX_PAGE = 5_000_000, SHOWN = 100;
type Brief = { id: number; floor: string; at: number; by: string; title: string; body: string; read_at: number | null };

export function postBrief(body: any, floor: string, by: string | null) {
  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");
  const text = String(body.body ?? "").replace(/\s+$/, "");
  if (!title) throw new Error("a brief needs a title: hud brief --title T");
  if (title.length > MAX_TITLE) throw new Error(`a brief's title is at most ${MAX_TITLE} characters`);
  if (!text.trim()) throw new Error("a brief needs a body: --body B, --file PATH, or pipe it in");
  const max = isPage(text) ? MAX_PAGE : MAX_BODY;
  if (text.length > max) throw new Error(isPage(text) ? "a brief page is at most 5 MB" : `a brief's body is at most ${MAX_BODY.toLocaleString("en")} characters`);
  const on = floorOr(floor);
  const id = Number(db.query("INSERT INTO briefs (floor, at, by, title, body) VALUES (?, ?, ?, ?, ?)").run(on, Date.now(), by || "hq", title, text).lastInsertRowid);
  event(by || "hq", `posted brief #${id}: ${title}`, null, on);
  postUpdate({ title: `New brief: ${title}`, body: `[Read the brief](#brief/${id})` }, on);
  return { id, floor: on, floorName: floorOf(on)?.name ?? on };
}

export function briefOf(id: number) {
  const b = db.query("SELECT * FROM briefs WHERE id = ?").get(id) as Brief | null;
  return b && { id: b.id, floor: floorOr(b.floor), at: b.at, by: b.by, title: b.title, body: isPage(b.body) ? null : b.body, html: isPage(b.body), read: !!b.read_at };
}
// The brief itself when it is a page, for GET /briefs/ID.html (a fragment is wrapped when served); null otherwise.
export function briefPage(id: number) {
  const b = db.query("SELECT body FROM briefs WHERE id = ?").get(id) as { body: string } | null;
  return b && isPage(b.body) ? b.body : null;
}
// An agent reads and answers only what is on its own floor (docs/floors.md, "Reading is scoped"): another floor's
// brief, comments or page data is refused unless it asks for every floor (--all) or names that floor (--floor). An
// agent's call comes from hud, which always sends x-hud-cwd; the HUD's page sends none and reads every floor.
export function agentOnFloor(req: Request, caller: () => Caller, floor: string, what: string) {
  if (!req.headers.has("x-hud-cwd") && !req.headers.has("x-hud-pane")) return;
  const c = caller();
  if (c.all || c.floor === floor) return;
  throw new Error(`${what} is on floor ${floor}, not yours (${c.floor}). Its HQ reads and answers it; add --all to reach another floor's`);
}
export function readBrief(id: number) {
  if (!db.query("UPDATE briefs SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(Date.now(), id).changes) throw new Error(`no brief #${id}`);
}

addStatePart("briefs", () =>
  (db.query(`SELECT b.id, b.floor, b.at, b.by, b.title, b.read_at, substr(b.body, 1, 4000) AS head FROM briefs b
    JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY floor ORDER BY at DESC, id DESC) AS n FROM briefs) r ON r.id = b.id
    WHERE r.n <= ? ORDER BY b.at DESC, b.id DESC`).all(SHOWN) as any[]).map((b) => {
    const html = isPage(b.head);
    return { id: b.id, floor: b.floor, at: b.at, by: b.by, title: b.title, read: !!b.read_at, html, lead: html ? pageText(b.head).slice(0, 240) : b.head.slice(0, 240) };
  }),
);
