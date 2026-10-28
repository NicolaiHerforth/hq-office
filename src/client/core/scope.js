// The scope: what the page is zoomed into, one state for every list and count. { floor, agent, all }: the floor
// zoomed into, the lane chosen, and SHOW ALL (lists unfiltered while the floor stays). Every change emits "scope" on
// the bus with { scope, jump }. Panels read view() and render again from "scope"; none calls another. No DOM code.
// Kept in sessionStorage so a reload or the page's autoreload keeps it, and a new tab starts unscoped.
import { emit, on } from "./bus.js";
import { S } from "./state.js";
import { askScope, floorList, floorOfLane, hasLane, normalizeScope, viewOf } from "./floors.js";

const KEY = "hq-scope";
const none = () => ({ floor: null, agent: null, all: false });
let cur = none();

const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(cur)); } catch {} };
function set(next, jump = false) {
  const changed = JSON.stringify(next) !== JSON.stringify(cur);
  if (!changed && !jump) return;
  cur = next;
  if (changed) save();
  emit("scope", { scope: cur, jump });
}
const clean = (v) => ({ floor: typeof v?.floor === "string" ? v.floor : null, agent: typeof v?.agent === "string" ? v.agent : null, all: v?.all === true });

// Read back what the tab kept, checked against the lanes there are once the state is in.
export function restore() {
  try { cur = clean(JSON.parse(sessionStorage.getItem(KEY))); } catch { cur = none(); }
  if (S) cur = normalizeScope(S, cur);
}

export const scope = () => cur;
export const view = () => viewOf(cur);

// Zoom into a floor and scope to it at once; null zooms all the way out.
export const setFloor = (id) => set({ floor: id ?? null, agent: null, all: false });
// Choose a lane. With two or more floors the scope takes the lane's floor. `jump` asks the question panel to show
// the lane's first open question. A lane the state does not have (a question's tag outlives its lane) is not chosen.
export function chooseAgent(name, { jump = false } = {}) {
  if (S && !hasLane(S, name)) return;
  const floor = S && floorList(S).length >= 2 ? floorOfLane(S, name) : null;
  set({ floor, agent: name, all: false }, jump);
}
// Open one question: scope to its lane (or, with no lane, its floor) and show that question, flashed.
export function openAsk(id) {
  const ask = S?.open.find((a) => a.id === id);
  if (ask) set(askScope(S, ask), id);
}
// Out one level: agent to its floor (with one floor, to nothing), floor to zoomed out.
export function outOne() {
  if (cur.agent) set({ floor: cur.floor, agent: null, all: false });
  else if (cur.floor) set(none());
}
export const allFloors = () => set(none());
// SHOW ALL and back. With nothing scoped there is nothing to lift.
export function toggleAll() {
  if (cur.floor || cur.agent) set({ ...cur, all: !cur.all });
}
export const normalize = (state) => set(normalizeScope(state, cur));

restore();
on("state", normalize);
