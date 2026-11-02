// THE PAGE RUNTIME's HUD side: the bridge between an HTML page in a sandboxed frame (runtime.js runs in it) and the
// server (src/server/page-runtime.ts). A page says hello with window.postMessage and a MessagePort; the bridge takes it
// only from the window of an <iframe> in this document that is sandboxed without allow-same-origin, and works out
// which page it is from that frame's src (rooms/SLUG/files/NAME, rooms/SLUG/brief, briefs/ID), never from what the page
// sends. After that the page and the bridge talk over the port: storage writes, db calls and subscriptions (refetched
// when the page's version in S.pageData moves), downloads, which the owner confirms here before the HUD saves them,
// publish, after which every view of the page reloads to the new version (S.pagePublished), rooms (each view is a
// peer in its page's rooms, over one stream per HUD tab), sample, which the owner allows here first, comments: a
// quote from the page opens its thread here, and cards: a <hud-card ref> asks for its card and opens it on a click,
// with the page's key from its frame, so it resolves only references its author wrote (embeds/pages.js).
import { CONFIG, S } from "../core/state.js";
import { emit, on } from "../core/bus.js";

const CAPS = ["db", "user", "downloads", "artifact", "self", "room", "comments"];
const MAX_MESSAGE = 1_100_000; // characters in one message from a page (a document is at most 256 KiB)
const MAX_PUBLISH = 5_100_000; // a publish carries the whole page (at most 5 MB)
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
  if ((m = u.pathname.match(/^\/asks\/(\d{1,9})\.html$/))) return `asks/${m[1]}`;
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
  for (const name of [...c.rooms.keys()]) leaveRoom(c, name);
  for (const ctl of c.aborts.values()) ctl.abort();
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
  const version = String(d.version ?? "").slice(0, 64);
  const c = { port, frame, source: e.source, page, nonce, version, subs: new Map(), rooms: new Map(), aborts: new Map(), seen: S?.pageData?.[page], second: 0, calls: 0 };
  lines.add(c);
  port.onmessage = (m) => handle(c, m.data);
  c.thread = threadShown(page);
  port.postMessage({ hello: "hud-page", page, caps: S?.pageSample ? [...CAPS, "sample"] : CAPS, comments: c.thread, user: { id: "owner", name: CONFIG.owner || "Owner" } });
});

