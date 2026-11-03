// CLASSIC SCRIPT, not a module: THE PAGE RUNTIME, inside an HTML page's sandboxed frame. The server puts it first in
// the page's <head> (src/server/page-runtime.ts withRuntime), after a JSON block with the page's key and stored keys.
// It gives the page what a Claude artifact gets from its runtime, without leaving the sandbox:
//   window.hud.use(name), and window.claude.use(name) when the page has no window.claude: a Promise of the
//     capability's frozen namespace, or null (unknown name, or not framed by the HUD). In a frame it waits for the
//     HUD's answer however late it comes.
//     db, user, downloads, artifact (publish), room, comments (openComposer, into the HUD's thread) and sample (when
//     the owner set HUD_SAMPLE_CMD) work; anything else is null.
//   COMMENT on a text selection, when the HUD shows the page's comment thread.
//   localStorage and sessionStorage, synchronous: localStorage starts with the stored keys and writes go back through
//     the HUD, so it is kept per page and shared by everyone who opens the HUD; sessionStorage lasts while the page is open.
//   Mermaid: a page with .mermaid diagrams and no mermaid of its own gets them drawn, as an artifact does.
//   <hud-card ref="brief/12">: a card of an HQ thing (its kind, title, status, one line), live while the page is open,
//     that opens it in the HUD on a click; only references the page's author wrote resolve (src/server/refs.ts).
// It talks only to the HUD page that frames it, through a MessageChannel handed over in a hello; the HUD
// (src/client/page-runtime/index.js) decides which page this is from the frame, never from what this script says.
(() => {
  const me = document.currentScript;
  const bootEl = me && me.previousElementSibling && me.previousElementSibling.matches("script[data-hud-page]") ? me.previousElementSibling : null;
  let boot = {};
  try { boot = JSON.parse(bootEl ? bootEl.textContent : "{}") || {}; } catch {}
  bootEl?.remove();
  me?.remove();
  const PAGE = String(boot.page || "");
  const VERSION = String(boot.version || "");
  const framed = window.parent !== window && !!PAGE;
  const error = (code, message) => Object.assign(new Error(message), { code });

  // ---- the keyboard stays where the owner put it ----
  // A framed page moves focus only while its frame has the keyboard, or just after a press inside it: a focus() as it
  // loads (a new ask, a new version, the theme's reload) would take the keyboard from the HUD's text box the owner
  // is typing in, and what they type or paste next would land in the page.
  if (window.parent !== window) {
    const may = () => document.hasFocus() || !!navigator.userActivation?.isActive;
    for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
      const focus = proto.focus;
      proto.focus = function (options) { if (may()) focus.call(this, options); };
    }
    const focusWindow = window.focus;
    window.focus = function () { if (may()) focusWindow.call(window); };
  }

  // ---- the line to the HUD ----
  let port = null;
  const outbox = [];
  const waiting = new Map();
  const listeners = new Map();
  let seq = 0;
  let ready = null; // what the HUD said in its hello, or null when it never answered
  const connected = new Promise((resolve) => {
    if (!framed) return resolve(null);
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const tries = [];
    const hello = () => {
      if (port) return;
      const ch = new MessageChannel();
      tries.push(ch.port1);
      ch.port1.onmessage = (e) => {
        const d = e.data;
        if (port || !d || d.hello !== "hud-page") { if (port !== ch.port1) ch.port1.close(); return; }
        port = ch.port1;
        ready = d;
        threadHere = !!d.comments;
        for (const p of tries) if (p !== port) p.close();
        port.onmessage = onReply;
        for (const m of outbox.splice(0)) port.postMessage(m.msg, m.transfer);
        resolve(d);
      };
      try { window.parent.postMessage({ "hud-page": "hello", page: PAGE, nonce, version: VERSION }, "*", [ch.port2]); } catch {}
    };
    // A HUD that is busy (a cold browser, a loaded machine) answers late: the page waits for it rather than going
    // without. The HUD answers a hello as it arrives or never, so only the last few lines are kept open.
    const started = Date.now();
    let warned = false;
    const again = () => {
      if (port) return;
      if (tries.length > 4) tries.shift().close();
      hello();
      const waited = Date.now() - started;
      if (waited > 10_000 && !warned) { warned = true; console.warn("hud: the HUD has not answered this page yet; still asking"); }
      setTimeout(again, waited < 10_000 ? 400 : 2000);
    };
    again();
  });
  function onReply(e) {
    const d = e.data || {};
    if (d.snap !== undefined) { listeners.get(d.snap)?.(d); return; }
    if (d.roomEv !== undefined) { rooms.get(d.roomEv)?.hear(d); return; }
    if (d.stream !== undefined) { streams.get(d.stream)?.(d.text); return; }
    if (d.mount !== undefined) { threadHere = !!d.mount; if (!threadHere) pickHide(); return; }
    if (d.cards !== undefined && d.re === undefined) { cardsCame(d.cards); return; }
    const w = waiting.get(d.re);
    if (!w) return;
    waiting.delete(d.re);
    streams.delete(d.re);
    if (d.error) w.reject(Object.assign(error(d.error.code || "unavailable", d.error.message || "refused"), d.error.text ? { text: d.error.text } : {}));
    else w.resolve(d.value);
  }
  function send(msg, transfer = []) {
    if (port) port.postMessage(msg, transfer);
    else if (framed && !ready) outbox.push({ msg, transfer });
  }
  function call(op, args = {}, transfer) {
    if (!framed) return Promise.reject(error("not_granted", "this page is not open in the HUD"));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      send({ id, op, ...args }, transfer);
      connected.then((r) => { if (!r && waiting.delete(id)) reject(error("unavailable", "the HUD did not answer")); });
    });
  }

  // ---- storage ----
  function makeStorage(initial, persist) {
    const data = new Map(Object.entries(initial || {}));
    let pending = null;
    const flush = () => { const set = pending; pending = null; if (set && persist) send({ op: "storage", set: set.set, clear: set.clear }); };
    const change = (k, v) => {
      if (!pending) { pending = { set: {}, clear: false }; queueMicrotask(flush); }
      pending.set[k] = v;
    };
    const size = () => { let n = 0; for (const [k, v] of data) n += k.length + v.length; return n; };
    const api = {
      get length() { return data.size; },
      key(i) { return [...data.keys()][i] ?? null; },
      getItem(k) { k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem(k, v) {
        k = String(k); v = String(v);
        const before = data.get(k);
        data.set(k, v);
        if (k.length > 1024 || size() > 1_000_000) {
          before === undefined ? data.delete(k) : data.set(k, before);
          throw new DOMException("The page's storage is full.", "QuotaExceededError");
        }
        change(k, v);
      },
      removeItem(k) { k = String(k); if (data.delete(k)) change(k, null); },
      clear() { data.clear(); pending = { set: {}, clear: true }; queueMicrotask(flush); },
    };
    const own = new Set(Object.keys(Object.getOwnPropertyDescriptors(api)));
    return new Proxy(api, {
      get: (t, p) => (typeof p === "symbol" || own.has(p) ? Reflect.get(t, p) : t.getItem(p) ?? undefined),
      set: (t, p, v) => { if (typeof p === "symbol" || own.has(p)) return false; t.setItem(p, v); return true; },
      deleteProperty: (t, p) => { if (typeof p !== "symbol" && !own.has(p)) t.removeItem(p); return true; },
      has: (t, p) => own.has(p) || (typeof p === "string" && data.has(p)),
      ownKeys: () => [...data.keys()],
      getOwnPropertyDescriptor: (t, p) => (typeof p === "string" && data.has(p) ? { value: data.get(p), writable: true, enumerable: true, configurable: true } : undefined),
    });
  }
  for (const [name, storage] of [["localStorage", makeStorage(boot.storage, true)], ["sessionStorage", makeStorage({}, false)]]) {
    let works = false;
    try { works = !!window[name]; } catch {}
    if (!works) { try { Object.defineProperty(window, name, { value: storage, configurable: true, enumerable: true }); } catch {} }
  }

  // ---- db: the artifact db's shape ----
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  const bytes = (s) => new TextEncoder().encode(s).length;
  function segs(path, even) {
    if (typeof path !== "string" || !path) throw new TypeError("a db path is a non-empty string");
    const s = path.split("/");
    if (bytes(path) > 1000 || s.length > 16) throw new TypeError(`db path "${path}": at most 16 segments and 1000 bytes`);
    for (const x of s) if (!SEG.test(x) || x === "." || x === ".." || bytes(x) > 200) throw new TypeError(`db path "${path}": bad segment "${x}" (letters, digits and _ - . ~ : @ + only)`);
    if ((s.length % 2 === 0) !== even) throw new TypeError(`db path "${path}" has ${s.length} segments: a ${even ? "document" : "collection"} path has an ${even ? "even" : "odd"} number`);
    return s;
  }
  const newId = () => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; for (const b of crypto.getRandomValues(new Uint8Array(20))) s += a[b % 62]; return s; };
  const freezeDeep = (v) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freezeDeep(x); } return v; };
  const META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  // A delivered document: frozen, and the same object while its body is the same (compare with ===).
  function docSnap(d, cache) {
    const text = d.exists ? JSON.stringify(d.data) : "";
    const key = `${d.path}\n${d.exists}\n${text}`;
    if (cache?.has(key)) return cache.get(key);
    const data = d.exists ? freezeDeep(JSON.parse(text)) : undefined;
    const s = Object.freeze({ id: d.id, exists: !!d.exists, data: () => data, metadata: META });
    cache?.set(key, s);
    return s;
  }
  function querySnap(docs, prev) {
    const changes = [];
    const before = new Map((prev || []).map((s, i) => [s.id, { s, i }]));
    const after = new Map(docs.map((s, i) => [s.id, i]));
    for (const [id, { s, i }] of before) if (!after.has(id)) changes.push({ type: "removed", doc: s, oldIndex: i, newIndex: -1 });
    docs.forEach((s, i) => {
      const was = before.get(s.id);
      if (!was) changes.push({ type: "added", doc: s, oldIndex: -1, newIndex: i });
      else if (was.s !== s || was.i !== i) changes.push({ type: "modified", doc: s, oldIndex: was.i, newIndex: i });
    });
    return Object.freeze({ docs: Object.freeze(docs), size: docs.length, empty: !docs.length, docChanges: () => changes, metadata: META });
  }
  function checkBody(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw error("invalid_argument", "a document is a plain object");
    let text;
    try { text = JSON.stringify(data); } catch { throw error("invalid_argument", "a document must be plain JSON"); }
    if (text.length > 256 * 1024) throw error("invalid_argument", "a document is at most 256 KiB");
    return JSON.parse(text);
  }
  const dbCall = (args) => call("db", args);
  let subSeq = 0;
  function subscribe(spec, next, fail, toSnap) {
    const id = ++subSeq;
    let done = false;
    listeners.set(id, (d) => {
      if (done) return;
      if (d.error) { done = true; listeners.delete(id); const e = error(d.error.code || "unavailable", d.error.message || "refused"); fail ? fail(e) : reportError(e); return; }
      next(toSnap(d.value));
    });
    if (!framed) queueMicrotask(() => listeners.get(id)?.({ error: { code: "not_granted", message: "this page is not open in the HUD" } }));
    else {
      send({ op: "sub", sub: id, ...spec });
      connected.then((r) => { if (!r) listeners.get(id)?.({ error: { code: "unavailable", message: "the HUD did not answer" } }); });
    }
    return () => { if (done) return; done = true; listeners.delete(id); send({ op: "unsub", sub: id }); };
  }
  function docRef(path) {
    const s = segs(path, true);
    return Object.freeze({
      id: s.at(-1),
      path,
      get: async () => docSnap(await dbCall({ dbop: "get", path })),
      set: async (data) => { await dbCall({ dbop: "set", path, data: checkBody(data) }); },
      update: async (data) => { await dbCall({ dbop: "update", path, data: checkBody(data) }); },
      delete: async () => { await dbCall({ dbop: "delete", path }); },
      acquire: async (o = {}) => dbCall({ dbop: "acquire", path, holder: String(o.holder ?? ""), ttlMs: o.ttlMs, data: o.data === undefined ? undefined : checkBody(o.data) }),
      onSnapshot(next, fail) {
        const cache = new Map();
        return subscribe({ kind: "doc", path }, (s) => next(s), fail, (v) => { const s = docSnap(v, cache); cache.clear(); cache.set(`${v.path}\n${v.exists}\n${v.exists ? JSON.stringify(v.data) : ""}`, s); return s; });
      },
      collection: (sub) => collRef(`${path}/${sub}`),
    });
  }
  function query(path, q) {
    const self = {
      where: (field, op, value) => {
        if (q.where.length >= 10) throw error("invalid_argument", "a query has at most 10 filters");
        return query(path, { ...q, where: [...q.where, [String(field), String(op), value]] });
      },
      orderBy: (field, dir = "asc") => query(path, { ...q, orderBy: [String(field), dir === "desc" ? "desc" : "asc"] }),
      limit: (n) => query(path, { ...q, limit: n }),
      get: async () => { const v = await dbCall({ dbop: "query", path, query: q }); return querySnap(v.docs.map((d) => docSnap({ ...d, exists: true })), []); },
      onSnapshot(next, fail) {
        let prev = [], cache = new Map();
        return subscribe({ kind: "query", path, query: q }, (s) => next(s), fail, (v) => {
          const fresh = new Map();
          const docs = v.docs.map((d) => { const s = docSnap({ ...d, exists: true }, cache); fresh.set(`${d.path}\ntrue\n${JSON.stringify(d.data)}`, s); return s; });
          cache = fresh;
          const snap = querySnap(docs, prev);
          prev = docs;
          return snap;
        });
      },
    };
    return self;
  }
  function collRef(path) {
    segs(path, false);
    return Object.freeze({
      ...query(path, { where: [], orderBy: null, limit: null }),
      path,
      doc: (id) => docRef(`${path}/${id === undefined ? newId() : id}`),
      add: async (data) => { const ref = docRef(`${path}/${newId()}`); await ref.set(data); return ref; },
    });
  }
  const dbNs = Object.freeze({ doc: docRef, collection: collRef });

  // ---- user: whoever opens the HUD is its owner ----
  function userNs() {
    const u = ready.user || {};
    const profile = Object.freeze({ id: u.id, name: u.name || "", avatarUrl: "", color: u.color || "#4a7bd0", email: null, isMe: true, guest: false });
    const viewer = Object.freeze({ id: u.id, name: u.name || "", avatarUrl: "", color: profile.color, email: null, isOwner: true, canEdit: true });
    return Object.freeze({
      id: async () => u.id,
      me: async () => viewer,
      isOwner: async () => true,
      canEdit: async () => true,
      can: async () => true,
      profiles: async (ids) => Object.fromEntries([].concat(ids).filter((id) => id === u.id).map((id) => [id, profile])),
      name: async () => profile.name,
      avatarUrl: async () => null,
      email: async () => null,
      search: async () => [profile],
    });
  }

  // ---- downloads: the HUD asks the viewer, then saves the file ----
  const downloadsNs = Object.freeze({
    save: async (req = {}) => {
      const filename = String(req.filename ?? "");
      let data = req.data;
      if (typeof data !== "string" && !(data instanceof Blob)) {
        if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) data = new Blob([data]);
        else throw error("bad_request", "data is a string, a Blob, an ArrayBuffer or a typed array");
      }
      return call("save", { filename, data });
    },
  });

  // ---- artifact: the page publishes a new version of itself; every open view, this one too, reloads to it ----
  const removed = (what) => async () => { throw error("capability_removed", `${what} is not part of this HUD's runtime`); };
  const artifactNs = Object.freeze({
    publish: async (html) => {
      if (typeof html !== "string") throw error("invalid_content", "this HUD publishes a whole HTML document, as a string");
      return call("publish", { html, base: VERSION });
    },
    edit: removed("artifact.edit"),
    sync: removed("artifact.sync"),
    metadata: async () => ({}),
  });

  // ---- room: whoever has this page open right now ----
  const rooms = new Map(); // name ("" is the lobby) -> its state
  const TOPIC = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
  const safely = (fn, ...a) => { try { fn(...a); } catch (e) { reportError(e); } };
  function makeRoom(name) {
    const topics = new Map(), peerFns = new Set(), connFns = new Set();
    let list = Object.freeze([]), live = false, left = false;
    const joined = call("room", { act: "join", room: name }).then((r) => { live = !!r?.connected; }, (e) => { left = true; throw e; });
    joined.catch(() => {});
    const st = {
      hear(d) {
        if (left) return;
        if (d.connected !== undefined) { live = d.connected; for (const fn of [...connFns]) safely(fn, live); return; }
        if (d.msg) { const m = Object.freeze({ ...d.msg }); for (const fn of [...(topics.get(m.topic) ?? [])]) safely(fn, m); return; }
        if (d.peers) {
          const before = new Map(list.map((p) => [p.peer, p]));
          const next = Object.freeze(d.peers.map((p) => Object.freeze({ ...p, presence: freezeDeep(p.presence ?? {}) })));
          const now = new Set(next.map((p) => p.peer));
          const change = Object.freeze({
            peers: next,
            joined: next.filter((p) => !before.has(p.peer)),
            left: list.filter((p) => !now.has(p.peer)),
            updated: next.filter((p) => before.has(p.peer) && before.get(p.peer).updatedAt !== p.updatedAt),
          });
          list = next;
          for (const fn of [...peerFns]) safely(fn, change);
        }
      },
    };
    rooms.set(name, st);
    const ready = async () => { if (left) throw error("not_permitted", "this room was left"); await joined; };
    const api = {
      emit: async (topic, data) => {
        if (!TOPIC.test(String(topic))) throw error("invalid_argument", "a topic is a name: a letter or _, then up to 63 letters, digits, _ or -");
        await ready();
        await call("room", { act: "emit", room: name, topic: String(topic), data });
      },
      on: (topic, fn) => {
        if (!TOPIC.test(String(topic)) || typeof fn !== "function") throw new TypeError("room.on(topic, handler)");
        const set = topics.get(topic) ?? topics.set(topic, new Set()).get(topic);
        set.add(fn);
        return () => set.delete(fn);
      },
      presence: async (patch) => { await ready(); await call("room", { act: "presence", room: name, patch }); },
      peers: () => list,
      onPeers: (fn) => {
        peerFns.add(fn);
        if (list.length) queueMicrotask(() => peerFns.has(fn) && safely(fn, Object.freeze({ peers: list, joined: list, left: [], updated: [] })));
        return () => peerFns.delete(fn);
      },
      connected: () => live,
      onConnection: (fn) => { connFns.add(fn); return () => connFns.delete(fn); },
    };
    if (!name) {
      return Object.freeze({
        ...api,
        join: async (n) => {
          n = String(n ?? "");
          if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(n)) throw error("invalid_argument", "a room's name is 1 to 64 letters, digits and _ . : -");
          const r = namedRooms.get(n) ?? namedRooms.set(n, makeRoom(n)).get(n);
          await joinedOf.get(r);
          return r;
        },
        sendToClaudeSession: async () => { throw error("claude_unavailable", "this HUD sends nothing to an agent's session from a page; use the page's comments"); },
        canSendToClaudeSession: async () => "unsupported",
      });
    }
    const named = Object.freeze({
      ...api,
      name,
      leave: async () => {
        if (left) return;
        left = true;
        rooms.delete(name);
        namedRooms.delete(name);
        await call("room", { act: "leave", room: name }).catch(() => {});
      },
    });
    joinedOf.set(named, joined);
    return named;
  }
  const namedRooms = new Map(), joinedOf = new WeakMap();
  let lobby = null;

  // ---- sample: ask a model (the command the owner set up; the HUD asks the owner first) ----
  const streams = new Map();
  const TIERS = ["default", "quick", "complex"];
  function ask(input, opts = {}) {
    if (opts.tools?.length) return Promise.reject(error("tools_unavailable", "this HUD's sample takes no tools"));
    if (opts.images && (opts.images instanceof Blob || opts.images.length)) return Promise.reject(error("images_unavailable", "this HUD's sample takes no images"));
    if (opts.signal?.aborted) return Promise.reject(error("cancelled", "cancelled"));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      let prev = "";
      if (typeof opts.onText === "function") streams.set(id, (text) => { const delta = text.startsWith(prev) ? text.slice(prev.length) : text; prev = text; safely(opts.onText, { text, delta }); });
      opts.signal?.addEventListener("abort", () => send({ op: "sampleAbort", re: id }), { once: true });
      send({ id, op: "sample", input, tier: TIERS.includes(opts.modelTier) ? opts.modelTier : "default" });
    });
  }
  const sampleNs = Object.freeze(Object.assign((input, opts) => ask(input, opts), {
    json: async (input, opts = {}) => {
      const suffix = "\n\nAnswer with the JSON value only: no prose, no code fences.";
      const r = await ask(typeof input === "string" ? input + suffix : Array.isArray(input) ? input.map((m, i) => (i === input.length - 1 ? { ...m, content: m.content + suffix } : m)) : input, opts);
      const text = r.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try { return JSON.parse(text); } catch { throw Object.assign(error("invalid_json", "the answer was not JSON"), { text: r.text }); }
    },
    limits: async () => ({ maxPromptBytes: 200_000, modelTiers: [...TIERS] }),
  }));

  // ---- comments: the page's thread is the HUD's (src/client/comments/); the page opens it with a quote ----
  // openComposer sends the element's text or the selected passage, with where it sits (a CSS path), and the HUD opens
  // the page's thread with it quoted. Selecting text in the page shows COMMENT, which does the same, whenever the HUD
  // shows the page's thread. Comments are written in the HUD, so the write verbs are not here.
  let threadHere = false;
  const MAX_QUOTE = 2000;
  function cssPath(el) {
    const parts = [];
    for (; el && el.nodeType === 1 && el !== document.documentElement; el = el.parentElement) {
      if (el.id) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(" > ") || "html";
  }
  const textOf = (el) => String(el?.innerText ?? el?.textContent ?? "").trim();
  function quoteOf(target) {
    if (target?.range instanceof Range) {
      const node = target.range.commonAncestorContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      return { text: (target.range.toString().trim() || textOf(el)).slice(0, MAX_QUOTE), anchor: cssPath(el) };
    }
    if (target?.element instanceof Element) return { text: textOf(target.element).slice(0, MAX_QUOTE), anchor: cssPath(target.element) };
    throw error("invalid", "openComposer({ element }) or openComposer({ range })");
  }
  const notHere = (what) => async () => { throw error("not_granted", `${what}: comments are written in the HUD; open the composer with openComposer`); };
  const commentsNs = Object.freeze({
    openComposer: async (target) => call("comment", quoteOf(target)),
    anchorFor: async (el) => {
      if (!(el instanceof Element)) throw error("invalid", "anchorFor takes an element");
      return Object.freeze({ path: cssPath(el), x: 0, y: 0 });
    },
    canSendToClaude: async () => "off",
    create: notHere("create"),
    reply: notHere("reply"),
    sendToClaude: notHere("sendToClaude"),
    resolve: notHere("resolve"),
    delete: notHere("delete"),
    customAnchors: notHere("customAnchors"),
  });
  // COMMENT on a selection: in a shadow root of its own, so the page's styles neither reach it nor are touched by it.
  let pickHost = null, pickBtn = null, picked = null;
  function pickHide() { if (pickHost) pickHost.style.display = "none"; picked = null; }
  function pickShow(range) {
    if (!pickHost) {
      pickHost = document.createElement("hud-comment-pick");
      const root = pickHost.attachShadow({ mode: "closed" });
      // The HUD's own COMMENT, in its light and dark colours (--ink, --on-ink, --edge): the HUD's tokens do not reach
      // into the page, but the theme does, as data-theme on the page's <html>.
      root.innerHTML = `<style>button{position:fixed;z-index:2147483647;margin:0;padding:9px 12px;border:2px solid var(--e);border-radius:8px;background:var(--i);color:var(--o);font:700 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;box-shadow:0 3px 0 rgba(0,0,0,.25);cursor:pointer;--i:#23233a;--o:#fff;--e:#3c3c5a}button.dark{--i:#ecebf4;--o:#1b1d2c;--e:#b4b4d4}@media (pointer:coarse){button{padding:14px 16px}}</style><button type="button">COMMENT</button>`;
      pickBtn = root.querySelector("button");
      pickBtn.addEventListener("pointerdown", (e) => e.preventDefault()); // keep the selection while pressing
      pickBtn.addEventListener("click", () => {
        const r = picked;
        pickHide();
        if (!r) return;
        call("comment", quoteOf({ range: r })).catch(() => {});
        getSelection()?.removeAllRanges();
      });
    }
    if (!pickHost.isConnected) document.documentElement.append(pickHost);
    pickHost.style.display = "";
    const theme = document.documentElement.dataset.theme;
    pickBtn.classList.toggle("dark", theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
    picked = range;
    const rect = range.getBoundingClientRect();
    const w = pickBtn.offsetWidth || 90, h = pickBtn.offsetHeight || 34;
    pickBtn.style.left = `${Math.min(innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2))}px`;
    pickBtn.style.top = `${rect.top - h - 8 >= 8 ? rect.top - h - 8 : Math.min(innerHeight - h - 8, rect.bottom + 8)}px`;
  }
  let pickQueued = false;
  if (framed) document.addEventListener("selectionchange", () => {
    if (pickQueued) return;
    pickQueued = true;
    requestAnimationFrame(() => {
      pickQueued = false;
      const sel = getSelection();
      if (!threadHere || !sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return pickHide();
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const at = node.nodeType === 1 ? node : node.parentElement;
      if (at?.closest("textarea, input, [contenteditable]")) return pickHide();
      pickShow(range.cloneRange());
    });
  });
  addEventListener("scroll", pickHide, { passive: true, capture: true });

  // ---- <hud-card ref="..."> ----
  // In a closed shadow root, in the HUD's light and dark colours (core/base.css --field, --ink, --muted, --edge, --edge-2,
  // --blue-text, --red, --green), built from text only: what the HUD sends is words and colours (embeds/pages.js), never
  // markup.
  const cardData = new Map(), cardEls = new Set();
  let cardAsk = null;
  function cardsCame(cards) {
    for (const [ref, c] of Object.entries(cards || {})) cardData.set(ref, c);
    for (const el of cardEls) el.draw();
  }
  function wantCard(ref) {
    if (!framed || cardData.has(ref)) return;
    if (!cardAsk) {
      cardAsk = new Set();
      queueMicrotask(() => {
        const refs = [...cardAsk];
        cardAsk = null;
        call("cards", { refs }).then(cardsCame, () => cardsCame(Object.fromEntries(refs.map((r) => [r, null]))));
      });
    }
    cardAsk.add(ref);
  }
  const CARD_CSS = `:host{display:block;max-width:560px;margin:8px 0}
.c{display:flex;gap:10px;padding:8px 10px;border:2px solid var(--e2);border-radius:8px;background:var(--f);color:var(--i);text-decoration:none;font:14px/1.35 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere;--f:#fff;--i:#23233a;--m:#6a6a82;--e:#3c3c5a;--e2:#a8a8c8;--b:#3c6fd6;--r:#d63c3c;--g:#2f9e57;--o:#fff}
.c.dark{--f:#191b2b;--i:#ecebf4;--m:#a6a6c2;--e:#b4b4d4;--e2:#50547c;--b:#8fb0ff}
a.c{cursor:pointer}a.c:hover{border-color:var(--e)}a.c:focus-visible{outline:3px solid var(--b);outline-offset:1px}
.c.other{border-left:6px solid var(--fc)}.c.gone,.c.wait{border-style:dashed}
.t{display:grid;gap:2px;min-width:0;flex:1}.h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
.w{font:700 9px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.06em;color:var(--m)}
.p{padding:0 6px;border-radius:4px;border:1px solid var(--e2);font-size:11px;font-weight:800;line-height:1.5}
.p.new{border-color:var(--b);color:var(--b)}.p.hot{background:var(--r);border-color:var(--r);color:var(--o)}.p.ok{background:var(--g);border-color:var(--g);color:var(--o)}.p.muted{color:var(--m)}.p.st{border-color:transparent;color:var(--o)}
.fl{padding:0 6px;border-radius:4px;font-size:11px;font-weight:800}
b{font-weight:800}.l{color:var(--m);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gone b{color:var(--m)}
.im{flex:0 0 64px;height:48px;border-radius:4px;overflow:hidden;border:1px solid var(--e2);background:#fff}.im img{width:100%;height:100%;object-fit:cover;display:block}`;
  const dark = () => { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
  const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
  class HudCard extends HTMLElement {
    static get observedAttributes() { return ["ref"]; }
    #root = this.attachShadow({ mode: "closed" });
    #drawn = "";
    connectedCallback() { cardEls.add(this); this.draw(); }
    disconnectedCallback() { cardEls.delete(this); }
    attributeChangedCallback() { if (this.isConnected) this.draw(); }
    draw() {
      const ref = String(this.getAttribute("ref") || "").trim().replace(/^#/, "");
      wantCard(ref);
      const c = cardData.get(ref);
      const known = framed && c !== undefined;
      // The cards are read again every few seconds: a box replaced between a press and its release loses the click.
      const drawn = JSON.stringify([ref, framed, known, c ?? null, dark()]);
      if (drawn === this.#drawn) return;
      this.#drawn = drawn;
      const box = document.createElement(known && c ? "a" : "div");
      box.className = `c${dark() ? " dark" : ""}${!framed || !known ? " wait" : c ? (c.floor ? " other" : "") : " gone"}`;
      const body = span("t", ""), head = span("h", "");
      body.append(head);
      if (!framed) {
        head.append(span("w", "HQ"));
        body.append(Object.assign(document.createElement("b"), { textContent: ref }), span("l", "Open this page in the HUD to see this card."));
      } else if (!known) {
        head.append(span("w", "…"));
        body.append(Object.assign(document.createElement("b"), { textContent: ref }));
      } else if (!c) {
        head.append(span("w", "NOT FOUND"));
        body.append(Object.assign(document.createElement("b"), { textContent: ref }), span("l", "Gone, or not in this page as its author wrote it."));
      } else {
        head.append(span("w", c.word));
        if (c.floor) {
          box.style.setProperty("--fc", c.floor.color);
          if (c.floor.name) { const f = span("fl", c.floor.name); f.style.background = c.floor.color; f.style.color = c.floor.ink; head.append(f); }
        }
        for (const x of c.chips || []) { const p = span(`p ${x.c}`, x.t); if (x.color) p.style.background = x.color; head.append(p); }
        body.append(Object.assign(document.createElement("b"), { textContent: c.title }));
        if (c.preview) body.append(span("l", c.preview));
        if (c.thumb) { const im = span("im", ""); im.append(Object.assign(document.createElement("img"), { src: c.thumb, alt: "" })); box.append(im); }
        if (c.href) Object.assign(box, { href: c.href, target: "_blank", rel: "noopener" });
        else {
          box.href = `#${ref}`;
          box.addEventListener("click", (e) => { e.preventDefault(); send({ op: "open", ref }); });
        }
      }
      box.append(body);
      this.#root.replaceChildren(Object.assign(document.createElement("style"), { textContent: CARD_CSS }), box);
    }
  }
  if (!customElements.get("hud-card")) customElements.define("hud-card", HudCard);
  const redrawCards = () => { for (const el of cardEls) el.draw(); };
  new MutationObserver(redrawCards).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", redrawCards);

  // ---- use() ----
  const MADE = { db: () => dbNs, user: userNs, downloads: () => downloadsNs, artifact: () => artifactNs, self: () => artifactNs, room: () => (lobby ??= makeRoom("")), sample: () => sampleNs, comments: () => commentsNs };
  const made = new Map();
  function use(name) {
    name = String(name);
    if (made.has(name)) return made.get(name);
    const p = connected.then((r) => (r && MADE[name] && (r.caps || []).includes(name) ? MADE[name]() : null));
    if (MADE[name]) made.set(name, p);
    return p;
  }
  const api = Object.freeze({ use });
  Object.defineProperty(window, "hud", { value: api, configurable: false, enumerable: true, writable: false });
  if (window.claude === undefined) Object.defineProperty(window, "claude", { value: api, configurable: false, enumerable: true, writable: false });

  // ---- Mermaid: drawn by the runtime when the page did not bring its own ----
  const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
  addEventListener("load", () => {
    if (window.mermaid) return;
    const todo = [...document.querySelectorAll(".mermaid")].filter((el) => !el.dataset.processed && !el.querySelector("svg"));
    if (!todo.length) return;
    const s = document.createElement("script");
    s.src = MERMAID;
    s.onload = () => {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
        window.mermaid.run({ nodes: todo }).catch((e) => console.warn("mermaid:", e));
      } catch (e) { console.warn("mermaid:", e); }
    };
    document.head.append(s);
  });
})();
