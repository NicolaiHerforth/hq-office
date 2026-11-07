// COMMENTS on a brief or a room's page (src/server/comments.ts), the way viewers comment on a Claude artifact. A view
// that shows a page puts a mount in itself, <aside class="cmount" data-comments="KEY">, and emits "comments:mount"
// with it; KEY is briefs/ID, rooms/SLUG/brief or rooms/SLUG/files/NAME. The thread fills the mount: beside the page on
// a wide screen, under a markdown brief on a phone (with a COMMENTS button that jumps to it) and in a sheet over a
// page's frame there (COMMENTS opens it, so the page keeps the whole view), newest at the bottom, with a send box
// that takes images and files as every send box does. Each comment is typed into the page's author; their answers
// land here. Selecting text in the view (a markdown brief) shows COMMENT, which quotes the passage in the comment.
// Selection inside a page's sandboxed frame cannot be read from here: the page runtime will emit
// "comments:quote" { key, text } for it, which does the same as COMMENT.
import { toast, keysHint } from "../core/dom.js";
import { S } from "../core/state.js";
import { clock, esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { on } from "../core/bus.js";
import { md, mdClip, mdInline } from "../core/markdown.js";
import { attachedTo, clearImages, composer, hasImages, notReady, withImages } from "../images/images.js";
import { sheet, sheetMode } from "../core/sheet.js";

const MAX_QUOTE = 2000;
const mounts = new Map(); // the mounts on the page now, and how each lets go of its sheet
const loaded = new Map(); // key -> { rev, data }
const drafts = new Map(); // key -> { text, quote, reply, sending: the words on their way, or null }
const draft = (key) => drafts.get(key) ?? drafts.set(key, { text: "", quote: "", reply: null, sending: null }).get(key);
const boxKey = (key) => `comment:${key}`;
const short = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const seenSent = new Map();

function mount(el) {
  if (!el?.dataset?.comments || mounts.has(el)) return;
  live();
  mounts.set(el, sheet(el, () => el.classList.remove("open"), () => sheetMode() && el.classList.contains("open")));
  el.setAttribute("aria-label", "Comments");
  el.setAttribute("data-drop", ""); // a file dropped on the thread joins its send box (images.js)
  el.innerHTML = `<button class="cjump" type="button" data-cjump>COMMENTS</button>
    <div class="chead"><b>COMMENTS</b><span class="cn"></span><span class="cto"></span><button class="cclose" type="button" data-cclose aria-label="Close comments">✕</button></div>
    <div class="cthread" tabindex="-1"><div class="empty">LOADING…</div></div>
    <div class="csend"><div class="cquote"></div><div class="creply"></div>${composer(boxKey(el.dataset.comments), `<textarea rows="1" placeholder="Comment on this.${keysHint(" ⌘↩ sends.")}">${esc(draft(el.dataset.comments).text)}</textarea>`, `<button class="send go" type="button" data-csend>SEND</button>`)}</div>`;
  watchJump(el);
  // Open or closed from the start: a thread that showed until its comments came, then closed, moved the page beside it.
  el.hidden = !showThread();
  load(el, true);
}
const live = () => { for (const [el, off] of mounts) if (!el.isConnected) { mounts.delete(el); off(); } return [...mounts.keys()]; };

async function load(el, force = false) {
  const key = el.dataset.comments, rev = S?.comments?.[key]?.rev ?? "0";
  if (!force && loaded.get(key)?.rev === rev) return;
  try {
    const r = await fetch(`/api/comments?page=${encodeURIComponent(key)}`, { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) { el.hidden = true; return; }
    loaded.set(key, { rev, data });
    render(el);
  } catch {}
}

// ---- drawing ----

function deliveryHtml(c) {
  if (c.delivery === "sent") return `<span class="seen ok">DELIVERED</span>`;
  if (c.delivery === "away") return `<span class="seen kept" title="Kept: it goes to ${esc(c.to)} when herdr sees the lane again">AWAY · KEPT</span>`;
  if (c.delivery === "held") return `<span class="seen kept" title="${esc(c.error || `Held: it goes to ${c.to} as soon as HQ can take it`)}">HELD FOR HQ</span>`;
  if (c.delivery === "failed") return `<span class="seen bad" title="${esc(c.error || "")}">NOT DELIVERED</span><button class="btn-s" type="button" data-cretry="${c.id}">RETRY</button>`;
  return `<span class="seen">SENDING…</span>`;
}
function commentHtml(c, byId) {
  const lane = c.who !== "owner";
  const p = c.reply ? byId.get(c.reply) : null;
  const re = p ? `<div class="quote">↩ ${p.who === "owner" ? "you" : esc(p.who)} ${clock(p.at)}: ${mdInline(short(p.text, 80), { links: false })}</div>` : c.reply ? `<div class="quote">↩ an earlier comment</div>` : "";
  const quote = c.quote ? `<blockquote class="cq md">${md(c.quote)}</blockquote>` : "";
  return `<article class="msg ${lane ? "lane" : "you"}${lane && !c.read ? " unread" : ""}" data-cmsg="${c.id}">
      <div class="meta"><span class="who">${lane ? esc(c.who) : "YOU"}</span><span class="tag">${clock(c.at)}</span>${lane ? `<button class="btn-s" type="button" data-creply="${c.id}">REPLY</button>` : deliveryHtml(c)}</div>
      ${re}${quote}<div class="text md">${mdClip(c.text, `cmt${c.id}`, 600)}</div>
    </article>`;
}

// The thread beside a brief or a page is closed until the owner opens it with COMMENTS in the view's bar: one choice
// for every brief and page, kept in this browser. On a narrow screen the thread is a sheet that COMMENTS opens.
const OPEN_KEY = "hq-comments-open";
let open = (() => { try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; } })();
const wide = matchMedia("(min-width: 1151px)");
const showThread = () => open || !wide.matches;
function toggles() {
  for (const b of document.querySelectorAll("[data-comments-toggle]")) {
    const c = S?.comments?.[b.dataset.commentsToggle], n = c?.n ?? 0;
    setHTML(b, n ? `COMMENTS · ${n}` : "COMMENTS");
    b.classList.toggle("on", wide.matches && open);
    b.classList.toggle("new", !!c?.unread);
    b.setAttribute("aria-pressed", String(wide.matches && open));
  }
}
function applyOpen() {
  for (const el of live()) if (loaded.get(el.dataset.comments)) el.hidden = !showThread();
  toggles();
}
wide.addEventListener?.("change", applyOpen);
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-comments-toggle]");
  if (!b) return;
  if (wide.matches) {
    open = !open;
    try { localStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
    applyOpen();
    if (open) live().find((el) => el.dataset.comments === b.dataset.commentsToggle)?.querySelector("textarea")?.focus({ preventScroll: true });
  } else {
    const el = live().find((m) => m.dataset.comments === b.dataset.commentsToggle);
    if (el) { el.classList.add("open"); el.querySelector("textarea")?.focus({ preventScroll: true }); }
  }
});

