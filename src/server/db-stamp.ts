// What was written to hud.db since someone last looked, so that what reads only some tables is made again only
// when one of them changed (state.ts).
//
// dbStamp(): the count of rows this connection changed, and the file's version as other connections left it (a
// tool that wrote to hud.db from outside). The same stamp twice: nothing was written between.
// tablesStamp(tables): the same for those tables alone. db.ts counts the writes of every statement that names its
// table. Rows that changed any other way (a trigger, a statement with RETURNING, db.exec, another connection) are
// seen here as a difference between the connection's total and what the statements said, and then every table
// counts as changed: the cost of that is one build too many, never one too few.
import { db, tableWrites, written } from "./db.ts";

const changes = db.query("SELECT total_changes() AS n");
const dataVersion = db.query("PRAGMA data_version");
const total = () => (changes.get() as { n: number }).n;
const outside = () => (dataVersion.get() as { data_version: number }).data_version;
export function dbStamp() {
  return `${total()}:${outside()}`;
}

let seen = { total: total(), outside: outside(), rows: written.rows };
let everything = 0;
// How often a write could not be put to a table (GET /api/push).
export const unplaced = { count: 0 };
export function tablesStamp(tables: readonly string[]) {
  const now = { total: total(), outside: outside(), rows: written.rows };
  if (now.outside !== seen.outside || now.total - seen.total !== now.rows - seen.rows) {
    everything++;
    unplaced.count++;
  }
  seen = now;
  return `${everything}/${tables.map((t) => tableWrites.get(t) ?? 0).join(",")}`;
}
