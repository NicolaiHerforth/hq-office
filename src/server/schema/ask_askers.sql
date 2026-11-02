-- Who asked an ask, when a lane did (a PM asking for its lanes). No row: HQ asked, as every ask did before.
CREATE TABLE IF NOT EXISTS ask_askers (
  ask_id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  at INTEGER NOT NULL
);
