// The lane in focus: a bar over the question column with the lane's name, role, status, links and projects. While a
// lane is in focus the column shows only its questions, messages and work; CLEAR (or Esc, or the empty floor) shows
// everyone's again.
import { $, pageScrolls } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { select, selected } from "../room/input.js";
import { STATUS_TEXT } from "../core/status.js";
import { dur, esc, setHTML } from "../core/format.js";
import { linkify } from "../core/text.js";
import { renderHud } from "../questions/questions.js";
import { qTab, renderMsgs, renderQTabs, setQTab } from "../messages/messages.js";
import { renderWork } from "../work-board/work-board.js";

const ROLE_NAME = { orchestrator: "ORCHESTRATOR", pm: "PM", builder: "BUILDER", walker: "WALKER" };

function linksOf(lane) {
  const split = (v) => String(v).split(/[ ,]+/).filter(Boolean);
  return [
    ...(lane.issue ? split(lane.issue).map((i) => (CONFIG.linearWorkspace ? `<a class="tag" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(i)}" target="_blank" rel="noopener">${esc(i)}</a>` : `<span class="tag">${esc(i)}</span>`)) : []),
    ...(lane.pr ? split(lane.pr).map((p) => p.replace("#", "")).map((p) => (CONFIG.githubRepo ? `<a class="tag" href="https://github.com/${CONFIG.githubRepo}/pull/${esc(p)}" target="_blank" rel="noopener">#${esc(p)}</a>` : `<span class="tag">#${esc(p)}</span>`)) : []),
    lane.machine ? `<span class="tag">${esc(lane.machine)} ${esc(lane.pane || "")}</span>` : "",
  ].join("");
}

export function renderCard() {
  const card = $("card");
  const lane = S?.lanes.find((l) => l.name === selected);
  if (!lane) { card.hidden = true; setHTML(card, ""); return; }
  const [label, color] = STATUS_TEXT[lane.status] || [lane.status, "#6a6a82"];
  const projects = lane.projects ?? [];
  card.hidden = false;
  card.dataset.role = lane.role || "";
  setHTML(card, `<div class="lhead">
      <h3>${esc(lane.name)}</h3>${ROLE_NAME[lane.role] ? `<span class="tag role">${ROLE_NAME[lane.role]}</span>` : ""}
      <span class="spacer"></span><button class="btn-s" type="button" data-lane-close aria-label="Show everyone">CLEAR</button>
    </div>
    ${lane.title ? `<div class="sub">${esc(lane.title)}</div>` : ""}
    <div class="row"><span class="status" style="background:${color}">${esc(label.toUpperCase())}</span>${lane.herdr_since ? `<span class="tag">FOR <span data-since="${lane.herdr_since}">${dur(Date.now() - lane.herdr_since)}</span></span>` : ""}${linksOf(lane)}</div>
    ${projects.length ? `<div class="row projects">${projects.map((p) => `<a class="tag proj" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`).join("")}</div>` : ""}
    ${lane.note ? `<div class="note">${linkify(lane.note)}</div>` : ""}`);
}

// The focus moved (room/input.js select). The column opens on the lane's questions when it has any, else its
// messages (WORK stays WORK), and every list is built again for the lane, or for everyone.
export function focusChanged(fromRoom) {
  if (selected && S && qTab !== "work") setQTab(S.open.some((a) => a.lane === selected) ? "questions" : "messages");
  renderCard();
  if (!S) return;
  renderQTabs();
  renderHud();
  renderMsgs();
  renderWork();
  // On a phone the column is above the room: go up to it.
  if (fromRoom && selected && pageScrolls()) $("card").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("card").addEventListener("click", (e) => { if (e.target.closest("[data-lane-close]")) select(null); });
