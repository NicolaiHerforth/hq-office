// Small pure helpers: HTML escaping, durations, clock times, the name hash.
// DOM writes only when the value changes: a write of the same text or HTML still costs a style and layout pass.
const shownHTML = new WeakMap();
export function setHTML(el, html) {
  if (shownHTML.get(el) === html) return false;
  shownHTML.set(el, html);
  el.innerHTML = html;
  return true;
}
export function setText(el, text) { if (el.textContent !== String(text)) el.textContent = text; }
export function setClass(el, cls) { if (el.className !== cls) el.className = cls; }
export function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
export function dur(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d${h % 24}h`;
  if (h) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${m}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
}
// A coarse age for a reading that changes by the minute: "4 min", "2h", "3d".
export function ago(ms) {
  const m = Math.max(1, Math.floor(Math.max(0, ms) / 60000)), h = Math.floor(m / 60);
  return m < 60 ? `${m} min` : h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
export function clock(t) { return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
export function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
