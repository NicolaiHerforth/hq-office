// "HQ isn't receiving": a red banner above everything while the server finds no agent it can type into as HQ (S.hq,
// see src/server/hq-link.ts). It says why and since when, lists what is held for HQ, and offers the fix: give HQ's
// last pane its name back, or check again. Made the first time it is needed, so a page whose HQ is fine is unchanged.
// With floors (docs/floors.md) it is about the floor you are in; in the building, one line per floor whose HQ isn't
// receiving. TELL HQ's placeholder says it too (tell/tell.js).
import { on } from "../core/bus.js";
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { clock, esc, setHTML } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { S } from "../core/state.js";
import { floorById, floorLabel, floorsOf, linkOf, multi, needsFix } from "../core/floors.js";
import { officeFloor } from "../core/scope.js";

let box = null;
const was = new Map(); // floor id (or "" with one floor) -> whether its HQ was receiving

// The fix for one floor's HQ: its buttons carry the floor when there are floors.
function fixHTML(hq, floor) {
  const at = floor ? ` data-floor="${esc(floor)}"` : "";
  const fix = hq.candidate
    ? `<button class="btn hqfix" type="button" data-hq="name"${at}>NAME ${esc(hq.candidate.pane)} "${esc(hq.agent)}"</button>`
    : "";
  // A floor's HQ that stopped and cannot be named back: start a new one, or pick another (floors/index.js).
  const f = floor ? floorById(S, floor) : null;
  const again = f && needsFix(S, f) ? `<button class="btn" type="button" data-floor-start="${esc(f.id)}">START ITS HQ</button><button class="btn" type="button" data-floor-pick="${esc(f.id)}">PICK ANOTHER</button>` : "";
  return `<span class="acts">${fix}<button class="btn" type="button" data-hq="check"${at}>CHECK NOW</button>${again}</span>`;
}
function howHTML(hq) {
  return hq.candidate
    ? `HQ's last pane, ${esc(hq.candidate.pane)}, holds a ${esc(hq.candidate.agent)} agent without a name: most likely HQ, restarted.`
    : `Start HQ in herdr with the name <code>${esc(hq.agent)}</code>, or in HQ's pane run <code>herdr agent rename "$HERDR_PANE_ID" ${esc(hq.agent)}</code>.`;
}
// One short strip, so the questions under it keep their room: what and why on the first line, the fix beside it,
// and what is held folded under it.
function oneHTML(hq, floor) {
  const held = hq.held ?? [];
  const name = floor ? `${esc(floorLabel(floorById(S, floor)))}: ` : "";
  return `
    <div class="head"><b>${name}HQ ISN'T RECEIVING</b><span class="why">${esc(hq.reason)}${hq.since ? ` · since ${clock(hq.since)}` : ""}</span>${fixHTML(hq, floor)}</div>
    <p>What you send is kept and goes to HQ, in order, once it can take it. ${howHTML(hq)}</p>
    ${held.length ? `<details class="held"><summary>HELD FOR HQ (${held.length})</summary>${held.map((h) => `<div><b>${clock(h.at)}</b>${mdInline(h.text.replace(/^HUD note from [^:]+: /, ""))}</div>`).join("")}</details>` : ""}`;
}
// The building: one line per floor whose HQ isn't receiving.
function manyHTML(down) {
  return `<div class="head"><b>HQ ISN'T RECEIVING ON ${down.length} ${down.length === 1 ? "FLOOR" : "FLOORS"}</b><span class="why">What you send is kept and goes to that HQ once it can take it.</span></div>`
    + down.map(([f, hq]) => `<div class="fline"><b>${esc(floorLabel(f))}</b><span class="why">${esc(hq.agent)}: ${esc(hq.reason)}${hq.since ? ` · since ${clock(hq.since)}` : ""}${hq.held?.length ? ` · ${hq.held.length} held` : ""}</span>${fixHTML(hq, f.id)}</div>`).join("");
}

function render() {
  if (!S) return;
  const many = multi(S);
  // A toast when a floor's HQ stops receiving, wherever you are.
  for (const [id, hq] of many ? floorsOf(S).map((f) => [f.id, linkOf(S, f.id)]) : [["", S.hq]]) {
    if (hq?.ok === false && was.get(id) === true) toast(id ? `${floorLabel(floorById(S, id))}: HQ ISN'T RECEIVING.` : "HQ ISN'T RECEIVING.");
    if (hq?.ok != null) was.set(id, hq.ok);
  }
  const floor = many ? officeFloor() : null;
  const down = many && !floor ? floorsOf(S).map((f) => [f, linkOf(S, f.id)]).filter(([, hq]) => hq?.ok === false) : [];
  const hq = many ? (floor ? linkOf(S, floor) : null) : S.hq;
  const shown = hq?.ok === false || down.length > 0;
  if (!shown && !box) return;
  if (!box) {
    box = document.createElement("section");
    box.className = "box hqdown";
    box.setAttribute("role", "alert");
    document.querySelector(".wrap")?.prepend(box);
  }
  box.hidden = !shown;
  if (!shown) return;
  setHTML(box, down.length ? manyHTML(down) : oneHTML(hq, floor));
}
on("state", render);
on("scope", render);

document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-hq]");
  if (!b) return;
  b.disabled = true;
  try {
    const link = await post(`/api/hq/${b.dataset.hq}`, b.dataset.floor ? { floor: b.dataset.floor } : {});
    toast(link?.ok ? "HQ IS RECEIVING. HELD MESSAGES SENT." : "HQ STILL ISN'T RECEIVING.");
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});
