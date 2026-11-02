// SPLIT: a brief or a page beside what it opened over, so the owner reads it and keeps the room or the lane in view. On
// a wide stage, over a room or over the office with a lane's drawer open, the stage splits in two: what is under it on
// the left, the brief or the page on the right, and a divider between them (drag it, or the arrow keys; a double-click
// makes it half and half). Once split, a side stays split until it closes, so closing the drawer does not throw it to
// full width. SPLIT and SINGLE in its bar are each viewer's own, kept in this browser as LAYOUT is. Over the bare
// office, on a narrow screen, or in SINGLE, the side takes the stage alone and BACK returns to what is under it. The
// address says what is open, never which of these (core/stage.js).
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { emit, on } from "../core/bus.js";
import { current, keepSideWhen } from "../core/stage.js";

const MIN = 400, BAR = 14, WIDE = 860; // a pane's least width, the divider's, the stage's least width to split
const stage = document.querySelector(".stage");
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, String(v)); } catch {} };
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

let single = stored("hq-split") === "single";
let ratio = Number(stored("hq-split-ratio")) || 0.5; // the left pane's share of the stage
let held = false;
let shown = false;

const bar = document.createElement("div");
bar.className = "splitbar";
bar.tabIndex = 0;
bar.setAttribute("role", "separator");
bar.setAttribute("aria-orientation", "vertical");
bar.setAttribute("aria-label", "Divider: drag it or use the arrow keys; double-click for half and half");
stage.append(bar);

const desk = matchMedia("(min-width: 1151px)");
const side = () => stage.querySelector(":scope > .briefview:not([hidden]), :scope > .pageview:not([hidden])");
const base = () => !!stage.querySelector(":scope > .roomview:not([hidden])") || !$("card").hidden || held;
const wide = () => desk.matches && stage.clientWidth >= WIDE;
// A brief from another floor than the room's has entered its own floor: it shows alone, and BACK returns to the room.
function sameFloor(v) {
  const slug = current().room, f = v.dataset.floor;
  const rf = slug && f ? S?.rooms?.find((r) => r.slug === slug)?.floor : null;
  return !rf || rf === f;
}

function layout() {
  const v = side(), can = !!v && wide() && base() && sameFloor(v), split = can && !single;
  held = !!v && (held || split);
  stage.classList.toggle("cansplit", can);
  stage.classList.toggle("split", split);
  place();
  if (split !== shown) { shown = split; emit("split", split); }
}
// The share as the stage can take it, each pane at least MIN wide; the owner's own share is kept for a wider stage.
const fit = (r) => { const least = Math.min(0.5, MIN / Math.max(1, stage.clientWidth - BAR)); return Math.min(1 - least, Math.max(least, r)); };
function place() {
  stage.style.setProperty("--split", fit(ratio).toFixed(4));
  bar.setAttribute("aria-valuenow", String(Math.round(fit(ratio) * 100)));
}
const resize = (r) => { ratio = fit(r); place(); };
const keep = () => store("hq-split-ratio", ratio === 0.5 ? null : ratio.toFixed(4));

// A room opened from beside a side keeps it there.
keepSideWhen(() => !single && wide() && !!side());

document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-split-toggle]")) return;
  single = !single;
  store("hq-split", single ? "single" : null);
  layout();
});
bar.addEventListener("pointerdown", (e) => {
  if (e.button) return;
  e.preventDefault();
  bar.focus();
  bar.setPointerCapture(e.pointerId);
  stage.classList.add("dragging");
});
bar.addEventListener("pointermove", (e) => {
  if (!bar.hasPointerCapture(e.pointerId)) return;
  const r = stage.getBoundingClientRect();
  resize((e.clientX - r.left - BAR / 2) / (r.width - BAR));
});
const drop = () => { if (stage.classList.contains("dragging")) { stage.classList.remove("dragging"); keep(); } };
bar.addEventListener("pointerup", drop);
bar.addEventListener("lostpointercapture", drop);
bar.addEventListener("dblclick", () => { resize(0.5); keep(); });
bar.addEventListener("keydown", (e) => {
  const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
  if (!step) return;
  e.preventDefault();
  resize(ratio + step);
  keep();
});

// What shows, and a brief's floor once it has loaded.
new MutationObserver(layout).observe(stage, { subtree: true, attributes: true, attributeFilter: ["hidden", "data-floor"] });
new ResizeObserver(layout).observe(stage);
desk.addEventListener("change", layout);
on("nav", layout);
on("state", layout);
layout();
