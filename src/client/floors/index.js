// FLOORS on the page (docs/floors.md): the floor bar, always on the stage (BUILDING with two or more floors, a tab per
// floor in its colour with its need-you dots and its HQ's state, + FLOOR), and inside a floor its header over the
// office (◀ ALL FLOORS · NAME FLOOR · HQ: agent · N need you), the page framed in its colour and a scope chip under the
// question tabs. THE BUILDING is floors/building.js, the add and edit panel floors/panel.js. Esc and the chip's ✕ step
// out one level. On a phone the bar and the header sit under the top bar, the bar a row of tabs that scrolls sideways.
// The navigation is adapted from PR #8 (the stage bar, the floor tabs, the zoomed floor's header, the
// scope chip and the coloured page border); a floor here is one HQ agent, from S.floors.
import { on } from "../core/bus.js";
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { esc, setHTML } from "../core/format.js";
import { MOOD_TEXT, floorById, floorLabel, floorsOf, hqMood, inkOn, moodLine, multi, needDotsHTML } from "../core/floors.js";
import { enter, officeFloor, outOne, scope, settle, toBuilding, toggleAll } from "../core/scope.js";
import { PANELS } from "../questions/drafts.js";
import { syncWorkers } from "../room/workers.js";
import { renderBuilding } from "./building.js";
import { closePanel, openPanel, panelOpen } from "./panel.js";

const stage = document.querySelector(".stage");
const make = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), { className: cls }, attrs);

// The bar and the header, in one box: first on the stage, or under the top bar on a narrow screen.
const nav = make("nav", "floornav", { ariaLabel: "Floors" });
const bar = make("div", "floorbar");
const head = make("div", "floorhead", { hidden: true });
nav.append(bar, head);
const narrow = matchMedia("(max-width: 1150px)");
function place() {
  if (narrow.matches) { if (nav.previousElementSibling !== document.querySelector(".top")) document.querySelector(".top").after(nav); }
  else if (stage.firstElementChild !== nav) stage.prepend(nav);
}
narrow.addEventListener("change", place);
place();

// The building (two or more floors), the page's frame and the scope chip: made the first time they are needed.
let building = null, frame = null, chip = null, wasMulti = null;
function parts() {
  if (building) return;
  building = make("section", "box building", { ariaLabel: "The building" });
  stage.querySelector(":scope > .room").before(building);
  frame = make("div", "floorframe", { hidden: true });
  document.body.append(frame);
  chip = make("button", "scopechip", { type: "button", hidden: true });
  chip.addEventListener("click", outOne);
  $("qtabs").after(chip);
}

const tabHTML = (f, current, many) => {
  const mood = hqMood(f), line = moodLine(f);
  const mark = mood === "down" ? `<span class="fmark down" aria-label="HQ isn't receiving">!</span>`
    : MOOD_TEXT[mood] ? `<span class="fmark ${mood}">${MOOD_TEXT[mood]}</span>` : "";
  const need = f.counts?.needsYou ?? 0;
  return `<span class="ftab mood-${mood}${current ? " on" : ""}" data-floor="${esc(f.id)}" style="--fc:${esc(f.color)};--fi:${inkOn(f.color)}">`
    + `<button class="ftgo" type="button" data-floor-tab="${esc(f.id)}"${current ? ` aria-current="true"` : ""} title="${esc(`${f.name} · HQ ${f.hq}${need ? ` · ${need} need you` : ""}${line ? ` · ${line}` : ""}`)}">`
    + `<b>${esc(floorLabel(f))}</b>${needDotsHTML(need)}${mark}</button>`
    + (current ? `<button class="ftedit" type="button" data-floor-edit="${esc(f.id)}" aria-label="Edit the ${esc(f.name)} floor">EDIT</button>` : "")
    + `</span>`;
};

