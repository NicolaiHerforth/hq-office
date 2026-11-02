// THE PAGE RUNTIME, server side: what an HTML page (pages.ts) keeps through the runtime the HUD injects into it
// (src/client/page-runtime/runtime.js), per page. A page is named by its key: rooms/SLUG/files/NAME, rooms/SLUG/brief
// or briefs/ID. The HUD's bridge (src/client/page-runtime/index.js) derives the key from the frame the page runs in and
// calls the routes in routes/page-runtime.ts; the page itself never reaches the server.
//   storage: the page's localStorage, inlined into the served page (page-runtime-tag.ts) so reads are synchronous.
//   db: documents at slash paths, the shape of a Claude artifact's db (doc/collection, get, set, update, delete,
//       where/orderBy/limit). A write moves the page's version in the state (S.pageData), so every open view refetches.
// Everything a page writes goes through secrets.mask first: a secret value never reaches hud.db.
import { db } from "./db.ts";
import { bump, secrets } from "./push.ts";
import { addStatePart } from "./state.ts";
import { setStorageSource } from "./page-runtime-tag.ts";

export const LIMITS = {
  storageKey: 1024, // characters in one localStorage key
  storageBytes: 1_000_000, // all of a page's keys and values, in characters (it is inlined into the page)
  docBytes: 256 * 1024, // one document, serialized
  docDepth: 32,
  docs: 5000, // documents per page
  pageBytes: 10_000_000, // all of a page's documents
  filters: 10,
  inValues: 30,
  queryLimit: 1000,
  segments: 16,
  segmentBytes: 200,
  pathBytes: 1000,
  body: 2_000_000, // one request from the bridge
};

// ---- page keys ----

const SLUG = "[a-z0-9][a-z0-9-]{0,47}";
const KEY_RE = new RegExp(`^(?:rooms/${SLUG}/(?:files/[^/\\\\\\0]{1,200}|brief)|briefs/\\d{1,9})$`);
export function checkPage(page: unknown): string {
  const p = String(page ?? "");
  if (!KEY_RE.test(p) || p.includes("/files/.")) throw new Error("not a page: rooms/SLUG/files/NAME, rooms/SLUG/brief or briefs/ID");
  return p;
}

// ---- errors in the artifact db's shape: { code, message } ----

export class PageError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const bad = (message: string) => new PageError("invalid_argument", message);

// ---- paths: an even number of segments is a document, an odd number a collection ----

const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
export function segments(path: unknown): string[] {
  if (typeof path !== "string" || !path) throw bad("a path is a non-empty string");
  if (new TextEncoder().encode(path).length > LIMITS.pathBytes) throw bad(`a path is at most ${LIMITS.pathBytes} bytes`);
  const s = path.split("/");
  if (s.length > LIMITS.segments) throw bad(`a path has at most ${LIMITS.segments} segments`);
  for (const x of s) {
    if (!SEG.test(x) || x === "." || x === "..") throw bad(`bad path segment "${x}": letters, digits and _ - . ~ : @ + only`);
    if (new TextEncoder().encode(x).length > LIMITS.segmentBytes) throw bad(`a path segment is at most ${LIMITS.segmentBytes} bytes`);
  }
  return s;
}
const docPath = (path: unknown) => { const s = segments(path); if (s.length % 2) throw bad(`"${path}" has ${s.length} segments: a document path has an even number`); return s; };
const collPath = (path: unknown) => { const s = segments(path); if (!(s.length % 2)) throw bad(`"${path}" has ${s.length} segments: a collection path has an odd number`); return s; };

// ---- bodies: plain JSON objects, masked ----

