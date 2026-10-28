// The floors that are live on the page, by id, and a way to hear about each one as it comes. HQ's is there from the start;
// a floor's copy joins when its modules have loaded. What sits over the rooms (layer/) hooks in here instead of reaching
// into floors/index.js. No DOM.
export const floors = new Map();
const listeners = [];

export function register(id, floor) {
  floors.set(id, floor);
  for (const fn of listeners) fn(floor);
}
// Called for every floor already there and for each one that joins later.
export function onFloor(fn) {
  listeners.push(fn);
  for (const f of floors.values()) fn(f);
}
