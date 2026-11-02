-- COMMENTS (comments.ts): a thread on a brief or a room's page, keyed by the page: briefs/ID, rooms/SLUG/brief or
-- rooms/SLUG/files/NAME. author is the agent that answered (hud brief reply, hud page reply), or NULL for the owner.
-- quote: the passage the owner selected when commenting. An owner's comment goes to to_agent (the page's author: a
-- lane, or "hq" for the floor's HQ, through the HQ outbox); delivery is sending, sent, away (kept until herdr sees the
-- lane again), failed (error says why) or hq (in the outbox; hq_outbox's ref comment:ID says how far it got).
-- read_at: when the owner saw an answer.
CREATE TABLE IF NOT EXISTS page_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  at INTEGER NOT NULL,
  author TEXT,
  to_agent TEXT,
  text TEXT NOT NULL,
  quote TEXT,
  reply_to INTEGER,
  delivery TEXT,
  delivered_at INTEGER,
  error TEXT,
  read_at INTEGER,
  floor TEXT
);
CREATE INDEX IF NOT EXISTS page_comments_page ON page_comments (page, id);
CREATE INDEX IF NOT EXISTS page_comments_delivery ON page_comments (delivery);
