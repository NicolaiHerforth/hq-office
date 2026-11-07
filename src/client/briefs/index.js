// BRIEFS: a floor's HQ's longer write-ups (hud brief), like a project update. The BRIEFS tab in the question column
// lists the floor's briefs newest first, with the date, who posted it and its first lines; NEW marks one you have not
// opened. Opening one (from the list, or the line MESSAGES gets, #brief/ID) takes the right column at full width, or
// sits beside the room or a lane's drawer on a wide stage (split/, #room/SLUG+brief/ID), with the whole brief in
// markdown (headings, tables, lists, code), BACK, NEWER and OLDER. BACK returns to the brief it was opened from (a card
// or a link in another brief), else to the room under it. On a narrow screen the brief fills the screen. It reads in the HUD's theme (the tokens of core/base.css). Inside a floor, that floor's briefs (docs/floors.md).
// A brief shows only inside its own floor or in the building: opened inside another floor (a MESSAGES line, a link, a
// card), the page enters the brief's floor first, so NEWER and OLDER walk that floor; going to another floor closes it.
import { $, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { emit, on } from "../core/bus.js";
import { md, mdInline } from "../core/markdown.js";
import { enter, officeFloor, pick, tagged } from "../core/scope.js";
import { floorById } from "../core/floors.js";
import { frameHTML, SPLIT_BUTTON } from "../pages/index.js";
import { briefId, closeSide, escIsFor, leaveField } from "../core/stage.js";
import { exportButton } from "../brief-export/button.js";

const list = $("briefs");
const stage = document.querySelector(".stage");
const view = document.createElement("section");
view.className = "box briefview";
view.hidden = true;
view.setAttribute("aria-label", "Brief");
stage.append(view);

const when = (t) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const lead = (s) => String(s ?? "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/^#+\s*/gm, "").replace(/[|*_`>#-]+/g, " ").replace(/\s+/g, " ").trim();
const briefs = () => pick(S?.briefs ?? []);
// The brief's floor, when the list shows every floor: a small chip in its colour.
const floorChip = (id) => { const f = S && tagged() ? floorById(S, id) : null; return f ? `<span class="bfloor" style="--fc:${esc(f.color)}">${esc(f.name)}</span>` : ""; };

function renderList() {
  if (!S) return;
  const all = briefs(), open = openId();
  const unread = all.filter((b) => !b.read).length;
  setHTML(list, all.length
    ? `<div class="bsum">${all.length} ${all.length === 1 ? "BRIEF" : "BRIEFS"}${unread ? ` · ${unread} NEW` : ""}</div>` + all.map((b) => `<a class="brow${b.read ? "" : " unread"}${b.id === open ? " here" : ""}" href="#brief/${b.id}">
        <div class="meta">${floorChip(b.floor)}<span class="when">${esc(when(b.at))}</span>${b.read ? "" : `<span class="tag new">NEW</span>`}${S.comments?.[`briefs/${b.id}`]?.unread ? `<span class="tag new">REPLY</span>` : ""}<span class="by">${esc(b.by)}</span></div>
        <b class="bt">${mdInline(b.title, { links: false })}</b>
        <span class="blead">${mdInline(lead(b.lead), { links: false })}</span>
      </a>`).join("")
    : `<div class="empty">No briefs yet. A floor's HQ posts one with <code>hud brief --title T --file brief.md</code>: a longer write-up than a message, such as a project update. MESSAGES gets a line when one lands.</div>`);
  const t = $("qtBriefs");
  t.hidden = !unread;
  t.textContent = unread;
  t.title = `${unread} new ${unread === 1 ? "brief" : "briefs"}`;
}

// ---- one brief, on the stage ----

const openId = briefId;
let shown = null; // { id, ...the brief } once read from the server
async function route() {
  const id = openId();
  if (!id) { close(); return; }
  if (shown?.id !== id) {
    show({ id, loading: true });
    try {
      const r = await fetch(`/api/briefs/${id}`, { cache: "no-store" });
      const b = await r.json();
      if (openId() !== id) return;
      if (!r.ok) { toast(b.error?.toUpperCase?.() || `NO BRIEF #${id}`); closeSide(); close(); return; }
      shown = b;
      place();
      show(b);
      if (!b.read) post(`/api/briefs/${id}/read`, {}).catch(() => {});
    } catch (err) { toast(err.message); }
  }
}
function show(b) {
  shown = b;
  view.dataset.floor = b.floor ?? "";
  view.hidden = false;
  stage.classList.add("inbrief");
  document.documentElement.classList.add("briefopen");
  // A brief that is a page has its own title: the bar carries a compact line (date, who) and the page fills the rest.
  const page = !b.loading && b.html;
  const meta = page ? `<span class="bvmeta">${floorChip(b.floor)}<span class="when">${esc(when(b.at))}</span><span class="by">by ${esc(b.by)}</span></span>` : `<span class="spacer"></span>`;
  setHTML(view, `<div class="bvbar"><button class="btn-s" type="button" data-brief-back>◀ BACK</button>${meta}`
    + (b.loading ? "" : `${exportButton(`briefs/${b.id}`)}<button class="btn-s" type="button" data-comments-toggle="briefs/${b.id}">COMMENTS</button>${SPLIT_BUTTON}<button class="btn-s wideonly" type="button" data-view-full>${document.fullscreenElement === view ? "EXIT FULL SCREEN" : "FULL SCREEN"}</button><a class="btn-s wideonly" href="./#brief/${b.id}" target="_blank" rel="noopener" title="This brief in a window of its own, beside a room or a lane">NEW WINDOW</a>`)
    + `<a class="btn-s" data-brief-step="-1">NEWER</a><a class="btn-s" data-brief-step="1">OLDER</a></div>`
    + (b.loading ? `<div class="empty">LOADING…</div>`
      : page ? frameHTML(`/briefs/${b.id}.html`, b.title)
      : `<article class="bbody">
      <header><div class="meta">${floorChip(b.floor)}<span class="when">${esc(when(b.at))}</span><span class="by">by ${esc(b.by)}</span></div><h1>${mdInline(b.title)}</h1></header>
      <div class="md">${md(b.body)}</div></article>`)
    + (b.loading ? "" : `<aside class="cmount" data-comments="briefs/${b.id}"></aside>`));
  // What sits inside the brief, not its bar (NEWER, OLDER): a side opened from it adds a step (core/stage.js).
  for (const el of view.querySelectorAll(".bbody, .pageframe, .cmount")) el.dataset.trail = "";
  steps();
  if (!b.loading) emit("comments:mount", view.querySelector(".cmount"));
  view.scrollTop = 0;
  view.querySelector(".bbody")?.scrollTo?.(0, 0);
  renderList();
}
// NEWER and OLDER: the next brief in the list as it shows now (the floor you are in, or every floor in the building).
function steps() {
  const all = briefs(), i = all.findIndex((x) => x.id === shown?.id);
  for (const a of view.querySelectorAll("[data-brief-step]")) {
    const to = i < 0 ? null : all[i + Number(a.dataset.briefStep)];
    a.classList.toggle("off", !to);
    if (to) { a.setAttribute("href", `#brief/${to.id}`); a.removeAttribute("aria-disabled"); }
    else { a.removeAttribute("href"); a.setAttribute("aria-disabled", "true"); }
  }
}
// Inside another floor than the brief's: enter the brief's floor. Before the first state the page knows no floors yet;
// that state places it.
function place() {
  const f = officeFloor();
  if (shown && !shown.loading && shown.floor && f && f !== shown.floor) enter(shown.floor);
}
function close() {
  if (view.hidden) return;
  // Leaving while full screen: leave full screen first, or the browser keeps showing a hidden element (a blank screen).
  if (document.fullscreenElement && view.contains(document.fullscreenElement)) document.exitFullscreen?.().catch(() => {});
  shown = null;
  view.hidden = true;
  stage.classList.remove("inbrief");
  document.documentElement.classList.remove("briefopen");
  renderList();
}
const back = closeSide;
view.addEventListener("click", (e) => {
  if (e.target.closest("[data-brief-back]")) back();
  // FULL SCREEN: the brief alone on the screen (Esc, or the button again, leaves it).
  else if (e.target.closest("[data-view-full]")) fullScreen(view);
});
function fullScreen(el) {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  else el.requestFullscreen?.().catch(() => toast("THIS BROWSER WON'T GO FULL SCREEN HERE"));
}
document.addEventListener("fullscreenchange", () => {
  for (const b of view.querySelectorAll("[data-view-full]")) b.textContent = document.fullscreenElement === view ? "EXIT FULL SCREEN" : "FULL SCREEN";
});
// Esc closes the brief before the room beside it (capture), when Esc is the brief's (core/stage.js); in the comment box
// it first leaves the box.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view.hidden || !escIsFor(view)) return;
  e.preventDefault();
  if (leaveField(view)) return;
  back();
}, true);
on("nav", route);
on("state", () => { renderList(); steps(); if (openId() && !shown) route(); else place(); });
// The floor changed with a brief open: the brief's own floor (or the building) draws it again, so NEWER and OLDER follow
// the list; the owner going into another floor leaves the brief.
on("scope", () => {
  if (!shown || shown.loading) { renderList(); return; }
  const f = officeFloor();
  if (f && shown.floor && f !== shown.floor) back();
  else steps();
  renderList();
});
on("qtab", (t) => { if (t === "briefs") renderList(); });
renderList();
route();
