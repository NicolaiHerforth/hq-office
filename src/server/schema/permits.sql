-- PERMITS (permits.ts): what a lane's hook sent the HUD. One row per exact request: a permission prompt the hook
-- refused ('prompt'), an auto-mode classifier block ('classifier'), or a prompt showing that the hook did not answer
-- ('stuck'). input is the tool's input as JSON, every held secret value masked before it is stored; key is the hash
-- that says "this exact request" (lane, tool, folder and the input's identity fields). status: refused, allowed (the
-- owner's tap, good for an hour), used, expired. said: the body of the question raised for it, as the owner was shown it.
CREATE TABLE IF NOT EXISTS permits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor TEXT,
  lane TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  input TEXT,
  key TEXT,
  mode TEXT,
  cwd TEXT,
  reason TEXT,
  tries INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'refused',
  ask INTEGER,
  said TEXT,
  allowed_at INTEGER,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS permits_key ON permits (lane, key, status);
