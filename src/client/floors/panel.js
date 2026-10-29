// The floor panel, over the stage: + ADD A FLOOR (in the floor list, the building and SETTINGS) adds a floor, EDIT
// changes one. A name, a colour from the floor palette (never red, amber or green: those are the readings), and its HQ,
// as a segmented control: USE AN AGENT (one of herdr's live named agents on this machine, lanes too: a lane promoted
// to run a domain; one that already runs a floor is shown, disabled, with that floor's name) or START A NEW HQ (the
// server opens a herdr tab beside the first floor's HQ and starts hq-<id> in it, as the herdr agent kind picked: any
// kind herdr can start, the first floor's HQ's by default; nothing assumes a provider). No typed names: a floor's HQ is an
// agent that runs, or one the HUD starts. EDIT renames, recolours, gives the floor another HQ (PICK ANOTHER opens it
// there), or removes it when it is empty, after a confirm in the page; REMOVE says why it cannot when it cannot.
// A failure shows in the panel, and nothing is added. Uses the floor routes (docs/floors.md).
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { floorById, floorsOf } from "../core/floors.js";
import { toBuilding } from "../core/scope.js";

// The floor palette, as the server's (src/server/floor-colors.ts): blue, teal, purple, magenta, slate, brown, cyan.
export const FLOOR_COLORS = ["#3c6fd6", "#1a9a8a", "#7a4fc9", "#b0469a", "#5f6b85", "#8a5a3c", "#2a9fc9"];
const stage = document.querySelector(".stage");
let box = null;
// The open form: { mode: "add" | "edit", id, name, color, how: "agent" | "start", hq, busy, error, confirm }.
let form = null;
let agents = null; // GET /api/floors/agents, read when the panel opens
let kinds = null; // GET /api/floors/kinds: the agent kinds herdr can start, read when the panel opens

export const panelOpen = () => !!form;
// No two floors wear one colour: a colour another floor wears is offered disabled, with its name (while one is free).
const wornBy = (c) => {
  const others = floorsOf(S).filter((x) => x.id !== form?.id);
  if (FLOOR_COLORS.every((p) => others.some((x) => x.color === p))) return "";
  return others.find((x) => x.color === c)?.name ?? "";
};
const slug = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
// herdr's live agents on this machine that run no other floor, by name; the one this floor has stays offered.
const free = () => [...new Set((agents ?? []).filter((a) => !a.floor || a.floor === form?.id).map((a) => a.name))].sort();
// Agents that already run another floor: offered disabled, with that floor's name.
const taken = () => (agents ?? []).filter((a) => a.floor && a.floor !== form?.id).sort((a, b) => a.name.localeCompare(b.name));
const isLane = (name) => (agents ?? []).some((a) => a.name === name && a.lane);
// Why a floor cannot go, in words; "" when it can.
function notRemovable(f) {
  if (floorsOf(S).length < 2) return "The last floor cannot go.";
  const lanes = f.counts?.lanes ?? 0, asks = f.counts?.needsYou ?? 0;
  const left = [lanes && `${lanes} ${lanes === 1 ? "lane" : "lanes"}`, asks && `${asks} ${asks === 1 ? "question" : "questions"}`].filter(Boolean);
  return left.length ? `Not empty: ${left.join(", ")}. Move its lanes first (hud lane NAME --floor OTHER).` : "";
}

