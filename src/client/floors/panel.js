// The floor panel, over the stage: + FLOOR (and + ADD A FLOOR, and SETTINGS) adds a floor, EDIT changes one. A name,
// a colour from the palette, and its HQ: USE AN AGENT (one of herdr's live named agents that runs no floor, lanes too:
// a lane promoted to run a domain) or START A NEW HQ (the server opens a herdr tab beside the first floor's HQ and
// starts hq-<id> in it). EDIT renames, recolours, gives the floor another HQ, or removes it when it is empty, after a
// confirm in the page. A failure shows in the panel, and nothing is added. Uses the floor routes (docs/floors.md).
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { floorById, floorLabel, floorsOf } from "../core/floors.js";
import { toBuilding } from "../core/scope.js";

export const FLOOR_COLORS = ["#3c6fd6", "#2f9e57", "#e0901e", "#b0469a", "#d63c3c", "#1abc9c", "#7a4fc9", "#6a6a82"];
const TYPE = "__type";
const stage = document.querySelector(".stage");
let box = null;
// The open form: { mode: "add" | "edit", id, name, color, how: "agent" | "start", hq, typed, busy, error, confirm }.
let form = null;
let agents = null; // GET /api/floors/agents, read when the panel opens

export const panelOpen = () => !!form;
const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
// herdr's live agents that run no other floor, by name; the one this floor has stays offered.
const free = () => [...new Set((agents ?? []).filter((a) => !a.floor || a.floor === form?.id).map((a) => a.name))].sort();
const isLane = (name) => (agents ?? []).some((a) => a.name === name && a.lane);
const removable = (f) => floorsOf(S).length > 1 && !f.counts?.lanes && !f.counts?.needsYou;

export function openPanel(o) {
  const f = o.mode === "edit" ? floorById(S, o.id) : null;
  if (o.mode === "edit" && !f) return;
  $("settings").hidden = true;
  const used = new Set(floorsOf(S).map((x) => x.color));
  form = f
    ? { mode: "edit", id: f.id, name: f.name, color: f.color, how: "agent", hq: f.hq, typed: false, busy: false, error: "", confirm: false }
    : { mode: "add", id: null, name: "", color: FLOOR_COLORS.find((c) => !used.has(c)) ?? FLOOR_COLORS[0], how: "agent", hq: "", typed: false, busy: false, error: "", confirm: false };
  agents = null;
  fetch("/api/floors/agents").then((r) => r.json()).then((d) => {
    agents = d.agents ?? [];
    if (!form) return;
    keep();
    if (form.mode === "add" && !form.hq) {
      // An agent that is not a lane is the likeliest HQ; with none, the HUD starts one.
      form.hq = free().find((n) => !isLane(n)) ?? "";
      if (!form.hq) form.how = "start";
    }
    draw();
  }).catch(() => { agents = []; draw(); });
  draw();
  box.querySelector("[name=name]")?.focus();
}
export function closePanel() {
  form = null;
  if (!box) return;
  if (box.contains(document.activeElement)) document.activeElement.blur();
  box.hidden = true;
}

function hqHTML() {
  if (form.how === "start") {
    const lead = floorsOf(S)[0];
    const id = slug(form.name) || "<id>";
    return `<p class="fpnote">The HUD opens a herdr tab beside <b>${esc(lead?.hq ?? "HQ")}</b>, in its folder, starts a Claude agent named <b class="fpid">hq-${esc(id)}</b> in it, and sends it the HQ guide for this floor.</p>`;
  }
  if (agents === null) return `<p class="fpnote">Reading herdr's agents…</p>`;
  const names = free();
  const typed = form.typed || !names.length || (!!form.hq && !names.includes(form.hq));
  if (typed) {
    return `<input class="levels" name="hqText" maxlength="64" spellcheck="false" autocomplete="off" placeholder="its name in herdr" value="${esc(form.hq)}" aria-label="HQ agent">`
      + (names.length ? `<button class="btn-s" type="button" data-fp-pick>PICK ONE</button>` : "")
      + `<p class="fpnote">${names.length ? "" : "No agent runs in herdr without a floor. "}A floor whose HQ is not running yet shows STARTING until it does.</p>`;
  }
  return `<select class="levels" name="hq" aria-label="HQ agent">${names.map((a) => `<option value="${esc(a)}"${a === form.hq ? " selected" : ""}>${esc(a)}${isLane(a) ? " (a lane)" : ""}</option>`).join("")}<option value="${TYPE}">TYPE A NAME…</option></select>`;
}

