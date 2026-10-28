// The SETTINGS panel.
import { $, toast } from "../core/dom.js";
import { post } from "../core/net.js";
import { clock, esc } from "../core/format.js";
import { CONFIG, S } from "../core/state.js";
import { HEROES } from "../room/palette.js";
import { DEFAULTS, PERFORMANCE_CHOICES, changeSettings, resetSettings, settings } from "./prefs.js";
import { on } from "../core/bus.js";
import { SEASONS, chosenSeason, setSeason } from "../room/seasons.js";
import { ACCESSORIES } from "../room/accessory-table.js";
import { wornCache } from "../room/accessories.js";
import { THEMES, THEME_CHOICES } from "../room/themes.js";
import { floorsRow } from "./floors.js";

// SETTINGS opens a panel of choices. Each choice has a default, and RESET puts them all back.
const SETTING_OPTIONS = {
  hero: HEROES.map((h) => h.name),
  season: ["auto", ...SEASONS],
  hat: ["auto", "none", ...ACCESSORIES.filter((a) => a.slot === "head").map((a) => a.id)],
  performance: PERFORMANCE_CHOICES,
  theme: THEME_CHOICES,
};
const SETTING_TITLES = { hero: "HERO", season: "SEASON", hat: "HERO HAT", performance: "PERFORMANCE", theme: "LEVEL THEME" };
// SMOOTH: everything moves at 30 frames a second. BALANCED: walking at 10, small motions on a slow beat.
// POWER SAVER: only walking workers move; an idle room shows no new frames.
const PERFORMANCE_LABELS = { smooth: "SMOOTH", balanced: "BALANCED", saver: "POWER SAVER" };
// The default hero is labelled with the owner's name (HUD_OWNER), or YOU.
const label = (key, v) => (key === "hero" && v === DEFAULTS.hero ? CONFIG.owner.trim() || v : key === "performance" ? PERFORMANCE_LABELS[v] : key === "theme" ? THEMES[v].label : v).toUpperCase();
function renderSettings() {
  const row = (key) => `<div class="srow"><span class="k">${SETTING_TITLES[key]}</span><div class="opts2">${SETTING_OPTIONS[key].map((v) =>
    `<button class="btn-s ${settings[key] === v ? "on" : ""}" type="button" data-set="${key}" data-val="${esc(v)}">${esc(label(key, v))}</button>`).join("")}</div></div>`;
  // With two or more floors, FLOORS comes first: it is what the owner opens SETTINGS for most.
  const floorsFirst = (S?.floors?.length ?? 0) >= 2;
  $("settings").innerHTML = `<div class="shead"><b class="k">SETTINGS</b><span class="spacer"></span><button class="btn-s" type="button" data-close>CLOSE</button></div>`
    + (floorsFirst ? floorsRow() : "")
    + row("hero") + row("season") + row("hat") + row("performance")
    // The lane tree: what each level is called (from the top: lanes under HQ first; deeper lanes take the last
    // name), and how the room dresses the levels.
    + `<form class="srow" data-levels><span class="k">LEVEL NAMES</span><div class="opts2"><input class="levels" name="levels" maxlength="200" spellcheck="false" autocomplete="off" value="${esc(settings.levels)}" aria-label="Level names, comma-separated"><button class="btn-s" type="submit">SAVE</button></div><span class="hint">From the top, comma-separated. Deeper lanes use the last name.</span></form>`
    + row("theme")
    + sweepRow()
    + (floorsFirst ? "" : floorsRow())
    + `<div class="sfoot"><button class="btn-s" type="button" data-reset>RESET TO DEFAULTS</button></div>`;
}
// HQ SWEEP: the server nudges HQ to sweep when HQ is idle (src/server/hq-sweep.ts). Its settings live on the server
// with the others; S.sweep says what it uses and when it last and next nudges.
const SWEEP_MINUTES = [20, 30, 60];
const hh = (h) => (h === 24 ? "midnight" : `${String(h).padStart(2, "0")}:00`);
function sweepHint(sw) {
  if (!sw?.on) return "Off. When on, the HUD nudges HQ to sweep (idle lanes, stalled work, rooms, questions waiting on you) whenever HQ is idle, at most every interval.";
  const [a, b] = sw.hours.split("-").map(Number);
  const when = sw.lastAt ? `Last ${clock(sw.lastAt)}, next from ${clock(sw.nextAt)}.` : "No nudge yet.";
  return `On: every ${sw.minutes} min from ${hh(a)} to ${hh(b)}, while HQ is idle and something needs a look. ${when}`;
}
function sweepRow() {
  const sw = S?.sweep ?? { on: false, minutes: 20, hours: "8-24" };
  const btn = (attr, v, label, on) => `<button class="btn-s ${on ? "on" : ""}" type="button" ${attr}="${v}">${label}</button>`;
  return `<form class="srow" data-sweep><span class="k">HQ SWEEP</span><div class="opts2">`
    + btn("data-sweep-on", "false", "OFF", !sw.on) + btn("data-sweep-on", "true", "ON", sw.on)
    + SWEEP_MINUTES.map((m) => btn("data-sweep-min", m, `${m} MIN`, sw.minutes === m)).join("")
    + `<input class="hours" name="hours" maxlength="5" spellcheck="false" autocomplete="off" value="${esc(sw.hours)}" aria-label="Hours, like 8-24"><button class="btn-s" type="submit">SAVE</button></div>`
    + `<span class="hint">${esc(sweepHint(sw))}</span></form>`;
}
// The row follows the state while the panel is open (a change here, on another page or by HQ; the last and next
// nudge), except while the hours are being typed.
on("state", (state) => {
  const el = !$("settings").hidden && document.querySelector("#settings [data-sweep]");
  if (!el || el.contains(document.activeElement) && document.activeElement.name === "hours") return;
  const html = sweepRow();
  if (el.outerHTML !== html) el.outerHTML = html;
});

