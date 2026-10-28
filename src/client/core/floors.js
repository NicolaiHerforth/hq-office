// Floors as pure functions of S (the last /api/state): which floors there are, a floor's HQ link, and the floor tag
// and the scope line that lists show. A floor is one HQ agent and everything it runs (docs/floors.md); S.floors lists
// them in order and every row carries `floor`. One floor shows nothing of this: every helper here then says so.
import { ago, esc } from "./format.js";

export const floorsOf = (S) => S?.floors ?? [];
// Two or more floors: the building, the scope and the tags show. One floor is the page as it was before floors.
export const multi = (S) => floorsOf(S).length >= 2;
export const floorById = (S, id) => (id ? floorsOf(S).find((f) => f.id === id) ?? null : null);
export const firstFloor = (S) => floorsOf(S)[0]?.id ?? null;
// A floor's HQ link (S.hqLinks); the first floor's is S.hq, as before floors.
export const linkOf = (S, id) => S?.hqLinks?.[id ?? firstFloor(S)] ?? (!id || id === firstFloor(S) ? S?.hq : null) ?? null;
// A floor's name for a label: upper case, cut as a worker's name is (room/loop.js).
export const floorLabel = (f) => String(f?.name || f?.id || "").toUpperCase();
export const cut = (s, n = 14) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// How a floor's HQ is doing, for its pill, row and tile: "starting" (a floor whose HQ herdr has not shown yet),
// "late" (still not there after a while: not running), "down" (it was receiving and stopped: the alarm), "ok", or
// "unknown" (not checked yet).
export function hqMood(f) {
  if (f?.starting) return f.notStarted ? "late" : "starting";
  return f?.receiving === false ? "down" : f?.receiving === true ? "ok" : "unknown";
}
export const MOOD_TEXT = { starting: "STARTING", late: "NOT STARTED", down: "HQ ISN'T RECEIVING" };
// The HQ's state in one word, beside its name.
export const MOOD_WORD = { ok: "receiving", starting: "starting", late: "not running", down: "stopped", unknown: "checking" };
// A floor whose HQ is not running gets its fix where it is shown, START ITS HQ or PICK ANOTHER: one that never
// started, or one that ran and stopped (herdr has no agent by its name and no pane to give the name back to). Not the
// first floor: its HQ is the one the HUD was set up with, and its strip has NAME and CHECK NOW.
export function needsFix(S, f) {
  if (!f || f.id === firstFloor(S)) return false;
  if (f.starting) return true;
  return f.receiving === false && /^no agent in herdr is named/.test(f.reason ?? "") && !linkOf(S, f.id)?.candidate;
}
// What a floor's mood says in words, for a title or a line under its name.
export function moodLine(f) {
  const m = hqMood(f);
  if (m === "starting" || m === "late") return `${f.hq} is not running in herdr`;
  if (m === "down" && /^no agent in herdr is named/.test(f.reason ?? "")) return `${f.hq} stopped: it is not running in herdr`;
  if (m === "down") return f.reason ?? "HQ isn't receiving";
  return "";
}

// The three readings, for a floor (its counts) or the whole office (S.office), the same everywhere (docs/floors.md,
// "The floor UI rules"). Red, amber and green mean these and nothing else:
//   blocking  questions and TO DOs that wait on the owner, and since when: red;
//   working   lanes at work now (herdr working or background work, never at a prompt), of the active ones: green;
//   stalled   active lanes, none working and none waiting on the owner: NOTHING MOVING. Shown once it has held for
//             3 minutes (so it never flickers), amber, and red after 20.
export const STALL_SHOW_MS = 3 * 60_000, STALL_LATE_MS = 20 * 60_000;
export function readingOf(c, now = Date.now()) {
  const blocking = c?.blocking ?? c?.needsYou ?? 0, working = c?.working ?? 0, active = c?.active ?? 0;
  const idleSince = c?.idleSince ?? null;
  const stalled = active > 0 && working === 0 && blocking === 0;
  const age = stalled && idleSince != null ? now - idleSince : 0;
  // 0: no alarm (or not for 3 minutes yet), 1: amber, 2: red.
  const stall = !stalled ? 0 : idleSince == null ? 1 : age >= STALL_LATE_MS ? 2 : age >= STALL_SHOW_MS ? 1 : 0;
  return { blocking, oldestWaitAt: c?.oldestWaitAt ?? null, working, active, blocked: c?.blocked ?? 0, idleSince, stalled, stall };
}
// The office's readings: S.office, or the sum of the floors from a server without it.
export function officeOf(S) {
  if (S?.office) return S.office;
  const fs = floorsOf(S);
  const sum = (k) => fs.reduce((n, f) => n + (f.counts?.[k] ?? 0), 0);
  return { blocking: S?.open?.length ?? sum("needsYou"), working: sum("working"), active: sum("lanes"), blocked: sum("blocked"), oldestWaitAt: null, idleSince: null };
}
// A floor's worst state, for its pip in the top bar and its tile's frame: "block", "late", "idle", "work" or "".
export function worstOf(c, now = Date.now()) {
  const r = readingOf(c, now);
  return r.blocking ? "block" : r.stall === 2 ? "late" : r.stall === 1 ? "idle" : r.working ? "work" : "";
}
// What the page clock must redraw: every floor's stall step and the office's (a stall shows at 3 min, reddens at 20).
export const stallKey = (S, now = Date.now()) => [officeOf(S), ...floorsOf(S).map((f) => f.counts)].map((c) => readingOf(c, now).stall).join("");

