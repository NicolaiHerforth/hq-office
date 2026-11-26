// MERGE (the tab; "ship" in the code): the PRs agents want the owner to merge (S.ship, docs/ship.md), as brief #211
// designed it. The answer first (how many are ready), who is idle until he merges and what is stuck with nobody
// moving, then a row per group: URGENT, a domain each (one button: MERGE N), LOW PRIORITY, CHECK THESE YOURSELF; DONE
// keeps the last 24 hours. A PR is one line; a PR that is fine says nothing about itself, one that is not his move
// says why where the button would be.
// One press on one PR is held by the server for five seconds (UNDO); a group and an unchecked PR ask first, in the
// column on a desktop and in the HUD's sheet on a phone. What he did stays where he did it until he leaves the tab,
// so nothing moves under the pointer. Only this page can merge: the routes refuse anything but the owner's browser.
// Off the tab only the counts on it are worked out: the list is empty and nothing here runs a timer.
import { on } from "../core/bus.js";
import { $, keepPlace, keepScroll, pageScrolls } from "../core/dom.js";
import { S } from "../core/state.js";
import { ago, clock, esc } from "../core/format.js";
import { mdClip, mdInline } from "../core/markdown.js";
import { post } from "../core/net.js";
import { pick, tagged } from "../core/scope.js";
import { floorTagHTML } from "../core/floors.js";
import { sheet, sheetMode } from "../core/sheet.js";
import { qTab, renderQTabs } from "../messages/messages.js";
import { morph } from "./morph.js";
import { counts, domainOf, groups, idle, idleOn, stuck, stuckOn, verdict } from "./model.js";

const box = $("ship"), readyTag = $("qtShipReady"), urgentTag = $("qtShipUrgent");
box.innerHTML = `<div class="mgs" aria-label="PRs to merge"></div>`;
const list = box.firstElementChild;
// The confirm lives beside the panes, so on a desktop it covers the column where he pressed.
const scrim = document.createElement("div"), cf = document.createElement("div");
scrim.className = "mscrim";
scrim.hidden = cf.hidden = true;
cf.className = "box mcf";
cf.tabIndex = -1;
cf.setAttribute("role", "dialog");
cf.setAttribute("aria-modal", "true");
cf.setAttribute("aria-labelledby", "mcfh");
box.after(scrim, cf);

const HOLD_MS = 5000; // the server's hold, for the bar under UNDO (HUD_SHIP_HOLD_MS)
// What takes a button's place under the pointer takes no press for its first GUARD_MS, so the second click of a double
// click, or the second tap of a double tap, lands on nothing: MERGE's UNDO does not take the merge back, UNDO's MERGE
// does not press it again, and a confirm that opened under the pointer is not answered by it. 600 ms is past the
// double-click time macOS and Windows use by default (500 ms) and a double tap; a deliberate UNDO is read and aimed
// first, and still has more than 4 s of the hold.
const GUARD_MS = 600;
const DAY = 24 * 3600_000, DONE_FIRST = 8;
// Groups he opened, kept in this browser. Every group starts folded: a domain is one row with one button.
const OPEN_KEY = "hq-merge-open";
const unfolded = (() => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]")); } catch { return new Set(); } })();
const saveOpen = () => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...unfolded])); } catch {} };

// What the page remembers while the tab is open. Leaving the tab forgets all of it but the folds and the holds,
// which are the server's.
const acted = new Map();   // id -> { it, verb }: what he pressed, as it was; a row that left SHIP stays in its place
const result = new Map();  // id -> "merged": a merge the server said went through, before the state says so
const errs = new Map();    // id -> why a press from this page failed
const local = new Map();   // id -> { verb, until, note, pending, undo }: a hold before the state carries it
const dropped = new Set(); // `${id}:${until}`: holds he took back, until the state forgets them
const late = new Map();    // id -> the server's words when UNDO came too late
const busy = new Set();    // ids in a merge request now
const running = new Map(); // group key -> how many its merge request holds
const failed = new Map();  // group key -> { n, moved }: how many of its last merge did not go through
const opened = new Set();  // PR rows opened
const flash = new Set();   // PRs pointed at (a name at the top was pressed), until the next press
const swapped = new Map(); // where -> when what is there last changed under the pointer: a PR's id, "cf" the confirm, "list" the list under it
let back = null;           // { id, text } while a SEND BACK box is open
// A group's confirm: listed, what it showed when it opened (id -> { it, sha }, in order); picked, what is ticked, with
// the head he saw (id -> sha). One unchecked PR's: { id, sha }. A confirm merges only what is picked, still ready and
// at the head he saw; what turned ready since shows as new and unticked.
let confirm = null;
const headMin = new Map(); // group key -> its head's tallest height while the tab is open: what is under it never moves up
const rowMin = new Map();  // PR id he acted on -> its row's tallest height since: merged or sent back, it pulls up nothing
let doneAll = false, sumMin = 0, bringUp = null, focusNext = null, looked = false, drawn = "", timer = 0;
let place = 0; // how far down the list was read: the pane's scrollTop on a desktop, the page's offset past its top on a phone

// The server's clock, for what is left of a hold: a hold's until is the server's time, and this device's clock may be
// off by any amount. base: the server's time and performance.now() when it came (S.shipNow on a push while a hold
// exists, now in a hold's or UNDO's answer); the device's clock only until one has come.
let base = null, shipNowSeen = null;
const heard = (now) => { if (Number.isFinite(now)) base = { server: now, at: performance.now() }; };
const serverNow = () => (base ? base.server + (performance.now() - base.at) : Date.now());

// Where each row stands, as last drawn: [{ key, label, one, items, cut }] (cut: the index of the first row under NOT
// READY YET). While he aims (the pointer moving over the list, or a touch or a key in it) a push changes what a row
// says but not where it stands: a new order waits until STILL_MS after the last of those, or until the pointer
// leaves, and a row that then moves takes no press for GUARD_MS. A PR that comes meanwhile waits with it.
const STILL_MS = 1500;
let arranged = null, stirred = -Infinity, thaw = 0;
const lastSeen = new Map(); // id -> the PR as last drawn: a row that left meanwhile keeps its place until then
const aiming = () => performance.now() - stirred < STILL_MS;
const cutOf = (items) => items.findIndex((it) => verdict(it).pile === "wait");
function arrange(fresh) {
  if (!arranged || !aiming()) return fresh.map((g) => ({ ...g, cut: g.one ? -1 : cutOf(g.items) }));
  const now = new Map(shown().map((it) => [it.id, it]));
  const out = arranged.map((g) => ({ ...g, items: g.items.map((it) => now.get(it.id) ?? lastSeen.get(it.id) ?? it) }));
  const same = (a, b) => a.length === b.length && a.every((g, i) => g.key === b[i].key && g.items.length === b[i].items.length && g.items.every((it, j) => it.id === b[i].items[j].id));
  if (!same(out, fresh)) { clearTimeout(thaw); thaw = setTimeout(render, stirred + STILL_MS - performance.now() + 20); }
  return out;
}
// While he aims no row gets shorter (steady: id -> its tallest height since he began), and the row under the pointer
// stays where it is when one above it grows.
const steady = new Map(), resized = new Set(); // resized: rows he opened or closed, which take their new height
let pointer = null; // [x, y] of the mouse over the list
const stir = (e) => { stirred = performance.now(); if (e.pointerType === "mouse") pointer = [e.clientX, e.clientY]; };
for (const k of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) list.addEventListener(k, stir, { passive: true });
// A list drawn again by his own press (a row or group opened or closed) moves what he meant to move: no guard for that.
let mine = false;
for (const k of ["click", "keydown", "submit"]) list.addEventListener(k, () => { mine = true; setTimeout(() => { mine = false; }); }, true);
list.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { stirred = -Infinity; pointer = null; render(); } });

