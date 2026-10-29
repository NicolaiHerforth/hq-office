-- FLOOR KINDS (floors.ts): the herdr agent kind each floor's HQ runs (claude, codex, or any other kind herdr can
-- start), as it was last started or seen in herdr. START ITS HQ starts that kind again. Any kind: nothing assumes one.
CREATE TABLE IF NOT EXISTS floor_kinds (
  floor TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
