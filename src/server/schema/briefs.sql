-- BRIEFS (briefs.ts): a floor's HQ's longer write-ups for the owner (a project update, a plan, a summary), posted with
-- hud brief and read on the floor's BRIEFS page. body is markdown. read_at: when the owner first opened it.
CREATE TABLE IF NOT EXISTS briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS briefs_floor_at ON briefs (floor, at);