const settling = (where) => performance.now() - (swapped.get(where) ?? -Infinity) < GUARD_MS;
const swap = (where) => swapped.set(where, performance.now());
const items = () => S?.ship?.items ?? [];
const byId = (id) => items().find((i) => i.id === id);
const doneOf = (id) => (S?.ship?.done ?? []).find((d) => d.id === id);
const live = () => pick(items());
// The live items, with each row he acted on that has left SHIP in its old place.
function shown() {
  const ids = new Set(items().map((i) => i.id)), out = [...items()];
  for (const [id, a] of acted) if (!ids.has(id)) out.push(a.it);
  return pick(out);
}
const holdOf = (it) => { const h = it.hold ?? local.get(it.id) ?? null; return h && !dropped.has(`${it.id}:${h.until}`) ? h : null; };

// Where a row is in its life, from the server's state and what he pressed here:
//   gone: it left SHIP by his press (merged, back) or merges by itself now (later); the row stays, quiet
//   held: pressed, and UNDO can still take it back; run: the hold is due, or a merge request holds it; {}: the rest
function lifeOf(it) {
  const now = byId(it.id), a = acted.get(it.id);
  if (!now) {
    const d = doneOf(it.id);
    // not in DONE and not his press: it was closed on GitHub (a row that waits for him to stop aiming)
    return { gone: d ? (d.how === "back" ? "back" : d.how === "self" ? "self" : "merged") : result.get(it.id) ?? (!a ? "closed" : a.verb === "back" ? "back" : "merged"), note: d?.note ?? null };
  }
  const h = holdOf(now);
  if (h) return serverNow() < h.until ? { held: h } : { run: h.verb, note: h.note };
  if (busy.has(it.id)) return { run: "merge" };
  if (a?.verb === "auto" && verdict(now).can === "queued") return { gone: "later" };
  return {};
}
const isLive = (it) => !!byId(it.id);
const free = (it) => { const l = lifeOf(it); return isLive(it) && !l.gone && !l.held && !l.run; };
// What a live PR is on its way to: held or running, it is no longer his to press, and is counted apart.
const going = (it) => { const l = lifeOf(it); return l.held?.verb ?? l.run ?? null; };
const GOING = [["merge", "merging"], ["auto", "to merge when checks pass"], ["back", "going back"]];
const goingSaid = (its) => GOING.map(([verb, say]) => { const n = its.filter((it) => going(it) === verb).length; return n ? `${n} ${say}` : ""; }).filter(Boolean);
const goingHTML = (its) => goingSaid(its).map((x) => `<span class="fl"> · ${x}</span>`).join("");
const readyOf = (g) => g.items.filter((it) => free(it) && verdict(it).pile === "ready");

const who = (it) => it.lane ?? it.filer ?? "HQ";
const laneOf = (name) => (S?.lanes ?? []).find((l) => l.name === name);
// Whether the one with the next move is moving: the HUD knows what each lane is doing.
function moving(it) {
  const l = it.lane && laneOf(it.lane);
  if (!l || l.status === "gone") return "";
  return l.status === "moving" ? ` ${esc(it.lane)} is working right now.` : ` ${esc(it.lane)} is idle, so it may not know.`;
}
// The one sentence an opened PR says about its state, from model.js's verdict.
const LONG = [
  [/^checks failing/, (w, m) => `<b>Its checks are failing.</b> ${w} has the next move.${m}`],
  [/^draft/, (w, m) => `<b>A draft.</b> ${w} is not done with it.${m}`],
  [/^conflicts with (.*)/, (w, m, x) => `<b>It conflicts with ${esc(x[1])}.</b> ${w} has to bring it up to date.${m}`],
  [/^changes requested/, (w, m) => `<b>A reviewer asked for changes.</b> ${w} has the next move.${m}`],
  [/^behind (.*)/, (w, m, x) => `<b>It is behind ${esc(x[1])}.</b> ${w} has to update it first.${m}`],
  [/^needs a review/, () => `<b>It needs an approving review</b> before the repo lets it merge. A review is given on GitHub.`],
  [/^blocked by branch rules/, () => `<b>The repo's branch rules block it.</b> GitHub says what is missing.`],
  [/^GitHub is still checking/, () => `<b>GitHub is still working out</b> whether it can merge. It shows up as ready when it knows.`],
  [/^GitHub could not be read/, () => `<b>GitHub could not be read for it.</b> It is read again in a few minutes.`],
  [/^not read from GitHub yet/, () => `<b>Not read from GitHub yet.</b> It shows up as ready or not once it is.`],
  [/^the repo allows no merge method/, () => `<b>The repo allows no merge method</b> this page can use.`],
  [/^already merged/, () => `<b>Already merged on GitHub.</b>`],
  [/^closed on GitHub/, () => `<b>Closed on GitHub.</b>`],
];
function long(it, v) {
  if (v.can === "merge") return `<b>Ready.</b> Its checks passed and nothing stops it.`;
  if (v.can === "check") return `<b>No checks ran on this one</b>, so nothing has tested it. It never merges with a group: only by its own button, and that asks first.`;
  if (v.can === "auto") return `<b>Its checks are still running.</b> You can say yes now, and it merges by itself once they pass.`;
  if (v.can === "queued") return `<b>It merges by itself when its checks pass.</b> The yes was given already, here or on GitHub. To take it back, turn off auto-merge on GitHub.`;
  if (v.why === "checks running") return it.mergeError ? `<b>Its checks are running again</b> on the new commits. It shows up as ready when they pass.` : `<b>Its checks are still running.</b> It shows up as ready when they pass.`;
  const w = esc(who(it)), m = moving(it);
  for (const [re, say] of LONG) { const x = re.exec(v.why); if (x) return say(w, m, x); }
  return `<b>${esc(v.why)}.</b>`;
}
const toneOf = (v) => (v.can === "merge" ? "ok" : v.can === "check" ? "wait" : v.tone);
const shortOf = (it, v) => (it.mergeError && v.why === "checks running" ? "new commits: checks running" : v.why);

