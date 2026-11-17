// THE MONITOR's store: every tick in a database of its own (monitor-schema.sql), rolled up into one-minute and
// fifteen-minute buckets, the old thrown away by age and then by size. It has no clock: every call is given the time,
// so a test runs it in memory and moves the time. One process writes to a file at a time.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostUsage, Owner, Usage } from "./monitor-types.ts";

const DAY_MS = 86_400_000;
// A day, plus the 15 minutes its last 15-minute bucket takes to be complete and rolled up from the raw rows.
export const RAW_KEEP_MS = DAY_MS + 15 * 60_000;
export const RES = [
  { res: 60, keepMs: 7 * DAY_MS },
  { res: 900, keepMs: 90 * DAY_MS },
];
const LIMIT_BYTES = 500 * 1024 * 1024;
export const MARK_LABEL = 200;
const MARK_KIND = /^[a-z0-9][a-z0-9-]{0,23}$/;
const PRUNE_ROUNDS = 20;
// A series' last tick is written down at a prune, so after a crash it is behind by the time between two prunes at
// most. A day is far more than that: no series goes while a row may still refer to it.
const SERIES_SLACK_MS = DAY_MS;
// What SQLite says of a file that is not a database, or is one no longer.
const NOT_A_DATABASE = ["SQLITE_NOTADB", "SQLITE_CORRUPT"];

export type Store = {
  write(at: number, host: HostUsage, rows: Usage[]): void;
  // A mark on the timeline. kind is cut to a short lower-case word ("note" when it is none), the label to MARK_LABEL
  // characters.
  mark(at: number, kind: string | undefined, label: string): void;
  // What a disk grower (monitor-disk.ts) takes on the disk at a time.
  grower(at: number, name: string, kb: number): void;
  // That a grower's walk was tried at a time, whatever came of it.
  tried(at: number, name: string): void;
  roll(now: number): void;
  prune(now: number): void;
  size(): { bytes: number; limit: number };
  db: Database;
  close(): void;
};

// host_raw's columns after t, in order: HostUsage's fields, in snake_case there.
const HOST_FIELDS: (keyof HostUsage)[] = [
  "dtMs", "cores", "busyMs", "load1", "memTotalKb", "memFreeKb", "memWiredKb", "memAppKb", "memCachedKb", "memCompressedKb", "memStoredKb", "swapTotalKb", "swapUsedKb",
  "pressure", "available", "pageins", "pageouts", "swapins", "swapouts", "thermal", "diskTotalKb", "diskFreeKb", "bootAt", "heldKb", "selfCpuMs", "selfMemKb",
];
const snake = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// What is kept for how long: the raw ticks, then each resolution. The two tables of one hold the same times.
const TIERS = [
  { host: "host_raw", rows: "raw", where: "TRUE", keepMs: RAW_KEEP_MS },
  ...RES.map(({ res, keepMs }) => ({ host: "host_roll", rows: "roll", where: `res = ${res}`, keepMs })),
];

// A tick at second t says what was used in the ten seconds up to t, so it belongs to the bucket that t - 1 is in:
// the tick on the full minute closes the minute before. ?1 is the resolution, ?2 the first bucket and ?3 the end of
// the last. Grouped by bucket, so a bucket without a sample gets no row.
const ROLL_HOST = `
  INSERT OR REPLACE INTO host_roll (res, t, samples, covered_ms, cores, busy_ms, load_avg, load_max, mem_total_kb, mem_free_avg_kb, mem_wired_avg_kb, mem_app_avg_kb,
    mem_cached_avg_kb, mem_compressed_avg_kb, mem_stored_avg_kb, swap_total_kb, swap_used_avg_kb, swap_used_max_kb, pressure_max, warn_ms, critical_ms, available_min,
    pageins, pageouts, swapins, swapouts, thermal_max, disk_total_kb, disk_free_min_kb, boot_at, available_avg, held_avg_kb, held_max_kb, busy_max, self_cpu_ms, self_mem_max_kb)
  SELECT ?1, (t - 1) - (t - 1) % ?1, COUNT(*), SUM(dt_ms), MAX(cores), SUM(busy_ms), AVG(load1), MAX(load1), MAX(mem_total_kb), ROUND(AVG(mem_free_kb)), ROUND(AVG(mem_wired_kb)), ROUND(AVG(mem_app_kb)),
    ROUND(AVG(mem_cached_kb)), ROUND(AVG(mem_compressed_kb)), ROUND(AVG(mem_stored_kb)), MAX(swap_total_kb), ROUND(AVG(swap_used_kb)), MAX(swap_used_kb), MAX(pressure),
    SUM(IIF(pressure = 2, dt_ms, 0)), SUM(IIF(pressure = 4, dt_ms, 0)), MIN(available),
    SUM(pageins), SUM(pageouts), SUM(swapins), SUM(swapouts), MAX(thermal), MAX(disk_total_kb), MIN(disk_free_kb), MAX(boot_at), AVG(available), ROUND(AVG(held_kb)), MAX(held_kb), MAX(IIF(dt_ms > 0, busy_ms * 1.0 / dt_ms, NULL)), SUM(self_cpu_ms), MAX(self_mem_kb)
  FROM host_raw WHERE t > ?2 AND t <= ?3 GROUP BY (t - 1) - (t - 1) % ?1`;
