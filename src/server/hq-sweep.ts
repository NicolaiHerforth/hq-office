// The HQ sweep nudge: HQ SWEEP in SETTINGS (off by default) has the server type one "HUD sweep:" line into HQ when it
// is time for a sweep. Checked at the end of every herdr sync (no timer of its own). It goes when the switch is on,
// the hour is in the window, HQ is idle or done right now (never mid-turn) and receiving, and the interval has passed
// since the last nudge. It lists what HQ should look at (done lanes to close among it, with their worktrees) and asks
// for housekeeping every time; with nothing to list it sends nothing. A nudge HQ does not
// act on (HQ never works after it) doubles the wait for the next, up to 2 h. Never queued: a nudge that cannot go
// now is dropped, since an old one says nothing.
// Per floor: the settings are shared, but each floor's HQ is nudged about its own floor only, with its own last
// nudge, next one and backoff.
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { getSettings } from "./settings.ts";
import { board } from "./work-board.ts";
import { withHint } from "../hq-guide.ts";
import { agentFolders, promptAgent } from "./herdr.ts";
import { hqLink, hqNowOf } from "./hq-link.ts";
import { firstFloor, floorList, hqOf, isHqAgent } from "./floors.ts";

// Every sweep asks for housekeeping as well; the lanes the HUD can tell are done are named in the findings.
const HOUSEKEEPING = "Housekeeping too: close lanes whose work is merged or done, stop their stacks and test containers, and prune their worktrees on each machine.";
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

// A floor's last nudge, from the event log, so a restart does not forget it.
const lastAt = (floor: string) => (db.query("SELECT MAX(at) AS at FROM events WHERE who = 'hud' AND text LIKE ? AND floor = ?").get(`${NUDGED}%`, floor) as { at: number | null }).at ?? 0;
// Nudges in a row that a floor's HQ did not act on. Memory only: after a restart HQ counts as having acted.
const unanswered = new Map<string, number>();
// The last nudge's list, as typed; ages ("oldest 2d") left out, since only they change while nothing else does.
const lastText = (floor: string) => (db.query("SELECT text FROM events WHERE who = 'hud' AND text LIKE ? AND floor = ? ORDER BY at DESC LIMIT 1").get(`${NUDGED}%`, floor) as { text: string } | null)?.text ?? "";
const sameList = (a: string, b: string) => a.replace(/ \(oldest [^)]*\)/g, "") === b.replace(/ \(oldest [^)]*\)/g, "");
// Judged once per nudge: the last nudge each floor's working HQ was weighed against.
const judged = new Map<string, number>();
// A floor whose nudge is being typed in. A timed sync and an asked-for one can overlap; both would read "no nudge
// yet" before either logged its own, and HQ got the line twice.
const sending = new Set<string>();
const waitMin = (minutes: number, floor: string) => Math.min(MAX_WAIT_MIN, minutes * 2 ** (unanswered.get(floor) ?? 0));

