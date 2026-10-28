// SETTINGS · FLOORS: every floor with its colour, name, HQ and lanes, an EDIT per floor and + ADD A FLOOR. Both open
// the floor panel over the stage (floors/panel.js; the clicks are caught in floors/index.js), the same one the floor
// bar's + FLOOR and EDIT open.
import { on } from "../core/bus.js";
import { $ } from "../core/dom.js";
import { esc } from "../core/format.js";
import { S } from "../core/state.js";
import { floorsOf, hqMood, hqShown, MOOD_WORD } from "../core/floors.js";

export function floorsRow() {
  const rows = floorsOf(S).map((f) => {
    const mood = MOOD_WORD[hqMood(f)], hq = hqShown(f);
    return `<div class="frow" data-floor-row="${esc(f.id)}"><i class="fsw" style="background:${esc(f.color)}"></i><b title="${esc(f.name)}">${esc(f.name)}</b><span class="fh">${hq ? `HQ ${esc(hq)}` : "HQ"} ${mood} · ${f.counts?.lanes ?? 0} ${f.counts?.lanes === 1 ? "lane" : "lanes"}</span><button class="btn-s" type="button" data-floor-edit="${esc(f.id)}">EDIT</button></div>`;
  }).join("");
  return `<div class="srow" data-floors><span class="k">FLOORS</span><div class="flist">${rows}</div><div class="opts2"><button class="btn-s" type="button" data-floor-add>+ ADD A FLOOR</button></div><span class="hint">A floor is one HQ agent and everything it runs. The pill over the office lists them all.</span></div>`;
}
// The rows follow the state while the panel is open (a floor added by HQ, its lanes, its HQ).
on("state", () => {
  const el = !$("settings").hidden && $("settings").querySelector("[data-floors]");
  if (!el) return;
  const html = floorsRow();
  if (el.outerHTML !== html) el.outerHTML = html;
});
