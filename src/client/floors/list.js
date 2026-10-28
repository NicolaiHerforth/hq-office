// The floor list, opened from the switcher's pill: a dropdown under it on a desktop, a bottom sheet on a phone.
// BUILDING (the overview, with the office's readings) first, then a row per floor (its colour, its name in the text
// font, its HQ and the HQ's state, and its readings: what waits on you, and work happening or NOTHING MOVING; EDIT on
// hover or focus), then + ADD A FLOOR. A floor whose HQ is not running carries its fix in its row: START ITS HQ and
// PICK ANOTHER. Arrow keys move between the rows, Home and End to the ends, Enter goes, Esc closes (floors/index.js).
// Drawn only while open, and again only when what it shows changes.
import { esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { S } from "../core/state.js";
import { MOOD_WORD, floorsOf, hqMood, hqShown, moodLine, multi, needsFix, officeOf, readingLineHTML, slotAHTML, slotBHTML } from "../core/floors.js";
import { officeFloor } from "../core/scope.js";

let open = false, box = null, back = null, host = null;
export const listOpen = () => open;

const items = () => (box ? [...box.querySelectorAll("[role=menuitem]")] : []);
const pill = () => host?.querySelector("[data-pill]");

// The fix for a floor whose HQ is not running, wherever the floor shows (its pill's row, its list row, its tile).
export function fixHTML(f) {
  const why = f.starting ? `**${f.hq}** is not running in herdr${f.notStarted ? ": it never started" : ""}.` : `**${f.hq}** stopped: it is not running in herdr.`;
  return `<span class="ffix"><span class="ffwhy">${mdInline(why, { links: false })}</span>`
    + `<button class="btn-s ffgo" type="button" data-floor-start="${esc(f.id)}" aria-label="Start its HQ"><span class="wl">START ITS HQ</span><span class="ws">START HQ</span></button>`
    + `<button class="btn-s" type="button" data-floor-pick="${esc(f.id)}" aria-label="Pick another HQ"><span class="wl">PICK ANOTHER</span><span class="ws">PICK</span></button></span>`;
}

function html() {
  const now = Date.now(), here = officeFloor();
  const many = multi(S);
  const building = many
    ? `<div class="flrow fbrow${here ? "" : " on"}"><button class="fli" type="button" role="menuitem" data-building${here ? "" : ` aria-current="true"`}>`
      + `<span class="flid">${slotAHTML(officeOf(S), now)}<span class="flname">BUILDING</span>${slotBHTML(officeOf(S), now)}</span><span class="flhq">every floor at a glance</span><span class="flreads">${readingLineHTML(officeOf(S), now)}</span></button></div>`
    : "";
  const rows = floorsOf(S).map((f) => {
    const mood = hqMood(f), on = many ? f.id === here : true;
    return `<div class="flrow${on ? " on" : ""}" data-floor="${esc(f.id)}" style="--fc:${esc(f.color)}">`
      + `<button class="fli" type="button" role="menuitem" data-floor-tab="${esc(f.id)}"${on ? ` aria-current="true"` : ""} title="${esc(f.name)}">`
      + `<span class="flid">${slotAHTML(f.counts, now)}<i class="fsw" aria-hidden="true"></i><span class="flname">${esc(f.name)}</span>${slotBHTML(f.counts, now)}</span>`
      + `<span class="flhq">${hqShown(f) ? `${esc(f.hq)} · ` : "HQ "}<span class="hqword mood-${mood}">${MOOD_WORD[mood]}</span></span>`
      + `<span class="flreads">${readingLineHTML(f.counts, now)}</span></button>`
      + `<button class="fledit" type="button" data-floor-edit="${esc(f.id)}" aria-label="Edit the ${esc(f.name)} floor">EDIT</button>`
      + (needsFix(S, f) ? fixHTML(f) : mood === "down" ? `<span class="ffix"><span class="ffwhy down">${mdInline(moodLine(f), { links: false })}</span></span>` : "")
      + `</div>`;
  }).join("");
  return `<div class="flhead"><b>FLOORS</b><button class="fpx" type="button" data-list-close aria-label="Close">✕</button></div>`
    + building + rows
    + `<div class="flrow fadd"><button class="fli" type="button" role="menuitem" data-floor-add><span class="flname">+ ADD A FLOOR</span></button></div>`;
}

export function renderList(nav) {
  host = nav;
  if (!open || !box) return;
  const focused = document.activeElement && box.contains(document.activeElement)
    ? [...box.querySelectorAll("button")].indexOf(document.activeElement) : -1;
  if (setHTML(box, html()) && focused >= 0) box.querySelectorAll("button")[focused]?.focus();
}

function make() {
  box = document.createElement("div");
  box.className = "fmenu";
  box.setAttribute("role", "menu");
  box.setAttribute("aria-label", "Floors");
  box.hidden = true;
  back = document.createElement("div");
  back.className = "fsheetbg";
  back.hidden = true;
  back.dataset.listClose = "";
  host.append(back, box);
  box.addEventListener("keydown", (e) => {
    const list = items(), i = list.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
  });
}

export function openList() {
  if (!host || !S) return;
  if (!box) make();
  open = true;
  box.hidden = back.hidden = false;
  renderList(host);
  pill()?.setAttribute("aria-expanded", "true");
  (box.querySelector("[aria-current]") ?? items()[0])?.focus();
}
export function closeList(refocus) {
  if (!open) return;
  open = false;
  box.hidden = back.hidden = true;
  pill()?.setAttribute("aria-expanded", "false");
  if (refocus) pill()?.focus();
}
export const toggleList = () => (open ? closeList(true) : openList());
