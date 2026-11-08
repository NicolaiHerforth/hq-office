// Notices new questions: the chime, the count on the tab and the pill. Whatever you are reading stays on the screen.
// An ask seen once is never new again: one whose answer failed comes back without a chime.
import { S } from "../core/state.js";
import { chime } from "../sound/sound.js";
import { markNew } from "./questions.js";

let seenAsks = null;

export function announce() {
  if (seenAsks) {
    const fresh = S.open.filter((a) => !seenAsks.has(a.id));
    if (fresh.length) { chime(); markNew(fresh.map((a) => a.id)); }
  }
  seenAsks = new Set([...(seenAsks ?? []), ...S.open.map((a) => a.id)]);
}
