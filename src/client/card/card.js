// The worker card: the selected lane's status, links and open asks. It opens over the stage's top right when a worker
// (or a lane on the lanes board) is selected, and closes with ✕, Esc, or when its lane goes.
import { $, overOffice } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { select, selected } from "../room/input.js";
import { STATUS_TEXT } from "../core/status.js";
import { dur, esc, setHTML } from "../core/format.js";
import { fence, md, mdInline } from "../core/markdown.js";
import { ranked, themeOf } from "../room/looks.js";
import { settings } from "../settings/prefs.js";

// How long it has been in its status: waiting on you since its oldest open question (as the lanes board says), else
// since herdr last changed its status.
const since = (lane, asks) => (lane.status === "needs_you" && asks.length ? Math.min(...asks.map((a) => a.created_at)) : lane.herdr_since);
export function renderCard() {
  const card = $("card");
  const lane = S?.lanes.find((l) => l.name === selected);
  card.hidden = !lane;
  if (!lane) return;
  overOffice(card);
  const [label, color] = STATUS_TEXT[lane.status] || [lane.status, "#6a6a82"];
  const asks = S.open.filter((a) => a.lane === lane.name);
  const links = [
    ...(lane.issue && CONFIG.linearWorkspace ? lane.issue.split(/[ ,]+/).filter(Boolean).map((i) => `<a class="tag" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(i)}" target="_blank" rel="noopener">${esc(i)}</a>`) : []),
    ...(lane.pr && CONFIG.githubRepo ? String(lane.pr).split(/[ ,]+/).filter(Boolean).map((p) => `<a class="tag" href="https://github.com/${CONFIG.githubRepo}/pull/${esc(p.replace("#", ""))}" target="_blank" rel="noopener">#${esc(p.replace("#", ""))}</a>`) : []),
    ...(lane.issue && !CONFIG.linearWorkspace ? lane.issue.split(/[ ,]+/).filter(Boolean).map((i) => `<span class="tag">${esc(i)}</span>`) : []),
    ...(lane.pr && !CONFIG.githubRepo ? String(lane.pr).split(/[ ,]+/).filter(Boolean).map((p) => `<span class="tag">#${esc(p.replace("#", ""))}</span>`) : []),
    lane.machine ? `<span class="tag">${esc(lane.machine)} ${esc(lane.pane || "")}</span>` : "",
  ].join("");
  // Where it sits, once the room shows ranks: its level and the chain up to HQ (each step selects that lane).
  const tree = ranked(S.lanes, themeOf(settings.theme)) ? `<div class="path"><span class="tag level">${esc(String(lane.level || "").toUpperCase())}</span><span class="chain">HQ${(lane.path || []).map((p) => ` &gt; <button class="up" data-select="${esc(p)}">${esc(p)}</button>`).join("")} &gt; <b>${esc(lane.name)}</b></span></div>` : "";
  setHTML(card, `<button class="cardx" type="button" data-card-close aria-label="Close the card">✕</button><h3>${esc(lane.name)}</h3>
    <div class="sub">${mdInline(lane.title)}</div>${tree}
    <div class="row"><span class="status" style="background:${color}">${esc(label.toUpperCase())}</span>${since(lane, asks) ? `<span class="tag">FOR <span data-since="${since(lane, asks)}">${dur(Date.now() - since(lane, asks))}</span></span>` : ""}${links}</div>
    ${lane.status === "blocked" ? `<div class="prompt"><span class="k">BLOCKED ON A PROMPT · ANSWER IT IN HERDR ON ${esc(String(lane.machine || "?").toUpperCase())}, PANE ${esc(lane.pane || "?")}</span><div class="md">${md(fence(lane.prompt))}</div></div>` : ""}
    ${lane.note ? `<div class="note md">${md(lane.note)}</div>` : ""}
    ${asks.length ? `<div class="row">${asks.map((a) => `<button class="tag lane" data-select="${esc(lane.name)}">ANSWER: ${mdInline(a.title.length > 40 ? a.title.slice(0, 40) + "…" : a.title, { links: false })}</button>`).join("")}</div>` : ""}`);
}

$("card").addEventListener("click", (e) => { if (e.target.closest("[data-card-close]")) select(null); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || $("card").hidden) return;
  e.preventDefault(); // the floors' Esc steps out a level only when nothing over the stage is open
  select(null);
});
