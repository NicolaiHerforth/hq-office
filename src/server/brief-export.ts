// BRIEF EXPORT: a floor's brief, a room's brief or a room's page as one file to send to someone without HQ Office. The
// one path: what is being exported (Source), that frozen into a self-contained HTML document (freeze), and the file:
// that document as it is, or printed to a PDF (brief-export-print.ts). The HUD's EXPORT and hud brief export both come here.
//
// What goes in is the source's own text and what it shows: the pictures, fonts, stylesheets and scripts it names on
// this machine, as data, each one named to the owner; the scripts and stylesheets it names on the web, fetched when the
// owner asks for a file so that it works offline; its title and date. What stays out: comments, threads, page storage and db rows, who wrote it, floors,
// machines, and whatever a reference to an HQ thing names: the reader could not follow it, and its title is internal. HTML
// comments in a page's source are dropped, and so is noscript: the file runs scripts. A frame not at a web address (srcdoc,
// data:, javascript: and the rest) is left out and named. A secret value the HUD holds right now is masked in the source before anything
// renders it (rendering changes characters a value may hold) and again over the whole file; what masking cannot catch is
// warned about before there is a file. No call back to the HUD: nothing in the file names it, and the file's own CSP
// refuses anything but https.
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DIR, UPLOADS } from "./config.ts";
import { db } from "./db.ts";
import { secrets } from "./push.ts";
import { noLongerHeld } from "./secret-ledger.ts";
import { looksLikeKeys } from "./brief-export-scan.ts";
import { floorOr } from "./floors.ts";
import { HTML_EXT, asDocument, isPage, pageTitle, themed } from "./pages.ts";
import { roomView } from "./rooms.ts";
import { LEGACY_FILES, briefVersionsDir, fileVersionsDir, movedTo, servedFile, version } from "./room-folder.ts";
import { extOf, namedFile } from "./attachments.ts";
import { printPdf, trustedHosts } from "./brief-export-print.ts";
import { guard, plainlyPrivate } from "./brief-export-guard.ts";
import { MAX_LIBRARY_BYTES, NOT_PUBLIC, fetchLibrary, type Fetched } from "./brief-export-web.ts";
import { decodedAttribute, maskSpelled } from "./brief-export-spelled.ts";
import { esc } from "../client/core/format.js";
import { md, mdInline } from "../client/core/markdown.js";
import { parseRef, REF_SOURCE } from "../client/core/refs.js";

export type Format = "html" | "pdf";
// Something the owner should read before sending the file. only: true of that format alone.
type Note = { text: string; only?: Format };
// What is being exported. base: its address on the HUD, which its relative links resolve against.
// refs: what its title referred to, taken out before it is used anywhere.
// tooBig: its file is over MAX_PAGE_BYTES, and was not read.
type Source = { key: string; floor: string; title: string; at: number; text: string; markdown: boolean; base: string; refs?: string[]; tooBig?: boolean };
// fromRoom: a room's own folder, where a page's stylesheets and scripts live. The general uploads are the owner's
// attachments, for any floor: a page may show a picture from them, never run or style itself with a file from them.
type StoredFile = { path: string; name: string; fromRoom: boolean };

const SLUG = "[a-z0-9][a-z0-9-]{0,47}";
const BRIEF_KEY = /^briefs\/(\d{1,9})$/, ROOM_BRIEF_KEY = new RegExp(`^rooms/(${SLUG})/brief$`), ROOM_FILE_KEY = new RegExp(`^rooms/(${SLUG})/files/(.+)$`);

