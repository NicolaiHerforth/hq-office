-- PAGE RUNTIME publish (page-publish.ts): the earlier versions of a floor brief that is a page, kept when the page
-- publishes itself (artifact.publish). A room's page and brief keep theirs in the room's folder (room-folder.ts).
CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  html TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_versions_page ON page_versions (page, at);
