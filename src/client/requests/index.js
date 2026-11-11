// REQUESTS on the WORK tab: everything the owner asked HQ for, in his own words, from the moment it arrives until it is
// delivered (S.requests, src/server/requests.ts), oldest first. Read-only: the weight is on HQ's side. The owner can
// only say a delivered or withdrawn one is not done (REOPEN, with his words) and take one off the list (CLOSE, in a
// row's history). A row unmoved for more than a day is amber, and the tab's badge counts those. A delivered or
// withdrawn row the owner has had on screen is reported seen, and the server closes it a day later.
// Drawn from the bus when the state or the tab changes; the one timer is the moment the next row turns amber.
import { on } from "../core/bus.js";
import { $, keepPlace, keepScroll, pageScrolls, toast } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { ago, clock, esc, setHTML } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { post } from "../core/net.js";
import { pick, tagged } from "../core/scope.js";
import { floorTagHTML } from "../core/floors.js";
import { ask } from "../core/sheet.js";
import { qTab, renderQTabs } from "../messages/messages.js";
import { STATUS, ended, live, movedAt, nextStaleAt, oldestFirst, prOf, stale, staleCount } from "./model.js";

const box = $("work"), count = $("qtStalled");
let openId = null; // the row whose history shows: one at a time
let reopen = null; // { id, said } while a row's REOPEN is open
let focusReopen = false;
const histories = new Map(); // id -> { key, moves, error }: a request's moves, read when its row opens
const seenSent = new Set(), onScreen = new Set();
let wake = 0;
let drawn = ""; // the list's markup as it shows now

const scoped = () => oldestFirst(pick(S?.requests ?? []));
const byId = (id) => (S?.requests ?? []).find((r) => r.id === id);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const dayOf = (t) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
const fullTime = (t) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const age = (t, now) => `<span data-since="${t}" data-ago>${ago(now - t)}</span>`;

