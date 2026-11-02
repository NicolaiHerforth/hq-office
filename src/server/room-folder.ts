// A room on disk: DATA/rooms/SLUG/ holds files/ (everything shared in the room), shelf.json, brief.md and versions/
// (the earlier versions of a replaced file and of the brief, see "versions" below). The
// database stays the source of truth; the two mirrors are rewritten when the shelf or the brief changes, never on a
// timer. A file a lane saves into an open room's files/ joins the shelf (fs.watch, one watcher per open room, idle
// until something changes there); a file deleted from it drops off the shelf. Files are served sandboxed by
// routes/rooms.ts.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DATA } from "./config.ts";
import { safeName } from "./attachments.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";

export const ROOMS_DIR = resolve(DATA, "rooms");
// Before rooms had folders, every shelf file went into this one folder. Read only: rows are moved out at start.
export const LEGACY_FILES = resolve(DATA, "room-files");
// A burst of writes (a lane saving a large file) settles this long before the shelf looks again.
const QUIET_MS = 400;
// Raster images show inline on the shelf; everything else (SVG among it) is a file.
export const RASTER = /\.(png|jpe?g|gif|webp|avif)$/i;
// Not shelf material: hidden files, an editor's backup, a download still in progress.
const SKIP = /^\.|~$|\.(crdownload|part|partial|download|tmp|swp)$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

type Row = { id: number; slug: string; at: number; by: string | null; kind: string; title: string; url: string; path: string | null };

// Every path below is checked to be inside its room's folder, whatever the caller already validated.
function inside(base: string, ...parts: string[]) {
  const p = resolve(base, ...parts);
  if (p !== base && !p.startsWith(base + sep)) throw new Error("that path is outside the room's folder");
  return p;
}
export function roomDir(slug: string) {
  if (!SLUG.test(slug)) throw new Error(`not a room: ${slug}`);
  return inside(ROOMS_DIR, slug);
}
export const filesDir = (slug: string) => inside(roomDir(slug), "files");
export const fileUrl = (slug: string, name: string) => `/rooms/${slug}/files/${encodeURIComponent(name)}`;

export { safeName };
// ---- versions ----

// A lane's upload under a name already in files/ replaces the file; the one it replaces moves to
// versions/files/NAME/, and a brief replaced moves to versions/brief/. Each version is one file named AT.BY.EXT (when it
// was written, and by whom), so the folder is its own record: no table. The newest MAX_VERSIONS of each are kept.
export const MAX_VERSIONS = 20;
const VERSION = /^(\d{1,15})\.([a-z0-9-]{1,48})(\.[A-Za-z0-9]{1,8})?$/;
export type Version = { v: string; at: number; by: string; path: string };
const versionsDir = (slug: string) => inside(roomDir(slug), "versions");
export const fileVersionsDir = (slug: string, name: string) => inside(versionsDir(slug), "files", safeName(name));
export const briefVersionsDir = (slug: string) => inside(versionsDir(slug), "brief");
const extOf = (name: string) => name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
// A version's author as a file name allows: a lane's name, owner or folder.
const byPart = (by: string | null | undefined) => String(by ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "unknown";
// The versions in a folder, newest first.
export function versions(dir: string): Version[] {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((n) => {
    const m = n.match(VERSION);
    return m ? [{ v: m[1], at: Number(m[1]), by: m[2], path: join(dir, n) }] : [];
  }).sort((a, b) => b.at - a.at);
}
export const version = (dir: string, v: string) => versions(dir).find((x) => x.v === v) ?? null;
// Keeps a copy of what is about to be replaced (a file's path, or a brief's text) as the version written at AT by BY.
export function keepVersion(dir: string, from: { path: string } | { text: string }, at: number, by: string | null, ext: string) {
  mkdirSync(dir, { recursive: true });
  const taken = new Set(versions(dir).map((x) => x.at));
  while (taken.has(at)) at++;
  const dest = inside(dir, `${at}.${byPart(by)}${ext}`);
  if ("path" in from) copyFileSync(from.path, dest);
  else writeFileSync(dest, from.text);
  for (const old of versions(dir).slice(MAX_VERSIONS)) { try { unlinkSync(old.path); } catch {} }
}

// A name in files/ for a new file: the name itself, or name-2.ext, name-3.ext... when it is taken.
function freeName(dir: string, name: string) {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, n))) return n;
  }
}
// The file in a room's files/ that a request names, or null: one plain file, straight inside files/, not a link.
export function servedFile(slug: string, rawName: string) {
  if (!SLUG.test(slug)) return null;
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { return null; }
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name.startsWith(".")) return null;
  let p: string;
  try { p = inside(filesDir(slug), name); } catch { return null; }
  try { return lstatSync(p).isFile() ? { path: p, name } : null; } catch { return null; }
}

// ---- the folder and its mirrors ----

