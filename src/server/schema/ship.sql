-- SHIP (ship.ts): one row per PR an agent ever filed for the owner to merge, unique on (repo, number). status: open (in
-- SHIP), merged, closed (on GitHub, without a merge) or sent_back (the owner sent it back with back_note); filing it
-- again opens it again. lane is whose work it is, filer who ran hud ship (null: HQ). urgent_why is the filer's
-- --urgent; domain, urgency and why are the sorter's, sorted_at when it ran. gh is GitHub's facts as JSON (docs/ship.md),
-- read at gh_read_at, or gh_error when the read failed. merge_asked_at is when the owner pressed MERGE or MERGE
-- WHEN CHECKS PASS, merge_error why the last merge failed. ended_how is how it left: merged (the owner, from the page),
-- self (merged on GitHub: auto-merge finished, or by hand there), back (sent back) or closed. hold_* is a press the
-- owner can still UNDO (docs/ship.md, UNDO: the hold): verb merge, auto or back, run at hold_until with the head the
-- page showed (hold_sha) and SEND BACK's note; all four are set together or all null. Every text column is TEXT, so
-- hud secret redact reaches it.
CREATE TABLE IF NOT EXISTS ship (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  floor TEXT NOT NULL,
  lane TEXT,
  filer TEXT,
  note TEXT,
  urgent_why TEXT,
  at INTEGER NOT NULL,
  filed_at INTEGER NOT NULL,
  domain TEXT,
  urgency TEXT,
  why TEXT,
  sorted_at INTEGER,
  gh TEXT,
  gh_error TEXT,
  gh_read_at INTEGER,
  merge_error TEXT,
  merge_asked_at INTEGER,
  back_note TEXT,
  ended_at INTEGER,
  ended_how TEXT,
  hold_verb TEXT,
  hold_until INTEGER,
  hold_sha TEXT,
  hold_note TEXT,
  UNIQUE (repo, number)
);
CREATE INDEX IF NOT EXISTS ship_status ON ship (status);
CREATE INDEX IF NOT EXISTS ship_ended ON ship (ended_at);
