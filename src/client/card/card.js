// The agent drawer: clicking a worker in the office, or a lane on the lanes board, slides it in from the right over
// the office. Read-only: talking to a lane goes through its room. From the top: who it is and its status; its open
// questions (ANSWER IN NEEDS YOU jumps to the question, so answering stays in one place); a prompt it is blocked on;
// NOW, its terminal (the last 30 lines, read from herdr every 3 seconds while the drawer is open and the page is
// visible, never otherwise; GET /api/lanes/NAME/live); what it last said; and its work (issue, PR, rooms). ✕ or Esc
// closes it; a sheet at the bottom of a narrow screen.
import { $, overOffice } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { select, selected } from "../room/input.js";
import { STATUS_TEXT } from "../core/status.js";
import { clock, dur, esc, setHTML } from "../core/format.js";
import { fence, md, mdInline } from "../core/markdown.js";
import { ranked, themeOf } from "../room/looks.js";
import { settings } from "../settings/prefs.js";

const EVERY = 3000;
let live = null; // { name, terminal: { text, at, error }, said: [...] } for the selected lane, from the server
let polling = null, timer = null;

// How long it has been in its status: waiting on you since its oldest open question (as the lanes board says), else
// since herdr last changed its status.
const since = (lane, asks) => (lane.status === "needs_you" && asks.length ? Math.min(...asks.map((a) => a.created_at)) : lane.herdr_since);
export function renderCard() {
  const card = $("card");
  const lane = S?.lanes.find((l) => l.name === selected);
  const was = !card.hidden;
  card.hidden = !lane;
  if (!lane) { stopPolling(); return; }
  overOffice(card);
  // Desktop: from the office's top to the foot of the right column (over the lanes board too, when it shows).
  if (matchMedia("(min-width: 1151px)").matches) {
    const h = card.parentElement.clientHeight - card.offsetTop - 8;
    card.style.height = card.style.maxHeight = `${Math.max(240, h)}px`;
  }
  if (!was) card.classList.remove("in"), void card.offsetWidth, card.classList.add("in");
  if (live?.name !== lane.name) live = null;
  if (polling !== lane.name) startPolling(lane.name);
  const [label, color] = STATUS_TEXT[lane.status] || [lane.status, "#6a6a82"];
  const asks = S.open.filter((a) => a.lane === lane.name);
  const links = [
    ...(lane.issue && CONFIG.linearWorkspace ? lane.issue.split(/[ ,]+/).filter(Boolean).map((i) => `<a class="tag" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(i)}" target="_blank" rel="noopener">${esc(i)}</a>`) : []),
    ...(lane.pr && CONFIG.githubRepo ? String(lane.pr).split(/[ ,]+/).filter(Boolean).map((p) => `<a class="tag" href="https://github.com/${CONFIG.githubRepo}/pull/${esc(p.replace("#", ""))}" target="_blank" rel="noopener">#${esc(p.replace("#", ""))}</a>`) : []),
    ...(lane.issue && !CONFIG.linearWorkspace ? lane.issue.split(/[ ,]+/).filter(Boolean).map((i) => `<span class="tag">${esc(i)}</span>`) : []),
    ...(lane.pr && !CONFIG.githubRepo ? String(lane.pr).split(/[ ,]+/).filter(Boolean).map((p) => `<span class="tag">#${esc(p.replace("#", ""))}</span>`) : []),
  ].join("");
  // Where it sits, once the room shows ranks: its level and the chain up to HQ (each step selects that lane).
  const tree = ranked(S.lanes, themeOf(settings.theme)) ? `<div class="path"><span class="tag level">${esc(String(lane.level || "").toUpperCase())}</span><span class="chain">HQ${(lane.path || []).map((p) => ` &gt; <button class="up" data-select="${esc(p)}">${esc(p)}</button>`).join("")} &gt; <b>${esc(lane.name)}</b></span></div>` : "";
  // What you scrolled to stays put across the refreshes: the drawer, and the terminal unless it is at its end.
  const prev = card.querySelector(".agterm"), keepTerm = prev && !stick ? prev.scrollTop : null, keepCard = card.scrollTop;
  const rooms = (S.rooms ?? []).filter((r) => !r.archivedAt && (r.owner === lane.name || r.members.includes(lane.name)));
  setHTML(card, `<button class="cardx" type="button" data-card-close aria-label="Close">✕</button><h3>${esc(lane.name)}</h3>
    <div class="sub">${mdInline(lane.title)}</div>${tree}
    <div class="row"><span class="status" style="background:${color}">${esc(label.toUpperCase())}</span>${since(lane, asks) ? `<span class="tag">FOR <span data-since="${since(lane, asks)}">${dur(Date.now() - since(lane, asks))}</span></span>` : ""}${lane.machine ? `<span class="tag">${esc(lane.machine)} ${esc(lane.pane || "")}</span>` : ""}</div>
    ${asks.map((a) => `<section class="agq"><h4>ITS OPEN QUESTION</h4><b>${mdInline(a.title)}</b>${a.options?.length ? `<div class="agopts">${a.options.map((o) => `<span>${mdInline(o, { links: false })}${o === a.recommended ? ` <i>HQ PICK</i>` : ""}</span>`).join("")}</div>` : ""}<button class="agjump" type="button" data-answer-jump="${esc(lane.name)}">ANSWER IN NEEDS YOU ›</button></section>`).join("")}
    ${lane.status === "blocked" ? `<div class="prompt"><span class="k">BLOCKED ON A PROMPT · ANSWER IT IN HERDR ON ${esc(String(lane.machine || "?").toUpperCase())}, PANE ${esc(lane.pane || "?")}</span><div class="md">${md(fence(lane.prompt))}</div></div>` : ""}
    ${lane.note ? `<div class="note md">${md(lane.note)}</div>` : ""}
    <section class="agsec"><h4><i class="agdot${live?.terminal?.text != null ? " on" : ""}"></i>NOW · ITS TERMINAL<em>${live?.terminal?.at ? `read ${clock(live.terminal.at)}, every 3 s` : "reading…"}</em></h4>${terminalHTML()}</section>
    <section class="agsec"><h4>WHAT IT LAST SAID</h4>${saidHTML()}</section>
    ${links || rooms.length ? `<section class="agsec"><h4>ITS WORK</h4><div class="row">${links}${rooms.map((r) => `<a class="tag agroom" href="#room/${esc(r.slug)}" data-card-leave>ROOM ${mdInline(r.title, { links: false })} ›</a>`).join("")}</div></section>` : ""}
    <p class="agfoot">Read-only. To talk to ${esc(lane.name)}, ${rooms.length ? "write in its room" : "open a room with it (ROOMS › + NEW ROOM)"}.</p>`);
  const term = card.querySelector(".agterm");
  if (term) term.scrollTop = stick || keepTerm == null ? term.scrollHeight : keepTerm;
  card.scrollTop = keepCard;
}

