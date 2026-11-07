// Clicks delegated from the whole document: select a worker, MORE/LESS.
import { renderLastNote } from "../tell/last-note.js";
import { select } from "../room/input.js";
import { expanded } from "./markdown.js";
import { renderHud } from "../questions/questions.js";
import { renderMsgs } from "../messages/messages.js";

document.addEventListener("click", (e) => {
  const sel = e.target.closest("[data-select]");
  // On a question's card the drawer opens over your place; anywhere else, the lane's question comes along.
  if (sel) { select(sel.dataset.select, !sel.closest("[data-ask]")); return; }
  const more = e.target.closest(".more[data-more]");
  if (more) {
    const key = more.dataset.more;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderLastNote();
    renderHud();
    renderMsgs();
  }
});
