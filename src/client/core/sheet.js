// One sheet on a phone: every panel that opens over the page is this one thing. Anchored at the foot of the screen, a
// scrim behind it that closes it, the page locked under it so neither a tap nor the keyboard reaches what is behind, and
// Back or Esc closes it. The focus goes in when it opens and back when it closes. A feature keeps opening and closing its
// panel as it always has and registers it once: sheet(el, close), which returns the way to unregister it. Above the phone
// sizes nothing changes. The look is in core/sheet.css, on the class this adds while one is open. A dead page stops the
// question panel, so a sheet with no box never holds the page: following a link closes every sheet, and one that loses
// its box, whatever took it, stops counting and is told to close.
import { on } from "./bus.js";

const PHONE = "(max-width: 799px), (max-width: 1150px) and (pointer: coarse)";
const phone = matchMedia(PHONE);
export const sheetMode = () => phone.matches;

const all = [];
let stack = [];
// Made when the first sheet opens: above the phone sizes the page holds nothing extra.
let scrim = null;
function makeScrim() {
  scrim = document.createElement("div");
  scrim.className = "sheetbg";
  scrim.addEventListener("click", () => stack.at(-1)?.close());
}
// A closed sheet takes its Back entry with it: the app's own BACK goes by the entry before it, and Back is never a dead
// press. It steps back only from the entry it was set on: a timer can land after the page navigated, or after Back came
// back to this kind of entry and is going on by itself, and a step more then leaves the app. Two closes before the timer
// runs still take one step: popstate goes on from there, and a second one here would leave the app too.
let dropping = false;
const dropEntry = () => {
  const entry = history.state;
  if (!entry?.hqSheet || dropping) return;
  dropping = true;
  setTimeout(() => { dropping = false; if (!stack.length && history.state === entry) history.back(); }, 0);
};

// What is behind the top sheet takes no keyboard: everything beside the path from it up to the body, worked out from
// where it is now, and again if it moves. A native modal dialog looks after itself and stays usable over a sheet.
const shut = new Set();
const moved = new MutationObserver(() => sync());
function shutOut(top) {
  moved.disconnect();
  const out = new Set();
  for (let n = top?.el; n && n !== document.body; n = n.parentElement) {
    moved.observe(n.parentElement, { childList: true });
    for (const k of n.parentElement.children) if (k !== n && k !== scrim && k.tagName !== "DIALOG") out.add(k);
  }
  for (const e of shut) if (!out.has(e)) { e.inert = false; shut.delete(e); }
  for (const e of out) if (!e.inert) { e.inert = true; shut.add(e); }
}
// Who had the focus before a sheet: a panel focuses what is in it as it opens, before sync sees it open.
let before = null;
addEventListener("focusin", (e) => { if (!all.some((s) => !stack.includes(s) && s.el.contains(e.target))) before = e.target; });
// Leaving for nothing forgets it, unless it left because it is being built again.
addEventListener("focusout", (e) => { if (!e.relatedTarget) queueMicrotask(() => { if (e.target.isConnected && before === e.target) before = null; }); });
// What opened a sheet may be built again while it is open (a row of the lanes board is): the same button then takes the focus.
const sameAs = (e) => e.tagName.toLowerCase() + [...e.attributes].filter((a) => a.name === "id" || a.name.startsWith("data-")).map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
function moveFocus(top, was, gone, came) {
  for (const s of came) {
    const from = gone.find((g) => g.el.contains(before));
    s.back = from ? from.back : before;
    s.again = from ? from.again : before && sameAs(before);
  }
  for (const s of gone.toReversed()) {
    const at = document.activeElement, to = s.back?.isConnected ? s.back : s.again && document.querySelector(s.again);
    if ((at === document.body || s.el.contains(at)) && to && !to.closest("[inert]")) to.focus({ preventScroll: true });
    if (s.tabbed) s.el.removeAttribute("tabindex");
    s.back = s.again = s.tabbed = null;
  }
  if (!top || top === was || top.el.contains(document.activeElement)) return;
  if (!top.el.hasAttribute("tabindex")) { top.el.tabIndex = -1; top.tabbed = true; }
  top.el.focus({ preventScroll: true });
}

// Attached or not, hidden itself or by anything above it: no box means nobody can see it or close it. The observer hears
// a box go whatever took it, a stylesheet's rule on a far parent too. It acts just after: moving the page from inside
// the observer's own step is a loop the browser reports as an error.
const hasBox = (s) => s.el.getClientRects().length > 0;
const boxes = new ResizeObserver(() => { if (stack.some((s) => !hasBox(s))) setTimeout(sync); });

