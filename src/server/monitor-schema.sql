-- THE MONITOR's own database (monitor-store.ts), never hud.db: what every owner used in every tick, and the same
-- rolled up into longer buckets. Every t is epoch seconds. Here and not in schema/, whose files are applied to hud.db.

-- A mark on the timeline that someone put down: a test run started, a release went out. kind is a short word
-- the caller chose; the history adds its own marks (restarts, gaps, lanes) when it is read.
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,          -- epoch seconds
  kind TEXT NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS marks_t ON marks (t);

-- Which of the page's seven colours an owner wears (monitor-page.ts). A colour stays with its owner for as long as
-- that one is among the largest, so it never moves to another owner between two views.
CREATE TABLE IF NOT EXISTS slots (
  slot INTEGER PRIMARY KEY,    -- 1 to 7
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  since INTEGER NOT NULL       -- epoch seconds
);

-- What a disk grower takes on the disk (monitor-disk.ts): one or more folders, walked once a day. A reading that
-- failed has no row.
CREATE TABLE IF NOT EXISTS growers (
  name TEXT NOT NULL,
  t INTEGER NOT NULL,          -- epoch seconds
  kb INTEGER NOT NULL,
  PRIMARY KEY (name, t)
) WITHOUT ROWID;

-- When each disk grower's walk was last tried, whether it gave a size or not: a walk that failed is tried again a
-- day later, and a restart in between does not bring that forward.
CREATE TABLE IF NOT EXISTS grower_tries (
  name TEXT PRIMARY KEY,
  t INTEGER NOT NULL           -- epoch seconds
) WITHOUT ROWID;

-- Who used it: one row per (kind, owner, name) seen, as monitor-types.ts's Owner. The other tables store its id, so
-- a tick's rows are a few integers each. A row goes once no table can still refer to it, which seen says without a
-- look at those tables.
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  seen INTEGER,                -- epoch seconds of the newest tick it was in, as of the last prune; the store adds
                               -- the column to a database made before it, where it is NULL until a prune
  UNIQUE (kind, owner, name)
);

-- One tick's Usage rows. t is the end of the tick.
CREATE TABLE IF NOT EXISTS raw (
  t INTEGER NOT NULL,
  sid INTEGER NOT NULL,        -- series.id
  cpu_ms INTEGER NOT NULL,     -- CPU time used during the tick
  mem_kb INTEGER NOT NULL,     -- memory held at its end
  n INTEGER NOT NULL,          -- how many processes
  read_kb INTEGER NOT NULL,    -- read from disk during the tick
  written_kb INTEGER NOT NULL,
  PRIMARY KEY (t, sid)
) WITHOUT ROWID;

-- One tick's HostUsage, field for field.
CREATE TABLE IF NOT EXISTS host_raw (
  t INTEGER PRIMARY KEY,
  dt_ms INTEGER NOT NULL,      -- time since the reading before; 0 when there was none to count from
  cores INTEGER NOT NULL,
  busy_ms INTEGER NOT NULL,    -- CPU time of all cores together during the tick
  load1 REAL NOT NULL,
  mem_total_kb INTEGER NOT NULL,
  mem_free_kb INTEGER NOT NULL,
  mem_wired_kb INTEGER NOT NULL,
  mem_app_kb INTEGER NOT NULL,
  mem_cached_kb INTEGER NOT NULL,
  mem_compressed_kb INTEGER NOT NULL, -- RAM the compressor occupies
  mem_stored_kb INTEGER NOT NULL,     -- memory stored in it
  swap_total_kb INTEGER NOT NULL,
  swap_used_kb INTEGER NOT NULL,
  pressure INTEGER,            -- 1 normal, 2 warn, 4 critical; NULL when unreadable
  available REAL,              -- percent of memory the kernel counts as available
  pageins INTEGER NOT NULL,    -- these four: during the tick
  pageouts INTEGER NOT NULL,
  swapins INTEGER NOT NULL,
  swapouts INTEGER NOT NULL,
  thermal INTEGER,             -- 0 nominal to 4 sleeping
  disk_total_kb INTEGER,
  disk_free_kb INTEGER,
  boot_at INTEGER,             -- when the machine started, epoch seconds: it changes with a restart
  held_kb INTEGER NOT NULL,    -- what all the tick's rows hold together
  self_cpu_ms REAL NOT NULL,   -- what the monitor itself cost during the tick
  self_mem_kb INTEGER NOT NULL
);

-- raw per bucket of res seconds; t is the bucket's start. Sums of what was used, and what was held.
CREATE TABLE IF NOT EXISTS roll (
  res INTEGER NOT NULL,
  t INTEGER NOT NULL,
  sid INTEGER NOT NULL,
  cpu_ms INTEGER NOT NULL,
  mem_avg_kb INTEGER NOT NULL, -- over every sample of the bucket: a series gone for half of it held half as much
  mem_max_kb INTEGER NOT NULL,
  n_max INTEGER NOT NULL,
  read_kb INTEGER NOT NULL,
  written_kb INTEGER NOT NULL,
  PRIMARY KEY (res, t, sid)
) WITHOUT ROWID;

-- host_raw per bucket. A bucket without a sample has no row.
CREATE TABLE IF NOT EXISTS host_roll (
  res INTEGER NOT NULL,
  t INTEGER NOT NULL,
  samples INTEGER NOT NULL,    -- how many ticks are in it
  covered_ms INTEGER NOT NULL, -- their dt_ms summed: less than the bucket when ticks are missing
  cores INTEGER NOT NULL,
  busy_ms INTEGER NOT NULL,
  load_avg REAL NOT NULL,
  load_max REAL NOT NULL,
  mem_total_kb INTEGER NOT NULL,
  mem_free_avg_kb INTEGER NOT NULL,
  mem_wired_avg_kb INTEGER NOT NULL,
  mem_app_avg_kb INTEGER NOT NULL,
  mem_cached_avg_kb INTEGER NOT NULL,
  mem_compressed_avg_kb INTEGER NOT NULL,
  mem_stored_avg_kb INTEGER NOT NULL,
  swap_total_kb INTEGER NOT NULL,
  swap_used_avg_kb INTEGER NOT NULL,
  swap_used_max_kb INTEGER NOT NULL,
  pressure_max INTEGER,
  warn_ms INTEGER NOT NULL,     -- dt_ms of the ticks at pressure 2
  critical_ms INTEGER NOT NULL, -- and at pressure 4
  available_min REAL,
  pageins INTEGER NOT NULL,
  pageouts INTEGER NOT NULL,
  swapins INTEGER NOT NULL,
  swapouts INTEGER NOT NULL,
  thermal_max INTEGER,
  disk_total_kb INTEGER,
  disk_free_min_kb INTEGER,
  boot_at INTEGER,             -- the latest in the bucket
  available_avg REAL,
  held_avg_kb INTEGER NOT NULL,
  held_max_kb INTEGER NOT NULL,
  busy_max REAL,               -- the busiest tick, in cores
  self_cpu_ms REAL NOT NULL,
  self_mem_max_kb INTEGER NOT NULL,
  PRIMARY KEY (res, t)
) WITHOUT ROWID;
