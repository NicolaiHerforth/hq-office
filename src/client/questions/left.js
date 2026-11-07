// A question that closes while you are in it (answered elsewhere, withdrawn) does not take your words with it: its card
// stays where it is and says what happened, the box read-only so the words can be copied, until you move on. After a
// reload, the ones you were away for wait behind one row at the top of the list, and what is still open comes first.
import { $, toast } from "../core/dom.js";
import { esc } from "../core/format.js";
import { floorTagHTML } from "../core/floors.js";
import { mdInline } from "../core/markdown.js";
import { pick, tagged } from "../core/scope.js";
import { ask } from "../core/sheet.js";
import { S } from "../core/state.js";
import { askerOf } from "./asker.js";
import { drafts } from "./drafts.js";

const hud = $("hud");

const words = (id) => (drafts.get(id)?.text || "").trim();
const noteHTML = (id, pasted, pictures) => {
  const done = (S.answered ?? []).find((x) => x.id === id);
  const said = (done?.answer || "").replace(/\s+/g, " ").slice(0, 160);
  const what = !done ? "THIS QUESTION IS NO LONGER OPEN" : done.status === "withdrawn" ? "WITHDRAWN" : "ANSWERED ELSEWHERE";
  const sent = words(id) ? "Your words were not sent. They stay here until you discard them." : "";
  const gone = `${pasted ? " What you pasted was not saved, and it is cleared." : ""}${pictures ? " The picture you attached was not sent, and it is not kept." : ""}`;
  return `<div class="leftnote${words(id) ? "" : " plain"}" role="status"><span class="sk">${what}</span>${said ? `<div class="md">${mdInline(said)}</div>` : ""}${sent || gone ? `<p>${esc(sent + gone)}</p>` : ""}
    <div class="leftacts">${words(id) ? `<button class="btn-s" type="button" data-left-copy>COPY</button>` : ""}<button class="btn-s" type="button" data-left-drop>${words(id) ? "DISCARD" : "DISMISS"}</button><button class="btn-s" type="button" data-left-next>NEXT</button></div></div>`;
};
export function turnLeft(card, id, { pasted = false, pictures = false } = {}) {
  card.classList.add("left");
  const d = drafts.get(id);
  if (d) d.about ??= { title: card.querySelector(":scope > h3")?.textContent, who: card.dataset.lane, floor: card.dataset.askFloor };
  // What stands above the box stays where it is, doing nothing now: the words do not move.
  card.querySelector(":scope > .asksec")?.remove();
  for (const el of card.querySelectorAll(":scope > .menu .opt")) el.disabled = true;
  const reply = card.querySelector(":scope > .reply"), box = reply?.querySelector("textarea");
  // The same box stays, with its focus and its caret.
  if (words(id) && box) {
    box.readOnly = true;
    box.value = drafts.get(id).text;
    for (const el of reply.querySelectorAll(".acts, .tray, .chips")) el.remove();
  } else reply?.remove();
  card.querySelector(":scope > .leftnote")?.remove();
  card.insertAdjacentHTML("beforeend", noteHTML(id, pasted, pictures));
}
// What a closed card says about its question once the question has gone from S as well: parked with the words.
export function noteAbout() {
  for (const [id, d] of drafts) {
    const a = S?.open.find((x) => x.id === id) ?? S?.answered?.find((x) => x.id === id);
    if (a) d.about = { title: a.title, who: askerOf(a) ?? a.lane, floor: a.floor };
  }
}
// After a reload: the words are parked, the card is not.
export function leftCard(id) {
  const card = document.createElement("article"), about = drafts.get(id)?.about;
  card.className = "box ask left";
  card.dataset.ask = id;
  const done = (S.answered ?? []).find((x) => x.id === id);
  card.dataset.created = done?.created_at ?? Date.now();
  card.dataset.lane = about?.who ?? done?.lane ?? "";
  card.dataset.askFloor = about?.floor ?? done?.floor ?? "";
  const who = card.dataset.lane ? `<span class="tag" title="${esc(card.dataset.lane)}">${esc(card.dataset.lane)}</span>` : "";
  card.innerHTML = `<div class="meta">${who}<span class="timer"></span></div><h3>${mdInline(about?.title || done?.title || `Question #${id}`)}</h3>${words(id) ? `<div class="reply"><textarea readonly rows="3">${esc(drafts.get(id).text)}</textarea></div>` : ""}`;
  return card;
}
export const holdsWords = (card) => !!words(Number(card.dataset.ask));
export function dropLeft(card) {
  drafts.delete(Number(card.dataset.ask));
  card.remove();
  syncRow();
}

const row = document.createElement("div");
row.className = "leftrow";
row.innerHTML = `<button class="btn-s" type="button" data-left-open aria-expanded="false"></button><button class="btn-s" type="button" data-left-all>DISCARD ALL</button>`;
const [opener] = row.children;
const parkedCards = () => [...hud.querySelectorAll(":scope > .ask.parked:not([hidden])")];
const rowSays = (n) => `${n} CLOSED QUESTION${n === 1 ? "" : "S"} HAD YOUR WORDS`;
const setOpen = (open) => { hud.classList.toggle("leftopen", open); opener.setAttribute("aria-expanded", open); };
export const showParked = () => setOpen(true);
function syncRow() {
  const n = parkedCards().length;
  if (!n) { setOpen(false); row.remove(); return; }
  opener.textContent = rowSays(n);
  if (!row.isConnected) hud.prepend(row);
}
// What a reload says about them, in the words of the row, or of the floor they are on.
export const toldAfterReload = () => {
  const n = parkedCards().length;
  return n ? `${rowSays(n)}: THE ROW AT THE TOP OF THE LIST.` : "A QUESTION WITH YOUR DRAFT CLOSED WHILE YOU WERE AWAY, ON ANOTHER FLOOR. IT IS ON THAT FLOOR'S LIST.";
};
// A closed card is scoped like any other: on its floor's list, with its floor's tag where lists show every floor. Says
// whether one came or went.
export function syncLeft() {
  let moved = false;
  for (const card of hud.querySelectorAll(":scope > .ask.left")) {
    const floor = card.dataset.askFloor, out = !!floor && !pick([{ floor }]).length;
    if (card.hidden !== out) { card.hidden = out; moved = true; }
    if (out) card.classList.remove("on");
    const meta = card.querySelector(":scope > .meta"), tag = tagged();
    if (meta && !!meta.querySelector(".fstripe") !== tag) {
      for (const el of meta.querySelectorAll(".fstripe, .fswatch")) el.remove();
      if (tag) meta.insertAdjacentHTML("afterbegin", floorTagHTML(S, floor));
    }
  }
  syncRow();
  return moved;
}
row.addEventListener("click", async (e) => {
  if (e.target.closest("[data-left-open]")) { setOpen(!hud.classList.contains("leftopen")); return; }
  const closed = parkedCards();
  const sure = await ask({ text: `Discard your words on ${closed.length} closed question${closed.length === 1 ? "" : "s"}? They were not sent, and they cannot be brought back.`, yes: "DISCARD ALL" });
  if (sure) for (const card of closed) dropLeft(card);
});
$("hud").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-left-copy]");
  if (!copy) return;
  const box = copy.closest(".ask").querySelector("textarea");
  try { await navigator.clipboard.writeText(box.value); toast("COPIED."); }
  // Where the page is not on a secure address: the words are selected, for the phone's own copy.
  catch { box.focus(); box.select(); toast("SELECTED: COPY IT WITH YOUR KEYBOARD OR MENU."); }
});
