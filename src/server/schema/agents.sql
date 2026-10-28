-- Every named herdr agent, lanes or not: its status and when that status began, from the 20 s herdr sync.
-- Applied at every start; IF NOT EXISTS keeps existing data.
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  pane TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL,
  since INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
