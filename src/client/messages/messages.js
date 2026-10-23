// The MESSAGES tab: one thread of HQ's updates and your notes, with replies.
import { $, keepPlace, pageScrolls, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { clock, esc, setHTML } from "../core/format.js";
import { clipText, linkify, renderBody } from "../core/text.js";
import { post } from "../core/net.js";
import { renderBelow } from "../questions/questions.js";
import { renderWork } from "../work-board/work-board.js";
import { selected } from "../room/input.js";

// QUESTIONS and MESSAGES share the question column; one shows at a time. The choice is remembered in this browser.
// MESSAGES is one thread, oldest at the top: HQ's updates and your notes, by time. A reply is an ordinary note
// that starts with  re: #u12 ("first words of the parent")  (u = from HQ, n = your note), so the server needs
// nothing new and HQ reads what the reply answers.
const REF = /^re: #([un])(\d+)(?: \("([^"\n]*)"\))?[ \t]*/;
export let qTab = (() => { try { const t = localStorage.getItem("hq-qtab"); return t === "messages" || t === "work" ? t : "questions"; } catch { return "questions"; } })();
export let replyTo = null, replyText = "", msgStick = true;
// Updates marked read by opening the tab keep their tint until you leave it, so you still see what was new.
const readSent = new Set(), msgFresh = new Set();
// A time today shows the clock; an older one its day too.
const when = (t) => (new Date(t).toDateString() === new Date().toDateString() ? clock(t) : `${new Date(t).toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(t)}`);
const short = (s, n) => { const t = String(s ?? "").replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export function setQTab(t) {
  if (t === qTab) return;
  // Where the page scrolls: a list you were in starts at its tabs, MESSAGES at its newest message; with the list
  // above the screen, what is on screen stays where it is.
  const wrap = $("qtabs").parentElement, was = pageScrolls() ? wrap.getBoundingClientRect() : null;
  if (qTab === "messages") msgFresh.clear();
  qTab = t;
  try { localStorage.setItem("hq-qtab", t); } catch {}
  msgStick = !was || was.bottom > 0;
  renderQTabs();
  if (t === "messages") renderMsgs(); else renderBelow();
  renderWork();
  if (!was) return;
  const now = wrap.getBoundingClientRect();
  if (was.bottom <= 0) scrollBy(0, now.bottom - was.bottom);
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
  if (!S) return;
  // The counts are of what the tabs show: a focused lane's own, or everyone's.
  const n = selected ? S.open.filter((a) => a.lane === selected).length : S.open.length;
  const u = selected ? (S.updates ?? []).filter((x) => x.lane === selected && !x.read_at).length : S.updatesUnread ?? 0;
  $("qtCount").hidden = !n;
  $("qtCount").textContent = n;
  $("qtUnread").hidden = !u;
  $("qtUnread").textContent = `${u} NEW`;
}
// Every update and note becomes a message; a note that starts with a re: reference hangs under its parent.
// With a lane in focus, the thread is that lane's: its updates, its events and the replies to them (laneItems).
function msgModel() {
  const items = selected ? laneItems() : [
    ...(S.updates ?? []).map((u) => ({ key: `u${u.id}`, who: "HQ", at: u.at, lane: u.lane, title: u.title, text: u.body || "", unread: !u.read_at || msgFresh.has(u.id) })),
    ...S.notes.map((n) => {
      const r = n.text.match(REF);
      return { key: `n${n.id}`, who: "YOU", at: n.at, text: r ? n.text.slice(r[0].length) : n.text, parent: r ? r[1] + r[2] : null, said: r?.[3] || "", acked: !!n.acked_at };
    }),
  ];
  items.sort((a, b) => a.at - b.at);
  const byKey = new Map(items.map((m) => [m.key, Object.assign(m, { kids: [] })]));
  const roots = [];
  for (const m of items) {
    const p = m.parent ? byKey.get(m.parent) : null;
    m.up = p && p !== m && p.at <= m.at ? p : null;
    (m.up ? m.up.kids : roots).push(m);
  }
  return { roots, byKey };
}
// The focused lane's messages come from the server (/api/lanes/stream), which keeps more than the state's last 40
// updates; they are fetched when the thread is shown and again after every change of the state.
let laneStream = { lane: null, version: -1, items: null }, laneLoading = null;
function laneItems() {
  if (laneStream.lane !== selected || !laneStream.items) return [];
  return laneStream.items.map((m) => m.key[0] === "u"
    ? { key: m.key, who: "HQ", at: m.at, title: m.title, text: m.text, unread: !m.read || msgFresh.has(Number(m.key.slice(1))) }
    : m.key[0] === "n"
      ? { key: m.key, who: "YOU", at: m.at, text: m.text, parent: m.to, said: "", acked: m.acked }
      : { key: m.key, who: m.who === "you" ? "YOU" : String(m.who).toUpperCase(), at: m.at, text: m.text, event: true });
}
async function loadLaneStream() {
  const lane = selected, version = S.version, want = `${lane}|${version}`;
  if ((laneStream.lane === lane && laneStream.version === version) || laneLoading === want) return;
  laneLoading = want;
  try {
    const res = await (await fetch(`/api/lanes/stream?lane=${encodeURIComponent(lane)}`)).json();
    if (lane !== selected) return;
    // A new lane's thread opens at its newest message; on a phone, where the page scrolls, it stays under the
    // lane's bar instead, so the lane in focus stays in view.
    if (laneStream.lane !== lane && !pageScrolls()) msgStick = true;
    laneStream = { lane, version, items: res.items ?? [] };
  } catch { return; } finally { if (laneLoading === want) laneLoading = null; }
  renderMsgs();
}
function msgItem(m, nameParent) {
  const body = m.text ? `<div class="text">${m.text.includes("```") ? renderBody(m.text) : clipText(m.text, `m${m.key}`)}</div>` : "";
  // A reply names what it answers when that is not the message right above it, or is too old to be in the list.
  const to = m.up ? (nameParent ? `${m.up.who} ${clock(m.up.at)}: ${short(m.up.title || m.up.text, 70)}` : "") : m.parent ? `an earlier message${m.said ? `: ${m.said}` : ""}` : "";
  return `<article class="msg ${m.who === "YOU" ? "you" : "hq"}${m.event ? " ev" : ""}${m.unread ? " unread" : ""}" data-msg="${m.key}">
      <div class="meta"><span class="who">${esc(m.who)}</span><span class="tag">${when(m.at)}</span>${m.lane ? `<button class="tag lane" type="button" data-select="${esc(m.lane)}">${esc(m.lane)}</button>` : ""}${m.unread ? `<span class="tag new">NEW</span>` : ""}${m.key[0] === "n" ? `<span class="seen ${m.acked ? "ok" : ""}">${m.acked ? "HQ HAS IT" : "NOT PICKED UP YET"}</span>` : ""}${m.event ? "" : `<button class="btn-s" type="button" data-reply="${m.key}">${replyTo === m.key ? "CANCEL" : "REPLY"}</button>`}</div>
      ${to ? `<div class="quote">↩ to ${esc(to)}</div>` : ""}
      ${m.title ? `<h3>${linkify(m.title)}</h3>` : ""}${body}
    </article>${replyTo === m.key ? replyBox(m) : ""}`;
}
function replyBox(m) {
  return `<div class="thread rbox" data-rbox>
      <div class="quote">↩ ${m.who} ${clock(m.at)}: ${esc(short(m.title || m.text, 90))}</div>
      <div class="reply"><textarea name="reply" rows="2" placeholder="Your reply. ⌘↩ sends, Esc closes.">${esc(replyText)}</textarea><button class="send go" type="button" data-rsend ${replyText.trim() ? "" : "disabled"}>SEND</button></div>
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
  if (selected) loadLaneStream();
  for (const u of S.updates ?? []) {
    if (selected && u.lane !== selected) continue;
    if (u.read_at || readSent.has(u.id)) continue;
    readSent.add(u.id);
    msgFresh.add(u.id);
    post(`/api/updates/${u.id}/read`, {}).catch(() => readSent.delete(u.id));
  }
  const caret = document.activeElement?.closest?.("[data-rbox]") ? document.activeElement.selectionStart : null;
  const waiting = selected && laneStream.lane !== selected;
  const html = msgModel().roots.map((m) => msgNode(m, 0)).join("") || (waiting ? `<div class="empty">…</div>` : selected ? `<div class="empty">NO MESSAGES</div>` : `<div class="empty">No messages yet. HQ's updates and your notes land here.</div>`);
  if (pageScrolls()) {
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
  if (caret != null) { const ta = box.querySelector("[data-rbox] textarea"); if (ta) { ta.focus(); ta.setSelectionRange(caret, caret); } }
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
  const text = replyText.trim();
  if (!text || !replyTo) return;
  const p = msgModel().byKey.get(replyTo);
  const said = p ? ` ("${short(p.title || p.text, 50).replace(/"/g, "'")}")` : "";
  btn.disabled = true;
  try {
    await post("/api/notes", { text: `re: #${replyTo}${said} ${text}` });
    replyTo = null; replyText = "";
    renderMsgs();
    toast("SENT TO HQ.");
  } catch (err) { toast(err.message); btn.disabled = false; }
}
$("qtabs").addEventListener("click", (e) => { const b = e.target.closest("[data-qtab]"); if (b) setQTab(b.dataset.qtab); });
$("stall").addEventListener("click", () => setQTab("work"));
$("msgs").addEventListener("click", (e) => {
  const r = e.target.closest("[data-reply]");
  if (r) {
    if (replyTo === r.dataset.reply) replyTo = null; else { replyTo = r.dataset.reply; replyText = ""; }
    renderMsgs();
    const rb = $("msgs").querySelector("[data-rbox]");
    if (rb) { rb.scrollIntoView({ block: "nearest" }); rb.querySelector("textarea").focus(); }
    return;
  }
  const send = e.target.closest("[data-rsend]");
  if (send) sendReply(send);
});
$("msgs").addEventListener("input", (e) => {
  if (!e.target.closest("[data-rbox]")) return;
  replyText = e.target.value;
  $("msgs").querySelector("[data-rsend]").disabled = !replyText.trim();
});
$("msgs").addEventListener("keydown", (e) => {
  if (!e.target.closest("[data-rbox]")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("msgs").querySelector("[data-rsend]")?.click();
  if (e.key === "Escape") { replyTo = null; renderMsgs(); }
});
renderQTabs();
