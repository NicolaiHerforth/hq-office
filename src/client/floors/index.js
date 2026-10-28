// The floors on the page. A click on a worker chooses that agent (core/scope.js); the chosen agent gets the room's ring
// on its floor; Escape steps the scope out one level. HQ's floor is the page's own room; with a second floor the stage
// becomes the building (building.js): every floor a live tile, a click on a tile zooms into it and scopes to it, and
// ◀ ALL FLOORS or BUILDING zoom out. A floor other than HQ's is the room's modules loaded again from /floor/<id>/...
// (room/floor.js), so it has its own canvas, workers and frame loop; a floor out of sight rests. With one floor none of
// this adds anything to the page.
import { on } from "../core/bus.js";
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { floor as hq } from "../room/floor.js";
import { chooseAgent, outOne, scope, setFloor } from "../core/scope.js";
import { closePanel, openPanel } from "../core/panel.js";
import { HQ, escapeAction, floorList, floorOfLane, floorsInView, stageBar, stageMode } from "../core/floors.js";
import { arrange, boxes, build, built, canvasRect, copyCanvas, dismantle, ensureBar, gridEl, moving, paintBar, paintLabels, paintMode, room } from "./building.js";
import { floors, register } from "./registry.js";

register(hq.id, hq);
const loading = new Set(), failed = new Set();
const sight = new Map(); // id -> whether the floor was last told it is in sight (all are, until told otherwise)
let zoomed; // the floor zoomed into (null: the building), as last laid out; undefined before the first layout
let stageShown = "office";

// A click on a worker chooses it once a floor is zoomed into; in the building a click anywhere on a tile zooms in.
const worker = (name) => { if (stageMode(S, scope()) !== "out") chooseAgent(name, { jump: true }); };
hq.onWorker(worker);

// Each floor rings the agent when it is on that floor, and no one otherwise.
function ring() {
  if (!S) return;
  const agent = scope().agent, at = floorOfLane(S, agent);
  for (const [id, f] of floors) f.select(agent && at === id ? agent : null);
}

// A floor's copy: its canvas first, then its modules from their own prefix.
function load(id) {
  if (floors.has(id) || loading.has(id) || failed.has(id)) return;
  loading.add(id);
  copyCanvas(id);
  import(`/floor/${encodeURIComponent(id)}/src/client/room/floor.js`).then(({ floor }) => {
    // A path the browser resolves elsewhere (an id of "..") would hand back another floor's copy: not this floor.
    if (floor.id !== id) throw new Error(`the copy at /floor/${id}/ is the ${floor.id} floor`);
    register(id, floor);
    floor.onWorker(worker);
    floor.stage(stageShown);
    floor.load(S);
    apply();
  }).catch((e) => { failed.add(id); console.error(`the ${id} floor did not load`, e); });
}

// The bar is always on the stage (its slot holds RUNDOWN); its buttons show with two floors.
ensureBar().addEventListener("click", (e) => { if (e.target.closest("[data-zoomout], [data-building]")) setFloor(null); });

function wire() {
  gridEl().addEventListener("click", (e) => {
    const tile = e.target.closest(".tile");
    if (tile && stageMode(S, scope()) === "out") setFloor(tile.dataset.floor);
  });
}

// The floor grows from where its tile was, or shrinks back to it: its canvas and the layer over it together.
function flip(id, from) {
  const to = canvasRect(id);
  if (!to?.width || !from?.width || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const frames = [{ transformOrigin: "0 0", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width})` }, { transformOrigin: "0 0", transform: "none" }];
  // While it moves it takes no clicks: a floor shrinking back to its tile would otherwise cover the tiles around it.
  for (const el of moving(id)) {
    const done = () => { el.style.pointerEvents = ""; };
    el.style.pointerEvents = "none";
    el.animate(frames, { duration: 380, easing: "cubic-bezier(.2,.7,.2,1)" }).finished.then(done, done);
  }
}

// Lay the stage out for the state and the scope: the building, a floor, or (one floor) today's room.
function apply() {
  if (!S) return;
  const sc = scope(), mode = stageMode(S, sc);
  if (mode === "single") {
    if (built()) { dismantle(); hq.fitTo(null); zoomed = undefined; }
  } else {
    const ids = floorList(S).map((f) => f.id);
    if (!built()) { build(); wire(); }
    for (const id of ids) if (id !== HQ) load(id);
    arrange(ids, hq.canvas);
    paintLabels(S, ids);
    const at = sc.floor, from = zoomed !== undefined && at !== zoomed ? canvasRect(at ?? zoomed) : null;
    paintMode(at);
    if (from) room().parentElement.scrollTop = 0; // the floor chosen, or the building, is seen from its top
    const box = boxes(ids, at);
    for (const [id, f] of floors) if (box[id]) f.fitTo(box[id]);
    if (from) flip(at ?? zoomed, from);
    zoomed = at;
  }
  paintBar(stageBar(S, sc));
  // A floor out of sight draws nothing; a floor told once is not told again.
  const seen = floorsInView(S, sc);
  for (const [id, f] of floors) {
    const shown = seen.includes(id);
    if ((sight.get(id) ?? true) !== shown) { sight.set(id, shown); f.show(shown); }
  }
  ring();
}

on("state", () => {
  apply();
  for (const [id, f] of floors) if (id !== HQ) f.load(S);
});
on("scope", apply);
new ResizeObserver(apply).observe(room());

// Caught before the room's own Escape (rooms/), which would otherwise act on the same key press.
let stage = false;
on("stage", (shown) => {
  stage = shown !== "office";
  stageShown = shown;
  for (const f of floors.values()) f.stage(shown);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const f = document.activeElement;
  const busy = {
    stage,
    settings: !$("settings").hidden,
    dialog: !!document.querySelector("dialog[open]"),
    // A reply box keeps Escape for itself while anything in it has focus, its buttons too: it closes first.
    typing: !!f?.matches?.("input, textarea, select, [contenteditable]") || !!f?.closest?.("[data-rbox]"),
    panel: openPanel() !== null,
  };
  const action = escapeAction(scope(), busy);
  if (!action) return;
  e.preventDefault();
  if (action === "panel") closePanel(); else outOne();
}, true);
