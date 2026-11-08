// NEEDS YOU: everything the owner is the blocker on (the open asks), their timers, and the pill for asks out of view.
// Each card says what it waits for: a QUESTION to decide, a TO DO only the owner can do (DONE or NOT YET), or FYI.
import { emit, on } from "../core/bus.js";
import { $, pageScrolls, toast } from "../core/dom.js";
import { drafts, secretDrafts } from "./drafts.js";
import { S } from "../core/state.js";
import { ago, clock, dur, esc, setClass, setHTML, setText } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { renderSecretTimes } from "../secrets/secrets.js";
import { clearImages, composer, hasImages, imageKeys } from "../images/images.js";
import { enter, pick, scope, tagged } from "../core/scope.js";
import { floorById, floorTagHTML, hqShown, readingOf } from "../core/floors.js";
import { fillFrames, holdFrames, onSmall, onStage, pageSlotHTML, stagedAsk } from "./ask-page.js";
import { askerOf, forWhom, pickWord } from "./asker.js";
import { arrive, beforeRemove, eyeLine, hold, isLeaving, onScreen, remember, scrollOn, sentAnswer, settle, watchCard } from "./place.js";
import { cardChanged } from "./hold.js";
import { focusOn, focusTo, focused, leftOnStage, setFocus, stepFrom, syncFocus } from "./focus.js";
import { dropLeft, holdsWords, leftCard, showParked, syncLeft, toldAfterReload, turnLeft } from "./left.js";

