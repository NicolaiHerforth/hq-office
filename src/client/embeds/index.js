// RICH CARDS of HQ things. A paragraph that is only a reference (core/refs.js: #brief/12, #room/SLUG, #lane/NAME,
// #ask/ID, #floor/ID, a shelf file or a room's brief), which core/markdown.js marks <p class="hudref">, becomes a card
// of that thing wherever text is shown: its kind, title, live status chips, one line, a picture for an image, and its
// floor's colour when it is on another floor than the one you are in. A click opens it where it opens today.
//
// The card comes from S (embeds/model.js), so it changes with every state; what S does not hold (a shelf file, a room's
// brief, an old brief, question or room) comes from GET /api/refs, read again after a state change at most every 3 s
// while such a card is on screen. A reference to something gone is a muted NOT FOUND card, never an error.
//
// #lane/NAME, #ask/ID and #floor/ID are actions, not places: a click opens the lane's drawer, goes to the question or
// enters the floor without changing the address, so a card inside a brief or a room leaves it open. Typed into the
// address, they act once and the address is cleared. A shelf file that is not a page opens in a new tab, as on the shelf.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { toast } from "../core/dom.js";
import { esc } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { parseRef } from "../core/refs.js";
import { STATUS_TEXT } from "../core/status.js";
import { floorById, inkOn, multi } from "../core/floors.js";
import { enter, listFloor, officeFloor } from "../core/scope.js";
import { select } from "../room/input.js";
import { cardOf } from "./model.js";

// ---- what a card says: from S, else from the server ----

const fromS = {
  brief: (id) => S?.briefs?.find((b) => b.id === id),
  replies: (key) => S?.comments?.[key]?.unread ?? 0,
  room: (slug) => S?.rooms?.find((r) => r.slug === slug),
  lane: (name) => S?.lanes?.find((l) => l.name === name) ?? null,
  ask: (id) => S?.open?.find((a) => a.id === id) ?? S?.answered?.find((a) => a.id === id),
  floor: (id) => S?.floors?.find((f) => f.id === id) ?? null,
  file: () => undefined,
  roombrief: () => undefined,
};

const served = new Map(); // ref -> { card, stale }: what the server said
const wanted = new Set();
let timer = null, lastFetch = 0;
function want(ref) {
  wanted.add(ref);
  timer ??= setTimeout(fetchWanted, Math.max(0, lastFetch + 3000 - Date.now()));
}
async function fetchWanted() {
  const refs = [...wanted];
  wanted.clear();
  lastFetch = Date.now();
  try {
    for (let i = 0; i < refs.length; i += 50) {
      const r = await fetch(`/api/refs?${refs.slice(i, i + 50).map((x) => `r=${encodeURIComponent(x)}`).join("&")}`, { cache: "no-store" });
      if (!r.ok) continue;
      for (const [ref, card] of Object.entries((await r.json()).cards ?? {})) served.set(ref, { card, stale: false });
    }
  } catch {}
  timer = null;
  if (wanted.size) want([...wanted][0]);
  refresh();
}
// The card for a reference: a card, null (gone) or undefined (not known yet).
function resolve(p) {
  const c = cardOf(p, fromS);
  if (c !== undefined) return c;
  const hit = served.get(p.ref);
  if (!hit || hit.stale) want(p.ref);
  return hit?.card;
}

// ---- drawing ----

const chipHTML = (c) => {
  if (c.c === "st") {
    const [label, color] = STATUS_TEXT[c.status] ?? [c.t, ""];
    return `<span class="hchip st"${color ? ` style="background:${esc(color)}"` : ""}>${esc(String(label).toUpperCase())}</span>`;
  }
  return `<span class="hchip ${esc(c.c)}">${esc(c.t)}</span>`;
};
const WORD = { brief: "BRIEF", room: "ROOM", lane: "LANE", ask: "QUESTION", floor: "FLOOR", file: "FILE", roombrief: "ROOM BRIEF" };
function cardHTML(p, label) {
  const c = resolve(p);
  const attrs = `data-ref="${esc(p.ref)}" data-label="${esc(label)}"`;
  if (c === undefined) return `<div class="hudcard loading" ${attrs} aria-busy="true"><span class="hcbody"><span class="hchead"><span class="hcword">${WORD[p.kind]}</span></span><b class="hctitle">${esc(label)}</b><span class="hcprev">…</span></span></div>`;
  if (c === null) return `<div class="hudcard gone" ${attrs} role="note"><span class="hcbody"><span class="hchead"><span class="hcword">${WORD[p.kind]}</span><span class="hchip muted">NOT FOUND</span></span><b class="hctitle">${esc(label)}</b><span class="hcprev">Gone, or not on this HUD: #${esc(p.ref)}</span></span></div>`;
  // Its floor, when that is not the floor you are in: a stripe in the floor's colour and its name.
  const f = multi(S) && c.floor ? floorById(S, c.floor) : null;
  const other = f && (c.kind === "floor" || c.floor !== officeFloor());
  const style = other ? ` style="--fc:${esc(f.color)};--fi:${inkOn(f.color)}"` : "";
  const title = c.kind === "lane" || c.kind === "floor" ? esc(c.title) : mdInline(c.title, { links: false });
  return `<a class="hudcard k-${c.kind}${other ? " other" : ""}" href="${esc(c.href)}"${c.tab ? ` target="_blank" rel="noopener"` : ""} ${attrs}${style}>`
    + (c.thumb ? `<span class="hcthumb"><img src="${esc(c.thumb)}" alt="" loading="lazy"></span>` : "")
    + `<span class="hcbody"><span class="hchead"><span class="hcword">${esc(c.word)}</span>${other && c.kind !== "floor" ? `<span class="hcfloor">${esc(f.name)}</span>` : ""}${c.chips.map(chipHTML).join("")}</span>`
    + `<b class="hctitle">${title}</b>${c.preview ? `<span class="hcprev">${mdInline(c.preview, { links: false })}</span>` : ""}</span></a>`;
}

