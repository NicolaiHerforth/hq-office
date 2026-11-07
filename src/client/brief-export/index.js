// EXPORT on a brief or a page (button.js): DOWNLOAD PDF and DOWNLOAD HTML, one file to send to someone without HQ
// Office. Opening the panel asks the server what the owner should read first (what looks like a key, what cannot go in),
// which is local work, and the buttons wait for that answer, so it is there before any file is. The server makes the file
// (src/server/brief-export.ts), which can take seconds for a PDF, then the browser fetches it as a plain download. A file
// the server holds back (made.hold: a PDF of a page still changing, an HTML file missing a script the page needs, which
// is known only once it has tried) does not start by itself: the panel says why, and the owner decides. While it is made the panel says so, a failure is said in the panel in words that say what to do,
// and SAVE THE FILE stays there in case the browser would not start the download on its own. What was made is kept per page
// until it is gone from the server or the page has changed since: EXPORT on that page asks, then shows it or starts over.
// Whatever arrives while its panel is not showing, a file or a failure, says so in a toast.
//
// On a touch screen nothing starts by itself. Mobile Safari shows a PDF in place of the page, whatever the headers or a
// download attribute say, which would take the owner off the HUD. There the owner's tap on SHARE THE FILE opens the
// system's sheet (Save to Files, Mail, Print), and SAVE THE FILE opens in a tab of its own. For a PDF that link has no
// download attribute: with one, Mobile Safari takes over the HUD's tab despite its target. The server's attachment header
// still makes it a download wherever the browser honours that. An HTML file keeps the attribute, which gets Safari's
// download prompt. The file is fetched before the button shows, because a share has to start inside the tap.
import { esc } from "../core/format.js";
import { post } from "../core/net.js";
import { on } from "../core/bus.js";
import { toast } from "../core/dom.js";
import { sheet, sheetMode } from "../core/sheet.js";

const FORMATS = { pdf: "PDF", html: "HTML" };
// Longer than the server takes to give up on a page that will not print (brief-export-print.ts). A browser with many of
// the HUD's tabs open can run out of connections, and this request then waits with nothing to say.
const ANSWER_MS = 3 * 60_000;
const NO_ANSWER = "No answer from HQ Office after 3 minutes, so this was stopped. If many HQ Office tabs are open, close some and try again.";
// A little under how long the server keeps a file (src/server/brief-export.ts).
const FILE_KEPT_MS = 9 * 60_000;
// The check reads only what is on this machine, so this is for a server that is not answering.
const CHECK_MS = 10_000;
const HOLD = { unfinished: "may be unfinished", missing: "is missing part of the page" };
const panel = document.createElement("div");
panel.className = "xpanel";
panel.hidden = true;
panel.setAttribute("role", "dialog");
panel.setAttribute("aria-label", "Export");

// Each page's export. phase: checking, choose, making, done, failed or refused (the check says no file can be made). notes: what the check said. made: the server's
// answer once there is a file. run: which ask this is the answer to.
let at = null, forPage = null; // the EXPORT button it hangs from, and what that button exports
const CHOOSE = { phase: "choose", format: null, notes: [], made: null, error: "" };
const pages = new Map();
let runs = 0;
const showing = (page) => !panel.hidden && forPage === page;
const set = (page, next) => {
  pages.set(page, next);
  if (showing(page)) { render(); place(); }
};