// Who has it: the lane (its drawer, when it is a lane on the page), the issue and the PR when HQ gave them, and for one
// that waits on the owner, the question it waits on.
function ownerHTML(r) {
  const out = [];
  if (r.lane) {
    const known = (S.lanes ?? []).some((l) => l.name === r.lane);
    out.push(known ? `<button class="tag lane" type="button" data-select="${esc(r.lane)}">${esc(r.lane)}</button>` : `<span class="tag lane">${esc(r.lane === "hq" ? "HQ" : r.lane)}</span>`);
  } else if (r.status === "open") out.push(`<span class="tag none">NO OWNER YET</span>`);
  if (r.issue) {
    out.push(CONFIG.linearWorkspace
      ? `<a class="tag link" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(r.issue)}" target="_blank" rel="noopener">${esc(r.issue)}</a>`
      : `<span class="tag">${esc(r.issue)}</span>`);
  }
  const pr = prOf(r.pr);
  if (pr) {
    const href = pr.href ?? (pr.number && CONFIG.githubRepo ? `https://github.com/${CONFIG.githubRepo}/pull/${pr.number}` : null);
    out.push(href ? `<a class="tag link" href="${esc(href)}" target="_blank" rel="noopener">${esc(pr.label)}</a>` : `<span class="tag">${esc(pr.label)}</span>`);
  }
  if (r.status === "waiting" && r.ask) out.push(`<a class="tag link" href="#ask/${Number(r.ask)}">QUESTION #${Number(r.ask)}</a>`);
  return out.join("");
}
// The line under his words: where it stands and since when. HQ's text comes whole from the server (a long movement, an
// answer), so it is clipped here, with MORE.
const LINE = 200;
function lineHTML(r, now) {
  const at = movedAt(r), clip = (said) => mdClip(said, `rql${r.id}`, LINE);
  if (r.status === "delivered") {
    return `<div class="out"><div class="what md inl">${clip(`${r.link ?? ""}${r.link && r.line ? " · " : ""}${r.line ?? ""}`)}</div><span class="when">delivered ${age(at, now)} ago</span>${reopenButton(r)}</div>`;
  }
  if (r.status === "withdrawn") {
    return `<div class="out"><div class="what md inl">${clip(`HQ gave it up: ${r.line || r.moved || "no reason given"}`)}</div><span class="when">${age(at, now)} ago</span>${reopenButton(r)}</div>`;
  }
  const what = clip(r.status === "new" ? `HQ has not sorted it yet${r.moved ? `. ${r.moved}` : ""}` : r.moved || (r.status === "waiting" ? "waits on your answer" : r.status === "open" ? "nobody has it yet" : "assigned"));
  return `<div class="moved"><div class="what md inl">${what}</div><span class="when">${stale(r, now) ? `no movement for ${age(at, now)}` : `${age(at, now)} ago`}</span></div>`;
}
const reopenButton = (r) => (reopen?.id === r.id ? "" : `<button class="btn-s" type="button" data-rq-reopen title="Not done: say what is missing, and it goes back to HQ">REOPEN</button>`);
function reopenBox(r) {
  return `<form class="rqre" data-rq-re autocomplete="off">
      <input type="text" name="reopen" maxlength="2000" placeholder="What is still missing?" aria-label="Why request #${r.id} is not done" value="${esc(reopen.said)}">
      <button class="send go" type="submit" ${reopen.said.trim() ? "" : "disabled"}>SEND</button><button class="btn-s" type="button" data-rq-cancel>CANCEL</button>
    </form>`;
}
function moveHTML(m, now) {
  const who = m.by === "owner" || (CONFIG.owner && m.by === CONFIG.owner) ? "YOU" : String(m.by ?? "HQ").toUpperCase();
  return `<li><span class="hat" title="${esc(fullTime(m.at))}">${sameDay(m.at, now) ? clock(m.at) : `${esc(dayOf(m.at))} ${clock(m.at)}`}</span><b class="hby">${esc(who)}</b><span class="htext">${m.kind === "attached" ? `<i>said again:</i> ` : ""}${m.kind === "seen" ? "saw it here" : mdInline(m.text)}</span></li>`;
}
function historyHTML(r, now) {
  const h = histories.get(r.id);
  const body = h?.moves
    ? h.moves.length ? `<ol class="rqmoves">${h.moves.map((m) => moveHTML(m, now)).join("")}</ol>` : `<div class="hint">Nothing has happened yet.</div>`
    : `<div class="hint">${h?.error ? esc(h.error) : "LOADING…"}</div>`;
  const note = ended(r) ? "It leaves this list by itself, a day after you saw it." : "CLOSE takes it off this list: HQ stops tracking it.";
  return `<div class="rqhist">${body}<div class="rqacts"><span class="hint">${note}</span><button class="btn-s" type="button" data-rq-close>CLOSE</button></div></div>`;
}
function rowHTML(r, now) {
  const open = openId === r.id;
  return `<article class="rq s-${esc(r.status)}${stale(r, now) ? " stale" : ""}${open ? " unfolded" : ""}" data-rq="${r.id}">
      <div class="meta">${tagged() ? floorTagHTML(S, r.floor) : ""}<span class="tag rs s-${esc(r.status)}">${STATUS[r.status] ?? esc(r.status)}</span>${ownerHTML(r)}<span class="sent" title="You sent it ${esc(fullTime(r.at))}">#${r.id} · ${sameDay(r.at, now) ? clock(r.at) : esc(dayOf(r.at))}</span><button class="rqx" type="button" data-rq-toggle aria-expanded="${open}" aria-label="History of request #${r.id}">${open ? "▴" : "▾"}</button></div>
      <div class="words md">${mdClip(r.words, `rq${r.id}`)}</div>
      ${lineHTML(r, now)}${reopen?.id === r.id ? reopenBox(r) : ""}${open ? historyHTML(r, now) : ""}
    </article>`;
}

function render() {
  if (!S) return;
  const now = Date.now(), list = scoped();
  // The badge: how many are unmoved for more than a day, on the floor the lists show. The tabs fit themselves again.
  const n = staleCount(list, now);
  if (count.hidden !== !n || count.textContent !== String(n)) {
    count.hidden = !n;
    count.textContent = n;
    count.title = `${n} ${n === 1 ? "request has" : "requests have"} not moved for more than a day`;
    renderQTabs();
  }
  clearTimeout(wake);
  const next = nextStaleAt(list, now);
  if (next != null) wake = setTimeout(render, next - now);
  // Off the tab the list is empty, so nothing in it keeps the page clock awake.
  if (qTab !== "work") { if (drawn !== "") { setHTML(box, (drawn = "")); watch(); } return; }
  if (openId != null && !list.some((r) => r.id === openId)) openId = null;
  if (reopen && !list.some((r) => r.id === reopen.id && ended(r))) reopen = null;
  for (const r of list) if (!ended(r)) seenSent.delete(r.id); // reopened: its next delivery is news again
  const opened = list.find((r) => r.id === openId);
  if (opened) loadHistory(opened);
  const html = list.length
    ? `<div class="rsum">${list.length} ${list.length === 1 ? "REQUEST" : "REQUESTS"}${n ? ` · <b>${n} UNMOVED FOR OVER A DAY</b>` : ""}</div>${list.map((r) => rowHTML(r, now)).join("")}`
    : `<div class="empty">Nothing open. What you ask HQ for shows here until it is delivered.</div>`;
  if (html === drawn) return; // most states change nothing here: nothing is measured, nothing is built
  const typing = document.activeElement?.closest?.("[data-rq-re]") ? document.activeElement.selectionStart : null;
  const keep = pageScrolls() ? keepPlace(box, "data-rq") : keepScroll(box, "data-rq");
  setHTML(box, (drawn = html));
  keep();
  watch();
  const field = box.querySelector("[data-rq-re] input");
  if (field && (focusReopen || typing != null)) { field.focus({ preventScroll: !focusReopen }); const at = typing ?? field.value.length; field.setSelectionRange(at, at); }
  focusReopen = false;
}