function draw() {
  if (!S) return;
  const many = multi(S);
  // The office's lanes change with the number of floors: one floor's office holds every lane.
  if (wasMulti !== null && wasMulti !== many) syncWorkers(true);
  wasMulti = many;
  const f = floorById(S, officeFloor());
  const inB = many && !f;
  const current = many ? f?.id : floorsOf(S)[0]?.id;
  setHTML(bar, (many ? `<button class="fbtn fbuild${inB ? " on" : ""}" type="button" data-building aria-pressed="${inB}">BUILDING</button>` : "")
    + `<span class="ftabs">${floorsOf(S).map((x) => tabHTML(x, x.id === current, many)).join("")}</span>`
    + `<button class="fbtn fadd" type="button" data-floor-add>+ FLOOR</button>`);
  if (many) parts();
  const mode = !many ? null : f ? "floor" : "building";
  if ((stage.dataset.floors ?? null) !== mode) { if (mode) stage.dataset.floors = mode; else stage.removeAttribute("data-floors"); }
  head.hidden = !f;
  if (f) {
    const need = f.counts?.needsYou ?? 0, mood = hqMood(f);
    setHTML(head, `<button class="fbtn fout" type="button" data-building>◀ ALL FLOORS</button>`
      + `<i class="fsw" style="background:${esc(f.color)}"></i><b class="fhname">${esc(floorLabel(f))} FLOOR</b>`
      + `<span class="fhsep">·</span><span class="fhq">HQ: ${esc(f.hq)}</span>`
      + `<span class="fhsep">·</span><span class="fhneed${need ? " hot" : ""}">${need} NEED${need === 1 ? "S" : ""} YOU</span>`
      + (MOOD_TEXT[mood] ? `<span class="fmark ${mood}">${MOOD_TEXT[mood]}</span><span class="fhwhy">${esc(moodLine(f))}</span>` : "")
      + `<button class="fbtn fhedit" type="button" data-floor-edit="${esc(f.id)}">EDIT</button>`);
    stage.style.setProperty("--fc", f.color);
  } else stage.style.removeProperty("--fc");
  if (!building) return;
  // The page framed in the floor's colour, and the chip that names the scope.
  frame.hidden = !f;
  chip.hidden = !f;
  if (f) {
    frame.style.borderColor = f.color;
    chip.style.setProperty("--fc", f.color);
    chip.style.color = inkOn(f.color);
    chip.setAttribute("aria-label", `In the ${f.name} floor: step out`);
    setHTML(chip, `${esc(floorLabel(f))} FLOOR${scope().all ? " · ALL" : ""} <span aria-hidden="true">×</span>`);
  }
  if (inB) renderBuilding(building, S);
}

on("state", () => { settle(); draw(); });
// Feature folders load after the page's first state may already be in.
if (S) { settle(); draw(); }
on("settings", draw);
// Another floor, the building, or SHOW ALL: every list and count, and the office, again.
on("scope", () => {
  for (const [, render] of PANELS) render();
  syncWorkers(true);
  draw();
});

document.addEventListener("click", (e) => {
  const t = e.target.closest?.("[data-building], [data-floor-tab], [data-floor-go], [data-floor-add], [data-floor-edit], [data-scope-all]");
  if (!t || !S) return;
  if (t.matches("[data-scope-all]")) toggleAll();
  else if (t.matches("[data-building]")) toBuilding();
  else if (t.matches("[data-floor-tab]")) { if (multi(S)) enter(t.dataset.floorTab); }
  else if (t.matches("[data-floor-go]")) enter(t.dataset.floorGo);
  else if (t.matches("[data-floor-add]")) openPanel({ mode: "add" });
  else if (t.matches("[data-floor-edit]")) openPanel({ mode: "edit", id: t.dataset.floorEdit });
});
// A lane's tag (on a question, a message, the card) selects its worker: on another floor, go there first so the
// office shows it. Before the click that selects it (core/clicks.js).
document.addEventListener("click", (e) => {
  const sel = e.target.closest?.("[data-select]");
  if (!sel || !S || !multi(S)) return;
  const lane = S.lanes.find((l) => l.name === sel.dataset.select);
  if (lane?.floor && lane.floor !== officeFloor()) enter(lane.floor);
}, true);

// Esc: the floor panel closes first; then one level out (SHOW ALL off, then out of the floor). Not while typing, in
// SETTINGS, a conference room or a preview.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (panelOpen()) { e.preventDefault(); closePanel(); return; }
  const el = document.activeElement;
  if (el?.matches?.("input, textarea, select, [contenteditable]") || el?.closest?.("[data-rbox]")) return;
  if (!$("settings").hidden || stage.classList.contains("inroom") || document.querySelector(".preview:not([hidden])")) return;
  if (outOne()) e.preventDefault();
});