// The terminal as text, verbatim; it scrolls on its own and stays at its end unless you scroll up.
let stick = true;
function terminalHTML() {
  if (!live) return `<pre class="agterm wait">…</pre>`;
  const t = live.terminal;
  if (t.text == null) return `<p class="agnone">${esc(t.error || "No output yet.")}</p>`;
  return `<pre class="agterm">${esc(t.text) || " "}</pre>`;
}
const KIND = { update: "Update", room: "Room", question: "Question", event: "Event" };
function saidHTML() {
  if (!live) return `<p class="agnone">…</p>`;
  if (!live.said.length) return `<p class="agnone">Nothing yet.</p>`;
  return `<div class="agsaid">${live.said.map((x) => `<div><span class="t">${clock(x.at)}</span><span><b>${x.kind === "room" ? `Room ${esc(x.room)}` : KIND[x.kind]}</b>${x.title ? ` · ${mdInline(x.title, { links: false })}` : ""}${x.text ? ` · ${mdInline(x.text, { links: false })}` : ""}</span></div>`).join("")}</div>`;
}

function startPolling(name) {
  stopPolling();
  polling = name;
  stick = true;
  poll();
}
function stopPolling() {
  polling = null;
  clearTimeout(timer);
  timer = null;
}
async function poll() {
  clearTimeout(timer);
  const name = polling;
  if (!name || document.hidden) return;
  try {
    const r = await fetch(`/api/lanes/${encodeURIComponent(name)}/live`, { cache: "no-store" });
    const d = await r.json();
    if (polling !== name) return;
    live = r.ok ? d : { name, terminal: { text: null, at: Date.now(), error: d.error || "could not read it" }, said: [] };
    renderCard();
  } catch {}
  if (polling === name) timer = setTimeout(poll, EVERY);
}
// A hidden page reads nothing; back in view, it reads at once.
document.addEventListener("visibilitychange", () => { if (!document.hidden && polling) poll(); });
$("card").addEventListener("scroll", (e) => {
  const t = e.target;
  if (t.classList?.contains("agterm")) stick = t.scrollHeight - t.scrollTop - t.clientHeight < 8;
}, true);
// ANSWER IN NEEDS YOU: the questions tab, at that lane's question.
$("card").addEventListener("click", (e) => {
  // Going to its room: the room takes the stage, the drawer closes.
  if (e.target.closest("[data-card-leave]")) { select(null); return; }
  const b = e.target.closest("[data-answer-jump]");
  if (!b) return;
  document.querySelector('[data-qtab="questions"]')?.click();
  const name = b.dataset.answerJump;
  // A phone's sheet would cover the question: the page goes to the question, and the sheet closes.
  select(name, true);
  if (!matchMedia("(min-width: 1151px)").matches) select(null);
});
$("card").addEventListener("click", (e) => { if (e.target.closest("[data-card-close]")) select(null); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || $("card").hidden) return;
  e.preventDefault(); // the floors' Esc steps out a level only when nothing over the stage is open
  select(null);
});
