// Updates from HQ: information, no reply asked.
import { db } from "./db.ts";
import { event } from "./events.ts";
import { floorsOf, HQ_FLOOR } from "../lane-tree.ts";

// Updates are information from HQ: no reply is asked for, and reading one sends nothing back to HQ.
export function postUpdate(body: any) {
  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("title is required");
  const res = db.query("INSERT INTO updates (at, lane, title, body) VALUES (?, ?, ?, ?)").run(Date.now(), body.lane || null, title, body.body ?? null);
  event("hq", `update: ${title}`, body.lane || null);
  return Number(res.lastInsertRowid);
}

// Unread updates by the lane they name ("" for none), so the page can count a floor or an agent. They add up to
// updatesUnread in the state. routes/updates.ts adds it to the state (this file loads before state.ts does).
export function unreadByLane() {
  const out: Record<string, number> = {};
  for (const r of db.query("SELECT COALESCE(lane, '') AS lane, COUNT(*) AS n FROM updates WHERE read_at IS NULL GROUP BY 1").all() as { lane: string; n: number }[]) out[r.lane] = r.n;
  return out;
}

// Marks unread updates read: all of them, or only those on `floor` and/or from `lane`. An update with no lane, or
// one whose lane is gone, is on HQ's floor.
export function markRead(scope: { floor?: string; lane?: string } = {}) {
  const now = Date.now();
  if (!scope.floor && !scope.lane) {
    db.query("UPDATE updates SET read_at = ? WHERE read_at IS NULL").run(now);
    return;
  }
  const floorOf = floorsOf(db.query("SELECT name, parent FROM lanes").all() as { name: string; parent: string | null }[]);
  const rows = db.query("SELECT id, lane FROM updates WHERE read_at IS NULL").all() as { id: number; lane: string | null }[];
  const mark = db.query("UPDATE updates SET read_at = ? WHERE id = ?");
  for (const u of rows) {
    if (scope.lane && u.lane !== scope.lane) continue;
    if (scope.floor && (floorOf.get(u.lane ?? "")?.floor ?? HQ_FLOOR) !== scope.floor) continue;
    mark.run(now, u.id);
  }
}
