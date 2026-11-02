// The stage's address: what is open in the right column, as the hash says it. Two parts, the base (the office, or a
// room) and the side (a brief or a page) over it or beside it:
//
//   #room/SLUG   #brief/ID   #page/...   #room/SLUG+brief/ID   #room/SLUG+page/...
//
// The address says what is open, never how it is laid out: split/ decides whether the side shows beside the base or
// alone. A room's slug has no +, so the first + ends it; a page's name may hold one. Every link to a room, a brief or a
// page goes through open(), so following one keeps the other part; rooms/, briefs/ and pages/ route on "nav".
import { emit, on } from "./bus.js";

const SLUG = "[a-z0-9][a-z0-9-]{0,47}";
const ROOM = new RegExp(`^room/(${SLUG})$`);
const BRIEF = /^brief\/(\d{1,9})$/;
// A page on the stage: a room's file, a room's brief, a floor's brief, an ask's page; ?v=V an older version.
export const PAGE = new RegExp(`^#page/(rooms/(${SLUG})/files/([^/?#]+)|rooms/(${SLUG})/brief|briefs/(\\d{1,9})|asks/(\\d{1,9}))(?:\\?v=(\\d{1,15}))?$`);

const isPage = (s) => { const m = `#${s}`.match(PAGE); return !!m && (!m[3] || /\.html?$/i.test(m[3])) && !(m[7] && (m[5] || m[6])); };
const isSide = (s) => BRIEF.test(s) || isPage(s);

// { room: SLUG | null, side: "brief/ID" | "page/..." | null }
export function parseStage(hash) {
  const h = String(hash ?? "").replace(/^#/, ""), i = h.indexOf("+");
  const room = (i < 0 ? h : h.slice(0, i)).match(ROOM)?.[1];
  if (room) return { room, side: i >= 0 && isSide(h.slice(i + 1)) ? h.slice(i + 1) : null };
  return { room: null, side: isSide(h) ? h : null };
}
export const stageHash = ({ room, side }) => (room ? `#room/${room}${side ? `+${side}` : ""}` : side ? `#${side}` : "");
export const current = () => parseStage(location.hash);
export const briefId = () => Number(current().side?.match(BRIEF)?.[1]) || null;

// Whether following a room link keeps the side open: split/ says yes when the room and the side would show side by side.
let keepsSide = () => false;
export const keepSideWhen = (fn) => { keepsSide = fn; };

// Which opened last, the side or a lane's drawer: Esc closes the most recent first.
let seq = 0, sideSeq = 0, drawerSeq = 0, lastSide = null;
const sideMoved = () => { const s = current().side; if (s && s !== lastSide) sideSeq = ++seq; lastSide = s; };
sideMoved();
on("select", (name) => { if (name) drawerSeq = ++seq; });

// "nav" once per change of address: the browser fires popstate and hashchange for one step back.
let last = location.hash;
function moved() {
  if (location.hash === last) return;
  last = location.hash;
  sideMoved();
  emit("nav");
}

// One history step per thing opened (a room, a side, a side of another kind over a side: a page from a brief), so the
// browser's back closes it; moving within one (room to room, brief to brief, version to version) replaces the step.
// Each step remembers the address it was opened from, this document and the history's length then: up() goes back
// when that is where it leads, in this document (back past a reload loads the page again), and nothing has added
// steps since (a page that navigates in its frame adds its own, and back would only undo one of those). Else, or when
// back does not arrive (the browser keeps only so many steps, so the length can stay the same), it replaces.
const DOC = Math.random().toString(36).slice(2);
const kind = (side) => side?.split("/")[0] ?? null;
export function go(next) {
  const cur = current(), to = { room: next.room ?? null, side: next.side ?? null };
  const url = location.pathname + location.search + stageHash(to);
  if ((to.room && !cur.room) || (to.side && kind(to.side) !== kind(cur.side))) {
    history.pushState(null, "", url);
    history.replaceState({ hqFrom: stageHash(cur), hqLength: history.length, hqDoc: DOC }, "", url);
  } else history.replaceState(history.state, "", url);
  moved();
}
export function up(next) {
  const to = stageHash({ room: next.room ?? null, side: next.side ?? null }), st = history.state;
  const replace = () => { history.replaceState(null, "", location.pathname + location.search + to); moved(); };
  if (st?.hqFrom !== to || st.hqDoc !== DOC || st.hqLength !== history.length) { replace(); return; }
  let arrived = false;
  addEventListener("popstate", () => { arrived = true; }, { once: true }); // and moved() routes
  history.back();
  setTimeout(() => { if (!arrived && location.hash !== to) replace(); }, 400);
}
// A room keeps the side when split/ says so; a side keeps the room. A link that names both is taken as it is.
export function open(to) {
  const cur = current();
  if (to.room && to.side) go(to);
  else if (to.room) go({ room: to.room, side: keepsSide(to.room) ? cur.side : null });
  else if (to.side) go({ room: cur.room, side: to.side });
}
// Closing a side returns to the side it was opened from in the same room (the brief a page was opened from), else to
// what is under it.
export function closeSide() {
  const cur = current(), from = parseStage(history.state?.hqFrom);
  up(from.side && from.side !== cur.side && from.room === cur.room ? from : { room: cur.room, side: null });
}
export const leaveRoom = () => up({ room: null, side: current().side });
// Whether Esc is the side's to take: not while a dialog, SETTINGS or SECRETS is open, nor while you type in a field
// outside it (a reply in the room beside it, an answer), nor while a lane's drawer is over it (alone on the stage) or
// opened after it (beside it): an overlay closes before what is under it, the most recent first.
export function escIsFor(side) {
  if (document.querySelector("dialog[open], #settings:not([hidden]), #secretsPanel:not([hidden])")) return false;
  const f = document.activeElement;
  if (f && !side.contains(f) && f.matches("input, textarea, select, [contenteditable]")) return false;
  const card = document.getElementById("card"), split = !!side.closest(".stage")?.classList.contains("split");
  return !card || card.hidden || (split && sideSeq > drawerSeq);
}
// Esc in a text box (a comment, the room's send box) first leaves the box, its draft kept; the next Esc goes on.
export function leaveField(scope) {
  const f = document.activeElement;
  if (!f || !scope.contains(f) || !f.matches("textarea, input, [contenteditable]")) return false;
  f.blur();
  return true;
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href^='#']");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const to = parseStage(a.getAttribute("href"));
  if (!to.room && !to.side) return;
  e.preventDefault();
  open(to);
});
addEventListener("popstate", moved);
addEventListener("hashchange", moved);
