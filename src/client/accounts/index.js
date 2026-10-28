// The accounts panel: each machine's Claude and Codex accounts, what each has left, and a MOVE for each Claude lane. The ACCOUNTS
// box in the top bar opens it over the room; it never covers the questions.
import { on } from "../core/bus.js";
import { $, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { esc, setClass, setHTML } from "../core/format.js";
import { post } from "../core/net.js";

const KEY = "hq.accounts.open";
let open = false;
try { open = localStorage.getItem(KEY) === "1"; } catch {}

const box = document.createElement("button");
box.type = "button";
box.id = "accounts";
box.className = "box health";
$("machines").before(box);

const room = document.querySelector(".room");
const panel = document.createElement("section");
panel.id = "accountsPanel";
panel.className = "accounts";
panel.setAttribute("aria-label", "Accounts");
room.append(panel);

function setOpen(v) {
  open = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch {}
  render();
}
box.addEventListener("click", () => setOpen(!open));

const pct = (w) => (w ? `${w.left}%` : "-");
function when(t) {
  if (!t) return "";
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return t - Date.now() < 20 * 3600_000 ? `resets ${hm}` : `resets ${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}
const level = (w, line) => (!w ? "" : w.left <= 0 ? "out" : w.left < line ? "low" : "");

function bar(label, w, line) {
  if (!w) return "";
  return `<div class="awin"><span class="k">${label}</span><span class="abar ${level(w, line)}"><i style="width:${Math.min(100, Math.max(0, w.left))}%"></i></span><span class="aleft"><b>${pct(w)}</b> left${w.resetsAt ? ` · ${esc(when(w.resetsAt))}` : ""}</span></div>`;
}

function account(a, limits, extra) {
  const bars = bar("5 HOURS", a.session, limits.session) + bar("WEEK", a.weekly, limits.weekly);
  return `<div class="acct">
    <div class="ahead"><b>${esc(a.name)}</b>${a.lanes?.length ? `<span class="tag on">${a.lanes.length} LANE${a.lanes.length > 1 ? "S" : ""}</span>` : ""}${a.out ? `<span class="tag out">OUT</span>` : a.low ? `<span class="tag low">LOW</span>` : ""}</div>
    ${bars || `<div class="anote">No reading yet.</div>`}
    ${extra ? `<div class="anote">${extra}</div>` : ""}
  </div>`;
}

const LIMITS = { session: 15, weekly: 10 };

// One Claude lane: where it runs, and a move to another account that is logged in.
function laneRow(m, l) {
  const targets = m.claude.accounts.filter((a) => a.loggedIn && a.name !== l.account);
  const busy = l.status === "working";
  return `<div class="alane"><b>${esc(l.name)}</b><span class="anote">on ${esc(l.account)}${busy ? " · working: move it when it is idle" : ""}</span>
    <select data-move-to="${esc(l.name)}" aria-label="Move ${esc(l.name)} to" ${targets.length ? "" : "disabled"}>${targets.map((a) => `<option>${esc(a.name)}</option>`).join("")}</select>
    <button class="btn" type="button" data-move="${esc(l.name)}" ${targets.length && !busy ? "" : "disabled"}>MOVE</button></div>`;
}

function claudeCard(m) {
  const c = m.claude;
  const [label, cls] = c.out ? ["AT ITS LIMIT", "out"] : c.low ? ["LOW", "low"] : c.accounts.filter((a) => a.loggedIn).length > 1 ? ["READY TO MOVE", "ok"] : ["ONE ACCOUNT", "low"];
  const login = (a) => (a.mcpNeedsSecret?.length ? `${a.mcpNeedsSecret.length} MCP server${a.mcpNeedsSecret.length > 1 ? "s need" : " needs"} their secret in this home: ${a.mcpNeedsSecret.map(esc).join(", ")}. ` : "") + (a.loggedIn ? "" : `Not logged in. The owner logs in once: <code>CLAUDE_CONFIG_DIR=~/.claude${a.name === "default" ? "" : `-${esc(a.name)}`} claude auth login</code>`);
  return `<article class="box acard ${c.out ? "out" : ""}">
    <div class="atop"><h3>CLAUDE · ${esc(m.machine.toUpperCase())}</h3><span class="tag ${cls}">${label}</span></div>
    <p class="aline">Each Claude account is its own home. A moved lane exits and resumes the same conversation on the other account, once it is idle.</p>
    ${c.accounts.map((a) => account(a, LIMITS, login(a))).join("")}
    ${c.lanes.length ? `<div class="alanes"><span class="k">LANES</span>${c.lanes.map((l) => laneRow(m, l)).join("")}</div>` : ""}
    ${c.canMove ? `<form class="aact" data-make-home><input name="name" placeholder="new account name" aria-label="New account name" pattern="[a-z0-9][a-z0-9\\-]*" maxlength="31" required><button class="btn" type="submit">MAKE A HOME</button><span class="anote">An empty home; the owner logs in to it once.</span></form>` : ""}
  </article>`;
}

function codexCard(m) {
  const homes = m.codex;
  const out = homes.some((h) => h.out);
  const usable = homes.filter((h) => h.loggedIn).length;
  const [label, cls] = !homes.length ? ["NOT HERE", ""] : out ? ["AT ITS LIMIT", "out"] : usable > 1 ? [`${usable} ACCOUNTS`, "ok"] : ["ONE ACCOUNT", "low"];
  const limits = LIMITS;
  const note = (h) => [
    h.loggedIn ? "" : "Not logged in. The owner logs it in with codex login.",
    h.sharesSessionsWith.length && !h.readingAt ? `Shares its sessions with ${h.sharesSessionsWith.map(esc).join(", ")}; its own usage shows once a pane runs on it.` : "",
    h.readingAt ? `Read from the newest Codex session, ${esc(new Date(h.readingAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))}.` : "",
  ].filter(Boolean).join(" ");
  return `<article class="box acard ${out ? "out" : ""}">
    <div class="atop"><h3>CODEX · ${esc(m.machine.toUpperCase())}</h3><span class="tag ${cls}">${label}</span></div>
    <p class="aline">${homes.length ? "Each Codex account is its own Codex home. A running Codex pane keeps its account until it restarts." : "No Codex home on this machine."}</p>
    ${homes.map((h) => account({ ...h, active: false }, limits, note(h))).join("")}
  </article>`;
}

function machineCards(m) {
  if (!m.ok) return `<article class="box acard"><div class="atop"><h3>${esc(m.machine.toUpperCase())}</h3><span class="tag low">NOT READ</span></div><p class="aline">${esc(m.error)}</p></article>`;
  return claudeCard(m) + codexCard(m);
}

// The box's word: the worst thing on any machine.
function summary(list) {
  let out = 0, low = 0, off = 0;
  for (const m of list) {
    if (!m.ok) { off++; continue; }
    if (m.claude.out || m.codex.some((h) => h.out)) out++;
    else if (m.claude.low || m.codex.some((h) => h.low)) low++;
  }
  return out ? [`${out} OUT`, "bad"] : low ? [`${low} LOW`, "off"] : off ? [`${off} NOT READ`, "off"] : [list.length ? "OK" : "-", ""];
}

function render() {
  const list = S?.accounts ?? [];
  const [word, cls] = summary(list);
  setClass(box, `box health ${cls}${open ? " open" : ""}`);
  box.setAttribute("aria-expanded", String(open));
  setHTML(box, `<span class="k">ACCOUNTS</span><span class="v">${esc(word)}</span>`);
  room.classList.toggle("accounts-open", open);
  if (!open) return setHTML(panel, "");
  setHTML(panel, `<div class="ahdr"><h2>ACCOUNTS</h2><button class="btn" type="button" data-accounts-close>BACK TO THE ROOM</button></div>
    ${list.map((m) => `<div class="amach">${machineCards(m)}</div>`).join("")}
    <p class="afoot">Names and percentages only: never a token, an email or a credential file. Logging in to, adding or paying for an account is the owner's; HQ Office only moves a lane between accounts already logged in, and never answers a limit or credits dialog.</p>`);
}

panel.addEventListener("click", async (e) => {
  if (e.target.closest("[data-accounts-close]")) return setOpen(false);
  const move = e.target.closest("[data-move]");
  if (!move) return;
  const lane = move.dataset.move;
  const account = panel.querySelector(`select[data-move-to="${CSS.escape(lane)}"]`)?.value;
  move.disabled = true;
  try {
    toast((await post("/api/accounts/move", { lane, account })).said || "Moved");
  } catch (err) {
    toast(`Not moved: ${err.message}`);
  }
  move.disabled = false;
});

panel.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-make-home]");
  if (!form) return;
  e.preventDefault();
  try {
    toast((await post("/api/accounts/home", { name: form.elements.name.value.trim() })).said || "Made");
  } catch (err) {
    toast(`No home made: ${err.message}`);
  }
});

on("state", render);
