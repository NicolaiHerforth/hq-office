// The frame loop: a frame only when something visible changes (beat.js), paused only while hidden.
import { emit, on } from "../core/bus.js";
import { S } from "../core/state.js";
import { terminalName } from "../core/floors.js";
import { FLOOR } from "./here.js";
import { hovered, selected } from "./input.js";
import { SC, TS, ctx, cv, px } from "./canvas.js";
import { drawSprite } from "./sprites.js";
import { heroPal, hqPal } from "./looks.js";
import { hero } from "../settings/prefs.js";
import { chosenSeason, setSeason } from "./seasons.js";
import { drawAccessories, wornBy } from "./accessories.js";
import { drawDeskGadget, drawGadget, heldBy } from "./gadgets.js";
import { drawEventCounter } from "./events.js";
import { workers } from "./workers.js";
import { deskCount } from "./collision.js";
import { GLYPH, drawBubble, drawLabel, drawRoom, labelBox, stillOpaque, stillPicture } from "./scene.js";
import { danceMove, drawNotes, drawShadow, drawSleep, drawSparkles, isNight, slideChange, sliding } from "./hero.js";
import { drawProp, drawWatchCheck, idleBrain, idleLift } from "./breakroom.js";
import { changeAt, danceClock, nextChange, steadyClock, walkMs, mode } from "./beat.js";

