// The HQ sweep nudge: HQ SWEEP in SETTINGS (off by default) has the server type one "HUD sweep:" line into HQ when it
// is time for a sweep. Checked at the end of every herdr sync (no timer of its own). It goes when the switch is on,
// the hour is in the window, HQ is idle or done right now (never mid-turn) and receiving, and the interval has passed
// since the last nudge. It lists what HQ should look at (the owner's requests first: the ones to sort and the ones
// that have not moved since the last nudge; done lanes to close among the rest, with their worktrees) and asks
// for housekeeping every time; with nothing to list it sends nothing. A nudge HQ does not
// act on (HQ never works after it) doubles the wait for the next, up to 2 h. A list of nothing but what waits
// on the owner (questions, requests waiting on one) goes once, and again only when it changes: HQ cannot answer
// them, and the question panel shows them to the owner already. Never queued: a nudge that cannot go
// now is dropped, since an old one says nothing.
// The requests' own housekeeping (requests.ts) runs here too, at every sync, whether the sweep is on or not.
// Per floor: the settings are shared, but each floor's HQ is nudged about its own floor only, with its own last
// nudge, next one and backoff.
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { getSettings } from "./settings.ts";
import { housekeepRequests, requests } from "./owner-requests.ts";
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
const ageless = (s: string) => s.replace(/ \(oldest [^)]*\)/g, "").replace(/, (?:now|\d+[mhd])\)/g, ")");
const sameList = (a: string, b: string) => ageless(a) === ageless(b);
const WAITING = `questions waiting on ${OWNER} `;
// Judged once per nudge: the last nudge each floor's working HQ was weighed against.
const judged = new Map<string, number>();
// A floor whose nudge is being typed in. A timed sync and an asked-for one can overlap; both would read "no nudge
// yet" before either logged its own, and HQ got the line twice.
const sending = new Set<string>();
const waitMin = (minutes: number, floor: string) => Math.min(MAX_WAIT_MIN, minutes * 2 ** (unanswered.get(floor) ?? 0));

// A floor's last sweep that was due and had nothing to send. Memory only: after a restart the last nudge stands in.
const quiet = new Map<string, number>();
// A request has not moved "since the last sweep" when its last movement is older than the floor's last sweep, sent or
// silent, and a full interval has passed since that sweep. Before the first sweep that is every request. Counting
// the silent ones matters: a request that moved once after the last nudge would otherwise never be named again on a
// floor with nothing else to report.
function unmovedBefore(floor: string, minutes: number, now: number, last = lastAt(floor)) {
  const ref = Math.max(last, quiet.get(floor) ?? 0);
  return !ref ? Infinity : now - ref >= minutes * MINUTE ? ref : 0;
}
// What "unmoved" meant in a floor's last nudge, so the judgement of whether HQ changed anything reads the same list.
const namedBefore = new Map<string, number>();
function sweptQuietly(floor: string, minutes: number, now: number, last: number) {
  if (now - Math.max(last, quiet.get(floor) ?? 0) >= minutes * MINUTE) quiet.set(floor, now);
}

// What a floor's HQ should look at, in one line; null when there is nothing. ownerOnly: every part waits on the
// owner, so HQ can change none of it. `before`: requests whose last movement is older count as unmoved.
function findings(floor: string, before: number): { text: string; ownerOnly: boolean } | null {
  // A lane that is a floor's HQ is never reported to an HQ as one of its lanes: it is the HQ.
  const notHq = <T extends { name: string }>(rows: T[]) => rows.filter((l) => !isHqAgent(l.name));
  const lanes = notHq(db.query("SELECT name, herdr FROM lanes WHERE herdr IN ('idle', 'done') AND bg IS NULL AND phase NOT IN ('done', 'parked') AND floor = ? ORDER BY name").all(floor) as { name: string }[]);
  // Housekeeping: lanes marked done with nothing open (no open question), each with the folder its agent works in.
  const done = notHq(db.query("SELECT l.name FROM lanes l WHERE l.phase = 'done' AND l.floor = ? AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.lane = l.name AND a.status = 'open') ORDER BY l.name").all(floor) as { name: string }[]);
  const gone = notHq(db.query("SELECT name FROM lanes WHERE herdr = 'gone' AND phase NOT IN ('done', 'parked') AND floor = ? ORDER BY name").all(floor) as { name: string }[]);
  const asks = db.query("SELECT COUNT(*) AS n, MIN(created_at) AS at FROM asks WHERE status = 'open' AND floor = ?").get(floor) as { n: number; at: number | null };
  const rooms = db.query("SELECT DISTINCT m.slug FROM room_messages m JOIN rooms r ON r.slug = m.slug WHERE m.author IS NULL AND m.delivery IN ('away', 'failed') AND r.archived_at IS NULL AND r.floor = ? ORDER BY m.slug").all(floor) as { slug: string }[];
  const parts: string[] = [];
  let forOwner = 0;
  const waitsOnOwner = (part: string) => { parts.push(part); forOwner += 1; };
  const list = (label: string, names: string[]) => names.length && parts.push(`${label} ${names.length}: ${names.join(", ")}`);
  // The owner's requests first: the ones to sort, the ones with no movement since this floor's last sweep, and the
  // ones waiting on the owner.
  const req = requests.sweepLines(floor, before, OWNER);
  if (req.sort) parts.push(req.sort);
  if (req.unmoved) parts.push(req.unmoved);
  if (req.waiting) waitsOnOwner(req.waiting);
  list("idle or done lanes", lanes.map((l) => l.name));
  list("gone lanes", gone.map((l) => l.name));
  list("done lanes to close", done.map((l) => { const f = agentFolders.get(l.name); return f ? `${l.name} (${short(f.cwd)} on ${f.machine})` : l.name; }));
  if (asks.n) waitsOnOwner(`${WAITING}${asks.n} (oldest ${age(Date.now() - (asks.at ?? Date.now()))})`);
  list("rooms with undelivered messages", rooms.map((r) => r.slug));
  return parts.length ? { text: parts.join("; "), ownerOnly: parts.length === forOwner } : null;
}
// A home folder as ~ (/Users/x/... or /home/x/...), so the line stays short.
const short = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const age = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

// After each sync: every floor in turn. Resolves once the nudges, if any, have been typed in.
export async function sweep(now = Date.now()) {
  housekeepRequests();
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
    const found = findings(floor, namedBefore.get(floor) ?? unmovedBefore(floor, c.minutes, now, last));
    if (!found || !sameList(`${NUDGED}${found.text}`.slice(0, 500), lastText(floor))) unanswered.set(floor, 0);
  }
  if (last && now - last < waitMin(c.minutes, floor) * MINUTE) return;
  if (!["idle", "done"].includes(hq.status ?? "") || hqLink(floor).ok !== true) return;
  const before = unmovedBefore(floor, c.minutes, now, last);
  const found = findings(floor, before);
  if (!found || (found.ownerOnly && sameList(`${NUDGED}${found.text}`.slice(0, 500), lastText(floor)))) return sweptQuietly(floor, c.minutes, now, last);
  if (sending.has(floor)) return;
  sending.add(floor);
  try {
    const r = await promptAgent(hqOf(floor), withHint(`HUD sweep: ${found.text}. Sweep now (hud work, hud inbox, the rooms); an idle lane must be idle for a reason, and only HQ can judge it. ${HOUSEKEEPING}`));
    if (!r.ok) return; // dropped, never held: the link check says why on the page
    event("hud", `${NUDGED}${found.text}`.slice(0, 500), null, floor);
    namedBefore.set(floor, Math.min(before, now));
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
