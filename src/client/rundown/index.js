// RUNDOWN: a brief the owner can go to. A button in the stage bar opens a panel over the room that lists, for each floor in
// scope, who needs help there and each open project with its state, owner, last line, time and brief (core/floors.js rundown).
// The briefs are fetched when the panel opens, for the projects that have one. It takes turns with the other panels over the
// room ("panel"), and Escape, its button or BACK TO THE ROOM close it. It never covers the questions.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { closePanel, showPanel } from "../core/panel.js";
import { view } from "../core/scope.js";
import { HELP_COLORS, floorTagShown, rundown } from "../core/floors.js";
import { mdInline } from "../core/markdown.js";
import { dur, esc, setHTML, setText } from "../core/format.js";
import { ensureBar } from "../floors/building.js";
import { briefLoader } from "./briefs.js";

const room = document.querySelector(".room");
const panel = document.createElement("section");
panel.id = "rundownPanel";
panel.className = "rundownp";
panel.setAttribute("aria-label", "Rundown");
room.append(panel);

const button = document.createElement("button");
button.type = "button";
button.className = "btn place";
button.id = "rundownBtn";
button.textContent = "RUNDOWN";
button.setAttribute("aria-pressed", "false");
ensureBar().querySelector(".stageslot").append(button);

let open = false;
const briefs = briefLoader(async (slug) => {
  const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).brief ?? "";
}, () => render());

const dots = (help) => help.map((h) => `<i class="dot" style="background:${HELP_COLORS[h.state]}" title="${esc(h.lane)}"></i>`).join("");
const lastLine = (l) => `<p class="rlast"><b>${l.who === "owner" ? `YOU → ${esc(l.to)}` : esc(l.who)}</b> ${mdInline(l.text, { links: false })}</p>`;
const project = (p) => `<div class="rproj"><div class="rhead"><b>${mdInline(p.title, { links: false })}</b><span class="tag st" style="background:${p.color}">${esc(p.name)}</span>${p.calls ? `<span class="tag count">${p.calls} OPEN CALL${p.calls > 1 ? "S" : ""}</span>` : ""}<span class="tag lane">${esc(p.owner)}</span><span class="timer" data-since="${p.at}"></span></div>${p.last ? lastLine(p.last) : ""}${p.brief ? `<p class="rbrief">${mdInline(p.brief, { links: false })}</p>` : ""}<div class="racts"><button class="btn" type="button" data-project="${esc(p.slug)}">PROJECT</button><a class="btn go" href="#room/${esc(p.slug)}">ROOM</a></div></div>`;

function render() {
  room.classList.toggle("rundown-open", open);
  button.classList.toggle("on", open);
  button.setAttribute("aria-pressed", String(open));
  if (!open || !S) return void setHTML(panel, "");
  // The briefs of the projects in view, each asked for once per time it was set.
  const shown = rundown(S, view()).flatMap((f) => f.projects.map((p) => p.slug));
  const text = Object.fromEntries(shown.map((slug) => [slug, briefs.of(slug, S.rooms.find((r) => r.slug === slug)?.briefAt)]));
  const floors = rundown(S, view(), text), tagged = floorTagShown(S);
  // The timers are filled in after, so a state push that changes nothing else does not rebuild the panel (and its focus).
  setHTML(panel, `<div class="rdhdr"><h2>RUNDOWN</h2><button class="btn" type="button" data-rundown-close>BACK TO THE ROOM</button></div>${floors.map((f) => `<div class="box rdfloor"><h3>${tagged ? `<span class="tag floortag" style="background:${f.color}">${esc(f.label)}</span>` : ""}${dots(f.help)}</h3>${f.projects.length ? f.projects.map(project).join("") : `<p class="rnone">NO PROJECTS</p>`}</div>`).join("")}`);
  for (const el of panel.querySelectorAll("[data-since]")) setText(el, dur(Date.now() - Number(el.dataset.since)));
}

on("panel", (id) => {
  if (id === "rundown" && !open) briefs.reset(); // opening asks again
  open = id === "rundown";
  render();
});
on("state", render);
on("scope", render);
// A conference room opening covers the floor, and the panel with it.
on("stage", (shown) => { if (shown !== "office") closePanel("rundown"); });

button.addEventListener("click", () => (open ? closePanel("rundown") : showPanel("rundown")));
panel.addEventListener("click", (e) => {
  if (e.target.closest("[data-rundown-close]")) closePanel("rundown");
});
