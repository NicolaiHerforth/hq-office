-- PAGE RUNTIME storage (page-runtime.ts): a page's localStorage, per page, shared by everyone who opens the HUD.
-- Served inline in the page so reads are synchronous; values have secret values masked.
CREATE TABLE IF NOT EXISTS page_storage (
  page TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  PRIMARY KEY (page, k)
);
