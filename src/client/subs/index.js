// SUBS, in the top bar next to MACHINES: one square per subscription, colored by its tighter window, and how many
// have room (N OK). It opens a dropdown (closing like MENU's) with each sub's 5-hour and weekly room and when each
// resets, most room first. Closes on Esc and on a click elsewhere. With no source anywhere it is not in the page.
// The numbers are what the agents last reported (src/server/sub-usage.ts); the page counts the resets down itself.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { on } from "../core/bus.js";
import { ago, dur, esc, setClass, setHTML } from "../core/format.js";
import { sheet, sheetMode } from "../core/sheet.js";

// Left at or above ROOM is room; under LOW is all but spent.
const ROOM = 25, LOW = 10;

const wrap = document.createElement("div");
wrap.className = "subswrap";
wrap.innerHTML = `<button class="box health subsbtn" id="subsBtn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="subsDrop"></button><div class="box subsdrop" id="subsDrop" role="dialog" aria-label="Subscription usage" hidden></div>`;
const btn = wrap.querySelector("#subsBtn"), drop = wrap.querySelector("#subsDrop");

const isOpen = () => !drop.hidden;
// The dropdown never covers an open question. Side by side (desktop) it ends short of the question column; stacked
// (narrow) it opens in the page under the question panel, over Tell HQ and the office, so nothing above it moves.
const stacked = matchMedia("(max-width: 1150px)");
function place() {
  const q = document.querySelector(".qwrap")?.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  for (const k of ["--subs-max", "top", "left", "width"]) drop.style.removeProperty(k);
  if (!q || sheetMode()) return;
  if (stacked.matches) {
    drop.style.top = `${Math.max(w.height + 6, q.bottom - w.top + 8)}px`;
    drop.style.left = `${8 - w.left}px`;
    drop.style.width = `${document.documentElement.clientWidth - 16}px`;
  } else if (q.right < w.right) drop.style.setProperty("--subs-max", `${w.right - q.right - 14}px`);
}
addEventListener("resize", () => isOpen() && place());
// The stacked layout can switch after the resize event has run (a phone turned): place it again then.
stacked.addEventListener?.("change", () => isOpen() && place());
function openSubs() {
  drop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  render();
  // Stacked, under a long question panel it can start below the screen: the page scrolls just enough to show its head.
  const top = drop.getBoundingClientRect().top;
  if (stacked.matches && !sheetMode() && top > innerHeight - 160) scrollBy({ top: top - innerHeight + 260 });
}
sheet(drop, () => closeSubs());
function closeSubs(focusBack = false) {
  if (!isOpen()) return;
  drop.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  clearTimeout(soon);
  if (focusBack) btn.focus();
}
btn.addEventListener("click", () => (isOpen() ? closeSubs() : openSubs()));
document.addEventListener("click", (e) => { if (isOpen() && !e.target.closest(".subswrap")) closeSubs(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !isOpen()) return;
  e.preventDefault();
  closeSubs(true);
});

// A window past its reset is full again, as far as anyone knows: RESET, not a number.
const isReset = (w, now) => w && w.resetsAt !== null && w.resetsAt <= now;
function roomOf(s, now) {
  const left = [s.fiveHour, s.weekly].filter(Boolean).map((w) => (isReset(w, now) ? 100 : w.left));
  return left.length ? Math.min(...left) : null;
}
const level = (left) => (left === null ? "none" : left >= ROOM ? "" : left >= LOW ? "off" : "bad");
const pct = (n) => `${Math.round(n)}%`;

function windowRow(label, w, missing, now) {
  if (!w) return `<div class="sw none"><span class="swk">${label}</span><span class="swv">${missing}</span></div>`;
  if (isReset(w, now)) return `<div class="sw"><span class="swk">${label}</span><span class="bar"><i style="width:100%"></i></span><span class="swv"><b>RESET</b> ${ago(now - w.resetsAt)} ago</span></div>`;
  const resets = w.resetsAt === null ? "" : ` · resets in ${dur(w.resetsAt - now)}`;
  return `<div class="sw ${level(w.left)}"><span class="swk">${label}</span><span class="bar"><i style="width:${w.left}%"></i></span><span class="swv"><b>${pct(w.left)}</b> left${resets}</span></div>`;
}

function subRow(s, now) {
  const on = s.activeOn.length ? `ON ${s.activeOn.map((m) => esc(m.toUpperCase())).join(", ")}` : "PARKED";
  const plan = s.plan ? `<span class="splan">${esc(s.plan.toUpperCase())}</span>` : "";
  const no5h = s.provider === "codex" ? "no 5-hour limit reported" : "no reading";
  return `<div class="srow"><div class="shead"><i class="${level(roomOf(s, now))}"></i><b>${esc(s.name)}</b>${plan}<span class="son">${on}</span></div>${windowRow("5H", s.fiveHour, no5h, now)}${windowRow("WEEK", s.weekly, "no reading", now)}<div class="sage">as of ${ago(now - s.asOf)} ago</div></div>`;
}

const SAY = { ok: "", none: "no source", unreachable: "unreachable" };
function sourcesLine(sources) {
  const quiet = sources.filter((m) => m.claude !== "ok" || m.codex !== "ok");
  if (!quiet.length) return "";
  const say = (name, v) => (v === "ok" ? `${name} ok` : `${name} ${SAY[v] ?? v}`);
  return `<div class="ssrc">${quiet.map((m) => `<span>${esc(m.machine.toUpperCase())}: ${say("CLAUDE", m.claude)} · ${say("CODEX", m.codex)}</span>`).join("")}</div>`;
}

// The next moment something shown changes by itself: a window resets (the squares) or, while open, a minute passes.
let soon = 0;
function wakeFor(list, now) {
  clearTimeout(soon);
  const resets = list.flatMap((s) => [s.fiveHour, s.weekly]).filter((w) => w && w.resetsAt > now).map((w) => w.resetsAt - now);
  const next = Math.min(isOpen() ? 30_000 : Infinity, ...resets);
  if (Number.isFinite(next)) soon = setTimeout(render, Math.min(next + 500, 2 ** 31 - 1));
}

function render() {
  const list = S?.subs?.list ?? [];
  // In the page only while there is something to show: with no source anywhere, the page is as it was without SUBS.
  if (!list.length) {
    closeSubs();
    wrap.remove();
    clearTimeout(soon);
    return;
  }
  if (!wrap.isConnected) $("machines").before(wrap);
  const now = Date.now();
  const rooms = list.map((s) => roomOf(s, now));
  const withRoom = rooms.filter((r) => r !== null && r >= ROOM).length;
  setClass(btn, "box health subsbtn" + (withRoom ? "" : " bad"));
  const tip = list.map((s, i) => `${s.name}${s.activeOn.length ? ` (on ${s.activeOn.join(", ")})` : ""}: ${rooms[i] === null ? "no reading" : `${pct(rooms[i])} left on its tighter window`}`).join("\n");
  if (btn.title !== tip) btn.title = tip;
  setHTML(btn, `<span class="k">SUBS</span><span class="v">${rooms.map((r) => `<i class="${level(r)}"></i>`).join("")}${withRoom} OK</span>`);
  if (isOpen()) place();
  if (isOpen()) setHTML(drop, `<div class="stitle">SUBSCRIPTIONS <small>most room first</small></div>${list.map((s) => subRow(s, now)).join("")}${sourcesLine(S.subs.sources ?? [])}`);
  wakeFor(list, now);
}

on("state", render);
render();
