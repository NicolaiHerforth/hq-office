-- REQUESTS (requests.ts): one row per thing the owner asked for, in his words, from the moment it arrives until it is
-- delivered. status: new (filed from a note, not yet sorted by HQ), open (work, no owner yet), assigned (a lane or
-- HQ owns it), waiting (on the owner: ask), delivered (link + line), withdrawn (line is HQ's reason), closed (in no
-- list; closed_why says how). source: note | answer | hand | import; ref: note:ID, ask:ID or an imported row's id.
-- moved_at and moved are the last movement; seen_at is when the owner's page first showed it delivered or withdrawn.
-- Nothing is ever deleted. Every text column is TEXT, so hud secret redact reaches it.
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor TEXT NOT NULL,
  at INTEGER NOT NULL,
  words TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT,
  status TEXT NOT NULL,
  lane TEXT,
  issue TEXT,
  pr TEXT,
  ask INTEGER,
  link TEXT,
  line TEXT,
  moved_at INTEGER NOT NULL,
  moved TEXT,
  seen_at INTEGER,
  closed_at INTEGER,
  closed_why TEXT
);
CREATE INDEX IF NOT EXISTS requests_status ON requests (status, floor);
CREATE INDEX IF NOT EXISTS requests_ref ON requests (floor, ref);
