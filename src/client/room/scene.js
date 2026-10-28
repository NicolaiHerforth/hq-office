// The room itself: floor, walls, furniture (painted once), screens and lights, bubbles and name labels.
import { CONFIG } from "../core/state.js";
import { H, SC, TS, W, ctx, cv, px, setCtx } from "./canvas.js";
import { season } from "./seasons.js";
import { drawWindowView } from "./weather.js";
import { EVENT_ART, drawSeason, eventLayer, paintEventLayer } from "./events.js";
import { SEATS } from "./spots.js";
import { workers } from "./workers.js";
import { deskCount } from "./collision.js";
import { steadyClock, steamClock } from "./beat.js";

// The room's still parts: floor, walls, windows, sign, plants and furniture. Painted once per season, sign, desk
// count and font load, then copied. The moving bits (screens, lights, steam) are drawn on top each frame.
let fontsLoaded = 0;
document.fonts?.addEventListener?.("loadingdone", () => { fontsLoaded++; });
function paintRoomStill(used) {
  // floor
  for (let y = 2; y < H; y++) for (let x = 0; x < W; x++) {
    const office = x >= 15;
    const a = office ? "#cfe0e6" : "#eadfc4", b = office ? "#c3d6de" : "#e0d3b4";
    px(x * TS, y * TS, TS, TS, (x + y) % 2 ? a : b);
  }
  px(15 * TS - 1, 2 * TS, 2, (H - 2) * TS, "#9fb3bd");
  // wall
  px(0, 0, W * TS, 2 * TS, "#7d8fb0");
  px(0, 2 * TS - 4, W * TS, 4, "#56688a");
  [2, 7, 12].forEach((wx, i) => {
    px(wx * TS, 4, TS * 2, 18, "#3c4a68");
    px(wx * TS + 2, 6, TS * 2 - 4, 14, "#a9d8f5");
    drawWindowView(wx * TS + 2, i);
    px(wx * TS + TS - 1, 6, 2, 14, "#3c4a68");
  });
  // HQ sign on the office wall
  px(17 * TS, 5, 6 * TS, 18, "#2b2f45");
  ctx.fillStyle = "#f8f8f0";
  ctx.font = `${8 * SC}px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(CONFIG.owner ? `${CONFIG.owner.toUpperCase()}'S DESK` : "YOUR DESK", 20 * TS * SC, 14 * SC);
  // plants
  for (const [x, y] of [[0, 2], [14, 2], [15.2, 15]]) {
    px(x * TS + 4, y * TS + 8, 8, 7, "#a0603c");
    px(x * TS + 2, y * TS, 12, 9, "#3f9e4f");
    px(x * TS + 5, y * TS - 3, 6, 5, "#57b866");
  }
  // desks with monitors; the screens are drawn live
  for (const s of SEATS.slice(0, used)) {
    const dx = s.x * TS, dy = (s.y - 1) * TS;
    px(dx - 2, dy + 7, TS + 4, 8, "#9a6a3a");
    px(dx - 2, dy + 14, TS + 4, 2, "#6e4826");
    px(dx + 3, dy - 1, 10, 8, "#2b2f3a");
  }
  // HQ terminal
  px(16 * TS, 4 * TS + 2, TS, 14, "#1d2733");
  px(16 * TS + 2, 4 * TS + 4, TS - 4, 8, "#163a2a");
  // coffee machine
  px(23 * TS + 2, 6 * TS - 4, 12, 16, "#55555f");
  px(23 * TS + 4, 6 * TS - 2, 8, 5, "#2a2a30");
  // couch
  px(17 * TS - 2, 12 * TS + 10, 6 * TS + 4, 8, "#7a4fa0");
  px(17 * TS - 2, 13 * TS + 2, 6 * TS + 4, 9, "#9466bd");
  px(17 * TS - 4, 12 * TS + 12, 4, 14, "#5e3a80");
  px(23 * TS, 12 * TS + 12, 4, 14, "#5e3a80");
  // kitchen coffee machine beside the snack table
  px(23 * TS + 3, 14 * TS, 10, 16, "#55555f");
  px(23 * TS + 5, 14 * TS + 2, 6, 4, "#2a2a30");
  // snack table: chips, a can, a donut and an apple on a wooden top
  px(20 * TS, 14 * TS + 4, 3 * TS, 8, "#c98f4a");
  px(20 * TS, 14 * TS + 12, 3 * TS, 2, "#8a5a2a");
  px(20 * TS + 3, 14 * TS - 2, 6, 6, "#e0c040");
  px(20 * TS + 14, 14 * TS - 2, 5, 6, "#3c6fd6");
  px(20 * TS + 27, 14 * TS - 2, 6, 6, "#ff8fab");
  px(20 * TS + 36, 14 * TS - 1, 5, 5, "#d63c3c");
}
const roomLayer = document.createElement("canvas");
roomLayer.width = cv.width; roomLayer.height = cv.height;
let roomLayerKey = null;
function paintRoomLayer(used) {
  const key = `${season}|${CONFIG.owner}|${used}|${fontsLoaded}`;
  if (roomLayerKey === key) return;
  const real = ctx;
  setCtx(roomLayer.getContext("2d"));
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, roomLayer.width, roomLayer.height);
  try { paintRoomStill(used); } finally { setCtx(real); }
  roomLayerKey = key;
  roomLayer.v = (roomLayer.v ?? 0) + 1;
}
// The room's still layer and the event's, as one picture when the event's leaves the room's moving bits (screens,
// terminal, coffee lights, steam) uncovered. Then a repaint copies one picture instead of two, with the same pixels.
const stillLayer = document.createElement("canvas");
stillLayer.width = cv.width; stillLayer.height = cv.height;
export let stillKey = null, stillHasEvent = false, stillOpaque = false;
function liveRoomBoxes(used) {
  const boxes = SEATS.slice(0, used).map((s) => [s.x * TS + 4, (s.y - 1) * TS, 8, 6]);
  boxes.push([16 * TS + 3, 4 * TS + 5, 8, 5], [23 * TS + 11, 6 * TS + 6, 2, 2], [23 * TS + 12, 14 * TS + 9, 2, 2], [23 * TS + 5, 14 * TS - 11, 8, 10]);
  return boxes;
}
export function stillPicture(used) {
  paintRoomLayer(used);
  const art = EVENT_ART[season];
  if (art) paintEventLayer(art);
  const key = `${roomLayer.v}|${art ? eventLayer.v : "-"}|${used}`;
  if (stillKey !== key) {
    stillKey = key;
    stillHasEvent = false;
    if (art) {
      const ec = eventLayer.getContext("2d");
      const clear = liveRoomBoxes(used).every(([x, y, w, h]) => ec.getImageData(Math.floor(x * SC) - 1, Math.floor(y * SC) - 1, Math.ceil(w * SC) + 2, Math.ceil(h * SC) + 2).data.every((v, i) => i % 4 !== 3 || v === 0));
      if (clear) {
        const g = stillLayer.getContext("2d");
        g.clearRect(0, 0, stillLayer.width, stillLayer.height);
        g.drawImage(roomLayer, 0, 0);
        g.drawImage(eventLayer, 0, 0);
        stillLayer.v = (stillLayer.v ?? 0) + 1;
        stillHasEvent = true;
      }
    }
    // A picture with no see-through pixel covers the whole canvas, so the frame need not be cleared first.
    const px4 = (stillHasEvent ? stillLayer : roomLayer).getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    stillOpaque = true;
    for (let i = 3; i < px4.length; i += 4) if (px4[i] !== 255) { stillOpaque = false; break; }
  }
  return stillHasEvent ? stillLayer : roomLayer;
}
export function drawRoom(now, still) {
  const used = deskCount(workers.size);
  ctx.drawImage(still, 0, 0);
  const t = steadyClock(now);
  // desk screens: lit and scrolling while the worker sits at it
  const atDesk = new Set([...workers.values()].filter((w) => w.lane.status === "moving" && Math.abs(w.x - w.target.x) < 0.05 && Math.abs(w.y - w.target.y) < 0.05).map((w) => `${w.seat.x},${w.seat.y}`));
  for (const s of SEATS.slice(0, used)) {
    const dx = s.x * TS, dy = (s.y - 1) * TS;
    const on = atDesk.has(`${s.x},${s.y}`);
    px(dx + 4, dy, 8, 6, on ? "#6ad1ff" : "#3b4a5a");
    if (on) {
      const f = Math.floor(t / 180 + s.x * 3 + s.y) % 4;
      px(dx + 5, dy + 1, 2 + f, 1, "#ffffff");
      px(dx + 5, dy + 3, 5 - f, 1, "#ffffff");
    }
  }
  // HQ terminal's scan line
  const g = Math.floor(t / 250) % 3;
  px(16 * TS + 3, 4 * TS + 5 + g * 2, 8, 1, "#3ee08f");
  // the coffee machines' lights blink every second, and the kitchen one steams while someone takes a coffee
  const lit = Math.floor(t / 1000) % 2 ? "#ff4d4d" : "#802020";
  px(23 * TS + 11, 6 * TS + 6, 2, 2, lit);
  px(23 * TS + 12, 14 * TS + 9, 2, 2, lit);
  if ([...workers.values()].some((w) => w.brain?.acting && w.brain.act.kind === "coffee")) {
    const s = steamClock(now);
    for (let i = 0; i < 3; i++) px(23 * TS + 6 + i * 2, 14 * TS - 4 - ((s / 500 + i * 2) % 6), 2, 2, "#e8e8f0");
  }
  drawSeason(now);
}

