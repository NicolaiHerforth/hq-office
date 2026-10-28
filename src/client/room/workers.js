// One worker per lane: where each one should be, and syncing them with the state.
import { S } from "../core/state.js";
import { hash } from "../core/format.js";
import { dressWorkers } from "./looks.js";
import { settings } from "../settings/prefs.js";
import { on } from "../core/bus.js";
import { COUCH, DONE_SPOT, HQ_SPOT, OVERFLOW, QUEUE, SEATS, WAIT_SPOT, slot } from "./spots.js";
import { rebuildBlocked, route } from "./collision.js";
import { isIdle } from "./breakroom.js";
import { multi } from "../core/floors.js";
import { officeFloor } from "../core/scope.js";

export const workers = new Map(); // name -> { x, y, path, dir, step, t, lane, seat, pal, bob }
// With floors the office is the floor you are in: its lanes only, and none while the building shows (docs/floors.md).
export function officeLanes() {
  if (!multi(S)) return S.lanes;
  const f = officeFloor();
  return f ? S.lanes.filter((l) => l.floor === f) : [];
}

// Who works at a desk: a lane that is moving, blocked or gone (the default in targetFor).
const AWAY_FROM_DESK = new Set(["needs_you", "hq_turn", "stale", "waiting", "parked", "done"]);
const atDesk = (lane) => !AWAY_FROM_DESK.has(lane.status);

// Desks hold one worker each. A worker at a desk keeps it while it stays there. A worker sitting down takes the desk
// its name points to (a hash, so it does not depend on the other lanes), or the next free one; desks are handed out in
// name order, so the same lanes always get the same desks. With more workers at desks than desks, the rest stand in
// the aisles (OVERFLOW), by name.
function assignDesks(lanes) {
  const desk = new Map();
  const aisle = new Map(); // lane -> where it stands without a desk
  const taken = new Map(); // seat index -> lane name
  const index = (seat) => SEATS.indexOf(seat);
  const sitting = lanes.filter(atDesk).sort((a, b) => a.name.localeCompare(b.name));
  for (const lane of sitting) {
    const kept = workers.get(lane.name)?.seat;
    const i = kept ? index(kept) : -1;
    if (i >= 0 && !taken.has(i)) { taken.set(i, lane.name); desk.set(lane.name, SEATS[i]); }
  }
  let overflow = 0;
  for (const lane of sitting) {
    if (desk.has(lane.name)) continue;
    let i = hash(lane.name) % SEATS.length;
    for (let k = 0; k < SEATS.length && taken.has(i); k++) i = (i + 1) % SEATS.length;
    if (!taken.has(i)) {
      taken.set(i, lane.name);
      desk.set(lane.name, SEATS[i]);
    } else {
      desk.set(lane.name, null);
      aisle.set(lane.name, slot(OVERFLOW, overflow++));
    }
  }
  return { desks: desk, aisle };
}

function targetFor(lane, seat, aisle, counts) {
  const st = lane.status;
  if (st === "needs_you") return { at: slot(QUEUE, counts.queue++), face: "up" };
  if (st === "hq_turn" || st === "stale") return { at: slot(HQ_SPOT, counts.hq++), face: "left" };
  if (st === "waiting") return { at: slot(WAIT_SPOT, counts.wait++), face: "down" };
  if (st === "parked") return { at: slot(COUCH, counts.couch++), face: "down" };
  if (st === "done") return { at: slot(DONE_SPOT, counts.done++), face: "down" };
  return { at: seat ?? aisle.get(lane.name), face: "up" }; // moving, blocked or gone: at its desk, or in the aisle
}

// Where each lane's worker belongs: its seat, and the spot its status puts it at (the queue, HQ, the couch...).
// Shared by the live office and the building's still renders (room/still.js).
export function placeLanes(lanes, open = S.open) {
  // queue order: oldest open ask first
  const oldest = new Map();
  for (const a of open) if (a.lane) oldest.set(a.lane, Math.min(oldest.get(a.lane) ?? Infinity, a.created_at));
  const ordered = [...lanes].sort((a, b) => (oldest.get(a.name) ?? Infinity) - (oldest.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));
  // seatIndex numbers the lanes by name for the costumes (a player's number); desks come from assignDesks.
  const seatIndex = new Map([...lanes].sort((a, b) => a.name.localeCompare(b.name)).map((l, i) => [l.name, i]));
  const { desks, aisle } = assignDesks(lanes);
  const counts = { queue: 0, hq: 0, wait: 0, couch: 0, done: 0 };
  const places = ordered.map((lane) => {
    const seat = desks.get(lane.name) ?? null;
    return { lane, seat, ...targetFor(lane, seat, aisle, counts) };
  });
  return { places, seatIndex };
}

export function syncWorkers(initial) {
  const lanes = officeLanes();
  const names = new Set(lanes.map((l) => l.name));
  for (const n of [...workers.keys()]) if (!names.has(n)) workers.delete(n);
  rebuildBlocked(lanes.length);
  const { places, seatIndex } = placeLanes(lanes);
  for (const { lane, seat, at, face } of places) {
    let w = workers.get(lane.name);
    if (!w) {
      w = { x: at.x, y: at.y, path: [], dir: face, step: 0, t: 0, pal: null, bob: hash(lane.name) % 1000 };
      workers.set(lane.name, w);
    }
    if (!isIdle(lane)) w.brain = null;
    if (w.brain) { w.lane = lane; continue; } // the break room decides where idle workers go
    const prevTarget = w.target;
    w.lane = lane;
    // A lane away from its desk (queue, HQ, couch...) keeps the desk it had, so it comes back to the same one.
    if (atDesk(lane)) w.seat = seat;
    w.face = face;
    w.target = at;
    if (initial) { w.x = at.x; w.y = at.y; w.dir = face; w.path = []; }
    else if (!prevTarget || prevTarget.x !== at.x || prevTarget.y !== at.y) w.path = route(w, at);
    if (isIdle(lane)) w.brain = { nextAt: 0, act: null, acting: false, until: 0 };
  }
  dressWorkers(workers, lanes, settings.theme, seatIndex);
}

// The theme changed: dress again (the room wakes on "settings" itself).
on("settings", () => {
  if (!S) return;
  const lanes = officeLanes();
  dressWorkers(workers, lanes, settings.theme, new Map([...lanes].sort((a, b) => a.name.localeCompare(b.name)).map((l, i) => [l.name, i])));
});
