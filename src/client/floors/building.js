// THE BUILDING: every floor at a glance, as a grid of tiles that fits the stage (2 across up to four floors, then 3,
// 4 on a wide screen; rows share the height, so every row shows). A tile leads with the readings, big and plain: its
// label row (slot A "! N" or "Zz N", the name, slot B's working bars), its HQ, then what waits on you and work
// happening or NOTHING MOVING; its frame takes slot A's colour. A small still picture of its office (room/still.js)
// sits beside the facts. A floor whose HQ is not running carries its fix instead of the readings. Then + ADD A FLOOR.
// A click enters the floor. On a phone a tile is a 44 px row; a tap opens its picture, its HQ and ENTER.
// A tile's picture is drawn again only when what it shows changes (its lanes, its HQ, the theme or the season) and
// only while the building shows: no frame loop, no live canvas per tile.
import { esc, setHTML } from "../core/format.js";
import { MOOD_WORD, floorsOf, hqMood, hqShown, needsFix, readingBigHTML, readingLineHTML, readingOf, slotAHTML, slotBHTML, worstOf } from "../core/floors.js";
import { STILL_H, STILL_W, drawStill, stillKey } from "../room/still.js";
import { fixHTML } from "./list.js";

const tiles = new Map(); // floor id -> { el, canvas, key }
let grid = null, slot = null;

// A phone shows each floor as a 44 px row: a tap on it opens its picture and ENTER, instead of going in.
const phone = matchMedia("(max-width: 1150px)");
function tile(f) {
  let t = tiles.get(f.id);
  if (t) return t;
  const el = document.createElement("div");
  el.className = "ftile";
  el.dataset.floor = f.id;
  el.innerHTML = `<button class="tgo" type="button" data-floor-go="${esc(f.id)}"></button>`
    + `<div class="tin"><div class="tfacts"></div><span class="tscene"><canvas class="fstill" width="${STILL_W}" height="${STILL_H}" aria-hidden="true"></canvas></span></div>`
    + `<span class="tenter" aria-hidden="true">ENTER ›</span><button class="tenterb" type="button" data-floor-go="${esc(f.id)}">ENTER ›</button>`;
  // Before the page's click (floors/index.js) goes in: on a phone, the row opens and closes.
  el.querySelector(".tgo").addEventListener("click", (e) => {
    if (!phone.matches) return;
    e.stopPropagation();
    const open = el.classList.toggle("pic");
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });
  t = { el, canvas: el.querySelector("canvas"), key: null };
  tiles.set(f.id, t);
  return t;
}

function factsHTML(S, f, now) {
  const mood = hqMood(f), hq = hqShown(f);
  return `<div class="tlabel">${slotAHTML(f.counts, now) || "<span></span>"}<span class="tname" title="${esc(f.name)}"><i class="fsw" style="background:${esc(f.color)}"></i><span class="tnm">${esc(f.name)}</span></span>${slotBHTML(f.counts, now) || "<span></span>"}</div>`
    + `<div class="thq">${hq ? `<span class="thqn">${esc(hq)}</span>` : "HQ"} <span class="hqword mood-${mood}">${MOOD_WORD[mood]}</span></div>`
    + (needsFix(S, f) ? fixHTML(f) : `<div class="treads">${readingBigHTML(f.counts, now)}</div>`)
    + `<div class="tline">${readingLineHTML(f.counts, now)}</div>`;
}

export function renderBuilding(box, S) {
  if (!grid) {
    grid = document.createElement("div");
    grid.className = "bgrid";
    slot = document.createElement("button");
    slot.type = "button";
    slot.className = "fslot";
    slot.dataset.floorAdd = "";
    slot.innerHTML = `<span class="fslotin">+ ADD A FLOOR</span>`;
    box.append(grid);
  }
  const now = Date.now();
  const floors = floorsOf(S);
  for (const id of [...tiles.keys()]) if (!floors.some((f) => f.id === id)) { tiles.get(id).el.remove(); tiles.delete(id); }
  const order = [...floors.map((f) => tile(f).el), slot];
  if (order.length !== grid.children.length || order.some((el, i) => grid.children[i] !== el)) grid.replaceChildren(...order);
  // Columns: 2 up to four floors, then 3 (4 on a wide screen: floors.css); rows share the height.
  const cols = floors.length <= 4 ? "2" : "3";
  if (grid.dataset.cols !== cols) grid.dataset.cols = cols;
  const rows = String(Math.ceil(order.length / Number(cols)));
  if (grid.dataset.rows !== rows) { grid.dataset.rows = rows; grid.style.setProperty("--rows", rows); }
  for (const f of floors) {
    const t = tiles.get(f.id), r = readingOf(f.counts, now);
    const cls = `ftile w-${worstOf(f.counts, now) || "none"} mood-${hqMood(f)}${t.el.classList.contains("pic") ? " pic" : ""}`;
    if (t.el.className !== cls) t.el.className = cls;
    t.el.style.setProperty("--fc", f.color);
    const say = r.blocking ? `${r.blocking} waiting on you` : r.stall ? "nothing moving" : `${r.working} of ${r.active} working`;
    t.el.querySelector(".tgo").setAttribute("aria-label", `Enter the ${f.name} floor: ${say}`);
    setHTML(t.el.querySelector(".tfacts"), factsHTML(S, f, now));
    const lanes = (S.lanes ?? []).filter((l) => l.floor === f.id), open = (S.open ?? []).filter((a) => a.floor === f.id);
    const key = stillKey(f, lanes, open);
    if (t.key !== key) {
      t.key = key;
      drawStill(t.canvas, f, lanes, open);
    }
  }
}
