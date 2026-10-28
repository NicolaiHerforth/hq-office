// The HQ sweep nudge: HQ SWEEP in SETTINGS (off by default) has the server type one "HUD sweep:" line into HQ when it
// is time for a sweep. Checked at the end of every herdr sync (no timer of its own). It goes when the switch is on,
// the hour is in the window, HQ is idle or done right now (never mid-turn) and receiving, and the interval has passed
// since the last nudge. It lists what HQ should look at; with nothing to list it sends nothing. A nudge HQ does not
// act on (HQ never works after it) doubles the wait for the next, up to 2 h. Never queued: a nudge that cannot go
// now is dropped, since an old one says nothing.
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { getSettings } from "./settings.ts";
import { board } from "./work-board.ts";
import { withHint } from "../hq-guide.ts";
import { HQ_AGENT, promptAgent } from "./herdr.ts";
import { hqLink, hqNow } from "./hq-link.ts";

export const SWEEP_DEFAULTS = { on: false, minutes: 20, hours: "8-24" };
const MINUTE = Number(process.env.HUD_SWEEP_MINUTE_MS) || 60_000;
const MAX_WAIT_MIN = 120;
const NUDGED = "nudged HQ: ";

function config() {
  const s = getSettings();
  const minutes = Number(s.hqSweepMinutes);
  const hours = typeof s.hqSweepHours === "string" && window(s.hqSweepHours) ? s.hqSweepHours : SWEEP_DEFAULTS.hours;
  return { on: s.hqSweep === true, minutes: minutes > 0 ? minutes : SWEEP_DEFAULTS.minutes, hours };
}

// "8-24": from 08:00 to midnight; "22-6" wraps past midnight; "0-24" all day. This machine's clock.
function window(spec: string): [number, number] | null {
  const m = spec.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a <= 24 && b <= 24 && a !== b ? [a, b] : null;
}
function inWindow(spec: string, now: Date) {
  const [a, b] = window(spec)!;
  const h = now.getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// The last nudge, from the event log, so a restart does not forget it.
const lastAt = () => (db.query("SELECT MAX(at) AS at FROM events WHERE who = 'hud' AND text LIKE ?").get(`${NUDGED}%`) as { at: number | null }).at ?? 0;
// Nudges in a row that HQ did not act on. Memory only: after a restart HQ counts as having acted.
let unanswered = 0;
const waitMin = (minutes: number) => Math.min(MAX_WAIT_MIN, minutes * 2 ** unanswered);

// What HQ should look at, in one line; null when there is nothing.
function findings(): string | null {
  const lanes = db.query("SELECT name, herdr FROM lanes WHERE herdr IN ('idle', 'done') AND bg IS NULL ORDER BY name").all() as { name: string }[];
  const gone = db.query("SELECT name FROM lanes WHERE herdr = 'gone' AND phase NOT IN ('done', 'parked') ORDER BY name").all() as { name: string }[];
  const stalled = board.view().items.filter((i: any) => i.state === "stalled").map((i: any) => i.issue as string);
  const asks = db.query("SELECT COUNT(*) AS n, MIN(created_at) AS at FROM asks WHERE status = 'open' AND recipient = 'owner'").get() as { n: number; at: number | null };
  const rooms = db.query("SELECT DISTINCT slug FROM room_messages WHERE author IS NULL AND delivery IN ('away', 'failed') ORDER BY slug").all() as { slug: string }[];
  const parts: string[] = [];
  const list = (label: string, names: string[]) => names.length && parts.push(`${label} ${names.length}: ${names.join(", ")}`);
  list("idle or done lanes", lanes.map((l) => l.name));
  list("gone lanes", gone.map((l) => l.name));
  list("stalled board items", stalled);
  if (asks.n) parts.push(`questions waiting on ${OWNER} ${asks.n} (oldest ${age(Date.now() - (asks.at ?? Date.now()))})`);
  list("rooms with undelivered messages", rooms.map((r) => r.slug));
  return parts.length ? parts.join("; ") : null;
}
const age = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

// After each sync. Resolves once a nudge, if any, has been typed in.
export async function sweep(now = Date.now()) {
  const c = config();
  if (!c.on) return;
  const last = lastAt();
  if (hqNow.workingAt > last) unanswered = 0; // HQ worked since the last nudge
  if (last && now - last < waitMin(c.minutes) * MINUTE) return;
  if (!inWindow(c.hours, new Date(now))) return;
  if (!["idle", "done"].includes(hqNow.status ?? "") || hqLink().ok !== true) return;
  const found = findings();
  if (!found) return;
  const r = await promptAgent(HQ_AGENT, withHint(`HUD sweep: ${found}. Sweep now (hud board, hud inbox, the rooms); an idle lane must be idle for a reason, and only HQ can judge it.`));
  if (!r.ok) return; // dropped, never held: the link check says why on the page
  event("hud", `${NUDGED}${found}`.slice(0, 500));
  if (last) unanswered += 1;
}

addStatePart("sweep", () => {
  const c = config(), last = lastAt();
  return { ...c, lastAt: last || null, nextAt: last ? last + waitMin(c.minutes) * MINUTE : null, backoff: unanswered };
});