// Memory is divided by the bucket's samples, not by the ticks the series was in: gone for half the bucket, it held
// half as much on average. CROSS JOIN keeps raw on the outside: one pass over the range, one lookup of the bucket
// per row. The planner's own order reads the whole range once per bucket of that resolution.
const ROLL_ROWS = `
  INSERT OR REPLACE INTO roll (res, t, sid, cpu_ms, mem_avg_kb, mem_max_kb, n_max, read_kb, written_kb)
  SELECT ?1, h.t, r.sid, SUM(r.cpu_ms), ROUND(SUM(r.mem_kb) * 1.0 / h.samples), MAX(r.mem_kb), MAX(r.n), SUM(r.read_kb), SUM(r.written_kb)
  FROM raw r CROSS JOIN host_roll h ON h.res = ?1 AND h.t = (r.t - 1) - (r.t - 1) % ?1
  WHERE r.t > ?2 AND r.t <= ?3 GROUP BY h.t, r.sid`;

export function openStore(path: string, opts: { limitBytes?: number } = {}): Store {
  const limit = opts.limitBytes ?? LIMIT_BYTES;
  const db = new Database(path, { create: true });
  try {
    // Before any table: a file made without it cannot give freed pages back without a full VACUUM.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(readFileSync(join(import.meta.dir, "monitor-schema.sql"), "utf8"));
    // A database made before series had the column: CREATE TABLE IF NOT EXISTS leaves its table as it was.
    if (!db.query("SELECT 1 FROM pragma_table_info('series') WHERE name = 'seen'").get()) db.exec("ALTER TABLE series ADD COLUMN seen INTEGER");
  } catch (e) {
    db.close();
    throw e;
  }

  const pragma = (name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0];
  const size = () => ({ bytes: (pragma("page_count") - pragma("freelist_count")) * pragma("page_size"), limit });

  // Every series' id, so a tick asks the database only about a series it has never seen.
  const ids = new Map<string, number>();
  const key = (o: Owner) => `${o.kind}\0${o.owner}\0${o.name}`;
  const loadIds = () => {
    ids.clear();
    for (const s of db.query("SELECT id, kind, owner, name FROM series").all() as (Owner & { id: number })[]) ids.set(key(s), s.id);
  };
  loadIds();
  const newSeries = db.query("INSERT INTO series (kind, owner, name, seen) VALUES (?, ?, ?, ?) RETURNING id");
  const idOf = (o: Owner, t: number) => {
    let id = ids.get(key(o));
    if (id === undefined) {
      id = (newSeries.get(o.kind, o.owner, o.name, t) as { id: number }).id;
      ids.set(key(o), id);
    }
    return id;
  };
  // The newest tick of each series written since the last prune, which writes them down: one small write every
  // quarter of an hour instead of one per row and tick.
  const seenSince = new Map<number, number>();
  const sawSeries = db.query("UPDATE series SET seen = MAX(COALESCE(seen, 0), ?) WHERE id = ?");
  const writeSeen = db.transaction(() => {
    for (const [id, t] of seenSince) sawSeries.run(t, id);
  });

  const putHost = db.query(`INSERT OR REPLACE INTO host_raw (t, ${HOST_FIELDS.map(snake).join(", ")}) VALUES (?${", ?".repeat(HOST_FIELDS.length)})`);
  const clearRows = db.query("DELETE FROM raw WHERE t = ?");
  // Two rows of one series in a tick (two names that a mask made one) add up.
  const putRow = db.query(`
    INSERT INTO raw (t, sid, cpu_ms, mem_kb, n, read_kb, written_kb) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (t, sid) DO UPDATE SET cpu_ms = cpu_ms + excluded.cpu_ms, mem_kb = mem_kb + excluded.mem_kb, n = n + excluded.n,
      read_kb = read_kb + excluded.read_kb, written_kb = written_kb + excluded.written_kb`);
  // A second write for the same second replaces the first, whole.
  const writeTick = db.transaction((t: number, host: HostUsage, rows: Usage[]) => {
    putHost.run(t, ...HOST_FIELDS.map((field) => host[field]));
    clearRows.run(t);
    for (const r of rows) putRow.run(t, idOf(r, t), r.cpuMs, r.memKb, r.n, r.readKb, r.writtenKb);
  });

  const newestRoll = db.query("SELECT MAX(t) AS t FROM host_roll WHERE res = ?");
  const rollHost = db.query(ROLL_HOST);
  const rollRows = db.query(ROLL_ROWS);
  // Both resolutions from the raw tables, never one from the other: no average of averages. One transaction, so
  // host_roll, which says how far the rollup got, never runs ahead of roll.
  const rollUp = db.transaction((now: number) => {
    for (const { res } of RES) {
      const end = Math.floor(now / 1000 / res) * res;
      const newest = (newestRoll.get(res) as { t: number | null }).t;
      const from = newest === null ? 0 : newest + res;
      if (from >= end) continue;
      rollHost.run(res, from, end);
      rollRows.run(res, from, end);
    }
  });

  const cut = (tier: (typeof TIERS)[number], before: number) => {
    for (const table of [tier.host, tier.rows]) db.query(`DELETE FROM ${table} WHERE ${tier.where} AND t < ?`).run(before);
  };

  return {
    db,
    size,
    write(at, host, rows) {
      const t = Math.round(at / 1000);
      try {
        writeTick(t, host, rows);
      } catch (e) {
        // The rollback took the series this tick added with it; their ids must not stay known.
        loadIds();
        throw e;
      }
      for (const r of rows) {
        const id = ids.get(key(r))!;
        seenSince.set(id, Math.max(seenSince.get(id) ?? 0, t));
      }
    },
    mark(at, kind, label) {
      db.query("INSERT INTO marks (t, kind, label) VALUES (?, ?, ?)").run(Math.round(at / 1000), kind !== undefined && MARK_KIND.test(kind) ? kind : "note", label.trim().slice(0, MARK_LABEL));
    },
    grower(at, name, kb) {
      db.query("INSERT OR REPLACE INTO growers (name, t, kb) VALUES (?, ?, ?)").run(name, Math.round(at / 1000), kb);
    },
    tried(at, name) {
      db.query("INSERT OR REPLACE INTO grower_tries (name, t) VALUES (?, ?)").run(name, Math.round(at / 1000));
    },
    roll: (now) => rollUp(now),
    prune(now) {
      const longest = Math.max(...RES.map((r) => r.keepMs));
      for (const tier of TIERS) cut(tier, (now - tier.keepMs) / 1000);
      // A mark, a grower's size and when it was last tried are kept as long as the history they belong to.
      for (const table of ["marks", "growers", "grower_tries"]) db.query(`DELETE FROM ${table} WHERE t < ?`).run((now - longest) / 1000);
      if (size().bytes > limit) {
        // Every tier gives up the oldest twentieth of the time it spans, round after round. The last round would
        // leave nothing, so the limit holds whenever an empty database is under it.
        const spans = TIERS.map((tier) => ({ tier, ...(db.query(`SELECT MIN(t) AS oldest, MAX(t) AS newest FROM ${tier.host} WHERE ${tier.where}`).get() as { oldest: number | null; newest: number }) }));
        for (let round = 1; round <= PRUNE_ROUNDS && size().bytes > limit; round++) {
          for (const { tier, oldest, newest } of spans) if (oldest !== null) cut(tier, oldest + Math.ceil(((newest - oldest + 1) * round) / PRUNE_ROUNDS));
        }
      }
      // A series goes by when it was last in a tick, never by a look through the rows: those are millions, and a
      // series with none left was last seen longer ago than any of them is kept. A row from before the column counts
      // as seen now.
      writeSeen();
      seenSince.clear();
      db.query("UPDATE series SET seen = ? WHERE seen IS NULL").run(Math.round(now / 1000));
      db.query("DELETE FROM series WHERE seen < ?").run((now - longest - SERIES_SLACK_MS) / 1000);
      loadIds();
      // Stepped to its end: each step gives one freed page back to the file system.
      db.query("PRAGMA incremental_vacuum").all();
    },
    close: () => db.close(),
  };
}

// The store for a monitor that has to come up whatever it finds: a file that is not a database is moved aside, with
// its -wal and -shm files, and a new one is started, so a damaged file costs the history and not the monitor.
// setAside is the name the old file has now, beside the new one, or null when there was nothing wrong with it. What
// else can stop the open (a folder that cannot be written, a full disk) is thrown, as openStore throws it.
export function openOrRenew(path: string, at: number): { store: Store; setAside: string | null } {
  try {
    return { store: openStore(path), setAside: null };
  } catch (e) {
    if (!NOT_A_DATABASE.includes((e as { code?: string }).code ?? "")) throw e;
  }
  const aside = `${path}.broken-${new Date(at).toISOString().replace(/[-:]|\.\d+/g, "")}`;
  for (const part of ["", "-wal", "-shm"]) if (existsSync(path + part)) renameSync(path + part, aside + part);
  return { store: openStore(path), setAside: basename(aside) };
}