// A row's moves, read when it opens and again when it has moved since.
async function loadHistory(r) {
  const key = movedAt(r), h = histories.get(r.id);
  if (h && (h.key === key || h.loading === key)) return;
  histories.set(r.id, { ...h, loading: key });
  let got;
  try {
    const res = await fetch(`/api/requests/${r.id}`, { cache: "no-store" });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.statusText);
    got = { key, moves: d.moves ?? d.request?.moves ?? [] };
  } catch (err) { got = { key, moves: h?.moves, error: err.message }; }
  histories.set(r.id, got);
  render();
}

// Seen: a delivered or withdrawn row that is on the screen, with the tab open and the page visible. Told once.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) { const id = Number(e.target.dataset.rq); if (e.isIntersecting) onScreen.add(id); else onScreen.delete(id); }
  tellSeen();
}, { threshold: 0.6 });
function watch() {
  io.disconnect();
  onScreen.clear();
  for (const el of box.querySelectorAll(".rq.s-delivered, .rq.s-withdrawn")) io.observe(el);
}
function tellSeen() {
  if (qTab !== "work" || document.visibilityState !== "visible" || !S) return;
  const ids = scoped().filter((r) => ended(r) && !r.seenAt && onScreen.has(r.id) && !seenSent.has(r.id)).map((r) => r.id);
  if (!ids.length) return;
  for (const id of ids) seenSent.add(id);
  post("/api/requests/seen", { ids }).catch(() => { for (const id of ids) seenSent.delete(id); });
}
document.addEventListener("visibilitychange", tellSeen);

async function sendReopen(form) {
  const r = byId(reopen?.id), said = reopen?.said.trim();
  if (!r || !said) return;
  const btn = form.querySelector(".send");
  btn.disabled = true;
  try {
    await post(`/api/requests/${r.id}/reopen`, { text: said });
    reopen = null;
    render();
    toast(`REQUEST #${r.id} IS OPEN AGAIN. HQ IS TOLD.`);
  } catch (err) { toast(err.message); btn.disabled = false; }
}
// One still on its way asks first: closed, nobody tracks it any more. One that is over only leaves a day early.
async function close(r, btn) {
  if (live(r) && !(await ask({ text: `Close request #${r.id}? It leaves this list and HQ stops tracking it.`, yes: "CLOSE IT" }))) return;
  btn.disabled = true;
  try {
    await post(`/api/requests/${r.id}/close`, {});
    toast(`REQUEST #${r.id} CLOSED.`);
  } catch (err) { toast(err.message); btn.disabled = false; }
}

box.addEventListener("click", (e) => {
  const row = e.target.closest("[data-rq]");
  if (!row) return;
  const id = Number(row.dataset.rq), r = byId(id);
  if (!r) return;
  if (e.target.closest("[data-rq-reopen]")) { reopen = { id, said: "" }; focusReopen = true; render(); return; }
  if (e.target.closest("[data-rq-cancel]")) { reopen = null; render(); return; }
  const shut = e.target.closest("[data-rq-close]");
  if (shut) { close(r, shut); return; }
  // A tap on the row opens its history; a link, a button, the REOPEN box, the history itself or marked text does not.
  if (!e.target.closest("[data-rq-toggle]") && (e.target.closest("a, button, input, form, .rqhist") || String(getSelection?.() ?? "").trim())) return;
  openId = openId === id ? null : id;
  const h = histories.get(id);
  if (openId && h) h.key = null; // read it again: something may have been said again without a move
  render();
});
box.addEventListener("submit", (e) => { const f = e.target.closest("[data-rq-re]"); if (f) { e.preventDefault(); sendReopen(f); } });
box.addEventListener("input", (e) => {
  const f = e.target.closest("[data-rq-re]");
  if (!f || !reopen) return;
  reopen.said = e.target.value;
  f.querySelector(".send").disabled = !reopen.said.trim();
});
box.addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.closest("[data-rq-re]")) { e.stopPropagation(); reopen = null; render(); } });
// MORE and LESS on his words: core/clicks.js (loaded before this) has changed what is open by now.
document.addEventListener("click", (e) => { if (e.target.closest?.("#work .more[data-more]")) render(); });

on("state", render);
on("scope", render);
on("qtab", render);
render(); // the state may have come before this module
