// ROOMS: a conference room per piece of work. The ROOMS tab in the question column lists them: each room's owner,
// its work's state on the board and its last activity. A room is a place you go to: opening one (from the list, a
// link to #room/SLUG, or the strip of rooms at its top) swaps the office on the right for the room's own view, and
// BACK TO OFFICE, Esc or the browser's back button return. The question column never moves.
//
// In the room the conversation comes first: the thread fills the main column with the send box always at its foot
// (write to the owning lane or any lane in the room; the server types it into that lane). The lanes, linked work,
// the brief and the shelf sit in a rail beside it, folded or open as this browser last left it. Each pane scrolls
// on its own. On a phone (or any screen under 1151px) a room is a full-screen view with CHAT, BRIEF and SHELF tabs.
//
// Each room is a folder on the HUD's disk (rooms/SLUG/, see src/server/room-folder.ts). The shelf's ADD puts files
// (picked, dropped anywhere on the room, or pasted) into its files/ and links on the shelf; images attached to a
// message go into files/ too, so they are on the shelf as well.
import { $, keepScroll, showEdges, toast } from "../core/dom.js";
import { CONFIG, S } from "../core/state.js";
import { clock, esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { emit, on } from "../core/bus.js";
import { STATUS_TEXT } from "../core/status.js";
import { qTab } from "../messages/messages.js";
import { clearImages, composer, hasImages, notReady, openPreview, uploadTarget, withImages } from "../images/images.js";
import { md, mdClip, mdInline } from "../core/markdown.js";
import { ART_H, drawStrip, laneAt, stripKey } from "./pix.js";
import { others, pick, scope, tagged } from "../core/scope.js";
import { floorTagHTML, scopeLineHTML } from "../core/floors.js";

const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
// Rooms 0.9 remembered the open room here; a room's address is its #room/SLUG now.
store("hq-room", null);

// ---- the list, in the question column ----

const box = $("rooms");
box.innerHTML = `<div class="rlist"></div>`;
const list = box.querySelector(".rlist");

// ---- the room view, on the stage in place of the office ----

const stage = document.querySelector(".stage");
const view = document.createElement("section");
view.className = "box roomview";
view.id = "roomView";
view.hidden = true;
view.setAttribute("aria-label", "Conference room");
view.innerHTML = `<div class="rvbar">
    <button class="btn back" type="button" data-room-back>◀ BACK TO OFFICE<span class="tag count waitn" hidden></span></button>
    <nav class="rvtabs" aria-label="Open rooms"></nav>
  </div>
  <div class="rvhead"></div>
  <canvas class="rvpix" aria-hidden="true"></canvas>
  <div class="rvptabs" role="tablist">
    <button class="tab" type="button" role="tab" data-ptab="chat">CHAT</button>
    <button class="tab" type="button" role="tab" data-ptab="brief">BRIEF</button>
    <button class="tab" type="button" role="tab" data-ptab="shelf">SHELF</button>
  </div>
  <div class="rvbody">
    <div class="rvchat">
      <div class="rthread" tabindex="-1" aria-label="Thread"></div>
      <div class="rsend"></div>
    </div>
    <aside class="rvrail" id="roomRail" aria-label="Lanes, brief and shelf">
      <section class="rtop"></section>
      <section class="rbrief"></section>
      <section class="rshelf"></section>
    </aside>
  </div>`;
stage.append(view);
const part = (cls) => view.querySelector(`.${cls}`);

let openSlug = null; // the room on the stage
let detail = null; // the open room, as /api/rooms/SLUG gave it
let fetching = "";
let stick = true; // the thread opens at its newest message
let sendFor = null; // the room the send box was built for
let railFolded = stored("hq-room-rail") === "folded";
const fresh = new Set(); // lanes' messages that were new when shown: tinted until you leave the room
const seenSent = new Map(); // slug -> the rev a "seen" was sent for
// Unsent text per room, its To and the message it replies to; kept across a reload.
const drafts = new Map((() => { try { return JSON.parse(sessionStorage.getItem("hq-room-drafts") || "[]"); } catch { return []; } })());
const keepDrafts = () => { try { sessionStorage.setItem("hq-room-drafts", JSON.stringify([...drafts].filter(([, d]) => d.text || d.reply || d.to))); } catch {} };
addEventListener("pagehide", keepDrafts);
document.addEventListener("visibilitychange", () => { if (document.hidden) keepDrafts(); });
const draft = (slug) => drafts.get(slug) ?? drafts.set(slug, { text: "", to: "", reply: null }).get(slug);
const key = (slug) => `room:${slug}`;

const roomOf = (slug) => (S?.rooms ?? []).find((r) => r.slug === slug) ?? null;
const short = (s, n) => { const t = String(s ?? "").replace(/```[\s\S]*?```/g, "[code]").replace(/\[image: [^\]]+\]/g, "[image]").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function ago(t) { const m = Math.floor((Date.now() - t) / 60000), h = Math.floor(m / 60); return m < 1 ? "NOW" : h < 1 ? `${m}M AGO` : h < 48 ? `${h}H AGO` : `${Math.floor(h / 24)}D AGO`; }
// Under 1151px there is no stage beside the questions: a room takes the whole screen.
const fullScreen = matchMedia("(max-width: 1150px)");

// ---- lanes: level, status, away ----

function laneInfo(name) {
  if (name === "hq") return { level: "HQ", label: "HQ", color: "#23233a", away: false };
  const l = (S?.lanes ?? []).find((x) => x.name === name);
  if (!l) return { level: "", label: "Not registered", color: "#6a6a82", away: true };
  const [label, color] = STATUS_TEXT[l.status] ?? [l.status, "#6a6a82"];
  // Away as the server decides it: herdr found no agent by this name (a lane can be away with a question open).
  return { level: l.level || "", label: l.herdr === "gone" ? `${label}, agent away` : label, color, away: l.herdr === "gone" };
}
function laneChip(name, role = "") {
  const i = laneInfo(name);
  const sel = name === "hq" ? "" : ` data-select="${esc(name)}"`;
  return `<button class="rlane${i.away ? " away" : ""}" type="button"${sel} title="${esc(`${name}: ${i.label}`)}"><i style="background:${i.color}"></i><b>${esc(name)}</b>${i.level ? `<span class="lv">${esc(i.level.toUpperCase())}</span>` : ""}${role ? `<span class="role">${role}</span>` : ""}${i.away ? `<span class="aw">AWAY</span>` : ""}</button>`;
}

// ---- linked work, with its state on the work board ----

const WS = { stalled: "STALLED", owner: "WAITING ON YOU", ci: "WAITING ON CI", moving: "MOVING", paused: "PAUSED", done: "DONE" };
const WS_ORDER = ["stalled", "owner", "ci", "moving", "paused", "done"];
function work(r) {
  const items = S?.board?.items ?? [];
  return [
    ...r.issues.map((k) => ({ kind: "issue", key: k, item: items.find((i) => i.issue === k) ?? null })),
    ...r.prs.map((k) => { const item = items.find((i) => i.prs.some((p) => p.key === k)) ?? null; return { kind: "pr", key: k, item, pr: item?.prs.find((p) => p.key === k) ?? null }; }),
  ];
}
// The most urgent state among a room's work.
const workState = (r) => WS_ORDER.find((s) => work(r).some((w) => w.item?.state === s)) ?? null;
function issueTag(k) {
  return CONFIG.linearWorkspace ? `<a class="tag key" href="https://linear.app/${esc(CONFIG.linearWorkspace)}/issue/${esc(k)}" target="_blank" rel="noopener">${esc(k)}</a>` : `<span class="tag key">${esc(k)}</span>`;
}
function prTag(k, p) {
  const num = k.split("#").pop(), repo = k.includes("#") ? k.split("#")[0] : CONFIG.githubRepo;
  const mark = !p ? "" : p.state === "MERGED" ? " MERGED" : p.state === "CLOSED" ? " CLOSED" : p.draft ? " DRAFT" : p.ci === "running" ? " CI…" : p.ci === "failed" ? " CI ✗" : p.state === "OPEN" ? " OPEN" : "";
  const cls = `tag pr${p?.state === "MERGED" ? " merged" : p?.draft ? " draft" : ""}`;
  return repo ? `<a class="${cls}" href="https://github.com/${esc(repo)}/pull/${esc(num)}" target="_blank" rel="noopener">#${esc(num)}${mark}</a>` : `<span class="${cls}">#${esc(num)}${mark}</span>`;
}
function workHtml(r, full) {
  return work(r).map((w) => {
    const state = w.item ? `<span class="tag ws ${w.item.state}" title="${esc(w.item.why)}">${WS[w.item.state]}</span>` : full ? `<span class="tag muted">NOT ON THE BOARD</span>` : "";
    // A PR's board state shows only when the room does not link its item's issue (which shows it already).
    // In the list the room's most urgent state stands for all of its work.
    const show = full && (w.kind === "issue" || !(w.item && r.issues.includes(w.item.issue)));
    return `<span class="rwork">${w.kind === "issue" ? issueTag(w.key) : prTag(w.key, w.pr)}${show ? state : ""}</span>`;
  }).join("");
}

// ---- the list ----

function rowHtml(r) {
  const state = workState(r);
  const last = r.last ? `<b>${r.last.who === "owner" ? `YOU → ${esc(r.last.to)}` : esc(r.last.who)}</b> ${mdInline(r.last.text, { links: false })}` : `No messages yet${r.artifacts ? ` · ${r.artifacts} on the shelf` : ""}`;
  const here = r.slug === openSlug;
  return `<article class="rrow${r.unread ? " unread" : ""}${r.archivedAt ? " archived" : ""}${here ? " here" : ""}" data-room="${esc(r.slug)}" tabindex="0" role="link" aria-label="Go to room ${esc(r.title)}"${here ? ` aria-current="page"` : ""}>
      <div class="meta">${tagged() ? floorTagHTML(S, r.floor) : ""}<b class="rt">${mdInline(r.title, { links: false })}</b>${here ? `<span class="tag in">YOU ARE HERE</span>` : ""}${r.unread ? `<span class="tag new">${r.unread} NEW</span>` : ""}${r.undelivered ? `<span class="tag kept">${r.undelivered} KEPT</span>` : ""}<span class="age">${ago(r.lastAt)}</span></div>
      <div class="people">${laneChip(r.owner, "OWNER")}${r.members.length ? `<span class="plus">+${r.members.length} ${r.members.length === 1 ? "LANE" : "LANES"}</span>` : ""}${state ? `<span class="tag ws ${state}">${WS[state]}</span>` : ""}${workHtml(r, false)}</div>
      <div class="last${r.last ? "" : " none"}">${last}</div>
    </article>`;
}
// Inside a floor, that floor's rooms (docs/floors.md).
function renderList() {
  const rooms = pick(S?.rooms), line = S ? scopeLineHTML(S, scope(), others(S.rooms)) : "";
  const live = rooms.filter((r) => !r.archivedAt), old = rooms.filter((r) => r.archivedAt);
  const unread = live.filter((r) => r.unread).length;
  setHTML(list, line + (rooms.length
    ? `<div class="rsum">${live.length} OPEN ${live.length === 1 ? "ROOM" : "ROOMS"}${unread ? ` · ${unread} WITH NEW MESSAGES` : ""}</div>${live.map(rowHtml).join("")}${old.length ? `<h4>ARCHIVED (${old.length})</h4>${old.map(rowHtml).join("")}` : ""}`
    : `<div class="empty">No rooms yet. HQ opens one for a piece of work with hud room create. Its lane keeps the brief and the artifacts there, and you talk to it here.</div>`));
}
function renderCount() {
  const n = pick(S?.rooms).filter((r) => !r.archivedAt && r.unread).length, t = $("qtRooms");
  t.hidden = !n;
  t.textContent = n;
  t.title = `${n} ${n === 1 ? "room has" : "rooms have"} new messages`;
}

// ---- an open room: the bar, the head, the strip ----

// The other open rooms, one step away; a count on those with new lane messages.
function renderBar(r) {
  const rooms = (S?.rooms ?? []).filter((x) => !x.archivedAt || x.slug === r.slug);
  setHTML(part("rvtabs"), rooms.map((x) => `<a class="rvtab${x.slug === r.slug ? " on" : ""}${x.unread && x.slug !== r.slug ? " unread" : ""}" href="#room/${esc(x.slug)}" data-room-go="${esc(x.slug)}"${x.slug === r.slug ? ` aria-current="page"` : ""} title="${esc(x.title)}"><span>${mdInline(x.title, { links: false })}</span>${x.unread && x.slug !== r.slug ? `<span class="tag new">${x.unread}</span>` : ""}</a>`).join(""));
  // The questions stay in their column; on a full-screen room, the way back says when some are waiting.
  const n = S?.open?.length ?? 0, w = part("waitn");
  w.hidden = !n;
  w.textContent = `${n} WAITING`;
}
// CLOSE ROOM: the owner archives the room, after a confirm in the page (never a browser dialog). closeAsk is the room
// whose confirm is showing.
let closeAsk = null;
function renderHead(r, d) {
  const shelf = d?.artifactList.length ?? r.artifacts ?? 0;
  setHTML(part("rvhead"), `<h2>${mdInline(r.title)}</h2>${r.archivedAt ? `<span class="tag muted">ARCHIVED</span>` : ""}<span class="who">${laneChip(r.owner, "OWNER")}${r.members.length ? `<span class="plus">+${r.members.length} ${r.members.length === 1 ? "LANE" : "LANES"}</span>` : ""}</span><button class="btn-s railbtn" type="button" data-rail-toggle aria-expanded="${!railFolded}" aria-controls="roomRail">${railFolded ? "◀ BRIEF · SHELF" : "FOLD ▶"}${railFolded && shelf ? ` (${shelf})` : ""}</button>${r.archivedAt ? "" : `<button class="btn-s rclose" type="button" data-room-close>CLOSE ROOM</button>`}`
    + (closeAsk === r.slug && !r.archivedAt ? `<div class="rconfirm" data-close-confirm><span>Close ${mdInline(r.title)}? It moves to ARCHIVED and stops taking messages; HQ can reopen it with <code>hud room create ${esc(r.slug)}</code>.</span><button class="btn-s" type="button" data-close-keep>KEEP IT OPEN</button><button class="btn-s danger" type="button" data-close-yes>CLOSE IT</button></div>` : ""));
  view.classList.toggle("folded", railFolded);
}

// The strip is drawn at 2 screen pixels per art pixel (1.5 on a full screen); its art is as wide as its box allows.
const pix = part("rvpix");
let pixKey = "", pixWidth = 0;
function renderStrip(r) {
  if (!r) return;
  const scale = fullScreen.matches ? 1.5 : 2;
  const css = pix.clientWidth;
  if (css <= 0) return;
  const width = Math.max(120, Math.round(css / scale));
  const lanes = new Map((S?.lanes ?? []).map((l) => [l.name, l]));
  const k = `${scale}|${stripKey(r, lanes, width)}`;
  if (k === pixKey) return;
  pixKey = k;
  pixWidth = width;
  pix.style.height = `${ART_H * scale}px`;
  drawStrip(pix, r, lanes, width);
}
pix.addEventListener("mousemove", (e) => {
  const r = roomOf(openSlug), b = pix.getBoundingClientRect();
  const name = laneAt(r, pixWidth, ((e.clientX - b.left) / b.width) * pixWidth);
  const t = name ? (name === "you" ? "You, at the head of the table" : `${name}: ${laneInfo(name).label}`) : "";
  if (pix.title !== t) pix.title = t;
});

// ---- the rail: lanes and work, the brief, the shelf ----

function renderTop(r) {
  setHTML(part("rtop"), `<div class="k"><span>LANES</span></div><div class="people">${laneChip(r.owner, "OWNER")}${r.members.map((m) => laneChip(m)).join("")}</div>${r.issues.length || r.prs.length ? `<div class="k"><span>WORK</span></div><div class="works">${workHtml(r, true)}</div>` : ""}`);
}
function renderBrief(d) {
  const head = `<div class="k"><span>BRIEF</span>${d?.briefAt ? `<span class="by">${esc(d.briefBy || "")} · ${ago(d.briefAt)}</span>` : ""}</div>`;
  const body = !d ? "" : d.brief ? `<div class="md">${md(d.brief)}</div>` : `<div class="md none">No brief yet. The owning lane pins one with hud room brief ${esc(d.slug)}.</div>`;
  setHTML(part("rbrief"), head + body);
}

// Pixel icons for the shelf's cards.
const icon = (paths) => `<svg viewBox="0 0 12 12" aria-hidden="true" shape-rendering="crispEdges">${paths}</svg>`;
const ICON = {
  "claude-artifact": icon(`<path d="M5 0h2v3H5zM5 9h2v3H5zM0 5h3v2H0zM9 5h3v2H9zM3 3h2v2H3zM7 3h2v2H7zM3 7h2v2H3zM7 7h2v2H7zM5 5h2v2H5z"/>`),
  link: icon(`<path d="M1 4h2v1H1zM0 5h1v3H0zM1 8h4v1H1zM5 5h1v3H5zM4 4h1v1H4zM6 3h4v1H6zM10 4h1v3h-1zM6 7h4v1H6zM6 4h1v3H6zM3 6h6v1H3z"/>`),
  file: icon(`<path d="M2 0h6v1H2zM8 1h1v1H8zM9 2h1v1H9zM10 3h1v9H10zM1 1h1v11H1zM2 11h8v1H2zM8 2h1v2h2v1H8zM3 5h5v1H3zM3 7h5v1H3zM3 9h4v1H3z"/>`),
};
const LABEL = { "claude-artifact": "CLAUDE ARTIFACT", link: "LINK", file: "FILE", image: "IMAGE" };
function host(u) { try { return new URL(u, location.href).host.replace(/^www\./, ""); } catch { return ""; } }
const byName = (by) => (by === "owner" ? "you" : by || "");
function cardHtml(a) {
  const meta = `<span class="am">${esc(byName(a.by))} · ${ago(a.at)}</span>`;
  if (a.kind === "image") {
    return `<div class="art image"><button type="button" class="aimg" data-art-preview="${a.id}" aria-label="See ${esc(a.title)} full screen"><img src="${esc(a.url)}" alt="" loading="lazy"></button><div class="at" title="${esc(a.title)}">${mdInline(a.title)}</div><div class="af">${meta}</div></div>`;
  }
  const ext = a.kind === "file" ? (a.url.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "").toUpperCase() : "";
  const label = a.kind === "file" ? `${ext || "FILE"} FILE` : a.kind === "link" ? host(a.url) || "LINK" : LABEL[a.kind];
  return `<div class="art ${esc(a.kind)}"><div class="ak">${ICON[a.kind] ?? ICON.link}<span>${esc(label)}</span></div><div class="at" title="${esc(a.title)}">${mdInline(a.title)}</div><div class="af">${meta}<a class="btn-s open" href="${esc(a.url)}" target="_blank" rel="noopener">OPEN</a></div></div>`;
}
// The shelf: its head (with ADD), the ADD form, the cards and where the folder is. The form is built once per room
// and never redrawn, so what you type in it survives every update.
let addOpen = false, adding = 0, shelfFor = null;
function renderShelf(d, r) {
  const items = d?.artifactList ?? [];
  const tab = view.querySelector('[data-ptab="shelf"]'), label = items.length ? `SHELF (${items.length})` : "SHELF";
  if (tab.textContent !== label) tab.textContent = label;
  const el = part("rshelf");
  if (shelfFor !== r.slug) {
    shelfFor = r.slug;
    el.innerHTML = `<div class="k rshk"></div>
      <form class="radd" hidden autocomplete="off">
        <label class="btn-s rpick">ADD FILES<input type="file" multiple data-shelf-file aria-label="Add files to the shelf"></label>
        <span class="or">OR A LINK</span>
        <input type="url" name="url" inputmode="url" placeholder="https://…" aria-label="Link">
        <input type="text" name="title" placeholder="Title (optional)" aria-label="Title">
        <button class="btn-s go" type="submit">ADD LINK</button>
      </form>
      <div class="rshitems"></div>`;
  }
  const live = !r.archivedAt;
  const form = el.querySelector(".radd");
  form.hidden = !(addOpen && live);
  setHTML(el.querySelector(".rshk"), `<span>SHELF${items.length ? ` (${items.length})` : ""}</span>${adding ? `<span class="by">adding ${adding}…</span>` : ""}${live ? `<button class="btn-s addbtn" type="button" data-shelf-add aria-expanded="${addOpen}">${addOpen ? "CLOSE" : "+ ADD"}</button>` : ""}`);
  const folder = d?.folder ? `<div class="rfolder" title="The room's folder on the HUD's disk. A file saved in its files/ shows here.">FOLDER <code>${esc(d.folder)}/files/</code></div>` : "";
  setHTML(el.querySelector(".rshitems"), (items.length
    ? `<div class="cards">${[...items].reverse().map(cardHtml).join("")}</div>`
    : `<div class="none">Nothing on the shelf yet. Add a file or a link here, drop files on the room, or a lane adds them with hud room artifact.</div>`) + folder);
}

// ---- adding to the shelf, as the owner: files (picked, dropped or pasted) and links ----

const MAX_FILE = 25 * 1024 * 1024;
export async function addToShelf(files) {
  const slug = openSlug, r = roomOf(slug);
  if (!r || r.archivedAt) { toast("THIS ROOM IS ARCHIVED."); return; }
  const list = [...files].filter((f) => f.size > 0 || f.name);
  if (!list.length) return;
  adding += list.length;
  renderShelf(detail?.slug === slug ? detail : null, r);
  const added = [];
  await Promise.all(list.map(async (f) => {
    const name = f.name || "file";
    try {
      if (f.size > MAX_FILE) throw new Error(`${name} is over 25 MB`);
      const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}/files?name=${encodeURIComponent(name)}&as=owner`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream", "x-hud": "1" }, body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      added.push(data.name);
    } catch (err) { toast(`NOT ADDED: ${err.message}`); }
  }));
  adding -= list.length;
  if (added.length) toast(added.length === 1 ? `ON THE SHELF: ${added[0]}` : `${added.length} FILES ON THE SHELF.`);
  if (openSlug === slug) renderShelf(detail?.slug === slug ? detail : null, roomOf(slug));
}
async function addLinkFrom(form) {
  const url = form.url.value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { toast("A LINK STARTS WITH HTTP:// OR HTTPS://"); form.url.focus(); return; }
  const title = form.title.value.trim() || (() => { try { const u = new URL(url); return (u.host + u.pathname).replace(/\/$/, ""); } catch { return url; } })();
  try {
    await post(`/api/rooms/${encodeURIComponent(openSlug)}/artifacts`, { url, title, as: "owner" });
    form.reset();
    toast(`ON THE SHELF: ${title}`);
  } catch (err) { toast(err.message); }
}

// A room's send box puts its images and files in the room's folder, so they land on the shelf too, by you. One
// removed from the box before sending comes off the shelf again.
uploadTarget("room:", {
  url: (k, name) => `/api/rooms/${encodeURIComponent(k.slice(5))}/files?name=${encodeURIComponent(name)}&as=owner&attach=1`,
  remove: (k, a) => post(`/api/rooms/${encodeURIComponent(k.slice(5))}/artifacts/${a.ref}/remove`, {}).catch(() => {}),
});

// The send box's panel is a drop zone for the message (images.js).
part("rsend").setAttribute("data-drop", "");

// ---- the thread ----

function deliveryHtml(m) {
  if (m.delivery === "sent") return `<span class="seen ok">DELIVERED</span>`;
  if (m.delivery === "away") return `<span class="seen kept" title="Kept: it goes to ${esc(m.to)} when herdr sees the lane again">AWAY · KEPT</span>`;
  if (m.delivery === "failed") return `<span class="seen bad" title="${esc(m.error || "")}">NOT DELIVERED</span><button class="btn-s" type="button" data-room-retry="${m.id}">RETRY</button>`;
  return `<span class="seen">SENDING…</span>`;
}
// A message's text as markdown with its line breaks kept. A long one shows its first part and MORE.
const textHtml = (m) => mdClip(m.text, `room${m.id}`, 600);
function messageHtml(m, byId, live) {
  const lane = m.who !== "owner";
  const p = m.reply ? byId.get(m.reply) : null;
  const quote = p ? `<div class="quote">↩ ${p.who === "owner" ? "you" : esc(p.who)} ${clock(p.at)}: ${mdInline(short(p.text, 80), { links: false })}</div>` : m.reply ? `<div class="quote">↩ an earlier message</div>` : "";
  return `<article class="msg ${lane ? "lane" : "you"}${lane && (!m.read || fresh.has(m.id)) ? " unread" : ""}" data-rmsg="${m.id}">
      <div class="meta"><span class="who">${lane ? esc(m.who) : "YOU"}</span>${lane ? "" : `<span class="to">→ ${esc(m.to)}</span>`}<span class="tag">${clock(m.at)}</span>${lane ? "" : deliveryHtml(m)}${lane && live ? `<button class="btn-s" type="button" data-room-reply="${m.id}">REPLY</button>` : ""}</div>
      ${quote}<div class="text md">${textHtml(m)}</div>
    </article>`;
}
const thread = part("rthread");
let atEnd = true; // at the thread's end it stays there while the room settles around it (fonts, an image)
// The page's own move to the end fires a scroll event a frame later, by when the room may have changed size around
// the thread: that event is not you scrolling away from the end, so it leaves atEnd as it is.
let setTop = -1;
function toBottom() { thread.scrollTop = thread.scrollHeight; setTop = thread.scrollTop; }
function renderThread(d, r) {
  if (!d) { setHTML(thread, `<div class="empty">LOADING…</div>`); return; }
  for (const m of d.messages) if (m.who !== "owner" && !m.read) fresh.add(m.id);
  const byId = new Map(d.messages.map((m) => [m.id, m]));
  const html = (d.earlier ? `<div class="earlier">${d.earlier} EARLIER ${d.earlier === 1 ? "MESSAGE" : "MESSAGES"} NOT SHOWN</div>` : "")
    + (d.messages.map((m) => messageHtml(m, byId, !r.archivedAt)).join("") || `<div class="empty">No messages yet. Write to ${esc(r.owner)} below: it is typed into the lane, and its reply lands here.</div>`);
  // At the newest message (just opened, or within 40px of it), stay on it; reading older ones, what you read stays put.
  const pinned = stick || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40, place = pinned ? null : keepScroll(thread, "data-rmsg");
  setHTML(thread, html);
  if (pinned) toBottom(); else place();
  atEnd = pinned || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  stick = false;
  showEdges(thread);
}

// ---- the send box ----

const lanesOf = (r) => [r.owner, ...r.members];
function renderSend(r) {
  const el = part("rsend");
  const d = draft(r.slug);
  if (!lanesOf(r).includes(d.to)) d.to = r.owner;
  if (r.archivedAt) {
    sendFor = null;
    setHTML(el, `<div class="none">This room is archived. HQ reopens it with hud room create ${esc(r.slug)}.</div>`);
    return;
  }
  const options = lanesOf(r).map((n) => `<option value="${esc(n)}"${n === d.to ? " selected" : ""}>${esc(n)}${n === r.owner ? " (owner)" : ""}${laneInfo(n).away ? " · away" : ""}</option>`).join("");
  if (sendFor !== r.slug) {
    sendFor = r.slug;
    el.innerHTML = `<div class="rto"><label>TO <select data-room-to aria-label="Send to">${options}</select></label><span class="tostate"></span></div>
      <div class="rquote"></div>
      ${composer(key(r.slug), `<textarea rows="1" placeholder="Write to the lane. ⌘↩ sends.">${esc(d.text)}</textarea>`, `<button class="send go" type="button" data-room-send>SEND</button>`)}`;
  } else {
    // Not while it is open (it has focus): rewriting its options would close it or move the highlight under the
    // pointer. It catches up when it closes (the blur listener below).
    const sel = el.querySelector("[data-room-to]");
    if (sel.innerHTML !== options && document.activeElement !== sel) { sel.innerHTML = options; sel.value = d.to; }
  }
  const away = laneInfo(d.to).away;
  setHTML(el.querySelector(".tostate"), away ? `<span class="aw">AWAY</span> kept until the lane is back` : `typed into ${esc(d.to)}`);
  const p = d.reply && detail?.messages.find((m) => m.id === d.reply);
  setHTML(el.querySelector(".rquote"), p ? `<span>↩ ${esc(p.who)} ${clock(p.at)}: ${mdInline(short(p.text, 70), { links: false })}</span><button class="btn-s" type="button" data-room-unreply aria-label="Do not reply to it">×</button>` : "");
  sendState();
}
function sendState() {
  const btn = part("rsend").querySelector("[data-room-send]");
  if (btn && openSlug) btn.disabled = !draft(openSlug).text.trim() && !hasImages(key(openSlug));
}

// ---- drawing the room ----

function renderRoom() {
  const r = roomOf(openSlug);
  if (!r) return;
  const d = detail?.slug === r.slug ? detail : null;
  renderBar(r);
  renderHead(r, d);
  renderTop(r);
  renderBrief(d);
  renderShelf(d, r);
  renderThread(d, r);
  renderSend(r);
  renderStrip(r);
  // Seen: its lanes' messages stop counting as new (the tint stays until you leave the room).
  if (d && r.unread && seenSent.get(r.slug) !== r.rev && document.visibilityState === "visible") {
    seenSent.set(r.slug, r.rev);
    post(`/api/rooms/${encodeURIComponent(r.slug)}/seen`, {}).catch(() => seenSent.delete(r.slug));
  }
}

async function fetchRoom(slug) {
  const r = roomOf(slug);
  if (!r || (detail?.slug === slug && detail.rev === r.rev)) return;
  const want = `${slug}@${r.rev}`;
  if (fetching === want) return;
  fetching = want;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(slug)}`);
    if (res.ok && openSlug === slug) { detail = await res.json(); renderRoom(); }
  } catch {} finally { if (fetching === want) fetching = ""; }
}

function render() {
  renderCount();
  if (!S) return;
  route();
  if (qTab === "rooms") renderList();
  if (!openSlug) return;
  renderRoom();
  fetchRoom(openSlug);
}

// ---- where you are: the address says it (#room/SLUG), and the page follows it ----

const slugInHash = () => { const m = location.hash.match(/^#room\/([a-z0-9][a-z0-9-]{0,47})$/); return m ? m[1] : null; };
function setPtab(t) {
  view.dataset.pane = t;
  for (const b of view.querySelectorAll("[data-ptab]")) { b.classList.toggle("on", b.dataset.ptab === t); b.setAttribute("aria-selected", String(b.dataset.ptab === t)); }
}
function show(slug) {
  if (openSlug !== slug) { detail = null; fresh.clear(); stick = true; atEnd = true; sendFor = null; shelfFor = null; pixKey = ""; setPtab("chat"); }
  openSlug = slug;
  view.hidden = !slug;
  stage.classList.toggle("inroom", !!slug);
  document.documentElement.classList.toggle("roomopen", !!slug);
  emit("stage", slug ? "room" : "office"); // the office's frame loop rests while a room covers it (room/loop.js)
  fitViewport();
  if (qTab === "rooms") renderList();
}
// Follows the address: on load, on every state and whenever the address changes.
function route() {
  const slug = slugInHash();
  if (slug === openSlug || (slug && !S)) return; // a room's summary comes with the first state
  if (slug && !roomOf(slug)) {
    toast(`NO ROOM ${slug.toUpperCase()}`);
    history.replaceState(null, "", location.pathname + location.search);
    if (openSlug) show(null);
    return;
  }
  show(slug);
  if (slug) { renderRoom(); fetchRoom(slug); }
}
// Going to a room from the office adds a step to the browser's history; moving from room to room replaces it, so
// one BACK always lands in the office.
export function goRoom(slug) {
  if (slugInHash() === slug) { route(); return; }
  const url = `${location.pathname}${location.search}#room/${slug}`;
  if (slugInHash()) history.replaceState(history.state, "", url);
  else history.pushState({ hqRoom: true }, "", url);
  route();
}
export function leaveRoom() {
  if (!slugInHash()) { route(); return; }
  if (history.state?.hqRoom) { history.back(); return; } // popstate routes
  history.replaceState(null, "", location.pathname + location.search);
  route();
}
addEventListener("popstate", route);
addEventListener("hashchange", route);

// On a full-screen room the send box stays above the keyboard: the view follows the visible part of the screen.
const vv = window.visualViewport;
function fitViewport() {
  if (!vv) return;
  if (!openSlug || !fullScreen.matches) { view.style.removeProperty("--vvh"); view.style.removeProperty("--vvt"); view.classList.remove("typing"); return; }
  view.style.setProperty("--vvh", `${vv.height}px`);
  view.style.setProperty("--vvt", `${vv.offsetTop}px`);
  view.classList.toggle("typing", vv.height < innerHeight * 0.75); // the keyboard is up: the strip steps aside
}
vv?.addEventListener("resize", fitViewport);
vv?.addEventListener("scroll", fitViewport);
fullScreen.addEventListener("change", () => { fitViewport(); if (openSlug) renderStrip(roomOf(openSlug)); });

// ---- sending ----

async function send(btn) {
  const slug = openSlug, d = draft(slug), k = key(slug);
  const text = withImages(k, d.text.trim());
  if (!text) return;
  const wait = notReady(k);
  if (wait) { toast(wait); return; }
  btn.disabled = true;
  try {
    await post(`/api/rooms/${encodeURIComponent(slug)}/post`, { text, to: d.to, reply: d.reply });
    toast(laneInfo(d.to).away ? `KEPT FOR ${d.to.toUpperCase()}: IT IS AWAY.` : `SENT TO ${d.to.toUpperCase()}.`);
    d.text = "";
    d.reply = null;
    clearImages(k);
    const ta = part("rsend").querySelector("textarea");
    if (ta) ta.value = "";
    stick = true;
    renderSend(roomOf(slug));
  } catch (err) { toast(err.message); btn.disabled = false; }
}

// ---- input ----

box.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-select]") || t.closest("a")) return; // a lane chip selects its worker; a link opens
  const row = t.closest("[data-room]");
  if (row) goRoom(row.dataset.room);
});
box.addEventListener("keydown", (e) => {
  const row = e.target.closest?.("[data-room]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); goRoom(row.dataset.room); }
});
view.addEventListener("click", (e) => {
  const t = e.target;
  // A lane chip selects its worker (core/clicks.js); its card is in the office, so go there.
  if (t.closest("[data-select]")) { leaveRoom(); return; }
  const go = t.closest("[data-room-go]");
  if (go) { e.preventDefault(); goRoom(go.dataset.roomGo); return; }
  if (t.closest("a")) return;
  if (t.closest("[data-room-back]")) { leaveRoom(); return; }
  const tab = t.closest("[data-ptab]");
  if (tab) {
    setPtab(tab.dataset.ptab);
    if (tab.dataset.ptab === "chat") toEnd();
    return;
  }
  if (t.closest("[data-rail-toggle]")) {
    railFolded = !railFolded;
    store("hq-room-rail", railFolded ? "folded" : null);
    renderHead(roomOf(openSlug), detail);
    return;
  }
  if (t.closest("[data-room-close]")) { closeAsk = openSlug; renderHead(roomOf(openSlug), detail); return; }
  if (t.closest("[data-close-keep]")) { closeAsk = null; renderHead(roomOf(openSlug), detail); return; }
  const yes = t.closest("[data-close-yes]");
  if (yes) {
    yes.disabled = true;
    const slug = openSlug;
    post(`/api/rooms/${encodeURIComponent(slug)}/archive`, { by: "owner" })
      .then(() => { closeAsk = null; toast("ROOM CLOSED. IT IS UNDER ARCHIVED IN ROOMS."); })
      .catch((err) => { yes.disabled = false; toast(err.message); });
    return;
  }
  if (t.closest("[data-shelf-add]")) {
    addOpen = !addOpen;
    renderShelf(detail, roomOf(openSlug));
    // On a desktop the link field is ready to type in; on a phone a keyboard would cover the picker.
    if (addOpen && !fullScreen.matches) part("rshelf").querySelector(".radd input[type=url]")?.focus({ preventScroll: true });
    return;
  }
  const art = t.closest("[data-art-preview]");
  if (art) { const a = detail?.artifactList.find((x) => String(x.id) === art.dataset.artPreview); if (a) openPreview(a.url, a.title); return; }
  const reply = t.closest("[data-room-reply]");
  if (reply) {
    const m = detail?.messages.find((x) => String(x.id) === reply.dataset.roomReply), d = draft(openSlug);
    if (m) { d.reply = m.id; if (lanesOf(roomOf(openSlug)).includes(m.who)) d.to = m.who; }
    renderSend(roomOf(openSlug));
    part("rsend").querySelector("textarea")?.focus({ preventScroll: true });
    return;
  }
  if (t.closest("[data-room-unreply]")) { draft(openSlug).reply = null; renderSend(roomOf(openSlug)); return; }
  const retry = t.closest("[data-room-retry]");
  if (retry) { retry.disabled = true; post(`/api/rooms/${encodeURIComponent(openSlug)}/messages/${retry.dataset.roomRetry}/retry`, {}).catch((err) => { toast(err.message); retry.disabled = false; }); return; }
  const sendBtn = t.closest("[data-room-send]");
  if (sendBtn) { send(sendBtn); return; }
  // MORE / LESS on a long message: core/clicks.js flips it after this handler; draw the thread once it has.
  if (t.closest(".more[data-more]")) setTimeout(() => detail && renderThread(detail, roomOf(openSlug)), 0);
});
view.addEventListener("keydown", (e) => {
  if (!e.target.closest?.(".rsend")) return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) part("rsend").querySelector("[data-room-send]")?.click();
  if (e.key === "Escape" && openSlug && draft(openSlug).reply) { e.preventDefault(); draft(openSlug).reply = null; renderSend(roomOf(openSlug)); }
});
// Esc goes back to the office, unless something over the room takes it first (a preview, SETTINGS, a reply being
// set up) or you are typing in the question column.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !openSlug || e.defaultPrevented) return;
  if (document.querySelector("dialog[open]") || !$("settings").hidden) return;
  const f = document.activeElement;
  if (f && !view.contains(f) && f.matches("input, textarea, select, [contenteditable]")) return;
  leaveRoom();
});
view.addEventListener("input", (e) => {
  if (e.target.tagName !== "TEXTAREA" || !openSlug || !e.target.closest(".rsend")) return;
  draft(openSlug).text = e.target.value;
  sendState();
});
view.addEventListener("submit", (e) => {
  if (!e.target.matches(".radd")) return;
  e.preventDefault();
  addLinkFrom(e.target);
});
view.addEventListener("change", (e) => {
  if (e.target.matches("[data-shelf-file]")) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    addToShelf(files);
    return;
  }
  if (!e.target.matches("[data-room-to]") || !openSlug) return;
  draft(openSlug).to = e.target.value;
  renderSend(roomOf(openSlug));
});
// The TO dropdown catches up with lanes that came, went or changed while it was open (renderSend leaves it alone then).
document.addEventListener("focusout", (e) => { if (e.target.matches?.("[data-room-to]") && openSlug) setTimeout(() => renderSend(roomOf(openSlug)), 0); });
const toEnd = () => { if (atEnd && openSlug) toBottom(); };
thread.addEventListener("scroll", () => {
  if (thread.scrollTop !== setTop) atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  setTop = -1;
  showEdges(thread);
}, { passive: true });
thread.addEventListener("load", toEnd, true);
new ResizeObserver(toEnd).observe(thread);
// The strip follows its own width (the rail folding, the window) and redraws only when that changes what it shows.
new ResizeObserver(() => { if (openSlug) renderStrip(roomOf(openSlug)); }).observe(pix);
document.fonts?.addEventListener?.("loadingdone", () => { if (openSlug) renderStrip(roomOf(openSlug)); });
// Files dropped anywhere on the room go on the shelf. Images and files dropped on the send box, or around it (its TO
// row), are attached to the message instead (images.js; they reach the shelf that way too). Listening first
// (capture) keeps a drop on the room from joining Tell HQ's tray, and a file from opening in place of the page.
const fileItems = (dt) => [...(dt?.items ?? [])].filter((i) => i.kind === "file");
const forMessage = (e, list) => !!e.target.closest?.(".rsend")?.querySelector("[data-composer]") && list.length > 0;
const clearDrop = () => view.classList.remove("dropping");
document.addEventListener("dragover", (e) => {
  if (!openSlug || !view.contains(e.target) || !fileItems(e.dataTransfer).length) return;
  e.preventDefault();
  if (forMessage(e, fileItems(e.dataTransfer))) { clearDrop(); return; }
  e.stopPropagation();
  if (!roomOf(openSlug)?.archivedAt) view.classList.add("dropping");
}, true);
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget || !view.contains(e.relatedTarget)) clearDrop(); }, true);
document.addEventListener("drop", (e) => {
  clearDrop();
  if (!openSlug || !view.contains(e.target)) return;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  if (forMessage(e, files)) return;
  e.stopPropagation();
  addToShelf(files);
}, true);
// Pasting a file or an image while a room is open, and not into a text box elsewhere on the page or into the room's
// send box (which attaches it to the message), puts it on the shelf.
document.addEventListener("paste", (e) => {
  if (!openSlug || view.hidden) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  const f = document.activeElement;
  if (f?.closest?.(".rsend [data-composer]")) return;
  if (f && !view.contains(f) && f.matches("input, textarea, [contenteditable]")) return;
  e.preventDefault();
  e.stopPropagation();
  addToShelf(files);
}, true);
on("attach", (k) => { if (openSlug && k === key(openSlug)) sendState(); });
on("state", render);
// The page loads its feature folders after its first state may already be in: follow the address now too.
if (S) render();
on("scope", () => { renderCount(); if (qTab === "rooms") renderList(); });
on("settings", () => { if (openSlug) renderStrip(roomOf(openSlug)); });
on("qtab", (t) => { if (t === "rooms") render(); });
