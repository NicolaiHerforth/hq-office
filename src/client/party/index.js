// PARTY: every lane in scope by floor, each with its status. The WORKING cell in the top bar opens it over the room; it stays
// closed until the owner opens it. A row chooses its agent (core/clicks.js) and gets out of the way. It takes turns with the
// other panels over the room ("panel"), and Escape, the cell again or BACK TO THE ROOM close it. The cell keeps its place in
// the strip; this file only listens on it. The panel never covers the questions.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { closePanel, showPanel } from "../core/panel.js";
import { view } from "../core/scope.js";
import { floorTagShown, party } from "../core/floors.js";
import { STATUS_TEXT } from "../core/status.js";
import { esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";

const room = document.querySelector(".room");
const panel = document.createElement("section");
panel.id = "partyPanel";
panel.className = "partyp";
panel.setAttribute("aria-label", "Party");
room.append(panel);

const cell = document.getElementById("sMove").parentElement;
cell.classList.add("partycell");
cell.tabIndex = 0;
cell.setAttribute("role", "button");
cell.setAttribute("aria-expanded", "false");

let open = false;

const row = (l) => {
  const [label, color] = STATUS_TEXT[l.status] ?? [l.status ?? "Not registered", "#6a6a82"];
  return `<button class="lrow" type="button" data-select="${esc(l.name)}"><i class="dot" style="background:${color}"></i><b>${esc(l.name)}</b>${l.head ? `<span class="tag in">GENERAL</span>` : ""}<span class="d">${mdInline(l.title, { links: false })}</span><span class="tag">${esc(label.toUpperCase())}</span></button>`;
};

function render() {
  room.classList.toggle("party-open", open);
  cell.classList.toggle("on", open);
  cell.setAttribute("aria-expanded", String(open));
  if (!open || !S) return void setHTML(panel, "");
  const p = party(S, view()), tagged = floorTagShown(S);
  setHTML(panel, `<div class="pyhdr"><h2>PARTY</h2><span class="tag count">${p.working}/${p.live} WORKING</span><button class="btn" type="button" data-party-close>BACK TO THE ROOM</button></div>${p.groups.map((g) => `<div class="box pygrp">${tagged ? `<h3><span class="tag floortag" style="background:${g.color}">${esc(g.label)}</span></h3>` : ""}${g.lanes.map(row).join("")}</div>`).join("")}`);
}

on("panel", (id) => { open = id === "party"; render(); });
on("state", render);
on("scope", render);
// A conference room opening covers the floor, and the panel with it.
on("stage", (shown) => { if (shown !== "office") closePanel("party"); });

const toggle = () => (open ? closePanel("party") : showPanel("party"));
cell.addEventListener("click", toggle);
cell.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  toggle();
});
panel.addEventListener("click", (e) => {
  if (e.target.closest("[data-party-close], [data-select]")) closePanel("party");
});
