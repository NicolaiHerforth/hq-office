// The ask ledger on the question cards: an EDITED tag, the checklist (read-only ticks, PRs linked) and HQ's comments.
// The question panel draws the cards; this adds to them when the panel replaces them and when S.ledger changes,
// never on a timer. It also drops a picked option that an edit removed, so SEND cannot send it.
import { on } from "../core/bus.js";
import { $ } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { esc, setHTML, setText } from "../core/format.js";
import { md, mdInline } from "../core/markdown.js";
import { drafts } from "../questions/drafts.js";
import { renderBelow, renderHud } from "../questions/questions.js";

const SHOWN = 5; // the latest comments shown; MORE opens the older ones
const opened = new Set(); // ask ids whose older comments are open
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function itemHtml(i) {
  const text = mdInline(i.text);
  const repo = i.pr?.repo || CONFIG.githubRepo;
  // The text already links a #1234 in the default repo; any other PR gets its own link.
  const pr = i.pr && repo && !text.includes("<a ") ? ` <a class="lpr" href="https://github.com/${esc(repo)}/pull/${esc(i.pr.number)}" target="_blank" rel="noopener">#${esc(i.pr.number)}</a>` : "";
  const why = i.done ? (i.by === "github" ? "merged" : "done") : "open";
  return `<li class="${i.done ? "done" : ""}"><span class="ltick" role="img" aria-label="${why}">${i.done ? "✓" : ""}</span><span class="lt">${text}${pr}</span></li>`;
}

function commentsHtml(id, list) {
  const older = list.length - SHOWN;
  const all = opened.has(id);
  const shown = all || older <= 0 ? list : list.slice(-SHOWN);
  const more = older > 0 ? `<button class="lmore" type="button" data-ledger-more="${id}">${all ? "LESS" : `MORE (${older})`}</button>` : "";
  return `<div class="lcom">${more}${shown.map((c) => `<div class="lc"><span class="lat">${hhmm(c.at)}</span><div class="md inl">${md(c.text)}</div></div>`).join("")}</div>`;
}

function decorate() {
  const L = S?.ledger || {};
  let changed = false;
  for (const card of $("hud").querySelectorAll("article[data-ask]")) {
    const id = Number(card.dataset.ask), l = L[id];
    const meta = card.querySelector(".meta");
    let tag = meta.querySelector(".tag.edited");
    if (l?.editedAt) {
      if (!tag) { tag = document.createElement("span"); tag.className = "tag edited"; meta.insertBefore(tag, meta.querySelector(".due")); }
      setText(tag, `EDITED ${hhmm(l.editedAt)}`);
    } else tag?.remove();
    const html = l ? (l.items.length ? `<ul class="lchk">${l.items.map(itemHtml).join("")}</ul>` : "") + (l.comments.length ? commentsHtml(id, l.comments) : "") : "";
    let box = card.querySelector(":scope > .ledger");
    if (!html) { if (box) { box.remove(); changed = true; } continue; }
    if (!box) {
      box = document.createElement("div");
      box.className = "ledger";
      card.insertBefore(box, card.querySelector(":scope > .menu, :scope > .asksec, :scope > .reply"));
    }
    if (setHTML(box, html)) changed = true;
  }
  // Taller cards can push a question below the fold: the panel's pill must know.
  if (changed) renderBelow();
}

// The panel replaced its cards (new state, a picked option, MORE): add to the new ones.
new MutationObserver(decorate).observe($("hud"), { childList: true });

let seenLedger = null, seenOpen = null;
on("state", (S) => {
  if (S.open !== seenOpen) {
    seenOpen = S.open;
    let cleared = false;
    for (const a of S.open) {
      const d = drafts.get(a.id);
      if (d?.opt && !a.options.includes(d.opt)) { delete d.opt; cleared = true; }
    }
    if (cleared) renderHud();
  }
  if (S.ledger !== seenLedger) { seenLedger = S.ledger; decorate(); }
});
decorate(); // the cards and the state may have come before this module

$("hud").addEventListener("click", (e) => {
  const more = e.target.closest("[data-ledger-more]");
  if (!more) return;
  const id = Number(more.dataset.ledgerMore);
  if (opened.has(id)) opened.delete(id); else opened.add(id);
  decorate();
});
