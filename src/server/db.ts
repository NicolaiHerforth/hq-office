// The SQLite database. Each table's schema is a file in schema/, applied at startup in name order.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DATA } from "./config.ts";

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

// ---- the queue: every message to HQ (or an orchestrator) is an ask with a recipient ----
const askColumns = () => (db.query("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name);
// Who must answer: 'owner' (the desk) or an orchestrator or PM name. Every older row is the owner's.
if (!askColumns().includes("recipient")) db.exec("ALTER TABLE asks ADD COLUMN recipient TEXT NOT NULL DEFAULT 'owner'");
// Set when an item was pushed to the top of its recipient's list. Each use is also a row in urgent_uses.
if (!askColumns().includes("urgent_at")) db.exec("ALTER TABLE asks ADD COLUMN urgent_at INTEGER");
// Why an answer could not reach the lane's pane.
if (!askColumns().includes("last_error")) db.exec("ALTER TABLE asks ADD COLUMN last_error TEXT");
// The id of the requests row this ask was copied from (see below); one ask per request, however often the copy runs.
if (!askColumns().includes("request_id")) db.exec("ALTER TABLE asks ADD COLUMN request_id INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS asks_request_id ON asks (request_id)");

// A database from the installed branch still has the old requests table. Its rows become asks, once: the copy skips
// every request already copied, so it is safe at every start. The table stays where it is, unread, because it holds
// answers; this is the only code that reads it. Upstream has no such table and nothing happens.
if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()) {
  db.exec(`
    INSERT INTO asks (lane, kind, title, body, link, recommended, due, created_at, status, answer, answered_at, acked_at, last_error, recipient, request_id)
    SELECT r.lane, r.kind,
           substr(CASE WHEN instr(r.text, char(10)) > 0 THEN substr(r.text, 1, instr(r.text, char(10)) - 1) ELSE r.text END, 1, 200),
           r.text, r.pr, r.default_action, r.default_by, r.created_at,
           CASE r.status WHEN 'closed' THEN 'answered' ELSE r.status END,
           r.answer, COALESCE(r.answered_at, r.defaulted_at),
           CASE WHEN r.status = 'open' THEN NULL ELSE COALESCE(r.answered_at, r.defaulted_at, r.created_at) END,
           r.last_error, COALESCE(NULLIF(trim(r.lead), ''), 'HQ'), r.id
    FROM requests r
    WHERE NOT EXISTS (SELECT 1 FROM asks a WHERE a.request_id = r.id)
    ORDER BY r.id`);
}
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
