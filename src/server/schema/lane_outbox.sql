-- What the server types into a lane's pane for an ask it asked (ask-routing.ts): sending, sent, away (kept until
-- herdr sees the lane again) or hq (the lane could not take it, so its floor's HQ got it).
CREATE TABLE IF NOT EXISTS lane_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  floor TEXT,
  to_lane TEXT NOT NULL,
  ref TEXT NOT NULL,
  text TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'sending',
  error TEXT,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS lane_outbox_delivery ON lane_outbox (delivery);
