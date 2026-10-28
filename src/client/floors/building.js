// The building's DOM and sizes: the stage bar, a tile per floor (its label and the scene its canvas lives in), and the
// box each floor's canvas fits. The bar is always there, over the room: with one floor it holds only what other panels put in
// its slot (RUNDOWN). The tiles are made the first time there are two floors and taken down when there is one again, so a
// page with one floor is today's room under that bar. What the scope is and which floors there are come from
// core/floors.js; this file only draws and measures.
import { esc, setHTML } from "../core/format.js";
import { HELP_COLORS, canvasId, floorLabel } from "../core/floors.js";

const GAP = 10; // between tiles
const PAD = 16; // the room's padding, both sides
const TILE_FRAME = 12; // a zoomed-out tile's border and padding, both sides (floors.css)
const BUILDING_CHROME = 260; // what the screen keeps from the building's width on a laptop: the signed frame's 100dvh - 260
const ZOOM_CHROME = 330; // and from a zoomed floor's height: 100dvh - 330, at 3:2
const DESKTOP = "(min-width: 1151px)";
const ONE_COLUMN = "(max-width: 600px)";

let parts = null; // { grid, room, tiles: Map(id -> tile) } while built
let bar = null; // the stage bar, made once
const scenes = new Map(); // id -> the scene holding a floor's canvas; kept when the building comes down, because a copy's module keeps its canvas

const make = (tag, cls, html = "") => Object.assign(document.createElement(tag), { className: cls, innerHTML: html });

export const built = () => !!parts;
export const room = () => parts?.room ?? document.querySelector(".stage .room");

// The scene of a floor: a box with its canvas. A copy's canvas is made here, before its module is loaded.
export function scene(id) {
  let s = scenes.get(id);
  if (!s) {
    s = make("div", "scene");
    s.dataset.floor = id;
    scenes.set(id, s);
  }
  return s;
}
// A floor's canvas lives in its scene, and so does whatever the page lays over it (layer/). HQ's canvas is the page's own,
// so its scene is made round it where it stands: before the legend in the room, or in its tile.
export function wrap(id, canvas) {
  const s = scene(id);
  if (canvas.parentElement !== s) {
    if (!s.isConnected) canvas.before(s);
    s.append(canvas);
  }
  return s;
}
export function copyCanvas(id) {
  const s = scene(id);
  let c = s.querySelector("canvas");
  if (!c) {
    c = document.createElement("canvas");
    c.id = canvasId(id);
    s.append(c);
  }
  return c;
}

// The stage bar over the room: ◀ ALL FLOORS and BUILDING (shown only with two floors) and a slot for panels' buttons.
export function ensureBar() {
  if (bar) return bar;
  bar = make("div", "stagebar", `<button class="btn zout" type="button" data-zoomout hidden>◀ ALL FLOORS</button><button class="btn place" type="button" data-building hidden>BUILDING</button><span class="stageslot"></span>`);
  document.querySelector(".stage").prepend(bar);
  return bar;
}

// Put the building in: a grid in the room, HQ's canvas into its tile.
export function build() {
  const roomEl = document.querySelector(".stage .room");
  const grid = make("div", "building");
  roomEl.prepend(grid);
  parts = { grid, room: roomEl, tiles: new Map() };
}

// Take it down: HQ's scene (its canvas and the layer) goes back where it was, before the legend.
export function dismantle() {
  if (!parts) return;
  const { grid, room: roomEl } = parts;
  roomEl.insertBefore(scene("hq"), roomEl.querySelector(".legend"));
  roomEl.removeAttribute("data-stage");
  grid.remove();
  parts = null;
}

