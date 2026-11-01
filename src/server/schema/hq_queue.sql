-- THE HQ QUEUE (hq-queue.ts, the HQ QUEUE setting): what lanes and the owner send a floor's HQ, waiting until HQ reads
-- it (read_at) and, for a lane's message, until HQ answers (answered_at) or closes it (closed_at). from_name is the
-- lane (or the owner's notes: 'owner'). via: hook (a message typed into HQ's pane, held by HQ's hook), hud (hud
-- request) or page (Tell HQ). ref ties an owner's note to it (note:ID).
CREATE TABLE IF NOT EXISTS hq_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor TEXT NOT NULL,
  at INTEGER NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  via TEXT NOT NULL,
  ref TEXT,
  urgent INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  answered_at INTEGER,
  answer TEXT,
  closed_at INTEGER,
  closed_why TEXT
);
CREATE INDEX IF NOT EXISTS hq_queue_floor ON hq_queue (floor, closed_at, answered_at);