function depth(v: unknown, d = 0): number {
  if (v === null || typeof v !== "object") return d;
  let max = d + 1;
  for (const x of Object.values(v as object)) max = Math.max(max, depth(x, d + 1));
  return max;
}
function body(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw bad("a document is a plain object");
  let text: string;
  try { text = JSON.stringify(data); } catch { throw bad("a document must be plain JSON"); }
  if (text.length > LIMITS.docBytes) throw bad(`a document is at most ${LIMITS.docBytes / 1024} KiB`);
  if (depth(data) > LIMITS.docDepth) throw bad(`a document is at most ${LIMITS.docDepth} levels deep`);
  return JSON.parse(secrets.mask(text));
}
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function merge(into: Record<string, unknown>, from: Record<string, unknown>) {
  const out = { ...into };
  for (const [k, v] of Object.entries(from)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

// ---- versions: a page's last write, in the state, so open views refetch ----

const versions = new Map<string, number>();
function touched(page: string) {
  versions.set(page, Math.max(Date.now(), (versions.get(page) ?? 0) + 1));
  bump();
}
addStatePart("pageData", () => Object.fromEntries(versions));

// ---- storage ----

type Row = { k: string; v: string };
export function storageOf(page: string): Record<string, string> {
  const rows = db.query("SELECT k, v FROM page_storage WHERE page = ? ORDER BY rowid").all(page) as Row[];
  return Object.fromEntries(rows.map((r) => [r.k, r.v]));
}
// set: { key: value | null } (null removes it); clear: remove every key first. Applied whole or not at all.
export function writeStorage(page: string, set: unknown, clear = false) {
  const changes: [string, string | null][] = [];
  for (const [k, v] of isObj(set) ? Object.entries(set) : []) {
    if (k.length > LIMITS.storageKey) throw bad(`a storage key is at most ${LIMITS.storageKey} characters`);
    if (v !== null && typeof v !== "string") throw bad("a storage value is a string");
    changes.push([secrets.mask(k), v === null ? null : secrets.mask(v)]);
  }
  const next = new Map(clear ? [] : Object.entries(storageOf(page)));
  for (const [k, v] of changes) v === null ? next.delete(k) : next.set(k, v);
  let size = 0;
  for (const [k, v] of next) size += k.length + v.length;
  if (size > LIMITS.storageBytes) throw new PageError("quota_exceeded", `a page's storage holds at most ${LIMITS.storageBytes} characters`);
  db.transaction(() => {
    if (clear) db.query("DELETE FROM page_storage WHERE page = ?").run(page);
    for (const [k, v] of changes) {
      if (v === null) db.query("DELETE FROM page_storage WHERE page = ? AND k = ?").run(page, k);
      else db.query("INSERT INTO page_storage (page, k, v) VALUES (?, ?, ?) ON CONFLICT (page, k) DO UPDATE SET v = excluded.v").run(page, k, v);
    }
  })();
  return { keys: next.size, size };
}

// The served page inlines its stored keys (page-runtime-tag.ts), so the page reads them synchronously.
setStorageSource(storageOf);

// ---- db ----

type DocRow = { path: string; data: string };
const snap = (r: DocRow | null, path: string) => ({ path, id: path.split("/").at(-1), exists: !!r, data: r ? JSON.parse(r.data) : undefined });
const getRow = (page: string, path: string) => db.query("SELECT path, data FROM page_docs WHERE page = ? AND path = ?").get(page, path) as DocRow | null;

function put(page: string, path: string, data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  const now = db.query("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM page_docs WHERE page = ? AND path != ?").get(page, path) as { n: number; bytes: number };
  if (!getRow(page, path) && now.n >= LIMITS.docs) throw new PageError("quota_exceeded", `a page holds at most ${LIMITS.docs} documents`);
  if (now.bytes + text.length > LIMITS.pageBytes) throw new PageError("quota_exceeded", `a page's documents hold at most ${LIMITS.pageBytes / 1e6} MB`);
  const s = path.split("/");
  db.query("INSERT INTO page_docs (page, path, coll, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (page, path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(page, path, s.slice(0, -1).join("/"), text, Date.now());
}

const OPS = new Set(["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains"]);
const RANK = (v: unknown) => (v === null ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : typeof v === "string" ? 3 : Array.isArray(v) ? 4 : 5);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function cmp(a: unknown, b: unknown) {
  if (RANK(a) !== RANK(b)) return RANK(a) - RANK(b);
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}
function matches(doc: Record<string, unknown>, [field, op, value]: [string, string, unknown]) {
  if (!(field in doc)) return false;
  const v = doc[field];
  switch (op) {
    case "==": return same(v, value);
    case "!=": return !same(v, value);
    case "in": return (value as unknown[]).some((x) => same(v, x));
    case "not-in": return !(value as unknown[]).some((x) => same(v, x));
    case "array-contains": return Array.isArray(v) && v.some((x) => same(x, value));
    default: return RANK(v) === RANK(value) && RANK(v) <= 3 && (op === "<" ? cmp(v, value) < 0 : op === "<=" ? cmp(v, value) <= 0 : op === ">" ? cmp(v, value) > 0 : cmp(v, value) >= 0);
  }
}
type Query = { where?: [string, string, unknown][]; orderBy?: [string, "asc" | "desc"] | null; limit?: number | null };
function checkQuery(q: unknown): Required<Query> {
  const query = (isObj(q) ? q : {}) as Query;
  const where = Array.isArray(query.where) ? query.where : [];
  if (where.length > LIMITS.filters) throw bad(`a query has at most ${LIMITS.filters} filters`);
  for (const w of where) {
    if (!Array.isArray(w) || typeof w[0] !== "string" || !w[0] || !OPS.has(w[1])) throw bad(`bad filter: ${JSON.stringify(w)}`);
    if ((w[1] === "in" || w[1] === "not-in") && (!Array.isArray(w[2]) || w[2].length > LIMITS.inValues)) throw bad(`"${w[1]}" takes an array of at most ${LIMITS.inValues} values`);
  }
  const orderBy = query.orderBy && typeof query.orderBy[0] === "string" ? [query.orderBy[0], query.orderBy[1] === "desc" ? "desc" : "asc"] as [string, "asc" | "desc"] : null;
  const limit = query.limit == null ? null : Number(query.limit);
  if (limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= LIMITS.queryLimit)) throw bad(`limit is 1 to ${LIMITS.queryLimit}`);
  return { where, orderBy, limit };
}
export function queryDocs(page: string, coll: string, q?: unknown) {
  collPath(coll);
  const { where, orderBy, limit } = checkQuery(q);
  let docs = (db.query("SELECT path, data FROM page_docs WHERE page = ? AND coll = ? ORDER BY path").all(page, coll) as DocRow[]).map((r) => snap(r, r.path));
  docs = docs.filter((d) => where.every((w) => matches(d.data, w)));
  docs.sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));
  if (orderBy) {
    const [f, dir] = orderBy;
    docs.sort((a, b) => {
      const ha = f in a.data, hb = f in b.data;
      if (!ha || !hb) return ha === hb ? 0 : ha ? -1 : 1; // missing the field: last, either way
      return dir === "desc" ? cmp(b.data[f], a.data[f]) : cmp(a.data[f], b.data[f]);
    });
  }
  return { path: coll, docs: limit ? docs.slice(0, limit) : docs };
}

