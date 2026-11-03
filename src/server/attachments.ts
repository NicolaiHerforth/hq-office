// What the owner may attach to a message (an image or a file of any type), how its name is kept, and how a stored
// file is served.
// Used by /api/uploads (routes/uploads.ts) and by a room's send box (rooms.ts, ?attach=1). Files stay on this machine.
import { closeSync, lstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export const MAX_IMAGE = 10 * 1024 * 1024;
export const MAX_FILE = 25 * 1024 * 1024;
// Raster images the browser has already re-encoded; they show inline. Any other file is taken too: what keeps it from
// running is how it is served (fileResponse), never its type.
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif"]);
const VIDEO_TYPE: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const IMAGE_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
const TEXT = /\.(txt|md|markdown|log|csv|tsv|json|jsonl|ya?ml|toml|ini|env\.example|diff|patch|sql|sh|ts|tsx|js|jsx|mjs|py|rb|go|rs|java|kt|swift|c|h|cpp|css)$/i;

export const extOf = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();

// Why NAME (BYTES long) may not be attached, or "" when it may: only its size.
export function refusal(name: string, bytes: number) {
  if (IMAGE_EXTS.has(extOf(name))) return bytes > MAX_IMAGE ? "the image is over 10 MB" : "";
  return bytes > MAX_FILE ? "the file is over 25 MB" : "";
}

// A file name as given, made safe: no folders, no control characters or brackets (a token ends at "]"), no leading
// dot, at most 120 characters.
export function safeName(raw: string) {
  let name = String(raw ?? "").split(/[/\\]/).pop()!.replace(/[\u0000-\u001f\u007f[\]]/g, "-").replace(/^[\s.]+/, "").trim();
  if (name.length > 120) {
    const ext = name.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? "";
    name = name.slice(0, 120 - ext.length).trim() + ext;
  }
  return name || "file";
}

// Writes BYTES into DIR under NAME, or name-2.ext, name-3.ext... when it is taken. The name is claimed with an
// exclusive create, so two uploads of the same name at once never share a file.
export function writeFree(dir: string, name: string, bytes: ArrayBuffer) {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${stem}-${i}${ext}`;
    let fd: number;
    try { fd = openSync(join(dir, n), "wx"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try { writeSync(fd, new Uint8Array(bytes)); } finally { closeSync(fd); }
    return n;
  }
}

// The file in DIR that a request names, or null: one plain file straight inside DIR, not a link.
export function namedFile(dir: string, rawName: string) {
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { return null; }
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0") || name.startsWith(".")) return null;
  const path = join(dir, name);
  try { return lstatSync(path).isFile() ? { path, name } : null; } catch { return null; }
}

// A stored file is shown, never run. Every answer is sandboxed and never sniffed; a raster image and a video show
// inline, text shows as plain text where TEXTINLINE says so, and anything else is a download.
export const SAFE = { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'", "x-content-type-options": "nosniff" };
export function fileResponse(path: string, name: string, o: { textInline?: boolean } = {}) {
  const ext = extOf(name);
  const quoted = encodeURIComponent(name);
  const headers: Record<string, string> = { ...SAFE };
  const inline = (type: string) => Object.assign(headers, { "content-type": type, "content-disposition": `inline; filename*=UTF-8''${quoted}` });
  if (IMAGE_TYPE[ext]) inline(IMAGE_TYPE[ext]);
  else if (VIDEO_TYPE[ext]) inline(VIDEO_TYPE[ext]);
  else if (o.textInline && TEXT.test(name)) inline("text/plain; charset=utf-8");
  else Object.assign(headers, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename*=UTF-8''${quoted}` });
  return new Response(Bun.file(path), { headers });
}
export const notFound = () => new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json", ...SAFE } });
