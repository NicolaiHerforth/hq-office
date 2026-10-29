// FLOORS on the page (docs/floors.md, "The page" and "The floor UI rules"): one switcher row over the office, never
// two and never wrapping. On the left the pill: the floor you are in (slot A: "! N" waiting on you or "Zz N" nothing
// moving; its name in the text font; slot B: a green bar per working lane; ▾), or BUILDING with the office's slots.
// Inside a floor: ◀ BUILDING and EDIT. On the right the readings in words (what waits on you, work happening or
// NOTHING MOVING), or, for a floor whose HQ is not running, why and its fix (START ITS HQ, PICK ANOTHER). The pill
// opens the floor list (floors/list.js). With two or more floors the top bar has a FLOORS box: a pip per floor in its
// worst state, and how many lanes work. Inside a floor the office's border takes its colour and one row under the
// question tabs says where the lists are: [Backend ×] +3 waiting on other floors · SHOW ALL. THE BUILDING is
// floors/building.js, the add and edit panel floors/panel.js. Esc and the ✕ step out one level. On a phone the row sits
// under the top bar and the list is a bottom sheet.
import { on } from "../core/bus.js";
import { $, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { post } from "../core/net.js";
import { esc, setHTML } from "../core/format.js";
import { MOOD_WORD, floorById, floorsOf, hqMood, inkOn, moodLine, multi, needsFix, officeOf, readingChipsHTML, readingOf, slotAHTML, slotBHTML, stallKey, worstOf } from "../core/floors.js";
import { enter, officeFloor, outOne, scope, settle, toBuilding, toggleAll } from "../core/scope.js";
import { PANELS } from "../questions/drafts.js";
import { syncWorkers } from "../room/workers.js";
import { renderBuilding } from "./building.js";
import { closePanel, openPanel, panelOpen } from "./panel.js";
import { closeList, fixHTML, listOpen, openList, renderList, toggleList } from "./list.js";

const stage = document.querySelector(".stage");
const make = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), { className: cls }, attrs);

// The switcher row and the floor list, in one box: first on the stage, or under the top bar on a narrow screen.
const nav = make("nav", "floornav", { ariaLabel: "Floors" });
const row = make("div", "fswitch");
nav.append(row);
const narrow = matchMedia("(max-width: 1150px)");
function place() {
  if (narrow.matches) { if (nav.previousElementSibling !== document.querySelector(".top")) document.querySelector(".top").after(nav); }
  else if (stage.firstElementChild !== nav) stage.prepend(nav);
}
narrow.addEventListener("change", place);
place();

// With two or more floors: the building, the scope row under the question tabs and the top bar's FLOORS box. Made
// the first time they are needed, so one floor's page is unchanged.
let building = null, scoperow = null, pips = null, wasMulti = null, wasB = null;
function parts() {
  if (building) return;
  building = make("section", "box building", { ariaLabel: "The building" });
  stage.querySelector(":scope > .room").before(building);
  scoperow = make("div", "scoperow", { hidden: true });
  $("qtabs").after(scoperow);
  pips = make("div", "box ffloors", { hidden: true });
  document.querySelector(".top .strip").after(pips);
}

function rowHTML(f, inB, many) {
  const now = Date.now();
  if (inB) {
    const o = officeOf(S);
    return `<button class="fpill fpbuild" type="button" data-pill aria-haspopup="menu" title="Every floor: open the floor list">${slotAHTML(o, now)}<span class="fpname">BUILDING</span>${slotBHTML(o, now)}<span class="fcaret" aria-hidden="true">▾</span></button>`
      + `<span class="freads" aria-label="The whole office">${readingChipsHTML(o, now)}</span>`;
  }
  const mood = hqMood(f), why = moodLine(f);
  return `<button class="fpill mood-${mood}" type="button" data-pill aria-haspopup="menu" style="--fc:${esc(f.color)};--fi:${inkOn(f.color)}" title="${esc(`${f.name} · HQ ${f.hq}: ${MOOD_WORD[mood]}${why ? ` (${why})` : ""}`)}">`
    + `${slotAHTML(f.counts, now)}<i class="fsw" aria-hidden="true"></i><span class="fpname">${esc(f.name)}</span>${slotBHTML(f.counts, now)}<span class="fcaret" aria-hidden="true">▾</span></button>`
    + (many ? `<button class="fbtn fout" type="button" data-building title="Every floor at a glance (Esc)"><span aria-hidden="true">◀</span><span>BUILDING</span></button>` : "")
    + `<button class="fbtn fedit" type="button" data-floor-edit="${esc(f.id)}" aria-label="Edit the ${esc(f.name)} floor">EDIT</button>`
    + (needsFix(S, f) ? fixHTML(f) : `<span class="freads" aria-label="${esc(f.name)}">${readingChipsHTML(f.counts, now)}</span>`);
}

