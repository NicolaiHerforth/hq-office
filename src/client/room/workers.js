// One worker per lane on this floor (its head is the figure at the terminal): where each one should be, and syncing
// them with the state.
import { S } from "../core/state.js";
import { hash } from "../core/format.js";
import { dressWorkers } from "./looks.js";
import { settings } from "../settings/prefs.js";
import { on } from "../core/bus.js";
import { floorLanes } from "../core/floors.js";
import { FLOOR } from "./here.js";
import { COUCH, DONE_SPOT, HQ_SPOT, QUEUE, SEATS, WAIT_SPOT, slot } from "./spots.js";
import { rebuildBlocked, route } from "./collision.js";
import { isIdle } from "./breakroom.js";

export const workers = new Map(); // name -> { x, y, path, dir, step, t, lane, seat, pal, bob }

function targetFor(lane, i, counts) {
  const st = lane.status;
  if (st === "needs_you") return { at: slot(QUEUE, counts.queue++), face: "up" };
  if (st === "hq_turn" || st === "stale") return { at: slot(HQ_SPOT, counts.hq++), face: "left" };
  if (st === "waiting") return { at: slot(WAIT_SPOT, counts.wait++), face: "down" };
  if (st === "parked") return { at: slot(COUCH, counts.couch++), face: "down" };
  if (st === "done") return { at: slot(DONE_SPOT, counts.done++), face: "down" };
  return { at: SEATS[i % SEATS.length], face: "up" }; // moving or gone: at the desk
}

export function syncWorkers(initial) {
  const lanes = floorLanes(S, FLOOR);
  const names = new Set(lanes.map((l) => l.name));
  for (const n of [...workers.keys()]) if (!names.has(n)) workers.delete(n);
  rebuildBlocked(lanes.length);
  // queue order: oldest open ask first
  const oldest = new Map();
  for (const a of S.open) if (a.lane) oldest.set(a.lane, Math.min(oldest.get(a.lane) ?? Infinity, a.created_at));
  const ordered = [...lanes].sort((a, b) => (oldest.get(a.name) ?? Infinity) - (oldest.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));
  const seatIndex = new Map([...lanes].sort((a, b) => a.name.localeCompare(b.name)).map((l, i) => [l.name, i]));
  const counts = { queue: 0, hq: 0, wait: 0, couch: 0, done: 0 };
  for (const lane of ordered) {
    const seat = seatIndex.get(lane.name);
    const { at, face } = targetFor(lane, seat, counts);
    let w = workers.get(lane.name);
    if (!w) {
      w = { x: at.x, y: at.y, path: [], dir: face, step: 0, t: 0, pal: null, bob: hash(lane.name) % 1000 };
      workers.set(lane.name, w);
    }
    if (!isIdle(lane)) w.brain = null;
    if (w.brain) { w.lane = lane; continue; } // the break room decides where idle workers go
    const prevTarget = w.target;
    w.lane = lane;
    w.seat = SEATS[seat % SEATS.length];
    w.face = face;
    w.target = at;
    if (initial) { w.x = at.x; w.y = at.y; w.dir = face; w.path = []; }
    else if (!prevTarget || prevTarget.x !== at.x || prevTarget.y !== at.y) w.path = route(w, at);
    if (isIdle(lane)) w.brain = { nextAt: 0, act: null, acting: false, until: 0 };
  }
  dressWorkers(workers, S.lanes, settings.theme, seatIndex); // the whole tree, so a look does not change when a general appears
}

// The theme changed: dress again (the room wakes on "settings" itself).
on("settings", () => {
  if (!S) return;
  dressWorkers(workers, S.lanes, settings.theme, new Map(floorLanes(S, FLOOR).sort((a, b) => a.name.localeCompare(b.name)).map((l, i) => [l.name, i])));
});
