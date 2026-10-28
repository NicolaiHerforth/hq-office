// The accounts panel: each machine's Claude and Codex accounts, what each has left, and grazr's swap. The ACCOUNTS
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
  return `<div class="acct${a.active ? " active" : ""}">
    <div class="ahead"><b>${esc(a.name)}</b>${a.active ? `<span class="tag on">ACTIVE</span>` : ""}${a.out ? `<span class="tag out">OUT</span>` : a.low ? `<span class="tag low">LOW</span>` : ""}</div>
    ${bars || `<div class="anote">No reading yet.</div>`}
    ${extra ? `<div class="anote">${extra}</div>` : ""}
  </div>`;
}

const CLAUDE_STATE = {
  rotating: ["ROTATING", "ok"],
  dry_run: ["DRY RUN", "low"],
  off: ["ROTATION OFF", "low"],
  one: ["ONE ACCOUNT", "low"],
  none: ["NOTHING ENROLLED", "low"],
  no_grazr: ["NO GRAZR", "low"],
};
const ENROL = "herdr plugin pane open --plugin wazum.grazr --entrypoint enrol";

function claudeCard(m) {
  const c = m.claude;
  const [label, cls] = c.out ? ["AT ITS LIMIT", "out"] : CLAUDE_STATE[c.state];
  const line = {
    rotating: `grazr moves to the next account below ${c.limits.session}% of the 5-hour window or ${c.limits.weekly}% of the week. Running panes switch on their next message, with no restart.`,
    dry_run: "grazr logs what it would do (DRY_RUN=1) and switches nothing.",
    off: "grazr's rotation is off (ENABLED=0). Swap now still works.",
    one: "One account is enrolled, so there is nothing to rotate to.",
    none: "grazr is installed, but no account is enrolled, so it has never rotated.",
    no_grazr: "grazr is not installed here. When this machine's Claude account runs out, its Claude lanes stop until the reset.",
  }[c.state];
  const warn = [
    c.accounts.length && !c.statusLine ? "grazr is not on Claude's status line, so it sees no usage. Run its action “grazr: connect to Claude's status line”." : "",
    c.accounts.length && c.loggedIn && !c.activeEnrolled ? "The login this machine uses now is not enrolled, so grazr can move off it only by hand." : "",
  ].filter(Boolean);
  const steps = c.state === "no_grazr"
    ? ["herdr plugin install wazum/herdr-grazr", ENROL]
    : ["none", "one"].includes(c.state) ? [ENROL] : [];
  const swapNote = c.canSwap ? "to the next account in ACCOUNTS with room" : c.accounts.length > 1 ? "no other account has room" : "nothing to swap to";
  return `<article class="box acard ${c.out ? "out" : ""}">
    <div class="atop"><h3>CLAUDE · ${esc(m.machine.toUpperCase())}</h3><span class="tag ${cls}">${label}</span></div>
    <p class="aline">${esc(line)}</p>
    ${warn.map((w) => `<p class="awarn">${esc(w)}</p>`).join("")}
    ${c.accounts.map((a) => account(a, c.limits, a.listed ? "" : "Not in ACCOUNTS, so grazr never rotates onto it.")).join("")}
    ${steps.length ? `<div class="asteps"><span class="k">TO ROTATE (THE OWNER'S: IT LOGS IN TO AN ACCOUNT)</span>${steps.map((s) => `<code>${esc(s)}</code>`).join("")}<span class="anote">Enrol at least two accounts: S saves this machine's login, L logs in to another.</span></div>` : ""}
    ${c.log.length ? `<div class="alog">${c.log.map((l) => `<div>${esc(l)}</div>`).join("")}</div>` : ""}
    ${c.state === "no_grazr" ? "" : `<div class="aact"><button class="btn" type="button" data-swap="${esc(m.machine)}" ${c.canSwap ? "" : "disabled"}>SWAP NOW</button><span class="anote">${swapNote}</span></div>`}
  </article>`;
}

function codexCard(m) {
  const homes = m.codex;
  const out = homes.some((h) => h.out);
  const usable = homes.filter((h) => h.loggedIn).length;
  const [label, cls] = !homes.length ? ["NOT HERE", ""] : out ? ["AT ITS LIMIT", "out"] : usable > 1 ? [`${usable} ACCOUNTS`, "ok"] : ["ONE ACCOUNT", "low"];
  const limits = { session: 15, weekly: 10 };
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
  let out = 0, low = 0, off = 0, setup = 0;
  for (const m of list) {
    if (!m.ok) { off++; continue; }
    if (m.claude.out || m.codex.some((h) => h.out)) out++;
    else if (m.claude.low || m.codex.some((h) => h.low)) low++;
    else if (!["rotating", "dry_run", "off"].includes(m.claude.state)) setup++;
  }
  return out ? [`${out} OUT`, "bad"] : low ? [`${low} LOW`, "off"] : off ? [`${off} NOT READ`, "off"] : setup ? ["SET UP", "off"] : [list.length ? "OK" : "-", ""];
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
    <p class="afoot">Names and percentages only: never a token, an email or a credential file. Logging in to, adding or paying for an account is the owner's; HQ Office only moves between accounts already logged in.</p>`);
}

panel.addEventListener("click", async (e) => {
  if (e.target.closest("[data-accounts-close]")) return setOpen(false);
  const swap = e.target.closest("[data-swap]");
  if (!swap) return;
  swap.disabled = true;
  try {
    const r = await post("/api/accounts/swap", { machine: swap.dataset.swap });
    toast(r.said || "Swapped");
  } catch (err) {
    toast(`Swap failed: ${err.message}`);
    swap.disabled = false;
  }
});

on("state", render);