// A question below the fold gets a red pill at the bottom of the list: tap it to go there, to the first new one if any
// has arrived. Where the page scrolls, the pill sits on the screen between ▲ and ▼ and says where you are.
const unseen = new Set(), showing = new Set(); // not on screen yet; new, on screen now
export function markNew(ids) { for (const id of ids) unseen.add(String(id)); }
const go = (el) => el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
const pill = $("below"), nav = document.createElement("div");
nav.className = "asknav";
nav.innerHTML = `<button class="stepb" type="button" data-step="-1" aria-label="Previous question">▲</button><button class="stepb" type="button" data-step="1" aria-label="Next question">▼</button><button class="focusb" type="button" data-focus aria-pressed="false" title="One question at a time">FOCUS</button><button class="askback" type="button" data-back hidden></button>`;
const [stepUp, stepDown] = nav.querySelectorAll(".stepb"), focusB = nav.querySelector(".focusb"), backB = nav.querySelector(".askback");
const liveCards = () => [...$("hud").querySelectorAll(":scope > .ask:not(.left)")];
const typed = (id) => { const d = drafts.get(id); return !!((d?.text || "").trim() || d?.opt || hasImages(id) || Object.values(secretDrafts.get(id) ?? {}).some(Boolean)); };
// A chip on the card: new since you last looked, or holding what you typed. Set only when it differs: it can take a line.
export function markCard(el) {
  const id = el.dataset.ask, mark = [(unseen.has(id) || showing.has(id)) && "NEW", typed(Number(id)) && "DRAFT"].filter(Boolean).join(" · ");
  if ((el.dataset.mark ?? "") === mark) return;
  if (mark) el.dataset.mark = mark; else delete el.dataset.mark;
}
// The card under your eye, and the way back to it once you follow NEW or a jump from somewhere else.
let here = null, back = null, gotAway = false;
const cardFor = (id) => cards.get(Number(id));
function show(el) {
  if (!el) return;
  if (focusOn()) { focusTo(Number(el.dataset.ask)); renderBelow(); } else go(el);
}
function follow(el) {
  if (el && here && here !== el && !back) { back = here.dataset.ask; gotAway = false; }
  show(el);
}
export function renderBelow() {
  const list = $("hud"), cards = liveCards();
  const stacked = pageScrolls(), line = eyeLine(), edge = stacked ? innerHeight : list.getBoundingClientRect().bottom;
  const view = list.getBoundingClientRect(), mode = focusOn(), gone = leftOnStage();
  for (const el of cards) {
    const r = el.getBoundingClientRect(), id = el.dataset.ask;
    if (r.top < edge && r.bottom > line && !list.hidden) { if (unseen.delete(id)) showing.add(id); } else showing.delete(id);
    markCard(el);
  }
  const fresh = cards.filter((el) => unseen.has(el.dataset.ask));
  const hidden = mode ? [] : cards.filter((el) => el.getBoundingClientRect().bottom > edge + 1);
  const news = fresh.length ? `${fresh.length} NEW` : "";
  // The next new one below you, else the first: a question that is due sorts to the top.
  const nextNew = fresh.find((el) => el.getBoundingClientRect().top > line) ?? fresh[0];
  const inside = mode ? cards.findIndex((el) => Number(el.dataset.ask) === focused()) : cards.findIndex((el) => el.getBoundingClientRect().bottom > line + 60);
  // Reading the closed cards at the top of the list: no question is yours to count yet, and the next one is the first.
  const overClosed = !mode && [...list.querySelectorAll(":scope > .ask.parked")].some((el) => el.getBoundingClientRect().bottom > line + 60);
  const i = overClosed ? -1 : inside < 0 ? cards.length - 1 : inside;
  here = gone || overClosed ? null : cards[i] ?? null;
  // A list that fits has no place to lose: the row comes with a list longer than its view, and stays with the mode.
  const long = stacked ? cards.length > 1 && view.height > innerHeight - line : list.scrollHeight > list.clientHeight;
  const row = !list.hidden && (mode ? cards.length > 0 || !!gone : long);
  if (!row) nav.remove();
  else if (!nav.isConnected) list.before(nav);
  // It goes once you are back: a smooth scroll is still on the card you left when it starts.
  if (here !== cardFor(back)) gotAway = true;
  if (back && (!cardFor(back) || (gotAway && cardFor(back) === here))) back = null;
  backB.hidden = !row || !back;
  if (back) backB.textContent = `◀ BACK TO ${cards.indexOf(cardFor(back)) + 1}${typed(Number(back)) ? " · YOUR DRAFT" : ""}`;
  focusB.setAttribute("aria-pressed", mode);
  const counted = row && (stacked || mode);
  stepUp.hidden = stepDown.hidden = !counted;
  if (!counted) {
    if (pill.parentElement === nav) document.querySelector(".qwrap")?.append(pill);
    pill.classList.remove("quiet");
    pill.onclick = () => follow(nextNew ?? hidden[0]);
    pill.hidden = stacked || !(fresh.length || hidden.length) || list.scrollHeight <= list.clientHeight;
    pill.textContent = news && !hidden.length ? news : `+${hidden.length} MORE OUT OF VIEW${news && ` · ${news}`}`;
    return;
  }
  if (pill.parentElement !== nav) nav.firstElementChild.after(pill);
  pill.hidden = false;
  pill.classList.toggle("quiet", !fresh.length);
  pill.textContent = gone || overClosed ? `${cards.length} WAITING${news && ` · ${news}`}` : `${i + 1} OF ${cards.length}${news && ` · ${news}`}`;
  stepUp.disabled = mode ? stepFrom(-1) == null : overClosed || (i === 0 && cards[0].getBoundingClientRect().top >= line - 1);
  stepDown.disabled = mode ? stepFrom(1) == null : i === cards.length - 1;
  pill.onclick = () => (fresh.length ? follow(nextNew) : mode ? null : go(cards[i + 1]));
}
// A step in FOCUS. A card that has closed goes with the step when it holds no words of yours, or when you discard them.
// From one there is always somewhere to go: the card after it, else the one before, else the empty list.
export function focusStep(n, discard = false) {
  const gone = leftOnStage(), drop = gone && (discard || !holdsWords(gone)), id = stepFrom(n) ?? (gone ? stepFrom(-n) : null);
  if (id == null && !drop) {
    if (gone) toast("NOTHING ELSE IS OPEN. YOUR WORDS STAY HERE UNTIL YOU COPY OR DISCARD THEM.");
    return;
  }
  if (drop) dropLeft(gone);
  focusTo(id);
  renderBelow();
}
// NEXT, and NOT YET in FOCUS: if the step brings another card, it comes under the finger that pressed.
export function stepOn() {
  const was = focused();
  focusStep(1);
  if (focused() !== was) cardChanged();
}
nav.addEventListener("click", (e) => {
  const step = Number(e.target.closest("[data-step]")?.dataset.step);
  if (e.target.closest("[data-focus]")) toggleFocus();
  else if (e.target.closest("[data-back]")) { const el = cardFor(back); back = null; show(el); renderBelow(); }
  else if (step && focusOn()) focusStep(step);
  else if (step) {
    const cards = liveCards(), i = cards.indexOf(here), line = eyeLine();
    // ▲ first goes back to the top of the card you are inside; ▼ always to the next one.
    const within = step < 0 && here?.getBoundingClientRect().top < line - 8;
    go(within ? here : cards[i + step]);
  }
});
// From the list to one question and back: the card under your eye is the one you stay on, and it stays where it is.
function toggleFocus() {
  const on = !focusOn(), el = on ? here : cardFor(focused()) ?? leftOnStage(), top = el?.getBoundingClientRect().top;
  setFocus(on, el ? Number(el.dataset.ask) : null);
  if (on && el) focusTo(Number(el.dataset.ask));
  else if (el?.isConnected) {
    if (el.classList.contains("parked")) showParked();
    arrive({ next: el, top });
  }
  renderBelow();
  remember();
}
// ANSWER IN NEEDS YOU and a question's own link: that question, in either mode, on its floor if the list leaves it out.
on("needs:go", (id) => {
  const a = S?.open.find((x) => x.id === id);
  if (!a) return;
  if (!pick(S.open).includes(a)) enter(a.floor);
  const el = cardFor(id);
  if (!el) return;
  follow(el);
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
});
// The arrow keys, when you are not typing and nothing else has them.
document.addEventListener("keydown", (e) => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (!step || !focusOn() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || $("hud").hidden) return;
  if (document.documentElement.classList.contains("sheetopen")) return; // not the question behind a sheet
  const t = e.target;
  if (t !== document.body && !t.closest?.("#hud, .asknav")) return;
  if (t.closest?.("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  // A card taller than the window is read first: the step comes once its end is in view.
  const card = $("hud").querySelector(":scope > .ask.on")?.getBoundingClientRect();
  if (card) {
    const edge = pageScrolls() ? innerHeight : $("hud").getBoundingClientRect().bottom, line = eyeLine();
    const rest = step > 0 ? card.bottom - edge : line - card.top;
    if (rest > 1 && scrollOn(step * Math.min(rest, (edge - line) * 0.8))) return;
  }
  focusStep(step);
});
$("hud").addEventListener("click", (e) => {
  if (e.target.closest("[data-left-next]")) { stepOn(); return; }
  if (!e.target.closest("[data-left-drop]")) return;
  const card = e.target.closest(".ask");
  if (leftOnStage() === card) focusStep(1, true); else { dropLeft(card); renderBelow(); }
  cardChanged();
});
$("hud").addEventListener("scroll", renderBelow, { passive: true });
addEventListener("scroll", () => { if (pageScrolls()) renderBelow(); }, { passive: true });
new ResizeObserver(renderBelow).observe($("hud"));

// An ask for secrets is answered with all of them, or (with none filled) in words, a pick or an image: never by a
// bare DONE or OK, which would leave its secrets blank and look like a reply.
export function canSend(a, d) {
  const want = a.secrets ?? [];
  const filled = want.filter((n) => secretDrafts.get(a.id)?.[n]).length;
  const said = !!d.opt || !!(d.text || "").trim() || hasImages(a.id);
  if (want.length) return filled ? filled === want.length : said;
  return a.kind !== "decision" || said;
}
// A picked, uploaded or removed image can change whether its ask can be sent.
on("attach", (key) => {
  const a = S?.open.find((x) => String(x.id) === key), btn = document.querySelector(`[data-ask="${CSS.escape(key)}"] .send`);
  if (a && btn) btn.disabled = !canSend(a, drafts.get(a.id) || {});
  // Parked with the drafts: what a closed card says about its question.
  if (a && hasImages(a.id) && !drafts.has(a.id)) drafts.set(a.id, {});
  const card = cardFor(key);
  if (card) markCard(card);
});

const KIND_LABEL = { decision: "QUESTION", action: "TO DO", info: "FYI" };

// FOR PM · Manager: the lane that asked, which the answer goes to (a click opens its card).
function forHTML(a) {
  const name = askerOf(a);
  if (!name) return "";
  const level = S.lanes.find((l) => l.name === name)?.level;
  return `<button class="tag for" data-select="${esc(name)}" title="${esc(name)} asked this: your answer goes to ${esc(name)}">FOR ${esc(name.toUpperCase())}${level ? ` · ${esc(level)}` : ""}</button>`;
}

// Nothing waits on you on this floor. When nothing moves either, that is not "all good": it says so, and whose it is.
function emptyFloorHTML(f) {
  const r = readingOf(f.counts), hq = hqShown(f) || f.hq;
  if (!r.stall) return `<div class="box"><h2>NOTHING ON THIS FLOOR NEEDS YOU</h2></div>`;
  const idle = r.idleSince ? ` for <span data-since="${r.idleSince}" data-ago>${ago(Date.now() - r.idleSince)}</span>` : "";
  return `<div class="box stallnote${r.stall === 2 ? " late" : ""}"><h2>NOTHING IS MOVING</h2><p>${mdInline(`Nothing waits on you here, but nothing is moving: ${r.active} ${r.active === 1 ? "lane" : "lanes"} idle`)}${idle}. ${mdInline(`That's on **${hq}**.`)}</p><button class="btn-s" type="button" data-tell-floor="${esc(f.id)}">TELL ${esc(hq.toUpperCase())}</button></div>`;
}
// The +N MORE OUT OF VIEW pill sits at the foot of the list it is about.
document.querySelector(".qwrap")?.append($("below"));

// The answer row: the options (with the asker's pick), the secrets an ask wants, and the send box. One copy at a time: in the
// card, or on the stage while the ask's page is there (renderDock).
const fieldHint = (a) => (a.kind === "action" ? `Optional note for ${forWhom(a)}` : a.options.length ? "Add detail, or your own answer" : "Your answer");
function answerHTML(a) {
  const d = drafts.get(a.id) || {};
  const kind = a.kind;
  const want = a.secrets ?? [];
  const opts = a.options.map((o) => `<button class="opt ${d.opt === o ? "sel" : ""}" data-opt="${esc(o)}">${esc(o)}${a.recommended === o ? ` <span class="pick">${esc(pickWord(a))}</span>` : ""}</button>`).join("");
  return `${opts ? `<div class="menu">${opts}</div>` : ""}
      ${want.length ? `<div class="asksec">${want.map((n) => `<label><span class="tag secret">${esc(n)}</span><input class="sin val" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="paste ${esc(n)}" data-secret="${esc(n)}"></label>`).join("")}
        <label><span class="sk">READABLE FOR</span><input class="sin min" type="number" min="1" max="10080" step="1" autocomplete="off" data-secret-min value="${esc(d.minutes ?? 60)}"><span class="sk">MIN</span></label></div>` : ""}
      ${composer(a.id, `<textarea rows="1" placeholder="${esc(fieldHint(a))}">${esc(d.text || "")}</textarea>`,
        `${kind === "action" ? `<button class="notyet" type="button">NOT YET</button>` : ""}<button class="send ${kind !== "decision" ? "go" : ""}" ${canSend(a, d) ? "" : "disabled"}>${kind === "action" ? "DONE" : kind === "info" ? "OK" : "SEND"}</button>`)}`;
}
function metaHTML(a, tags, page) {
  const want = a.secrets ?? [];
  return `<div class="meta">
        ${tags ? floorTagHTML(S, a.floor) : ""}${a.lane ? `<button class="tag lane" data-select="${esc(a.lane)}" title="${esc(a.lane)}">${esc(a.lane)}</button>` : ""}${forHTML(a)}
        <span class="tag kind ${esc(a.kind)}">${esc(KIND_LABEL[a.kind] ?? a.kind.toUpperCase())}</span>
        ${want.length ? `<span class="tag secret">SECRETS</span>` : ""}
        ${page ? `<a class="tag pageopen" href="#page/asks/${a.id}" title="Open the page at full width">OPEN PAGE ▶</a>` : ""}
        ${a.link ? `<a class="tag" href="${esc(a.link)}" target="_blank" rel="noopener">OPEN LINK</a>` : ""}
        <span class="due"></span>
        <span class="timer"></span>
      </div>`;
}
// Values being pasted are kept in memory only and put back as the input's value, never as markup.
function restoreSecrets(root) {
  for (const inp of root.querySelectorAll("[data-secret]")) {
    const v = secretDrafts.get(Number(inp.closest("[data-ask]").dataset.ask))?.[inp.dataset.secret];
    if (v) inp.value = v;
  }
}

export function renderHud() {
  renderList();
  renderDock();
}

// A card is built once and then changed in place, by the parts that differ, so a state push leaves alone the box you
// type in, its keyboard, what you read and every other card. What the owner has done in the answer row (a picked
// option, the text) lives in that row: it is built again only when the question itself offers something else.
const READ = ":scope > .meta, :scope > h3, :scope > .text, :scope > .askpage, :scope > .askstrip";
const ANSWER = ":scope > .menu, :scope > .asksec, :scope > .reply, :scope > .onstage";
const answerShape = (a, stagedHere) => JSON.stringify([stagedHere, a.kind, a.options, a.recommended, a.secrets, a.options.length ? pickWord(a) : ""]);
const nodes = (html) => { const t = document.createElement("template"); t.innerHTML = html; return t.content; };
const shown = new WeakMap(); // a card -> { read, shape }

function focusOf(card) {
  const el = document.activeElement;
  if (!card.contains(el) || !el.matches("textarea, input")) return null;
  return { secret: el.dataset.secret, min: el.dataset.secretMin !== undefined, caret: el.selectionStart };
}
function refocus(card, f) {
  if (!f) return;
  const q = f.secret != null ? `[data-secret="${CSS.escape(f.secret)}"]` : f.min ? "[data-secret-min]" : "textarea";
  const el = card.querySelector(q);
  if (el) { el.focus({ preventScroll: true }); if (f.caret != null) try { el.setSelectionRange(f.caret, f.caret); } catch {} }
}
function syncCard(card, a, read, answer, shape) {
  const was = shown.get(card);
  if (was.read !== read) {
    holdFrames(card);
    const edited = card.querySelector(".meta .tag.edited");
    for (const el of card.querySelectorAll(READ)) el.remove();
    card.prepend(nodes(read));
    // The ledger's tag (ledger/index.js) goes on the meta row after the card is drawn.
    if (edited) { const meta = card.querySelector(".meta"); meta.insertBefore(edited, meta.querySelector(".due")); }
  }
  if (was.shape !== shape) {
    const d = drafts.get(a.id);
    if (d?.opt && !a.options.includes(d.opt)) delete d.opt;
    const f = focusOf(card);
    for (const el of card.querySelectorAll(ANSWER)) el.remove();
    card.append(nodes(answer()));
    restoreSecrets(card);
    refocus(card, f);
  } else {
    const ta = card.querySelector(":scope > .reply textarea"), hint = fieldHint(a);
    if (ta && ta.placeholder !== hint) ta.placeholder = hint;
  }
  shown.set(card, { read, shape });
  const due = a.due || "", lane = a.lane || "";
  if (card.dataset.due !== String(due)) card.dataset.due = due;
  if (card.dataset.lane !== lane) card.dataset.lane = lane;
  if (card.dataset.askFloor !== (a.floor ?? "")) card.dataset.askFloor = a.floor ?? "";
}
function newCard(a, cls, read, answer, shape) {
  const card = nodes(`<article class="${cls}" data-ask="${a.id}" data-lane="${esc(a.lane || "")}" data-ask-floor="${esc(a.floor ?? "")}" data-created="${a.created_at}" data-due="${a.due || ""}">${read}${answer()}</article>`).firstElementChild;
  shown.set(card, { read, shape });
  restoreSecrets(card);
  return card;
}

const cards = new Map(); // an ask's id -> its card in the list
let shownHead = null, restored = false, shownScope = "";
function renderList() {
  const hud = $("hud");
  // Inside a floor (docs/floors.md): that floor's asks; the scope row over the list says what other floors hold.
  const open = pick(S.open), tags = tagged(), staged = stagedAsk();
  const here = scope().all ? null : floorById(S, scope().floor);
  // The count lives in the top bar now; the list only needs words when it is empty.
  const head = open.length ? "" : here ? emptyFloorHTML(here) : `<div class="box"><h2>NOTHING NEEDS YOU</h2><div style="color:var(--muted);font-size:14px">Every worker is either at its desk or waiting on HQ or CI. Decisions and things only you can do land here.</div></div>`;
  const where = JSON.stringify(scope()), entered = where !== shownScope;
  shownScope = where;
  let changed = false, leftFor = null;
  if (head !== shownHead) {
    shownHead = head;
    hud.querySelector(":scope > .box:not(.ask)")?.remove();
    if (head) hud.prepend(nodes(head));
    changed = true;
  }
  const wanted = new Set(open.map((a) => a.id));
  const isOpen = (id) => S.open.some((a) => a.id === id);
  for (const [id, card] of cards) {
    if (wanted.has(id)) continue;
    cards.delete(id);
    changed = true;
    // It closed without you, with your words in it or on the stage: it says so where it is, and you move on from it.
    const words = !!(drafts.get(id)?.text || "").trim(), pasted = Object.values(secretDrafts.get(id) ?? {}).some(Boolean), pictures = hasImages(id);
    if (!isOpen(id) && !isLeaving(id) && (words || pasted || pictures || (focused() === id && open.length))) {
      toast(words ? "A QUESTION WITH YOUR DRAFT CLOSED. YOUR WORDS STAY ON ITS CARD." : pictures ? "A QUESTION WITH YOUR PICTURE CLOSED. THE PICTURE WAS NOT SENT." : "THIS QUESTION CLOSED.");
      if (onScreen(card)) cardChanged();
      turnLeft(card, id, { pasted, pictures });
      continue;
    }
    leftFor = beforeRemove(card, !isOpen(id)) ?? leftFor;
    card.remove();
    // Nothing of yours is on it: a pick means nothing once its question has gone. An answer on its way keeps it until it lands.
    if (!isOpen(id) && !isLeaving(id)) drafts.delete(id);
  }
  // After a reload: what you left on a question that closed meanwhile, however long ago, newest first, and the question on
  // the stage if it is the one. The words stay until you discard them; a bare pick does not.
  const parkedNow = !restored && [...drafts.keys()].filter((id) => !isOpen(id) && ((drafts.get(id)?.text || "").trim() || hasImages(id))).sort((a, b) => a - b);
  if (parkedNow) {
    restored = true;
    const known = focused() && open.length && !isOpen(focused()) && S.answered?.some((x) => x.id === focused()) ? [focused()] : [];
    for (const id of new Set([...parkedNow, ...known])) {
      const card = leftCard(id);
      card.classList.toggle("parked", parkedNow.includes(id));
      hud.prepend(card);
      turnLeft(card, id, { pictures: hasImages(id) });
      if (focused() === id) card.classList.add("on");
      changed = true;
    }
    for (const id of [...drafts.keys()]) if (!isOpen(id) && !parkedNow.includes(id) && !known.includes(id)) drafts.delete(id);
  }
  if (syncLeft()) changed = true;
  if (parkedNow?.length) toast(focusOn() ? "A QUESTION WITH YOUR DRAFT CLOSED WHILE YOU WERE AWAY. IT STAYS ON ITS CARD." : toldAfterReload());
  for (const id of secretDrafts.keys()) if (!isOpen(id)) secretDrafts.delete(id);
  for (const key of imageKeys()) if (/^\d+$/.test(key) && !S.open.some((a) => String(a.id) === key) && !isLeaving(Number(key))) clearImages(key);
  // A card that has closed stays where it is among the others.
  const skipLeft = (el) => { while (el?.classList.contains("left")) el = el.nextElementSibling; return el; };
  let at = skipLeft(hud.querySelector(":scope > .ask"));
  for (const a of open) {
    // An ask with a page shows it under its text (ask-page.js); on the stage, its answer row goes with it.
    const page = S.askPages?.[a.id], onStage = page && staged === a.id;
    const read = `${metaHTML(a, tags, page)}<h3>${mdInline(a.title)}</h3>${a.body ? `<div class="text md">${mdClip(a.body, `q${a.id}`)}</div>` : ""}${page ? pageSlotHTML(a, page, onStage) : ""}`;
    const answer = () => (onStage ? `<a class="onstage" href="#page/asks/${a.id}">ANSWER IT ON THE STAGE, UNDER ITS PAGE ▶</a>` : answerHTML(a));
    const shape = answerShape(a, !!onStage);
    let card = cards.get(a.id);
    if (card) {
      const was = shown.get(card);
      if (was.read !== read || was.shape !== shape) { syncCard(card, a, read, answer, shape); changed = true; }
      card.classList.toggle("haspage", !!page);
    } else {
      card = newCard(a, `box ask${page ? " haspage" : ""}`, read, answer, shape);
      cards.set(a.id, card);
      watchCard(card);
      changed = true;
    }
    if (card === at) { at = skipLeft(at.nextElementSibling); continue; }
    // Moved with moveBefore where there is one: a frame keeps running and the focus stays.
    if (card.isConnected && hud.moveBefore) hud.moveBefore(card, at); else hud.insertBefore(card, at);
    changed = true;
  }
  if (!changed) { settle(); return; }
  fillFrames(hud);
  syncFocus(open.map((a) => a.id), isOpen);
  if (leftFor?.next.isConnected && !focusOn()) arrive(leftFor); else hold(entered);
  settle();
  tick();
  renderBelow();
}

// The answer row on the stage, under an ask's page (#page/asks/ID: pages/index.js mounts the dock). Once the ask is
// answered, the dock says what the answer was.
let dock = null, dockCard = null;
on("askdock:mount", (el) => { dock = el; dockCard = null; renderDock(); });
function renderDock() {
  if (!dock?.isConnected || !S) return;
  const id = Number(dock.dataset.askdock), a = S.open.find((x) => x.id === id);
  if (a) {
    const read = `${metaHTML(a, tagged(), null)}<h3>${mdInline(a.title)}</h3>`, answer = () => answerHTML(a), shape = answerShape(a, false);
    if (dockCard?.isConnected) { const was = shown.get(dockCard); if (was.read === read && was.shape === shape) return; syncCard(dockCard, a, read, answer, shape); }
    else { dockCard = newCard(a, "ask dock", read, answer, shape); dock.replaceChildren(dockCard); }
    tick();
    return;
  }
  dockCard = null;
  const done = (S.answered ?? []).find((x) => x.id === id) ?? sentAnswer(id);
  setHTML(dock, `<div class="dockdone"><span class="sk">${done ? (done.status === "withdrawn" ? "WITHDRAWN" : "ANSWERED") : "NOT OPEN"}</span>${done ? `<h3>${mdInline(done.title)}</h3>${done.answer ? `<div class="md">${mdClip(done.answer, `dock${id}`)}</div>` : ""}` : "<span>This question is not waiting on you.</span>"}</div>`);
  tick();
}
// An ask's page went onto the stage or left it, or the screen crossed the phone width: the cards show it.
onStage(() => { if (S) renderHud(); });
onSmall(() => { if (S) renderHud(); });

export function tick() {
  const now = Date.now();
  for (const el of document.querySelectorAll(".ask")) {
    const age = now - Number(el.dataset.created);
    el.classList.toggle("warm", age > 5 * 60000 && age <= 30 * 60000);
    el.classList.toggle("hot", age > 30 * 60000);
    setText(el.querySelector(".timer"), dur(age));
    const due = Number(el.dataset.due);
    const de = el.querySelector(".due");
    if (due) { setText(de, due > now ? `DUE ${clock(due)}` : `OVERDUE ${clock(due)}`); setClass(de, "due" + (due <= now ? " late" : "")); }
  }
  // data-ago: a coarse age ("4 min", "2h") that wakes the clock once a minute.
  for (const el of document.querySelectorAll("[data-since]")) setText(el, (el.hasAttribute("data-ago") ? ago : dur)(now - Number(el.dataset.since)));
  if (S) {
    const oldest = S.open.length ? Math.min(...S.open.map((a) => a.created_at)) : null;
    const age = oldest ? now - oldest : 0;
    setClass($("sOld"), "old" + (age > 30 * 60000 ? " hot" : age > 5 * 60000 ? " warm" : ""));
    setText($("sOld").querySelector(".v"), oldest ? dur(age) : "-");
  }
  const phase = Math.floor(now / 250) % 4, step = phase === 0 ? "" : phase === 2 ? "blink-2" : "blink-1";
  for (const el of document.querySelectorAll(".blink-1, .blink-2")) if (!el.matches(BLINKING)) el.classList.remove("blink-1", "blink-2");
  for (const el of document.querySelectorAll(BLINKING)) { el.classList.toggle("blink-1", step === "blink-1"); el.classList.toggle("blink-2", step === "blink-2"); }
  renderSecretTimes();
  emit("tick");
}
// The page clock wakes only for the next visible change: an age shown in seconds (under an hour) or minutes, a due
// time passing, or the next blink step while something blinks. Never while the page is hidden.
const BLINKING = ".urgent.alert .count, .ask.hot .timer";
let clockTimer = null;
export function scheduleTick() {
  clearTimeout(clockTimer);
  clockTimer = null;
  if (!S || document.hidden) return;
  const now = Date.now();
  let wait = Infinity;
  for (const el of document.querySelectorAll("[data-created], [data-since]")) {
    const age = now - Number(el.dataset.created ?? el.dataset.since), step = age < 3600_000 && !el.hasAttribute("data-ago") ? 1000 : 60_000;
    wait = Math.min(wait, step - (age % step));
  }
  for (const el of document.querySelectorAll("[data-due]")) { const due = Number(el.dataset.due); if (due > now) wait = Math.min(wait, due - now); }
  if (document.querySelector(BLINKING)) wait = Math.min(wait, 250 - (now % 250));
  if (!$("secretsPanel").hidden && document.querySelector("#secretList [data-exp]")) wait = Math.min(wait, 1000 - (now % 1000));
  if (wait < Infinity) clockTimer = setTimeout(() => { tick(); scheduleTick(); }, wait + 5);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S) tick(); scheduleTick(); });
