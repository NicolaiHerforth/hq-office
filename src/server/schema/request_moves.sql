-- Every movement of a request (requests.ts), for hud work show and the row's history on the page. kind: assigned,
-- waiting, moved, delivered, withdrawn, answered, reopened, seen, closed, imported, or attached (words that came in
-- later as a repeat: text is those words, at is when the owner sent them). by: owner, hud, or the agent's name.
CREATE TABLE IF NOT EXISTS request_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request INTEGER NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS request_moves_request ON request_moves (request, at);
