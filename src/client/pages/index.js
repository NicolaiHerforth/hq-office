// HTML PAGES on the stage (src/server/pages.ts): a page a lane wrote, shown the way a Claude artifact would be, with no
// account. #page/rooms/SLUG/files/NAME (a room's .html file), #page/rooms/SLUG/brief (a room's brief that is a page),
// #page/briefs/ID (a floor's brief that is a page). It takes the right column at full width (the whole screen on a
// phone), with BACK and OPEN IN NEW TAB. The page runs in an iframe sandboxed without allow-same-origin, and the
// server sends it with a sandbox policy too: its scripts cannot reach the HUD, its data or its storage.
//
// A room's page keeps its earlier versions (src/server/room-folder.ts): VERSIONS lists them, and ?v=V on the address
// (#page/rooms/SLUG/files/NAME?v=V) shows one, read-only, under a line that says so. While the newest is shown, a new
// version from the lane replaces it in place.
import { setHTML, esc } from "../core/format.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";

export const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";
const stage = document.querySelector(".stage");
const view = document.createElement("section");
view.className = "box pageview";
view.hidden = true;
view.setAttribute("aria-label", "Page");
stage.append(view);

const SLUG = "[a-z0-9][a-z0-9-]{0,47}";
const PLACE = new RegExp(`^#page/(rooms/(${SLUG})/files/([^/?#]+)|rooms/(${SLUG})/brief|briefs/(\\d{1,9}))(?:\\?v=(\\d{1,15}))?$`);
// The page's address on the server, what to call it and, for a room's page, where its versions are; null for anything
// else.
export function pageOf(hash) {
  const m = hash.match(PLACE);
  if (!m) return null;
  const v = m[6] ?? null, q = v ? `?v=${v}` : "";
  if (m[3]) {
    let name = m[3];
    try { name = decodeURIComponent(name); } catch {}
    if (!/\.html?$/i.test(name)) return null;
    const src = `/rooms/${m[2]}/files/${encodeURIComponent(name)}`;
    return { src: src + q, title: name, slug: m[2], v, latest: `#page${src}`, versions: `/api/rooms/${m[2]}/versions?file=${encodeURIComponent(name)}` };
  }
  if (m[4]) return { src: `/rooms/${m[4]}/brief.html${q}`, title: `Brief of ${m[4]}`, slug: m[4], v, latest: `#page/rooms/${m[4]}/brief`, versions: `/api/rooms/${m[4]}/versions?brief=1` };
  if (v) return null; // a floor's brief has no versions: each one is a brief of its own
  return { src: `/briefs/${m[5]}.html`, title: `Brief #${m[5]}` };
}
// The same frame, for a page shown inside another view (a floor's brief).
export const frameHTML = (src, label) => `<iframe class="pageframe" src="${esc(src)}" sandbox="${SANDBOX}" referrerpolicy="no-referrer" title="${esc(label)}"></iframe>`;

export const when = (t) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const byName = (by) => (by === "owner" ? "you" : by || "?");

let shown = null; // the page on the stage: pageOf(hash), plus its versions once read
let listOpen = false;
function route() {
  const p = pageOf(location.hash);
  if (!p) { close(); return; }
  if (shown?.src === p.src) return;
  shown = p;
  listOpen = false;
  view.hidden = false;
  stage.classList.add("inpage");
  document.documentElement.classList.add("pageopen");
  setHTML(view, `<div class="pvbar"><button class="btn-s" type="button" data-page-back>◀ BACK</button><b class="pvtitle">${esc(p.title)}</b><span class="pvvbtn"></span><a class="btn-s" href="${esc(p.src)}" target="_blank" rel="noopener">OPEN IN NEW TAB</a><div class="pvvers" hidden></div></div><div class="pvold"${p.v ? "" : " hidden"}></div>${frameHTML(p.src, p.title)}`);
  renderVersions();
  if (p.versions) loadVersions(p);
}
function close() {
  if (view.hidden) return;
  shown = null;
  view.hidden = true;
  stage.classList.remove("inpage");
  document.documentElement.classList.remove("pageopen");
  setHTML(view, "");
}

