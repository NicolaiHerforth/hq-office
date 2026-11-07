// The secret ledger: the name, setter and deadline of every secret this server holds (never a value), kept in
// secret_meta so a server that starts after a crash knows which secrets it lost and says so: in listings, on the
// page and in a note to HQ. Also writes this start's handover token (see secrets.ts and src/secret-handover.ts).
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, OWNER } from "./config.ts";
import { db } from "./db.ts";
import { bump, secrets } from "./push.ts";
import { notifyAllHqs } from "./hq-link.ts";
import { addStatePart } from "./state.ts";
import { createHandover, restartTime, type LostBook, type LostSecret } from "./secrets.ts";
import { TOKEN_FILE } from "../secret-handover.ts";

export const startedAt = Date.now();
// How long a lost name waits for a handover before HQ is told: a planned restart imports within a second or two.
// HUD_SECRET_LOST_NOTE_MS shortens it for tests.
const NOTE_AFTER_MS = Number(process.env.HUD_SECRET_LOST_NOTE_MS) || 30_000;

type Row = { name: string; by: string; set_at: number; expires_at: number };
db.query("DELETE FROM secret_meta WHERE expires_at <= ?").run(startedAt);
const lost = new Map<string, LostSecret>(
  (db.query("SELECT * FROM secret_meta ORDER BY expires_at").all() as Row[]).map((r) => [r.name, { name: r.name, by: r.by, setAt: r.set_at, expiresAt: r.expires_at, lostAt: startedAt }]),
);

// Names that expired, were removed or were dismissed as lost since this start. Memory only: this is for a warning, and
// nothing is known of those that went before it.
const gone = new Set<string>();
secrets.attach({
  put(m) {
    db.query("INSERT INTO secret_meta (name, by, set_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET by = excluded.by, set_at = excluded.set_at, expires_at = excluded.expires_at").run(m.name, m.by, m.setAt, m.expiresAt);
    lost.delete(m.name);
    gone.delete(m.name);
  },
  drop(name) {
    db.query("DELETE FROM secret_meta WHERE name = ?").run(name);
    gone.add(name);
  },
});

function forget(name: string) {
  if (!lost.delete(name)) return false;
  db.query("DELETE FROM secret_meta WHERE name = ?").run(name);
  gone.add(name);
  return true;
}
// Every name whose value this server once had or was meant to have and cannot mask now.
export const noLongerHeld = () => [...new Set([...lostBook.list().map((l) => l.name), ...gone])];
export const lostBook: LostBook = {
  list() {
    const now = Date.now();
    for (const l of [...lost.values()]) if (l.expiresAt <= now) forget(l.name);
    return [...lost.values()];
  },
  get(name) {
    const l = lost.get(name);
    if (!l) return null;
    if (l.expiresAt <= Date.now()) return forget(name), null;
    return l;
  },
  clear(name) {
    const gone = forget(name);
    if (gone) bump();
    return gone;
  },
};
addStatePart("secretsLost", () => lostBook.list());

// One line to HQ, once: what this start lost and did not get back from a handover.
let told = false;
function tellHq() {
  if (told) return;
  told = true;
  clearTimeout(noteTimer);
  const names = lostBook.list().map((l) => l.name);
  if (!names.length) return;
  notifyAllHqs(`HUD secrets lost: the server restarted at ${restartTime(startedAt)} and lost ${names.join(", ")} (values live in its memory only). hud secret get fails for them; ask ${OWNER} to set them again (hud ask --secret NAME).`);
}
const noteTimer = lost.size ? setTimeout(tellHq, NOTE_AFTER_MS) : undefined;
if (!lost.size) told = true;

// The handover token: fresh per start, in the data dir, this user only.
const tokenPath = join(DATA, TOKEN_FILE);
let token = "";
try {
  const t = randomBytes(32).toString("hex");
  rmSync(tokenPath, { force: true });
  writeFileSync(tokenPath, t + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(tokenPath, 0o600);
  token = t;
} catch (e) {
  console.error(`secret handover off: could not write ${tokenPath}: ${(e as Error).message}`);
}
export const handover = createHandover({
  token,
  startedAt,
  onImport(restored) {
    console.log(`secret handover: took ${restored.length} secret${restored.length === 1 ? "" : "s"} from the previous server`);
    bump();
    tellHq();
  },
});
