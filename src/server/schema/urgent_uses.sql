-- One row for every urgent use: an item filed urgent, or an existing one pushed to the top. Who, when and which item.
-- Applied at every start; IF NOT EXISTS keeps existing data.
CREATE TABLE IF NOT EXISTS urgent_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ask_id INTEGER NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL
);
