// One gate for every control on a card. When a card on screen closes or changes, by your press or someone else's, the list
// moves under where you decided: for a moment SEND, DONE, OK, NOT YET, an option, DISCARD, DISMISS and NEXT do nothing and say
// so. COPY stays free. A key goes free too: it has no pixel and finds its card from the focus, so a card that moved cannot take it.
import { toast } from "../core/dom.js";

const CONTROLS = ".send, .notyet, .opt, [data-left-drop], [data-left-next]";
// The danger is a press already under way when the list moves: a person sees the move and can correct after a few hundred ms.
const CORRECT_MS = 400;
const root = document.documentElement;
let timer = 0;

export function cardChanged() {
  root.classList.add("unready");
  clearTimeout(timer);
  timer = setTimeout(() => root.classList.remove("unready"), CORRECT_MS);
}

document.addEventListener("click", (e) => {
  if (!root.classList.contains("unready") || !e.detail || !e.target.closest?.(CONTROLS)?.closest("[data-ask]")) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  toast("HELD: THE LIST JUST CHANGED. THAT PRESS DID NOT COUNT.");
}, true);
