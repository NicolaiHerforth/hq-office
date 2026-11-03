// HTML PAGES on the stage (src/server/pages.ts): a page a lane wrote, shown the way a Claude artifact would be, with no
// account. #page/rooms/SLUG/files/NAME (a room's .html file), #page/rooms/SLUG/brief (a room's brief that is a page),
// #page/briefs/ID (a floor's brief that is a page), #page/asks/ID (an ask's page: the ask's answer row sits under it,
// drawn by questions/questions.js into the dock this view mounts). It takes the right column at full width (the whole
// screen on a phone), or sits beside the room or a lane's drawer on a wide stage (split/, #room/SLUG+page/...), with
// BACK (to the room under it, if any) and OPEN IN NEW TAB. The page runs in an iframe sandboxed without allow-same-origin, and the
// server sends it with a sandbox policy too: its scripts cannot reach the HUD, its data or its storage.
//
// A room's page keeps its earlier versions (src/server/room-folder.ts): VERSIONS lists them, and ?v=V on the address
// (#page/rooms/SLUG/files/NAME?v=V) shows one, read-only, under a line that says so. While the newest is shown, a new
// version from the lane replaces it in place. A page shows in the HUD's theme (theme.js).
import { setHTML, esc } from "../core/format.js";
import { S } from "../core/state.js";
import { emit, on } from "../core/bus.js";
import { themedSrc } from "./theme.js";
import { navigateFrame } from "./frame-nav.js";
import { PAGE, closeSide, current, escIsFor, leaveField } from "../core/stage.js";

export const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads";
const stage = document.querySelector(".stage");
const view = document.createElement("section");
view.className = "box pageview";
view.hidden = true;
view.setAttribute("aria-label", "Page");
stage.append(view);

// The page's address on the server, what to call it and, for a room's page, where its versions are; null for anything
// else.
export function pageOf(hash) {
  const m = hash.match(PAGE);
  if (!m) return null;
  const v = m[7] ?? null, q = v ? `?v=${v}` : "";
  if (m[3]) {
    let name = m[3];
    try { name = decodeURIComponent(name); } catch {}
    if (!/\.html?$/i.test(name)) return null;
    const src = `/rooms/${m[2]}/files/${encodeURIComponent(name)}`;
    return { src: src + q, title: name, slug: m[2], v, latest: `#page${src}`, key: `rooms/${m[2]}/files/${name}`, versions: `/api/rooms/${m[2]}/versions?file=${encodeURIComponent(name)}` };
  }
  if (m[4]) return { src: `/rooms/${m[4]}/brief.html${q}`, title: `Brief of ${m[4]}`, slug: m[4], v, latest: `#page/rooms/${m[4]}/brief`, key: `rooms/${m[4]}/brief`, versions: `/api/rooms/${m[4]}/versions?brief=1` };
  if (v) return null; // a floor's brief has no versions: each one is a brief of its own, nor has an ask's page
  if (m[6]) return { src: `/asks/${m[6]}.html`, title: `Question #${m[6]}`, key: `asks/${m[6]}`, ask: Number(m[6]), at: S?.askPages?.[m[6]]?.at };
  return { src: `/briefs/${m[5]}.html`, title: `Brief #${m[5]}`, key: `briefs/${m[5]}` };
}
// What a page may ask for from a click, as an artifact may: copying to the clipboard, and going full screen.
export const ALLOW = "clipboard-write; fullscreen";
// The same frame, for a page shown inside another view (a floor's brief). It shows in the HUD's theme (theme.js),
// which keeps it in step through data-src.
// SPLIT or SINGLE, in a brief's or a page's bar: split/ shows it while the side can sit beside what is under it, and
// says the other way's name.
export const SPLIT_BUTTON = `<button class="btn-s wideonly splitbtn" type="button" data-split-toggle title="Beside the room or the lane, or alone"><span class="tosplit">SPLIT</span><span class="tosingle">SINGLE</span></button>`;
export const frameHTML = (src, label) => `<iframe class="pageframe" src="${esc(themedSrc(src))}" data-src="${esc(src)}" sandbox="${SANDBOX}" allow="${ALLOW}" allowfullscreen referrerpolicy="no-referrer" title="${esc(label)}"></iframe>`;

