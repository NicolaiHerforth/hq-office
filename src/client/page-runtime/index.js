// THE PAGE RUNTIME's HUD side: the bridge between an HTML page in a sandboxed frame (runtime.js runs in it) and the
// server (src/server/page-runtime.ts). A page says hello with window.postMessage and a MessagePort; the bridge takes it
// only from the window of an <iframe> in this document that is sandboxed without allow-same-origin, and works out
// which page it is from that frame's src (rooms/SLUG/files/NAME, rooms/SLUG/brief, briefs/ID), never from what the page
// sends. After that the page and the bridge talk over the port: storage writes, db calls and subscriptions (refetched
// when the page's version in S.pageData moves), and downloads, which the owner confirms here before the HUD saves them.
import { CONFIG, S } from "../core/state.js";
import { on } from "../core/bus.js";

const CAPS = ["db", "user", "downloads"];
const MAX_MESSAGE = 1_100_000; // characters in one message from a page (a document is at most 256 KiB)
const MAX_DOWNLOAD = 25 * 1024 * 1024;
const MAX_CALLS = 60; // calls a page may make in one second
const MAX_SUBS = 64; // live subscriptions per page view, as an artifact has
const REFUSED_EXT = /\.(exe|bat|cmd|com|msi|scr|ps1|vbs|jar|app|dmg|pkg|sh|command|js|mjs|lnk|reg|hta|cpl|msc|dll)$/i;

// The page a frame shows, from its src on this HUD; null for anything else.
export function pageKey(src) {
  let u;
  try { u = new URL(src, location.href); } catch { return null; }
  if (u.origin !== location.origin) return null;
  let m = u.pathname.match(/^\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/files\/([^/]+)$/);
  if (m) {
    let name;
    try { name = decodeURIComponent(m[2]); } catch { return null; }
    return /\.html?$/i.test(name) && !name.startsWith(".") && !/[/\\\0]/.test(name) ? `rooms/${m[1]}/files/${name}` : null;
  }
  if ((m = u.pathname.match(/^\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/brief\.html$/))) return `rooms/${m[1]}/brief`;
  if ((m = u.pathname.match(/^\/briefs\/(\d{1,9})\.html$/))) return `briefs/${m[1]}`;
  return null;
}
const sandboxed = (f) => f.hasAttribute("sandbox") && f.sandbox.contains("allow-scripts") && !f.sandbox.contains("allow-same-origin");

// The server, with the artifact db's error codes kept.
async function rpc(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: res.statusText, code: "unavailable" }));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code || "unavailable" });
  return data;
}
const fail = (e) => ({ code: e?.code || "unavailable", message: e?.message || "refused" });

// One line per page document: { port, frame, source, page, nonce, subs }.
const lines = new Set();
function drop(c) {
  lines.delete(c);
  c.subs.clear();
  try { c.port.close(); } catch {}
}

addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d["hud-page"] !== "hello" || e.origin !== "null") return;
  const port = e.ports?.[0];
  if (!port) return;
  const frame = [...document.querySelectorAll("iframe")].find((f) => f.contentWindow === e.source);
  const page = frame && sandboxed(frame) ? pageKey(frame.getAttribute("src")) : null;
  if (!page || d.page !== page) { port.close(); return; }
  const nonce = String(d.nonce ?? "").slice(0, 64);
  for (const c of [...lines]) {
    if (c.source !== e.source) continue;
    if (c.nonce === nonce) { port.close(); return; } // the same document again: it keeps the line it has
    drop(c); // the frame shows a new document now
  }
  const c = { port, frame, source: e.source, page, nonce, subs: new Map(), seen: S?.pageData?.[page], second: 0, calls: 0 };
  lines.add(c);
  port.onmessage = (m) => handle(c, m.data);
  port.postMessage({ hello: "hud-page", page, caps: CAPS, user: { id: "owner", name: CONFIG.owner || "Owner" } });
});

