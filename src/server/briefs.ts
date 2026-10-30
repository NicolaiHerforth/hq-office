// BRIEFS: a floor's HQ posts a brief (hud brief: a title and a markdown body), a longer write-up than MESSAGES suits:
// a project update, a plan, a summary. It is on the caller's floor; MESSAGES gets one short line linking to it
// (#brief/ID), and the page lists the floor's briefs newest first. The state carries each brief's title and date, not
// its body; the page reads a body when it opens the brief (GET /api/briefs/ID).
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { postUpdate } from "./updates.ts";
import { floorOf, floorOr } from "./floors.ts";

const MAX_TITLE = 200, MAX_BODY = 200_000, SHOWN = 100;
type Brief = { id: number; floor: string; at: number; by: string; title: string; body: string; read_at: number | null };

export function postBrief(body: any, floor: string, by: string | null) {
  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");
  const text = String(body.body ?? "").replace(/\s+$/, "");
  if (!title) throw new Error("a brief needs a title: hud brief --title T");
  if (title.length > MAX_TITLE) throw new Error(`a brief's title is at most ${MAX_TITLE} characters`);
  if (!text.trim()) throw new Error("a brief needs a body: --body B, --file PATH, or pipe it in");
  if (text.length > MAX_BODY) throw new Error(`a brief's body is at most ${MAX_BODY.toLocaleString("en")} characters`);
  const on = floorOr(floor);
  const id = Number(db.query("INSERT INTO briefs (floor, at, by, title, body) VALUES (?, ?, ?, ?, ?)").run(on, Date.now(), by || "hq", title, text).lastInsertRowid);
  event(by || "hq", `posted brief #${id}: ${title}`, null, on);
  postUpdate({ title: `New brief: ${title}`, body: `[Read the brief](#brief/${id})` }, on);
  return { id, floor: on, floorName: floorOf(on)?.name ?? on };
}

export function briefOf(id: number) {
  const b = db.query("SELECT * FROM briefs WHERE id = ?").get(id) as Brief | null;
  return b && { id: b.id, floor: b.floor, at: b.at, by: b.by, title: b.title, body: b.body, read: !!b.read_at };
}
export function readBrief(id: number) {
  if (!db.query("UPDATE briefs SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(Date.now(), id).changes) throw new Error(`no brief #${id}`);
}

addStatePart("briefs", () =>
  (db.query("SELECT id, floor, at, by, title, read_at, substr(body, 1, 240) AS lead FROM briefs ORDER BY at DESC, id DESC LIMIT ?").all(SHOWN) as any[]).map((b) => ({
    id: b.id, floor: b.floor, at: b.at, by: b.by, title: b.title, read: !!b.read_at, lead: b.lead,
  })),
);