function renderSettingsButton() { $("settingsBtn").textContent = "SETTINGS"; }
// The settings changed, here, on another page or from the server: the room picks the season and the hats again.
on("settings", () => {
  setSeason(chosenSeason());
  wornCache.clear();
  if (!$("settings").hidden) renderSettings();
});
$("settingsBtn").addEventListener("click", () => {
  const panel = $("settings");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderSettings();
});
$("settings").addEventListener("submit", (e) => {
  const sweep = e.target.closest("[data-sweep]");
  if (sweep) {
    e.preventDefault();
    const hours = sweep.elements.hours.value.replace(/\s+/g, "");
    const m = hours.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!m || Number(m[1]) > 24 || Number(m[2]) > 24 || m[1] === m[2]) { toast("HOURS ARE FROM-TO, LIKE 8-24"); return; }
    post("/api/settings", { settings: { hqSweepHours: hours } }).catch((err) => toast(err.message));
    return;
  }
  const form = e.target.closest("[data-levels]");
  if (!form) return;
  e.preventDefault();
  const levels = form.elements.levels.value.split(",").map((n) => n.trim()).filter(Boolean).join(", ");
  changeSettings({ levels: levels || DEFAULTS.levels });
});
$("settings").addEventListener("click", (e) => {
  const on = e.target.closest("[data-sweep-on]"), min = e.target.closest("[data-sweep-min]");
  if (on || min) {
    post("/api/settings", { settings: on ? { hqSweep: on.dataset.sweepOn === "true" } : { hqSweepMinutes: Number(min.dataset.sweepMin) } }).catch((err) => toast(err.message));
    return;
  }
  const choice = e.target.closest("[data-set]");
  if (choice) { changeSettings({ [choice.dataset.set]: choice.dataset.val }); return; }
  if (e.target.closest("[data-reset]")) { resetSettings(); return; }
  if (e.target.closest("[data-close]")) $("settings").hidden = true;
});
renderSettingsButton();
// Esc closes SETTINGS (before anything else on the page listens to it).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || $("settings").hidden) return;
  e.preventDefault();
  $("settings").hidden = true;
});