// The tiles, one per floor in the order given, each holding its floor's scene; HQ's scene takes the page's own canvas.
export function arrange(ids, hqCanvas) {
  const { grid, tiles } = parts;
  for (const id of ids) {
    if (tiles.has(id)) continue;
    const t = make("div", "tile", `<button class="tlabel" type="button"></button>`);
    t.dataset.floor = id;
    t.append(scene(id));
    tiles.set(id, t);
  }
  for (const [id, t] of tiles) if (!ids.includes(id)) { t.remove(); tiles.delete(id); }
  const hq = scene("hq");
  if (hqCanvas.parentElement !== hq) hq.append(hqCanvas);
  const order = ids.map((id) => tiles.get(id));
  if (order.some((t, i) => grid.children[i] !== t) || grid.children.length !== order.length) grid.replaceChildren(...order);
}

// Each tile's label: the floor's tag, what waits on you there, who needs help.
export function paintLabels(S, ids) {
  for (const id of ids) {
    const f = floorLabel(S, id);
    const help = f.help.map((h) => `<i class="dot" style="background:${HELP_COLORS[h.state]}" title="${esc(h.lane)}"></i>`).join("");
    const label = parts.tiles.get(id).querySelector(".tlabel");
    label.setAttribute("aria-label", `Zoom into the ${f.label} floor: ${f.waiting} waiting on you, ${f.help.length} need help`);
    setHTML(label, `<span class="tag floortag" style="background:${f.color}">${esc(f.label)}</span>${f.waiting ? `<span class="tag count">${f.waiting}</span>` : ""}${help}`);
    parts.tiles.get(id).style.setProperty("--fc", f.color);
  }
}

// Zoomed out (`zoomed` null) or into one floor.
export function paintMode(zoomed) {
  const { room: roomEl, tiles } = parts;
  roomEl.dataset.stage = zoomed ? "in" : "out";
  for (const [id, t] of tiles) t.classList.toggle("on", id === zoomed);
}
// The bar's buttons follow core/floors.js's stageBar: none with one floor (`state` null).
export function paintBar(state) {
  const b = ensureBar().querySelector("[data-building]");
  bar.querySelector("[data-zoomout]").hidden = !state?.back;
  b.hidden = !state;
  b.classList.toggle("on", !!state?.building);
  b.setAttribute("aria-current", String(!!state?.building));
}

// The box each floor's canvas fits, and the building's width, as the signed frame sizes them. Zoomed out a tile is as
// wide as the room allows two to a row, and the building no wider than the screen is tall less its chrome; zoomed in
// the floor is as wide as the room, and no taller than the screen leaves it. On a laptop the stage scrolls for the rest
// (floors.css), so no size depends on the room's own height. A box with an infinite height is limited by its width alone.
export function boxes(ids, zoomed) {
  const { room: roomEl, grid } = parts;
  const desktop = matchMedia(DESKTOP).matches;
  const width = roomEl.clientWidth - PAD;
  if (zoomed) {
    grid.style.width = "";
    return { [zoomed]: { width: desktop ? Math.min(width, (innerHeight - ZOOM_CHROME) * 1.5) : width, height: Infinity } };
  }
  const cols = matchMedia(ONE_COLUMN).matches || ids.length < 2 ? 1 : 2;
  let w = (width - (cols - 1) * GAP) / cols;
  if (desktop) w = Math.min(w, (innerHeight - BUILDING_CHROME - (cols - 1) * GAP) / cols);
  w = Math.max(80, Math.floor(w));
  grid.style.width = `${w * cols + (cols - 1) * GAP}px`;
  return Object.fromEntries(ids.map((id) => [id, { width: w - TILE_FRAME, height: Infinity }]));
}

// A floor's canvas, and where it is on screen (null before it has one).
export const canvasOf = (id) => scenes.get(id)?.querySelector(":scope > canvas") ?? null;
// What moves when a floor grows from its tile: the canvas and the layer over it.
export const moving = (id) => [canvasOf(id), scenes.get(id)?.querySelector(":scope > .layer")].filter(Boolean);
export const canvasRect = (id) => canvasOf(id)?.getBoundingClientRect() ?? null;
export const gridEl = () => parts?.grid ?? null;