function render(el) {
  const key = el.dataset.comments, d = loaded.get(key)?.data;
  if (!d) return;
  el.hidden = !showThread();
  toggles();
  const n = d.comments.length + d.earlier;
  setHTML(el.querySelector(".cn"), n ? String(n) : "");
  setHTML(el.querySelector(".cto"), d.away ? `to ${esc(d.to)} · <span class="aw">AWAY</span>` : `to ${esc(d.to)}`);
  setHTML(el.querySelector("[data-cjump]"), n ? `COMMENTS · ${n}` : "COMMENT");
  const t = el.querySelector(".cthread");
  const byId = new Map(d.comments.map((c) => [c.id, c]));
  const html = (d.earlier ? `<div class="earlier">${d.earlier} EARLIER NOT SHOWN</div>` : "")
    + (d.comments.map((c) => commentHtml(c, byId)).join("") || `<div class="empty">No comments yet. Write one below; it goes to ${esc(d.to)}, and the answer lands here. Select text on the page and press COMMENT to quote it.</div>`);
  const atEnd = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  if (setHTML(t, html) && (atEnd || el.dataset.stick)) t.scrollTop = t.scrollHeight;
  delete el.dataset.stick;
  renderSend(el);
  // Seen: the answers stop counting as new.
  const unread = d.comments.some((c) => c.who !== "owner" && !c.read);
  const rev = loaded.get(key).rev;
  if (unread && seenSent.get(key) !== rev && document.visibilityState === "visible") {
    seenSent.set(key, rev);
    post("/api/comments/seen", { page: key }).catch(() => seenSent.delete(key));
  }
}