// The top bar's FLOORS box: a pip per floor in its worst state (red waiting on you, amber or red nothing moving,
// green working), each a way in. How many lanes work is the strip's WORKING beside it.
function pipsHTML(now) {
  return `<span class="k">FLOORS</span><span class="v"><span class="pips">${floorsOf(S).map((f) => {
    const w = worstOf(f.counts, now), r = readingOf(f.counts, now);
    const say = r.blocking ? `${r.blocking} waiting on you` : r.stall ? "nothing moving" : `${r.working} working`;
    return `<button class="pip${w ? ` is-${w}` : ""}" type="button" data-floor-tab="${esc(f.id)}" style="--fc:${esc(f.color)}" title="${esc(`${f.name}: ${say}`)}" aria-label="${esc(`${f.name}: ${say}`)}"></button>`;
  }).join("")}</span></span>`;
}

// One row under the question tabs, inside a floor: the floor (its ✕ steps out) and what the other floors hold.
function scopeHTML(f) {
  const all = scope().all;
  const elsewhere = (S.open ?? []).filter((a) => a.floor !== f.id).length;
  const chip = `<span class="schip" style="--fc:${esc(f.color)};color:${inkOn(f.color)}"><span class="fname">${esc(f.name)}</span>${all ? `<span class="fall">· ALL</span>` : ""}<button class="sx" type="button" data-scope-out aria-label="Out of the ${esc(f.name)} floor">×</button></span>`;
  const what = all ? "" : elsewhere ? `+${elsewhere} ON OTHER FLOORS` : "";
  return chip + `<button class="sall" type="button" data-scope-all title="${all ? "Show this floor only" : `${elsewhere} waiting on you on other floors: show every floor's lists`}">`
    + (what ? `<span class="swhat">${what}</span><span class="ssep">·</span>` : "") + `<span class="sgo">${all ? "THIS FLOOR ONLY" : "SHOW ALL"}</span></button>`;
}

// The floor pill's one width: the longest floor name in its font, its slots at their widest, to a cap.
let pillKey = null;
function pillWidth() {
  const names = floorsOf(S).map((f) => f.name), key = names.join("\n");
  if (key === pillKey) return;
  pillKey = key;
  const g = document.createElement("canvas").getContext("2d");
  g.font = `700 15px ${getComputedStyle(document.body).getPropertyValue("--text") || "sans-serif"}`;
  const longest = Math.max(0, ...names.map((n) => g.measureText(n).width));
  // padding and border 20, slot A 44, the swatch 10, slot B 34, the caret 10, five gaps of 6
  nav.style.setProperty("--pillw", `${Math.ceil(Math.min(longest, 260) + 148)}px`);
}

let lastStall = "";
function draw() {
  if (!S) return;
  const now = Date.now();
  lastStall = stallKey(S, now);
  const many = multi(S);
  // The office's lanes change with the number of floors: one floor's office holds every lane.
  if (wasMulti !== null && wasMulti !== many) syncWorkers(true);
  wasMulti = many;
  const f = floorById(S, officeFloor()) ?? (many ? null : floorsOf(S)[0]);
  const inB = many && !officeFloor();
  pillWidth();
  setHTML(row, f || inB ? rowHTML(f, inB, many) : "");
  row.querySelector("[data-pill]")?.setAttribute("aria-expanded", String(listOpen()));
  if (many) parts();
  const mode = !many ? null : inB ? "building" : "floor";
  if ((stage.dataset.floors ?? null) !== mode) { if (mode) stage.dataset.floors = mode; else stage.removeAttribute("data-floors"); }
  if (many && !inB) stage.style.setProperty("--fc", f.color); else stage.style.removeProperty("--fc");
  renderList(nav);
  if (!building) return;
  pips.hidden = !many;
  if (many) {
    setHTML(pips, pipsHTML(now));
    pips.classList.toggle("idle", floorsOf(S).some((x) => readingOf(x.counts, now).stall) && !officeOf(S).blocking);
  }
  const inF = many && !inB;
  scoperow.hidden = !inF;
  if (inF) {
    setHTML(scoperow, scopeHTML(f));
    scoperow.classList.toggle("hot", !scope().all && (S.open ?? []).some((a) => a.floor !== f.id));
  }
  // Back in the building: its top, wherever it was scrolled.
  if (inB) { renderBuilding(building, S); if (wasB === false) building.scrollTop = 0; }
  wasB = inB;
}

