// The top bar's BLOCKED count: lanes whose agent waits at a prompt in herdr. Shown only while there is one; the box
// is made the first time it is needed, so a page with no blocked lane is exactly the page without this feature.
// Clicking it selects the longest-blocked lane, whose card shows the prompt and where to answer it.
import { on } from "../core/bus.js";
import { esc, setClass, setHTML } from "../core/format.js";
import { S as current } from "../core/state.js";

let box = null;
function draw(S) {
  const blocked = (S.lanes ?? []).filter((l) => l.status === "blocked").sort((a, b) => (a.herdr_since ?? 0) - (b.herdr_since ?? 0));
  if (!blocked.length && !box) return;
  if (!box) {
    box = document.createElement("button");
    box.type = "button";
    box.id = "sBlocked";
    document.querySelector(".top .right .strip")?.after(box);
  }
  box.hidden = !blocked.length;
  if (!blocked.length) return;
  setClass(box, "box blockedbox");
  box.dataset.select = blocked[0].name;
  const tip = blocked.map((l) => `${l.name} (${l.machine || "?"} ${l.pane || ""}): ${l.prompt || ""}`).join("\n\n");
  if (box.title !== tip) box.title = tip;
  setHTML(box, `<span class="k">BLOCKED</span><span class="v">${esc(blocked.length)}</span>`);
}
on("state", draw);
if (current) draw(current); // the state may have come before this module
