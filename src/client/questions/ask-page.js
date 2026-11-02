// An ask's HTML page in its NEEDS YOU card (src/server/ask-pages.ts): a sandboxed frame below the title and above the
// answer row, no taller than the page and never over the cap (questions.css), with OPEN to the stage (#page/asks/ID).
// On a phone the card shows a strip instead, and while the ask is on the stage its card shows that and the stage has
// the answer row. The frame cannot answer: it runs in an opaque origin, and the HUD takes from it only its height.
import { on } from "../core/bus.js";
import { esc } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { themedSrc } from "../pages/theme.js";

// No allow-modals: an alert in a card would stop the whole HUD. No fullscreen either: OPEN gives the page the stage.
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms";

// The ask whose page is on the stage, or null: what the page view says it shows (pages/index.js), not the address, which
// BACK clears without a hashchange.
let staged = null;
export const stagedAsk = () => staged;
export function onStage(fn) {
  on("page:stage", (p) => {
    const id = p?.ask ?? null;
    if (id === staged) return;
    staged = id;
    fn();
  });
}
const SMALL = matchMedia("(max-width: 640px)");
export const onSmall = (fn) => SMALL.addEventListener("change", fn);

// What goes between the card's text and its answer row: a slot the frame is put in (fillFrames), or a strip.
export function pageSlotHTML(a, p, staged) {
  const strip = (what) => `<a class="askstrip" href="#page/asks/${a.id}"><span class="sk">${what}</span><span class="st">${mdInline(p.title || "Page", { links: false })}${p.lead && !staged ? ` <i>${mdInline(p.lead, { links: false })}</i>` : ""}</span><span class="btn-s">${staged ? "ON THE STAGE" : "OPEN ▶"}</span></a>`;
  if (staged || SMALL.matches) return strip("PAGE");
  return `<div class="askpage" data-askframe="${esc(`/asks/${a.id}.html?at=${p.at}`)}" data-ask-id="${a.id}"></div>`;
}

// The card's frames outlive a rebuild of the list: each is moved aside before and back into its new slot after, with
// moveBefore, which keeps a frame's document running. Where a browser has no moveBefore, the frame loads again.
const holder = document.createElement("div");
holder.hidden = true;
document.body.append(holder);
const heights = new Map(); // a frame's src -> the page's height, as it last said
const canMove = typeof holder.moveBefore === "function";

export function holdFrames(list) {
  if (!canMove) return;
  for (const f of list.querySelectorAll("iframe.askframe")) holder.moveBefore(f, null);
}
export function fillFrames(list) {
  for (const slot of list.querySelectorAll("[data-askframe]")) {
    if (slot.firstElementChild) continue;
    const src = slot.dataset.askframe;
    let f = [...holder.children].find((x) => x.dataset.src === src);
    if (!f) {
      f = document.createElement("iframe");
      f.className = "pageframe askframe";
      f.dataset.src = src;
      f.setAttribute("sandbox", SANDBOX);
      f.setAttribute("allow", "clipboard-write");
      f.setAttribute("referrerpolicy", "no-referrer");
      f.title = `The page of question #${slot.dataset.askId}`;
      f.src = themedSrc(src);
      if (heights.has(src)) f.style.setProperty("--fh", `${heights.get(src)}px`);
      slot.append(f);
    } else slot.moveBefore(f, null);
  }
  for (const f of [...holder.children]) f.remove();
}

// A page says how tall it is (ask-pages.ts adds the few lines that do); only a card's own frame is heard, and only a
// number is taken from it.
addEventListener("message", (e) => {
  const h = e.data?.["hud-ask-height"];
  if (e.origin !== "null" || typeof h !== "number" || !Number.isFinite(h)) return;
  const f = [...document.querySelectorAll("iframe.askframe")].find((x) => x.contentWindow === e.source);
  if (!f) return;
  const px = Math.max(40, Math.min(4000, Math.ceil(h)));
  heights.set(f.dataset.src, px);
  f.style.setProperty("--fh", `${px}px`);
});
