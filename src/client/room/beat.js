// The room's clocks: how often each kind of motion steps under the PERFORMANCE setting, and the next visible change.
//
// A presented frame costs about the same whatever it draws (Safari: about 0.65% of a core per frame a second), so
// the room presents only frames that show something new. Each animation reads its own clock below, which holds its
// time at its last step and notes when it steps next; the loop sleeps until the earliest of those, or until new
// state, a setting, a click, a hover, focus or visibility wakes it. Nothing moving: no frames at all.
//
// Three kinds of motion:
// - walking (and the hero's moonwalk): drawn at the mode's walking rate;
// - travel (the dance, falling snow and leaves, an event's effects, steam): things that glide;
// - steady (screens, the terminal, coffee lights, bobs, nods, bubbles, the ring, the sleep): small changes that read
//   just as well in steps. They share one slow beat, so they share frames instead of each forcing its own.
import { settings } from "../settings/prefs.js";

export const BEAT_MS = 250;
// smooth: everything that travels at 30 fps, focused or not; steady things on a 500 ms beat.
// balanced: walking at 10 fps, the dance on the 250 ms beat, weather and event effects on 500 ms, steady things
//   and steam on 1 s. An idle room: 1 frame a second, 2 in a snowy or event season.
// saver: walking at 8 fps (at 6 a worker jumps three quarters of a tile a frame; 10 costs another 1.3% of a core
//   while someone walks); everything else frozen in a still pose (drawn at FROZEN_T): an idle room presents nothing.
// travel 0 means continuous (a frame at the walking rate); null means frozen.
export const PERFORMANCE = {
  smooth: { walkFps: 30, dance: 0, travel: 0, steady: 500, steam: 0 },
  balanced: { walkFps: 10, dance: BEAT_MS, travel: 2 * BEAT_MS, steady: 4 * BEAT_MS, steam: 4 * BEAT_MS },
  saver: { walkFps: 8, dance: null, travel: null, steady: null, steam: null },
};
export const FROZEN_T = 0;
// Asked for less motion, the room rests as in POWER SAVER: still poses, and a worker walks only when its work moves it.
const lessMotion = matchMedia("(prefers-reduced-motion: reduce)");
export const mode = () => (lessMotion.matches ? PERFORMANCE.saver : PERFORMANCE[settings.performance] ?? PERFORMANCE.smooth);
// A walking frame's interval; 4 ms early lands on the display frame.
export const walkMs = () => 1000 / mode().walkFps - 4;

let due = Infinity;
// The room changes again at t.
export function changeAt(t) { if (t < due) due = t; }
// An animation's clock: now held at its last step (every `every` ms), with its next step noted.
export function stepped(now, every) {
  const t = Math.floor(now / every) * every;
  changeAt(t + every);
  return t;
}
// A clock by the mode: 0 runs continuously at the walking rate, null stands still, otherwise steps every so often.
function clock(now, every) {
  if (every === null) return FROZEN_T;
  if (every === 0) { changeAt(now + walkMs()); return now; }
  return stepped(now, every);
}
export const danceClock = (now) => clock(now, mode().dance);
export const travelClock = (now) => clock(now, mode().travel);
export const steadyClock = (now) => clock(now, mode().steady);
export const steamClock = (now) => clock(now, mode().steam);
// The first beat at or after t.
export const onBeat = (t) => Math.ceil(t / BEAT_MS) * BEAT_MS;
// The earliest change noted since the last call.
export function nextChange() { const d = due; due = Infinity; return d; }