function size(d) {
  try { return JSON.stringify(d, (k, v) => (v instanceof Blob ? `blob:${v.size}` : v)).length; } catch { return Infinity; }
}
async function handle(c, d) {
  if (!lines.has(c) || !d || typeof d !== "object") return;
  const reply = (value) => c.port.postMessage({ re: d.id, value });
  const refuse = (e) => c.port.postMessage({ re: d.id, error: { ...fail(e), ...(e?.text ? { text: e.text } : {}) } });
  const no = (code, message) => {
    if (d.op === "sub") c.port.postMessage({ snap: d.sub, error: { code, message } });
    else if (d.id) refuse({ code, message });
    else console.warn(`page ${c.page}: ${d.op} refused: ${message}`);
  };
  if (size(d) > (d.op === "publish" ? MAX_PUBLISH : MAX_MESSAGE)) return no(d.op === "publish" ? "too_large" : "invalid_argument", "message too large");
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
      case "room":
        reply(await room(c, d));
        return;
      case "comment":
        reply(comment(c, d));
        return;
      case "sample":
        reply(await sample(c, d));
        return;
      case "cards":
        c.cards ??= { push: (cards) => lines.has(c) && c.port.postMessage({ cards }), alive: () => lines.has(c) };
        emit("page:cards", { page: c.page, refs: d.refs, reply, view: c.cards });
        return;
      case "open":
        emit("page:open", { page: c.page, ref: String(d.ref ?? "") });
        return;
      case "sampleAbort":
        c.aborts.get(d.re)?.abort();
        return;
      case "publish":
        try {
          reply(await rpc("/api/page-runtime/publish", { page: c.page, html: d.html, base: c.version }));
        } catch (e) {
          refuse(e);
          if (e.code === "conflict") reload(c); // the newer version is the one to show
        }
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
// ---- room: whoever has the page open right now (src/server/page-room.ts) ----
// This tab holds one stream for every room its pages are in, opened with the first and closed with the last. Each view
// is its own peer in each room it joins. When the stream comes back after a break, every view joins again, with its
// presence: the server forgot this tab when the stream closed.
const TAB = crypto.randomUUID();
const peers = new Map(); // peer id -> { c, name }
let stream = null, streamOpen = null, connected = false;
function roomStream(rejoin = false) {
  if (stream) return streamOpen;
  stream = new EventSource(`/api/page-runtime/room/events?tab=${TAB}`);
  let ready;
  streamOpen = new Promise((ok) => (ready = ok));
  stream.onopen = async () => {
    connected = true;
    const first = !!ready;
    if (ready) { ready(); ready = null; }
    if (!first || rejoin) {
      for (const [peer, { c, name }] of peers) {
        const r = c.rooms.get(name);
        await rpc("/api/page-runtime/room", { tab: TAB, op: "join", page: c.page, room: name, peer }).catch(() => {});
        if (r && Object.keys(r.presence).length) await rpc("/api/page-runtime/room", { tab: TAB, op: "presence", page: c.page, room: name, peer, patch: r.presence }).catch(() => {});
      }
    }
    tellConnection();
  };
  stream.onerror = () => { if (connected) { connected = false; tellConnection(); } };
  stream.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    const to = peers.get(e.to);
    if (!to || !lines.has(to.c)) return;
    if (e.t === "peers") to.c.port.postMessage({ roomEv: to.name, peers: e.peers });
    if (e.t === "msg") to.c.port.postMessage({ roomEv: to.name, msg: e.msg });
  };
  return streamOpen;
}
// The tab going away (reload, navigation, the back-forward cache) closes the stream, so the server lets its views go
// at once; shown again from that cache, it opens the stream again and its views join anew.
addEventListener("pagehide", () => {
  if (!stream) return;
  stream.close();
  stream = null; streamOpen = null; connected = false;
});
addEventListener("pageshow", (e) => { if (e.persisted && peers.size && !stream) roomStream(true); });
function tellConnection() {
  for (const c of lines) for (const name of c.rooms.keys()) c.port.postMessage({ roomEv: name, connected });
}
async function room(c, d) {
  const name = String(d.room ?? "");
  const call = (op, more) => rpc("/api/page-runtime/room", { tab: TAB, op, page: c.page, room: name, peer: c.rooms.get(name)?.peer, ...more });
  switch (d.act) {
    case "join": {
      if (c.rooms.has(name)) return { connected };
      const peer = `v-${TAB.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
      c.rooms.set(name, { peer, presence: {} });
      peers.set(peer, { c, name });
      await roomStream();
      try { await call("join"); } catch (e) { leaveRoom(c, name); throw e; }
      return { connected };
    }
    case "leave": leaveRoom(c, name); return {};
    case "presence": {
      const r = c.rooms.get(name);
      if (!r) throw { code: "not_permitted", message: "join the room first" };
      await call("presence", { patch: d.patch });
      for (const [k, v] of Object.entries(d.patch ?? {})) v === null ? delete r.presence[k] : (r.presence[k] = v);
      return {};
    }
    case "emit":
      if (!c.rooms.has(name)) throw { code: "not_permitted", message: "join the room first" };
      await call("emit", { topic: d.topic, data: d.data });
      return {};
  }
  throw { code: "invalid_argument", message: `unknown room call ${d.act}` };
}
function leaveRoom(c, name) {
  const r = c.rooms.get(name);
  if (!r) return;
  c.rooms.delete(name);
  peers.delete(r.peer);
  rpc("/api/page-runtime/room", { tab: TAB, op: "leave", page: c.page, room: name, peer: r.peer }).catch(() => {});
  if (!peers.size && stream) { stream.close(); stream = null; streamOpen = null; connected = false; }
}

// A page published anew (artifact.publish) reloads in every view that still shows an older version. A view that
// reloads its frame itself (a room's page on the stage) says hello again first, with the new version, and is left alone.
function reload(c) {
  setTimeout(() => {
    if (!lines.has(c) || !c.frame.isConnected) return;
    drop(c);
    c.frame.src = c.frame.getAttribute("src");
  }, 300);
}
on("state", (s) => {
  for (const c of [...lines]) {
    if (!c.frame.isConnected || c.frame.contentWindow !== c.source) { drop(c); continue; }
    if (threadShown(c.page) !== c.thread) { c.thread = !c.thread; c.port.postMessage({ mount: c.thread }); }
    const live = s.pagePublished?.[c.page];
    if (live && live !== c.version && !c.reloading) { c.reloading = true; reload(c); continue; }
    const v = s.pageData?.[c.page];
    if (v === c.seen) continue;
    c.seen = v;
    for (const id of c.subs.keys()) run(c, id);
  }
});

// ---- comments: a quote from inside the page goes to its thread (src/client/comments/) ----
// The thread is the view's own mount (<aside class="cmount" data-comments="KEY">); a page whose view shows none gets
// { opened: false }. Each line hears whether its thread is there, so the page offers COMMENT only when it is.
const threadShown = (page) => [...document.querySelectorAll("aside.cmount[data-comments]")].some((m) => m.dataset.comments === page && m.isConnected);
function comment(c, d) {
  const text = String(d.text ?? "").trim().slice(0, 2000);
  if (!text) throw { code: "invalid", message: "nothing to quote" };
  if (!threadShown(c.page)) return { opened: false };
  emit("comments:quote", { key: c.page, text, anchor: String(d.anchor ?? "").slice(0, 500) });
  return { opened: true };
}
function tellThreads() {
  for (const c of lines) {
    const here = threadShown(c.page);
    if (here !== c.thread) { c.thread = here; c.port.postMessage({ mount: here }); }
  }
}
on("comments:mount", () => queueMicrotask(tellThreads));
addEventListener("hashchange", () => setTimeout(tellThreads, 0));

// ---- asking the owner: one bar at a time, the next waits its turn ----
let queue = Promise.resolve();
function askOwner(parts, yesLabel, noLabel, label) {
  const turn = queue.then(() => new Promise((resolve) => {
    const bar = document.createElement("div");
    bar.className = "pr-save box";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", label);
    const what = document.createElement("span");
    what.className = "pr-what";
    what.append(...parts);
    const yes = Object.assign(document.createElement("button"), { type: "button", className: "btn-s pr-yes", textContent: yesLabel });
    const no = Object.assign(document.createElement("button"), { type: "button", className: "btn-s pr-no", textContent: noLabel });
    bar.append(what, yes, no);
    const done = (ok) => { clearTimeout(timer); bar.remove(); resolve(ok); };
    const timer = setTimeout(() => done(false), 120_000);
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    document.body.append(bar);
    yes.focus({ preventScroll: true });
  }));
  queue = turn.catch(() => {});
  return turn;
}
const bold = (text) => Object.assign(document.createElement("b"), { textContent: text });

// ---- downloads: the owner says yes here, then the HUD saves the file ----
const TYPES = { txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", svg: "image/svg+xml", png: "image/png", pdf: "application/pdf" };
async function save(c, filename, data) {
  const name = String(filename ?? "").trim();
  if (!name || name.length > 200 || /[/\\\0-\x1f]/.test(name) || name.startsWith(".")) throw { code: "bad_request", message: "a file name, without folders" };
  if (REFUSED_EXT.test(name)) throw { code: "rejected_extension", message: `the HUD does not save ${name.split(".").pop()} files` };
  const type = TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream";
  const blob = data instanceof Blob ? data : typeof data === "string" ? new Blob([data], { type }) : null;
  if (!blob) throw { code: "bad_request", message: "nothing to save" };
  if (blob.size > MAX_DOWNLOAD) throw { code: "too_large", message: "a file is at most 25 MB" };
  if ((c.asking = (c.asking ?? 0) + 1) > 3) { c.asking--; throw { code: "rate_limited", message: "the page is already asking to save files" }; }
  const kb = blob.size < 1024 ? `${blob.size} B` : blob.size < 1048576 ? `${Math.round(blob.size / 1024)} KB` : `${(blob.size / 1048576).toFixed(1)} MB`;
  const ok = await askOwner(["The page wants to save ", bold(name), ` (${kb}).`], "SAVE", "NO", "Save a file from the page").finally(() => c.asking--);
  if (!ok) throw { code: "declined", message: "the owner did not save it" };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return { status: "saved" };
}

// ---- sample: a model's answer, from the command the owner set (src/server/page-sample.ts) ----
// The first call in a view asks the owner; a NO holds for as long as the page is open.
async function sample(c, d) {
  if (!S?.pageSample) throw { code: "sampling_disabled", message: "this HUD asks no model" };
  if (c.sampleOk === undefined) c.sampleOk = askOwner(["The page wants to ask a model. Its prompt goes to ", bold("HUD_SAMPLE_CMD"), " on this machine."], "ALLOW", "NO", "Let the page ask a model");
  if (!(await c.sampleOk)) throw { code: "not_granted", message: "the owner said no" };
  const ctl = new AbortController();
  c.aborts.set(d.id, ctl);
  try {
    const res = await fetch("/api/page-runtime/sample", { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ page: c.page, input: d.input, tier: d.tier }), signal: ctl.signal });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw { code: e.code || "upstream_error", message: e.error || res.statusText }; }
    let buf = "", last = null;
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        last = JSON.parse(line);
        if (last.error) throw { code: last.code, message: last.error, text: last.text };
        if (!last.done && lines.has(c)) c.port.postMessage({ stream: d.id, text: last.text });
      }
    }
    if (!last?.done) throw { code: "upstream_error", message: "the answer stopped" };
    return { text: last.text, truncated: !!last.truncated, modelTierApplied: last.tier };
  } catch (e) {
    if (ctl.signal.aborted) throw { code: "cancelled", message: "cancelled" };
    throw e;
  } finally {
    c.aborts.delete(d.id);
  }
}
