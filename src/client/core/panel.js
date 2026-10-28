// Panels over the room (accounts, the project panel, later PARTY and RUNDOWN) take turns: at most one is open. Opening one
// says so on the bus ("panel", id, detail) and every other panel that is open closes itself; Escape closes the open one
// before it touches the scope. This file only knows which is open. No DOM.
import { emit } from "./bus.js";

let open = null;
export const openPanel = () => open;
// Open a panel (null closes whatever is open). `detail` goes to the panel opened, such as the project's slug.
export function showPanel(id, detail) {
  open = id ?? null;
  emit("panel", open, detail);
}
// Close `id` if it is the one open; with no id, close whichever is.
export function closePanel(id) {
  if (id === undefined || open === id) showPanel(null);
}
