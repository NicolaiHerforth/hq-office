// The scope: which floor the page is in, and SHOW ALL. With two or more floors the stage shows the building (no floor)
// or one floor's office, and the lists follow the floor you are in unless SHOW ALL is on. With one floor there is no
// scope: every getter here answers as the page did before floors. Kept in sessionStorage so a reload keeps it, and
// dropped when it no longer holds (its floor is gone). A change emits "scope" on the bus; floors/ draws it again.
// Adapted from the scope in PR #8.
import { emit } from "./bus.js";
import { S } from "./state.js";
import { floorById, multi } from "./floors.js";

const KEY = "hq-scope";
let cur = { floor: null, all: false };
try {
  const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
  if (v && typeof v.floor === "string") cur = { floor: v.floor, all: v.all === true };
} catch {}

// What holds now: a floor that is gone, or one floor in all, is no floor.
export function scope() {
  const floor = S && multi(S) && floorById(S, cur.floor) ? cur.floor : null;
  return { floor, all: !!floor && cur.all };
}
function set(next) {
  if (next.floor === cur.floor && next.all === cur.all) return;
  cur = next;
  try { cur.floor ? sessionStorage.setItem(KEY, JSON.stringify(cur)) : sessionStorage.removeItem(KEY); } catch {}
  emit("scope", scope());
}
// Drop a kept scope that no longer holds (called with each state).
export function settle() { if (S && cur.floor && !scope().floor) set({ floor: null, all: false }); }

// The floor whose office the stage shows; null for the building (or the only office, with one floor).
export const officeFloor = () => scope().floor;
// Two or more floors and no floor entered: the stage shows the building.
export const inBuilding = () => !!S && multi(S) && !scope().floor;
// The floor the lists show; null for every floor (the building, SHOW ALL, or one floor).
export const listFloor = () => { const s = scope(); return s.all ? null : s.floor; };
// Lists that show every floor tag each card with its floor.
export const tagged = () => !!S && multi(S) && !listFloor();
// A list's rows in scope, and how many are left out.
export const pick = (list) => { const f = listFloor(); return f ? (list ?? []).filter((x) => x.floor === f) : list ?? []; };
export const others = (list) => { const f = listFloor(); return f ? (list ?? []).filter((x) => x.floor !== f).length : 0; };

export const enter = (id) => set({ floor: id ?? null, all: id ? cur.all && cur.floor === id : false });
export const toBuilding = () => set({ floor: null, all: false });
export const toggleAll = () => { const s = scope(); if (s.floor) set({ floor: s.floor, all: !s.all }); };
// Esc and the scope chip's ✕: one level out. SHOW ALL off first, then out of the floor to the building. Says whether
// there was a level to step out of.
export function outOne() {
  const s = scope();
  if (s.all) set({ floor: s.floor, all: false });
  else if (s.floor) set({ floor: null, all: false });
  else return false;
  return true;
}
