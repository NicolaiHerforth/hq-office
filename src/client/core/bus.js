// The page's event channel. A feature listens here instead of being called from another area's file, so adding
// one is adding a folder, not editing boot.js or the room loop.
//
//   "state" (S)      after every /api/state load, once the built-in panels have rendered
//   "tick"           whenever the page clock wakes: only for a visible change, never on a fixed timer
//   "room:draw" (now) at the end of every room frame, after the workers; draw with px() from room/canvas.js
//   "panel" (id, detail) a panel over the room opened (core/panel.js) or all closed (null); a panel that is open and is not
//                    `id` closes itself, so they take turns
//   "settings" (settings) when the owner's settings change, here, on another page or from the server
//   "room:leave"     a feature that shows the floor (the project panel) asks rooms/ to step out of a conference room
const handlers = new Map();

export function on(name, fn) {
  const list = handlers.get(name) ?? handlers.set(name, []).get(name);
  list.push(fn);
  return () => list.splice(list.indexOf(fn), 1);
}

export function emit(name, ...args) {
  const list = handlers.get(name);
  if (!list) return;
  for (const fn of [...list]) {
    try { fn(...args); } catch (e) { console.error(`${name} listener failed`, e); }
  }
}