function renderSend(el) {
  const key = el.dataset.comments, d = draft(key), data = loaded.get(key)?.data;
  setHTML(el.querySelector(".cquote"), d.quote ? `<blockquote class="md">${mdInline(short(d.quote, 240), { links: false })}</blockquote><button class="btn-s" type="button" data-cunquote aria-label="Do not quote it">×</button>` : "");
  const p = d.reply && data?.comments.find((c) => c.id === d.reply);
  setHTML(el.querySelector(".creply"), p ? `<span>↩ ${esc(p.who)} ${clock(p.at)}: ${mdInline(short(p.text, 70), { links: false })}</span><button class="btn-s" type="button" data-cunreply aria-label="Do not reply to it">×</button>` : "");
  sendState(el);
}
function sendState(el) {
  const btn = el.querySelector("[data-csend]");
  const d = draft(el.dataset.comments);
  if (btn) btn.disabled = d.sending === null && !d.text.trim() && !hasImages(boxKey(el.dataset.comments));
}

// ---- sending ----

// The box stays live while a comment goes: what comes out of it is what went, and only if the box still starts with it.
async function send(el) {
  const key = el.dataset.comments, d = draft(key), k = boxKey(key);
  if (d.sending !== null) { toast(d.text === d.sending ? "STILL SENDING." : "STILL SENDING THE LAST ONE. THIS STAYS HERE; SEND IT WHEN THAT HAS GONE."); return; }
  const raw = d.text, text = withImages(k, raw.trim());
  if (!text) return;
  const wait = notReady(k);
  if (wait) { toast(wait); return; }
  const { quote, reply } = d, pictures = attachedTo(k);
  d.sending = raw;
  try {
    const r = await post("/api/comments/post", { page: key, text, quote: quote || undefined, reply: reply ?? undefined });
    d.sending = null;
    if (d.text.startsWith(raw)) d.text = d.text.slice(raw.length).trimStart();
    if (d.quote === quote) d.quote = "";
    if (d.reply === reply) d.reply = null;
    clearImages(k, pictures);
    // The view may have been left and opened again meanwhile: the box to show this in is the one there now.
    const here = live().filter((m) => m.dataset.comments === key);
    for (const m of here) {
      const ta = m.querySelector("textarea");
      if (ta && ta.value !== d.text) ta.value = d.text;
      renderSend(m);
    }
    const said = loaded.get(key)?.data.away ? `KEPT FOR ${String(r.to).toUpperCase()}: IT IS AWAY.` : `SENT TO ${String(r.to).toUpperCase()}.`;
    const left = d.text.trim() || d.quote || d.reply || hasImages(k);
    toast(left ? `${said} ${here.some((m) => m.getClientRects().length) ? "WHAT YOU ADDED SINCE IS STILL HERE." : "COMMENTS HAS WHAT YOU ADDED SINCE."}` : said);
    el.dataset.stick = "1";
    await load(el, true);
  } catch (err) {
    d.sending = null;
    toast(err.message);
    sendState(el);
  }
}

