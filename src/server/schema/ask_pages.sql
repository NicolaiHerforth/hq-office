-- An ask's HTML page (hud ask --file q.html): one per ask, replaced in place by hud update ID --file. title and lead are
-- read from the page when it is written, so the state never reads the page itself.
CREATE TABLE IF NOT EXISTS ask_pages (
  ask_id INTEGER PRIMARY KEY,
  html TEXT NOT NULL,
  at INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  lead TEXT NOT NULL DEFAULT ''
);
