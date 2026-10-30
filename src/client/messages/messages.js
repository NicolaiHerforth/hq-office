// The MESSAGES tab: one thread of HQ's updates, your notes and your answers to HQ's questions, with replies.
import { $, keepPlace, keepScroll, pageScrolls, phone, showEdges, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { clock, esc, setHTML } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { post } from "../core/net.js";
import { renderBelow } from "../questions/questions.js";
import { renderWork } from "../work-board/work-board.js";
import { on } from "../core/bus.js";
import { clearImages, composer, hasImages, notReady, withImages } from "../images/images.js";
import { emit } from "../core/bus.js";
import { listFloor, pick, tagged } from "../core/scope.js";
import { floorById, floorTagHTML } from "../core/floors.js";
import { messageChime } from "../sound/sound.js";

// QUESTIONS and MESSAGES share the question column; one shows at a time. The choice is remembered in this browser.
// MESSAGES is one thread, oldest at the top: HQ's updates, your notes and your answers, by time. A reply is an ordinary note
// that starts with  re: #u12 ("first words of the parent")  (u = from HQ, n = your note), so the server needs
// nothing new and HQ reads what the reply answers.
const REF = /^re: #([un])(\d+)(?: \("([^"\n]*)"\))?[ \t]*/;
export let qTab = (() => { try { const t = localStorage.getItem("hq-qtab"); return ["messages", "work", "rooms", "briefs"].includes(t) ? t : "questions"; } catch { return "questions"; } })();
export let replyTo = null, replyText = "", msgStick = true;
// The open reply, put back after the page reloads (questions/drafts.js keeps it with the other drafts).
export function setReply(to, text) { replyTo = to; replyText = text; }
// Updates marked read by opening the tab keep their tint until you leave it, so you still see what was new.
const readSent = new Set(), msgFresh = new Set();
const short = (s, n) => { const t = String(s ?? "").replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function setQTab(t) {
  if (t === qTab) return;
  // Where the page scrolls: a list you were in starts at its tabs, MESSAGES at its newest message; with the list
  // above the screen, what is on screen stays where it is. On a phone the thread scrolls itself: it opens at its
  // newest message, and the page scrolls (no further than the tabs) until the thread and Tell HQ under it show.
  const wrap = $("qtabs").parentElement, was = pageScrolls() ? wrap.getBoundingClientRect() : null;
  if (qTab === "messages") msgFresh.clear();
  qTab = t;
  try { localStorage.setItem("hq-qtab", t); } catch {}
  msgStick = !was || was.bottom > 0 || phone();
  renderQTabs();
  if (t === "messages") renderMsgs(); else renderBelow();
  renderWork();
  emit("qtab", t); // ROOMS (rooms/) and BRIEFS (briefs/) draw themselves when shown
  if (!was) return;
  const now = wrap.getBoundingClientRect();
  if (was.bottom <= 0) scrollBy(0, now.bottom - was.bottom);
  else if (t === "messages" && phone()) scrollBy(0, Math.min(now.top, Math.max(0, wrap.parentElement.getBoundingClientRect().bottom - innerHeight + 8)));
  else if (t !== "messages" && now.top < 0) scrollBy(0, now.top);
}
export function renderQTabs() {
  for (const b of $("qtabs").querySelectorAll("[data-qtab]")) {
    const on = b.dataset.qtab === qTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  $("hud").hidden = qTab !== "questions";
  $("msgs").hidden = qTab !== "messages";
  $("work").hidden = qTab !== "work";
  $("rooms").hidden = qTab !== "rooms"; // its count is set by rooms/
  $("briefs").hidden = qTab !== "briefs"; // its list and count are briefs/
  if (!S) return;
  // Inside a floor the tabs count that floor's (docs/floors.md); WAITING ON YOU in the top bar counts every floor.
  const n = pick(S.open).length, u = unreadIn(listFloor());
  $("qtCount").hidden = !n;
  $("qtCount").textContent = n;
  $("qtUnread").hidden = !u;
  $("qtUnread").textContent = u; // a number, like every tab's count; the colour says new
  $("qtUnread").title = `${u} new from HQ`;
}
// Unread updates from HQ: a floor's (S.floors counts every one, not only the newest 40), or every floor's.
export const unreadIn = (floor) => (floor ? floorById(S, floor)?.counts?.unreadMessages ?? 0 : S.updatesUnread ?? 0);
// A chime when HQ sends something new (SOUND on).
let seenUpdates = null;
export function announceUpdates() {
  const unread = new Set((S.updates ?? []).filter((u) => !u.read_at).map((u) => u.id));
  if (seenUpdates && [...unread].some((id) => !seenUpdates.has(id))) messageChime();
  seenUpdates = unread;
}
// Every update, note and answer becomes a message; a note that starts with a re: reference hangs under its parent.
// An answer is yours: the question it answers is its title, your answer its text, and whether HQ acted on it.
function msgModel() {
  const items = [
    ...pick(S.answered ?? []).filter((a) => a.answered_at && a.status !== "withdrawn").map((a) => ({ key: `a${a.id}`, who: "YOU", at: a.answered_at, lane: a.lane, floor: a.floor, title: a.title, text: a.answer || "", answer: true, acked: !!a.acked_at })),
    ...pick(S.updates).map((u) => ({ key: `u${u.id}`, who: "HQ", at: u.at, lane: u.lane, floor: u.floor, title: u.title, text: u.body || "", unread: !u.read_at || msgFresh.has(u.id) })),
    ...pick(S.notes).map((n) => {
      const r = n.text.match(REF);
      return { key: `n${n.id}`, who: "YOU", at: n.at, floor: n.floor, text: r ? n.text.slice(r[0].length) : n.text, parent: r ? r[1] + r[2] : null, said: r?.[3] || "", acked: !!n.acked_at };
    }),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  const byKey = new Map(items.map((m) => [m.key, Object.assign(m, { kids: [] })]));
  const roots = [];
  for (const m of items) {
    const p = m.parent ? byKey.get(m.parent) : null;
    m.up = p && p !== m && p.at <= m.at ? p : null;
    (m.up ? m.up.kids : roots).push(m);
  }
  return { roots, byKey };
}
function msgItem(m, nameParent) {
  const body = m.text ? `<div class="text md">${mdClip(m.text, `m${m.key}`)}</div>` : "";
  // A reply names what it answers when that is not the message right above it, or is too old to be in the list.
  const to = m.up ? (nameParent ? `${m.up.who} ${clock(m.up.at)}: ${short(m.up.title || m.up.text, 70)}` : "") : m.parent ? `an earlier message${m.said ? `: ${m.said}` : ""}` : "";
  return `<article class="msg ${m.who === "HQ" ? "hq" : "you"}${m.unread ? " unread" : ""}" data-msg="${m.key}">
      <div class="meta">${tagged() ? floorTagHTML(S, m.floor) : ""}<span class="who">${m.who}</span><span class="tag">${clock(m.at)}</span>${m.answer ? `<span class="tag ans">ANSWERED</span>` : ""}${m.lane ? `<span class="tag lane">${esc(m.lane)}</span>` : ""}${m.unread ? `<span class="tag new">NEW</span>` : ""}${m.who === "YOU" ? `<span class="seen ${m.acked ? "ok" : ""}">${m.answer ? (m.acked ? "HQ ACTED" : "HQ TO ACT") : m.acked ? "HQ HAS IT" : "NOT PICKED UP YET"}</span>` : ""}${m.answer ? "" : `<button class="btn-s" type="button" data-reply="${m.key}">${replyTo === m.key ? "CANCEL" : "REPLY"}</button>`}</div>
      ${to ? `<div class="quote">↩ to ${mdInline(to, { links: false })}</div>` : ""}
      ${m.title ? `<h3>${mdInline(m.title)}</h3>` : ""}${body}
    </article>${replyTo === m.key ? replyBox(m) : ""}`;
}
function replyBox(m) {
  return `<div class="thread rbox" data-rbox>
      <div class="quote">↩ ${m.who} ${clock(m.at)}: ${mdInline(short(m.title || m.text, 90), { links: false })}</div>
      ${composer("reply", `<textarea name="reply" rows="1" placeholder="Your reply. ⌘↩ sends, Esc closes.">${esc(replyText)}</textarea>`, `<button class="send go" type="button" data-rsend ${replyText.trim() || hasImages("reply") ? "" : "disabled"}>SEND</button>`)}
    </div>`;
}
// Two levels of indent at most. Under the second level, every deeper reply sits at that level and names its parent.
function msgNode(m, depth) {
  if (depth < 2) return msgItem(m, false) + (m.kids.length ? `<div class="thread">${m.kids.map((k) => msgNode(k, depth + 1)).join("")}</div>` : "");
  const flat = [];
  const walk = (x) => { for (const k of x.kids) { flat.push(k); walk(k); } };
  walk(m);
  return [m, ...flat.sort((a, b) => a.at - b.at)].map((x, i) => msgItem(x, i > 0)).join("");
}
// Built only when the state changes or you act on the list, never per frame. Reading sends nothing to HQ:
// it only marks the shown updates read, the same call the FROM HQ tab makes.
export function renderMsgs() {
  if (qTab !== "messages" || !S) return;
  const box = $("msgs");
  // Only what shows is marked read: inside a floor, that floor's updates.
  for (const u of pick(S.updates)) {
    if (u.read_at || readSent.has(u.id)) continue;
    readSent.add(u.id);
    msgFresh.add(u.id);
    post(`/api/updates/${u.id}/read`, {}).catch(() => readSent.delete(u.id));
  }
  const caret = document.activeElement?.closest?.("[data-rbox]") ? document.activeElement.selectionStart : null;
  const html = (msgModel().roots.map((m) => msgNode(m, 0)).join("") || `<div class="empty">No messages yet. HQ's updates, your notes and your answers land here.</div>`);
  if (phone()) {
    // The thread scrolls itself (core/layout.css): at the newest message (just opened, or within 40px of it), stay
    // on it; reading older ones, what you read stays where it is, whatever lands above or below.
    const pinned = msgStick || box.scrollHeight - box.scrollTop - box.clientHeight < 40, place = pinned ? null : keepScroll(box, "data-msg");
    setHTML(box, html);
    if (pinned) box.scrollTop = box.scrollHeight; else place();
    showEdges(box);
  } else if (pageScrolls()) {
    // The page scrolls, not the thread: on the newest message (just opened, or already there), stay on it;
    // reading older ones, what you read stays where it is.
    const pinned = msgStick || atNewest(box), place = pinned ? null : keepPlace(box, "data-msg");
    setHTML(box, html);
    if (pinned) showNewest(box); else place();
  } else {
    const atBottom = msgStick || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const top = box.scrollTop;
    if (setHTML(box, html) || msgStick) box.scrollTop = atBottom ? box.scrollHeight : top;
  }
  msgStick = false;
  if (caret != null) { const ta = box.querySelector("[data-rbox] textarea"); if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(caret, caret); } }
}
const lastMsg = (box) => { const all = box.querySelectorAll("[data-msg]"); return all[all.length - 1]; };
// The newest message is on screen, or its bottom is just under the edge.
function atNewest(box) {
  const r = lastMsg(box)?.getBoundingClientRect();
  return !r || (r.bottom > 0 && r.bottom <= innerHeight + 40);
}
// Scroll the page only as far as it takes to show the newest message at the bottom of the screen.
function showNewest(box) {
  const r = lastMsg(box)?.getBoundingClientRect();
  if (r && (r.bottom < 0 || r.bottom > innerHeight - 12)) scrollBy(0, r.bottom - innerHeight + 12);
}
async function sendReply(btn) {
  const text = withImages("reply", replyText.trim());
  if (!text || !replyTo) return;
  const wait = notReady("reply");
  if (wait) { toast(wait); return; }
  const p = msgModel().byKey.get(replyTo);
  const said = p ? ` ("${short(p.title || p.text, 50).replace(/"/g, "'")}")` : "";
  btn.disabled = true;
  try {
    // A reply goes to the HQ of the floor of what it answers.
    await post("/api/notes", { text: `re: #${replyTo}${said} ${text}`, ...(p?.floor && S.floors?.length > 1 ? { floor: p.floor } : {}) });
    replyTo = null; replyText = "";
    clearImages("reply");
    renderMsgs();
    toast("SENT TO HQ.");
  } catch (err) { toast(err.message); btn.disabled = false; }
}
$("qtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-qtab]"); if (b) setQTab(b.dataset.qtab); });
$("stall").addEventListener("click", () => setQTab("work"));
$("msgs").addEventListener("click", (e) => {
  const r = e.target.closest("[data-reply]");
  if (r) {
    if (replyTo === r.dataset.reply) replyTo = null; else { replyTo = r.dataset.reply; replyText = ""; clearImages("reply"); }
    renderMsgs();
    const rb = $("msgs").querySelector("[data-rbox]");
    if (rb) { rb.scrollIntoView({ block: "nearest" }); rb.querySelector("textarea").focus(); }
    return;
  }
  const send = e.target.closest("[data-rsend]");
  if (send) sendReply(send);
});
$("msgs").addEventListener("scroll", () => showEdges($("msgs")), { passive: true });
$("msgs").addEventListener("input", (e) => {
  if (!e.target.closest("[data-rbox]") || e.target.tagName !== "TEXTAREA") return;
  replyText = e.target.value;
  $("msgs").querySelector("[data-rsend]").disabled = !replyText.trim() && !hasImages("reply");
});
on("attach", (key) => {
  const btn = key === "reply" && $("msgs").querySelector("[data-rsend]");
  if (btn) btn.disabled = !replyText.trim() && !hasImages("reply");
});
$("msgs").addEventListener("keydown", (e) => {
  if (!e.target.closest("[data-rbox]")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("msgs").querySelector("[data-rsend]")?.click();
  if (e.key === "Escape") { replyTo = null; renderMsgs(); }
});
renderQTabs();
