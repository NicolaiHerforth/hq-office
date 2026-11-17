// THE MONITOR's way in: MACHINES in the top bar (and MENU › MONITOR, menu/) opens the monitor's page (/monitor,
// public/monitor.html) in this same tab; its ← HQ comes back. Not a new tab: an app window, a phone's home-screen app
// or a browser that puts a script's tab out of sight showed nothing at all. ⌘/Ctrl/Shift-click or a middle click
// still asks for a tab of its own. The unsent drafts are parked on leaving and restored on the way back
// (questions/drafts.js). The box and what it shows stay the top bar's (topbar/topbar.js); this makes it a link, for a
// pointer, a finger and the keyboard. The page reads the HUD's theme itself.
import { $ } from "../core/dom.js";

export function openMonitor(e) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) window.open("/monitor", "_blank", "noopener");
  else location.assign("/monitor");
}

const box = $("machines");
box.setAttribute("role", "link");
box.setAttribute("aria-label", "Machines: open the resource monitor");
box.tabIndex = 0;
box.addEventListener("click", openMonitor);
box.addEventListener("auxclick", (e) => { if (e.button === 1) openMonitor(e); });
box.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  e.preventDefault();
  openMonitor(e);
});
