// The room's canvas (one per floor), its pixel scale, px() and the cache of pre-painted art (bake, blit).
import { $ } from "../core/dom.js";
import { canvasId } from "../core/floors.js";
import { FLOOR } from "./here.js";

export const TS = 16, SC = 3, W = 24, H = 16;
export const cv = $(canvasId(FLOOR)); // "room" on HQ's floor, which is the page's own graph
cv.width = W * TS * SC; cv.height = H * TS * SC;
export let ctx = cv.getContext("2d");
ctx.imageSmoothingEnabled = false;
export function px(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x * SC), Math.round(y * SC), Math.round(w * SC), Math.round(h * SC)); }
// Art that does not change between frames (a sprite in one pose, the room's furniture) is painted once into its own
// small canvas and copied each frame: one copy instead of hundreds of rectangles. paint() draws with px() at 0,0.
const ART = new Map();
const artIds = new WeakMap();
let artNext = 0;
export const artId = (o) => { let i = artIds.get(o); if (i === undefined) artIds.set(o, (i = artNext++)); return i; };
function bake(paint) {
  const rects = [], real = ctx;
  ctx = { globalAlpha: 1, fillStyle: "", fillRect(x, y, w, h) { rects.push([x, y, w, h, this.fillStyle]); } };
  try { paint(); } finally { ctx = real; }
  if (!rects.length) return { c: null };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of rects) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); }
  const c = document.createElement("canvas");
  c.width = x1 - x0; c.height = y1 - y0;
  const g = c.getContext("2d");
  for (const [x, y, w, h, f] of rects) { g.fillStyle = f; g.fillRect(x - x0, y - y0, w, h); }
  return { c, x: x0, y: y0 };
}
export function blit(key, x, y, alpha, paint) {
  let a = ART.get(key);
  if (!a) ART.set(key, (a = bake(paint)));
  if (!a.c) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(a.c, Math.round(x * SC) + a.x, Math.round(y * SC) + a.y);
  ctx.globalAlpha = 1;
}
export function setCtx(v) { return (ctx = v); }
