-- The asks table. Applied at every start; IF NOT EXISTS keeps existing data.
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT,
  kind TEXT NOT NULL DEFAULT 'decision',
  title TEXT NOT NULL,
  body TEXT,
  options TEXT,
  recommended TEXT,
  link TEXT,
  due INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_at INTEGER,
  acked_at INTEGER
);
-- The open questions, and a day's answers by their time: both are asked for on every state build.
CREATE INDEX IF NOT EXISTS asks_status_answered ON asks (status, answered_at);
