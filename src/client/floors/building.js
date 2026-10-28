// THE BUILDING: a grid of floors, each a tile with its name tag in its colour, its need-you dots, its HQ's state and
// ZOOM IN ›, over a small picture of its office drawn by the room's own code (room/still.js), then a + ADD A FLOOR
// slot and a legend: CLICK A FLOOR TO ZOOM IN. A tile's picture is drawn again only when what it shows changes (its
// lanes, its HQ, the theme or the season) and only while the building shows: no frame loop, no live canvas per tile.
// The layout follows the building frame in PR #8.
import { esc, setHTML } from "../core/format.js";
import { MOOD_TEXT, floorLabel, floorsOf, hqMood, inkOn, moodLine, needDotsHTML } from "../core/floors.js";
import { STILL_H, STILL_W, drawStill, stillKey } from "../room/still.js";

const tiles = new Map(); // floor id -> { el, canvas, key }
let grid = null, slot = null, legend = null;

const LEGEND = `<b class="lhead">CLICK A FLOOR TO ZOOM IN</b>
  <span class="lrow"><span class="fneed"><i></i></span>WAITING ON YOU</span>
  <span class="lrow"><span class="fmark starting">STARTING</span>ITS NEW HQ IS STARTING IN HERDR</span>
  <span class="lrow"><span class="fmark down">!</span>ITS HQ STOPPED RECEIVING</span>
  <span class="ltext">A floor is one HQ agent and everything it runs. + FLOOR adds one: an agent that already runs, or a new HQ the HUD starts for you. Esc steps back out.</span>`;

function tile(f) {
  let t = tiles.get(f.id);
  if (t) return t;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ftile";
  el.dataset.floor = el.dataset.floorGo = f.id;
  el.innerHTML = `<span class="tlabel"></span><span class="tscene"><canvas class="fstill" width="${STILL_W}" height="${STILL_H}" aria-hidden="true"></canvas></span><span class="tfoot"></span>`;
  t = { el, canvas: el.querySelector("canvas"), key: null };
  tiles.set(f.id, t);
  return t;
}

export function renderBuilding(box, S) {
  if (!grid) {
    grid = document.createElement("div");
    grid.className = "bgrid";
    slot = document.createElement("button");
    slot.type = "button";
    slot.className = "ftile fslot";
    slot.dataset.floorAdd = "";
    slot.innerHTML = `<span class="fslotin">+ ADD A FLOOR</span>`;
    legend = document.createElement("div");
    legend.className = "flegend";
    legend.innerHTML = LEGEND;
    box.append(grid);
  }
  const floors = floorsOf(S);
  for (const id of [...tiles.keys()]) if (!floors.some((f) => f.id === id)) { tiles.get(id).el.remove(); tiles.delete(id); }
  const order = [...floors.map((f) => tile(f).el), slot, legend];
  if (order.length !== grid.children.length || order.some((el, i) => grid.children[i] !== el)) grid.replaceChildren(...order);
  for (const f of floors) {
    const t = tiles.get(f.id), c = f.counts ?? {}, mood = hqMood(f), line = moodLine(f);
    t.el.className = `ftile mood-${mood}`;
    t.el.style.setProperty("--fc", f.color);
    t.el.setAttribute("aria-label", `Zoom into the ${f.name} floor: ${c.needsYou ?? 0} waiting on you${line ? `, ${line}` : ""}`);
    const mark = mood === "down" ? `<span class="fmark down">HQ ISN'T RECEIVING</span>` : MOOD_TEXT[mood] ? `<span class="fmark ${mood}">${MOOD_TEXT[mood]}</span>` : "";
    setHTML(t.el.querySelector(".tlabel"), `<span class="tag floortag" style="background:${esc(f.color)};color:${inkOn(f.color)}">${esc(floorLabel(f))}</span>`
      + (c.needsYou ? `<span class="tag count">${c.needsYou}</span>` : "") + needDotsHTML(Math.min(c.needsYou ?? 0, 5)) + mark + `<span class="zoom">ZOOM IN ›</span>`);
    setHTML(t.el.querySelector(".tfoot"), `<span>HQ: ${esc(f.hq)}</span><span>${c.lanes ?? 0} ${c.lanes === 1 ? "LANE" : "LANES"} · ${c.working ?? 0} WORKING${c.blocked ? ` · <b class="hot">${c.blocked} BLOCKED</b>` : ""}</span>`
      + (line ? `<span class="twhy mood-${mood}">${esc(line)}</span>` : ""));
    const lanes = (S.lanes ?? []).filter((l) => l.floor === f.id), open = (S.open ?? []).filter((a) => a.floor === f.id);
    const key = stillKey(f, lanes, open);
    if (t.key !== key) {
      t.key = key;
      drawStill(t.canvas, f, lanes, open);
    }
  }
}
