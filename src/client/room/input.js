// Pointer input on the room (hover, click to focus a lane) and fitting the canvas to its box.
import { H, TS, W, cv } from "./canvas.js";
import { workers } from "./workers.js";
import { focusChanged } from "../card/card.js";

export let selected = null;
export let hovered = null;

function workerAt(e) {
  const r = cv.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width) * W * TS, ny = ((e.clientY - r.top) / r.height) * H * TS;
  let hit = null;
  for (const w of workers.values()) {
    const sx = w.x * TS, sy = w.y * TS - 6;
    if (nx >= sx + 2 && nx <= sx + 14 && ny >= sy && ny <= sy + 22) if (!hit || w.y > hit.y) hit = w;
  }
  return hit;
}
cv.addEventListener("mousemove", (e) => { const w = workerAt(e); hovered = w?.lane.name ?? null; cv.style.cursor = w ? "pointer" : "default"; });
cv.addEventListener("mouseleave", () => { hovered = null; });
// A worker puts its lane in focus; the empty floor, or Esc, shows everyone again.
cv.addEventListener("click", (e) => {
  const w = workerAt(e);
  select(w ? w.lane.name : null, !!w);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected && !e.target.closest?.("textarea, input")) select(null); });

// The lane in focus (card/card.js shows it over the question column, which then shows only that lane); null for
// everyone. fromRoom: chosen in the room, so on a phone the page goes up to the column to show it.
export function select(name, fromRoom = false) {
  if (name === selected) return;
  selected = name;
  focusChanged(fromRoom);
}

// Desktop: the canvas is as big as the room box allows, keeping its 3:2 shape, so the page never scrolls.
const roomBox = cv.parentElement, roomLegend = roomBox.querySelector(".legend");
function fitRoom() {
  if (!matchMedia("(min-width: 1151px)").matches) { cv.style.width = ""; return; }
  const w = roomBox.clientWidth - 16;
  const h = roomBox.clientHeight - 16 - roomLegend.offsetHeight;
  cv.style.width = Math.max(160, Math.floor(Math.min(w, (h * W) / H))) + "px";
}
new ResizeObserver(fitRoom).observe(roomBox);
