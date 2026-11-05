-- The Linear projects rooms are linked to (room_links, kind 'project', ref = the project's id): their name and URL as
-- Linear last gave them, so a room shows its project's name before the first fetch after a restart.
CREATE TABLE IF NOT EXISTS linear_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  at INTEGER NOT NULL
);