// ---- drawing ----
const CK = `<span class="ck" aria-hidden="true">✓</span>`;
const sizeOf = (it) => `+${Number(it.gh?.additions) || 0} −${Number(it.gh?.deletions) || 0}`;
const age = (t, now) => `<span data-since="${t}" data-ago>${ago(now - t)}</span>`;
const titleOf = (it) => (it.gh?.title ? mdInline(it.gh.title, { links: false }) : `<i>${it.gh ? "untitled" : `${esc(it.repo)} #${it.number}`}</i>`);
const laneTag = (name) => (laneOf(name) ? `<button class="tag lane" type="button" data-select="${esc(name)}">${esc(name)}</button>` : `<span class="tag lane">${esc(name)}</span>`);
const HELD = { merge: "MERGING…", auto: "WILL MERGE WHEN CHECKS PASS…", back: "SENDING BACK…" };
const HELD_SHORT = { merge: "MERGING…", auto: "MERGES WHEN CHECKS PASS…", back: "SENDING…" };
// Past the hold UNDO is gone, and the words say why.
const RUN = { merge: "MERGING · CAN'T BE UNDONE", auto: "AUTO-MERGE GOING ON · TURN IT OFF ON GITHUB", back: "SENDING BACK · CAN'T BE UNDONE" };
const GONE = { merged: [`MERGED${CK}`, ""], self: [`MERGED BY ITSELF${CK}`, ""], later: [`MERGES BY ITSELF${CK}`, ""], back: ["SENT BACK", " back"], closed: ["CLOSED ON GITHUB", " back"] };

// The bar under UNDO runs out with the server's hold: a reload in those seconds shows what is left.
function undoHTML(h, short) {
  const left = Math.max(0, Math.min(HOLD_MS, h.until - serverNow()));
  return `<span class="doing" role="status">${(short ? HELD_SHORT : HELD)[h.verb]}</span><button class="btn-s undo" type="button" data-undo style="animation-delay:-${HOLD_MS - left}ms">UNDO</button>`;
}
const runHTML = (id, verb) => `<span class="doing" role="status">${late.has(id) ? esc(late.get(id)) : RUN[verb]}</span>`;
// UNDO stands in the row, or under it when the row is open (and on a row with its own button, only for SEND BACK).
const below = (it, one, l) => !!l.held && opened.has(it.id) && (!one || l.held.verb === "back");

// What stands at the right of a row: what he can do, or what stops it, or what was done.
function sideHTML(it, v, g, l) {
  const one = g.one;
  if (l.gone) { const [label, cls] = GONE[l.gone]; return `<span class="mark${cls}" role="status">${label}</span>`; }
  const size = `<span>${sizeOf(it)}</span><span class="age" title="Waiting since ${esc(new Date(it.at).toLocaleString())}">${age(it.at, Date.now())}</span>`;
  // in CHECK THESE YOURSELF the line under the title says "no checks ran" already
  const quiet = v.pile === "ready" && !one ? size : g.key === "check" ? "" : `<span class="why ${toneOf(v)}">${esc(shortOf(it, v))}</span>`;
  if (l.held) return below(it, one, l) ? quiet : `<span class="held">${undoHTML(l.held, true)}</span>`;
  if (l.run) return one ? runHTML(it.id, l.run) : quiet;
  const sorting = !it.sorted && S.ship?.sampler ? `<span class="tag sorting">SORTING</span>` : "";
  if (v.pile === "ready") return sorting + (one ? `<button class="send go" type="button" data-merge>MERGE</button>` : size);
  if (v.pile === "check") return sorting + `<button class="btn-s" type="button" data-ask>MERGE</button>`;
  if (one && v.can === "auto") return `<button class="btn-s two" type="button" data-later title="Its checks are still running">MERGE WHEN CHECKS PASS</button>`;
  return sorting + quiet;
}

function detailHTML(it, v, one, l) {
  const lane = `filed by ${laneTag(who(it))}${!l.gone && idleOn(it, S.lanes) ? ", idle until this merges" : ""}`;
  const files = Number(it.gh?.files) || 0;
  const acts = [];
  if (free(it)) {
    // a row with its own button does not repeat it here; a row in a domain gets it here
    if (!one && v.pile === "ready") acts.push(`<button class="send go" type="button" data-merge>MERGE</button>`);
    if (!one && v.can === "auto") acts.push(`<button class="btn-s" type="button" data-later>MERGE WHEN CHECKS PASS</button>`);
    if (back?.id !== it.id) acts.push(`<button class="btn-s backb" type="button" data-back title="Not like this: say why, and it goes back to ${esc(who(it))}">SEND BACK</button>`);
  }
  const form = back?.id === it.id && free(it) ? `<form data-backform autocomplete="off"><label for="mbk${it.id}">It leaves this list and goes back to ${esc(who(it))} with your note. It returns when ${esc(who(it))} files it again.</label>
      <textarea id="mbk${it.id}" rows="2" placeholder="What has to change first?">${esc(back.text)}</textarea>
      <button class="send go" type="submit" ${back.text.trim() ? "" : "disabled"}>SEND BACK</button><button class="btn-s" type="button" data-cancel>CANCEL</button></form>` : "";
  const goingBack = l.held?.verb === "back" || l.run === "back" || l.gone === "back";
  const said = l.held?.verb === "back" ? l.held.note : l.note;
  const state = l.gone === "merged" || l.gone === "self" ? `<div class="state ok"><b>Merged.</b> It is in DONE below, with its link to GitHub.</div>`
    : l.gone === "closed" ? `<div class="state"><b>Closed on GitHub.</b> It leaves this list once you stop pointing at it.</div>`
    : l.gone === "later" ? `<div class="state ok"><b>It merges by itself when its checks pass.</b> It goes to DONE then.</div>`
    : goingBack ? `<div class="state"><b>${l.gone ? "Sent back" : "Going back"} to ${esc(who(it))}.</b> It returns when ${esc(who(it))} files it again.</div>${said ? `<div class="note"><i>YOU SAID</i>${mdInline(said)}</div>` : ""}`
    : `<div class="state ${toneOf(v)}">${long(it, v)}</div>`;
  const err = !l.gone && (errs.get(it.id) || it.mergeError);
  const doing = below(it, one, l) ? `<span class="heldb">${undoHTML(l.held, false)}</span>` : l.run ? runHTML(it.id, l.run) : acts.join("");
  return `<div class="d">
      <div class="ref"><a href="${esc(it.url)}" target="_blank" rel="noopener" title="Open it on GitHub">${esc(it.repo)} #${it.number}<span class="ext" aria-hidden="true">↗</span></a><span>${lane}</span><span>${sizeOf(it)} in ${files} ${files === 1 ? "file" : "files"}, ${l.gone ? "waited" : "waiting"} ${age(it.at, Date.now())}</span></div>
      ${err ? `<div class="err" role="status">${esc(err)}</div>` : ""}
      ${state}
      ${it.note && !goingBack ? `<div class="note"><i>${esc(who(it).toUpperCase())} SAYS</i>${mdClip(it.note, `ship${it.id}`, 280)}</div>` : ""}
      ${form || `<div class="acts">${doing}</div>`}
    </div>`;
}

// A row keeps its lines through everything that happens to it: pressed, merged or sent back, it can still be opened,
// so nothing under the pointer moves and what was done can be read where it was done.
function rowHTML(it, g) {
  const v = verdict(it), l = lifeOf(it), open = opened.has(it.id), a = acted.get(it.id);
  // a row whose own button a press turns into UNDO keeps room for its tallest moment from the start (roomy; two: the
  // longer words of MERGE WHEN CHECKS PASS), so nothing under the pointer moves while it is held, runs and is done
  const two = v.can === "auto" || a?.verb === "auto", roomy = g.one && (v.pile !== "wait" || two);
  const lines = [];
  if (g.key === "urgent" && it.why) lines.push(`<div class="urg">${mdInline(it.why)}</div>`);
  if (g.key === "check") lines.push(`<div class="chk">no checks ran · ${esc(it.urgency === "LOW" ? "low priority" : domainOf(it))}</div>`);
  return `<div class="r ${l.gone ? "gone" : v.pile}${roomy ? ` roomy${two ? " two" : ""}` : ""}${open ? " open" : ""}${flash.has(it.id) ? " hl" : ""}" data-pr="${it.id}" data-k="p${it.id}" role="button" tabindex="0" aria-expanded="${open}"${rowMin.has(it.id) || steady.has(it.id) ? ` style="min-height:${Math.max(rowMin.get(it.id) ?? 0, steady.get(it.id) ?? 0)}px"` : ""}>${tagged() ? floorTagHTML(S, it.floor) : ""}
      <span class="caret c${open ? " o" : ""}" aria-hidden="true"></span><span class="t">${titleOf(it)}</span><span class="side">${sideHTML(it, v, g, l)}</span>
      ${lines.join("")}
      ${open ? detailHTML(it, v, g.one, l) : ""}
    </div>`;
}

function groupHTML(g) {
  const open = g.one || unfolded.has(g.key);
  const left = g.items.filter(isLive), ready = readyOf(g);
  const notReady = left.filter((it) => !going(it) && verdict(it).pile === "wait").length;
  const lanes = g.one ? [] : idle(left, S.lanes);
  const did = g.items.filter((it) => ["merged", "self"].includes(lifeOf(it).gone)).length, not = failed.get(g.key);
  let act = "";
  if (running.has(g.key)) act = `<span class="said" role="status">MERGING ${running.get(g.key)}…</span>`;
  else if (!g.one && ready.length) act = `<button class="send go" type="button" data-all aria-label="Merge the ${ready.length} ready in ${esc(g.label)}">MERGE ${ready.length}</button>`;
  else if (!g.one && did) act = `<span class="said ok" role="status">${did} MERGED${CK}</span>`;
  // the second line: how many are ready and not, what just happened, who is idle until they merge
  const say = [[ready.length ? `${ready.length} ready` : "", notReady ? `${notReady} not ready` : "", ...goingSaid(left)].filter(Boolean).join(", ")];
  if (ready.length && did) say.push(`<span class="okk">${did} merged</span>`);
  if (not) say.push(`<span class="bad">${not.n} not merged${not.moved === not.n ? ": new commits" : ""}</span>`);
  for (const { lane, count } of lanes) say.push(`<span class="tag lane">${esc(lane)}</span> idle until ${count} of these merge${count === 1 ? "s" : ""}`);
  const head = g.key === "urgent" ? `<div class="gh"><span class="name"><b>URGENT</b></span></div>`
    : g.key === "check" ? `<div class="gh"><span class="name"><b>CHECK THESE YOURSELF</b></span><span class="hint">Nothing has tested these. Each merges only by its own button, and that asks first.</span></div>`
    : `<button class="gh" type="button" data-fold aria-expanded="${open}"><span class="name"><span class="caret c${open ? " o" : ""}" aria-hidden="true"></span><b>${esc(g.label)}</b></span><span class="say">${say.filter(Boolean).join(" · ") || "nothing left here"}</span></button>`;
  let rows = "";
  if (open) {
    g.items.forEach((it, i) => {
      if (i === g.cut) rows += `<div class="sub">NOT READY YET · NOT YOUR MOVE</div>`;
      rows += rowHTML(it, g);
    });
  }
  const cls = g.key === "urgent" ? " gu one" : g.key === "check" ? " gc one" : g.key === "low" ? " low" : "";
  const min = headMin.get(g.key);
  return `<section class="g${cls}" data-g="${esc(g.key)}"><div class="ghwrap" data-k="g${esc(g.key)}"${min ? ` style="min-height:${min}px"` : ""}>${head}${act ? `<div class="act">${act}</div>` : ""}</div>${rows}</section>`;
}

// DONE: what left SHIP in the last 24 hours by a merge or a SEND BACK, by day, each with its time and its link.
function doneHTML(now) {
  const open = unfolded.has("done");
  const all = pick(S.ship?.done ?? []).filter((d) => now - d.at < DAY).sort((a, b) => b.at - a.at);
  const today = new Date(now).toDateString(), dayOf = (d) => (new Date(d.at).toDateString() === today ? "TODAY" : "YESTERDAY");
  const count = (xs) => { const m = xs.filter((x) => x.how !== "back").length, b = xs.length - m; return [m ? `${m} merged` : "", b ? `${b} sent back` : ""].filter(Boolean).join(", "); };
  const t = all.filter((d) => dayOf(d) === "TODAY"), y = all.filter((d) => dayOf(d) !== "TODAY");
  const say = [t.length ? `Today: ${count(t)}` : "", y.length ? `${t.length ? "yesterday" : "Yesterday"}: ${count(y)}` : ""].filter(Boolean).join(" · ") || "Nothing in the last 24 hours";
  let rows = "";
  if (open) {
    let day = null;
    for (const d of doneAll ? all : all.slice(0, DONE_FIRST)) {
      if (dayOf(d) !== day) rows += `<div class="sub">${(day = dayOf(d))}</div>`;
      const mark = d.how === "back" ? `<span class="mark back">SENT BACK</span>` : `<span class="mark">${d.how === "self" ? "MERGED BY ITSELF" : "MERGED"}</span>`;
      rows += `<div class="dr" data-k="d${d.id}-${d.at}"><span class="t">${d.title ? mdInline(d.title, { links: false }) : `${esc(d.repo)} #${d.number}`}</span>${mark}<span class="m"><a href="${esc(d.url)}" target="_blank" rel="noopener" title="Open it on GitHub: a merge is reverted there">${esc(d.repo)} #${d.number}<span class="ext" aria-hidden="true">↗</span></a> · ${esc(clock(d.at))}${d.how === "back" && d.note ? ` · you said: “${mdInline(d.note, { links: false })}”` : ""}</span></div>`;
    }
    if (!doneAll && all.length > DONE_FIRST) rows += `<div class="dmore"><button class="btn-s" type="button" data-doneall>SHOW ${all.length - DONE_FIRST} MORE</button></div>`;
  }
  return `<section class="g done" data-g="done"><div class="ghwrap" data-k="gdone"><button class="gh" type="button" data-fold aria-expanded="${open}"><span class="name"><span class="caret c${open ? " o" : ""}" aria-hidden="true"></span><b>DONE</b></span><span class="say">${say}</span></button></div>${rows}</section>`;
}

// Who is idle until he merges, and on how many: each name takes him to them.
function idleHTML(open) {
  const lanes = idle(open, S.lanes);
  if (!lanes.length) return "";
  const one = (lane, n) => `<button class="idler" type="button" data-jump="${esc(lane)}" title="${esc(lane)} is idle until ${n} of its PRs merge${n === 1 ? "s" : ""}: show ${n === 1 ? "it" : "them"}" aria-label="${esc(lane)} is idle until ${n} of its PRs merge: show them"><span class="tag lane">${esc(lane)}</span><span>${n}</span><span class="go" aria-hidden="true">↓</span></button>`;
  return `<div class="idle"><span>Idle until you merge:</span>${lanes.map(({ lane, count }) => one(lane, count)).join("")}</div>`;
}
// Stuck, nobody moving: each idle lane with the next move, and the reviews; each takes him to those PRs.
function stuckHTML(open) {
  const s = stuck(open, S.lanes);
  if (!s.lanes.length && !s.review) return "";
  const them = (n) => (n === 1 ? "it" : "them");
  const lane = ({ lane, count }) => `<button class="idler" type="button" data-stuck="lane" data-lane="${esc(lane)}" title="${esc(lane)} has the next move on ${count} and is idle: show ${them(count)}"><span class="tag lane">${esc(lane)}</span><span>${count}</span><span class="go" aria-hidden="true">↓</span></button>`;
  const review = s.review ? `<button class="idler" type="button" data-stuck="review" title="Show ${them(s.review)}"><span>${s.review} ${s.review === 1 ? "needs" : "need"} a review on GitHub</span><span class="go" aria-hidden="true">↓</span></button>` : "";
  return `<div class="idle stuck"><span>Stuck, nobody moving:</span>${s.lanes.map(lane).join("")}${review}</div>`;
}
// What is not ready and who has its next move, in words: "an agent, a reviewer or a check".
const MOVER = { lane: "an agent", review: "a reviewer", checks: "a check", github: "GitHub" };
function notReady(open, n) {
  if (!n) return "";
  const moves = new Set(open.map(verdict).filter((v) => v.pile === "wait").map((v) => v.move));
  const who = Object.keys(MOVER).filter((m) => moves.has(m)).map((m) => MOVER[m]);
  const has = who.length > 1 ? `${who.slice(0, -1).join(", ")} or ${who.at(-1)}` : who[0];
  return `${n} ${n === 1 ? "is" : "are"} not ready${has ? `: ${has} has the next move` : ""}.`;
}
// open: what is his to press (nothing held or running); all: every live PR, for what is on its way.
function sumHTML(open, all) {
  const c = counts(open), rest = notReady(open, c.wait), st = stuckHTML(open), fl = goingHTML(all);
  const min = sumMin ? ` style="min-height:${sumMin}px"` : "";
  if (c.ready) return `<div class="sum"${min}><span class="n">${c.ready}</span><span class="k">READY TO MERGE${fl}</span><span class="of">${c.check ? `<button class="lnk" type="button" data-goto="check">${c.check} more to check yourself ↓</button> ` : ""}${rest || (c.check ? "" : "That is all of them.")}</span>${idleHTML(open)}${st}</div>`;
  if (c.check) return `<div class="sum check"${min}><span class="n">${c.check}</span><span class="k">LEFT TO CHECK YOURSELF${fl}</span><span class="of">Everything that passed its checks is merged. <button class="lnk" type="button" data-goto="check">Show them ↓</button> ${rest}</span>${idleHTML(open)}${st}</div>`;
  // nothing to merge, and something stuck: it waits on someone, maybe on him, so the page does not say it waits on nobody
  if (st) return `<div class="sum clear stuck"${min}><span class="n">0</span><span class="k">NOTHING TO MERGE${fl}</span><span class="of">${rest}</span>${st}</div>`;
  const of = rest || (items().length || S.ship?.done?.length ? "Every PR your agents filed is merged or sent back." : "When HQ or a lane files a PR for you with <code>hud ship</code>, it waits here.");
  return `<div class="sum clear"${min}><span class="n">${CK}</span><span class="k">NOTHING HERE WAITS ON YOU${fl}</span><span class="of">${of}</span></div>`;
}

function confirmHTML(gs) {
  if (!confirm || qTab !== "ship") return "";
  if (confirm.id) {
    const it = byId(confirm.id);
    if (!it || !free(it)) return "";
    const files = Number(it.gh?.files) || 0, moved = it.gh?.sha !== confirm.sha;
    return `<h3 id="mcfh">MERGE THIS ONE UNCHECKED?</h3>
      <ul><li class="alone"><label><span>${titleOf(it)}</span><small>${sizeOf(it)} in ${files} ${files === 1 ? "file" : "files"}</small></label></li></ul>
      <div class="rest warn">${moved ? "New commits came in since this opened, so it does not merge from here. Close this and look at it again." : "No checks ran on it, so nothing has tested it. Once it is merged, it can only be reverted on GitHub."}</div>
      <div class="acts"><button class="btn-s" type="button" data-no>NOT NOW</button><button class="btn-s danger" type="button" data-yes ${moved ? "disabled" : ""}>MERGE IT</button></div>`;
  }
  const g = gs.find((x) => x.key === confirm.key);
  if (!g) return "";
  const lines = confirmLines(g), go = lines.filter((l) => l.goes);
  const n = go.length, out = lines.filter((l) => l.can && !l.picked && !l.fresh).length;
  const wait = g.items.filter((it) => isLive(it) && !going(it) && verdict(it).pile === "wait").length;
  const moved = lines.filter((l) => l.moved).length, gone = lines.filter((l) => !l.can && !l.moved).length;
  const rest = [out ? `${out} you left out` : "", moved ? `${moved} with new commits` : "", gone ? `${gone} no longer ready` : "", wait ? `${wait} not ready` : ""].filter(Boolean).join(", ");
  const tag = (l) => (l.moved ? "NEW COMMITS · LEFT OUT" : !l.can ? "NOT READY NOW · LEFT OUT" : l.fresh ? "NEW" : "");
  const li = (l) => `<li class="${l.goes ? "" : l.fresh && l.can ? "fresh" : "out"}" data-k="l${l.it.id}"><label><input type="checkbox" data-pick="${l.it.id}" ${l.goes ? "checked" : ""} ${l.can && !l.moved ? "" : "disabled"}><span>${titleOf(l.it)}</span><small>${tag(l) ? `<b class="lt">${tag(l)}</b>` : sizeOf(l.it)}</small></label></li>`;
  return `<h3 id="mcfh">MERGE ${n === 1 ? "THIS 1" : `THESE ${n}`} IN ${esc(g.label.toUpperCase())}?</h3>
      <ul>${lines.map(li).join("")}</ul>
      <div class="rest">${n ? `${n === 1 ? "It has" : n === lines.length ? `All ${n} have` : `These ${n} have`} passed ${n === 1 ? "its" : "their"} checks.` : "Nothing is ticked."}${rest ? ` Staying behind: ${rest}.` : ""}${lines.length > 1 ? " Untick a line to leave it out." : ""}${lines.some((l) => l.fresh) ? " A line marked NEW turned ready while this was open: tick it to take it too." : ""} Once merged, ${n === 1 ? "it" : "they"} can only be reverted on GitHub.</div>
      <div class="acts"><button class="btn-s" type="button" data-no>NOT NOW</button><button class="send go" type="button" data-yes ${n ? "" : "disabled"}>MERGE ${n}</button></div>`;
}
// The lines of a group's confirm: what it listed, then what turned ready since. can: still his to merge; moved: its
// head is not the one he saw; picked: ticked; goes: MERGE N takes it, at sha.
function confirmLines(g) {
  const c = confirm, ready = readyOf(g);
  const line = (it, fresh) => {
    const now = byId(it.id), sha = c.picked.get(it.id) ?? (fresh ? null : c.listed.get(it.id).sha);
    const can = !!now && free(now) && verdict(now).pile === "ready", moved = can && sha != null && now.gh?.sha !== sha;
    const picked = c.picked.has(it.id);
    return { it: now ?? it, fresh, can, moved, picked, goes: can && !moved && picked, sha };
  };
  return [...[...c.listed.values()].map((x) => line(x.it, false)), ...ready.filter((it) => !c.listed.has(it.id)).map((it) => line(it, true))];
}
function openConfirm(key) {
  const g = arranged?.find((x) => x.key === key), ready = g ? readyOf(g) : [];
  confirm = { key, listed: new Map(ready.map((it) => [it.id, { it, sha: it.gh?.sha ?? null }])), picked: new Map(ready.map((it) => [it.id, it.gh?.sha ?? null])) };
}

// The tab's count is the number at the top of the list: what is ready (green), or, when none is, what is left to
// check (amber); "!n" for urgent ones he can still act on, an outline so only NEEDS YOU has solid red.
function renderCounts(c) {
  let moved = false;
  const set = (el, n, text, title, cls) => {
    if (el.hidden === !n && el.textContent === text && el.className === cls) return;
    Object.assign(el, { hidden: !n, textContent: text, title, className: cls });
    moved = true;
  };
  set(readyTag, c.ready || c.check, String(c.ready || c.check), c.ready ? `${c.ready} ready to merge` : `${c.check} left to check yourself`, `tag ${c.ready ? "mready" : "mcheck"}`);
  set(urgentTag, c.urgent, `!${c.urgent}`, `${c.urgent} urgent`, "tag murgent");
  if (moved) renderQTabs(); // the tabs fit themselves again
}

// What had the focus in the list, said so it can be found again after the list is built anew.
function focusKey() {
  const a = document.activeElement;
  if (!a || !list.contains(a) || a.closest("[data-backform]")) return null;
  const row = a.closest("[data-pr]"), g = a.closest("[data-g]");
  const own = [...a.attributes].find((x) => x.name.startsWith("data-") && !["data-pr", "data-k"].includes(x.name));
  const base = row ? `[data-pr="${row.dataset.pr}"]` : g ? `[data-g="${CSS.escape(g.dataset.g)}"]` : "";
  return a === row ? base : own && base ? `${base} [${own.name}${own.value ? `="${CSS.escape(own.value)}"` : ""}]` : null;
}

function render() {
  if (!S) return;
  if (S.shipNow != null && S.shipNow !== shipNowSeen) heard((shipNowSeen = S.shipNow));
  const all = live(), open = all.filter((it) => !going(it));
  renderCounts(counts(open));
  // Off the tab the list is empty, so nothing in it keeps the page clock awake.
  if (qTab !== "ship") { looked = false; clearTimeout(timer); if (drawn !== "") morph(list, (drawn = "")); drawConfirm([]); return; }
  if (!looked) { looked = true; post("/api/ship/look", {}).catch(() => {}); } // the server reads GitHub at most every 30 s
  const now = Date.now(), at = serverNow();
  for (const [id, h] of local) if (!h.pending && (byId(id)?.hold || !byId(id) || at > h.until + 3000)) local.delete(id);
  for (const k of dropped) { const [id, until] = k.split(":").map(Number); if (byId(id)?.hold?.until !== until) dropped.delete(k); }
  for (const id of late.keys()) if (!byId(id)?.hold) late.delete(id);
  // a merge from here that did not go through opens its row, so the reason shows where he pressed
  for (const [id] of acted) { const it = byId(id); if (it?.mergeError && !it.hold && !errs.has(id)) { errs.set(id, it.mergeError); opened.add(id); } }
  if (back && !free(byId(back.id) ?? { id: back.id })) back = null;
  if (aiming()) { for (const r of list.querySelectorAll("[data-pr]")) { const id = Number(r.dataset.pr); if (!resized.has(id)) steady.set(id, Math.max(steady.get(id) ?? 0, r.offsetHeight)); } }
  else steady.clear();
  resized.clear();
  const gs = (arranged = arrange(groups(shown())));
  lastSeen.clear();
  for (const g of gs) for (const it of g.items) lastSeen.set(it.id, it);
  // S.shipRead moves only when a read changed something: the foot says that much and no more.
  const read = S.shipRead ? `Last change read from GitHub ${age(S.shipRead, now)} ago.` : "Nothing read from GitHub yet.";
  const html = sumHTML(open, all) + gs.map(groupHTML).join("") + doneHTML(now) + `<div class="foot">${read}</div>`;
  // the moment a hold runs out, the row is drawn again: UNDO becomes MERGING…
  clearTimeout(timer);
  const next = Math.min(...items().map((it) => holdOf(it)?.until ?? Infinity).filter((u) => u > at));
  if (next < Infinity) timer = setTimeout(render, next - at + 30);
  const typing = document.activeElement?.closest?.("[data-backform]") ? document.activeElement.selectionStart : null;
  let was = focusNext;
  if (html !== drawn) {
    was ??= focusKey();
    const keep = bringUp ? () => {} : pageScrolls() ? keepPlace(box, "data-k") : keepScroll(list, "data-k");
    const tops = new Map([...list.querySelectorAll("[data-pr], [data-g] > .ghwrap")].map((e) => [e, e.getBoundingClientRect().top]));
    const under = aiming() && pointer ? document.elementFromPoint(...pointer)?.closest("#ship [data-pr], #ship .ghwrap") : null;
    morph(list, (drawn = html));
    keep();
    if (under?.isConnected) { const d = under.getBoundingClientRect().top - tops.get(under); if (Math.abs(d) > 0.5) { if (pageScrolls()) scrollBy(0, d); else list.scrollTop += d; } }
    // what moved under the pointer takes no press for GUARD_MS
    if (!mine) for (const [e, top] of tops) if (e.isConnected && Math.abs(e.getBoundingClientRect().top - top) > 1) swap(e.dataset.pr ? Number(e.dataset.pr) : `g:${e.parentElement.dataset.g}`);
    sumMin = Math.max(sumMin, Math.round(list.querySelector(".sum")?.getBoundingClientRect().height ?? 0));
    for (const h of list.querySelectorAll(".g:not(.done) > .ghwrap")) { const k = h.parentElement.dataset.g; headMin.set(k, Math.max(headMin.get(k) ?? 0, h.offsetHeight)); }
    for (const id of rowMin.keys()) if (!acted.has(id)) rowMin.delete(id);
    for (const id of acted.keys()) { const r = list.querySelector(`[data-pr="${id}"]`); if (r) rowMin.set(id, Math.max(rowMin.get(id) ?? 0, r.offsetHeight)); }
  }
  focusNext = null;
  drawConfirm(gs);
  const field = list.querySelector("[data-backform] textarea");
  if (field && (was === "back" || (typing != null && document.activeElement !== field))) { field.focus({ preventScroll: was !== "back" }); const at = typing ?? field.value.length; field.setSelectionRange(at, at); }
  else if (was && was !== "back" && cf.hidden) list.querySelector(was)?.focus({ preventScroll: true });
  // a name at the top was pressed: the first PR it means comes to the middle; a group just opened comes into view when
  // it is not
  if (bringUp) {
    const el = list.querySelector(bringUp.id != null ? `[data-pr="${bringUp.id}"]` : `[data-g="${CSS.escape(bringUp.key)}"]`);
    if (el && bringUp.id != null) el.scrollIntoView({ block: "center" });
    else if (el) {
      const r = el.getBoundingClientRect(), port = pageScrolls() ? { top: $("qtabs").getBoundingClientRect().bottom, bottom: innerHeight } : list.getBoundingClientRect();
      if (r.top < port.top || Math.min(r.bottom, r.top + 220) > port.bottom) el.scrollIntoView({ block: "start" });
    }
    bringUp = null;
  }
}

// The confirm: beside the list on a desktop, the HUD's sheet on a phone (core/sheet.js: the scrim, Esc and Back).
let cfKey = null, cfDrawn = "";
function drawConfirm(gs) {
  const html = confirmHTML(gs);
  if (!html) confirm = null;
  const key = confirm ? confirm.key ?? `pr${confirm.id}` : null;
  if (html !== cfDrawn) morph(cf, (cfDrawn = html));
  scrim.hidden = cf.hidden = !html;
  if (key === cfKey) return;
  cfKey = key;
  // the confirm takes the focus, not its green button: Enter merges nothing by accident
  if (key && !sheetMode()) cf.focus({ preventScroll: true });
}
// on a phone the sheet closes it: a tap outside, or Back
sheet(cf, () => closeConfirm(true));
// pressed: a press closed it, so the list comes back under the pointer
function closeConfirm(pressed) {
  const c = confirm;
  if (!c) return;
  confirm = null;
  if (pressed) swap("list");
  focusNext = c.key ? `[data-g="${CSS.escape(c.key)}"] [data-all]` : `[data-pr="${c.id}"]`;
  render();
}

// ---- what the buttons do ----
// A press sent to the server, and what came back: { data } its answer, { refused } the server said no and why, or
// { lost } no answer that can be read (the network, a timeout, a reply that is not the server's), so the press may
// have been taken. MS: how long an answer may take.
async function send(path, body, ms) {
  let res, data = null;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body), signal: ms ? AbortSignal.timeout(ms) : undefined });
    data = await res.json();
  } catch { return { lost: true }; }
  if (res.ok) return { data };
  return res.status < 500 && data?.error ? { refused: String(data.error) } : { lost: true };
}
const LOOKING = "May have gone through: looking again.", UNREACHED = "May have gone through: the server cannot be reached now. This row shows what happened once it can.";
// What the server holds now, for a press whose answer was lost: S.ship as the server has it, or null.
const shipNow = () => fetch("/api/state").then((r) => r.json()).then((s) => s.ship ?? null).catch(() => null);
// What became of a press on IT whose answer was lost, from the server's state: still there and held, gone (merged,
// sent back), or still there and not held. A state that cannot be read says so, and the next push shows the rest.
function lookedAt(ship, id) {
  if (!ship) return "unknown";
  const now = ship.items.find((x) => x.id === id);
  if (!now) { const d = ship.done.find((x) => x.id === id); return d ? (d.how === "back" ? "back" : "merged") : "gone"; }
  return now.hold ? { hold: now.hold } : now.mergeError ? { error: now.mergeError } : "open";
}
async function hold(it, verb, note) {
  swap(it.id);
  acted.set(it.id, { it, verb });
  errs.delete(it.id);
  local.set(it.id, { verb, note: note ?? null, until: serverNow() + HOLD_MS, pending: true });
  render();
  const notDone = (why) => {
    local.delete(it.id);
    acted.delete(it.id);
    errs.set(it.id, `Not done: ${why}`);
    opened.add(it.id);
    if (verb === "back") back = { id: it.id, text: note };
  };
  const a = await send(`/api/ship/${it.id}/hold`, { verb, sha: it.gh?.sha ?? null, ...(note ? { note } : {}) }, 10_000);
  let until = a.data?.until;
  heard(a.data?.now);
  if (a.refused) notDone(a.refused);
  else if (a.lost) {
    errs.set(it.id, LOOKING);
    opened.add(it.id);
    render();
    const was = lookedAt(await shipNow(), it.id);
    errs.delete(it.id);
    if (was.hold) until = was.hold.until;
    else if (was === "merged" || was === "back") { local.delete(it.id); result.set(it.id, was); }
    else if (was === "unknown") { local.delete(it.id); errs.set(it.id, UNREACHED); }
    else notDone(was === "gone" ? "it was closed on GitHub." : was.error ?? "the press did not reach the server.");
  }
  if (until != null) {
    const h = local.get(it.id);
    local.set(it.id, { verb, note: note ?? null, until });
    if (h?.undo) { render(); undo(it.id); return; }
  }
  render();
}
async function undo(id) {
  const it = byId(id), h = it && holdOf(it);
  if (!h) return;
  swap(id);
  if (h.pending) { h.undo = true; return; } // the hold's answer comes first; UNDO follows it
  dropped.add(`${id}:${h.until}`);
  local.delete(id);
  render();
  try {
    const r = await post(`/api/ship/${id}/undo`, {});
    heard(r.now);
    if (r.undone) {
      acted.delete(id);
      if (h.verb === "back") { back = { id, text: h.note ?? "" }; opened.add(id); focusNext = "back"; } else focusNext = `[data-pr="${id}"]`;
    } else {
      dropped.delete(`${id}:${h.until}`);
      const why = String(r.why || "it is running now");
      late.set(id, `${why[0].toUpperCase()}${why.slice(1)}${/[.!]$/.test(why) ? "" : "."}`);
    }
  } catch (err) {
    dropped.delete(`${id}:${h.until}`);
    late.set(id, `UNDO did not reach the server: ${err.message}`);
  }
  render();
}
// A group's MERGE N after the confirm, or one unchecked PR after its own: one request, merged one at a time. It says
// which ("group" or "one"): the server keeps a group's rules for a group of one.
// go: [{ it, sha }], each with the head he saw.
async function mergeNow(sent, key) {
  const go = sent.map((x) => x.it);
  for (const it of go) { busy.add(it.id); acted.set(it.id, { it, verb: "merge" }); errs.delete(it.id); }
  if (key) { running.set(key, go.length); failed.delete(key); }
  render();
  let results = [];
  const a = await send("/api/ship/merge", { kind: key ? "group" : "one", items: sent.map(({ it, sha }) => ({ id: it.id, sha })) });
  if (a.data) results = a.data.results ?? [];
  else if (a.refused) results = go.map((it) => ({ id: it.id, ok: false, error: a.refused }));
  else {
    for (const it of go) errs.set(it.id, LOOKING);
    render();
    const ship = await shipNow();
    for (const it of go) errs.delete(it.id);
    results = go.map((it) => {
      const was = lookedAt(ship, it.id);
      return was === "merged" ? { id: it.id, ok: true } : { id: it.id, ok: false, error: was.error ?? (was === "unknown" ? UNREACHED : "the answer was lost, and the server has it open still.") };
    });
  }
  const said = new Map(results.map((r) => [r.id, r]));
  let n = 0, moved = 0;
  for (const it of go) {
    busy.delete(it.id);
    const r = said.get(it.id);
    if (r?.ok) { result.set(it.id, "merged"); continue; }
    n++;
    const why = r?.error || "the server did not say";
    if (/new commits/i.test(why)) moved++;
    errs.set(it.id, /^(not merged|may have gone)/i.test(why) ? why : `Not merged: ${why}`);
    acted.delete(it.id);
    if (!key) opened.add(it.id);
  }
  if (key) { running.delete(key); if (n) failed.set(key, { n, moved }); }
  render();
}
// A name at the top, the reviews, or "to check yourself": open every group the PRs meant are in, bring the first into
// view and point at them, until the next press.
function point(ids) {
  const gs = groups(shown()).filter((g) => g.items.some((it) => ids.includes(it.id)));
  if (!gs.length) return;
  for (const g of gs) if (!g.one) unfolded.add(g.key);
  saveOpen();
  flash.clear();
  for (const id of ids) flash.add(id);
  bringUp = { key: gs[0].key, id: gs[0].items.find((it) => ids.includes(it.id)).id };
  render();
}
// The PRs a name at the top means.
function meant(d) {
  if (d.jump) return (it) => idleOn(it, S.lanes) === d.jump;
  if (d.stuck === "review") return (it) => stuckOn(it, S.lanes) === "review";
  if (d.stuck) return (it) => stuckOn(it, S.lanes) === "lane" && it.lane === d.lane;
  return (it) => verdict(it).pile === "check";
}

