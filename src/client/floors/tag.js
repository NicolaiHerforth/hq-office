// The floor tag on a question or an update: its floor's label in the floor's colour, as markup for a row's meta line.
// Empty with one floor, where every row would carry the same tag (core/floors.js decides).
import { esc } from "../core/format.js";
import { floorTag } from "../core/floors.js";

export function floorTagHTML(S, item) {
  const t = floorTag(S, item);
  return t ? `<span class="tag floortag" data-floor="${esc(t.id)}" style="background:${t.color}">${esc(t.label)}</span>` : "";
}
