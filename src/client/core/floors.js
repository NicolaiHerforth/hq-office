// Floors as pure functions of S (the last /api/state): which floors there are, a floor's HQ link, and the floor tag
// and the scope line that lists show. A floor is one HQ agent and everything it runs (docs/floors.md); S.floors lists
// them in order and every row carries `floor`. One floor shows nothing of this: every helper here then says so.
import { esc } from "./format.js";

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

// How a floor's HQ is doing, for its tab, tile and header: "starting" (a new floor whose HQ herdr has not shown yet),
// "late" (still not there after a while: a calm note), "down" (it was receiving and stopped: the alarm), "ok", or
// "unknown" (not checked yet).
export function hqMood(f) {
  if (f?.starting) return f.notStarted ? "late" : "starting";
  return f?.receiving === false ? "down" : f?.receiving === true ? "ok" : "unknown";
}
export const MOOD_TEXT = { starting: "STARTING", late: "NOT STARTED", down: "HQ ISN'T RECEIVING" };
// What a floor's mood says in words, for a title or a line under its name.
export function moodLine(f) {
  const m = hqMood(f);
  if (m === "starting") return `waiting for ${f.hq} in herdr`;
  if (m === "late") return `${f.hq} has not started in herdr yet`;
  if (m === "down") return f.reason ?? "HQ isn't receiving";
  return "";
}
// Need-you dots: one per open question up to five; more than that, the count.
export function needDotsHTML(n) {
  if (!n) return "";
  return n > 5 ? `<span class="fneed n">${n}</span>` : `<span class="fneed" aria-hidden="true">${"<i></i>".repeat(n)}</span>`;
}

// Ink or white on a floor's colour, whichever reads: the colour is the owner's choice (or hud's), any #rrggbb.
export function inkOn(color) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  if (!m) return "#fff";
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#23233a" : "#fff";
}
// The tag on a card in a list that shows every floor: the floor's name on its colour.
export function floorTagHTML(S, floorId) {
  const f = floorById(S, floorId);
  if (!f) return "";
  return `<span class="tag floortag" data-floor="${esc(f.id)}" style="background:${esc(f.color)};color:${inkOn(f.color)}">${esc(floorLabel(f))}</span>`;
}
// The first line of a list scoped to a floor: what other floors hold and the way to see it; with SHOW ALL on, the way
// back. Empty when there is nothing to say.
export function scopeLineHTML(S, scope, hidden) {
  const f = floorById(S, scope.floor);
  if (!f) return "";
  if (scope.all) return `<button class="scopeline" type="button" data-scope-all>ALL FLOORS · ONLY ${esc(floorLabel(f))}</button>`;
  return hidden ? `<button class="scopeline" type="button" data-scope-all>+${hidden} ON OTHER FLOORS · SHOW ALL</button>` : "";
}
