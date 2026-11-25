// Writes a monitor.db as large as a busy machine's (about 2 million raw rows: a day of ticks for 230 process groups,
// with a week of one-minute and two weeks of quarter-hour rollups beside them), for HUD_MONITOR_REPLAY. The page's
// parts read millions of rows from such a file; test/server/monitor-reader.test.ts and scripts/monitor-bench.ts
// check that the server's thread answers while they do. Every value is made up from the time and the series' number,
// so the same call writes the same database, and its memory goes tight and critical now and then, so the history
// has episodes to find. Written with SQL, not through the store: the store's rollup would take minutes.
//   bun scripts/monitor-big.ts DIR
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/server/monitor-store.ts";

// The newest sample, which a replay takes as now.
export const BIG_END = Date.UTC(2026, 2, 10, 10, 0, 0);
const KINDS = ["lane", "app", "pane", "system", "other", "hq"];

export function writeBig(folder: string, opts: { series?: number; rawDays?: number; minuteDays?: number; quarterDays?: number } = {}) {
  const { series = 230, rawDays = 1, minuteDays = 7, quarterDays = 14 } = opts;
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "monitor.db");
  if (existsSync(file)) throw new Error(`${file} is there already`);
  const store = openStore(file);
  const db = store.db;
  const end = BIG_END / 1000;
  db.transaction(() => {
    const put = db.query("INSERT INTO series (id, kind, owner, name, seen) VALUES (?, ?, ?, ?, ?)");
    for (let i = 1; i <= series; i++) put.run(i, KINDS[i % KINDS.length], `owner-${i % 60}`, `proc-${i}`, end);
    // A tick's memory pressure: critical for a few minutes every six hours, tight around it.
    const pressure = `CASE WHEN (t % 21600) BETWEEN 3000 AND 3300 THEN 4 WHEN (t % 21600) BETWEEN 2400 AND 3900 THEN 2 ELSE 1 END`;
    const ticks = (days: number, step: number) => `WITH RECURSIVE n(t) AS (SELECT ${end - days * 86_400 + step} UNION ALL SELECT t + ${step} FROM n WHERE t < ${end}) `;
    db.exec(`${ticks(rawDays, 10)}
      INSERT INTO host_raw SELECT t, 10000, 16, 40000 + (t * 7919) % 90000, 4.0 + (t % 97) / 10.0, 67108864, 2000000 + (t * 31) % 3000000, 3000000, 40000000, 8000000, 4000000, 9000000,
        8388608, 2000000 + (t % 21600) * 50, ${pressure}, 40.0 - (t % 97) / 5.0, 10, 5, 2, 1, 0, 994000000, 300000000, ${end - 30 * 86_400}, 60000000, 30.0, 40000 FROM n`);
    db.exec(`${ticks(rawDays, 10)}, s(sid) AS (SELECT id FROM series)
      INSERT INTO raw SELECT t, sid, (t * 13 + sid * 7919) % 2000, 20000 + (sid * 104729 + t) % 900000, 1 + sid % 5, (t + sid) % 300, (t * 3 + sid) % 200 FROM n CROSS JOIN s`);
    for (const [res, days] of [[60, minuteDays], [900, quarterDays]] as const) {
      const samples = res / 10;
      db.exec(`${ticks(days, res)}
        INSERT INTO host_roll SELECT ${res}, t - ${res}, ${samples}, ${res * 1000}, 16, ${samples} * (40000 + (t * 7919) % 90000), 4.0 + (t % 97) / 10.0, 6.0 + (t % 97) / 10.0, 67108864,
          2000000 + (t * 31) % 3000000, 3000000, 40000000, 8000000, 4000000, 9000000, 8388608, 2000000 + (t % 21600) * 50, 2100000 + (t % 21600) * 50, ${pressure},
          IIF(${pressure} = 2, ${res * 1000}, 0), IIF(${pressure} = 4, ${res * 1000}, 0), 30.0, 10, 5, 2, 1, 0, 994000000, 300000000, ${end - 30 * 86_400}, 35.0, 60000000, 62000000, 6.0, 30.0, 40000 FROM n`);
      db.exec(`${ticks(days, res)}, s(sid) AS (SELECT id FROM series)
        INSERT INTO roll SELECT ${res}, t - ${res}, sid, ${samples} * ((t * 13 + sid * 7919) % 2000), 20000 + (sid * 104729 + t) % 900000, 30000 + (sid * 104729 + t) % 900000, 1 + sid % 5, (t + sid) % 300, (t * 3 + sid) % 200 FROM n CROSS JOIN s`);
    }
  })();
  const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rows = { raw: count("raw"), roll: count("roll") };
  // Into the file itself, so it is one file of about 150 MB and not that again in its log.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  return { file, rows };
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bun scripts/monitor-big.ts DIR");
  const at = performance.now();
  const { file, rows } = writeBig(dir);
  console.log(`${file}: ${rows.raw} raw rows, ${rows.roll} rollup rows, in ${Math.round(performance.now() - at)} ms`);
}
