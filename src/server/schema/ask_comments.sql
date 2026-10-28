-- The thread under a question: what the owner, HQ and the question's lane wrote. author is NULL for HQ (every
-- row made before the column), to_lane the lane a comment is addressed to (NULL: HQ), and delivery and error say whether an
-- owner's comment to a lane reached it. Never in HQ's inbox, never on the score.
CREATE TABLE IF NOT EXISTS ask_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ask_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ask_comments_ask ON ask_comments (ask_id);