const touch = () => matchMedia("(pointer: coarse)").matches;
// The file as something the system can share, or null where it cannot (no Web Share, or not that type of file).
async function shareable(made) {
  if (!navigator.canShare) return null;
  try {
    const res = await fetch(made.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const blob = await res.blob();
    const file = new File([blob], made.name, { type: blob.type.split(";")[0] });
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

function render() {
  const state = pages.get(forPage) ?? CHOOSE;
  const { phase, format, made, error, notes } = state;
  const making = phase === "making", waiting = making || phase === "checking" || phase === "refused";
  const warnings = phase === "done" ? made.warnings ?? [] : notes;
  panel.innerHTML = `<div class="xrow">${Object.entries(FORMATS).map(([f, word]) => `<button class="btn-s xgo" type="button" data-export-as="${f}"${waiting ? " disabled" : ""}>${making && format === f ? `MAKING ${word}…` : `DOWNLOAD ${word}`}</button>`).join("")}</div>`
    + (phase === "failed" || phase === "refused" ? `<p class="xerr" role="alert">${esc(error)}</p>` : "")
    + (phase === "done" ? `<p class="xdone" role="status"><b>${esc(made.name)}</b> ${made.hold ? `${HOLD[made.hold]}. Read below before you save it.` : touch() ? "is ready." : "is in your downloads. If it is not there, use this button."}</p><div class="xrow${state.share ? "" : " xone"}">${state.share ? `<button class="btn-s xshare" type="button" data-export-share>${made.hold ? "SHARE THE FILE ANYWAY" : "SHARE THE FILE"}</button>` : ""}<a class="btn-s xsave" href="${esc(made.url)}"${touch() && format === "pdf" ? "" : ` download="${esc(made.name)}"`}${touch() ? ` target="_blank" rel="noopener"` : ""}>${made.hold ? "SAVE THE FILE ANYWAY" : "SAVE THE FILE"}</a></div>` : "")
    + (phase === "checking" ? `<p class="xnote" role="status">Checking what would go in the file…</p>` : "")
    + (warnings.length ? `<ul class="xwarn">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "")
    + `<p class="xnote">Only secret values HQ Office holds right now are masked, and only as usually written. Read the file before you send it.</p>`;
}
function place() {
  if (!at) return;
  // Its bar was drawn again (a room's brief, when its age ticks over): the same button, a new element.
  if (!at.isConnected) {
    const again = [...document.querySelectorAll("[data-export]")].find((b) => pageOf(b) === forPage);
    if (!again) { close(false); return; }
    at = again;
    at.setAttribute("aria-expanded", "true");
  }
  // In full screen only what is inside the full-screen element shows.
  const host = document.fullscreenElement ?? document.body;
  if (panel.parentElement !== host) host.append(panel);
  // On a phone it is a sheet, anchored by core/sheet.css.
  if (sheetMode()) { panel.style.left = panel.style.top = ""; return; }
  const r = at.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight, gap = 6, edge = 8;
  panel.style.left = `${Math.max(edge, Math.min(innerWidth - w - edge, r.right - w))}px`;
  const below = r.bottom + gap + h <= innerHeight - edge;
  panel.style.top = `${below ? r.bottom + gap : Math.max(edge, r.top - gap - h)}px`;
}
// A page laid out anew moves the button only once it has finished: a wide bar is drawn after the screen turned wide.
const placeSoon = () => requestAnimationFrame(() => requestAnimationFrame(() => { if (!panel.hidden) place(); }));
// Its bar drawn again while it is open: the panel follows the new button, whenever that happens.
const redrawn = new MutationObserver(() => { if (at && !at.isConnected) place(); });
const pageOf = (btn) => (btn.dataset.exportV ? `${btn.dataset.export}?v=${btn.dataset.exportV}` : btn.dataset.export);
function open(btn) {
  at = btn;
  forPage = pageOf(btn);
  btn.setAttribute("aria-expanded", "true");
  // Its file is being made, and it says so. One already made is offered only once the server says it still stands, and
  // anything else starts over.
  const was = pages.get(forPage), making = was?.phase === "making";
  const kept = was?.phase === "done" && Date.now() - was.madeAt < FILE_KEPT_MS;
  if (!making) pages.set(forPage, { ...CHOOSE, phase: "checking", run: ++runs });
  panel.hidden = false;
  render();
  place();
  redrawn.observe(document.body, { childList: true, subtree: true });
  const mine = pages.get(forPage).run;
  if (making) panel.querySelector("[data-export-as]")?.focus({ preventScroll: true });
  else if (kept) stillThere(forPage, was, mine);
  else check(forPage, mine);
}
// The server keeps only so many, and the page may have changed since: a file that no longer says what the page says is not
// handed over.
async function stillThere(page, was, mine) {
  const token = was.made.url.split("/")[2];
  let kept;
  try {
    ({ kept } = await Promise.race([post("/api/exports/kept", { token, page }), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), CHECK_MS))]));
  } catch {
    if (pages.get(page)?.run === mine) set(page, { ...CHOOSE, phase: "failed", error: "HQ Office is not answering, so this file cannot be checked or saved. Try again once it is back." });
    return;
  }
  if (pages.get(page)?.run !== mine) return;
  if (!kept) { check(page, mine); return; }
  set(page, was);
  if (showing(page)) panel.querySelector(".xshare, .xsave")?.focus({ preventScroll: true });
}
// The buttons wait for this. It cannot leave the owner stuck: if it fails, they open, and the panel says it could not check.
async function check(page, mine) {
  let notes, stop;
  try {
    ({ warnings: notes, stop } = await Promise.race([post("/api/exports/check", { page }), new Promise((_, no) => setTimeout(() => no(new Error("timed out")), CHECK_MS))]));
  } catch (err) {
    notes = [`This could not be checked (${err.message}), so nothing has looked for keys in it. Read the file before you send it.`];
  }
  const was = pages.get(page);
  if (was?.run !== mine) return;
  set(page, stop ? { ...was, phase: "refused", error: stop, notes: [] } : { ...was, phase: "choose", notes });
  if (showing(page)) panel.querySelector("[data-export-as]")?.focus({ preventScroll: true });
}
function close(giveFocusBack) {
  if (panel.hidden) return;
  panel.hidden = true;
  redrawn.disconnect();
  at?.setAttribute("aria-expanded", "false");
  if (giveFocusBack && at?.isConnected) at.focus({ preventScroll: true });
  at = null;
  forPage = null;
}
function download(made) {
  const a = document.createElement("a");
  a.href = made.url;
  a.download = made.name;
  panel.append(a); // in the panel, so its click is not a click outside
  a.click();
  a.remove();
}
async function make(format) {
  const page = pageOf(at), { notes } = pages.get(page) ?? CHOOSE, mine = ++runs;
  set(page, { ...CHOOSE, phase: "making", format, notes, run: mine });
  try {
    const made = await Promise.race([post("/api/exports", { page, format }), new Promise((_, no) => setTimeout(() => no(new Error(NO_ANSWER)), ANSWER_MS))]);
    const share = touch() ? await shareable(made) : null;
    if (!touch() && !made.hold) download(made);
    const done = { ...CHOOSE, phase: "done", format, made, share, madeAt: Date.now(), run: mine };
    set(page, done);
    // Kept as long as the server keeps it, a little under: then it is simply gone from this page.
    setTimeout(() => { if (pages.get(page) === done && !showing(page)) pages.delete(page); }, FILE_KEPT_MS);
    if (showing(page)) panel.querySelector(".xshare, .xsave")?.focus({ preventScroll: true });
    else toast(made.hold ? `${made.name} ${HOLD[made.hold]}: press EXPORT on it to read why and save it` : touch() ? `${made.name} is ready: press EXPORT on it to share or save it` : `${made.name} is in your downloads`);
  } catch (err) {
    if (!showing(page)) toast(err.message);
    set(page, { ...CHOOSE, phase: "failed", format, notes, error: err.message, run: mine });
  }
}
document.addEventListener("click", (e) => {
  const go = e.target.closest?.("[data-export-as]");
  if (go) { make(go.dataset.exportAs); return; }
  if (e.target.closest?.("[data-export-share]")) {
    navigator.share({ files: [pages.get(forPage).share] }).catch((err) => { if (err.name !== "AbortError") toast(err.message); });
    return;
  }
  const btn = e.target.closest?.("[data-export]");
  if (btn) { if (at === btn || (at && !at.isConnected && forPage === pageOf(btn))) close(true); else { close(false); open(btn); } return; }
  if (!panel.hidden && !panel.contains(e.target)) close(false);
});
sheet(panel, () => close(false));
// A sheet turned wide, or wide turned sheet: it is placed again once the class says which it is.
new MutationObserver(() => { if (!panel.hidden) { place(); placeSoon(); } }).observe(panel, { attributes: true, attributeFilter: ["class"] });
// On window, in capture: before a brief or a page takes Esc to close itself.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || panel.hidden) return;
  e.preventDefault();
  close(true);
}, true);
addEventListener("resize", () => { place(); placeSoon(); });
document.addEventListener("fullscreenchange", place);
// What it hung from went away (BACK, NEWER, another page).
on("nav", () => close(false));
