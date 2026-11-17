// THE MONITOR's way in: MACHINES in the top bar opens the monitor's page (/monitor, public/monitor.html) in a tab of
// its own. The box and what it shows stay the top bar's (topbar/topbar.js); this makes it a link, for a pointer, a
// finger and the keyboard. The page reads the HUD's theme itself.
import { $ } from "../core/dom.js";

const box = $("machines");
const open = () => window.open("/monitor", "_blank", "noopener");
box.setAttribute("role", "link");
box.setAttribute("aria-label", "Machines: open the resource monitor in a new tab");
box.tabIndex = 0;
box.addEventListener("click", open);
box.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.defaultPrevented) return;
  e.preventDefault();
  open();
});