// At most one frame is ever waiting: either its timer or the display frame the timer asked for.
let last = performance.now();
let frameTimer = null;
let frameQueued = 0;
let frameNext = 0;
let walked = false;
// The office rests while something covers it: a conference room opened on the stage (rooms/) says so on the bus.
let covered = false;
// The floor in view draws; one out of sight rests (floors/ says which).
let shown = true;
const roomVisible = () => document.visibilityState === "visible" && !covered && shown;
function scheduleFrame() {
  if (!roomVisible()) {
    clearTimeout(frameTimer);
    cancelAnimationFrame(frameQueued);
    frameTimer = null;
    frameQueued = 0;
    return;
  }
  if (frameTimer || frameQueued) return;
  frameTimer = setTimeout(() => { frameTimer = null; frameQueued = requestAnimationFrame(roomFrame); }, Math.max(0, frameNext - performance.now()));
}
function roomFrame() {
  frameQueued = 0;
  if (!roomVisible()) return;
  // Timed from the clock, not the frame's own timestamp, which can lag.
  const now = performance.now();
  // A walk that starts after a still spell takes one walking frame's step, not the whole gap.
  const dt = Math.min(walked ? 0.2 : 1 / mode().walkFps, (now - last) / 1000);
  last = now;
  setSeason(chosenSeason());
  drawScene(now, dt);
  walked = [...workers.values()].some((w) => w.path.length);
  changeAt(now + 60000 - (Date.now() % 60000)); // the wall clock's minute: night, the season, the event's day
  frameNext = Math.max(nextChange(), now + 1);
  scheduleFrame();
}
// What changes the picture between its own steps wakes the room at once.
let drawnHover = null;
function wake() {
  clearTimeout(frameTimer);
  frameTimer = null;
  frameNext = 0;
  scheduleFrame();
}
on("state", wake);
on("select", wake);
export function showRoom(v) { shown = !!v; wake(); }
on("stage", (shown) => { covered = shown !== "office"; wake(); });
on("settings", wake); // PERFORMANCE switches at once
window.addEventListener("focus", wake);
window.addEventListener("blur", wake);
document.addEventListener("click", wake);
document.fonts?.addEventListener?.("loadingdone", wake);
cv.addEventListener("mousemove", () => { if (hovered !== drawnHover) wake(); });
cv.addEventListener("mouseleave", wake);
// A worker's name as its label shows it: cut at 14 characters.
const shortName = (name) => (name.length > 14 ? name.slice(0, 13) + "…" : name);
// Every label the room draws now, as boxes in the scene's units, measured the way drawLabel paints them. Bold, which is
// the widest a label gets (a hovered or waiting one), so the boxes do not move when the pointer does.
export function labelBoxes() {
  if (!S) return [];
  const boxes = [labelBox("YOU", 20 * TS, 3 * TS + 10, true), labelBox(terminalName(S, FLOOR), 16 * TS + 8, 5 * TS + 10, true)];
  for (const w of workers.values()) boxes.push(labelBox(shortName(w.lane.name), w.x * TS + 8, w.y * TS + 10, true, w.mark));
  return boxes;
}
function drawScene(now, dt) {
  const still = stillPicture(deskCount(workers.size));
  if (!stillOpaque) ctx.clearRect(0, 0, cv.width, cv.height);
  drawRoom(now, still);
  if (S) {
    // The hero behind the counter, HQ at its terminal
    // With nothing waiting on the hero, it dances the routine, and music notes float up while it does.
    // From midnight to seven it sleeps on a bed that pulls out instead.
    const idle = !S.open.length;
    const sleeping = idle && isNight();
    if (sleeping) {
      drawSleep(steadyClock(now));
    } else {
      // On the beat (balanced), a moonwalk slide travels, so it is drawn at up to the walking rate.
      const beat = mode().dance > 0, slide = idle && beat && sliding(now);
      if (slide) changeAt(Math.max(slideChange(now), now + walkMs()));
      const dance = idle ? (slide ? now : danceClock(now)) : 0;
      const move = idle ? danceMove(dance) : null;
      if (move) drawShadow(move.air, move.dx);
      const hx = 20 * TS - 8 + (move?.dx ?? 0), hy = 2 * TS - 6 + (move?.lift ?? 0), hdir = move?.dir ?? "down", hstep = move?.step ?? 0;
      const me = heroPal();
      drawSprite(me, hx, hy, hdir, hstep);
      drawAccessories(me, wornBy(hero().name, true, me.look?.hides), hx, hy, hdir, hstep);
      if (move?.sparkle) drawSparkles(dance);
      if (idle) drawNotes(slide ? danceClock(now) : dance);
    }
    px(17 * TS, 3 * TS - 2, 6 * TS, 10, "#c84b4b");
    px(17 * TS, 3 * TS - 2, 6 * TS, 3, "#f08080");
    px(17 * TS, 3 * TS + 8, 6 * TS, 3, "#8a2a2a");
    drawEventCounter(now);
    drawLabel("YOU", 20 * TS, 3 * TS + 10, true);
    drawSprite(hqPal(), 16 * TS, 5 * TS - 6, "up", 0);
    drawLabel(terminalName(S, FLOOR), 16 * TS + 8, 5 * TS + 10, true);

    const list = [...workers.values()];
    for (const w of list) if (w.brain) idleBrain(w, now, list);
    for (const w of list) {
      if (w.path.length) {
        const p = w.path[0];
        const dx = p.x - w.x, dy = p.y - w.y;
        const d = Math.hypot(dx, dy), step = 4.5 * dt;
        changeAt(now + walkMs());
        if (d <= step) { w.x = p.x; w.y = p.y; w.path.shift(); }
        else { w.x += (dx / d) * step; w.y += (dy / d) * step; }
        w.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        w.t += dt;
      } else {
        w.dir = w.face;
        w.t = 0;
      }
    }
    list.sort((a, b) => a.y - b.y);
    // What each worker holds, and the gadgets standing on desks: part of the desk, so under every worker.
    const held = new Map();
    for (const w of list) {
      const busyHand = !!(w.brain?.acting && (w.brain.act.kind === "coffee" || w.brain.act.kind === "snack"));
      const items = wornBy(w.lane.name, false, w.pal.look?.hides);
      const h = heldBy(w, items, now, w.path.length > 0, busyHand);
      held.set(w, { items, busyHand, h });
      if (h?.pose === "desk") drawDeskGadget(w.pal, h.g, w.seat, w.lane.status === "gone" ? 0.4 : 1);
    }
    for (const w of list) {
      const { items, busyHand, h } = held.get(w);
      const moving = w.path.length > 0;
      const step = moving ? 1 + (Math.floor(w.t * 8) % 2) : 0;
      const st = w.lane.status;
      const idleBob = !moving && st === "moving" ? (Math.floor((steadyClock(now) + w.bob * 7) / 300) % 2) : 0;
      const ghost = st === "gone";
      const float = ghost ? Math.sin(steadyClock(now) / 400 + w.bob) * 1.5 : 0;
      const sway = w.brain && moving ? Math.round(Math.sin(now / 110 + w.bob)) : 0;
      const sx = w.x * TS + sway, sy = w.y * TS - 6 - idleBob + float - idleLift(w, moving, now) - (h?.pose === "sip" ? 1 : 0);
      if (selected === w.lane.name) {
        const r = 7 + Math.sin(steadyClock(now) / 200);
        ctx.strokeStyle = "#d63c3c";
        ctx.lineWidth = SC;
        ctx.beginPath();
        ctx.ellipse((sx + 8) * SC, (w.y * TS + 9) * SC, r * SC, r * 0.45 * SC, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      drawSprite(w.pal, sx, sy, w.dir, step, ghost ? 0.4 : 1);
      drawAccessories(w.pal, items, sx, sy, w.dir, step, ghost ? 0.4 : 1, busyHand);
      if (h && h.pose !== "desk") drawGadget(w.pal, h, sx, sy, w.dir, step, ghost ? 0.4 : 1);
      if (!moving && GLYPH[st]) {
        const bounce = st === "needs_you" || st === "blocked" ? Math.abs(Math.sin(steadyClock(now) / 220)) * 2.5 : 0;
        drawBubble(sx, sy, GLYPH[st][0], GLYPH[st][1], bounce, GLYPH[st][2]);
      } else if (!moving && w.lane.asks) {
        // Working with a question open: it stays at its desk, and a still "!" says the question is waiting.
        drawBubble(sx, sy, GLYPH.needs_you[0], GLYPH.needs_you[1], 0);
      }
      drawProp(w, sx, sy);
      if (st === "waiting" && !moving) drawWatchCheck(w, sx, sy, now);
      const name = shortName(w.lane.name);
      drawLabel(name, sx + 8, w.y * TS + 10, selected === w.lane.name || hovered === w.lane.name || st === "needs_you" || st === "blocked", w.mark);
    }
  }
  drawnHover = hovered;
  emit("room:draw", now);
}
scheduleFrame();
document.addEventListener("visibilitychange", wake);
