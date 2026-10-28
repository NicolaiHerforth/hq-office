// A still picture of one floor's office, for the building's tiles (floors/building.js): the room, the hero at the
// counter, that floor's HQ at the terminal and a worker per lane where its status puts it (at its desk, in the queue,
// on the couch), with its bubble and name. Drawn by the room's own code (px, sprites, labels), with the drawing
// context pointed at a scratch canvas for the length of one call, then copied, smaller, into the tile's canvas.
// No frame loop: a tile is drawn again only when what it shows changes (stillKey).
import { CONFIG } from "../core/state.js";
import { cut } from "../core/floors.js";
import { TS, ctx, cv, px, setCtx } from "./canvas.js";
import { drawSprite } from "./sprites.js";
import { dressWorkers, heroPal, hqPal } from "./looks.js";
import { drawAccessories, wornBy } from "./accessories.js";
import { hero, settings } from "../settings/prefs.js";
import { chosenSeason, setSeason } from "./seasons.js";
import { GLYPH, drawBubble, drawLabel, stillOpaque, stillPicture } from "./scene.js";
import { deskCount } from "./collision.js";
import { placeLanes } from "./workers.js";

let scratch = null;
let fontLoads = 0;
document.fonts?.addEventListener?.("loadingdone", () => { fontLoads++; });

// What a floor's picture is drawn from: when this changes, the tile is drawn again.
export function stillKey(floor, lanes, open) {
  const asks = new Map();
  for (const a of open) if (a.lane) asks.set(a.lane, Math.min(asks.get(a.lane) ?? Infinity, a.created_at));
  return [chosenSeason(), settings.theme, hero().name, CONFIG.owner, fontLoads, floor.hq, floor.starting || floor.receiving === false,
    ...lanes.map((l) => `${l.name}:${l.status}:${l.asks ? 1 : 0}:${l.rank ?? l.depth ?? ""}:${l.parent ?? ""}:${asks.get(l.name) ?? ""}`)].join("|");
}

// Draws the floor `floor` with its `lanes` (and the open questions `open`, for the queue's order) into `target`.
export function drawStill(target, floor, lanes, open) {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = cv.width;
    scratch.height = cv.height;
  }
  const g = scratch.getContext("2d");
  const real = ctx;
  setCtx(g);
  g.imageSmoothingEnabled = false;
  try {
    setSeason(chosenSeason());
    const still = stillPicture(deskCount(lanes.length));
    if (!stillOpaque) g.clearRect(0, 0, scratch.width, scratch.height);
    g.drawImage(still, 0, 0);
    // No event art (pumpkins, stones) in a tile: at this size it competes with the workers.
    const { places, seatIndex } = placeLanes(lanes, open);
    // desk screens lit where a worker sits at work
    for (const { lane, at, seat } of places) {
      if (lane.status !== "moving" || at !== seat) continue;
      const dx = seat.x * TS, dy = (seat.y - 1) * TS;
      px(dx + 4, dy, 8, 6, "#6ad1ff");
      px(dx + 5, dy + 1, 2, 1, "#ffffff");
      px(dx + 5, dy + 3, 5, 1, "#ffffff");
    }
    // the hero behind the counter, the floor's HQ at its terminal
    const me = heroPal();
    drawSprite(me, 20 * TS - 8, 2 * TS - 6, "down", 0);
    drawAccessories(me, wornBy(hero().name, true, me.look?.hides), 20 * TS - 8, 2 * TS - 6, "down", 0);
    px(17 * TS, 3 * TS - 2, 6 * TS, 10, "#c84b4b");
    px(17 * TS, 3 * TS - 2, 6 * TS, 3, "#f08080");
    px(17 * TS, 3 * TS + 8, 6 * TS, 3, "#8a2a2a");
    drawLabel("YOU", 20 * TS, 3 * TS + 10, true);
    drawSprite(hqPal(), 16 * TS, 5 * TS - 6, "up", 0, floor.starting || floor.receiving === false ? 0.3 : 1); // an HQ not there: a ghost
    drawLabel(cut(floor.hq), 16 * TS + 8, 5 * TS + 10, true);
    // the workers, dressed as the office dresses them, back to front
    const figures = new Map(places.map((p) => [p.lane.name, {}]));
    dressWorkers(figures, lanes, settings.theme, seatIndex);
    for (const { lane, at, face } of [...places].sort((a, b) => a.at.y - b.at.y)) {
      const w = figures.get(lane.name);
      const ghost = lane.status === "gone";
      const sx = at.x * TS, sy = at.y * TS - 6;
      drawSprite(w.pal, sx, sy, face, 0, ghost ? 0.4 : 1);
      drawAccessories(w.pal, wornBy(lane.name, false, w.pal.look?.hides), sx, sy, face, 0, ghost ? 0.4 : 1);
      const glyph = GLYPH[lane.status] ?? (lane.asks ? GLYPH.needs_you : null);
      if (glyph) drawBubble(sx, sy, glyph[0], glyph[1], 0, glyph[2]);
      drawLabel(lane.name.length > 14 ? lane.name.slice(0, 13) + "…" : lane.name, sx + 8, at.y * TS + 10, lane.status === "needs_you" || lane.status === "blocked", w.mark);
    }
  } finally {
    setCtx(real);
  }
  const t = target.getContext("2d");
  t.imageSmoothingEnabled = true;
  t.imageSmoothingQuality = "high";
  t.clearRect(0, 0, target.width, target.height);
  t.drawImage(scratch, 0, 0, target.width, target.height);
}
// The size a tile's canvas is made at: half the room's, enough for a tile at any width the building gives it.
export const STILL_W = (cv.width / 2) | 0, STILL_H = (cv.height / 2) | 0;
