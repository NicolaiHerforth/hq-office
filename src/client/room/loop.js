// The frame loop: a frame only when something visible changes (beat.js), paused only while hidden.
import { emit, on } from "../core/bus.js";
import { S } from "../core/state.js";
import { hovered, selected } from "./input.js";
import { SC, TS, ctx, cv, px } from "./canvas.js";
import { drawSprite } from "./sprites.js";
import { HQBOT } from "./palette.js";
import { hero } from "../settings/prefs.js";
import { chosenSeason, setSeason } from "./seasons.js";
import { drawAccessories, wornBy } from "./accessories.js";
import { drawEventCounter } from "./events.js";
import { workers } from "./workers.js";
import { deskCount } from "./collision.js";
import { GLYPH, drawAlert, drawLabel, drawMark, drawNeedsGlow, drawRoom, stillOpaque, stillPicture } from "./scene.js";
import { ROLE_COLOR, wornWithRole } from "./roles.js";
import { danceMove, drawNotes, drawShadow, drawSleep, drawSparkles, isNight, slideChange, sliding } from "./hero.js";
import { drawProp, drawWatchCheck, idleBrain, idleLift } from "./breakroom.js";
import { changeAt, danceClock, nextChange, steadyClock, walkMs, mode } from "./beat.js";

// At most one frame is ever waiting: either its timer or the display frame the timer asked for.
let last = performance.now();
let frameTimer = null;
let frameQueued = 0;
let frameNext = 0;
let walked = false;
const roomVisible = () => document.visibilityState === "visible";
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
on("settings", wake); // PERFORMANCE switches at once
window.addEventListener("focus", wake);
window.addEventListener("blur", wake);
document.addEventListener("click", wake);
document.fonts?.addEventListener?.("loadingdone", wake);
cv.addEventListener("mousemove", () => { if (hovered !== drawnHover) wake(); });
cv.addEventListener("mouseleave", wake);
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
      drawSprite(hero().pal, hx, hy, hdir, hstep);
      drawAccessories(hero().pal, wornBy(hero().name, true), hx, hy, hdir, hstep);
      if (move?.sparkle) drawSparkles(dance);
      if (idle) drawNotes(slide ? danceClock(now) : dance);
    }
    px(17 * TS, 3 * TS - 2, 6 * TS, 10, "#c84b4b");
    px(17 * TS, 3 * TS - 2, 6 * TS, 3, "#f08080");
    px(17 * TS, 3 * TS + 8, 6 * TS, 3, "#8a2a2a");
    drawEventCounter(now);
    drawLabel("YOU", 20 * TS, 3 * TS + 10, true);
    drawSprite(HQBOT, 16 * TS, 5 * TS - 6, "up", 0);
    drawLabel("HQ", 16 * TS + 8, 5 * TS + 10, true);

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
    list.sort((a, b) => (a.lane.name === selected) - (b.lane.name === selected) || a.y - b.y); // the focused one on top
    // With a lane in focus, everyone else steps back (drawn faint, but a lane that needs you keeps its bubble) and
    // the focused one stands in a yellow ring, the yellow of the focus bar over the question column.
    for (const w of list) {
      const moving = w.path.length > 0;
      const step = moving ? 1 + (Math.floor(w.t * 8) % 2) : 0;
      const st = w.lane.status;
      const idleBob = !moving && st === "moving" ? (Math.floor((steadyClock(now) + w.bob * 7) / 300) % 2) : 0;
      const ghost = st === "gone";
      const float = ghost ? Math.sin(steadyClock(now) / 400 + w.bob) * 1.5 : 0;
      const sway = w.brain && moving ? Math.round(Math.sin(now / 110 + w.bob)) : 0;
      const sx = w.x * TS + sway, sy = w.y * TS - 6 - idleBob + float - idleLift(w, moving, now);
      const needs = st === "needs_you", focused = selected === w.lane.name;
      const alpha = (ghost ? 0.4 : 1) * (selected && !focused ? 0.45 : 1);
      if (needs) drawNeedsGlow(sx + 8, w.y * TS + 9, Math.abs(Math.sin(steadyClock(now) / 300)));
      if (focused) {
        const r = 8 + Math.sin(steadyClock(now) / 200);
        for (const [color, width] of [["#22202a", 3], ["#ffd84a", 1.5]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = SC * width;
          ctx.beginPath();
          ctx.ellipse((sx + 8) * SC, (w.y * TS + 9) * SC, r * SC, r * 0.45 * SC, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      drawSprite(w.pal, sx, sy, w.dir, step, alpha);
      const busyHand = !!(w.brain?.acting && (w.brain.act.kind === "coffee" || w.brain.act.kind === "snack"));
      drawAccessories(w.pal, wornWithRole(w.lane.name, w.lane.role), sx, sy, w.dir, step, alpha, busyHand);
      if (!moving && needs) drawAlert(sx, sy, Math.abs(Math.sin(steadyClock(now) / 220)) * 2.5);
      else if (!moving && GLYPH[st]) { ctx.globalAlpha = alpha; drawMark(sx, sy, GLYPH[st][0], GLYPH[st][1]); ctx.globalAlpha = 1; }
      drawProp(w, sx, sy);
      if (st === "waiting" && !moving) drawWatchCheck(w, sx, sy, now);
      const name = w.lane.name.length > 14 ? w.lane.name.slice(0, 13) + "…" : w.lane.name;
      ctx.globalAlpha = needs ? 1 : alpha;
      drawLabel(name, sx + 8, w.y * TS + 10, focused || hovered === w.lane.name || needs, needs ? "#d63c3c" : ROLE_COLOR[w.lane.role], focused ? "#ffd84a" : undefined);
      ctx.globalAlpha = 1;
    }
  }
  drawnHover = hovered;
  emit("room:draw", now);
}
scheduleFrame();
document.addEventListener("visibilitychange", wake);
