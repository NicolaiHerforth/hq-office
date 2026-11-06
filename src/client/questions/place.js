// Your place in NEEDS YOU: what is under your eye stays at its pixel, whatever changes height above it (a card, a
// comment, a strip over the list), with or without the browser's own scroll anchoring. iOS Safari has none.
import { $, pageScrolls } from "../core/dom.js";
import { on } from "../core/bus.js";

const hud = $("hud");
// The list scrolls itself on a desktop, the page under 1151px (core/layout.css).
const offset = () => (pageScrolls() ? scrollY : hud.scrollTop);
const move = (d) => { if (pageScrolls()) scrollBy(0, d); else hud.scrollTop += d; };
// Where reading starts: under the question tabs and the row of where you are, which stick to the top on a phone.
export const eyeLine = () => (pageScrolls() ? Math.max(0, (document.querySelector(".asknav") ?? $("qtabs")).getBoundingClientRect().bottom) : hud.getBoundingClientRect().top);

// [element, top] in order of preference: the field being typed in, the part of the first card on screen that is under
// the eye, then that card and the next ones on screen, so a card that leaves hands over to the next.
let anchors = [], at = 0;
export function remember() {
  anchors = [];
  at = offset();
  if (hud.hidden) return;
  const line = eyeLine(), add = (el) => anchors.push([el, el.getBoundingClientRect().top]);
  const seen = (r) => r.bottom > line && r.top < innerHeight;
  const field = document.activeElement; // a card's box, or TELL HQ under the list
  if (field?.matches?.("textarea, input") && hud.closest(".desk").contains(field) && seen(field.getBoundingClientRect())) add(field);
  // The list ends above the middle of the screen: you are reading what is under it, which stays put as the list grows.
  if (at && pageScrolls() && hud.getBoundingClientRect().bottom <= Math.max(line, innerHeight / 2)) { add(hud.closest(".desk").querySelector(".tell") ?? hud); return; }
  for (const card of hud.children) {
    const r = card.getBoundingClientRect();
    if (r.top >= innerHeight) break;
    if (r.bottom <= line) continue;
    if (!anchors.length) { const part = [...card.children].find((c) => c.getBoundingClientRect().bottom > line); if (part) add(part); }
    add(card);
  }
}
export function hold() {
  // Someone scrolled on purpose (entering a floor, a menu taking the focus) and the scroll event is on its way: that is
  // where you are now, not something to undo.
  if (offset() !== at) { remember(); return; }
  for (const [el, top] of anchors) {
    if (!el.isConnected) continue;
    const d = el.getBoundingClientRect().top - top;
    if (d) move(d);
    break;
  }
  remember();
}
// Only the finger's scrolls: the event of a correction made here arrives a frame later, and must not take as your place
// whatever has moved since.
const scrolled = () => { if (wanted) settle(); else if (offset() !== at) remember(); };
addEventListener("scroll", scrolled, { passive: true });
hud.addEventListener("scroll", scrolled, { passive: true });
document.addEventListener("focusin", remember);
on("qtab", remember);

// A card that changes height moves what is under it, and so does anything else on the page.
// At the very top of the page, what loads above the list pushes it down: a page never opens scrolled.
const sizes = new ResizeObserver(() => { if (wanted) settle(); else if (offset()) hold(); else remember(); });
sizes.observe($("main"));
sizes.observe(document.body);
export const watchCard = (card) => sizes.observe(card);

// You answered this card: when it leaves, the next one takes its place, under the eye if it was above the screen.
let leaving = null;
export const leave = (id) => { leaving = id; };
export const stay = () => { leaving = null; };
export function beforeRemove(card) {
  if (Number(card.dataset.ask) !== leaving) return null;
  leaving = null;
  // Scrolled away before the answer came back: you are reading something else now, and it stays.
  const { top, bottom } = card.getBoundingClientRect(), next = card.nextElementSibling ?? card.previousElementSibling;
  return next && bottom > eyeLine() && top < innerHeight ? { next, top } : null;
}
export function arrive({ next, top }) {
  const margin = parseFloat(getComputedStyle(next).scrollMarginTop) || 0;
  move(next.getBoundingClientRect().top - Math.max(top, eyeLine() + Math.min(margin, 12)));
  remember();
}

// A reload (a release, or a phone dropping the page while it slept) puts you back: the card and its pixel, parked with
// the drafts, and put back once the cards are there.
export function parked() {
  // As last measured: while a page goes away its layout is no longer the one you were reading.
  const card = anchors.find(([el]) => el.dataset.ask);
  return card ? { ask: card[0].dataset.ask, top: card[1] } : null;
}
let wanted = null, settling = false;
const landed = () => { wanted = null; };
export function restore(place) {
  wanted = place;
  if (!place) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) addEventListener(type, landed, { once: true, passive: true });
}
// Kept up while the page loads, until you touch it: the rest of the page still arrives, and Safari reports the top of
// the page for a moment after the first scroll.
export function settle() {
  if (!wanted) return;
  const card = hud.querySelector(`[data-ask="${CSS.escape(String(wanted.ask))}"]`);
  if (!card) return;
  if (!settling) { settling = true; setTimeout(landed, 2000); }
  const d = card.getBoundingClientRect().top - wanted.top;
  if (d) move(d);
  remember();
}
