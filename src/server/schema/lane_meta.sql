-- What a lane is, as HQ registers it (hud lane NAME --role R --project NAME=URL): its role, which sets how its
-- worker looks, and the projects it works on (JSON array of { name, url }). One row per lane; a lane without a row
-- has neither. Applied at every start; IF NOT EXISTS keeps existing data.
CREATE TABLE IF NOT EXISTS lane_meta (
  lane TEXT PRIMARY KEY,
  role TEXT,
  projects TEXT,
  updated_at INTEGER NOT NULL
);
