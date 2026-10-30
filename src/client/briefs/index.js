// BRIEFS: a floor's HQ's longer write-ups (hud brief), like a project update. The BRIEFS tab in the question column
// lists the floor's briefs newest first, with the date, who posted it and its first lines; NEW marks one you have not
// opened. Opening one (from the list, or the line MESSAGES gets, #brief/ID) takes the right column at full width, the
// way a room does, with the whole brief in markdown (headings, tables, lists, code), BACK, NEWER and OLDER. On a
// narrow screen the brief fills the screen. Inside a floor, that floor's briefs (docs/floors.md).
import { $, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { on } from "../core/bus.js";
import { md, mdInline } from "../core/markdown.js";
import { pick, tagged } from "../core/scope.js";
import { floorById } from "../core/floors.js";

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
        <div class="meta">${floorChip(b.floor)}<span class="when">${esc(when(b.at))}</span>${b.read ? "" : `<span class="tag new">NEW</span>`}<span class="by">${esc(b.by)}</span></div>
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

const openId = () => { const m = location.hash.match(/^#brief\/(\d{1,9})$/); return m ? Number(m[1]) : null; };
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
      if (!r.ok) { toast(b.error?.toUpperCase?.() || `NO BRIEF #${id}`); history.replaceState(null, "", location.pathname + location.search); close(); return; }
      show(b);
      if (!b.read) post(`/api/briefs/${id}/read`, {}).catch(() => {});
    } catch (err) { toast(err.message); }
  }
}
function show(b) {
  shown = b;
  view.hidden = false;
  stage.classList.add("inbrief");
  document.documentElement.classList.add("briefopen");
  const all = briefs(), i = all.findIndex((x) => x.id === b.id);
  const newer = i > 0 ? all[i - 1] : null, older = i >= 0 && i < all.length - 1 ? all[i + 1] : null;
  setHTML(view, `<div class="bvbar"><button class="btn-s" type="button" data-brief-back>◀ BACK</button><span class="spacer"></span>`
    + `<a class="btn-s${newer ? "" : " off"}" ${newer ? `href="#brief/${newer.id}"` : `aria-disabled="true"`}>NEWER</a><a class="btn-s${older ? "" : " off"}" ${older ? `href="#brief/${older.id}"` : `aria-disabled="true"`}>OLDER</a></div>`
    + (b.loading ? `<div class="empty">LOADING…</div>` : `<article class="bbody">
      <header><div class="meta">${floorChip(b.floor)}<span class="when">${esc(when(b.at))}</span><span class="by">by ${esc(b.by)}</span></div><h1>${mdInline(b.title)}</h1></header>
      <div class="md">${md(b.body)}</div></article>`));
  view.scrollTop = 0;
  view.querySelector(".bbody")?.scrollTo?.(0, 0);
  renderList();
}
function close() {
  if (view.hidden) return;
  shown = null;
  view.hidden = true;
  stage.classList.remove("inbrief");
  document.documentElement.classList.remove("briefopen");
  renderList();
}
function back() {
  if (history.state?.hqBrief) history.back();
  else { history.replaceState(null, "", location.pathname + location.search); route(); }
}
view.addEventListener("click", (e) => { if (e.target.closest("[data-brief-back]")) back(); });
// A brief link adds one step to the history from elsewhere; from brief to brief it replaces it, so BACK leaves.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#brief/"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  const url = `${location.pathname}${location.search}${a.getAttribute("href")}`;
  if (openId()) history.replaceState({ hqBrief: true }, "", url); else history.pushState({ hqBrief: true }, "", url);
  route();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || view.hidden) return;
  e.preventDefault();
  back();
});
addEventListener("hashchange", route);
addEventListener("popstate", route);
on("state", () => { renderList(); if (openId() && !shown) route(); });
on("scope", renderList);
on("qtab", (t) => { if (t === "briefs") renderList(); });
renderList();
route();
