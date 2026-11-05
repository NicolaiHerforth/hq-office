// DONE MEANS: a room linked to a Linear project shows the project's acceptance criteria (its issues labelled
// "acceptance", read by the server into S.acceptance[SLUG]): how many are closed in Linear, a bar, and each
// milestone's items. Closed is what Linear says, not proof: PMs close a criterion once it is walked on production.
// A room with no project shows one quiet line to link one. On the ROOMS tab a linked room's tile shows the project
// and its count. It hooks in on rooms/ ("room:open", "rooms:list") and draws again on every "state"; the age of the
// data follows the page clock (data-since, data-ago).
import { toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { ago, esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { on } from "../core/bus.js";
import { mdInline } from "../core/markdown.js";
import { openRoom } from "../rooms/index.js";

const roomOf = (slug) => (S?.rooms ?? []).find((r) => r.slug === slug) ?? null;
const isClosed = (i) => i.stateType === "completed";
const CLOSED = "Closed in Linear. PMs close a criterion after it's walked on production.";
const counted = (i) => i.stateType !== "canceled";

// The server's errors, in words the owner can act on. In the panel the last good list stays under them.
const SAY = {
  "no Linear key": "Linear isn't connected yet: HQ asked for a key.",
  "project not found": "Linear can't find this project any more. It may have been deleted, or the key can't see it.",
};
const errorText = (e) => SAY[e] ?? `Linear didn't answer: ${e.replace(/^Linear:\s*/, "")}`;

// Closed items fold away until the viewer asks for them: what is left is what the room is working on.
const CLOSED_KEY = "hq-acc-closed";
let showClosed = (() => { try { return localStorage.getItem(CLOSED_KEY) === "1"; } catch { return false; } })();

const pct = (closed, total) => (total ? Math.round((closed / total) * 100) : 0);
const bar = (closed, total) => `<div class="accbar" role="progressbar" aria-label="${closed} of ${total} acceptance criteria closed in Linear" title="${CLOSED}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${closed}"><i style="width:${pct(closed, total)}%"></i></div>`;

function itemHtml(i) {
  const cls = isClosed(i) ? "closed" : counted(i) ? "open" : "gone";
  return `<li class="accitem ${cls}"><span class="accmark" aria-label="${isClosed(i) ? "closed" : counted(i) ? "open" : "canceled"}">${isClosed(i) ? "✓" : counted(i) ? "○" : "×"}</span><span class="acctitle">${mdInline(i.title, { links: false })}</span><span class="accmeta"><a class="acckey" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.key)}</a> · ${esc(i.state)}</span></li>`;
}
function milestoneHtml(m) {
  const items = m.items.filter(counted), closed = items.filter(isClosed).length;
  const shown = showClosed ? m.items : m.items.filter((i) => !isClosed(i) && counted(i));
  const done = items.length > 0 && closed === items.length;
  return `<div class="accms${done ? " done" : ""}"><div class="accmh"><b>${m.name == null ? "NO MILESTONE" : mdInline(m.name, { links: false })}</b><span title="${CLOSED}">${done ? "✓ " : ""}${closed}/${items.length}</span></div>${shown.length ? `<ul>${shown.map(itemHtml).join("")}</ul>` : ""}</div>`;
}

function panelHtml(a) {
  const head = `<div class="k"><span>DONE MEANS</span><a class="accproj" href="${esc(a.project.url)}" target="_blank" rel="noopener" title="Open the project in Linear">${esc(a.project.name)} ↗</a></div>`;
  const err = a.error ? `<div class="accerr" role="status">${esc(errorText(a.error))}</div>` : "";
  const when = a.fetchedAt ? `<span class="accwhen">updated <span data-since="${a.fetchedAt}" data-ago>${ago(Date.now() - a.fetchedAt)}</span> ago</span>` : "";
  if (!a.fetchedAt) return head + err + (a.error ? "" : `<div class="none">Reading the project from Linear…</div>`);
  if (!a.total) return head + err + `<div class="none">No acceptance criteria yet. In Linear, label the project's issues <b>acceptance</b> and they show here.</div><div class="accfoot">${when}</div>`;
  const closedN = a.milestones.flatMap((m) => m.items).filter(isClosed).length;
  const toggle = closedN ? `<button class="btn-s accshow" type="button" data-acc-closed aria-pressed="${showClosed}">${showClosed ? "HIDE CLOSED" : `SHOW CLOSED (${closedN})`}</button>` : "";
  return head + err
    + bar(a.met, a.total)
    + `<div class="accsum"><b title="${CLOSED}">${a.met} of ${a.total} closed</b>${when}${toggle}</div>`
    + a.milestones.filter((m) => m.items.length).map(milestoneHtml).join("");
}

// ---- the panel in an open room ----

let at = null; // { slug, mount, el, form }: the open room's panel
function attach(r) {
  const el = document.createElement("section");
  el.className = "acc";
  el.setAttribute("aria-label", "Done means");
  el.innerHTML = `<div class="accbody"></div>
    <form class="acclink" autocomplete="off" hidden>
      <input type="url" name="ref" inputmode="url" placeholder="Paste a Linear project URL" aria-label="Linear project URL" title="Link this room to a Linear project: its acceptance criteria show here">
      <button class="btn-s" type="submit">LINK</button>
    </form>`;
  r.mount.append(el);
  at = { ...r, el, body: el.querySelector(".accbody"), form: el.querySelector(".acclink") };
  render();
}
function render() {
  if (!at?.el.isConnected) return;
  const room = roomOf(at.slug), a = S?.acceptance?.[at.slug];
  // A server without acceptance (no S.acceptance at all) shows nothing; nor does an archived room with no project.
  const none = !S || S.acceptance === undefined || !room || (!a && room.archivedAt);
  at.el.hidden = none;
  if (none) return;
  at.form.hidden = !!a;
  at.el.classList.toggle("linked", !!a);
  setHTML(at.body, a ? panelHtml(a) : "");
}

async function link(form) {
  const ref = form.ref.value.trim(), slug = at?.slug;
  if (!ref || !slug) { form.ref.focus(); return; }
  const btn = form.querySelector("button");
  btn.disabled = true;
  try {
    const res = await post(`/api/rooms/${encodeURIComponent(slug)}/project`, { ref, by: "owner" });
    form.reset();
    toast(res?.project ? `LINKED TO ${res.project.name.toUpperCase()}.` : "LINKED.");
  } catch (err) { toast(SAY[err.message] ?? err.message); } finally { btn.disabled = false; }
}

document.addEventListener("submit", (e) => {
  if (!e.target.matches?.(".acclink")) return;
  e.preventDefault();
  link(e.target);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("[data-acc-closed]")) return;
  showClosed = !showClosed;
  try { localStorage.setItem(CLOSED_KEY, showClosed ? "1" : "0"); } catch {}
  render();
});

// ---- the tiles on the ROOMS tab ----

function tiles(list) {
  const acc = S?.acceptance ?? {};
  for (const row of list.querySelectorAll("article[data-room]")) {
    const a = acc[row.dataset.room];
    let t = row.querySelector(":scope > .acctile");
    if (!a) { t?.remove(); continue; }
    if (!t) { t = document.createElement("div"); t.className = "acctile"; row.append(t); }
    setHTML(t, `<span class="accname">${esc(a.project.name)}</span>${a.total ? `${bar(a.met, a.total)}<b title="${CLOSED}">${a.met}/${a.total}</b>` : `<b class="none">NO CRITERIA</b>`}${a.error ? `<span class="accwarn" title="${esc(errorText(a.error))}">!</span>` : ""}`);
  }
}

on("room:open", attach);
on("rooms:list", tiles);
on("state", render);
const r = openRoom();
if (r) attach(r);
const list = document.querySelector("#rooms .rlist");
if (list && S) tiles(list);
