// Tell HQ: the free-text note box, with its attached images and files. With two or more floors a compact "to: Backend ▾"
// sits left of SEND (a native select under a label as wide as the name): it shows the floor you are in, or in the
// building the last floor used, and can be set to any other floor for one note. Its placeholder names that floor's HQ,
// or says when that HQ isn't receiving or is still starting. TELL <HQ> (a stalled floor's note in NEEDS YOU) points it
// at that floor and puts the cursor in the box.
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { attachButton, chipsHTML, clearImages, hasImages, notReady, withImages } from "../images/images.js";
import { esc, setHTML } from "../core/format.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { cut, firstFloor, floorById, floorsOf, linkOf, multi } from "../core/floors.js";
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
    const f = multi(S) ? floorById(S, floor) : null, to = f ? `${f.name.toUpperCase()} HQ` : "HQ";
    toast(linkOf(S, floor)?.ok === false ? `KEPT. ${to} ISN'T RECEIVING; IT GOES WHEN IT IS BACK.` : f?.starting ? `KEPT. IT GOES WHEN ${to} RUNS.` : `SENT TO ${to}.`);
    renderTell();
  } catch (err) { toast(err.message); }
});
$("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("compose").requestSubmit(); });
// The attach button, the same on every send box, and what was attached before a reload. The whole TELL HQ panel
// takes a drop for its box.
document.querySelector("#compose .acts").insertAdjacentHTML("afterbegin", attachButton("note"));
setHTML(document.querySelector('[data-chips="note"]'), chipsHTML("note"));
$("compose").closest(".box").setAttribute("data-drop", "");

// "to: Backend ▾" beside SEND: made the first time there are two floors, so one floor's page is unchanged.
function pickFloor(id) {
  const at = scope().floor;
  override = at && id !== at ? { in: at, floor: id } : null;
  remember(id);
  renderTell();
}
function renderTell() {
  if (!S) return;
  const choose = multi(S);
  let to = document.querySelector("#compose .tto");
  if (choose && !to) {
    to = document.createElement("label");
    to.className = "tto";
    to.innerHTML = `<span class="ttk">to:</span><span class="ttn"></span><span class="ttc" aria-hidden="true">▾</span><select id="tellFloor" aria-label="The floor whose HQ gets this"></select>`;
    to.querySelector("select").addEventListener("change", (e) => pickFloor(e.target.value));
    document.querySelector("#compose .acts .send").before(to);
  }
  if (to) {
    to.hidden = !choose;
    if (choose) {
      const sel = to.querySelector("select");
      setHTML(sel, floorsOf(S).map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join(""));
      sel.value = tellFloor();
      const f = floorById(S, sel.value);
      setHTML(to.querySelector(".ttn"), esc(cut(f?.name ?? "", 16)));
      to.style.setProperty("--fc", f?.color ?? "transparent");
      to.title = f ? `To the ${f.name} floor: its HQ, ${f.hq}, gets this` : "";
    }
  }
  const floor = tellFloor(), f = floorById(S, floor);
  const link = linkOf(S, floor);
  const text = link?.ok === false ? "HQ isn't receiving: this is kept and sent when HQ is back."
    : f?.starting ? `Tell HQ (${f.name}): kept until ${f.hq} starts in herdr.` : f ? `Tell HQ (${f.name})…` : PLACEHOLDER;
  if ($("noteText").placeholder !== text) $("noteText").placeholder = text;
}
on("state", renderTell);
// TELL <HQ>, from a floor where nothing moves: this box, to that floor.
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-tell-floor]");
  if (!b || !S || !floorById(S, b.dataset.tellFloor)) return;
  pickFloor(b.dataset.tellFloor);
  const box = $("noteText");
  box.scrollIntoView({ block: "nearest" });
  box.focus();
});
on("scope", () => { if (override && override.in !== scope().floor) override = null; renderTell(); });