// What hud and the page may call a thing: 12, #brief/12, briefs/12, rooms/SLUG/brief, rooms/SLUG/files/NAME, or the
// address after #page/, ?v=V included.
export function parseKey(raw: unknown) {
  const text = String(raw ?? "").trim().replace(/^#/, "").replace(/^page\//, "");
  const asked = text.match(/\?v=(\d{1,15})$/);
  const path = asked ? text.slice(0, asked.index) : text, v = asked?.[1] ?? null;
  const brief = path.match(/^(?:brief\/)?(\d{1,9})$/);
  return { key: brief ? `briefs/${brief[1]}` : path, v };
}

const textOf = (path: string) => readFileSync(path, "utf8");
// Past this, reading a page holds up the HUD whatever it is made of. A brief cannot get there; a file in a room's folder can.
const MAX_PAGE_BYTES = 20 * 1024 * 1024;
// Why no file can be made of a page: the panel and hud say it, and offer none.
class NoFile extends Error {}
function sourceOf(key: string, v: string | null): Source {
  let m = key.match(BRIEF_KEY);
  if (m) {
    const b = db.query("SELECT floor, at, title, body FROM briefs WHERE id = ?").get(Number(m[1])) as { floor: string; at: number; title: string; body: string } | null;
    if (!b) throw new Error(`no brief #${m[1]}`);
    return { key, floor: floorOr(b.floor), title: b.title, at: b.at, text: b.body, markdown: !isPage(b.body), base: `/briefs/${m[1]}.html` };
  }
  if ((m = key.match(ROOM_BRIEF_KEY))) {
    const r = roomView(m[1]);
    const old = v ? version(briefVersionsDir(m[1]), v) : null;
    if (v && !old) throw new Error(`no version ${v} of the brief of ${m[1]}`);
    const text = old ? textOf(old.path) : r.brief;
    if (!text) throw new Error(`${m[1]} has no brief to export`);
    return { key, floor: floorOr(r.floor), title: r.title, at: old?.at ?? r.briefAt ?? Date.now(), text, markdown: !isPage(text), base: `/rooms/${m[1]}/brief.html` };
  }
  if ((m = key.match(ROOM_FILE_KEY))) {
    const r = roomView(m[1]);
    const f = servedFile(m[1], encodeURIComponent(m[2])) ?? servedFile(m[1], m[2]);
    if (!f) throw new Error(`no file ${m[2]} in ${m[1]}`);
    if (!HTML_EXT.test(f.name)) throw new Error(`${f.name} is not a page: export takes a brief or a room's .html file`);
    const old = v ? version(fileVersionsDir(m[1], f.name), v) : null;
    if (v && !old) throw new Error(`no version ${v} of ${f.name}`);
    const tooBig = statSync(old?.path ?? f.path).size > MAX_PAGE_BYTES, text = tooBig ? "" : textOf(old?.path ?? f.path);
    return { key, floor: floorOr(r.floor), title: pageTitle(text) || f.name.replace(HTML_EXT, ""), at: old?.at ?? statSync(f.path).mtimeMs, text, markdown: false, base: `/rooms/${m[1]}/files/${encodeURIComponent(f.name)}`, tooBig };
  }
  throw new Error(`nothing to export at ${key || "(nothing named)"}: give a brief's number, rooms/SLUG/brief or rooms/SLUG/files/NAME.html`);
}

// ---- the file's own rules ----

const directives = (scripts: boolean, frames = "https: data: blob:") => [
  "default-src 'none'",
  scripts ? "script-src 'unsafe-inline' 'unsafe-eval' https: blob:" : "script-src 'none'",
  scripts ? "style-src 'unsafe-inline' https:" : "style-src 'unsafe-inline'",
  scripts ? "img-src data: blob: https:" : "img-src data:",
  scripts ? "font-src data: https:" : "font-src data:",
  scripts ? "media-src data: blob: https:" : "media-src data:",
  ...(scripts ? ["connect-src https: data: blob:", `frame-src ${frames}`, "worker-src blob:"] : []),
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
// What the printing Chrome gets with the file: the same rules in a sandbox, with no dialogs, popups or downloads, so
// its scripts run in an opaque origin and nothing can hold the print up.
export const PRINT_CSP = `sandbox allow-scripts; ${directives(true, "https: data:")}`;
// The file on its way out of the HUD: a download, and sandboxed should anyone open its address.
export const FILE_CSP = `sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; ${directives(true)}`;

// Paper never scrolls: whatever would run off the sheet wraps, and a block stays whole where it can. For a page this is
// laid over its own styles, and for print only.
const PRINT_CSS = `@media print {
  html, body { height: auto !important; overflow: visible !important; }
  pre, pre code { white-space: pre-wrap !important; overflow-wrap: break-word !important; word-break: break-word !important; }
  pre, figure, img, svg, canvas, blockquote, tr, .codebox { break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  thead { display: table-header-group; }
  img, svg, canvas, video { max-width: 100% !important; height: auto; }
}`;

const headTags = (scripts: boolean, more: string) => `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${directives(scripts)}"><meta name="referrer" content="no-referrer"><style media="print">${PRINT_CSS}</style>${more}`;
// Right after the doctype, or at the very start: before anything of the page's can run, whatever it writes. Looking for
// its <head> would find one inside an attribute, a title or a script, and the rules would land there and do nothing. A
// browser opens the head for these tags, adds the page's <html> attributes to the root, and ignores its <head>.
function first(html: string, tags: string) {
  const at = /^\s*(?:<!---->\s*)*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + tags + html.slice(at);
}
const inScript = (js: string) => js.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

// ---- the look of a markdown brief ----

// Without their comments: those speak to whoever works on the HUD, not to the reader of a file.
const css = (path: string) => textOf(join(DIR, "src", "client", path)).replace(/\/\*[\s\S]*?\*\//g, "");
function tokenBlocks() {
  const base = css("core/base.css");
  const light = base.match(/^:root \{[^}]*\}/m)?.[0] ?? "";
  const system = base.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{[^}]*\}\s*\}/)?.[0] ?? "";
  const dark = base.match(/:root\[data-theme="dark"\] \{[^}]*\}/)?.[0] ?? "";
  return { light, system, dark };
}
const tokenIn = (block: string, name: string) => block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim() ?? "";
const nunito = () => `@font-face { font-family: "Nunito"; font-weight: 200 1000; font-style: normal; font-display: swap; src: url("data:font/woff2;base64,${readFileSync(join(import.meta.dir, "brief-export-assets", "nunito-latin.woff2")).toString("base64")}") format("woff2"); }`;

// ---- freezing ----

const MEDIA: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
};
const MAX_INLINE = 64 * 1024 * 1024;
const list = (names: Iterable<string>) => { const all = [...names]; return all.slice(0, 8).join(", ") + (all.length > 8 ? ` and ${all.length - 8} more` : ""); };

