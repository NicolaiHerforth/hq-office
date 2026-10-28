// The layer over each floor's room: project frames on the wall and a marker beside every agent that needs help, drawn on
// a canvas of its own over the room's (the room's pixels are never touched). Zoomed in, the frames and markers are also
// buttons: a marker chooses its agent, a frame is a project. Zoomed out, a click anywhere on a floor zooms in, so the
// layer is only a picture. Where things go is layer/place.js; who gets one is core/floors.js.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { scope } from "../core/scope.js";
import { FRAMES_MAX, HELP_COLORS, HELP_NAMES, frameName, frames, helpMarks, stageMode } from "../core/floors.js";
import { esc } from "../core/format.js";
import { onFloor } from "../floors/registry.js";
import { wrap } from "../floors/building.js";
import { RH, RW, TERMINAL, frameBox, frameSlots, placeMarks } from "./place.js";

// Three by five pixel signs: "!" waiting on you, "?" waiting on HQ, "#" blocked, "~" stalled.
const GLYPH = { waiting: ["010", "010", "010", "000", "010"], hq: ["111", "001", "011", "000", "010"], blocked: ["111", "111", "111", "111", "111"], stalled: ["000", "000", "101", "010", "000"] };

const layers = new Map(); // floor id -> { floor, box, ovl, hits, key }
const slots = frameSlots(FRAMES_MAX);

function rect(g, k, x, y, w, h, c) {
  g.fillStyle = c;
  g.fillRect(Math.round(x * k), Math.round(y * k), Math.round(w * k), Math.round(h * k));
}
function drawFrame(g, k, f) {
  const { x, y, w, h } = f;
  rect(g, k, x + w / 2 - 1, y - 3, 2, 2, "#3c3c5a");
  rect(g, k, x - 1, y - 1, w + 2, h + 2, "#5a3a22");
  rect(g, k, x, y, w, h, "#c8a060");
  rect(g, k, x + 2, y + 2, w - 4, h - 4, f.color);
  for (let i = 0; i < 3; i++) rect(g, k, x + 3 + i * 3, y + h - 3 - [2, 4, 3][i], 2, [2, 4, 3][i], "rgba(255,255,255,0.8)");
}
function drawMark(g, k, m) {
  const { x, y, w, h } = m.box, u = w / 7;
  rect(g, k, x, y, w, h, "#23233a");
  rect(g, k, x + u, y + u, w - 2 * u, h - 2 * u, HELP_COLORS[m.state]);
  GLYPH[m.state].forEach((row, i) => [...row].forEach((on, j) => { if (on === "1") rect(g, k, x + 2 * u + j * u, y + 2 * u + i * u, u, u, "#ffffff"); }));
}

const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`;
const place = (b) => `left:${pct(b.x, RW)};top:${pct(b.y, RH)};width:${pct(b.w, RW)};height:${pct(b.h, RH)}`;

function make(floor) {
  const scene = wrap(floor.id, floor.canvas);
  const box = Object.assign(document.createElement("div"), { className: "layer" });
  box.dataset.floor = floor.id;
  const ovl = Object.assign(document.createElement("canvas"), { className: "ovl", width: floor.canvas.width, height: floor.canvas.height });
  ovl.setAttribute("aria-hidden", "true");
  const hits = Object.assign(document.createElement("div"), { className: "hits" });
  box.append(ovl, hits);
  scene.append(box);
  // The layer lies exactly over the room's canvas, wherever the scene puts it.
  const fit = () => {
    const c = floor.canvas, css = `left:${c.offsetLeft}px;top:${c.offsetTop}px;width:${c.offsetWidth}px;height:${c.offsetHeight}px`;
    if (fitted !== css) box.style.cssText = fitted = css;
  };
  let fitted = "";
  const ro = new ResizeObserver(fit);
  ro.observe(floor.canvas);
  ro.observe(scene);
  fit();
  return { floor, box, ovl, hits, key: null, hitsHtml: "", fit };
}

// A floor's layer, painted again only when what it shows changes: the frames and their states, who is marked and where,
// and whether the floor is zoomed into.
function draw(L) {
  if (!S) return;
  L.fit();
  const { floor } = L, mode = stageMode(S, scope());
  const zoomedIn = mode !== "out", live = mode === "single" || (mode === "in" && scope().floor === floor.id);
  const wall = frames(S, floor.id).map((f, i) => ({ ...f, ...slots[i] }));
  const marked = helpMarks(S, floor.id, zoomedIn);
  const sprites = floor.positions(), at = new Map(sprites.map((p) => [p.name, p]));
  const agents = marked.map((m) => ({ ...m, ...(m.head ? TERMINAL : at.get(m.lane)) })).filter((m) => m.sx !== undefined);
  const marks = placeMarks({ agents, sprites, labels: floor.labels(), zoomedIn });
  const key = JSON.stringify([live, wall.map((f) => [f.slug, f.title, f.state, f.calls]), marks.map((m) => [m.lane, m.state, m.box.x, m.box.y])]);
  if (key === L.key) return;
  L.key = key;
  const g = L.ovl.getContext("2d"), k = L.ovl.width / RW;
  g.clearRect(0, 0, L.ovl.width, L.ovl.height);
  L.box.dataset.frames = wall.map((f) => f.slug).join(" ");
  L.box.dataset.marks = marks.map((m) => m.lane).join(" ");
  wall.forEach((f) => drawFrame(g, k, f));
  marks.forEach((m) => drawMark(g, k, m));
  // Buttons only where a click is wanted: zoomed in, on the floor the page shows. They are made again only when which buttons
  // there are or what they say changes; a marked agent walking only moves its button, so a click, hover or focus survives it.
  const buttons = !live ? [] : [
    ...wall.map((f) => {
      const name = frameName(f);
      return { box: frameBox(f), html: `<button class="hit frame" type="button" data-project="${esc(f.slug)}" aria-label="${esc(name)}" title="${esc(name)}">${f.calls ? `<span class="tag count">${f.calls}</span>` : ""}</button>` };
    }),
    ...marks.map((m) => {
      const name = `${m.lane}: ${HELP_NAMES[m.state]}`;
      return { box: m.box, html: `<button class="hit agent" type="button" data-select="${esc(m.lane)}" data-state="${m.state}" aria-label="${esc(name)}" title="${esc(name)}"></button>` };
    }),
  ];
  const html = buttons.map((b) => b.html).join("");
  if (html !== L.hitsHtml) {
    L.hits.innerHTML = html;
    L.hitsHtml = html;
  }
  [...L.hits.children].forEach((el, i) => {
    const style = place(buttons[i].box);
    if (el.getAttribute("style") !== style) el.setAttribute("style", style);
  });
}

onFloor((floor) => {
  const L = make(floor);
  layers.set(floor.id, L);
  floor.onDraw(() => draw(L));
  draw(L);
});
const all = () => { for (const L of layers.values()) draw(L); };
on("state", all);
on("scope", all);

// The legend under the floor says what the two new signs mean.
const legend = document.querySelector(".room > .legend");
if (legend) {
  const row = (color, glyph, text) => `<span><i style="background:${color};color:#fff">${glyph}</i>${text}</span>`;
  legend.lastElementChild.insertAdjacentHTML("beforebegin", row(HELP_COLORS.blocked, "#", "BLOCKED") + row(HELP_COLORS.stalled, "~", "STALLED"));
}
