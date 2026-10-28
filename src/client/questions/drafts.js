// Unsent answers and notes, kept across the page's own reloads.
import { $ } from "../core/dom.js";
import { renderLog } from "../feed/feed.js";
import { renderMachines, renderStats } from "../topbar/topbar.js";
import { renderHud } from "./questions.js";
import { renderCard } from "../card/card.js";
import { renderMsgs, renderQTabs, replyText, replyTo, setReply } from "../messages/messages.js";
import { renderWork } from "../work-board/work-board.js";
import { restoreImages, savedImages } from "../images/images.js";

export const drafts = new Map();
// Secret values typed into a question card, by ask id. Memory only: never in drafts, sessionStorage or the DOM's markup.
export const secretDrafts = new Map();

// Autoreload: the server stamps index.html's mtime into every state. A new stamp means the file changed.
// Unsent text, the open reply and attached images (their paths on the HUD, never their bytes) are parked in
// sessionStorage so the reload does not eat them. So is any other reload, or a phone dropping the page while its
// camera is open: they are parked whenever the page is hidden too.
export function keepDrafts() {
  try { sessionStorage.setItem("hq-drafts", JSON.stringify({ drafts: [...drafts], note: $("noteText").value, reply: replyTo ? [replyTo, replyText] : null, images: savedImages() })); } catch {}
}
addEventListener("pagehide", keepDrafts);
document.addEventListener("visibilitychange", () => { if (document.hidden) keepDrafts(); });
function restoreDrafts() {
  try {
    const d = JSON.parse(sessionStorage.getItem("hq-drafts") || "null");
    sessionStorage.removeItem("hq-drafts");
    if (!d) return;
    for (const [k, v] of d.drafts) drafts.set(k, v);
    $("noteText").value = d.note || "";
    if (d.reply) setReply(...d.reply);
    restoreImages(d.images);
  } catch {}
}
restoreDrafts();


// The stream's first message is the whole state; after that each message holds only the parts of the state that
// changed, and only the panels showing one of those parts are built again.
export const PANELS = [
  [["open", "lanes", "score", "updatesUnread", "hq"], () => renderStats()],
  [["machines"], () => renderMachines()],
  [["open", "lanes"], () => renderHud()], // a lane that changes floor changes its questions' tags and the scope
  [["lanes", "open", "config"], () => renderCard()],
  [["notes", "answered", "updates", "updatesUnread", "updatesUnreadByLane", "lanes", "secrets", "secretsLost", "hq"], () => renderLog()],
  [["open", "updatesUnread", "updatesUnreadByLane", "lanes", "board"], () => renderQTabs()],
  [["board", "open"], () => renderWork()],
  [["updates", "updatesUnreadByLane", "notes", "lanes"], () => renderMsgs()],
];
