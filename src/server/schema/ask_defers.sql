-- Each time the owner deferred an open question: from when, until when. A deferral ended early (brought back, or deferred
-- again) is cut at that moment. The bank does not count these spans as waiting.
CREATE TABLE IF NOT EXISTS ask_defers (
  ask_id INTEGER NOT NULL,
  from_at INTEGER NOT NULL,
  to_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ask_defers_ask ON ask_defers (ask_id);
