// The owner's settings: the choices made on the page (hero, season, hat, sound), kept in the data directory so they
// survive a restart, a plugin update and a cleared browser. Served as S.settings; changed with POST /api/settings.
//
// The server does not know what the choices mean: it keeps short keys with small JSON values (a string, a number, a
// boolean), and the page checks them against what it offers. A key set to null goes back to the page's default.
import { db } from "./db.ts";
import { addStatePart } from "./state.ts";

export type Settings = Record<string, string | number | boolean>;
const KEY = /^[A-Za-z][\w-]{0,39}$/;
const MAX_KEYS = 50;
const MAX_STRING = 200;

let cache: Settings | null = null;
export function getSettings(): Settings {
  if (cache) return cache;
  const rows = db.query("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
  return (cache = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])));
}

function check(changes: unknown): Record<string, string | number | boolean | null> {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("settings must be an object");
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!KEY.test(key)) throw new Error(`"${key}" is not a setting name`);
    const ok = value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= MAX_STRING);
    if (!ok) throw new Error(`setting "${key}" must be a short string, a number, a boolean or null`);
    out[key] = value as string | number | boolean | null;
  }
  return out;
}

// Applies { key: value } changes and returns all settings. With ifEmpty (the page sending up what it remembered
// before the server kept settings), nothing changes unless the server has no settings yet, so two pages migrating at
// once cannot overwrite a choice made since.
export function changeSettings(changes: unknown, opts: { ifEmpty?: boolean } = {}) {
  const valid = check(changes);
  const now = Date.now();
  db.transaction(() => {
    if (opts.ifEmpty && (db.query("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n > 0) return;
    const keys = new Set(Object.keys(getSettings()));
    for (const [key, value] of Object.entries(valid)) value === null ? keys.delete(key) : keys.add(key);
    if (keys.size > MAX_KEYS) throw new Error(`at most ${MAX_KEYS} settings`);
    for (const [key, value] of Object.entries(valid)) {
      if (value === null) db.query("DELETE FROM settings WHERE key = ?").run(key);
      else db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, JSON.stringify(value), now);
    }
  })();
  cache = null;
  for (const fn of settingsChanged) fn();
  return getSettings();
}
// Hears every change of the settings (the HQ QUEUE's marker file follows its switch: hq-queue.ts).
export const settingsChanged = new Set<() => void>();

addStatePart("settings", getSettings);
