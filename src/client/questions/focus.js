// FOCUS in NEEDS YOU: one question on the stage. The others stay built, with their drafts, and out of layout, so nothing
// about them can move what you read. The mode is this browser's, the question this tab's.
import { $ } from "../core/dom.js";
import { eyeLine, remember } from "./place.js";

const hud = $("hud"), MODE = "hq-needs-focus", AT = "hq-needs-at";
let on = (() => { try { return localStorage.getItem(MODE) === "1"; } catch { return false; } })();
let at = (() => { try { return Number(sessionStorage.getItem(AT)) || null; } catch { return null; } })();
let order = []; // the list as last drawn: where a question was once it has gone
// Parked with the drafts: where the question on the stage was, if it has gone by the time you are back.
export const readingOrder = () => order;
export const seedOrder = (ids) => { order = ids ?? []; };

export const focusOn = () => on;
export const focused = () => (on ? at : null);
const cardOf = (id) => hud.querySelector(`:scope > .ask[data-ask="${id}"]`);
export const leftOnStage = () => (on ? hud.querySelector(":scope > .ask.left.on") : null);

function stage(id) {
  for (const c of hud.querySelectorAll(":scope > .ask.on")) if (Number(c.dataset.ask) !== id) c.classList.remove("on");
  at = id;
  cardOf(id)?.classList.add("on");
  try { if (id) sessionStorage.setItem(AT, id); else sessionStorage.removeItem(AT); } catch {}
}
// Its top under the row of where you are, the top of the box where the list scrolls itself.
function pin(id) {
  const card = cardOf(id);
  if (!card) return;
  hud.scrollTop = 0;
  const top = card.getBoundingClientRect().top, line = eyeLine();
  if (top < line) scrollBy(0, top - line - 8);
}
export function focusTo(id) {
  stage(id);
  pin(id);
  remember();
}
export function setFocus(next, id) {
  on = next;
  try { if (on) localStorage.setItem(MODE, "1"); else localStorage.removeItem(MODE); } catch {}
  hud.classList.toggle("focus", on);
  if (on) stage(id ?? at ?? order[0] ?? null);
  else for (const c of hud.querySelectorAll(":scope > .ask.on")) c.classList.remove("on");
}
// After each drawing of the list: the question that left (you answered it, or it is out of scope now) gives way to the
// one after it. A question that left on its own stays on the stage as it is, saying so (left.js), until you move on.
export function syncFocus(ids, stillOpen) {
  hud.classList.toggle("focus", on);
  if (!on) { order = ids; return; }
  if (leftOnStage()) { order = ids; return; }
  const i = order.indexOf(at), was = at;
  // With no question left, a card still holding your words comes up before the empty list does.
  const kept = () => Number(hud.querySelector(":scope > .ask.left:not([hidden])")?.dataset.ask) || null;
  if (!ids.includes(at)) stage((stillOpen(at) || i < 0 ? ids[0] : order.slice(i + 1).find((x) => ids.includes(x)) ?? ids.at(-1)) ?? kept());
  else stage(at);
  order = ids;
  if (at !== was) { pin(at); remember(); }
}
// Where a step goes: the cards in the list's order. One that has closed with your words in it keeps its place among them.
export function stepFrom(n) {
  const all = [...hud.querySelectorAll(":scope > .ask:not([hidden])")], i = all.findIndex((c) => Number(c.dataset.ask) === at);
  return Number(all[i + n]?.dataset.ask) || null;
}