// Quote a passage: COMMENT on a selection, or the page runtime for a selection in a page's frame.
function quote(key, text) {
  const el = live().find((m) => m.dataset.comments === key);
  const q = String(text ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_QUOTE);
  if (!el || !q) return;
  draft(key).quote = q;
  el.classList.add("open");
  renderSend(el);
  const ta = el.querySelector("textarea");
  ta?.focus({ preventScroll: true });
  el.querySelector(".csend")?.scrollIntoView?.({ block: "nearest" });
}
on("comments:quote", (e) => quote(e?.key, e?.text));

// ---- COMMENT on a selection ----

const pick = document.createElement("button");
pick.type = "button";
pick.className = "cpick";
pick.textContent = "COMMENT";
pick.hidden = true;
document.body.append(pick);
let picked = null; // { key, text }
function selectionFor() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const at = node.nodeType === 1 ? node : node.parentElement;
  if (at?.closest("textarea, input, [contenteditable], .cmount")) return null;
  const el = live().find((m) => m.parentElement?.contains(at) && !m.hidden);
  return el ? { key: el.dataset.comments, text, rect: sel.getRangeAt(0).getBoundingClientRect() } : null;
}
let queued = false;
document.addEventListener("selectionchange", () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const s = selectionFor();
    picked = s;
    pick.hidden = !s;
    if (!s) return;
    const w = pick.offsetWidth || 90, h = pick.offsetHeight || 34;
    const left = Math.min(innerWidth - w - 8, Math.max(8, s.rect.left + s.rect.width / 2 - w / 2));
    const top = s.rect.top - h - 8 >= 8 ? s.rect.top - h - 8 : Math.min(innerHeight - h - 8, s.rect.bottom + 8);
    pick.style.left = `${left}px`;
    pick.style.top = `${top}px`;
  });
});
pick.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection while pressing
pick.addEventListener("click", () => {
  if (!picked) return;
  const { key, text } = picked;
  getSelection()?.removeAllRanges();
  pick.hidden = true;
  quote(key, text);
});

// ---- on a phone: a button that jumps to the thread while it is out of view ----

function watchJump(el) {
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(([e]) => el.classList.toggle("inview", e.isIntersecting));
  io.observe(el.querySelector(".chead"));
}

// ---- input ----

document.addEventListener("click", (e) => {
  const el = e.target.closest?.(".cmount");
  if (!el || !mounts.has(el)) return;
  const key = el.dataset.comments, d = draft(key), t = e.target;
  if (t.closest("[data-csend]")) send(el);
  // COMMENTS: to the thread under a markdown brief, or (a page in a frame, on a phone) open its sheet; × closes it.
  else if (t.closest("[data-cjump]")) { el.classList.add("open"); el.querySelector(".chead").scrollIntoView({ block: "start", behavior: "smooth" }); el.querySelector("textarea")?.focus({ preventScroll: true }); }
  else if (t.closest("[data-cclose]")) el.classList.remove("open");
  else if (t.closest("[data-cunquote]")) { d.quote = ""; renderSend(el); }
  else if (t.closest("[data-cunreply]")) { d.reply = null; renderSend(el); }
  else if (t.closest("[data-creply]")) { d.reply = Number(t.closest("[data-creply]").dataset.creply); renderSend(el); el.querySelector("textarea")?.focus(); }
  else if (t.closest("[data-cretry]")) post(`/api/comments/${t.closest("[data-cretry]").dataset.cretry}/retry`, {}).then(() => load(el, true)).catch((err) => toast(err.message));
});
document.addEventListener("input", (e) => {
  const el = e.target.closest?.(".cmount");
  if (!el || !e.target.matches("textarea")) return;
  draft(el.dataset.comments).text = e.target.value;
  sendState(el);
});
document.addEventListener("keydown", (e) => {
  const el = e.target.closest?.(".cmount");
  if (!el || !e.target.matches?.("textarea")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(el); }
});
on("attach", (k) => { for (const el of live()) if (boxKey(el.dataset.comments) === k) sendState(el); });
on("comments:mount", mount);
on("state", () => { for (const el of live()) load(el); toggles(); });
document.querySelectorAll(".cmount[data-comments]").forEach(mount);
