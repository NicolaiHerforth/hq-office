// Tell HQ: the free-text note box, with its attached images and files.
import { $, toast } from "../core/dom.js";
import { on } from "../core/bus.js";
import { S } from "../core/state.js";
import { post } from "../core/net.js";
import { attachButton, chipsHTML, clearImages, hasImages, notReady, withImages } from "../images/images.js";
import { setHTML } from "../core/format.js";

$("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = $("noteText").value.trim();
  if (!typed && !hasImages("note")) return;
  const wait = notReady("note");
  if (wait) { toast(wait); return; }
  const wasUrgent = urgent.getAttribute("aria-pressed") === "true";
  try { await post("/api/notes", { text: withImages("note", typed), urgent: wasUrgent }); urgent.setAttribute("aria-pressed", "false"); $("noteText").value = ""; $("noteText").style.height = ""; clearImages("note"); toast(wasUrgent && S.hq?.ok === false ? "KEPT. HQ ISN'T RECEIVING; IT GOES WHEN HQ IS BACK." : "SENT TO HQ."); } catch (err) { toast(err.message); }
});
// URGENT: it goes to the top of HQ's queue and one line is typed into HQ's pane. Whether a plain note waits in the queue
// is the server's TELL_GOES_TO_QUEUE; the title follows what /api/state says.
const urgent = document.createElement("button");
urgent.type = "button";
urgent.className = "btn urgent-toggle";
urgent.textContent = "URGENT";
const TITLES = {
  queue: "HQ reads a plain note from its queue; an urgent one reaches HQ at once",
  direct: "A plain note reaches HQ at once; an urgent one also goes to the top of HQ's queue",
};
urgent.title = TITLES.queue;
on("state", () => { if (S?.queue) urgent.title = S.queue.tellToQueue === false ? TITLES.direct : TITLES.queue; });
urgent.setAttribute("aria-pressed", "false");
urgent.addEventListener("click", () => urgent.setAttribute("aria-pressed", String(urgent.getAttribute("aria-pressed") !== "true")));
// In the head, beside the hint: it marks the note before it is typed, and the send row stays the photo button then SEND.
document.querySelector("#compose .head .hint").after(urgent);
$("noteText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("compose").requestSubmit(); });
// The attach button, the same on every send box, and what was attached before a reload. The whole TELL HQ panel
// takes a drop for its box.
document.querySelector("#compose .acts").insertAdjacentHTML("afterbegin", attachButton("note"));
setHTML(document.querySelector('[data-chips="note"]'), chipsHTML("note"));
$("compose").closest(".box").setAttribute("data-drop", "");