on("state", () => { settle(); draw(); });
// Feature folders load after the page's first state may already be in.
if (S) { settle(); draw(); }
on("settings", draw);
// The pill's width is measured in the text font: again once the font is in.
document.fonts?.ready.then(() => { pillKey = null; draw(); });
// The page clock: a stall shows after 3 minutes and reddens after 20. Redraw only when one of those steps changes.
on("tick", () => {
  if (!S || stallKey(S) === lastStall) return;
  draw();
  for (const [, render] of PANELS) render();
});
// Another floor, the building, or SHOW ALL: every list and count, and the office, again.
// Another floor or the building: the question list starts at its top, and on a phone the page keeps the switcher in
// view (it scrolls only when the row would be off screen: no jump).
let lastFloor = officeFloor();
on("scope", () => {
  for (const [, render] of PANELS) render();
  syncWorkers(true);
  draw();
  if (officeFloor() === lastFloor) return;
  lastFloor = officeFloor();
  $("hud").scrollTop = 0;
  if (narrow.matches) {
    const top = nav.getBoundingClientRect().top;
    if (top < 0 || top > innerHeight - nav.offsetHeight) scrollTo({ top: Math.max(0, scrollY + top - 8), behavior: "instant" });
  }
});

// START ITS HQ: the server starts hq-<id> in a new herdr tab and makes it the floor's HQ.
async function startItsHq(btn) {
  const f = floorById(S, btn.dataset.floorStart);
  if (!f) return;
  const all = () => document.querySelectorAll(`[data-floor-start="${CSS.escape(f.id)}"]`);
  for (const b of all()) { b.disabled = true; b.dataset.was = b.innerHTML; b.textContent = "STARTING…"; }
  try {
    const r = await post(`/api/floors/${encodeURIComponent(f.id)}`, { start: true });
    toast(r?.waiting ? `HQ-${f.id.toUpperCase()} STARTED, BUT WAITS ON A PROMPT IN ITS HERDR PANE: ANSWER IT THERE.` : `HQ-${f.id.toUpperCase()} STARTED FOR ${f.name.toUpperCase()}.`);
  } catch (err) {
    toast(err.message);
    for (const b of all()) { b.disabled = false; if (b.dataset.was) b.innerHTML = b.dataset.was; }
  }
}

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-pill], [data-building], [data-floor-tab], [data-floor-go], [data-floor-add], [data-floor-edit], [data-floor-pick], [data-floor-start], [data-scope-all], [data-scope-out], [data-list-close]");
  if (!t || !S) {
    // A click anywhere else closes the floor list.
    if (listOpen() && !e.target.closest?.(".fmenu")) closeList(false);
    return;
  }
  if (t.matches("[data-pill]")) { toggleList(); return; }
  if (t.matches("[data-list-close]")) { closeList(true); return; }
  if (t.matches("[data-floor-start]")) { startItsHq(t); return; }
  if (listOpen()) closeList(false);
  if (t.matches("[data-scope-all]")) toggleAll();
  else if (t.matches("[data-scope-out]")) outOne();
  else if (t.matches("[data-building]")) toBuilding();
  else if (t.matches("[data-floor-tab]")) { if (multi(S)) enter(t.dataset.floorTab); }
  else if (t.matches("[data-floor-go]")) enter(t.dataset.floorGo);
  else if (t.matches("[data-floor-add]")) openPanel({ mode: "add" });
  else if (t.matches("[data-floor-edit]")) openPanel({ mode: "edit", id: t.dataset.floorEdit });
  else if (t.matches("[data-floor-pick]")) openPanel({ mode: "edit", id: t.dataset.floorPick, focus: "hq" });
});
// A lane's tag (on a question, a message, the card) selects its worker: on another floor, go there first so the
// office shows it. Before the click that selects it (core/clicks.js).
document.addEventListener("click", (e) => {
  const sel = e.target.closest?.("[data-select]");
  if (!sel || !S || !multi(S)) return;
  const lane = S.lanes.find((l) => l.name === sel.dataset.select);
  if (lane?.floor && lane.floor !== officeFloor()) enter(lane.floor);
}, true);

// Esc: the floor panel closes first, then the floor list; then one level out (SHOW ALL off, then out of the floor).
// Not while typing, in SETTINGS, a conference room or a preview.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (panelOpen()) { e.preventDefault(); closePanel(); return; }
  if (listOpen()) { e.preventDefault(); closeList(true); return; }
  const el = document.activeElement;
  if (el?.matches?.("input, textarea, select, [contenteditable]") || el?.closest?.("[data-rbox]")) return;
  if (!$("settings").hidden || stage.classList.contains("inroom") || document.querySelector(".preview:not([hidden])")) return;
  if (outOne()) e.preventDefault();
});
// Down on the pill opens the list at its first row.
row.addEventListener("keydown", (e) => {
  if (e.target.matches("[data-pill]") && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openList(); }
});
