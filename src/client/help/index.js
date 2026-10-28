// NEED HELP: the agents in scope that need the owner or HQ, worst first, in a strip between the room and the worker card.
// A row chooses its agent (the same click as a worker's: data-select), so it is the tap target a marker is too small to be.
// Nobody needing help reads "0 NEED HELP" and is disabled. The strip follows the scope but never changes it.
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { view } from "../core/scope.js";
import { HELP_COLORS, HELP_NAMES, helpStrip } from "../core/floors.js";
import { esc, setHTML } from "../core/format.js";

const strip = document.createElement("section");
strip.className = "box needhelp";
strip.setAttribute("aria-label", "Need help");
strip.hidden = true;
document.querySelector(".stage > .under").before(strip);

// What the strip takes of the page's height, with the gap above the card: on a phone FROM HQ is sized to fit one screen with the
// room (core/layout.css), so help.css takes the strip's share from it.
new ResizeObserver(() => {
  const gap = parseFloat(getComputedStyle(strip.parentElement).rowGap) || 0;
  document.documentElement.style.setProperty("--help-h", strip.hidden ? "0px" : `${strip.offsetHeight + gap}px`);
}).observe(strip);

function render() {
  if (!S) return;
  strip.hidden = false;
  const { count, rows, disabled } = helpStrip(S, view());
  strip.classList.toggle("zero", disabled);
  if (disabled) return void setHTML(strip, `<button class="helpzero" type="button" disabled>0 NEED HELP</button>`);
  const title = (name) => S.lanes.find((l) => l.name === name)?.title ?? "";
  setHTML(strip, `<h3>${count} NEED HELP</h3><div class="helpl">${rows.map((r) =>
    `<button class="lrow" type="button" data-select="${esc(r.lane)}"><i class="dot" style="background:${HELP_COLORS[r.state]}"></i><b>${esc(r.lane)}</b><span class="d">${esc(title(r.lane))}</span><span class="tag">${HELP_NAMES[r.state]}</span></button>`).join("")}</div>`);
}
on("state", render);
on("scope", render);