// Cooperative leases (acquire): in memory, gone with a restart, as a short lease may be.
const leases = new Map<string, { holder: string; expires: number }>();

// One call from the bridge: { op, path, data?, query?, holder?, ttlMs? }.
export function dbCall(page: string, req: Record<string, unknown>) {
  const op = String(req.op ?? "");
  const path = String(req.path ?? "");
  switch (op) {
    case "get": docPath(path); return snap(getRow(page, path), path);
    case "query": return queryDocs(page, path, req.query);
    case "set": docPath(path); put(page, path, body(req.data)); touched(page); return {};
    case "update": {
      docPath(path);
      const row = getRow(page, path);
      if (!row) throw bad(`update: no document at "${path}"`);
      put(page, path, merge(JSON.parse(row.data), body(req.data)));
      touched(page);
      return {};
    }
    case "delete": docPath(path); if (db.query("DELETE FROM page_docs WHERE page = ? AND path = ?").run(page, path).changes) touched(page); return {};
    case "acquire": {
      docPath(path);
      const holder = String(req.holder ?? "").slice(0, 200);
      if (!holder) throw bad("acquire needs a holder");
      const ttl = Math.min(600_000, Math.max(1000, Number(req.ttlMs) || 30_000));
      const k = `${page}\n${path}`, now = Date.now(), held = leases.get(k);
      if (held && held.expires > now && held.holder !== holder) return { acquired: false, expiresAt: new Date(held.expires).toISOString() };
      const lease = { holder, expires: now + ttl };
      leases.set(k, lease);
      if (isObj(req.data)) { const row = getRow(page, path); put(page, path, merge(row ? JSON.parse(row.data) : {}, body(req.data))); touched(page); }
      return { acquired: true, version: lease.expires, expiresAt: new Date(lease.expires).toISOString(), holder };
    }
  }
  throw bad(`unknown db call "${op}"`);
}

// ---- reading it back (hud page data PAGE [PATH]) ----

export function pageData(page: string, path?: string) {
  if (path) return segments(path).length % 2 ? queryDocs(page, path) : snap(getRow(page, path), path);
  const docs = db.query("SELECT path, data FROM page_docs WHERE page = ? ORDER BY path").all(page) as DocRow[];
  return { page, storage: storageOf(page), docs: Object.fromEntries(docs.map((r) => [r.path, JSON.parse(r.data)])) };
}
// Every page that keeps anything, with how much.
export function pagesWithData() {
  return db.query(`SELECT page, SUM(docs) AS docs, SUM(keys) AS keys FROM (
    SELECT page, COUNT(*) AS docs, 0 AS keys FROM page_docs GROUP BY page
    UNION ALL SELECT page, 0, COUNT(*) FROM page_storage GROUP BY page) GROUP BY page ORDER BY page`).all() as { page: string; docs: number; keys: number }[];
}
