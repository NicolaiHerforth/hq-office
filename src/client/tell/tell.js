// Tell HQ: the free-text note box, with its attached images and files. With floors a FLOOR select sits beside SEND
// (as in PR #8): it shows the floor you are in, or in the building the last floor used, and can be set
// to any other floor for one note. Its placeholder names that floor's HQ, or says when that HQ isn't receiving or is
// still starting.
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { attachButton, chipsHTML, clearImages, hasImages, notReady, withImages } from "../images/images.js";
import { esc, setHTML } from "../core/format.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { firstFloor, floorById, floorsOf, linkOf, multi } from "../core/floors.js";
import { scope } from "../core/scope.js";

const PLACEHOLDER = $("noteText").placeholder;
const LAST = "hq-tell-floor";
let picked = (() => { try { return localStorage.getItem(LAST); } catch { return null; } })();
// A floor set in the select inside a floor holds until you go elsewhere.
let override = null; // { in: the floor you were in, floor }
// The floor a note goes to; null with one floor (the server's first floor, as before floors).
function tellFloor() {
  if (!S || !multi(S)) return null;
  const s = scope();
  if (override && override.in === s.floor && floorById(S, override.floor)) return override.floor;
  if (s.floor) return s.floor;
  return floorById(S, picked)?.id ?? firstFloor(S);
}
function remember(floor) {
  picked = floor;
  try { localStorage.setItem(LAST, floor); } catch {}
}

$("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("noteText").value.trim();
  if (!typed && !hasImages("note")) return;
  const wait = notReady("note");
  if (wait) { toast(wait); return; }
  const floor = tellFloor();
  try {
    await post("/api/notes", { text: withImages("note", typed), ...(floor ? { floor } : {}) });
    if (floor) remember(floor);
    $("noteText").value = ""; $("noteText").style.height = ""; clearImages("note");
    toast(linkOf(S, floor)?.ok === false ? "KEPT. HQ ISN'T RECEIVING; IT GOES WHEN HQ IS BACK." : floorById(S, floor)?.starting ? "KEPT. IT GOES WHEN THE NEW HQ RUNS." : "SENT TO HQ.");
    renderTell();
  } catch (err) { toast(err.message); }
});
$("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("compose").requestSubmit(); });
// The attach button, the same on every send box, and what was attached before a reload. The whole TELL HQ panel
// takes a drop for its box.
document.querySelector("#compose .acts").insertAdjacentHTML("afterbegin", attachButton("note"));
setHTML(document.querySelector('[data-chips="note"]'), chipsHTML("note"));
$("compose").closest(".box").setAttribute("data-drop", "");

// The FLOOR select beside SEND: made the first time there are two floors, so one floor's page is unchanged.
function renderTell() {
  if (!S) return;
  const choose = multi(S);
  let sel = $("tellFloor");
  if (choose && !sel) {
    sel = document.createElement("select");
    sel.id = "tellFloor";
    sel.className = "tfloor";
    sel.setAttribute("aria-label", "The floor whose HQ gets this");
    sel.addEventListener("change", () => {
      const at = scope().floor;
      override = at && sel.value !== at ? { in: at, floor: sel.value } : null;
      remember(sel.value);
      renderTell();
    });
    document.querySelector("#compose .acts .send").before(sel);
  }
  if (sel) {
    sel.hidden = !choose;
    if (choose) {
      setHTML(sel, floorsOf(S).map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join(""));
      sel.value = tellFloor();
    }
  }
  const floor = tellFloor(), f = floorById(S, floor);
  const link = linkOf(S, floor);
  const text = link?.ok === false ? "HQ isn't receiving: this is kept and sent when HQ is back."
    : f?.starting ? `Tell HQ (${f.name}): kept until ${f.hq} starts in herdr.` : f ? `Tell HQ (${f.name})…` : PLACEHOLDER;
  if ($("noteText").placeholder !== text) $("noteText").placeholder = text;
}
on("state", renderTell);
on("scope", () => { if (override && override.in !== scope().floor) override = null; renderTell(); });
