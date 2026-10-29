// DOM shortcuts: $ by id, the toast, and keeping the place on a page that scrolls and in a list that scrolls itself.
export const $ = (id) => document.getElementById(id);
export function toast(msg) {
  const t = document.createElement("div");
  t.className = "box toast px";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}
// Under 1151px the page scrolls, not the panels (core/layout.css), so a panel built again can move what is on screen.
// On a phone, MESSAGES and FROM HQ are the exception: each has a bounded height and scrolls inside itself.
export const phone = () => matchMedia("(max-width: 1150px) and (pointer: coarse)").matches;
export const pageScrolls = () => !matchMedia("(min-width: 1151px)").matches;
// Call before a panel is built again; call what it returns after. The first item of the panel on screen that is
// still there (found by its attribute: the rebuild makes new elements) stays where it was; with the whole panel above
// the screen, what is under it stays put. Nothing to do where the panel scrolls itself.
export function keepPlace(box, attr) {
  if (!pageScrolls() || box.hidden) return () => {};
  const seen = [];
  for (const el of box.querySelectorAll(`[${attr}]`)) {
    const r = el.getBoundingClientRect();
    if (r.top >= innerHeight) break;
    if (r.bottom > 0) seen.push([el.getAttribute(attr), r.top]);
  }
  const bottom = box.getBoundingClientRect().bottom;
  return () => {
    let d = bottom <= 0 ? box.getBoundingClientRect().bottom - bottom : 0;
    for (const [key, top] of seen) {
      const el = box.querySelector(`[${attr}="${CSS.escape(key)}"]`);
      if (el) { d = el.getBoundingClientRect().top - top; break; }
    }
    if (d) scrollBy(0, d);
  };
}
// For a list that scrolls itself: call before it is built again, call what it returns after. The first item in its
// view that is still there stays where it was; with the whole list above the screen, what is under it stays put.
export function keepScroll(box, attr) {
  if (box.hidden) return () => {};
  const view = box.getBoundingClientRect();
  let seen = null;
  for (const el of box.querySelectorAll(`[${attr}]`)) {
    const r = el.getBoundingClientRect();
    if (r.bottom > view.top) { seen = [el.getAttribute(attr), r.top]; break; }
  }
  return () => {
    const el = seen && box.querySelector(`[${attr}="${CSS.escape(seen[0])}"]`);
    if (el) box.scrollTop += el.getBoundingClientRect().top - seen[1];
    if (view.bottom <= 0) scrollBy(0, box.getBoundingClientRect().bottom - view.bottom);
  };
}
// Marks the ends a list that scrolls itself has more beyond (data-more="up down"), for the fades on a phone.
export function showEdges(box) {
  if (!phone()) return;
  const more = `${box.scrollTop > 2 ? "up " : ""}${box.scrollHeight - box.clientHeight - box.scrollTop > 2 ? "down" : ""}`.trim();
  if (box.dataset.more !== more) box.dataset.more = more;
}

// A panel over the stage (the worker card, SECRETS): at the top of the office or the building, inside its border,
// clear of the floor switcher row above it.
export function overOffice(el) {
  // narrow: a sheet at the bottom of the screen (card.css, secrets.css), placed by its stylesheet
  if (!matchMedia("(min-width: 1151px)").matches) { el.style.top = el.style.right = el.style.maxHeight = ""; return; }
  const stage = el.parentElement;
  const view = [...stage.children].find((c) => (c.classList.contains("room") || c.classList.contains("building")) && c.offsetParent !== null);
  el.style.top = `${(view?.offsetTop ?? 0) + 8}px`;
  el.style.right = "8px";
  el.style.maxHeight = `${Math.max(160, (view ? view.offsetTop + view.offsetHeight : stage.clientHeight) - (view?.offsetTop ?? 0) - 16)}px`;
}