list.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-select], a[href], .more")) return; // a lane's drawer, GitHub, MORE: not this list's
  const pointed = flash.size > 0;
  const name = t.closest("[data-jump], [data-stuck], [data-goto]");
  if (name) { const its = meant(name.dataset); point(shown().filter((it) => isLive(it) && its(it)).map((it) => it.id)); return; }
  if (pointed) flash.clear(); // the next press ends the pointing
  const group = t.closest("[data-g]");
  if (!group) { if (pointed) render(); return; }
  if (t.closest("[data-doneall]")) { doneAll = true; render(); return; }
  if (t.closest("[data-all]")) { if (!settling("list") && !settling(`g:${group.dataset.g}`)) { openConfirm(group.dataset.g); swap("cf"); render(); } return; }
  if (t.closest("[data-fold]")) {
    const k = group.dataset.g;
    if (unfolded.has(k)) unfolded.delete(k); else { unfolded.add(k); bringUp = { key: k }; }
    saveOpen();
    render();
    return;
  }
  const row = t.closest("[data-pr]"), id = row && Number(row.dataset.pr), it = row && (byId(id) ?? acted.get(id)?.it);
  if (!it) { if (pointed) render(); return; }
  if (t.closest("[data-undo], [data-merge], [data-later], [data-ask], [data-back], [data-backform] .send") && (settling(it.id) || settling("list"))) { e.preventDefault(); return; }
  if (t.closest("[data-undo]")) { undo(it.id); return; }
  const can = free(it);
  if (can && t.closest("[data-merge]")) hold(it, "merge");
  else if (can && t.closest("[data-later]")) hold(it, "auto");
  else if (can && t.closest("[data-ask]")) { confirm = { id: it.id, sha: it.gh?.sha ?? null }; swap("cf"); render(); }
  else if (can && t.closest("[data-back]")) { back = { id: it.id, text: "" }; focusNext = "back"; render(); }
  else if (t.closest("[data-cancel]")) { swap(it.id); back = null; focusNext = `[data-pr="${it.id}"] [data-back]`; render(); }
  else if (!t.closest(".d") && !t.closest("button")) {
    if (opened.has(it.id)) opened.delete(it.id); else opened.add(it.id);
    rowMin.delete(it.id); // he opened or closed it: it takes its new height
    steady.delete(it.id);
    resized.add(it.id);
    if (back?.id === it.id) back = null;
    focusNext = `[data-pr="${it.id}"]`;
    render();
  } else if (pointed) render();
});
list.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.closest("[data-backform]")) { e.stopPropagation(); const id = back?.id; back = null; focusNext = `[data-pr="${id}"] [data-back]`; render(); return; }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.closest("[data-backform]")) { e.preventDefault(); e.target.closest("form").requestSubmit(); return; }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches(".r[data-pr]")) { e.preventDefault(); e.target.click(); }
});
list.addEventListener("submit", (e) => {
  e.preventDefault();
  const it = back && byId(back.id), text = back?.text.trim();
  if (it && text) { back = null; hold(it, "back", text); }
});
list.addEventListener("input", (e) => {
  const f = e.target.closest("[data-backform]");
  if (!f || !back) return;
  back.text = e.target.value;
  f.querySelector(".send").disabled = !back.text.trim();
});
cf.addEventListener("click", (e) => {
  if (e.target.closest("[data-no]")) { closeConfirm(true); return; }
  if (!e.target.closest("[data-yes]") || !confirm) return;
  const c = confirm, g = c.key && arranged?.find((x) => x.key === c.key);
  const go = c.id ? [byId(c.id)].filter((it) => it && free(it) && it.gh?.sha === c.sha).map((it) => ({ it, sha: c.sha })) : g ? confirmLines(g).filter((l) => l.goes).map((l) => ({ it: l.it, sha: l.sha })) : [];
  confirm = null;
  swap("list");
  focusNext = c.key ? `[data-g="${CSS.escape(c.key)}"] [data-fold]` : `[data-pr="${c.id}"]`;
  if (go.length) mergeNow(go, c.key ?? null); else render();
});
cf.addEventListener("change", (e) => {
  const tick = e.target.closest("[data-pick]");
  if (!tick || !confirm?.picked) return;
  const id = Number(tick.dataset.pick);
  if (tick.checked) confirm.picked.set(id, byId(id)?.gh?.sha ?? null); else confirm.picked.delete(id);
  render();
});
scrim.addEventListener("click", () => closeConfirm(true));
// A confirm that just opened under the pointer takes no click on its lines, its buttons or (on a desktop) its scrim:
// the second click of a double click on MERGE N must not answer it, untick a line or close it. On a phone a tap
// outside the sheet still closes it at once, as every sheet does; closing merges nothing.
addEventListener("click", (e) => { if (confirm && settling("cf") && (cf.contains(e.target) || e.target === scrim)) { e.preventDefault(); e.stopPropagation(); } }, true);
// Esc closes the confirm on a desktop; on a phone the sheet hears it first.
addEventListener("keydown", (e) => { if (e.key === "Escape" && confirm && !sheetMode()) { e.stopPropagation(); e.preventDefault(); closeConfirm(); } }, true);
// MORE and LESS on a note: core/clicks.js has changed what is open by now.
document.addEventListener("click", (e) => { const m = e.target.closest?.("#ship .more[data-more]"); if (m) { const id = Number(m.closest("[data-pr]")?.dataset.pr); rowMin.delete(id); steady.delete(id); resized.add(id); render(); } });

// The list's place, kept while another tab shows. Read as he scrolls: when the tab changes the pane is hidden already.
list.addEventListener("scroll", () => { if (!box.hidden && !pageScrolls()) place = list.scrollTop; }, { passive: true });
addEventListener("scroll", () => { if (!box.hidden && pageScrolls() && list.childElementCount) place = Math.max(0, -box.getBoundingClientRect().top); }, { passive: true });
on("qtab", (t) => {
  if (t !== "ship") {
    for (const m of [acted, result, errs, late, opened, flash, failed, headMin, rowMin]) m.clear();
    back = confirm = arranged = null;
    lastSeen.clear();
    sumMin = 0;
    doneAll = false;
    render();
    return;
  }
  render();
  if (!pageScrolls()) { list.scrollTop = place; return; }
  // setQTab moves the page to the tabs after this returns; the way back to where the list was comes after that.
  const y = place;
  queueMicrotask(() => { if (y > 0) scrollBy(0, box.getBoundingClientRect().top + y); });
});

on("state", render);
// Another floor, or SHOW ALL: an open confirm listed what was in view, so it closes.
on("scope", () => { confirm = arranged = null; render(); });
render(); // the state may have come before this module
