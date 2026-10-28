// The SQLite database. Each table's schema is a file in schema/, applied at startup in name order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DATA } from "./config.ts";
import { FLOOR_PALETTE, freeColor } from "./floor-colors.ts";

export const db = new Database(`${DATA}/hud.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
const SCHEMA = join(import.meta.dir, "schema");
for (const f of readdirSync(SCHEMA).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(SCHEMA, f), "utf8"));
// Migrations for databases made before a column existed; they run after the tables exist.
// What an idle agent still has running in the background (for example "2 shells still running"), from its pane.
if (!(db.query("PRAGMA table_info(lanes)").all() as { name: string }[]).some((c) => c.name === "bg")) db.exec("ALTER TABLE lanes ADD COLUMN bg TEXT");
// Names of the secrets an ask requests (JSON array). Names only: values never reach the database.
if (!(db.query("PRAGMA table_info(asks)").all() as { name: string }[]).some((c) => c.name === "secrets")) db.exec("ALTER TABLE asks ADD COLUMN secrets TEXT");
// The lane a lane reports to; empty means straight under HQ. Depth is computed from the chain, never stored.
if (!(db.query("PRAGMA table_info(lanes)").all() as { name: string }[]).some((c) => c.name === "parent")) db.exec("ALTER TABLE lanes ADD COLUMN parent TEXT");
// blocked-prompts: the excerpt of the prompt a lane's agent waits on in herdr (null when none); see prompt.ts.
if (!(db.query("PRAGMA table_info(lanes)").all() as { name: string }[]).some((c) => c.name === "prompt")) db.exec("ALTER TABLE lanes ADD COLUMN prompt TEXT");
// A level set by hand (`hud lane NAME --level L`), over the one the tree gives; empty: the tree decides.
if (!(db.query("PRAGMA table_info(lanes)").all() as { name: string }[]).some((c) => c.name === "level")) db.exec("ALTER TABLE lanes ADD COLUMN level TEXT");
// Delivery to HQ, confirmed (HQ started working on it) or typed in mid-turn and sent once more (hq-link.ts).
// Rows from before it count as confirmed: an upgrade never replays the past.
for (const [col, type] of [["confirmed_at", "INTEGER"], ["resend", "INTEGER NOT NULL DEFAULT 0"]]) {
  if ((db.query("PRAGMA table_info(hq_outbox)").all() as { name: string }[]).some((c) => c.name === col)) continue;
  db.exec(`ALTER TABLE hq_outbox ADD COLUMN ${col} ${type}`);
  if (col === "confirmed_at") db.exec("UPDATE hq_outbox SET confirmed_at = COALESCE(sent_at, at)");
}
// FLOORS (floors.ts). A database from before floors gets its first floor here: "hq" / "HQ", or named by
// HUD_FLOOR_NAME, with HUD_HQ_AGENT as its HQ and the pane HQ was last seen in. Every existing row is put on it, so
// one floor is exactly what there was before.
if (!db.query("SELECT 1 FROM floors LIMIT 1").get()) {
  const name = (process.env.HUD_FLOOR_NAME ?? "").trim() || "HQ";
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "hq";
  const last = db.query("SELECT pane, seen_at FROM hq_link WHERE id = 1").get() as { pane: string; seen_at: number } | null;
  db.query("INSERT INTO floors (id, name, color, hq, position, created_at, hq_pane, hq_seen_at) VALUES (?, ?, ?, NULL, 0, ?, ?, ?)").run(id, name, FLOOR_PALETTE[0], Date.now(), last?.pane ?? null, last?.seen_at ?? null);
}
// Red, amber and green mean the three readings, never a floor, and no two floors wear one colour (floor-colors.ts): a
// floor that wears a reserved colour, or one an earlier floor wears, moves to the nearest colour nobody wears.
{
  const worn: string[] = [];
  for (const f of db.query("SELECT id, color FROM floors ORDER BY position, created_at").all() as { id: string; color: string }[]) {
    const c = freeColor(f.color, worn);
    if (c !== f.color.toLowerCase()) db.query("UPDATE floors SET color = ? WHERE id = ?").run(c, f.id);
    worn.push(c);
  }
}
const firstFloorId = (db.query("SELECT id FROM floors ORDER BY position, created_at LIMIT 1").get() as { id: string }).id;
// The work_items table is the board's own (board.ts adds its floor column the same way).
for (const table of ["lanes", "asks", "updates", "notes", "rooms", "hq_outbox", "events"]) {
  if ((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "floor")) continue;
  db.exec(`ALTER TABLE ${table} ADD COLUMN floor TEXT`);
  db.query(`UPDATE ${table} SET floor = ?`).run(firstFloorId);
}
