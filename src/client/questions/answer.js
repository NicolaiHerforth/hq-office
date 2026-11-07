// Answering: options, drafts as you type, SEND, COPY, and deleting a secret.
import { $, toast } from "../core/dom.js";
import { drafts, secretDrafts } from "./drafts.js";
import { S } from "../core/state.js";
import { copyCode } from "../core/markdown.js";
import { post } from "../core/net.js";
import { canSend, markCard, stepOn } from "./questions.js";
import { focusOn } from "./focus.js";
import { isLeaving, leave, stay } from "./place.js";
import { forWhom, keptFor } from "./asker.js";
import { attachedTo, clearImages, notReady, withImages } from "../images/images.js";

// One answer per card on its way, from the list or the stage: the server would take only the first. NOT YET's; an answer's
// is isLeaving, which lasts until its card has gone.
const flying = new Set();

// Whom the answer reaches, read before it is sent (once answered, the ask leaves S.open): the asker, or HQ. A lane
// that is away (or at a prompt) or busy gets it once it can take it.
function sentTo(id) {
  const a = S.open.find((x) => x.id === id);
  return { who: (a ? forWhom(a) : "HQ").toUpperCase(), kept: a ? keptFor(a) : null };
}
const reached = ({ who, kept }, has) => (kept ? `${who} IS ${kept === "busy" ? "BUSY" : "AWAY"}: KEPT FOR IT.` : `${who} ${has}.`);

$("main").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest(".copy");
  if (copyBtn) { copyCode(copyBtn); return; }
  const rmBtn = e.target.closest("[data-secret-rm]");
  if (rmBtn) {
    rmBtn.disabled = true;
    try { await post("/api/secrets/rm", { name: rmBtn.dataset.secretRm }); toast(`DELETED ${rmBtn.dataset.secretRm}.`); } catch (err) { toast(err.message); rmBtn.disabled = false; }
    return;
  }
  const upd = e.target.closest("[data-upd]");
  if (upd && upd.classList.contains("unread") && !e.target.closest(".more")) { post(`/api/updates/${upd.dataset.upd}/read`, {}).catch(() => {}); return; }
  const card = e.target.closest("[data-ask]");
  if (!card) return;
  const id = Number(card.dataset.ask);
  const d = drafts.get(id) || {};
  const opt = e.target.closest(".opt");
  if (opt) {
    // Changed in place, not by building the list again: the option stays exactly where it was clicked.
    d.opt = d.opt === opt.dataset.opt ? undefined : opt.dataset.opt;
    drafts.set(id, d);
    markCard(card);
    for (const b of card.querySelectorAll(".opt")) b.classList.toggle("sel", b.dataset.opt === d.opt);
    const send = card.querySelector(".send"), ask = S.open.find((a) => a.id === id);
    if (send && ask) send.disabled = !canSend(ask, d);
    return;
  }
  if (!e.target.closest(".notyet, .send") || flying.has(id) || isLeaving(id)) return;
  const going = (off) => { for (const b of card.querySelectorAll(".notyet, .send")) b.disabled = off; };
  const back = () => { going(false); const send = card.querySelector(".send"), ask = S.open.find((a) => a.id === id); if (send && ask) send.disabled = !canSend(ask, drafts.get(id) || {}); };
  // NOT YET on a TO DO: it stays (still waiting on the owner); whoever asked hears it, with what is in the box as the note.
  if (e.target.closest(".notyet")) {
    const sent = d.text || "", to = sentTo(id), pictures = attachedTo(id).filter((a) => a.state === "done");
    going(true);
    flying.add(id);
    try {
      await post(`/api/asks/${id}/notyet`, { note: withImages(id, sent.trim()) });
      // Only what went: the box stayed live, and what you typed since is yours.
      const now = drafts.get(id) ?? {}, text = now.text || "";
      now.text = text.startsWith(sent) ? text.slice(sent.length).trimStart() : text;
      drafts.set(id, now);
      clearImages(id, pictures);
      const ta = card.querySelector("textarea");
      if (ta && ta.value !== now.text) ta.value = now.text;
      markCard(card);
      toast(to.kept ? `NOT YET. ${reached(to)}` : `${to.who} KNOWS: NOT YET.`);
      if (focusOn()) stepOn();
    } catch (err) { toast(err.message); }
    flying.delete(id);
    back();
    return;
  }
  const ask = S.open.find((a) => a.id === id);
  const wait = notReady(id);
  if (wait) { toast(wait); return; }
  const text = withImages(id, (d.text || "").trim());
  const answer = d.opt ? (text ? `${d.opt}. ${text}` : d.opt) : text || (ask.kind === "action" ? "done" : "seen");
  const values = secretDrafts.get(id);
  const to = sentTo(id);
  going(true);
  leave(id);
  if (ask.secrets?.length && values && Object.values(values).some(Boolean)) {
    // Cleared at once, whatever the server says.
    secretDrafts.delete(id);
    for (const inp of card.querySelectorAll("[data-secret]")) inp.value = "";
    try { await post(`/api/asks/${id}/secrets`, { values, minutes: Number(d.minutes ?? 60), note: d.opt ? answer : text }); drafts.delete(id); clearImages(id); toast(`SECRETS SAVED. ${reached(to, "HAS THE NAMES")}`); }
    catch (err) { stay(id); toast(err.message); back(); }
    return;
  }
  try { await post(`/api/asks/${id}/answer`, { answer }); drafts.delete(id); clearImages(id); toast(`SENT. ${reached(to, "HAS IT")}`); }
  catch (err) { stay(id); toast(err.message); back(); }
});
$("main").addEventListener("input", (e) => {
  const card = e.target.closest("[data-ask]");
  if (!card) return;
  const id = Number(card.dataset.ask);
  const d = drafts.get(id) || {};
  const ask = S.open.find((a) => a.id === id);
  if (e.target.dataset.secret !== undefined || e.target.dataset.secretMin !== undefined) {
    if (e.target.dataset.secretMin !== undefined) { d.minutes = e.target.value; drafts.set(id, d); }
    else secretDrafts.set(id, { ...secretDrafts.get(id), [e.target.dataset.secret]: e.target.value });
    markCard(card);
    card.querySelector(".send").disabled = !canSend(ask, d);
    return;
  }
  if (e.target.tagName !== "TEXTAREA") return;
  d.text = e.target.value;
  drafts.set(id, d);
  markCard(card);
  card.querySelector(".send").disabled = !canSend(ask, d);
});
$("main").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.target.closest("[data-ask]")?.querySelector(".send")?.click();
});