// What a floor's HQ should look at, in one line; null when there is nothing.
function findings(floor: string): string | null {
  // A lane that is a floor's HQ is never reported to an HQ as one of its lanes: it is the HQ.
  const notHq = <T extends { name: string }>(rows: T[]) => rows.filter((l) => !isHqAgent(l.name));
  const lanes = notHq(db.query("SELECT name, herdr FROM lanes WHERE herdr IN ('idle', 'done') AND bg IS NULL AND phase != 'done' AND floor = ? ORDER BY name").all(floor) as { name: string }[]);
  // Housekeeping: lanes marked done with nothing open (no open question), each with the folder its agent works in.
  const done = notHq(db.query("SELECT l.name FROM lanes l WHERE l.phase = 'done' AND l.floor = ? AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.lane = l.name AND a.status = 'open') ORDER BY l.name").all(floor) as { name: string }[]);
  const gone = notHq(db.query("SELECT name FROM lanes WHERE herdr = 'gone' AND phase NOT IN ('done', 'parked') AND floor = ? ORDER BY name").all(floor) as { name: string }[]);
  const stalled = board.view({ floor }).items.filter((i: any) => i.state === "stalled").map((i: any) => i.issue as string);
  const asks = db.query("SELECT COUNT(*) AS n, MIN(created_at) AS at FROM asks WHERE status = 'open' AND floor = ?").get(floor) as { n: number; at: number | null };
  const rooms = db.query("SELECT DISTINCT m.slug FROM room_messages m JOIN rooms r ON r.slug = m.slug WHERE m.author IS NULL AND m.delivery IN ('away', 'failed') AND r.floor = ? ORDER BY m.slug").all(floor) as { slug: string }[];
  const parts: string[] = [];
  const list = (label: string, names: string[]) => names.length && parts.push(`${label} ${names.length}: ${names.join(", ")}`);
  list("idle or done lanes", lanes.map((l) => l.name));
  list("gone lanes", gone.map((l) => l.name));
  list("done lanes to close", done.map((l) => { const f = agentFolders.get(l.name); return f ? `${l.name} (${short(f.cwd)} on ${f.machine})` : l.name; }));
  list("stalled board items", stalled);
  if (asks.n) parts.push(`questions waiting on ${OWNER} ${asks.n} (oldest ${age(Date.now() - (asks.at ?? Date.now()))})`);
  list("rooms with undelivered messages", rooms.map((r) => r.slug));
  return parts.length ? parts.join("; ") : null;
}
// A home folder as ~ (/Users/x/... or /home/x/...), so the line stays short.
const short = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const age = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

// After each sync: every floor in turn. Resolves once the nudges, if any, have been typed in.
export async function sweep(now = Date.now()) {
  const c = config();
  if (!c.on || !inWindow(c.hours, new Date(now))) return;
  for (const f of floorList()) await sweepFloor(f.id, c, now);
}

async function sweepFloor(floor: string, c: ReturnType<typeof config>, now: number) {
  const last = lastAt(floor);
  const hq = hqNowOf(floor);
  // HQ worked since the last nudge: the wait starts over, unless the sweep would list the same things again. Then HQ
  // could not change them (a question only the owner can answer, a lane idle for a reason), and the repeat keeps
  // doubling the wait instead of coming back every interval.
  if (hq.workingAt > last && judged.get(floor) !== last) {
    judged.set(floor, last);
    const found = findings(floor);
    if (!found || !sameList(`${NUDGED}${found}`.slice(0, 500), lastText(floor))) unanswered.set(floor, 0);
  }
  if (last && now - last < waitMin(c.minutes, floor) * MINUTE) return;
  if (!["idle", "done"].includes(hq.status ?? "") || hqLink(floor).ok !== true) return;
  const found = findings(floor);
  if (!found || sending.has(floor)) return;
  sending.add(floor);
  try {
    const r = await promptAgent(hqOf(floor), withHint(`HUD sweep: ${found}. Sweep now (hud board, hud inbox, the rooms); an idle lane must be idle for a reason, and only HQ can judge it. ${HOUSEKEEPING}`));
    if (!r.ok) return; // dropped, never held: the link check says why on the page
    event("hud", `${NUDGED}${found}`.slice(0, 500), null, floor);
    if (last) unanswered.set(floor, (unanswered.get(floor) ?? 0) + 1);
  } finally {
    sending.delete(floor);
  }
}

// A floor's last and next nudge and its backoff.
function timing(floor: string, minutes: number) {
  const last = lastAt(floor);
  return { lastAt: last || null, nextAt: last ? last + waitMin(minutes, floor) * MINUTE : null, backoff: unanswered.get(floor) ?? 0 };
}
// S.sweep: the settings and the first floor's timing, as before floors. S.sweepByFloor: every floor's timing.
addStatePart("sweep", () => {
  const c = config();
  return { ...c, ...timing(firstFloor(), c.minutes) };
});
addStatePart("sweepByFloor", () => {
  const c = config();
  return Object.fromEntries(floorList().map((f) => [f.id, timing(f.id, c.minutes)]));
});
