// Clicks delegated from the whole document: choose an agent or open a question (core/scope.js), switch the feed tab, MORE/LESS.
import { renderFeed, renderLog, setFeedTab } from "../feed/feed.js";
import { chooseAgent, openAsk } from "./scope.js";
import { expanded } from "./markdown.js";
import { renderHud } from "../questions/questions.js";
import { renderMsgs } from "../messages/messages.js";

document.addEventListener("click", (e) => {
  const sel = e.target.closest("[data-select]");
  if (sel) { chooseAgent(sel.dataset.select, { jump: true }); return; }
  const open = e.target.closest("[data-open-ask]");
  if (open) { openAsk(Number(open.dataset.openAsk)); return; }
  const tabBtn = e.target.closest("[data-tab]");
  if (tabBtn) {
    setFeedTab(tabBtn.dataset.tab);
    renderFeed();
    return;
  }
  const more = e.target.closest(".more[data-more]");
  if (more) {
    const key = more.dataset.more;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderLog();
    renderHud();
    renderMsgs();
  }
});