export function openPanel(o) {
  const f = o.mode === "edit" ? floorById(S, o.id) : null;
  if (o.mode === "edit" && !f) return;
  $("settings").hidden = true;
  const used = new Set(floorsOf(S).map((x) => x.color));
  form = f
    ? { mode: "edit", id: f.id, name: f.name, color: f.color, how: "agent", hq: f.hq, kind: "", busy: false, error: "", confirm: false }
    : { mode: "add", id: null, name: "", color: FLOOR_COLORS.find((c) => !used.has(c)) ?? FLOOR_COLORS[0], how: "agent", hq: "", kind: "", busy: false, error: "", confirm: false };
  agents = null;
  kinds = null;
  fetch("/api/floors/kinds").then((r) => r.json()).then((d) => {
    kinds = d;
    if (form && !form.kind) form.kind = d.lead ?? d.ready?.[0] ?? d.kinds?.[0] ?? "";
    if (form?.how === "start") draw();
  }).catch(() => { kinds = { kinds: [], ready: [], lead: null }; });
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
    // PICK ANOTHER opens at the HQ select, once herdr's agents are in.
    if (o.focus === "hq") box.querySelector("[name=hq]")?.focus();
  }).catch(() => { agents = []; draw(); });
  draw();
  (o.focus === "hq" ? box.querySelector("[name=hq]") : null)?.focus() ?? box.querySelector("[name=name]")?.focus();
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
    return kindHTML() + `<p class="fpnote">The HUD opens a herdr tab beside <b>${esc(lead?.hq ?? "HQ")}</b>, in its folder, starts <b class="fpkind">${esc(form.kind || "an agent")}</b> named <b class="fpid">hq-${esc(id)}</b> in it, and sends it the HQ guide for this floor.</p>`;
  }
  if (agents === null) return `<p class="fpnote">Reading herdr's agents…</p>`;
  const names = free(), busy = taken();
  const f = form.mode === "edit" ? floorById(S, form.id) : null;
  // A floor's own HQ that is not running stays shown, so the select says what the floor has now.
  const gone = f && form.hq === f.hq && !names.includes(f.hq) ? `<option value="${esc(f.hq)}" selected disabled>${esc(f.hq)} (not running)</option>` : "";
  if (!names.length && !gone) {
    return `<p class="fpnote">No agent runs in herdr on this machine without a floor${busy.length ? ` (${busy.map((a) => esc(a.name)).join(", ")} already run one)` : ""}. ${f ? "Start one in herdr, then PICK ANOTHER again." : "START A NEW HQ, and the HUD starts one."}</p>`;
  }
  return `<select class="levels" name="hq" aria-label="HQ agent">${gone}${names.map((a) => `<option value="${esc(a)}"${a === form.hq ? " selected" : ""}>${esc(a)}${isLane(a) ? " (a lane)" : ""}</option>`).join("")}`
    + busy.map((a) => `<option value="${esc(a.name)}" disabled>${esc(a.name)} (HQ of ${esc(floorById(S, a.floor)?.name ?? a.floor)})</option>`).join("") + `</select>`
    + `<p class="fpnote">Agents that run in herdr on this machine. An HQ runs one floor.</p>`;
}

// Which agent the new HQ runs: any kind herdr can start. Those whose herdr integration is installed come first (herdr
// reads their state); the first floor's HQ's kind is the default. Nothing assumes a provider.
function kindHTML() {
  if (kinds === null) return `<p class="fpnote">Reading which agents herdr can start…</p>`;
  const ready = kinds.ready ?? [], all = kinds.kinds ?? [];
  const known = [...new Set([...(form.kind ? [form.kind] : []), ...ready])];
  const rest = all.filter((k) => !known.includes(k));
  const opt = (k) => `<option value="${esc(k)}"${k === form.kind ? " selected" : ""}>${esc(k)}${k === kinds.lead ? " (as the first HQ)" : ""}</option>`;
  const field = !known.length && !rest.length
    ? `<input class="levels" name="kind" spellcheck="false" autocomplete="off" placeholder="a herdr agent kind (herdr agent start --help)" value="${esc(form.kind)}">`
    : `<select class="levels" name="kind">${known.map(opt).join("")}${rest.length ? `<optgroup label="Other kinds (no herdr integration)">${rest.map(opt).join("")}</optgroup>` : ""}</select>`;
  return `<label class="fpk"><span class="sk">AGENT</span>${field}</label>`;
}

