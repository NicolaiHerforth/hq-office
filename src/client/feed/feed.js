// The box under the room: FROM HQ updates and the SENT & ANSWERED log, and the note under Tell HQ.
import { $, keepScroll, phone, showEdges } from "../core/dom.js";
import { S } from "../core/state.js";
import { messageChime } from "../sound/sound.js";
import { clock, esc, setHTML } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { scheduleTick } from "../questions/questions.js";
import { liveSecrets, lostSecrets, renderSecrets } from "../secrets/secrets.js";
import { listFloor, pick, tagged } from "../core/scope.js";
import { floorTagHTML, linkOf } from "../core/floors.js";
import { unreadIn } from "../messages/messages.js";

let seenUpdates = null, shownTab = null;

// FROM HQ: information, not questions. Newest first; unread ones are tinted. Nothing here waits, times or scores.
// It shares the box under the room with your sent log; the top bar's FROM HQ box opens this tab.
export let feedTab = "updates";
function updateRows() {
  // Inside a floor, that floor's (docs/floors.md); SECRETS stay global.
  const tags = tagged();
  const rows = pick(S.updates).map((u) => `<article class="upd ${u.read_at ? "" : "unread"}" data-upd="${u.id}">
      <div class="meta">${tags ? floorTagHTML(S, u.floor) : ""}<span class="tag">${clock(u.at)}</span>${u.lane ? `<span class="tag lane">${esc(u.lane)}</span>` : ""}${u.read_at ? "" : `<span class="tag new">NEW</span>`}</div>
      <h3>${mdInline(u.title)}</h3>
      ${u.body ? `<div class="text md">${mdClip(u.body, `u${u.id}`)}</div>` : ""}
    </article>`).join("");
  return (rows || `<div class="empty">Nothing from HQ yet.</div>`);
}
// The SECRETS pane is built once and only its list is redrawn, so a value being pasted survives every refresh.
export function renderFeed() {
  const unread = unreadIn(listFloor());
  const live = liveSecrets().length, lost = lostSecrets().length;
  const tab = (id, label, extra = "") => `<button class="tab ${feedTab === id ? "on" : ""}" type="button" data-tab="${id}">${label}${extra}</button>`;
  setHTML($("feedTabs"), `
      ${tab("updates", "FROM HQ", unread ? ` <span class="tag new">${unread} NEW</span>` : "")}
      ${tab("log", "SENT &amp; ANSWERED")}
      ${tab("secrets", "SECRETS", (live ? ` <span class="tag secret">${live}</span>` : "") + (lost ? ` <span class="tag secret lost">${lost} LOST</span>` : ""))}
      <span class="spacer"></span>
      ${feedTab === "updates" ? `<button class="btn-s" type="button" data-readall ${unread ? "" : "disabled"}>MARK ALL READ</button>` : ""}`);
  const secretsOn = feedTab === "secrets";
  $("feedBody").hidden = secretsOn;
  $("secretsPane").hidden = !secretsOn;
  if (!secretsOn) {
    const body = $("feedBody"), html = feedTab === "updates" ? updateRows() : `<div class="log" style="margin:0;max-height:none">${logRows()}</div>`;
    if (phone()) {
      // The list scrolls itself (core/layout.css), newest first: a tab opens at its top; at the top, a new update
      // shows there; reading older ones further down, what you read stays where it is.
      const opened = shownTab !== feedTab, place = !opened && body.scrollTop > 2 ? keepScroll(body, "data-upd") : null;
      setHTML(body, html);
      if (opened) body.scrollTop = 0; else place?.();
      showEdges(body);
    } else setHTML(body, html);
  }
  shownTab = feedTab;
  renderSecrets();
  scheduleTick(); // the SECRETS pane's countdown needs the page clock while it shows
}

export function announceUpdates() {
  const unread = new Set((S.updates ?? []).filter((u) => !u.read_at).map((u) => u.id));
  if (seenUpdates && [...unread].some((id) => !seenUpdates.has(id))) messageChime();
  seenUpdates = unread;
}

// Under Tell HQ: only your last note and whether HQ has it. The full log is the SENT & ANSWERED tab.
export function renderLog() {
  renderFeed();
  const n = pick(S.notes)[0];
  setHTML($("lastNote"), n
    ? `<b>LAST ${clock(n.at)}</b>${mdInline(n.text)} ${noteMark(n)}`
    : `<span style="color:var(--muted)">Nothing sent yet today.</span>`);
}
// Where a note or an answer stands with HQ (S.hq.deliveries, see hq-link.ts): acked by HQ, delivered (HQ started
// working on it), typed in while HQ was busy (sent again once it is free), or held (not typed in yet).
// Each floor's HQ has its own link (S.hqLinks); the first floor's is S.hq.
const held = (link, ref) => (link?.held ?? []).some((h) => h.ref === ref);
const mark = (color, text) => `<span style="color:var(--${color})">· ${text}</span>`;
function deliveryMark(ref, acked, ackedText, waitingText, floor) {
  if (acked) return mark("green", ackedText);
  const link = linkOf(S, floor);
  if (held(link, ref)) return mark("red", "HELD: HQ isn't receiving");
  const d = link?.deliveries?.[ref];
  if (d === "held") return mark("amber", "sending to HQ");
  if (d === "unconfirmed") return mark("amber", "typed in while HQ was busy; sent again once it is free");
  if (d === "delivered") return mark("green", "delivered to HQ");
  return mark("amber", waitingText);
}
const noteMark = (n) => deliveryMark(`note:${n.id}`, !!n.acked_at, "HQ has it", "not picked up yet", n.floor);
function logRows() {
  // One list, newest first: your notes and HQ's answers interleaved by time.
  const tags = tagged(), tag = (x) => (tags ? floorTagHTML(S, x.floor) : "");
  const notes = pick(S.notes).slice(0, 5).map((n) => ({ at: n.at, html: `<div>${tag(n)}<b>${clock(n.at)} YOU</b><div class="md inl">${mdClip(n.text, `n${n.id}`)}</div> ${noteMark(n)}</div>` }));
  const answered = pick(S.answered).slice(0, 8).map((a) => ({ at: a.answered_at, html: `<div>${tag(a)}<b>${clock(a.answered_at)} ${a.status === "withdrawn" ? "WITHDRAWN" : "ANSWERED"}</b>${esc(a.lane ? a.lane + ": " : "")}${mdInline(a.title)} → <div class="md inl ans">${mdClip(a.answer, `a${a.id}`)}</div> ${a.status === "withdrawn" ? "" : deliveryMark(`ask:${a.id}`, !!a.acked_at, "HQ acted", "HQ to act", a.floor)}</div>` }));
  const rows = [...notes, ...answered].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return (rows.map((r) => r.html).join("") || `<div style="color:var(--muted)">Nothing yet today.</div>`);
}
$("feedBody").addEventListener("scroll", () => showEdges($("feedBody")), { passive: true });
export function setFeedTab(v) { return (feedTab = v); }
