// The SECRETS panel (MENU › SECRETS, over the stage): paste a value, see names and deadlines (with the date), and
// the names a restart lost. Esc or ✕ closes it.
import { $, overOffice, toast } from "../core/dom.js";
import { S } from "../core/state.js";
import { clock, esc, setHTML } from "../core/format.js";
import { post } from "../core/net.js";
import { atText, expiresText } from "./expiry.js";

// The owner pastes a value, names it and gives it minutes. HQ reads it with  hud secret get NAME | <command>  until then.
// The page sees names and times. A value comes to it only on a click of COPY, straight to the clipboard: never into
// the page, the state or storage.
export const liveSecrets = () => (S?.secrets ?? []).filter((x) => x.expiresAt > Date.now());
// Names the server lost in a restart (crash or kill) before their deadline: said in red until set again or dismissed.
export const lostSecrets = () => (S?.secretsLost ?? []).filter((x) => x.expiresAt > Date.now());
export function renderSecrets() {
  const lost = lostSecrets().map((x) => `<div class="sitem lost" data-secret-row="${esc(x.name)}">
      <b>${esc(x.name)}</b><span class="tag lost">LOST</span>
      <span class="why">lost in a restart at ${esc(restartAt(x.lostAt))}, set it again</span>
      <button class="btn-s" type="button" data-secret-rm="${esc(x.name)}">DISMISS</button>
    </div>`).join("");
  const rows = liveSecrets().map((x) => `<div class="sitem" data-secret-row="${esc(x.name)}">
      <b>${esc(x.name)}</b><span class="tag">${esc(x.by.toUpperCase())}</span><span class="sk">SET ${clock(x.setAt)}</span>
      <span class="left" data-exp="${x.expiresAt}"></span>
      <button class="btn-s" type="button" data-secret-copy="${esc(x.name)}">COPY</button>
      <button class="btn-s" type="button" data-secret-rm="${esc(x.name)}">DELETE</button>
    </div>`).join("");
  setHTML($("secretList"), lost + rows || `<div class="hint">No secrets. Name one, give it minutes and paste the value. HQ reads it with <code>hud secret get NAME | &lt;command&gt;</code> until it expires. A restart of the plugin hands them over; a crash loses them, and they show here as lost.</div>`);
  renderSecretTimes();
}
// "13:45" today, else "yesterday 13:45" or "Mon 2 Nov, 13:45".
const restartAt = (t) => { const s = atText(t); return s.startsWith("today ") ? s.slice(6) : s; };
export function renderSecretTimes() {
  const now = Date.now();
  for (const el of document.querySelectorAll("#secretList [data-exp]")) {
    const left = Number(el.dataset.exp) - now;
    if (left <= 0) { el.closest(".sitem").remove(); continue; }
    el.textContent = expiresText(Number(el.dataset.exp), now);
    el.classList.toggle("soon", left < 60000);
  }
}
export const secretsOpen = () => !$("secretsPanel").hidden;
export function openSecrets() {
  $("secretsPanel").hidden = false;
  overOffice($("secretsPanel"));
  renderSecrets();
  $("secName").focus();
}
export function closeSecrets() {
  const p = $("secretsPanel");
  if (p.contains(document.activeElement)) document.activeElement.blur();
  p.hidden = true;
}
$("secretsPanel").addEventListener("click", (e) => { if (e.target.closest("[data-secrets-close]")) closeSecrets(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !secretsOpen()) return;
  e.preventDefault(); // the floors' Esc steps out a level only when nothing over the stage is open
  closeSecrets();
});

$("secretForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("secValue").value;
  // Cleared at once, whatever the server says.
  $("secValue").value = "";
  const name = $("secName").value.trim();
  if (!value) { toast("PASTE A VALUE FIRST"); return; }
  try {
    await post("/api/secrets", { name, minutes: Number($("secMin").value), value, by: "owner" });
    $("secName").value = "";
    toast(`SAVED ${name}. HQ CAN READ IT.`);
  } catch (err) { toast(err.message); }
});

// COPY: the value comes from the server for this click only (POST /api/secrets/copy, which answers only this page)
// and goes to the clipboard; it is held in a local for that moment and never written anywhere in the page.
async function valueOf(name) {
  const res = await fetch("/api/secrets/copy", { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ name }), cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `copy refused (${res.status})`);
  return data.value;
}
function copySecret(name, btn) {
  btn.disabled = true;
  const done = (msg) => { btn.disabled = false; toast(msg); };
  // On this machine or over https: the clipboard takes the value as a promise, so the click still counts when it
  // arrives (Safari needs that).
  if (window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem) {
    const item = new ClipboardItem({ "text/plain": valueOf(name).then((v) => new Blob([v], { type: "text/plain" })) });
    navigator.clipboard.write([item]).then(() => done(`COPIED ${name}.`), (err) => done(/refused|no secret/.test(err.message) ? err.message : `COULD NOT COPY ${name}: ${err.message}`));
    return;
  }
  // Plain http from another host: a copy event hands the value to the clipboard without putting it in the page.
  valueOf(name).then((v) => {
    const put = (ev) => { ev.clipboardData.setData("text/plain", v); ev.preventDefault(); };
    document.addEventListener("copy", put, { once: true });
    const ok = document.execCommand("copy");
    document.removeEventListener("copy", put);
    done(ok ? `COPIED ${name}.` : "THE BROWSER WOULD NOT COPY HERE: OPEN THE HUD OVER HTTPS, OR ON THIS MACHINE.");
  }, (err) => done(err.message));
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-secret-copy]");
  if (b) copySecret(b.dataset.secretCopy, b);
});