const drawn = new WeakMap(); // card element -> the HTML it was drawn from
function put(old, html) {
  if (drawn.get(old) === html) return;
  const t = document.createElement("template");
  t.innerHTML = html;
  const el = t.content.firstElementChild;
  drawn.set(el, html);
  old.replaceWith(el);
}
// A marked paragraph becomes a card, in place.
const marked = document.getElementsByClassName("hudref");
function upgrade() {
  for (const para of [...marked]) {
    const a = para.querySelector("a[href]"), p = a && parseRef(a.getAttribute("href"));
    if (!p) { para.classList.remove("hudref"); continue; }
    put(para, cardHTML(p, a.textContent.trim()));
  }
}
// Every card on screen, again: after a state change, or once the server answered.
function refresh() {
  for (const el of [...document.querySelectorAll(".hudcard[data-ref]")]) {
    const p = parseRef(el.dataset.ref);
    if (p) put(el, cardHTML(p, el.dataset.label ?? ""));
  }
}
new MutationObserver(() => { if (marked.length) upgrade(); }).observe(document.body, { childList: true, subtree: true });
on("state", () => {
  for (const hit of served.values()) hit.stale = true;
  refresh();
});
on("scope", refresh);
upgrade();

// ---- opening one: lanes, questions and floors are actions ----

function flash(el) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}
function openAsk(id) {
  const open = S?.open?.find((a) => a.id === id);
  if (open) {
    // A question on a floor the lists leave out: into its floor first.
    if (listFloor() && open.floor !== listFloor()) enter(open.floor);
    document.querySelector('[data-qtab="questions"]')?.click();
    requestAnimationFrame(() => { const el = document.querySelector(`.ask[data-ask="${id}"]`); if (el) flash(el); });
    return;
  }
  const done = S?.answered?.find((a) => a.id === id);
  if (done && done.status !== "withdrawn") {
    if (listFloor() && done.floor !== listFloor()) enter(done.floor);
    document.querySelector('[data-qtab="messages"]')?.click();
    requestAnimationFrame(() => { const el = document.querySelector(`[data-msg="a${id}"]`); if (el) flash(el); else toast(`QUESTION #${id} IS ANSWERED`); });
    return;
  }
  toast(done ? `QUESTION #${id} WAS WITHDRAWN` : `QUESTION #${id} IS NOT OPEN ANY MORE`);
}
function act(p) {
  if (p.kind === "lane") {
    if (S?.lanes?.some((l) => l.name === p.name)) select(p.name);
    else toast(`NO LANE ${p.name.toUpperCase()}`);
  } else if (p.kind === "ask") openAsk(p.id);
  else if (p.kind === "floor") {
    if (floorById(S, p.id)) enter(multi(S) ? p.id : null);
    else toast(`NO FLOOR ${p.id.toUpperCase()}`);
  }
}
const ACTION = /^#(?:lane|ask|floor)\//;
document.addEventListener("click", (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  const a = e.target.closest?.("a[href^='#']");
  if (!a) return;
  const href = a.getAttribute("href"), p = parseRef(href);
  if (!p) return;
  // Full screen shows only the view the card sits in: whatever the card opens would be behind it.
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (ACTION.test(href)) { e.preventDefault(); act(p); return; }
  // A shelf file that is not a page, named by its page address in a link: the file itself, in a new tab.
  if (p.kind === "file" && !/\.html?$/i.test(p.name)) { e.preventDefault(); open(`/rooms/${p.slug}/files/${encodeURIComponent(p.name)}`, "_blank", "noopener"); }
});
function route() {
  if (!ACTION.test(location.hash) || !S) return;
  const p = parseRef(location.hash);
  history.replaceState(history.state, "", location.pathname + location.search);
  if (p) act(p);
}
addEventListener("hashchange", route);
on("state", route);
route();
