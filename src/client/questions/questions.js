// NEEDS YOU: everything the owner is the blocker on (the open asks), their timers, and the pill for asks out of view.
// Each card says what it waits for: a QUESTION to decide, a TO DO only the owner can do (DONE or NOT YET), or FYI.
import { emit, on } from "../core/bus.js";
import { $, pageScrolls } from "../core/dom.js";
import { drafts, secretDrafts } from "./drafts.js";
import { S } from "../core/state.js";
import { ago, clock, dur, esc, setClass, setHTML, setText } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { renderSecretTimes } from "../secrets/secrets.js";
import { clearImages, composer, hasImages, imageKeys } from "../images/images.js";
import { pick, scope, tagged } from "../core/scope.js";
import { floorById, floorTagHTML, hqShown, readingOf } from "../core/floors.js";
import { fillFrames, holdFrames, onSmall, onStage, pageSlotHTML, stagedAsk } from "./ask-page.js";
import { askerOf, forWhom, pickWord } from "./asker.js";
import { arrive, beforeRemove, eyeLine, hold, settle, watchCard } from "./place.js";

// A question below the fold gets a red pill at the bottom of the list: tap it to go there, to the first new one if any
// has arrived. Where the page scrolls, the pill sits on the screen between ▲ and ▼ and says where you are.
const unseen = new Set();
export function markNew(ids) { for (const id of ids) unseen.add(String(id)); }
const go = (el) => el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
const pill = $("below"), nav = document.createElement("div");
nav.className = "asknav";
nav.innerHTML = `<button class="stepb" type="button" data-step="-1" aria-label="Previous question">▲</button><button class="stepb" type="button" data-step="1" aria-label="Next question">▼</button>`;
export function renderBelow() {
  const list = $("hud"), cards = [...list.querySelectorAll(".ask")];
  const stacked = pageScrolls(), line = eyeLine(), edge = stacked ? innerHeight : list.getBoundingClientRect().bottom;
  const view = list.getBoundingClientRect();
  for (const el of cards) { const r = el.getBoundingClientRect(); if (r.top < edge && r.bottom > line && !list.hidden) unseen.delete(el.dataset.ask); }
  const fresh = cards.filter((el) => unseen.has(el.dataset.ask));
  const hidden = cards.filter((el) => el.getBoundingClientRect().bottom > edge + 1);
  const news = fresh.length ? `${fresh.length} NEW` : "";
  // The next new one below you, else the first: a question that is due sorts to the top.
  const nextNew = fresh.find((el) => el.getBoundingClientRect().top > line) ?? fresh[0];
  pill.onclick = () => go(nextNew ?? hidden[0]);
  if (!stacked) {
    nav.remove();
    if (pill.parentElement === nav) document.querySelector(".qwrap")?.append(pill);
    pill.hidden = !(fresh.length || hidden.length) || list.scrollHeight <= list.clientHeight;
    pill.textContent = news && !hidden.length ? news : `+${hidden.length} MORE OUT OF VIEW${news && ` · ${news}`}`;
    return;
  }
  // In the flow above the list, so it comes and goes only when the list stops or starts being longer than the screen.
  const shows = !list.hidden && cards.length > 1 && view.height > innerHeight - line;
  if (!shows) { nav.remove(); pill.hidden = true; return; }
  if (!nav.isConnected) { list.before(nav); nav.firstElementChild.after(pill); }
  const i = cards.findIndex((el) => el.getBoundingClientRect().bottom > line + 60);
  const here = i < 0 ? cards.length - 1 : i;
  pill.hidden = false;
  pill.classList.toggle("quiet", !fresh.length);
  pill.textContent = `${here + 1} OF ${cards.length}${news && ` · ${news}`}`;
  nav.querySelector('[data-step="-1"]').disabled = here === 0 && cards[0].getBoundingClientRect().top >= line - 1;
  nav.querySelector('[data-step="1"]').disabled = here === cards.length - 1;
  nav.onclick = (e) => {
    const step = Number(e.target.closest("[data-step]")?.dataset.step);
    if (!step) return;
    // ▲ first goes back to the top of the card you are inside; ▼ always to the next one.
    const inside = step < 0 && cards[here].getBoundingClientRect().top < line - 8;
    go(inside ? cards[here] : cards[here + step]);
  };
  if (!fresh.length) pill.onclick = () => go(cards[here + 1]);
}
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
        ${tags ? floorTagHTML(S, a.floor) : ""}${a.lane ? `<button class="tag lane" data-select="${esc(a.lane)}">${esc(a.lane)}</button>` : ""}${forHTML(a)}
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
}
function newCard(a, cls, read, answer, shape) {
  const card = nodes(`<article class="${cls}" data-ask="${a.id}" data-lane="${esc(a.lane || "")}" data-created="${a.created_at}" data-due="${a.due || ""}">${read}${answer()}</article>`).firstElementChild;
  shown.set(card, { read, shape });
  restoreSecrets(card);
  return card;
}

const cards = new Map(); // an ask's id -> its card in the list
let shownHead = null;
function renderList() {
  const hud = $("hud");
  // Inside a floor (docs/floors.md): that floor's asks; the scope row over the list says what other floors hold.
  const open = pick(S.open), tags = tagged(), staged = stagedAsk();
  const here = scope().all ? null : floorById(S, scope().floor);
  // The count lives in the top bar now; the list only needs words when it is empty.
  const head = open.length ? "" : here ? emptyFloorHTML(here) : `<div class="box"><h2>NOTHING NEEDS YOU</h2><div style="color:var(--muted);font-size:14px">Every worker is either at its desk or waiting on HQ or CI. Decisions and things only you can do land here.</div></div>`;
  for (const id of secretDrafts.keys()) if (!S.open.some((a) => a.id === id)) secretDrafts.delete(id);
  for (const key of imageKeys()) if (/^\d+$/.test(key) && !S.open.some((a) => String(a.id) === key)) clearImages(key);
  let changed = false, leftFor = null;
  if (head !== shownHead) {
    shownHead = head;
    hud.querySelector(":scope > .box:not(.ask)")?.remove();
    if (head) hud.prepend(nodes(head));
    changed = true;
  }
  const wanted = new Set(open.map((a) => a.id));
  for (const [id, card] of cards) {
    if (wanted.has(id)) continue;
    leftFor = beforeRemove(card) ?? leftFor;
    card.remove();
    cards.delete(id);
    changed = true;
  }
  let at = hud.querySelector(":scope > .ask");
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
    if (card === at) { at = at.nextElementSibling; continue; }
    // Moved with moveBefore where there is one: a frame keeps running and the focus stays.
    if (card.isConnected && hud.moveBefore) hud.moveBefore(card, at); else hud.insertBefore(card, at);
    changed = true;
  }
  if (!changed) { settle(); return; }
  fillFrames(hud);
  if (leftFor?.next.isConnected) arrive(leftFor); else hold();
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
  const done = (S.answered ?? []).find((x) => x.id === id);
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