// A link's last word, for naming what was left out. It reaches a terminal (hud), so no control characters.
function lastPart(raw: string) {
  const tail = raw.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) ?? "";
  let name = tail;
  try { name = decodeURIComponent(tail); } catch {}
  // Masked before it is cut: a cut value is no longer one the mask can find.
  return secrets.mask(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80);
}
// An attribute as the browser reads it: the rewriter gives it as written, entities and all.
const attr = (el: { getAttribute(name: string): string | null }, name: string) => { const v = el.getAttribute(name); return v === null ? null : decodedAttribute(v); };
// An address as the URL parser reads it, the one place this is done: no space or control character at the ends, and no tab
// or newline anywhere.
const linkOf = (raw: string) => {
  let to = raw.length;
  while (to > 0 && raw.charCodeAt(to - 1) <= 0x20) to--;
  return raw.slice(0, to).replace(/^[\u0000-\u0020]+|[\t\n\r]/g, "");
};
const link = (el: { getAttribute(name: string): string | null }, name: string) => { const v = attr(el, name); return v === null ? null : linkOf(v); };
const isHttps = (url: string) => /^https:/i.test(url);
const hostIn = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };
// Is a live secret's value in these bytes? They cannot be masked in a picture: such a file stays out.
function holdsSecret(bytes: Buffer) {
  for (const text of [bytes.toString("latin1"), bytes.toString("utf8")]) if (secrets.mask(text) !== text) return true;
  return false;
}
// A held value in text a browser will read as HTML, however it is spelled there.
const masked = (text: string) => secrets.mask(maskSpelled(text, secrets.carry()));
// The data: addresses in a finished file, in whatever tag or style holds them. One whose text a browser would read (text, an
// SVG) is decoded once and asked about, and if it holds a held value it is cut; any other is left byte for byte. Each search
// goes on from where the last address ended, and a media type is short, so this reads the file once. Not seen: a value an
// SVG spells again inside itself, with XML entities or an SVG in an SVG, or as UTF-16.
const READ_AS_TEXT = /^\s*(?:text\/|image\/svg\+xml|;|$)/i;
function withoutHeldData(html: string, cut: () => void) {
  if (!secrets.size()) return html;
  const parts: string[] = [], scan = /\bdata:/gi, ends = /[\s"'()<>]/g;
  const clean = new Set<string>();
  let done = 0;
  for (let m = scan.exec(html); m; m = scan.exec(html)) {
    const head = html.slice(m.index + 5, m.index + 133), type = head.slice(0, Math.max(0, head.indexOf(","))), start = m.index + 6 + type.length, before = html[m.index - 1];
    if (!head.includes(",") || !READ_AS_TEXT.test(type)) continue;
    ends.lastIndex = start;
    const end = before === '"' || before === "'" ? html.indexOf(before, start) : before === "(" ? html.indexOf(")", start) : ends.exec(html)?.index ?? -1;
    const body = html.slice(start, end < 0 ? html.length : end);
    scan.lastIndex = start + body.length;
    const address = `${type},${body}`;
    if (clean.has(address)) continue;
    let text = decodedAttribute(body);
    try { text = decodeURIComponent(text); } catch { text = unescape(text); }
    if (/;\s*base64\s*$/i.test(type)) text = Buffer.from(text, "base64").toString("utf8");
    if (masked(text) === text) { clean.add(address); continue; }
    parts.push(html.slice(done, m.index));
    done = start + body.length;
    cut();
  }
  return done ? parts.join("") + html.slice(done) : html;
}
// What is removed leaves an empty comment: what stood either side must not join into a tag, as < and iframe would.
const NOTHING = "<!---->";
const gone = (el: HTMLRewriterTypes.Element) => el.replace(NOTHING, { html: true });
const unwrapped = (el: HTMLRewriterTypes.Element) => { el.before(NOTHING, { html: true }); el.after(NOTHING, { html: true }); el.removeAndKeepContent(); };
// Why something a page names stays out of the file.
type Why = keyof typeof WHY;
const WHY = {
  missing: "Left out, because it is not on this machine any more",
  elsewhere: "Left out, because it is not at a public https address, so nobody else could reach it",
  floor: "Left out, because it belongs to another floor",
  link: "Named in the text, but the file is not inside",
  place: "Link cut, because it points at this machine or a private network",
  secret: "Left out, because it holds a secret value",
  large: "Left out, because the file would get too large",
  kind: "Left out, because this kind of file cannot go inside",
  uploads: "Left out, because a page's scripts and styles can come only from its own room's folder",
  frame: "Left out, because a frame that is not at a web address cannot go in the file",
};
// A reference in running text, as markdown.js finds it; the sentence keeps its trailing punctuation.
const BARE_REF = new RegExp(`(^|[\\s(])(#${REF_SOURCE})`, "g");
const ANY_REF = new RegExp(`#${REF_SOURCE}`);
const NEUTRAL = "(internal reference)";
const neutral = (text: string, found: (ref: string) => void) => text.replace(BARE_REF, (_all, before, whole) => {
  let end = whole.length;
  while (end > 0 && ".,;:!?".includes(whole[end - 1])) end--;
  const ref = whole.slice(0, end);
  found(ref);
  return `${before}${NEUTRAL}${whole.slice(ref.length)}`;
});
// What a script that really runs imports from elsewhere, as a parser reads it, so a comment, a string or a data island is
// not an import. An import() counts wherever it stands: the file may need it. One built from pieces is not seen. Parsing
// holds up the whole HUD, so a make reads MAX_PARSED in all. null: a script that has the word and was not read, because that
// is spent or the parser refused it, so nothing can be said of it.
const RUNS = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5]|text\/(?:jscript|livescript))$/;
const MAX_PARSED = 3 * 1024 * 1024;
const ADDRESS = /^(?:(?:https?:)?\/\/|\.{0,2}\/)/i;
const reader = new Bun.Transpiler({ loader: "js" });
function importsOf(text: string, rawType: string, parsing: { left: number }): string[] | null {
  const type = rawType.trim().toLowerCase(), map = type === "importmap";
  if (!map && (!RUNS.test(type) || !/\b(?:im|ex)port\b/.test(text))) return [];
  if (text.length > parsing.left) return null;
  parsing.left -= text.length;
  try {
    if (!map) return reader.scanImports(text).filter((i) => i.kind === "dynamic-import" || (type === "module" && i.kind === "import-statement")).map((i) => i.path).filter((a) => ADDRESS.test(a));
    const { imports, scopes } = JSON.parse(text);
    return [imports, ...Object.values(scopes ?? {})].flatMap((part) => (part && typeof part === "object" ? Object.values(part) : [])).filter((a): a is string => typeof a === "string" && ADDRESS.test(a));
  } catch {
    return map ? [] : null;
  }
}
const IMPORTED = "it is imported when the page runs";
const MODULE_WHY = "it is a module, which loads more of itself from the web";
const SKIP = /^(?:data|blob|mailto|tel|javascript):/i;
const KEEP = { keep: true } as const;
const ROOM_FILE_PATH = new RegExp(`^/rooms/(${SLUG})/files/([^/]+)$`), ROOM_FILES = new RegExp(`^/rooms/(${SLUG})/files/`);
// An address in a style: quoted, or with no space, quote or bracket in it. Nothing here can go back over what it read.
const CSS_URL = /url\(\s*(?:"([^"\\]*(?:\\[^][^"\\]*)*)"|'([^'\\]*(?:\\[^][^'\\]*)*)'|((?:[^'"()\s\\]|\\[^])[^'"()\s\\]*(?:\\[^][^'"()\s\\]*)*))\s*\)/gi;
const ATTRS: [string, string[]][] = [["img", ["src"]], ["source", ["src"]], ["video", ["src", "poster"]], ["audio", ["src"]], ["track", ["src"]], ["input", ["src"]], ["image", ["href", "xlink:href"]], ["use", ["href", "xlink:href"]], ["feimage", ["href", "xlink:href"]], ["script", ["href", "xlink:href"]], ["iframe", ["src"]], ["frame", ["src"]], ["embed", ["src"]], ["object", ["data"]]];
// How many distinct addresses of a page are looked up in the database and on the disk, on the thread the question panel needs:
// this many, each naming a small file, take about 0.7 s at load 15. Nothing else counts: the 20 MB stop bounds the rest.
const MAX_LOOKUPS = 20_000;
const TOO_MANY = `This page has too many links to export: more than ${MAX_LOOKUPS.toLocaleString("en-US")} different links, pictures and style addresses on this machine. No file was made.`;
// A frame at a web address, or with nothing in it. Any other has its page in its own address, or nowhere a reader could reach.
const AT_THE_WEB = /^(?:https?:|about:blank$|(?![a-z][a-z0-9+.-]*:))/i;

// web: what was fetched from the web for this file; null when only looking, which asks the web for nothing.
export function freezer(src: Source, web: Map<string, Fetched> | null) {
  const left = new Map<Why, Set<string>>(), online = new Set<string>(), carried = new Set<string>(), carriedText: string[] = [], unread = new Set<string>();
  const leave = (raw: string, why: Why) => { if (!left.has(why)) left.set(why, new Set()); left.get(why)!.add(lastPart(raw)); };
  const refs = new Set<string>(), fromWeb = new Set<string>(), notFetched = new Map<string, string>(), parsing = { left: MAX_PARSED };
  const deferred: string[] = [];
  // The HUD's own address for this export. Random, so that nothing in a page or a stylesheet can spell it: a file on this
  // machine is reached only by a name relative to the page.
  const HOME = `${crypto.randomUUID()}.invalid`;
  let spent = 0, plainDepth = 0, lookups = 0, titled = false, viewport = false, codeLeft = false, styleText = "", wordsText = "", scriptText = "", scriptType: string | null = null;
  const reference = (raw: string) => { const p = parseRef(raw); refs.add(p ? `#${p.ref}` : lastPart(raw)); };
  for (const ref of src.refs ?? []) reference(ref);
  const needsOnline = (url: string, base?: string) => { try { const u = new URL(url, base?.startsWith("https:") ? base : undefined); if (u.protocol === "https:") online.add(u.host); } catch {} };
  // A sentence keeps its words and loses what a reference names. A page's scripts and styles are not its words.
  const words = (text: string) => neutral(text, reference);
  // A script's imports, which no tag names. An import map's addresses count the same.
  const imports = (text: string, type: string, name = "a script in the page") => {
    const found = importsOf(text, type, parsing);
    if (!found) unread.add(lastPart(name));
    for (const address of found ?? []) notFetched.set(lastPart(address), IMPORTED);
  };

  // Each answer once per make, however often the page asks: a 20 MB page can name one file a million times.
  const floors = new Map<string, boolean>(), sizes = new Map<string, number>(), uris = new Map<string, string | null>(), texts = new Map<string, string>();
  const carry = (text: string) => { carriedText.push(text); return text; };
  const once = <T>(known: Map<string, T>, key: string, work: () => T) => { if (!known.has(key)) known.set(key, work()); return known.get(key)!; };
  const sameFloor = (slug: string) => once(floors, slug, () => {
    const r = db.query("SELECT floor FROM rooms WHERE slug = ?").get(slug) as { floor: string } | null;
    return !!r && floorOr(r.floor) === src.floor;
  });
  // A path on the HUD that names a stored file. A room's files only from this floor: this file leaves the machine.
  function stored(path: string): StoredFile | null {
    let m = path.match(ROOM_FILE_PATH);
    if (m) {
      const f = sameFloor(m[1]) ? servedFile(m[1], m[2]) : null;
      return f && { ...f, fromRoom: true };
    }
    let f = null;
    if ((m = path.match(/^\/uploads\/([^/]+)$/))) f = namedFile(UPLOADS, m[1]);
    else if ((m = path.match(/^\/room-files\/([^/]+)$/))) {
      const to = movedTo(lastPart(m[1]));
      if (to) return stored(to);
      f = namedFile(LEGACY_FILES, m[1]);
    }
    return f && { ...f, fromRoom: false };
  }
  // What a link in the page points at: left as it is (the web, this page), a file on this machine, or nothing it can
  // carry (anything else on the HUD or this machine).
  const answers = new Map<string, ReturnType<typeof lookUp>>();
  function resolve(raw: string, base = src.base) {
    const t = linkOf(raw);
    if (!t || t.startsWith("#") || SKIP.test(t)) return KEEP;
    return once(answers, `${base}\0${t}`, () => lookUp(t, base));
  }
  function lookUp(t: string, base: string): { keep: true } | { keep: false; file: StoredFile } | { keep: false; file: null; why: Why } {
    let u: URL;
    try { u = new URL(t, base.startsWith("https:") ? base : `http://${HOME}${base}`); } catch { return { keep: false, file: null, why: "elsewhere" }; }
    if (u.protocol === "https:") return KEEP;
    if (u.hostname !== HOME) return { keep: false, file: null, why: "elsewhere" };
    if (++lookups > MAX_LOOKUPS) throw new NoFile(TOO_MANY);
    const file = stored(u.pathname);
    if (file) return { keep: false, file };
    const room = u.pathname.match(ROOM_FILES);
    return { keep: false, file: null, why: room && !sameFloor(room[1]) ? "floor" : "missing" };
  }
  const budget = (bytes: number) => { if (spent + bytes > MAX_INLINE) return false; spent += bytes; return true; };
  // The file as data, or null when it stays out (and said so under raw, the name the page gave it).
  function dataUri(file: StoredFile, raw: string) {
    const type = MEDIA[extOf(file.name)];
    if (!type) { leave(raw, "kind"); return null; }
    if (!budget(once(sizes, file.path, () => statSync(file.path).size))) { leave(raw, "large"); return null; }
    const uri = once(uris, file.path, () => {
      const bytes = readFileSync(file.path);
      // An SVG is text: a secret in it would not survive the last mask as base64.
      if (type !== "image/svg+xml") return holdsSecret(bytes) ? null : `data:${type};base64,${bytes.toString("base64")}`;
      return `data:${type};base64,${Buffer.from(carry(masked(bytes.toString("utf8")))).toString("base64")}`;
    });
    if (uri === null) { leave(raw, "secret"); return null; }
    carried.add(lastPart(file.name));
    return uri;
  }
  function textFile(file: StoredFile, ext: string, raw: string) {
    if (!file.fromRoom) { leave(raw, "uploads"); return null; }
    if (extOf(file.name) !== ext) { leave(raw, "kind"); return null; }
    if (!budget(once(sizes, file.path, () => statSync(file.path).size))) { leave(raw, "large"); return null; }
    carried.add(lastPart(file.name));
    return once(texts, file.path, () => carry(masked(textOf(file.path))));
  }
  // A link's replacement: the data, or empty when it is left out (and said so).
  function inlined(raw: string, base?: string): string | null {
    const r = resolve(raw, base);
    if (r.keep) { needsOnline(raw, base); return null; }
    if (!r.file) { leave(raw, r.why); return ""; }
    return dataUri(r.file, raw) ?? "";
  }
  // base: where the stylesheet came from. One from the web moves into the file, so what it names relative to itself
  // needs its whole address.
  const freezeCss = (text: string, base?: string) => text.replace(CSS_URL, (all, double, single, bare) => {
    const url = double ?? single ?? bare;
    if (!url) return all;
    // A browser reads the escapes, and this does not.
    if (url.includes("\\")) { leave(url, "elsewhere"); return `url("")`; }
    const uri = inlined(url, base);
    if (uri !== null) return `url("${uri}")`;
    return base?.startsWith("https:") && !url.startsWith("#") && !SKIP.test(url) ? `url("${new URL(url, base).href}")` : all;
  });
  // An address is whatever runs up to a space: a comma ends a candidate only after one, or at the end of the address.
  // Runs of spaces and of commas are one first: the search would go over a run again from each place in it.
  const srcset = (value: string) => [...value.replace(/\s+/g, " ").replace(/,{2,}/g, ",").matchAll(/\s*(\S*[^\s,])(\s+[^,]*)?\s*(?:,|$)/g)].map(([, url, size]) => {
    const uri = inlined(url);
    return uri === null ? `${url}${size ?? ""}` : uri ? `${uri}${size ?? ""}` : "";
  }).filter(Boolean).join(", ");

  // A script's text in its place. Written inline it would run where it stands, before the page it was deferred until.
  function inlineScript(el: HTMLRewriterTypes.Element, text: string) {
    for (const name of ["src", "integrity", "crossorigin"]) el.removeAttribute(name);
    if (el.hasAttribute("defer")) {
      const type = attr(el, "type");
      deferred.push(`<script${type ? ` type="${esc(type)}"` : ""}>${inScript(text)}</script>`);
      gone(el);
    } else if (el.selfClosing) el.replace(`<script>${inScript(text)}</script>`, { html: true });
    else el.setInnerContent(inScript(text), { html: true });
  }
  // What a tag names that cannot come: stays named, and the page's address for it stays out of the file if it is private.
  function refused(el: HTMLRewriterTypes.Element, url: string, why: string) {
    notFetched.set(lastPart(url), why);
    if (why === NOT_PUBLIC) { if (el.tagName === "link") gone(el); else el.removeAttribute("src"); }
  }
  // A link out of the page: kept if a reader could follow it, its words kept otherwise.
  function linkFrom(el: HTMLRewriterTypes.Element, name: string, gone: () => void) {
    const href = link(el, name);
    if (href === null) return;
    if (href.startsWith("#")) {
      if (parseRef(href)) { reference(href); gone(); }
      return;
    }
    const r = resolve(href);
    const host = /^https?:/i.test(href) ? hostIn(href) : "";
    if (host && plainlyPrivate(host, trustedHosts())) { leave(href, "place"); gone(); return; }
    if (r.keep || host) return;
    leave(href, "link");
    gone();
  }
  // A page with no reference anywhere in it skips the words: a call into this for every text node is most of what a big
  // page costs.
  const build = (html: string) => {
    const rewriter = new HTMLRewriter()
    .onDocument({
      comments(c) { c.after(NOTHING, { html: true }); c.remove(); },
      ...(ANY_REF.test(html) ? { text(t: HTMLRewriterTypes.Text) {
        if (plainDepth) return;
        wordsText += t.text;
        if (t.lastInTextNode) { t.replace(words(wordsText), { html: true }); wordsText = ""; }
        else t.remove();
      } } : {}),
      end(end) { if (deferred.length) end.append(deferred.splice(0).join(""), { html: true }); },
    })
    // First, so nothing it names is said to be inside. Its page is markup twice over, which nothing here reads.
    .on("iframe, frame, object, embed", { element(el) {
      if (!(el.tagName === "iframe" && el.hasAttribute("srcdoc")) && AT_THE_WEB.test(link(el, el.tagName === "object" ? "data" : "src") ?? "")) return;
      leave(attr(el, "title") || attr(el, "name") || attr(el, "id") || "a frame with no name", "frame");
      codeLeft = true;
      gone(el);
    } })
    // A tag written <style/> inside an svg has no end, and no words to protect.
    .on("script, style, noscript", { element(el) { if (el.selfClosing) return; plainDepth++; el.onEndTag(() => { plainDepth--; }); } })
    .on("noscript", { element(el) { gone(el); } })
    .on("script", {
      // With a src, a script's own text never runs.
      element(el) { scriptType = el.hasAttribute("src") ? null : attr(el, "type") ?? ""; },
      text(t) {
        scriptText += t.text;
        if (t.lastInTextNode) { if (scriptType !== null) imports(scriptText, scriptType); scriptText = ""; }
      },
    })
    .on("base", { element(el) { gone(el); } })
    .on("title", { element() { titled = true; } })
    .on("meta[http-equiv]", { element(el) { if (/refresh/i.test(attr(el, "http-equiv") ?? "")) gone(el); } })
    .on("meta[name]", { element(el) {
      const name = (attr(el, "name") ?? "").trim();
      if (/^referrer$/i.test(name)) gone(el);
      else if (/^viewport$/i.test(name)) viewport = true;
    } })
    .on("hud-card", { element(el) { reference(attr(el, "ref") ?? ""); gone(el); } })
    .on("[style]", { element(el) { const v = attr(el, "style") ?? ""; if (!el.removed && /url\(/i.test(v)) el.setAttribute("style", freezeCss(v)); } })
    .on("a", { element(el) {
      linkFrom(el, "href", () => unwrapped(el));
      if (el.hasAttribute("xlink:href")) linkFrom(el, "xlink:href", () => unwrapped(el));
    } })
    .on("area", { element(el) { linkFrom(el, "href", () => gone(el)); } })
    .on("form", { element(el) { linkFrom(el, "action", () => el.removeAttribute("action")); } })
    .on("button, input", { element(el) { linkFrom(el, "formaction", () => el.removeAttribute("formaction")); } })
    .on("script[src]", { element(el) {
      const url = link(el, "src") ?? "", r = resolve(url);
      if (r.keep) {
        if (!isHttps(url)) return;
        if (plainlyPrivate(hostIn(url), trustedHosts())) { refused(el, url, NOT_PUBLIC); return; }
        const got = isModule(el) ? { why: MODULE_WHY } : web?.get(url);
        if (!got && !web) return;
        if (got && "text" in got && budget(got.text.length)) {
          fromWeb.add(lastPart(url));
          imports(got.text, "", url);
          carriedText.push(masked(got.text));
          inlineScript(el, got.text);
        } else refused(el, url, got && "why" in got ? got.why : "the file would get too large");
        return;
      }
      if (!r.file) leave(url, r.why);
      const text = r.file ? textFile(r.file, "js", url) : null;
      el.removeAttribute("src");
      if (text === null) codeLeft = true;
      else {
        imports(text, attr(el, "type") ?? "", url);
        inlineScript(el, text);
      }
    } })
    .on("link", { element(el) {
      const url = link(el, "href") ?? "", rel = (attr(el, "rel") ?? "").toLowerCase();
      const sheet = /stylesheet/.test(rel), icon = /icon/.test(rel);
      // Anything else a link asks for (preconnect, preload, prefetch) only reaches out, and shows nothing.
      if (!url || (!sheet && !icon)) { gone(el); return; }
      const r = resolve(url);
      const media = attr(el, "media");
      const asStyle = (css: string) => el.replace(`<style${media ? ` media="${esc(media)}"` : ""}>${css.replace(/<\/(style)/gi, "<\\/$1")}</style>`, { html: true });
      if (r.keep) {
        if (!sheet || !isHttps(url)) return;
        if (plainlyPrivate(hostIn(url), trustedHosts())) { refused(el, url, NOT_PUBLIC); return; }
        if (!web) return;
        const got = web.get(url);
        if (got && "text" in got && budget(got.text.length)) {
          fromWeb.add(lastPart(url));
          carriedText.push(masked(got.text));
          asStyle(freezeCss(got.text, url));
        } else refused(el, url, got && "why" in got ? got.why : "the file would get too large");
      } else if (sheet) {
        if (!r.file) leave(url, r.why);
        const text = r.file ? textFile(r.file, "css", url) : null;
        if (text === null) { codeLeft = true; gone(el); return; }
        asStyle(freezeCss(text, new URL(url, `http://${HOME}${src.base}`).pathname));
      } else {
        const uri = inlined(url);
        if (uri) el.setAttribute("href", uri);
        else gone(el);
      }
    } })
    .on("style", { text(t) {
      styleText += t.text;
      if (t.lastInTextNode) { t.replace(freezeCss(styleText), { html: true }); styleText = ""; }
      else t.remove();
    } });
  for (const [tag, attrs] of ATTRS) {
    rewriter.on(tag, { element(el) {
      if (el.removed) return;
      for (const name of attrs) {
        const url = link(el, name);
        if (url === null) continue;
        const uri = inlined(url);
        if (uri) el.setAttribute(name, uri);
        else if (uri === "") {
          el.removeAttribute(name);
          if (tag === "img") el.replace(`<span class="gone">[image left out: ${esc(lastPart(url))}]</span>`, { html: true });
        }
      }
      const set = attr(el, "srcset");
      if (set !== null) el.setAttribute("srcset", srcset(set));
    } });
  }
    return rewriter;
  };
  return {
    reference,
    titled: () => titled,
    viewport: () => viewport,
    // A script or stylesheet the page names that is not in the file, and the file would not work as it does here.
    missingCode: () => codeLeft || notFetched.size > 0,
    html: (text: string) => withoutHeldData(build(text).transform(text), () => leave("a picture written in the page", "secret")),
    scanned: () => carriedText.join("\n"),
    notes(): Note[] {
      return [
        ...(carried.size ? [{ text: `Inside the file, from this machine: ${list(carried)}. Whoever gets the file gets these too.` }] : []),
        ...(fromWeb.size ? [{ text: `Inside the file, fetched from the web so it works offline: ${list(fromWeb)}.` }] : []),
        ...[...left].flatMap(([why, names]) => {
          // A picture's own link: whether it is inside, or why not, is already said.
          const shown = why === "link" ? [...names].filter((n) => !carried.has(n) && ![...left].some(([w, other]) => w !== "link" && other.has(n))) : [...names];
          return shown.length ? [{ text: `${WHY[why]}: ${list(shown)}.` }] : [];
        }),
        ...(refs.size ? [{ text: `Taken out, because the reader could not follow them and they name things inside HQ Office: ${list(refs)}. In a sentence they read "${NEUTRAL}".` }] : []),
        ...(unread.size ? [{ text: `What this script loads was not read: ${list(unread)}. It is too long to read or could not be parsed, so when the file is opened it may ask the web, and offline it may not work.`, only: "html" as const }] : []),
        ...(notFetched.size ? [{ text: `The HTML file could not bring these in, so offline they will not run or show: ${list([...notFetched].map(([name, why]) => `${name} (${why})`))}. Send the PDF to anyone who may be offline: it has them printed in.`, only: "html" as const }] : []),
        ...(online.size ? [{ text: `The HTML file needs the internet for what it shows from: ${list(online)}. The PDF does not.`, only: "html" as const }] : []),
      ];
    },
  };
}

// ---- a page's libraries on the web ----

const MAX_WEB_FILES = 24, WEB_MS = 30_000;
const isModule = (el: { getAttribute(name: string): string | null }) => /^\s*module\s*$/i.test(attr(el, "type") ?? "");
// The scripts and stylesheets a page names on the web, fetched before the page is frozen, since a rewriter's handlers
// cannot wait. A module is left: it imports more of itself from where it lives. One at a time, from one budget and one
// deadline, so what an export can hold and how long it can take are known.
function librariesNamed(src: Source) {
  const wanted = new Map<string, string | null>();
  if (src.markdown) return { wanted, mermaid: false };
  const html = asDocument(src.text);
  let ownMermaid = false;
  new HTMLRewriter()
    .on("script[src]", { element(el) {
      const url = link(el, "src") ?? "";
      if (/mermaid/i.test(url)) ownMermaid = true;
      if (!isModule(el)) wanted.set(url, attr(el, "integrity"));
    } })
    .on("link[href]", { element(el) { if (/stylesheet/i.test(attr(el, "rel") ?? "")) wanted.set(link(el, "href") ?? "", attr(el, "integrity")); } })
    .transform(html);
  return { wanted, mermaid: !ownMermaid && /class\s*=\s*["'][^"']*\bmermaid\b/i.test(html) };
}
async function webLibraries(wanted: Map<string, string | null>) {
  const allowed = guard(trustedHosts()), spend = { left: MAX_LIBRARY_BYTES }, deadline = AbortSignal.timeout(WEB_MS);
  const got = new Map<string, Fetched>();
  for (const [url, integrity] of [...wanted].filter(([u]) => isHttps(u))) {
    got.set(url, got.size < MAX_WEB_FILES ? await fetchLibrary(url, integrity, allowed, { spend, deadline }) : { why: "the page names too many" });
  }
  return got;
}

// ---- Mermaid: a page's diagrams are drawn by the runtime, so the file brings the library ----

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
const MERMAID_SHA256 = "a43bc1afd446f9c4cc66ac5dd45d02e8d65e26fc5344ec0ef787f88d6ddb6f9e";
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
async function mermaidLibrary() {
  const dir = join(DATA, "export-cache"), path = join(dir, "mermaid-11.4.1.min.js");
  try {
    const kept = textOf(path);
    if (sha256(kept) === MERMAID_SHA256) return kept;
  } catch {}
  try {
    const res = await fetch(MERMAID_URL, { signal: AbortSignal.timeout(20_000) });
    const text = res.ok ? await res.text() : "";
    if (sha256(text) !== MERMAID_SHA256) return null;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
    return text;
  } catch {
    return null;
  }
}

// ---- a source as one document ----

export const dateOf = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

function markdownDocument(src: Source, f: ReturnType<typeof freezer>) {
  const tokens = tokenBlocks();
  const body = md(src.text)
    .replaceAll(`<button class="copy" type="button">COPY</button>`, "")
    .replace(/<p class="hudref"><a href="#([^"]+)">[\s\S]*?<\/a><\/p>/g, (_all, ref) => { f.reference(ref); return ""; });
  const style = [nunito(), tokens.light, tokens.system, tokens.dark, css("core/markdown.css"), css("brief-export/saved.css")].join("\n");
  return `<!doctype html><html lang="en" class="saved"><head><title>${esc(src.title)}</title><style>${style}</style></head><body><article class="sdoc"><header><div class="when">${esc(dateOf(src.at))}</div><h1>${mdInline(src.title, { links: false })}</h1></header><div class="md">${body}</div></article></body></html>`;
}
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`;
// What the web gave for this file, fetched first: nothing here waits. To look at what would go in, without making a file,
// it stays empty: nothing is fetched, or looked up.
type Libraries = { web: Map<string, Fetched> | null; mermaid: string | null; noMermaid: boolean };
const LOOKING: Libraries = { web: null, mermaid: null, noMermaid: false };
// The source as one self-contained document, frozen and, for the printer, in a theme. A page's own tags go through the
// rewriter; what the export adds (the rules, the runtime, the library) goes on afterwards, and so is never rewritten.
function frozen(src: Source, { web, mermaid, noMermaid: noLibrary }: Libraries, theme?: "light") {
  const notes: Note[] = [];
  const f = freezer(src, src.markdown ? null : web);
  const doc = f.html(src.markdown ? markdownDocument(src, f) : asDocument(src.text));
  let more = VIEWPORT;
  if (!src.markdown) {
    if (noLibrary) notes.push({ text: "The HTML file's diagrams need the internet when opened: the drawing library could not be fetched just now. Send the PDF to anyone who may be offline: it has them printed in.", only: "html" });
    // The HUD's frame gives a page a phone's width whatever it says; a file opened on a phone needs the tag to get it.
    const runtime = textOf(join(import.meta.dir, "brief-export-assets", "saved-runtime.js")).replace(/^\s*\/\/.*\n/gm, "");
    more = `${f.titled() ? "" : `<title>${esc(src.title)}</title>`}${f.viewport() ? "" : VIEWPORT}${mermaid ? `<script>${inScript(mermaid)}</script>` : ""}<script>${inScript(runtime)}</script>`;
  }
  // What is scanned is what goes in the file, masked, not the source: what the export adds is its own.
  return { file: () => masked(first(theme ? themed(doc, theme) : doc, headTags(!src.markdown, more))), notes: [...secretNotes(`${src.title}\n${secrets.mask(doc)}\n${f.scanned()}`), ...f.notes(), ...notes], missing: f.missingCode() || noLibrary };
}
// Masking knows only the values held right now. What it cannot catch is said before there is a file.
function secretNotes(text: string): Note[] {
  const keys = looksLikeKeys(text), gone = noLongerHeld();
  return [
    ...(keys.length ? [{ text: `This looks like a key and would go out as written: ${list(keys)}. This check knows a few shapes and is no guarantee: read the file before you send it.` }] : []),
    ...(gone.length ? [{ text: `HQ Office no longer holds these secrets, so it cannot mask their values if they appear here: ${list(gone)}.` }] : []),
  ];
}

// ---- the files ----

// Held a little while so the browser can fetch them: the page asks, gets an address, and the download is a plain GET
// (a phone's browser saves those reliably, and shows what went wrong before it starts, not as a broken file).
// At most 8 files and 200 MB, oldest out first; one larger than that stays until the next. A file gone says so at its address.
const KEPT_MS = 10 * 60_000, KEPT_FILES = 8, KEPT_BYTES = 200 * 1024 * 1024;
type HeldFile = { name: string; type: string; bytes: Uint8Array; page: string; stamp: string };
const held = new Map<string, HeldFile>();
export const heldFile = (token: string) => held.get(token) ?? null;
function keep(token: string, file: HeldFile) {
  held.set(token, file);
  const total = () => [...held.values()].reduce((sum, f) => sum + f.bytes.length, 0);
  while (held.size > 1 && (held.size > KEPT_FILES || total() > KEPT_BYTES)) held.delete(held.keys().next().value!);
  setTimeout(() => held.delete(token), KEPT_MS).unref?.();
}

export function fileName(title: string, format: Format) {
  const words = title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${[...words].slice(0, 64).join("").replace(/-+$/, "") || "brief"}.${format}`;
}

type OnFloor = (floor: string, what: string) => void;
// Reading and freezing, one at a time per server, for checks and makes alike: a page can be 20 MB, and several at once hold
// several times that. Waiting on the web and on Chrome stays outside. Each turn starts on a new tick, so the HUD answers
// between them.
let turn: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => T): Promise<T> {
  const run = turn.then(async () => {
    await Bun.sleep(0);
    return work();
  });
  turn = run.catch(() => {});
  return run;
}

const pageName = ({ key, v }: { key: string; v: string | null }) => (v ? `${key}?v=${v}` : key);
// What a kept file was made from, to tell whether it still stands: the source, and which secrets were held. A change in what
// is held starts every kept file over, whatever it touched: that covers a stylesheet, a script and the text of a PDF alike.
const stampOf = (src: { title: string; text: string }) => sha256(`${src.title}\0${src.text}\0${secrets.list().map((s) => `${s.name}\0${s.setAt}\0${s.expiresAt}`).join("\0")}`);
// Who may ask, first, before any work and outside the turns: another floor must not cost a freeze, or learn a page's size
// from how long it took. What does not exist has no floor, and says so when it is read.
function askFloor({ key }: { key: string }, onFloor: OnFloor) {
  const brief = key.match(BRIEF_KEY), room = key.match(ROOM_BRIEF_KEY) ?? key.match(ROOM_FILE_KEY);
  const row = (brief ? db.query("SELECT floor FROM briefs WHERE id = ?").get(Number(brief[1])) : room ? db.query("SELECT floor FROM rooms WHERE slug = ?").get(room[1]) : null) as { floor: string } | null;
  if (row) onFloor(floorOr(row.floor), key);
}
function exported(parsed: ReturnType<typeof parseKey>) {
  const found = sourceOf(parsed.key, parsed.v);
  if (found.tooBig) throw new NoFile(`This page is too big to export: more than ${MAX_PAGE_BYTES / 1024 / 1024} MB. No file was made.`);
  const refs: string[] = [], title = masked(found.title), text = masked(found.text);
  return { ...found, page: pageName(parsed), stamp: stampOf(found), title: neutral(title, (ref) => refs.push(ref)), text, refs };
}
const said = (notes: Note[]) => notes.map((n) => secrets.mask(n.text));

// What the owner should read before any file is made, for either format. stop: no file can be made, and why.
export async function checkExport(page: unknown, onFloor: OnFloor) {
  const parsed = parseKey(page);
  askFloor(parsed, onFloor);
  return oneAtATime(() => {
    try {
      return { warnings: said(frozen(exported(parsed), LOOKING).notes) } as { warnings: string[]; stop?: string };
    } catch (e) {
      if (e instanceof NoFile) return { warnings: [], stop: e.message };
      throw e;
    }
  });
}

// Whether a kept file can still be handed over: it is held, and the page it was made from says what it said then.
export async function stillCurrent(token: string, page: unknown) {
  const file = held.get(token), parsed = parseKey(page);
  if (!file || file.page !== pageName(parsed)) return false;
  return oneAtATime(() => {
    try { return stampOf(sourceOf(parsed.key, parsed.v)) === file.stamp; } catch { return false; }
  });
}

export async function makeExport(page: unknown, format: unknown, onFloor: OnFloor) {
  if (format !== "html" && format !== "pdf") throw new Error("say which file: pdf or html");
  const parsed = parseKey(page);
  askFloor(parsed, onFloor);
  const { src, named } = await oneAtATime(() => {
    const src = exported(parsed);
    return { src, named: librariesNamed(src) };
  });
  const mermaid = named.mermaid ? await mermaidLibrary() : null;
  const libraries: Libraries = { web: src.markdown ? null : await webLibraries(named.wanted), mermaid, noMermaid: named.mermaid && !mermaid };
  const name = fileName(src.title, format);
  // hold: why the file is not handed over unasked for. A PDF needs no internet to be read, so what it could not bring in
  // does not hold it back, and what it held back for is the page not being done.
  const handOver = (bytes: Uint8Array, notes: Note[], hold: "missing" | "unfinished" | null) => {
    const token = crypto.randomUUID().replace(/-/g, "");
    keep(token, { name, type: format === "pdf" ? "application/pdf" : "text/html; charset=utf-8", bytes, page: src.page, stamp: src.stamp });
    return { url: `/exports/${token}/${encodeURIComponent(name)}`, name, bytes: bytes.length, warnings: said(notes), ...(hold ? { hold } : {}) };
  };
  if (format === "html") {
    return oneAtATime(() => {
      const { file, notes, missing } = frozen(src, libraries);
      return handOver(new TextEncoder().encode(file()), notes, missing ? "missing" : null);
    });
  }
  const { html, notes } = await oneAtATime(() => {
    const { file, notes } = frozen(src, libraries, "light");
    return { html: file(), notes };
  });
  const { pdf, warnings: printed, unfinished } = await printPdf({ html, title: src.title, date: dateOf(src.at), ink: tokenIn(tokenBlocks().light, "muted") });
  return handOver(pdf, [...notes.filter((n) => n.only !== "html"), ...printed.map((text) => ({ text }))], unfinished ? "unfinished" : null);
}
