-- Which Claude account (home) a lane was last moved to. A lane with no row runs on the default home.
CREATE TABLE IF NOT EXISTS lane_accounts (
  lane TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  moved_at INTEGER NOT NULL
);
