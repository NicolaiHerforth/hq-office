// The question panel: the open asks, their timers, and the pill for asks out of view.
import { emit } from "../core/bus.js";
import { $, keepPlace } from "../core/dom.js";
import { drafts, secretDrafts } from "./drafts.js";
import { S } from "../core/state.js";
import { clock, dur, esc, setClass, setHTML, setText } from "../core/format.js";
import { clipText, linkify, renderBody } from "../core/text.js";
import { renderSecretTimes } from "../secrets/secrets.js";
import { selected } from "../room/input.js";

// A question below the fold gets a red pill at the bottom of the list. Click it to go to the next one.
export function renderBelow() {
  const list = $("hud"), pill = $("below");
  const edge = list.getBoundingClientRect().bottom;
  const hidden = [...list.querySelectorAll(".ask")].filter((el) => el.getBoundingClientRect().bottom > edge + 1);
  pill.hidden = !hidden.length || list.scrollHeight <= list.clientHeight;
  pill.textContent = `+${hidden.length} ${hidden.length === 1 ? "QUESTION" : "QUESTIONS"} OUT OF VIEW`;
  pill.onclick = () => hidden[0]?.scrollIntoView({ behavior: "smooth", block: "start" });
}
$("hud").addEventListener("scroll", renderBelow, { passive: true });
new ResizeObserver(renderBelow).observe($("hud"));

export function renderHud() {
  const hud = $("hud");
  const focused = document.activeElement?.closest?.("[data-ask]")?.dataset.ask;
  const caret = document.activeElement?.selectionStart;
  const focusedSecret = document.activeElement?.dataset?.secret;
  const focusedMin = document.activeElement?.dataset?.secretMin !== undefined;
  // The count lives in the top bar now; the list only needs words when it is empty.
  // With a lane in focus, only its questions.
  const open = selected ? S.open.filter((a) => a.lane === selected) : S.open;
  const head = open.length ? "" : selected ? `<div class="box"><h2>NOTHING FROM ${esc(selected.toUpperCase())} WAITS ON YOU</h2></div>` : `<div class="box"><h2>NOTHING WAITS ON YOU</h2><div style="color:var(--muted);font-size:14px">Every worker is either at its desk or waiting on HQ or CI. Questions land here.</div></div>`;
  const html = head + open.map((a) => {
    const d = drafts.get(a.id) || {};
    const kind = a.kind;
    const want = a.secrets ?? [];
    const filled = want.filter((n) => secretDrafts.get(a.id)?.[n]).length;
    // An ask for secrets is answered with all of them, or (with none filled) in words like any other ask.
    const canSend = want.length && filled ? filled === want.length : kind !== "decision" || d.opt || (d.text || "").trim();
    const opts = a.options.map((o) => `<button class="opt ${d.opt === o ? "sel" : ""}" data-opt="${esc(o)}">${esc(o)}${a.recommended === o ? ` <span class="pick">HQ PICK</span>` : ""}</button>`).join("");
    return `<article class="box ask" data-ask="${a.id}" data-lane="${esc(a.lane || "")}" data-created="${a.created_at}" data-due="${a.due || ""}">
      <div class="meta">
        ${a.lane ? `<button class="tag lane" data-select="${esc(a.lane)}">${esc(a.lane)}</button>` : ""}
        <span class="tag ${esc(kind)}">${esc(kind.toUpperCase())}</span>
        ${want.length ? `<span class="tag secret">SECRETS</span>` : ""}
        ${a.link ? `<a class="tag" href="${esc(a.link)}" target="_blank" rel="noopener">OPEN LINK</a>` : ""}
        <span class="due"></span>
        <span class="timer"></span>
      </div>
      <h3>${linkify(a.title)}</h3>
      ${a.body ? `<div class="text">${a.body.includes("```") ? renderBody(a.body) : clipText(a.body, `q${a.id}`)}</div>` : ""}
      ${opts ? `<div class="menu">${opts}</div>` : ""}
      ${want.length ? `<div class="asksec">${want.map((n) => `<label><span class="tag secret">${esc(n)}</span><input class="sin val" type="password" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore placeholder="paste ${esc(n)}" data-secret="${esc(n)}"></label>`).join("")}
        <label><span class="sk">READABLE FOR</span><input class="sin min" type="number" min="1" max="10080" step="1" autocomplete="off" data-secret-min value="${esc(d.minutes ?? 60)}"><span class="sk">MIN</span></label></div>` : ""}
      <div class="reply">
        <textarea rows="1" placeholder="${kind === "action" ? "Optional note for HQ" : a.options.length ? "Add detail, or answer in your own words" : "Your answer"}">${esc(d.text || "")}</textarea>
        <button class="send ${kind !== "decision" ? "go" : ""}" ${canSend ? "" : "disabled"}>${kind === "action" ? "DONE" : kind === "info" ? "OK" : "SEND"}</button>
      </div>
    </article>`;
  }).join("");
  // Values being pasted are kept in memory only and put back as the input's value, never as markup.
  for (const id of secretDrafts.keys()) if (!S.open.some((a) => a.id === id)) secretDrafts.delete(id);
  const place = keepPlace(hud, "data-ask");
  if (!setHTML(hud, html)) return;
  place();
  for (const inp of hud.querySelectorAll("[data-secret]")) {
    const v = secretDrafts.get(Number(inp.closest("[data-ask]").dataset.ask))?.[inp.dataset.secret];
    if (v) inp.value = v;
  }
  if (focused) {
    const q = `[data-ask="${focused}"]`;
    const ta = focusedSecret != null ? hud.querySelector(`${q} [data-secret="${CSS.escape(focusedSecret)}"]`) : focusedMin ? hud.querySelector(`${q} [data-secret-min]`) : hud.querySelector(`${q} textarea`);
    if (ta) { ta.focus(); if (caret != null) try { ta.setSelectionRange(caret, caret); } catch {} }
  }
  tick();
  renderBelow();
}

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
  for (const el of document.querySelectorAll("[data-since]")) setText(el, dur(now - Number(el.dataset.since)));
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
    const age = now - Number(el.dataset.created ?? el.dataset.since), step = age < 3600_000 ? 1000 : 60_000;
    wait = Math.min(wait, step - (age % step));
  }
  for (const el of document.querySelectorAll("[data-due]")) { const due = Number(el.dataset.due); if (due > now) wait = Math.min(wait, due - now); }
  if (document.querySelector(BLINKING)) wait = Math.min(wait, 250 - (now % 250));
  if (!$("secretsPane").hidden && document.querySelector("#secretList [data-exp]")) wait = Math.min(wait, 1000 - (now % 1000));
  if (wait < Infinity) clockTimer = setTimeout(() => { tick(); scheduleTick(); }, wait + 5);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S) tick(); scheduleTick(); });
