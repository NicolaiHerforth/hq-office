// THE LANES BOARD (MENU › LAYOUT › LANES BOARD, under the office): every lane by name, in the readings the floors use.
// WORKING (green): lanes at work, longest first. WAITING ON YOU (red): lanes with an open question or TO DO, oldest
// first, with what they ask. NOT MOVING (amber): everything else that is not parked or done (waiting on HQ, on CI,
// at a prompt, agent gone), stuck longest first, with why. Parked and done lanes are counted, not listed. Inside a
// floor it shows that floor's lanes, like the office; in the building, every floor's, each with its floor's colour.
// A row selects its lane: the worker card opens over the office. Long WORKING lists fold into a row of names, so the
// other two keep the height.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { ago, esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { STATUS_TEXT } from "../core/status.js";
import { floorById, multi } from "../core/floors.js";
import { officeFloor } from "../core/scope.js";
import { select, selected } from "../room/input.js";


const FOLD = 8; // more working lanes than this: names only
const QUIET = new Set(["done", "parked"]);
const box = $("lanesBoard");

function lanesHere() {
  const f = multi(S) ? officeFloor() : null;
  return { lanes: f ? S.lanes.filter((l) => l.floor === f) : S.lanes, floor: f, tag: multi(S) && !f };
}
const since = (t) => (t ? `<span class="lbt" data-since="${t}" data-ago>${ago(Date.now() - t)}</span>` : `<span class="lbt"></span>`);
const swatch = (l, tag) => (tag ? `<i class="lbsw" style="background:${esc(floorById(S, l.floor)?.color ?? "#888")}" title="${esc(floorById(S, l.floor)?.name ?? "")}"></i>` : "");
function row(l, tag, text, at) {
  return `<button class="lbrow${selected === l.name ? " on" : ""}" type="button" data-lane-pick="${esc(l.name)}">${swatch(l, tag)}<b class="lbn">${esc(l.name)}</b><span class="lbx">${text}</span>${since(at)}</button>`;
}
function chip(l, tag, at) {
  return `<button class="lbchip${selected === l.name ? " on" : ""}" type="button" data-lane-pick="${esc(l.name)}">${swatch(l, tag)}<b class="lbn">${esc(l.name)}</b>${since(at)}</button>`;
}
function col(kind, head, items, empty, body) {
  return `<section class="lbcol ${kind}" aria-label="${head}"><h3><i class="lbsig" aria-hidden="true"></i>${head}<em>${items.length}</em></h3>${items.length ? body : `<p class="lbempty">${empty}</p>`}</section>`;
}

export function renderBoard() {
  if (!S || document.documentElement.dataset.layout !== "board") return;
  const { lanes, floor, tag } = lanesHere();
  const oldestAsk = new Map();
  for (const a of S.open) if (a.lane) oldestAsk.set(a.lane, Math.min(oldestAsk.get(a.lane) ?? Infinity, a.created_at));
  const askOf = (l) => S.open.filter((a) => a.lane === l.name).sort((a, b) => a.created_at - b.created_at)[0];
  const working = lanes.filter((l) => l.status === "moving").sort((a, b) => (a.herdr_since ?? 0) - (b.herdr_since ?? 0) || a.name.localeCompare(b.name));
  const you = lanes.filter((l) => l.status === "needs_you").sort((a, b) => oldestAsk.get(a.name) - oldestAsk.get(b.name));
  const still = lanes.filter((l) => !QUIET.has(l.status) && l.status !== "moving" && l.status !== "needs_you")
    .sort((a, b) => (a.herdr_since ?? a.updated_at ?? 0) - (b.herdr_since ?? b.updated_at ?? 0));
  const parked = lanes.filter((l) => l.status === "parked").length, done = lanes.filter((l) => l.status === "done").length;
  const fold = working.length > FOLD;
  const fl = floor ? floorById(S, floor) : null;
  setHTML(box, `<header class="lbhead"><h2>LANES</h2><span class="lbwhere">${fl ? `on ${esc(fl.name)}, by` : multi(S) ? "on every floor, by" : "By"} what they are doing now</span><span class="lbfoot">${parked} PARKED · ${done} DONE</span></header>
    <div class="lbcols">`
    + col("lbwork", "WORKING", working, "Nothing is working right now.", fold
      ? `<div class="lbchips">${working.map((l) => chip(l, tag, l.herdr_since)).join("")}</div>`
      : working.map((l) => row(l, tag, mdInline(l.title || "", { links: false }), l.herdr_since)).join(""))
    + col("lbyou", "WAITING ON YOU", you, "Nothing waits on you.", you.map((l) => row(l, tag, mdInline(askOf(l)?.title || l.title || "", { links: false }), oldestAsk.get(l.name))).join(""))
    + col("lbstill", "NOT MOVING", still, "Every lane is working, waiting on you, or done.", still.map((l) => row(l, tag, esc(STATUS_TEXT[l.status]?.[0] ?? l.status), l.herdr_since ?? l.updated_at)).join(""))
    + `</div>`);
}

box.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lane-pick]");
  if (b) select(b.dataset.lanePick === selected ? null : b.dataset.lanePick);
});
on("state", renderBoard);
on("scope", renderBoard);
on("layout", renderBoard);
on("select", renderBoard);
renderBoard();
