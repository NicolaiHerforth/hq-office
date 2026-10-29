// + NEW ROOM (on the ROOMS tab): the owner opens a room without asking a lane to. A panel over the office: a title,
// the lane that owns the room (or HQ), other lanes, an issue or a PR, and an optional first message, which goes to
// the owning lane like any message in the room. The server picks the room's address from the title and tells HQ
// (POST /api/rooms with by: "owner"); the new room opens. Inside a floor the lanes offered are that floor's.
import { $, overOffice, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { mdInline } from "../core/markdown.js";
import { pick } from "../core/scope.js";
import { on } from "../core/bus.js";

const stage = document.querySelector(".stage");
let box = null, form = null;

// Lanes that can be in a room: in this floor (or every floor in the building), not done; by name.
const lanes = () => pick(S?.lanes ?? []).filter((l) => l.status !== "done").sort((a, b) => a.name.localeCompare(b.name));

function html() {
  const all = lanes();
  const owners = [`<option value="" ${form.owner ? "" : "selected"} disabled>Pick the lane that owns it</option>`, ...all.map((l) => `<option value="${esc(l.name)}"${form.owner === l.name ? " selected" : ""}>${esc(l.name)}</option>`), `<option value="hq"${form.owner === "hq" ? " selected" : ""}>HQ itself</option>`];
  const others = all.filter((l) => l.name !== form.owner);
  return `<form class="nrform" data-nr novalidate>
    <div class="nrhead"><b class="k">NEW ROOM</b><button class="spx" type="button" data-nr-close aria-label="Close">✕</button></div>
    <label class="nrrow"><span class="sk">TITLE</span><input class="levels" id="nrTitle" name="title" maxlength="80" autocomplete="off" spellcheck="false" placeholder="Pricing page copy" value="${esc(form.title)}"></label>
    <label class="nrrow"><span class="sk">OWNER</span><select class="levels" id="nrOwner" name="owner">${owners.join("")}</select></label>
    <div class="nrrow"><span class="sk">LANES</span>${others.length ? `<div class="nrlanes" role="group" aria-label="Other lanes in the room">${others.map((l) => `<label class="nrlane"><input type="checkbox" name="member" value="${esc(l.name)}"${form.members.has(l.name) ? " checked" : ""}><span>${esc(l.name)}</span></label>`).join("")}</div>` : `<span class="nrnone">No other lanes${form.owner ? "" : " yet: pick the owner first"}.</span>`}</div>
    <div class="nrrow nrtwo"><label><span class="sk">ISSUE</span><input class="levels" id="nrIssue" name="issue" autocomplete="off" spellcheck="false" placeholder="OPE-12 (optional)" value="${esc(form.issue)}"></label><label><span class="sk">PR</span><input class="levels" id="nrPr" name="pr" autocomplete="off" spellcheck="false" placeholder="#34 (optional)" value="${esc(form.pr)}"></label></div>
    <label class="nrrow"><span class="sk">FIRST MESSAGE</span><textarea class="levels" id="nrText" name="text" rows="3" placeholder="What the room is for. Optional; it goes to the owning lane.">${esc(form.text)}</textarea></label>
    ${form.error ? `<div class="nrerr" role="alert">${mdInline(form.error)}</div>` : ""}
    <div class="opts2 nracts"><button class="btn-s on" type="submit"${form.busy ? " disabled" : ""}>${form.busy ? "OPENING…" : "OPEN ROOM"}</button><button class="btn-s" type="button" data-nr-close>CANCEL</button></div>
  </form>`;
}
function keep() {
  const f = box?.querySelector("[data-nr]");
  if (!f) return;
  form.title = f.elements.title.value;
  form.owner = f.elements.owner.value;
  form.issue = f.elements.issue.value;
  form.pr = f.elements.pr.value;
  form.text = f.elements.text.value;
  form.members = new Set([...f.querySelectorAll("[name=member]:checked")].map((c) => c.value));
  form.members.delete(form.owner);
}
function draw() {
  const focused = document.activeElement?.id;
  setHTML(box, html());
  if (focused && box.querySelector(`#${focused}`)) box.querySelector(`#${focused}`).focus();
}
export const newRoomOpen = () => !!box && !box.hidden;
export function openNewRoom() {
  if (!box) {
    box = document.createElement("section");
    box.className = "box nrpanel";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "New room");
    stage.append(box);
    wire();
  }
  form = { title: "", owner: "", members: new Set(), issue: "", pr: "", text: "", busy: false, error: "" };
  box.hidden = false;
  draw();
  overOffice(box);
  box.querySelector("#nrTitle").focus();
}
export function closeNewRoom() {
  if (!box) return;
  if (box.contains(document.activeElement)) document.activeElement.blur();
  box.hidden = true;
}
// The new room opens once the page's state has it (the room view goes by the rooms it knows).
let going = null;
const has = (slug) => (S?.rooms ?? []).some((r) => r.slug === slug);
function goWhenThere(slug) {
  going = slug;
  if (has(slug)) arrive();
  setTimeout(() => { if (going === slug) going = null; }, 10_000);
}
function arrive() { const slug = going; going = null; location.hash = `#room/${slug}`; }
on("state", () => { if (going && has(going)) arrive(); });
const split = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
async function save() {
  keep();
  form.error = "";
  if (!form.title.trim()) form.error = "Give the room a title.";
  else if (!form.owner) form.error = "Pick the lane that owns the room.";
  if (form.error) { draw(); return; }
  form.busy = true;
  draw();
  try {
    const r = await post("/api/rooms", { by: "owner", title: form.title.trim(), owner: form.owner, members: [...form.members], issues: split(form.issue), prs: split(form.pr), text: form.text.trim() });
    closeNewRoom();
    toast(`ROOM OPENED${form.text.trim() ? `; YOUR MESSAGE GOES TO ${form.owner.toUpperCase()}` : ""}.`);
    goWhenThere(r.slug);
  } catch (err) {
    form.busy = false;
    form.error = err.message;
    draw();
  }
}
function wire() {
  box.addEventListener("submit", (e) => { e.preventDefault(); if (!form.busy) save(); });
  // The owner changed: the other lanes are redrawn without it.
  box.addEventListener("change", (e) => { if (e.target.name === "owner") { keep(); draw(); } });
  box.addEventListener("input", keep);
  box.addEventListener("click", (e) => { if (e.target.closest("[data-nr-close]")) closeNewRoom(); });
}
document.addEventListener("click", (e) => { if (e.target.closest?.("[data-room-new]")) openNewRoom(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !newRoomOpen()) return;
  e.preventDefault();
  closeNewRoom();
});
