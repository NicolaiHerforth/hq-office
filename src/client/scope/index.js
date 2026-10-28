// Where the scope shows: the chip in a row under the tabs, and a border round the screen in the floor's
// colour (a second ring inside it at the agent level). Made the first time a scope is set, as blocked/ makes its
// box, so a page with no scope is exactly the page without this feature.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { scope, outOne, view } from "../core/scope.js";
import { chipText, floorList, floorOfLane } from "../core/floors.js";
import { setText } from "../core/format.js";

let chip = null, border = null, ring = null;

function make() {
  chip = document.createElement("button");
  chip.type = "button";
  chip.className = "scopechip";
  chip.addEventListener("click", outOne);
  document.getElementById("qtabs")?.after(chip);
  border = document.createElement("div");
  border.className = "scopeborder";
  ring = document.createElement("div");
  ring.className = "scopering";
  document.body.append(border, ring);
}

function render() {
  const v = view();
  const active = !!(v.floor || v.agent);
  if (!active && !chip) return;
  if (!chip) make();
  chip.hidden = border.hidden = ring.hidden = !active;
  if (!active) return;
  const floor = v.floor ?? floorOfLane(S, v.agent);
  const color = floorList(S).find((f) => f.id === floor)?.color ?? floorList(S)[0].color;
  border.style.borderColor = color;
  ring.style.borderColor = color;
  ring.hidden = !v.agent;
  chip.style.borderColor = color;
  chip.style.background = color;
  setText(chip, chipText(S, scope()));
}
on("scope", render);
on("state", render);