// fill: the bubble's inside (white; red for a lane blocked on a prompt).
export function drawBubble(x, y, glyph, color, bounce, fill = "#ffffff") {
  const bx = x + 9, by = y - 9 - bounce;
  px(bx, by, 10, 9, "#22202a");
  px(bx + 1, by + 1, 8, 7, fill);
  px(bx + 2, by + 9, 2, 2, "#22202a");
  ctx.fillStyle = color;
  ctx.font = `bold ${7 * SC}px "Press Start 2P", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, (bx + 5) * SC, (by + 5) * SC);
}

// Label widths are measured once per text, weight and font load, not every frame.
const labelWidths = new Map();
const labelFont = (strong) => `${strong ? 700 : 600} ${4.2 * SC}px Nunito, system-ui, sans-serif`;
function labelWidth(text, strong) {
  const wk = `${strong}|${fontsLoaded}|${text}`;
  let w = labelWidths.get(wk);
  if (w === undefined) {
    ctx.font = labelFont(strong);
    if (labelWidths.size > 500) labelWidths.clear();
    labelWidths.set(wk, (w = ctx.measureText(text).width + 8));
  }
  return w;
}
// mark (a worker with a rank): { color, pips } or { color, symbol } from room/themes.js, drawn before the name.
const PIP = Math.round(2.4 * SC), PIP_GAP = SC;
// The rank symbols, 5x5, the same shapes as the masks.
const SYMBOLS = {
  star: ["..x..", "xxxxx", ".xxx.", ".x.x.", "x...x"],
  square: ["xxxxx", "x...x", "x...x", "x...x", "xxxxx"],
  triangle: ["..x..", "..x..", ".xxx.", ".xxx.", "xxxxx"],
  circle: [".xxx.", "x...x", "x...x", "x...x", ".xxx."],
};
const CELL = Math.max(1, Math.round(0.8 * SC));
const markWidth = (mark) => (!mark ? 0 : mark.symbol ? 5 * CELL + PIP_GAP : mark.pips * (PIP + PIP_GAP));
export function drawLabel(text, cx, y, strong, mark = null) {
  ctx.font = labelFont(strong);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const w = labelWidth(text, strong);
  const mw = markWidth(mark);
  ctx.fillStyle = strong ? "rgba(35,35,58,.92)" : "rgba(35,35,58,.62)";
  ctx.fillRect(cx * SC - (w + mw) / 2, y * SC, w + mw, 5.6 * SC);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, cx * SC + mw / 2, y * SC + 0.8 * SC);
  if (!mark) return;
  ctx.fillStyle = mark.color;
  const x0 = Math.round(cx * SC - (w + mw) / 2 + 4);
  if (mark.symbol) {
    const sy = Math.round(y * SC + (5.6 * SC - 5 * CELL) / 2);
    SYMBOLS[mark.symbol].forEach((row, r) => { for (let c = 0; c < 5; c++) if (row[c] === "x") ctx.fillRect(x0 + c * CELL, sy + r * CELL, CELL, CELL); });
    return;
  }
  const py = Math.round(y * SC + (5.6 * SC - PIP) / 2);
  for (let i = 0; i < mark.pips; i++) ctx.fillRect(x0 + i * (PIP + PIP_GAP), py, PIP, PIP);
}
// The box drawLabel paints for the same arguments, in the scene's units (the room is 384 by 256), so the layer over the
// room can keep clear of a name it will not cover.
export function labelBox(text, cx, y, strong, mark = null) {
  const w = labelWidth(text, strong) + markWidth(mark);
  return { x: cx - w / (2 * SC), y, w: w / SC, h: 5.6 };
}

// [glyph, colour, inside]: blocked is a white "!" in a red bubble, at the lane's desk.
export const GLYPH = { blocked: ["!", "#ffffff", "#d63c3c"], needs_you: ["!", "#d63c3c"], hq_turn: ["?", "#e0901e"], stale: ["?", "#c0501e"], waiting: ["…", "#3c6fd6"], parked: ["z", "#6a6a82"], done: ["✓", "#2f9e57"], gone: ["x", "#6a6a82"] };
