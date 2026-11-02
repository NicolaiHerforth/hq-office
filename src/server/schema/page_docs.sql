-- PAGE RUNTIME db (page-runtime.ts): the documents an HTML page keeps through claude.use("db") / hud.use("db"), per
-- page (rooms/SLUG/files/NAME, rooms/SLUG/brief, briefs/ID). path is the document's path, coll its collection's,
-- data the JSON body, with secret values masked.
CREATE TABLE IF NOT EXISTS page_docs (
  page TEXT NOT NULL,
  path TEXT NOT NULL,
  coll TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page, path)
);
CREATE INDEX IF NOT EXISTS page_docs_coll ON page_docs (page, coll);
