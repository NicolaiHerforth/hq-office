// Moved here from the page's single script.
import { $ } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { esc } from "../core/format.js";
import { qTab } from "../messages/messages.js";
import { selected } from "../room/input.js";

// Read-only. Every item's state comes from the server (GitHub, the lane, open asks); this only draws it.
// It is rebuilt when the state changes, never on a timer. STALLED work also shows as a red strip on the
// other two tabs, so it is seen without leaving the questions.
const WORK_STATE = { stalled: "STALLED", owner: "WAITING ON YOU", ci: "WAITING ON CI", moving: "MOVING", paused: "PAUSED", done: "DONE" };
const WORK_ORDER = ["stalled", "owner", "ci", "moving", "paused", "done"];
// Minutes, not seconds: these are redrawn when the state changes (at least once a minute), not every second.
function workAge(ms) { const m = Math.floor(ms / 60000), h = Math.floor(m / 60); return m < 1 ? "NOW" : h < 1 ? `${m}M AGO` : h < 48 ? `${h}H ${m % 60}M AGO` : `${Math.floor(h / 24)}D AGO`; }
function workIssue(i) {
  return CONFIG.linearWorkspace
    ? `<a class="key" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(i.issue)}" target="_blank" rel="noopener">${esc(i.issue)}</a>`
    : `<b class="key">${esc(i.issue)}</b>`;
}
function workPr(p) {
  const repo = p.repo || CONFIG.githubRepo;
  const mark = p.error ? " ?" : p.state === "MERGED" ? " MERGED" : p.state === "CLOSED" ? " CLOSED" : p.draft ? " DRAFT" : p.ci === "running" ? " CI…" : p.ci === "failed" ? " CI ✗" : "";
  const cls = `tag pr${p.state === "MERGED" ? " merged" : p.draft ? " draft" : ""}`;
  const label = `#${esc(p.number)}${mark}`;
  const tip = p.error ? ` title="${esc(p.error)}"` : "";
  return repo ? `<a class="${cls}" href="https://github.com/${esc(repo)}/pull/${esc(p.number)}" target="_blank" rel="noopener"${tip}>${label}</a>` : `<span class="${cls}"${tip}>${label}</span>`;
}
function workRow(i) {
  const now = Date.now();
  const what = i.state === "paused" || i.state === "owner" ? i.why : i.last ? `last: ${i.last.what}` : "nothing has happened yet";
  const age = i.state === "paused" && i.pausedAt ? now - i.pausedAt : i.last ? now - i.last.at : now - i.createdAt;
  return `<article class="wi ${i.state}">
      <div class="meta"><span class="tag ws ${i.state}">${WORK_STATE[i.state]}</span>${workIssue(i)}${i.lane ? `<button class="tag lane" data-select="${esc(i.lane)}">${esc(i.lane)}</button>` : ""}${i.prs.map(workPr).join("")}<span class="age">${workAge(age)}</span></div>
      <div class="what">${esc(what)}</div>
    </article>`;
}
export function renderWork() {
  if (!S?.board) return;
  const b = S.board, stalled = b.items.filter((i) => i.state === "stalled");
  const t = $("qtStalled");
  t.hidden = !stalled.length;
  t.textContent = stalled.length;
  // The strip: on QUESTIONS and MESSAGES, at most two rows, so the questions keep the column.
  const strip = $("stall");
  strip.hidden = !stalled.length || qTab === "work";
  if (!strip.hidden) {
    const rows = stalled.slice(0, 2).map((i) => `<div class="row"><b>${esc(i.issue)}</b>${esc(i.lane || "no lane")} · ${esc(i.last ? i.last.what : "nothing yet")} · ${workAge(Date.now() - (i.last?.at ?? i.createdAt))}</div>`).join("");
    strip.innerHTML = `<span class="k">${stalled.length} STALLED ${stalled.length === 1 ? "ITEM" : "ITEMS"}${stalled.length > 2 ? ` (+${stalled.length - 2} MORE)` : ""} · OPEN WORK</span>${rows}`;
  }
  if (qTab !== "work") return;
  // With a lane in focus, only its work.
  const items = selected ? b.items.filter((i) => i.lane === selected) : b.items;
  const open = items.filter((i) => i.state !== "done").length;
  const counts = selected ? Object.fromEntries(WORK_ORDER.map((s) => [s, items.filter((i) => i.state === s).length])) : b.counts;
  const sum = WORK_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${WORK_STATE[s]}`).join(" · ");
  const groups = WORK_ORDER.map((s) => {
    const its = items.filter((i) => i.state === s);
    return its.length ? `<h4 class="${s}">${WORK_STATE[s]} (${its.length})</h4>${its.map(workRow).join("")}` : "";
  }).join("");
  $("work").innerHTML = items.length
    ? `<div class="sum">${open} OPEN · ${sum}</div>${groups}`
    : selected ? `<div class="empty">NO TRACKED WORK</div>` : `<div class="empty">No tracked work. HQ adds it with hud track.</div>`;
}