const written = new Map<string, string>(); // what each mirror holds, so an unchanged one is not written again
function mirror(path: string, text: string) {
  if (!written.has(path)) {
    try { written.set(path, readFileSync(path, "utf8")); } catch { written.set(path, ""); }
  }
  if (written.get(path) === text && existsSync(path)) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  written.set(path, text);
}
export function ensureFolder(slug: string) {
  mkdirSync(filesDir(slug), { recursive: true });
  return roomDir(slug);
}
const rows = (slug: string) => db.query("SELECT * FROM room_artifacts WHERE slug = ? ORDER BY id").all(slug) as Row[];
// The shelf as a lane reads it: a file in files/ by its name, anything else by its url.
export function writeShelf(slug: string) {
  const dir = filesDir(slug);
  const items = rows(slug).map((a) => {
    const file = a.path && a.path.startsWith(dir + sep) ? a.path.slice(dir.length + 1) : null;
    return { id: a.id, kind: a.kind, title: a.title, ...(file ? { file } : { url: a.url }), by: a.by, at: new Date(a.at).toISOString() };
  });
  mirror(join(roomDir(slug), "shelf.json"), `${JSON.stringify(items, null, 2)}\n`);
}
export function writeBrief(slug: string) {
  const r = db.query("SELECT brief FROM rooms WHERE slug = ?").get(slug) as { brief: string | null } | null;
  mirror(join(roomDir(slug), "brief.md"), r?.brief ? `${r.brief}\n` : "");
}

// ---- files in ----

function touch(slug: string) {
  db.query("UPDATE rooms SET rev = rev + 1 WHERE slug = ?").run(slug);
}
const kindByName = (name: string) => (RASTER.test(name) ? "image" : "file");

