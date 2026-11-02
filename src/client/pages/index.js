// HTML PAGES on the stage (src/server/pages.ts): a page a lane wrote, shown the way a Claude artifact would be, with no
// account. #page/rooms/SLUG/files/NAME (a room's .html file), #page/rooms/SLUG/brief (a room's brief that is a page),
// #page/briefs/ID (a floor's brief that is a page). It takes the right column at full width (the whole screen on a
// phone), with BACK and OPEN IN NEW TAB. The page runs in an iframe sandboxed without allow-same-origin, and the
// server sends it with a sandbox policy too: its scripts cannot reach the HUD, its data or its storage.
import { setHTML, esc } from "../core/format.js";

export const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";
const stage = document.querySelector(".stage");
const view = document.createElement("section");
view.className = "box pageview";
view.hidden = true;
view.setAttribute("aria-label", "Page");
stage.append(view);

// The page's address on the server, and what to call it, from the place in the hash; null for anything else.
export function pageOf(hash) {
  const m = hash.match(/^#page\/(rooms\/([a-z0-9][a-z0-9-]{0,47})\/files\/([^/?#]+)|rooms\/([a-z0-9][a-z0-9-]{0,47})\/brief|briefs\/(\d{1,9}))$/);
  if (!m) return null;
  if (m[3]) {
    let name = m[3];
    try { name = decodeURIComponent(name); } catch {}
    if (!/\.html?$/i.test(name)) return null;
    return { src: `/rooms/${m[2]}/files/${encodeURIComponent(name)}`, title: name };
  }
  if (m[4]) return { src: `/rooms/${m[4]}/brief.html`, title: `Brief of ${m[4]}` };
  return { src: `/briefs/${m[5]}.html`, title: `Brief #${m[5]}` };
}
// The same frame, for a page shown inside another view (a floor's brief).
export const frameHTML = (src, label) => `<iframe class="pageframe" src="${esc(src)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer" title="${esc(label)}"></iframe>`;

let shown = null;
function route() {
  const p = pageOf(location.hash);
  if (!p) { close(); return; }
  if (shown === p.src) return;
  shown = p.src;
  view.hidden = false;
  stage.classList.add("inpage");
  document.documentElement.classList.add("pageopen");
  setHTML(view, `<div class="pvbar"><button class="btn-s" type="button" data-page-back>◀ BACK</button><b class="pvtitle">${esc(p.title)}</b><a class="btn-s" href="${esc(p.src)}" target="_blank" rel="noopener">OPEN IN NEW TAB</a></div>${frameHTML(p.src, p.title)}`);
}
function close() {
  if (view.hidden) return;
  shown = null;
  view.hidden = true;
  stage.classList.remove("inpage");
  document.documentElement.classList.remove("pageopen");
  setHTML(view, "");
}
// BACK returns to where the page was opened from (a room, a brief), else to the office. It replaces the address rather
// than going back in the history: a page that navigates inside its frame adds history steps of its own.
let cameFrom = null;
function back() {
  if (cameFrom) location.replace(cameFrom);
  else { history.replaceState(null, "", location.pathname + location.search); route(); }
}
view.addEventListener("click", (e) => { if (e.target.closest("[data-page-back]")) back(); });
// Esc leaves the page first (capture: before the room under it takes Esc to leave the room).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view.hidden) return;
  e.preventDefault();
  back();
}, true);
addEventListener("hashchange", (e) => {
  if (!pageOf(location.hash)) cameFrom = null;
  else if (!pageOf(new URL(e.oldURL).hash)) cameFrom = new URL(e.oldURL).hash;
  route();
});
route();
