// MENU, top right: SECRETS (the panel over the stage), SETTINGS, SOUND, LAYOUT and THEME in one place. LAYOUT is
// each viewer's own choice, remembered in this browser: OFFICE (the default: the office takes the whole right column)
// or LANES BOARD (the board of every lane under the office, lanes/). It is set as data-layout on the root, which
// core/layout.css reads. THEME is each viewer's own too: SYSTEM (the default: the browser's light or dark, live),
// LIGHT or DARK, set as data-theme="light"|"dark" on the root (nothing for SYSTEM), which core/base.css reads; the
// page shell sets it before the first paint. A red dot on MENU when a restart lost a secret. Esc, a click elsewhere
// or a pick closes it; SOUND, LAYOUT and THEME leave it open so the change shows.
import { $ } from "../core/dom.js";
import { S } from "../core/state.js";
import { emit, on } from "../core/bus.js";
import { setText } from "../core/format.js";
import { liveSecrets, lostSecrets, openSecrets } from "../secrets/secrets.js";
import { sheet, sheetMode, sheetsNow } from "../core/sheet.js";
import { openTell } from "../tell/tell.js";

const KEY = "hq-layout";
export const LAYOUTS = ["office", "board"];
export let layout = (() => { try { const v = localStorage.getItem(KEY); return LAYOUTS.includes(v) ? v : "office"; } catch { return "office"; } })();

function applyLayout() {
  document.documentElement.dataset.layout = layout;
  for (const b of document.querySelectorAll("#menuDrop [data-layout]")) {
    const on = b.dataset.layout === layout;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}
export function setLayout(v) {
  if (!LAYOUTS.includes(v) || v === layout) return;
  layout = v;
  try { localStorage.setItem(KEY, v); } catch {}
  applyLayout();
  emit("layout", v);
}

const THEME_KEY = "hq-theme"; // also read by theme-first.js, before the first paint
export const THEMES = ["system", "light", "dark"];
export let theme = (() => { try { const v = localStorage.getItem(THEME_KEY); return THEMES.includes(v) ? v : "system"; } catch { return "system"; } })();

function applyTheme() {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const b of document.querySelectorAll("#menuDrop [data-set-theme]")) {
    const on = b.dataset.setTheme === theme;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
}
export function setTheme(v) {
  if (!THEMES.includes(v) || v === theme) return;
  theme = v;
  try { if (v === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch {}
  applyTheme();
  emit("theme", v);
}

const btn = $("menuBtn"), drop = $("menuDrop");
const isOpen = () => !drop.hidden;
function openMenu() {
  phoneRows();
  const subs = document.getElementById("menuSubs");
  if (subs) subs.hidden = !document.getElementById("subsBtn");
  drop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  drop.querySelector("[role^=menuitem]")?.focus();
}
function closeMenu(focusBack = false) {
  if (!isOpen()) return;
  drop.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  if (focusBack) btn.focus();
}
sheet(drop, () => closeMenu());
// What a phone keeps under the list, one tap once you are at the top of the page, where MENU is: TELL HQ, the office and
// SUBS. From inside a long list MENU itself is a scroll up. Only on a phone.
function phoneRows() {
  if (!sheetMode() || $("menuTell")) return;
  drop.insertAdjacentHTML("afterbegin", `<button class="mi" id="menuTell" type="button" role="menuitem">TELL HQ</button><button class="mi" id="menuOffice" type="button" role="menuitem">THE OFFICE</button><button class="mi" id="menuSubs" type="button" role="menuitem" hidden>SUBS</button>`);
}
// To the office and back: the place in the list is one tap away, not 30,000 px of scrolling.
let jumpBack = null;
function toOffice() {
  const y = scrollY, stage = document.querySelector(".stage");
  stage.scrollIntoView({ block: "start", behavior: "instant" });
  jumpBack?.remove();
  const b = (jumpBack = document.createElement("button"));
  b.className = "jumpback";
  b.type = "button";
  b.textContent = "▲ BACK";
  const gone = () => { b.remove(); removeEventListener("scroll", watch); };
  const watch = () => { if (stage.getBoundingClientRect().top > innerHeight) gone(); };
  b.addEventListener("click", () => { gone(); scrollTo({ top: y, behavior: "instant" }); });
  addEventListener("scroll", watch, { passive: true });
  document.body.append(b);
}
btn.addEventListener("click", () => (isOpen() ? closeMenu() : openMenu()));
drop.addEventListener("click", (e) => {
  const l = e.target.closest(".mseg [data-layout]");
  if (l) { setLayout(l.dataset.layout); return; }
  const t = e.target.closest(".mseg [data-set-theme]");
  if (t) { setTheme(t.dataset.setTheme); return; }
  // These two focus what is in them on this same click, which takes the page unlocked first.
  if (e.target.closest("#secretsBtn")) { closeMenu(); sheetsNow(); openSecrets(); return; }
  if (e.target.closest("#menuTell")) { closeMenu(); sheetsNow(); openTell(); return; }
  if (e.target.closest("#menuOffice")) { closeMenu(); setTimeout(toOffice); return; }
  if (e.target.closest("#menuSubs")) { closeMenu(); setTimeout(() => $("subsBtn").click()); return; }
});
// Before settings/panel.js opens its panel on the button's own listener: on a phone that sheet then takes this one's place.
drop.addEventListener("click", (e) => { if (e.target.closest("#settingsBtn")) closeMenu(); }, true);
document.addEventListener("click", (e) => { if (isOpen() && !e.target.closest(".menuwrap")) closeMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !isOpen()) return;
  e.preventDefault();
  closeMenu(true);
});

// SECRETS says how many are held and how many a restart lost; the dot on MENU says when one was lost.
function renderMenu() {
  if (!S) return;
  const live = liveSecrets().length, lost = lostSecrets().length;
  setText($("secretsSay"), [live ? `${live} held` : "none held", lost ? `${lost} LOST` : ""].filter(Boolean).join(" · "));
  $("secretsSay").classList.toggle("lost", !!lost);
  $("menuDot").hidden = !lost;
  btn.title = lost ? `${lost} secret${lost === 1 ? "" : "s"} lost in a restart: MENU › SECRETS` : "Secrets, settings, sound, layout and theme";
}
on("state", renderMenu);
applyLayout();
applyTheme();
emit("layout", layout); // the state may have come before this module: the board draws now if it is on
renderMenu();
