// One floor's room, as the page uses it: the page asks for the ring, the state, the size and whether it is in sight, and
// listens for a click; it never reaches into the room's other modules. HQ's floor is the page's own graph (boot.js feeds
// it); a floor's copy is this file loaded from /floor/<id>/..., with its own canvas, workers, loop and bus.
import { emit, on } from "../core/bus.js";
import { CONFIG, setCONFIG, setS } from "../core/state.js";
import { HQ } from "../core/floors.js";
import { TS, cv } from "./canvas.js";
import { fitTo, select } from "./input.js";
import { labelBoxes, showRoom } from "./loop.js";
import { syncWorkers, workers } from "./workers.js";
import { FLOOR } from "./here.js";

// The lanes and questions this copy last built its workers from: boot.js replaces them when they change.
let lanes = null, open = null;

export const floor = {
  id: FLOOR,
  canvas: cv,
  select, // the ring on a worker by name, or on none (null)
  onWorker: (fn) => on("worker", fn), // a click on a worker, with its name
  onDraw: (fn) => on("room:draw", fn), // after every frame this floor draws
  // Where each worker's sprite is now (its top-left corner) and every label's box, in the scene's units (the room is
  // 384 by 256): what the layer over the room keeps clear of.
  positions: () => [...workers.values()].map((w) => ({ name: w.lane.name, sx: Math.round(w.x * TS), sy: Math.round(w.y * TS - 6) })),
  labels: labelBoxes,
  // A copy takes the page's state; HQ's floor already has it.
  load(state) {
    if (FLOOR === HQ) return;
    setS(state);
    setCONFIG(state.config ?? CONFIG);
    if (state.lanes !== lanes || state.open !== open) {
      syncWorkers(lanes === null);
      lanes = state.lanes;
      open = state.open;
    }
    emit("state", state);
  },
  show: showRoom, // false while the floor is out of sight: its loop rests
  // The page's "stage" event (a conference room covers the office), passed on to a copy.
  stage(shown) { if (FLOOR !== HQ) emit("stage", shown); },
  fitTo, // the box the canvas fits (width and height); null gives the canvas back to the room's own rule
};