export const when = (t) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const byName = (by) => (by === "owner" ? "you" : by || "?");

let shown = null; // the page on the stage: pageOf(hash), plus its versions once read
let listOpen = false;
function route() {
  const side = current().side, p = side?.startsWith("page/") ? pageOf(`#${side}`) : null;
  if (!p) { close(); return; }
  if (shown?.src === p.src) return;
  shown = p;
  listOpen = false;
  view.hidden = false;
  stage.classList.add("inpage");
  document.documentElement.classList.add("pageopen");
  // An ask's page has its answer row docked under it (questions/questions.js) where other pages have comments.
  setHTML(view, `<div class="pvbar"><button class="btn-s" type="button" data-page-back>◀ BACK</button><b class="pvtitle">${esc(p.title)}</b><span class="pvvbtn"></span>${p.ask ? "" : `<button class="btn-s" type="button" data-comments-toggle="${esc(p.key)}">COMMENTS</button>`}${SPLIT_BUTTON}<button class="btn-s wideonly" type="button" data-view-full>FULL SCREEN</button><a class="btn-s" href="${esc(p.src)}" target="_blank" rel="noopener">OPEN IN NEW TAB</a><div class="pvvers" hidden></div></div><div class="pvold"${p.v ? "" : " hidden"}></div>${frameHTML(p.src, p.title)}${p.ask ? `<aside class="box askdock" data-askdock="${p.ask}" aria-label="Answer"></aside>` : `<aside class="cmount" data-comments="${esc(p.key)}"></aside>`}`);
  if (p.ask) emit("askdock:mount", view.querySelector(".askdock"));
  else emit("comments:mount", view.querySelector(".cmount"));
  emit("page:stage", p);
  renderVersions();
  if (p.versions) loadVersions(p);
}
function close() {
  if (view.hidden) return;
  // Leaving while full screen: leave full screen first, or the browser keeps showing a hidden element (a blank screen).
  if (document.fullscreenElement && view.contains(document.fullscreenElement)) document.exitFullscreen?.().catch(() => {});
  shown = null;
  view.hidden = true;
  stage.classList.remove("inpage");
  document.documentElement.classList.remove("pageopen");
  setHTML(view, "");
  emit("page:stage", null);
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
    if (newer) { const f = view.querySelector(".pageframe"); if (f) navigateFrame(f); }
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
  // An ask's page replaced in place (hud update ID --file) loads again.
  if (p?.ask) {
    const at = S?.askPages?.[p.ask]?.at;
    if (at && p.at && at !== p.at) { const f = view.querySelector(".pageframe"); if (f) navigateFrame(f); }
    if (at) p.at = at;
    return;
  }
  if (!p?.versions || !p.data) return;
  const rev = S?.rooms?.find((x) => x.slug === p.slug)?.rev;
  if (rev != null && rev !== p.rev) { p.rev = rev; loadVersions(p); }
});

// BACK returns to the room under the page, else to the office (core/stage.js). Moving between versions replaces the
// address, so BACK leaves in one step.
const back = closeSide;
view.addEventListener("click", (e) => {
  if (e.target.closest("[data-page-back]")) { back(); return; }
  // FULL SCREEN: the page alone on the screen (Esc, or the button again, leaves it).
  if (e.target.closest("[data-view-full]")) {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else view.requestFullscreen?.().catch(() => {});
    return;
  }
  if (e.target.closest("[data-page-versions]")) { listOpen = !listOpen; renderVersions(); }
});
// Esc closes the versions list, then leaves the page (capture: before the room under it takes Esc to leave the room),
// when Esc is the page's (core/stage.js); in the comment box it first leaves the box.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view.hidden || !escIsFor(view)) return;
  e.preventDefault();
  if (leaveField(view)) return;
  if (listOpen) { listOpen = false; renderVersions(); return; }
  back();
}, true);
on("nav", route);
route();
document.addEventListener("fullscreenchange", () => {
  for (const b of view.querySelectorAll("[data-view-full]")) b.textContent = document.fullscreenElement === view ? "EXIT FULL SCREEN" : "FULL SCREEN";
});