function size(d) {
  try { return JSON.stringify(d, (k, v) => (v instanceof Blob ? `blob:${v.size}` : v)).length; } catch { return Infinity; }
}
async function handle(c, d) {
  if (!lines.has(c) || !d || typeof d !== "object") return;
  const reply = (value) => c.port.postMessage({ re: d.id, value });
  const refuse = (e) => c.port.postMessage({ re: d.id, error: fail(e) });
  const no = (code, message) => {
    if (d.op === "sub") c.port.postMessage({ snap: d.sub, error: { code, message } });
    else if (d.id) refuse({ code, message });
    else console.warn(`page ${c.page}: ${d.op} refused: ${message}`);
  };
  if (size(d) > MAX_MESSAGE) return no("invalid_argument", "message too large");
  const now = Date.now();
  if (now - c.second >= 1000) { c.second = now; c.calls = 0; }
  if (d.op !== "unsub" && ++c.calls > MAX_CALLS) return no("resource_exhausted", `at most ${MAX_CALLS} calls a second`);
  if (d.op === "sub" && c.subs.size >= MAX_SUBS) return no("resource_exhausted", `at most ${MAX_SUBS} subscriptions`);
  try {
    switch (d.op) {
      case "storage":
        await rpc("/api/page-runtime/storage", { page: c.page, set: d.set, clear: d.clear === true }).catch((e) => console.warn(`page ${c.page}: storage not saved:`, e.message));
        return;
      case "db": {
        const value = await rpc("/api/page-runtime/db", { page: c.page, op: d.dbop, path: d.path, data: d.data, query: d.query, holder: d.holder, ttlMs: d.ttlMs });
        reply(value);
        if (d.dbop !== "get" && d.dbop !== "query") refresh(c.page);
        return;
      }
      case "sub":
        c.subs.set(d.sub, { kind: d.kind === "doc" ? "doc" : "query", path: d.path, query: d.query });
        run(c, d.sub);
        return;
      case "unsub":
        c.subs.delete(d.sub);
        return;
      case "save":
        reply(await save(c, d.filename, d.data));
        return;
    }
    if (d.id) refuse({ code: "invalid_argument", message: `unknown call ${d.op}` });
  } catch (e) {
    if (d.id) refuse(e);
  }
}

// ---- subscriptions: fetched once, then again whenever the page's data moves ----
async function run(c, id) {
  const s = c.subs.get(id);
  if (!s) return;
  try {
    const value = await rpc("/api/page-runtime/db", s.kind === "doc" ? { page: c.page, op: "get", path: s.path } : { page: c.page, op: "query", path: s.path, query: s.query });
    if (c.subs.get(id) === s) c.port.postMessage({ snap: id, value });
  } catch (e) {
    if (c.subs.get(id) !== s) return;
    c.subs.delete(id);
    c.port.postMessage({ snap: id, error: fail(e) });
  }
}
function refresh(page) {
  for (const c of lines) if (c.page === page) for (const id of c.subs.keys()) run(c, id);
}
on("state", (s) => {
  for (const c of [...lines]) {
    if (!c.frame.isConnected || c.frame.contentWindow !== c.source) { drop(c); continue; }
    const v = s.pageData?.[c.page];
    if (v === c.seen) continue;
    c.seen = v;
    for (const id of c.subs.keys()) run(c, id);
  }
});

// ---- downloads: the owner says yes here, then the HUD saves the file ----
const TYPES = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", svg: "image/svg+xml", png: "image/png", pdf: "application/pdf" };
let asking = null;
function save(c, filename, data) {
  const name = String(filename ?? "").trim();
  if (!name || name.length > 200 || /[/\\\0-\x1f]/.test(name) || name.startsWith(".")) throw { code: "bad_request", message: "a file name, without folders" };
  if (REFUSED_EXT.test(name)) throw { code: "rejected_extension", message: `the HUD does not save ${name.split(".").pop()} files` };
  const type = TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  const blob = data instanceof Blob ? data : typeof data === "string" ? new Blob([data], { type }) : null;
  if (!blob) throw { code: "bad_request", message: "nothing to save" };
  if (blob.size > MAX_DOWNLOAD) throw { code: "too_large", message: "a file is at most 25 MB" };
  if (asking) throw { code: "rate_limited", message: "the page is already asking to save a file" };
  return new Promise((resolve, reject) => {
    const bar = document.createElement("div");
    bar.className = "pr-save box";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Save a file from the page");
    const what = document.createElement("span");
    what.className = "pr-what";
    const kb = blob.size < 1024 ? `${blob.size} B` : blob.size < 1048576 ? `${Math.round(blob.size / 1024)} KB` : `${(blob.size / 1048576).toFixed(1)} MB`;
    what.append("The page wants to save ", Object.assign(document.createElement("b"), { textContent: name }), ` (${kb}).`);
    const yes = Object.assign(document.createElement("button"), { type: "button", className: "btn-s pr-yes", textContent: "SAVE" });
    const no = Object.assign(document.createElement("button"), { type: "button", className: "btn-s pr-no", textContent: "NO" });
    bar.append(what, yes, no);
    const done = (ok) => {
      clearTimeout(timer);
      bar.remove();
      asking = null;
      if (!ok) return reject({ code: "declined", message: "the owner did not save it" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type }));
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      resolve({ status: "saved" });
    };
    const timer = setTimeout(() => done(false), 120_000);
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    asking = bar;
    document.body.append(bar);
    yes.focus({ preventScroll: true });
  });
}