// An age the page clock keeps current, coarse ("25 min", "2h"), and wakes for once a minute.
const ageHTML = (at, now) => `<span data-since="${at}" data-ago>${ago(now - at)}</span>`;
// Slot A, before the name: a red "! N" when anything waits on you, else an amber (then red) "Zz N" when nothing moves.
export function slotAHTML(c, now = Date.now()) {
  const r = readingOf(c, now);
  if (r.blocking) return `<span class="slot sa block" title="${r.blocking} ${r.blocking === 1 ? "waits" : "wait"} on you"><b aria-hidden="true">!</b>${r.blocking}</span>`;
  if (r.stall) return `<span class="slot sa idle${r.stall === 2 ? " late" : ""}" title="Nothing moving: ${r.active} ${r.active === 1 ? "lane" : "lanes"} idle, nothing waits on you"><b aria-hidden="true">Zz</b>${r.active}</span>`;
  return "";
}
// Slot B, after the name: a green bar per working lane, up to five, then ▮5+.
export function slotBHTML(c, now = Date.now()) {
  const r = readingOf(c, now);
  if (!r.working) return "";
  const bars = r.working > 5 ? `<i></i>5+` : "<i></i>".repeat(r.working);
  return `<span class="slot sb" title="${r.working} working now" aria-label="${r.working} working">${bars}</span>`;
}
// The readings in words: chips on the switcher row. The words are the same at every width; a narrow row drops the
// ages, a zero "wait on you" and the working count (the pill's bars say it), never the alarm.
export function readingChipsHTML(c, now = Date.now()) {
  const r = readingOf(c, now), of = Math.max(r.active, r.working);
  const block = r.blocking
    ? `<span class="fread rblock hot" title="${r.blocking} ${r.blocking === 1 ? "waits" : "wait"} on you: you are the bottleneck"><b>${r.blocking}</b><span>WAIT ON YOU</span>${r.oldestWaitAt ? `<span class="wl">· ${ageHTML(r.oldestWaitAt, now)}</span>` : ""}</span>`
    : `<span class="fread rblock zero" title="Nothing waits on you"><b>0</b><span>WAIT ON YOU</span></span>`;
  const prompt = r.blocked ? `<span class="fread rprompt" title="${r.blocked} at a prompt in herdr"><b>${r.blocked}</b><span>AT A PROMPT</span></span>` : "";
  const work = r.stall
    ? `<span class="fread rstall${r.stall === 2 ? " late" : ""}" title="${r.active} ${r.active === 1 ? "lane" : "lanes"} idle · nothing waiting on you"><b>NOTHING MOVING</b>${r.idleSince ? `<span class="wl">· ${ageHTML(r.idleSince, now)}</span>` : ""}</span>`
    : `<span class="fread rwork${r.working ? " on" : ""}" title="${r.working} of ${of} active lanes working now"><b>${r.working}</b><span>OF ${of} WORKING</span>${r.stalled && r.idleSince ? `<span class="wl">· idle ${ageHTML(r.idleSince, now)}</span>` : ""}</span>`;
  return block + prompt + work;
}
// The readings big and plain (a building tile): a line each, the number first.
export function readingBigHTML(c, now = Date.now()) {
  const r = readingOf(c, now), of = Math.max(r.active, r.working);
  const block = `<div class="tr tblock${r.blocking ? " hot" : ""}"><b>${r.blocking}</b><span>${r.blocking === 1 ? "WAITS" : "WAIT"} ON YOU</span>${r.blocking && r.oldestWaitAt ? `<small>oldest ${ageHTML(r.oldestWaitAt, now)}</small>` : ""}</div>`;
  const work = r.stall
    ? `<div class="tr tstall${r.stall === 2 ? " late" : ""}"><b>${r.idleSince ? ageHTML(r.idleSince, now) : "-"}</b><span>NOTHING MOVING</span><small>${r.active} idle</small></div>`
    : `<div class="tr twork${r.working ? " on" : ""}"><b>${r.working}/${of}</b><span>WORKING</span>${r.blocked ? `<small>${r.blocked} at a prompt</small>` : ""}</div>`;
  return block + work;
}
// The readings in a line (a row of the floor list).
export function readingLineHTML(c, now = Date.now()) {
  const r = readingOf(c, now), of = Math.max(r.active, r.working);
  const block = r.blocking ? `<span class="lr lr-hot">${r.blocking} wait on you</span>` : `<span class="lr">0 wait on you</span>`;
  const work = r.stall
    ? `<span class="lr lr-stall${r.stall === 2 ? " lr-late" : ""}">nothing moving${r.idleSince ? ` · ${ageHTML(r.idleSince, now)}` : ""}</span>`
    : `<span class="lr${r.working ? " lr-on" : ""}">${r.working} of ${of} working</span>`;
  return block + work;
}
// Don't print "HQ: hq" for a floor whose HQ is named as the floor.
export const hqShown = (f) => (f && f.hq !== f.id ? f.hq : "");

// Ink or white on a floor's colour, whichever reads: the colour is the owner's choice (or hud's), any #rrggbb.
export function inkOn(color) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  if (!m) return "#fff";
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#23233a" : "#fff";
}
// A card's floor, in a list that shows every floor: a 4 px stripe in the floor's colour down the card's left edge
// and a small swatch that sits in the lane tag after it; the floor's name in the tooltip.
export function floorTagHTML(S, floorId) {
  const f = floorById(S, floorId);
  if (!f) return "";
  return `<span class="fstripe" data-floor="${esc(f.id)}" style="background:${esc(f.color)}" title="${esc(f.name)} floor" aria-label="${esc(f.name)} floor"></span><i class="fswatch" style="background:${esc(f.color)}" aria-hidden="true"></i>`;
}
