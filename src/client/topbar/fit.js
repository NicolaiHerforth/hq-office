// The top bar's ladder, 1151 px and up: one row that never wraps. When the row would overflow, steps turn on one at a
// time, the least important first, until it fits. They add up: data-fit on .top lists the ones that are on ("1 2 3"),
// and each box's stylesheet says what a step does to it. The same bar at the same width always gets the same steps.
// No count and no alarm colour ever leaves; WAITING ON YOU is in the left column and never changes.
//   1 the title becomes the mark HQ             (topbar.css)
//   2 SUBS: the word only, no squares          (subs.css)
//   3 MACHINES: only the named machine's square (topbar.css)
//   4 short labels (STALLED, QUEUE), the strip's gap 18 to 12 (topbar.css)
//   5 MENU: the arrow only                     (menu.css)
//   6 BANK leaves the bar for the top of MENU   (topbar.css, menu.css)
//   7 MACHINES: the number only, the name in the tooltip (topbar.css)
const STEPS = 7;
const top = document.querySelector(".top"), row = top.querySelector(".right");
const wide = matchMedia("(min-width: 1151px)");

export function fit() {
  if (!wide.matches) { delete top.dataset.fit; return; }
  const on = [];
  top.dataset.fit = "";
  while (on.length < STEPS && row.scrollWidth > row.clientWidth) {
    on.push(on.length + 1);
    top.dataset.fit = on.join(" ");
  }
}

// The row's width and every box's width (a count grows, an alarm names a machine, a font loads, SUBS or BLOCKED comes
// and goes). Fit waits for the next frame: changing a watched box's size inside the observer's callback is a loop.
let queued = 0;
const later = () => { queued ||= requestAnimationFrame(() => { queued = 0; fit(); }); };
const sizes = new ResizeObserver(later);
function watch() {
  sizes.disconnect();
  sizes.observe(row);
  for (const el of row.children) sizes.observe(el);
}
new MutationObserver(watch).observe(row, { childList: true });
wide.addEventListener?.("change", later);
watch();
