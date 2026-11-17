-- The events table. Applied at every start; IF NOT EXISTS keeps existing data.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  lane TEXT,
  who TEXT NOT NULL,
  text TEXT NOT NULL
);
-- The last event on a lane: the work board asks for it once per lane, on every state build.
CREATE INDEX IF NOT EXISTS events_lane_at ON events (lane, at);
