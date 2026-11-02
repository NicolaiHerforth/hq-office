// Cards inside an HTML page: what the bridge (page-runtime/index.js) hands over for a page's <hud-card ref> elements.
// "page:cards" asks for cards, always with the page's key as the bridge knows it from the frame, so the server
// answers only references the page's author wrote into it (src/server/refs.ts); the answer is plain text and colours
// to draw, never markup. While the page is open its cards are read again after a state change, at most every 3 s.
// A click on one opens it only if the server gave that page its card (allowedIn, for embeds/index.js).
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { mdInline } from "../core/markdown.js";
import { STATUS_TEXT } from "../core/status.js";
import { floorById, inkOn, multi } from "../core/floors.js";
import { officeFloor } from "../core/scope.js";

const plain = (text) => { const t = document.createElement("template"); t.innerHTML = mdInline(text ?? "", { links: false }); return t.content.textContent; };
// What a page draws: words and colours only.
function drawn(c) {
  if (!c) return null;
  const f = multi(S) && c.floor ? floorById(S, c.floor) : null;
  const other = f && (c.kind === "floor" || c.floor !== officeFloor());
  return {
    word: c.word,
    title: plain(c.title),
    preview: plain(c.preview),
    chips: c.chips.map((x) => (x.c === "st" ? { t: String(STATUS_TEXT[x.status]?.[0] ?? x.status).toUpperCase(), c: "st", color: STATUS_TEXT[x.status]?.[1] ?? "" } : { t: x.t, c: x.c })),
    floor: other ? { name: c.kind === "floor" ? "" : f.name, color: f.color, ink: inkOn(f.color) } : null,
    href: c.tab ? c.href : null, // a file that is not a page: the page opens it in a tab itself
    thumb: c.thumb,
  };
}

const allowed = new Map(); // page key -> the references the server gave it a card for
async function fetchCards(page, refs) {
  const r = await fetch(`/api/refs?page=${encodeURIComponent(page)}&${refs.map((x) => `r=${encodeURIComponent(x)}`).join("&")}`, { cache: "no-store" });
  if (!r.ok) return Object.fromEntries(refs.map((x) => [x, null]));
  const { cards } = await r.json();
  const mine = allowed.get(page) ?? allowed.set(page, new Set()).get(page);
  for (const [ref, c] of Object.entries(cards)) if (c) mine.add(c.ref);
  return Object.fromEntries(Object.entries(cards).map(([ref, c]) => [ref, drawn(c)]));
}

// One entry per page document that shows cards: view is { push(cards), alive() }, the same object for its life.
const views = new Map(); // view -> { page, refs, at, later }
on("page:cards", async ({ page, refs, reply, view }) => {
  const list = [...new Set((Array.isArray(refs) ? refs : []).map(String))].slice(0, 50);
  reply(await fetchCards(page, list).catch(() => Object.fromEntries(list.map((x) => [x, null]))));
  const v = views.get(view) ?? views.set(view, { page, refs: new Set(), at: Date.now(), later: null }).get(view);
  for (const x of list) v.refs.add(x);
});
// Read a view's cards again now, or once 3 s have passed since the last read.
function again(view) {
  const v = views.get(view);
  if (!v || v.later) return;
  if (!view.alive()) { views.delete(view); return; }
  const wait = v.at + 3000 - Date.now();
  if (wait > 0) { v.later = setTimeout(() => { v.later = null; again(view); }, wait); return; }
  v.at = Date.now();
  fetchCards(v.page, [...v.refs]).then((cards) => view.alive() && view.push(cards), () => {});
}
on("state", () => { for (const view of views.keys()) again(view); });

// Whether PAGE was given a card for REF: only those open from inside it (embeds/index.js "page:open").
export const allowedIn = (page, ref) => !!allowed.get(page)?.has(ref);
