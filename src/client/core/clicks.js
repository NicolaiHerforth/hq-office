// Clicks delegated from the whole document: focus a lane, switch the feed tab, MORE/LESS.
import { $ } from "./dom.js";
import { renderFeed, renderLog, setFeedTab } from "../feed/feed.js";
import { select } from "../room/input.js";
import { expanded } from "./text.js";
import { renderHud } from "../questions/questions.js";
import { renderMsgs } from "../messages/messages.js";

document.addEventListener("click", (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) { select(sel.dataset.select); return; }
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) {
    setFeedTab(tabBtn.dataset.tab);
    renderFeed();
    if (tabBtn.id === "sFrom") { const f = $("feed"); f.classList.remove("flash"); void f.offsetWidth; f.classList.add("flash"); }
    return;
  }
  const more = e.target.closest("[data-more]");
  if (more) {
    const key = more.dataset.more;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderLog();
    renderHud();
    renderMsgs();
  }
});