function html() {
  const f = form.mode === "edit" ? floorById(S, form.id) : null;
  const colors = FLOOR_COLORS.includes(form.color) ? FLOOR_COLORS : [...FLOOR_COLORS, form.color];
  const how = (v, label) => `<button class="btn-s${form.how === v ? " on" : ""}" type="button" data-fp-how="${v}" aria-pressed="${form.how === v}">${label}</button>`;
  const save = form.busy ? (form.how === "start" ? "STARTING HQ…" : "SAVING…") : form.mode === "edit" ? "SAVE" : form.how === "start" ? "START HQ AND ADD" : "ADD FLOOR";
  const confirm = form.confirm && f
    ? `<div class="fconfirm" data-floor-confirm><span>Remove ${esc(floorLabel(f))}? What it leaves (answered questions, updates, notes, the log) moves to the first floor.</span><button class="btn-s" type="button" data-fp-rm-no>KEEP IT</button><button class="btn-s danger" type="button" data-fp-rm-yes>REMOVE IT</button></div>`
    : "";
  return `<form class="fpform" data-fp style="--fc:${esc(form.color)}">
    <div class="fphead"><i class="fsw" style="background:${esc(form.color)}"></i><b>${f ? `EDIT THE ${esc(floorLabel(f))} FLOOR` : "ADD A FLOOR"}</b><button class="fpx" type="button" data-fp-close aria-label="Close">✕</button></div>
    <label class="fprow"><span class="sk">NAME</span><input class="levels" name="name" maxlength="40" spellcheck="false" autocomplete="off" placeholder="Backend, Legal, Sales…" value="${esc(form.name)}" aria-label="Floor name"></label>
    <div class="fprow"><span class="sk">COLOUR</span><div class="opts2">${colors.map((c) => `<button class="fcolor${c === form.color ? " on" : ""}" type="button" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="Colour ${esc(c)}" aria-pressed="${c === form.color}"></button>`).join("")}</div></div>
    <div class="fprow"><span class="sk">HQ</span><div class="fphq">${f ? "" : `<div class="opts2 fphow">${how("agent", "USE AN AGENT")}${how("start", "START A NEW HQ")}</div>`}${hqHTML()}</div></div>
    ${form.error ? `<div class="fperr" role="alert">${mdInline(form.error)}</div>` : ""}
    <div class="opts2 fpacts"><button class="btn-s on" type="submit" data-fp-save${form.busy ? " disabled" : ""}>${save}</button><button class="btn-s" type="button" data-fp-close>CANCEL</button>${f ? `<button class="btn-s" type="button" data-fp-rm ${removable(f) ? "" : "disabled"} title="${removable(f) ? "Remove this floor" : "Only an empty floor can go: move its lanes first (hud lane NAME --floor OTHER)"}">REMOVE</button>` : ""}</div>
    ${confirm}
  </form>`;
}

function draw() {
  if (!form) return;
  if (!box) {
    box = document.createElement("section");
    box.className = "box fpanel";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Floor");
    stage.append(box);
    wire();
  }
  box.hidden = false;
  const focused = document.activeElement?.name;
  setHTML(box, html());
  if (focused && box.contains(document.activeElement) === false) box.querySelector(`[name="${focused}"]`)?.focus();
}
// What is typed stays in the form while it is drawn again.
function keep() {
  const el = box?.querySelector("[data-fp]");
  if (!el || !form) return;
  form.name = el.elements.name.value;
  if (el.elements.hqText) form.hq = el.elements.hqText.value.trim();
  else if (el.elements.hq && el.elements.hq.value !== TYPE) form.hq = el.elements.hq.value;
}

async function save() {
  keep();
  const name = form.name.trim(), hq = form.hq.trim();
  form.error = "";
  if (!name) { form.error = "Give the floor a name."; draw(); return; }
  const id = form.mode === "add" ? slug(name) : form.id;
  if (!id) { form.error = "A name with letters or digits."; draw(); return; }
  if (form.how === "agent" && !hq) { form.error = "Pick its HQ agent, or START A NEW HQ."; draw(); return; }
  form.busy = true;
  draw();
  try {
    if (form.mode === "add") await post("/api/floors", form.how === "start" ? { id, name, color: form.color, start: true } : { id, name, hq, color: form.color });
    else await post(`/api/floors/${encodeURIComponent(id)}`, { name, hq, color: form.color });
    const added = form.mode === "add";
    closePanel();
    toast(added ? `${name.toUpperCase()} FLOOR ADDED.` : "SAVED.");
    // A new floor shows in the building, among the others; an edited one stays where you are.
    if (added) toBuilding();
  } catch (err) {
    if (!form) return;
    form.busy = false;
    form.error = err.message;
    draw();
  }
}

function wire() {
  box.addEventListener("submit", (e) => { e.preventDefault(); if (!form?.busy) save(); });
  box.addEventListener("input", () => {
    keep();
    // START A NEW HQ names the agent after the floor: say which, as it is typed.
    const id = box.querySelector(".fpid");
    if (id) id.textContent = `hq-${slug(form.name) || "<id>"}`;
  });
  box.addEventListener("change", (e) => {
    if (e.target.name === "hq" && e.target.value === TYPE) { keep(); form.typed = true; form.hq = ""; draw(); box.querySelector("[name=hqText]")?.focus(); }
  });
  box.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-fp-close], [data-color], [data-fp-how], [data-fp-pick], [data-fp-rm], [data-fp-rm-no], [data-fp-rm-yes]");
    if (!t || !form) return;
    if (t.matches("[data-fp-close]")) { closePanel(); return; }
    keep();
    if (t.matches("[data-color]")) form.color = t.dataset.color;
    else if (t.matches("[data-fp-how]")) { form.how = t.dataset.fpHow; form.error = ""; }
    else if (t.matches("[data-fp-pick]")) { form.typed = false; form.hq = free()[0] ?? ""; }
    else if (t.matches("[data-fp-rm]")) form.confirm = true;
    else if (t.matches("[data-fp-rm-no]")) form.confirm = false;
    else if (t.matches("[data-fp-rm-yes]")) {
      const id = form.id;
      try {
        await post(`/api/floors/${encodeURIComponent(id)}`, { rm: true });
        closePanel();
        toast("FLOOR REMOVED.");
        return;
      } catch (err) { form.confirm = false; form.error = err.message; }
    }
    draw();
  });
}

// A floor that went while its edit was open closes the panel.
on("state", () => {
  if (form?.mode === "edit" && !floorById(S, form.id)) closePanel();
});
