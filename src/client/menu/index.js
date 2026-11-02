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
btn.addEventListener("click", () => (isOpen() ? closeMenu() : openMenu()));
drop.addEventListener("click", (e) => {
  const l = e.target.closest(".mseg [data-layout]");
  if (l) { setLayout(l.dataset.layout); return; }
  const t = e.target.closest(".mseg [data-set-theme]");
  if (t) { setTheme(t.dataset.setTheme); return; }
  if (e.target.closest("#secretsBtn")) { closeMenu(); openSecrets(); return; }
  if (e.target.closest("#settingsBtn")) closeMenu(); // settings/panel.js opens the panel on the same click
});
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
