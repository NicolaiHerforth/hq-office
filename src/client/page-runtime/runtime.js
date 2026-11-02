// CLASSIC SCRIPT, not a module: THE PAGE RUNTIME, inside an HTML page's sandboxed frame. The server puts it first in
// the page's <head> (src/server/page-runtime.ts withRuntime), after a JSON block with the page's key and stored keys.
// It gives the page what a Claude artifact gets from its runtime, without leaving the sandbox:
//   window.hud.use(name), and window.claude.use(name) when the page has no window.claude: a Promise of the
//     capability's frozen namespace, or null (unknown name, not framed by the HUD, or no answer in 10 s).
//     db, user and downloads work; artifact, room, comments, sample and the rest are null for now.
//   localStorage and sessionStorage, synchronous: localStorage starts with the stored keys and writes go back through
//     the HUD, so it is kept per page and shared by everyone who opens the HUD; sessionStorage lasts while the page is open.
//   Mermaid: a page with .mermaid diagrams and no mermaid of its own gets them drawn, as an artifact does.
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
  const framed = window.parent !== window && !!PAGE;
  const error = (code, message) => Object.assign(new Error(message), { code });

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
        for (const p of tries) if (p !== port) p.close();
        port.onmessage = onReply;
        for (const m of outbox.splice(0)) port.postMessage(m.msg, m.transfer);
        resolve(d);
      };
      try { window.parent.postMessage({ "hud-page": "hello", page: PAGE, nonce }, "*", [ch.port2]); } catch {}
    };
    hello();
    const timer = setInterval(() => { if (port) clearInterval(timer); else hello(); }, 400);
    setTimeout(() => { clearInterval(timer); if (!port) { for (const p of tries) p.close(); resolve(null); } }, 10_000);
  });
  function onReply(e) {
    const d = e.data || {};
    if (d.snap !== undefined) { listeners.get(d.snap)?.(d); return; }
    const w = waiting.get(d.re);
    if (!w) return;
    waiting.delete(d.re);
    if (d.error) w.reject(error(d.error.code || "unavailable", d.error.message || "refused"));
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

  // ---- use() ----
  const MADE = { db: () => dbNs, user: userNs, downloads: () => downloadsNs };
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