// ---- versions ----

async function loadVersions(p) {
  try {
    const r = await fetch(p.versions, { cache: "no-store" });
    const data = r.ok ? await r.json() : null;
    if (shown !== p || !data) return;
    // While the newest is on the stage, a newer one replaces it in place.
    const newer = p.data && !p.v && data.current?.at !== p.data.current?.at;
    p.data = data;
    p.rev = S?.rooms?.find((x) => x.slug === p.slug)?.rev;
    if (newer) { const f = view.querySelector(".pageframe"); if (f) f.src = f.getAttribute("src"); }
    renderVersions();
  } catch {}
}
function renderVersions() {
  const p = shown, d = p?.data;
  if (!p) return;
  // A brief's earlier versions that were markdown are not pages: the room's brief shows those.
  const older = (d?.versions ?? []).filter((x) => d.brief ? x.html : true);
  const btn = view.querySelector(".pvvbtn"), list = view.querySelector(".pvvers"), old = view.querySelector(".pvold");
  setHTML(btn, older.length ? `<button class="btn-s" type="button" data-page-versions aria-expanded="${listOpen}" aria-haspopup="true">VERSIONS (${older.length + 1})</button>` : "");
  list.hidden = !(listOpen && older.length);
  const row = (href, label, x, here) => `<a class="pvv${here ? " here" : ""}" href="${esc(href)}" data-page-version${here ? ` aria-current="page"` : ""}><b>${label}</b><span>${esc(byName(x?.by))}${x?.at ? ` · ${esc(when(x.at))}` : ""}</span></a>`;
  setHTML(list, d ? row(p.latest, "LATEST", d.current, !p.v) + older.map((x, i) => row(`${p.latest}?v=${x.v}`, `V${older.length - i}`, x, p.v === x.v)).join("") : "");
  if (p.v) {
    const i = older.findIndex((x) => x.v === p.v), x = older[i];
    setHTML(old, !d ? "" : x
      ? `<span><b>OLDER VERSION V${older.length - i}</b>read-only · by ${esc(byName(x.by))} · ${esc(when(x.at))}</span><a class="btn-s" href="${esc(p.latest)}" data-page-version>SHOW LATEST</a>`
      : `<span><b>THIS VERSION IS NO LONGER KEPT</b></span><a class="btn-s" href="${esc(p.latest)}" data-page-version>SHOW LATEST</a>`);
  }
}
// A new version, or one pruned: a room's change shows in its rev, and the versions are read again.
on("state", () => {
  const p = shown;
  if (!p?.versions || !p.data) return;
  const rev = S?.rooms?.find((x) => x.slug === p.slug)?.rev;
  if (rev != null && rev !== p.rev) { p.rev = rev; loadVersions(p); }
});

// BACK returns to where the page was opened from (a room, a brief), else to the office. It replaces the address rather
// than going back in the history: a page that navigates inside its frame adds history steps of its own. Moving between
// versions replaces it too, so BACK leaves in one step.
let cameFrom = null;
function back() {
  if (cameFrom) location.replace(cameFrom);
  else { history.replaceState(null, "", location.pathname + location.search); route(); }
}
view.addEventListener("click", (e) => {
  if (e.target.closest("[data-page-back]")) { back(); return; }
  if (e.target.closest("[data-page-versions]")) { listOpen = !listOpen; renderVersions(); return; }
  const go = e.target.closest("[data-page-version]");
  if (go && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); location.replace(go.getAttribute("href")); }
});
// Esc closes the versions list, then leaves the page (capture: before the room under it takes Esc to leave the room).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view.hidden) return;
  e.preventDefault();
  if (listOpen) { listOpen = false; renderVersions(); return; }
  back();
}, true);
addEventListener("hashchange", (e) => {
  if (!pageOf(location.hash)) cameFrom = null;
  else if (!pageOf(new URL(e.oldURL).hash)) cameFrom = new URL(e.oldURL).hash;
  route();
});
route();
