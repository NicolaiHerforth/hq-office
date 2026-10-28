// The worker card: the chosen agent's status, links and open asks (core/scope.js), whichever floor it is on.
import { $ } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { on } from "../core/bus.js";
import { scope } from "../core/scope.js";
import { STATUS_TEXT } from "../core/status.js";
import { dur, esc, setHTML } from "../core/format.js";
import { fence, md, mdInline } from "../core/markdown.js";
import { ranked, themeOf } from "../room/looks.js";
import { settings } from "../settings/prefs.js";
import { issueLink, prLink } from "../core/floors.js";

const words = (v) => String(v ?? "").split(/[ ,]+/).filter(Boolean);
const linkTag = (href, text) => (href ? `<a class="tag" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : `<span class="tag">${esc(text)}</span>`);

export function renderCard() {
  const card = $("card");
  const lane = S?.lanes.find((l) => l.name === scope().agent);
  if (!lane) {
    setHTML(card, `<h3>CLICK A WORKER</h3><div class="sub">Each worker is one lane. Click one to see what it does, where it is, and what it waits on.</div>`);
    return;
  }
  const [label, color] = STATUS_TEXT[lane.status] || [lane.status, "#6a6a82"];
  const asks = S.open.filter((a) => a.lane === lane.name);
  const links = [
    ...words(lane.issue).map((i) => linkTag(issueLink(CONFIG, i).href, i)),
    ...words(lane.pr).map((p) => { const l = prLink(CONFIG, p); return linkTag(l.href, `#${l.num}`); }),
    lane.machine ? `<span class="tag">${esc(lane.machine)} ${esc(lane.pane || "")}</span>` : "",
  ].join("");
  // Where it sits, once the room shows ranks: its level and the chain up to HQ (each step selects that lane).
  const tree = ranked(S.lanes, themeOf(settings.theme)) ? `<div class="path"><span class="tag level">${esc(String(lane.level || "").toUpperCase())}</span><span class="chain">HQ${(lane.path || []).map((p) => ` &gt; <button class="up" data-select="${esc(p)}">${esc(p)}</button>`).join("")} &gt; <b>${esc(lane.name)}</b></span></div>` : "";
  setHTML(card, `<h3>${esc(lane.name)}</h3>
    <div class="sub">${mdInline(lane.title)}</div>${tree}
    <div class="row"><span class="status" style="background:${color}">${esc(label.toUpperCase())}</span>${lane.herdr_since ? `<span class="tag">FOR <span data-since="${lane.herdr_since}">${dur(Date.now() - lane.herdr_since)}</span></span>` : ""}${links}</div>
    ${lane.status === "blocked" ? `<div class="prompt"><span class="k">BLOCKED ON A PROMPT · ANSWER IT IN HERDR ON ${esc(String(lane.machine || "?").toUpperCase())}, PANE ${esc(lane.pane || "?")}</span><div class="md">${md(fence(lane.prompt))}</div></div>` : ""}
    ${lane.note ? `<div class="note md">${md(lane.note)}</div>` : ""}
    ${asks.length ? `<div class="row">${asks.map((a) => `<button class="tag lane" data-select="${esc(lane.name)}">ANSWER: ${mdInline(a.title.length > 40 ? a.title.slice(0, 40) + "…" : a.title, { links: false })}</button>`).join("")}</div>` : ""}`);
}

on("scope", () => S && renderCard());
