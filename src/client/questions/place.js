// Your place in NEEDS YOU: what is under your eye stays at its pixel, whatever changes height above it (a card, a
// comment, a strip over the list), with or without the browser's own scroll anchoring. iOS Safari has none.
import { $, pageScrolls } from "../core/dom.js";
import { on } from "../core/bus.js";
import { cardChanged } from "./hold.js";

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
  const field = document.activeElement; // a card's box, or TELL HQ under the list; on a sheet it is not your place in the list
  if (field?.matches?.("textarea, input") && hud.closest(".desk").contains(field) && !field.closest(".sheet") && seen(field.getBoundingClientRect())) add(field);
  // No card left under the eye: you are reading what is under the list, which stays put as the list grows. The last card
  // goes with it, for a reload, whose place is a card. With no card at all there is only what is under the list.
  const last = [...hud.children].findLast((c) => c.dataset.ask && c.getClientRects().length);
  if (at && pageScrolls() && (last ? last.getBoundingClientRect().bottom <= line : hud.getBoundingClientRect().bottom <= Math.max(line, innerHeight / 2))) {
    add(hud.closest(".desk").querySelector(".tell:not(.sheet)") ?? hud);
    if (last) add(last);
    return;
  }
  for (const card of hud.children) {
    const r = card.getBoundingClientRect();
    if (r.top >= innerHeight) break;
    if (r.bottom <= line) continue;
    if (!anchors.length) { const part = [...card.children].find((c) => c.getBoundingClientRect().bottom > line); if (part) add(part); }
    add(card);
  }
}
// A step of reading, by a key. Says whether there was room to take it.
export function scrollOn(d) {
  const was = offset();
  move(d);
  return offset() !== was;
}
// The page got shorter than where you were: the browser shortened the scroll, and nobody scrolled.
const shortened = () => offset() < at && offset() >= (pageScrolls() ? document.documentElement.scrollHeight - innerHeight : hud.scrollHeight - hud.clientHeight) - 1;
// entered: this drawing is another floor's list, which you chose. Nothing moved under a finger, and the next press counts.
export function hold(entered = false) {
  // Someone scrolled on purpose (entering a floor, a menu taking the focus) and the scroll event is on its way: that is
  // where you are now, not something to undo.
  if (offset() !== at && (entered || !shortened())) { remember(); return; }
  let kept = null;
  for (const anchor of anchors) {
    const [el, top] = anchor;
    if (!el.getClientRects().length) continue;
    const d = el.getBoundingClientRect().top - top;
    if (d) move(d);
    kept = anchor;
    break;
  }
  // What the correction could not put back has moved under your finger. At the very top of the page no place is kept.
  if (at && !entered && kept && Math.abs(kept[0].getBoundingClientRect().top - kept[1]) > 2) cardChanged();
  remember();
  // A page scrolls in whole pixels and a card's height is fractional: what fell short goes into the next correction, or it
  // adds up with each question that arrives. More than a pixel short is a page that had no room to scroll: that is your place.
  const again = kept && anchors.find(([el]) => el === kept[0]);
  if (again && Math.abs(again[1] - kept[1]) < 1) again[1] = kept[1];
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

// You answered this card: it leaves the list at once, before the server hears of it, and the next one takes its place,
// under the eye if it was above the screen. It stays out until the server's list no longer holds it, or comes back if
// the answer fails. sent: what the stage shows meanwhile ({ title, answer, status }).
const leaving = new Map();
export const leave = (id, sent) => { leaving.set(id, sent); };
export const stay = (id) => { leaving.delete(id); };
export const isLeaving = (id) => leaving.has(id);
export const sentAnswer = (id) => leaving.get(id);
export function withoutLeaving(open) {
  for (const id of leaving.keys()) if (!open.some((a) => a.id === id)) leaving.delete(id);
  return leaving.size ? open.filter((a) => !leaving.has(a.id)) : open;
}
export function onScreen(card) {
  const { top, bottom } = card.getBoundingClientRect();
  return !hud.hidden && bottom > eyeLine() && top < (pageScrolls() ? innerHeight : hud.getBoundingClientRect().bottom);
}
// A card on screen goes because its question closed, your answer or someone else's, and another takes its place: that one
// is held back from the press meant for this one. Leaving the list for another floor closes nothing.
const shownFrom = (card, step) => { let c = card[step]; while (c && !c.getClientRects().length) c = c[step]; return c; };
export function beforeRemove(card, closed) {
  const mine = leaving.has(Number(card.dataset.ask)), { top } = card.getBoundingClientRect(), seen = onScreen(card);
  // FOCUS shows one card at a time: the hold asks only whether there is another, and the jump needs one you can see.
  if ((mine || closed) && seen && (card.nextElementSibling ?? card.previousElementSibling)) cardChanged();
  const next = shownFrom(card, "nextElementSibling") ?? shownFrom(card, "previousElementSibling");
  // Scrolled away before the answer came back: you are reading something else now, and it stays.
  return mine && next && seen ? { next, top } : null;
}
export function arrive({ next, top }) {
  const margin = parseFloat(getComputedStyle(next).scrollMarginTop) || 0;
  move(next.getBoundingClientRect().top - Math.max(top, eyeLine() + Math.min(margin, 12)));
  remember();
}

// A reload (a release, or a phone dropping the page while it slept) puts you back: the card and its pixel, parked with
// the drafts, and put back once the cards are there.
export function parked() {
  if (wanted) return wanted; // still being put back: a second reload keeps it
  // At the very top there is no place to keep: what stands above the list differs from one load to the next, and holding
  // a card at its old pixel would open the page scrolled.
  // As last measured: while a page goes away its layout is no longer the one you were reading.
  const card = anchors.find(([el]) => el.dataset.ask);
  // With the reading order: it may have closed by the time you are back, and its neighbour takes its pixel.
  return at && card ? { ask: card[0].dataset.ask, top: card[1], order: [...hud.querySelectorAll(":scope > .ask")].map((c) => c.dataset.ask) } : null;
}
let wanted = null, settling = false;
// The card parked, or the next one still shown as you read on; with none ahead, the nearest behind.
function parkedCard() {
  const shown = (id) => { const c = hud.querySelector(`:scope > .ask[data-ask="${CSS.escape(String(id))}"]`); return c?.getClientRects().length ? c : null; };
  const order = wanted.order ?? [wanted.ask], i = order.indexOf(wanted.ask);
  for (const id of [...order.slice(i), ...order.slice(0, i).reverse()]) { const c = shown(id); if (c) return c; }
  return null;
}
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
  const card = parkedCard();
  if (!card) return;
  if (!settling) { settling = true; setTimeout(landed, 2000); }
  // Another card has only the pixel if its top stays in view: you may have been partway down the one that closed.
  const top = card.dataset.ask === wanted.ask ? wanted.top : Math.max(wanted.top, eyeLine() + 12);
  const d = card.getBoundingClientRect().top - top;
  if (d) move(d);
  remember();
}
