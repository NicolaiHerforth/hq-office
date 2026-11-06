// Notices new questions: the chime, the count on the tab and the pill. Whatever you are reading stays on the screen.
import { S } from "../core/state.js";
import { chime } from "../sound/sound.js";
import { markNew } from "./questions.js";

let seenAsks = null;

export function announce() {
  const ids = new Set(S.open.map((a) => a.id));
  if (seenAsks) {
    const fresh = S.open.filter((a) => !seenAsks.has(a.id));
    if (fresh.length) { chime(); markNew(fresh.map((a) => a.id)); }
  }
  seenAsks = ids;
}