function html() {
  const f = form.mode === "edit" ? floorById(S, form.id) : null;
  const colors = FLOOR_COLORS.includes(form.color) ? FLOOR_COLORS : [...FLOOR_COLORS, form.color];
  const how = (v, label) => `<button class="seg${form.how === v ? " on" : ""}" type="button" role="radio" data-fp-how="${v}" aria-checked="${form.how === v}">${label}</button>`;
  const save = form.busy ? (form.how === "start" ? "STARTING HQ…" : "SAVING…") : form.mode === "edit" ? "SAVE" : form.how === "start" ? "START HQ AND ADD" : "ADD FLOOR";
  const confirm = form.confirm && f
    ? `<div class="fconfirm" data-floor-confirm><span>Remove ${esc(f.name)}? What it leaves (answered questions, updates, notes, the log) moves to the first floor.</span><button class="btn-s" type="button" data-fp-rm-no>KEEP IT</button><button class="btn-s danger" type="button" data-fp-rm-yes>REMOVE IT</button></div>`
    : "";
  return `<form class="fpform" data-fp style="--fc:${esc(form.color)}">
    <div class="fphead"><i class="fsw" style="background:${esc(form.color)}"></i><b>${f ? `EDIT <span class="fname">${esc(f.name)}</span>` : "ADD A FLOOR"}</b><button class="fpx" type="button" data-fp-close aria-label="Close">✕</button></div>
    <label class="fprow"><span class="sk">NAME</span><input class="levels" name="name" maxlength="40" spellcheck="false" autocomplete="off" placeholder="Backend, Legal, Sales…" value="${esc(form.name)}" aria-label="Floor name"></label>
    <div class="fprow"><span class="sk">COLOUR</span><div class="opts2">${colors.map((c) => { const by = wornBy(c); return `<button class="fcolor${c === form.color ? " on" : ""}" type="button" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="${by ? `${esc(c)}, worn by ${esc(by)}` : `Colour ${esc(c)}`}"${by ? ` disabled title="${esc(by)} wears it"` : ""} aria-pressed="${c === form.color}"></button>`; }).join("")}</div></div>
    <div class="fprow"><span class="sk">HQ</span><div class="fphq">${f ? "" : `<div class="fphow" role="radiogroup" aria-label="Its HQ">${how("agent", "USE AN AGENT")}${how("start", "START A NEW HQ")}</div>`}${hqHTML()}</div></div>
    ${form.error ? `<div class="fperr" role="alert">${mdInline(form.error)}</div>` : ""}
    <div class="opts2 fpacts"><button class="btn-s on" type="submit" data-fp-save${form.busy ? " disabled" : ""}>${save}</button><button class="btn-s" type="button" data-fp-close>CANCEL</button>${f ? `<button class="btn-s" type="button" data-fp-rm ${notRemovable(f) ? "disabled" : ""}>REMOVE</button>` : ""}</div>
    ${f && notRemovable(f) ? `<p class="fpnote fprmwhy">${mdInline(notRemovable(f))}</p>` : ""}
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
  if (el.elements.hq?.value) form.hq = el.elements.hq.value;
  if (el.elements.kind?.value !== undefined) form.kind = el.elements.kind.value.trim();
}

async function save() {
  keep();
  const name = form.name.trim(), hq = form.hq.trim();
  form.error = "";
  if (!name) { form.error = "Give the floor a name."; draw(); return; }
  const id = form.mode === "add" ? slug(name) : form.id;
  if (!id) { form.error = "A name with letters or digits."; draw(); return; }
  if (form.how === "agent" && !hq) { form.error = "Pick an agent that runs in herdr, or START A NEW HQ."; draw(); return; }
  form.busy = true;
  draw();
  try {
    let r = null;
    if (form.mode === "add") r = await post("/api/floors", form.how === "start" ? { id, name, color: form.color, start: true, ...(form.kind ? { kind: form.kind } : {}) } : { id, name, hq, color: form.color });
    else await post(`/api/floors/${encodeURIComponent(id)}`, { name, hq, color: form.color });
    const added = form.mode === "add";
    closePanel();
    toast(!added ? "SAVED." : r?.waiting ? `${name.toUpperCase()} FLOOR ADDED. ITS HQ WAITS ON A PROMPT IN ITS HERDR PANE: ANSWER IT THERE.` : `${name.toUpperCase()} FLOOR ADDED.`);
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
    const kind = box.querySelector(".fpkind");
    if (kind) kind.textContent = form.kind || "an agent";
  });
  box.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-fp-close], [data-color], [data-fp-how], [data-fp-rm], [data-fp-rm-no], [data-fp-rm-yes]");
    if (!t || !form) return;
    if (t.matches("[data-fp-close]")) { closePanel(); return; }
    keep();
    if (t.matches("[data-color]")) form.color = t.dataset.color;
    else if (t.matches("[data-fp-how]")) { form.how = t.dataset.fpHow; form.error = ""; }
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
