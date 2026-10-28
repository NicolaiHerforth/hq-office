// Answering: options, drafts as you type, SEND, COPY, and marking updates read.
import { $, toast } from "../core/dom.js";
import { drafts, secretDrafts } from "./drafts.js";
import { S } from "../core/state.js";
import { copyCode } from "../core/markdown.js";
import { post } from "../core/net.js";
import { readAllBody } from "../core/floors.js";
import { view } from "../core/scope.js";
import { canSend, renderHud } from "./questions.js";
import { clearImages, notReady, withImages } from "../images/images.js";

$("main").addEventListener("click", async (e) => {
  const copyBtn = e.target.closest(".copy");
  if (copyBtn) { copyCode(copyBtn); return; }
  if (e.target.closest("[data-readall]")) { await post("/api/updates/read-all", readAllBody(view())).catch(() => {}); return; }
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
    for (const b of card.querySelectorAll(".opt")) b.classList.toggle("sel", b.dataset.opt === d.opt);
    const send = card.querySelector(".send"), ask = S.open.find((a) => a.id === id);
    if (send && ask) send.disabled = !canSend(ask, d);
    return;
  }
  // NOT YET on a TO DO: it stays (still waiting on the owner); HQ hears it, with what is in the box as the note.
  if (e.target.closest(".notyet")) {
    e.target.disabled = true;
    try {
      await post(`/api/asks/${id}/notyet`, { note: withImages(id, (d.text || "").trim()) });
      drafts.set(id, { ...d, text: "" });
      clearImages(id);
      const ta = card.querySelector("textarea");
      if (ta) ta.value = "";
      toast("HQ KNOWS: NOT YET.");
    } catch (err) { toast(err.message); }
    e.target.disabled = false;
    return;
  }
  if (e.target.closest(".send")) {
    const ask = S.open.find((a) => a.id === id);
    const wait = notReady(id);
    if (wait) { toast(wait); return; }
    const text = withImages(id, (d.text || "").trim());
    const answer = d.opt ? (text ? `${d.opt}. ${text}` : d.opt) : text || (ask.kind === "action" ? "done" : "seen");
    const values = secretDrafts.get(id);
    if (ask.secrets?.length && values && Object.values(values).some(Boolean)) {
      // Cleared at once, whatever the server says.
      secretDrafts.delete(id);
      for (const inp of card.querySelectorAll("[data-secret]")) inp.value = "";
      e.target.disabled = true;
      try { await post(`/api/asks/${id}/secrets`, { values, minutes: Number(d.minutes ?? 60), note: d.opt ? answer : text }); drafts.delete(id); clearImages(id); toast("SECRETS SAVED. HQ HAS THE NAMES."); }
      catch (err) { toast(err.message); renderHud(); }
      return;
    }
    e.target.disabled = true;
    try { await post(`/api/asks/${id}/answer`, { answer }); drafts.delete(id); clearImages(id); toast("SENT. HQ HAS IT."); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  }
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
    card.querySelector(".send").disabled = !canSend(ask, d);
    return;
  }
  if (e.target.tagName !== "TEXTAREA") return;
  d.text = e.target.value;
  drafts.set(id, d);
  card.querySelector(".send").disabled = !canSend(ask, d);
});
$("main").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.target.closest("[data-ask]")?.querySelector(".send")?.click();
});