// Bytes into the room's files/ under their own name, and onto the shelf. The bytes land in a hidden file beside files/
// first, so the watcher only ever sees the finished file, already on the shelf. With replace (a lane's upload), a file
// of the same name is replaced and kept as a version; its shelf card stays and shows the new one. Without (the
// owner's from the page, where two pasted pictures are both image.png), the new file gets a free name, name-2.ext.
export async function saveFile(slug: string, given: string, bytes: ArrayBuffer, a: { title?: string; kind?: string; by: string; replace?: boolean }) {
  ensureFolder(slug);
  const tmp = inside(roomDir(slug), `.incoming-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await Bun.write(tmp, bytes);
  const dir = filesDir(slug);
  const wanted = safeName(given);
  let old: { st: ReturnType<typeof lstatSync>; row: Row | null } | null = null;
  if (a.replace) {
    try {
      const st = lstatSync(inside(dir, wanted));
      if (st.isFile()) old = { st, row: db.query("SELECT * FROM room_artifacts WHERE slug = ? AND path = ? ORDER BY id DESC LIMIT 1").get(slug, inside(dir, wanted)) as Row | null };
    } catch {}
  }
  const name = old ? wanted : freeName(dir, wanted);
  const path = inside(dir, name);
  const url = fileUrl(slug, name);
  const kind = a.kind || kindByName(name);
  // The file it replaces is copied out first; the rename then swaps the new one in at once, so the watcher never
  // finds the name missing.
  if (old) {
    try { keepVersion(fileVersionsDir(slug, name), { path }, old.row?.at ?? Math.round(old.st.mtimeMs), old.row?.by ?? "folder", extOf(name)); } catch (e) {
      try { unlinkSync(tmp); } catch {}
      throw e;
    }
  }
  const set = (r: Row, at: number, by: string | null, kind: string, title: string) => db.query("UPDATE room_artifacts SET at = ?, by = ?, kind = ?, title = ? WHERE id = ?").run(at, by, kind, title, r.id);
  const was = old?.row;
  if (was) set(was, Date.now(), a.by, kind, a.title || was.title);
  const id = was ? was.id : Number(db.query("INSERT INTO room_artifacts (slug, at, by, kind, title, url, path) VALUES (?, ?, ?, ?, ?, ?, ?)").run(slug, Date.now(), a.by, kind, a.title || name, url, path).lastInsertRowid);
  try { renameSync(tmp, path); } catch (e) {
    if (was) set(was, was.at, was.by, was.kind, was.title);
    else db.query("DELETE FROM room_artifacts WHERE id = ?").run(id);
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  touch(slug);
  writeShelf(slug);
  return { id, name, url, path, kind, replaced: !!old };
}

// A shelf item taken off by the owner (an image removed from the send box before sending): its file goes too.
export function removeItem(slug: string, id: number) {
  const a = db.query("SELECT * FROM room_artifacts WHERE slug = ? AND id = ?").get(slug, id) as Row | null;
  if (!a) throw new Error(`no item #${id} on the shelf of ${slug}`);
  db.query("DELETE FROM room_artifacts WHERE id = ?").run(id);
  const dir = filesDir(slug);
  if (a.path && a.path.startsWith(dir + sep)) { try { unlinkSync(a.path); } catch {} }
  touch(slug);
  writeShelf(slug);
}

// A room reopened: what changed in its files/ while it was archived.
export const reconcileRoom = (slug: string) => reconcile(slug);

// The shelf follows files/: a new file joins it (by "folder"), a file gone from disk leaves it. A file written in the
// last moments is still being written: it is looked at again once it has settled. Returns whether anything changed.
function reconcile(slug: string) {
  const dir = filesDir(slug);
  if (!existsSync(dir)) return false;
  const known = rows(slug).filter((a) => a.path && a.path.startsWith(dir + sep));
  const byPath = new Set(known.map((a) => a.path));
  let changed = false, settling = false;
  for (const name of readdirSync(dir)) {
    if (SKIP.test(name)) continue;
    const path = inside(dir, name);
    if (byPath.has(path)) continue;
    let st;
    try { st = lstatSync(path); } catch { continue; }
    if (!st.isFile()) continue; // folders and links are not shelf items
    if (Date.now() - st.mtimeMs < QUIET_MS) { settling = true; continue; }
    db.query("INSERT INTO room_artifacts (slug, at, by, kind, title, url, path) VALUES (?, ?, 'folder', ?, ?, ?, ?)").run(slug, Date.now(), kindByName(name), name, fileUrl(slug, name), path);
    changed = true;
  }
  for (const a of known) {
    if (existsSync(a.path!)) continue;
    db.query("DELETE FROM room_artifacts WHERE id = ?").run(a.id);
    changed = true;
  }
  if (changed) { touch(slug); writeShelf(slug); }
  if (settling) later(slug);
  return changed;
}

// ---- watching open rooms ----

const watchers = new Map<string, FSWatcher>();
// The open rooms, watched or not: HUD_FOLDER_WATCH=0 leaves the system's file events off and relies on checkFolders.
const open = new Set<string>();
const WATCH = process.env.HUD_FOLDER_WATCH !== "0";
const pending = new Map<string, ReturnType<typeof setTimeout>>();
function later(slug: string) {
  clearTimeout(pending.get(slug));
  pending.set(slug, setTimeout(() => {
    pending.delete(slug);
    if (reconcile(slug)) bump();
  }, QUIET_MS));
}
export function watchRoom(slug: string) {
  if (open.has(slug)) return;
  open.add(slug);
  ensureFolder(slug);
  if (!WATCH) return;
  try {
    const w = watch(filesDir(slug), () => later(slug));
    w.on("error", () => unwatchRoom(slug));
    watchers.set(slug, w);
  } catch {}
}
export function unwatchRoom(slug: string) {
  open.delete(slug);
  seenMtime.delete(slug);
  watchers.get(slug)?.close();
  watchers.delete(slug);
  clearTimeout(pending.get(slug));
  pending.delete(slug);
}
export const watching = () => [...open];

// The safety net: the system's file events can stall (macOS's fseventsd stops delivering them when it is overloaded),
// so every herdr sync looks at each open room's files/ and catches the shelf up when the folder changed since it last
// looked. One stat per open room every 20 s; an added or removed file changes the folder's time.
const seenMtime = new Map<string, number>();
export function checkFolders() {
  let changed = false;
  for (const slug of open) {
    let m: number;
    try { m = statSync(filesDir(slug)).mtimeMs; } catch { continue; }
    if (seenMtime.get(slug) === m) continue;
    seenMtime.set(slug, m);
    if (reconcile(slug)) changed = true;
  }
  if (changed) bump();
}

// ---- at start ----

// Shelf files from before rooms had folders: each row whose file is in room-files/ moves into its room's files/
// under the same name, and its url and path follow. Safe to run again, and after a stop halfway.
function migrate() {
  const old = db.query("SELECT * FROM room_artifacts WHERE url LIKE '/room-files/%'").all() as Row[];
  for (const a of old) {
    const name = a.url.slice("/room-files/".length);
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) continue;
    const dir = filesDir(a.slug);
    mkdirSync(dir, { recursive: true });
    const src = join(LEGACY_FILES, name);
    let dest = inside(dir, name);
    if (existsSync(src)) {
      if (existsSync(dest)) dest = inside(dir, freeName(dir, name));
      try { renameSync(src, dest); } catch { copyFileSync(src, dest); unlinkSync(src); }
    } else if (!existsSync(dest)) continue; // the file is gone: the row stays as it was
    const file = dest.slice(dir.length + 1);
    db.query("UPDATE room_artifacts SET url = ?, path = ? WHERE id = ?").run(fileUrl(a.slug, file), dest, a.id);
    touch(a.slug);
  }
}
// Where an old /room-files/NAME link went: the moved row's url, or null.
export function movedTo(name: string) {
  if (!/^[\w.-]+$/.test(name)) return null;
  const r = db.query("SELECT url FROM room_artifacts WHERE url LIKE ? ESCAPE '\\'").get(`/rooms/%/files/${name.replace(/[\\%_]/g, "\\$&")}`) as { url: string } | null;
  return r?.url ?? null;
}

// Every room gets its folder and mirrors; old rows move in; each room's files/ is looked at once; open rooms are watched.
export function startFolders() {
  mkdirSync(ROOMS_DIR, { recursive: true });
  const all = db.query("SELECT slug, archived_at FROM rooms").all() as { slug: string; archived_at: number | null }[];
  for (const r of all) ensureFolder(r.slug);
  migrate();
  for (const r of all) {
    reconcile(r.slug);
    writeShelf(r.slug);
    writeBrief(r.slug);
    if (!r.archived_at) watchRoom(r.slug);
  }
}