function sync() {
  const was = stack.at(-1);
  const open = phone.matches ? all.filter((s) => s.isOpen() && hasBox(s)) : [];
  const gone = stack.filter((s) => !open.includes(s));
  const came = open.filter((s) => !stack.includes(s));
  const kept = stack.filter((s) => open.includes(s));
  stack = [...kept, ...came];
  boxes.disconnect();
  for (const s of stack) boxes.observe(s.el);
  for (const s of all) s.el.classList.toggle("sheet", stack.includes(s));
  stack.forEach((s, i) => { s.el.style.zIndex = String(61 + 2 * i); });
  for (const s of gone) { s.el.classList.remove("sheet"); s.el.style.removeProperty("z-index"); }
  document.documentElement.classList.toggle("sheetopen", stack.length > 0);
  const top = stack.at(-1);
  if (top && !scrim) makeScrim();
  if (scrim) scrim.hidden = !top;
  if (top) {
    if (scrim.nextElementSibling !== top.el) top.el.before(scrim); // the same stacking context as the sheet, wherever it lives
    scrim.style.zIndex = String(60 + 2 * (stack.length - 1));
  }
  shutOut(top);
  moveFocus(top, was, gone, came);
  // A sheet that takes the place of one closing, or of one whose entry is still there, keeps that Back entry: closing it
  // is one step back. A real stack of sheets still steps back twice, and Playwright's WebKit crashes on a reload after
  // that, on a bare page too; whether Safari does is unproven.
  let spare = fromBack ? 0 : Math.max(gone.length, !kept.length && history.state?.hqSheet ? 1 : 0);
  for (const s of came) {
    // Going back to this entry must not put the page where it was when the sheet opened: something may have moved it on purpose.
    history.scrollRestoration = "manual";
    if (spare-- > 0) continue;
    history.pushState({ ...history.state, hqSheet: true }, "");
  }
  if (gone.length && !fromBack && !leaving) dropEntry();
  // Lost its box and still says it is open: told last, so it does not come back with whatever hid it. Closing may sync again.
  if (phone.matches) for (const s of gone) if (all.includes(s) && s.isOpen()) s.close();
}

// The address moved, so what it points at is behind any sheet: they all go, on this tap. A move that replaced the step
// keeps the sheet's entry under the new address, which is no sheet's any more. Then again, once the views have followed.
on("nav", () => {
  if (!stack.length) return;
  for (const s of stack.toReversed()) s.close();
  if (history.state?.hqSheet) { const { hqSheet, ...rest } = history.state; history.replaceState(rest, ""); }
  queueMicrotask(sync);
});

let fromBack = false, leaving = false;
addEventListener("popstate", (e) => {
  if (!phone.matches) return;
  const top = stack.at(-1);
  if (top) { fromBack = true; top.close(); sync(); fromBack = false; }
  if (!stack.length && e.state?.hqSheet) history.back(); // an entry a sheet left behind: Back goes on to what is under it
});
// A panel that closes and hands over to another in one go says so: until the page is unlocked, what the next panel
// focuses cannot take the focus.
export const sheetsNow = () => sync();
// Esc closes the sheet on top before what is behind it hears the key. A native dialog over it takes its own Esc, and an
// input method its own too: Esc cancelling a dead key closes nothing. Safari ends the composition first, and says 229.
addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length || document.querySelector("dialog[open]")) return;
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  stack.at(-1).close();
}, true);
// Turning wide closes a sheet without going back: a traversal now could cancel a navigation under way.
phone.addEventListener?.("change", () => { leaving = !phone.matches; sync(); leaving = false; });

// isOpen defaults to "not hidden"; a panel that shows itself by a class says how. A panel may register before it is
// attached: what ends a registration is calling what this returns, never leaving the page.
export function sheet(el, close, isOpen = () => !el.hidden) {
  const s = { el, close, isOpen };
  all.push(s);
  const seen = new MutationObserver(sync);
  seen.observe(el, { attributes: true, attributeFilter: ["hidden", "class"] });
  sync();
  return () => {
    if (!all.includes(s)) return;
    all.splice(all.indexOf(s), 1);
    seen.disconnect();
    sync();
  };
}

// A question before something that cannot be undone. Resolves true or false; closing the sheet any other way is no, and
// so is asking something else: there is one question at a time.
let asking = null;
export function ask({ text, yes, no = "KEEP IT", danger = true }) {
  asking?.(false);
  return new Promise((done) => {
    const box = document.createElement("div");
    box.className = "box confirm";
    box.setAttribute("role", "alertdialog");
    const say = document.createElement("p");
    say.textContent = text;
    const acts = document.createElement("div");
    acts.className = "confirmacts";
    const button = (label, cls, answer) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn-s ${cls}`;
      b.textContent = label;
      b.addEventListener("click", () => finish(answer));
      return b;
    };
    const keep = button(no, "confirmno", false);
    acts.append(keep, button(yes, danger ? "confirmyes danger" : "confirmyes", true));
    box.append(say, acts);
    let ended = false;
    const finish = (answer) => {
      if (ended) return;
      ended = true;
      asking = null;
      removeEventListener("keydown", onKey, true);
      box.hidden = true;
      off();
      box.remove();
      done(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } };
    addEventListener("keydown", onKey, true);
    document.body.append(box);
    const off = sheet(box, () => finish(false));
    asking = finish;
    if (phone.matches) keep.focus({ preventScroll: true });
  });
}
