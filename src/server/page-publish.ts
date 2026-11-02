// THE PAGE RUNTIME's artifact.publish: a page that is its own record (a poll, a checklist, a sign-up sheet) saves a new
// version of itself, a whole HTML document, the way a Claude artifact republishes itself. The page sends back the
// version it was served (page-runtime-tag.ts sourceVersion); if the page changed since, the publish is a conflict and
// the view reloads to the newer one. The new version goes where the page lives, and the one it replaces is kept:
//   rooms/SLUG/files/NAME  the room's file, replaced as a lane's upload replaces it (versions/files/NAME/)
//   rooms/SLUG/brief       the room's brief (versions/brief/)
//   briefs/ID              the brief's body; the earlier one in page_versions (newest MAX_VERSIONS)
// Secret values are masked before it is written. S.pagePublished carries each published page's new version, so every
// open view of it reloads (src/client/page-runtime/index.js).
import { readFileSync } from "node:fs";
import { db } from "./db.ts";
import { bump, secrets } from "./push.ts";
import { addStatePart } from "./state.ts";
import { HTML_EXT, isPage } from "./pages.ts";
import { briefPage } from "./briefs.ts";
import { roomView, setBrief } from "./rooms.ts";
import { MAX_VERSIONS, saveFile, servedFile } from "./room-folder.ts";
import { setVersionSource, sourceVersion } from "./page-runtime-tag.ts";
import { PageError } from "./page-runtime.ts";

export const MAX_PAGE = 5_000_000;
const EVERY_MS = 2000; // one publish per page per this long

const SLUG = "([a-z0-9][a-z0-9-]{0,47})";
const BRIEF = /^briefs\/(\d{1,9})$/, ROOM_BRIEF = new RegExp(`^rooms/${SLUG}/brief$`), ROOM_FILE = new RegExp(`^rooms/${SLUG}/files/(.+)$`);

// What the page is now: its HTML, or null when the key names nothing that is a page.
export function sourceOf(page: string): string | null {
  let m = page.match(BRIEF);
  if (m) return briefPage(Number(m[1]));
  if ((m = page.match(ROOM_BRIEF))) {
    try { const b = roomView(m[1]).brief; return isPage(b) ? b : null; } catch { return null; }
  }
  if ((m = page.match(ROOM_FILE))) {
    const f = servedFile(m[1], encodeURIComponent(m[2]));
    return f && HTML_EXT.test(f.name) ? readFileSync(f.path, "utf8") : null;
  }
  return null;
}

setVersionSource((page) => { const src = sourceOf(page); return src === null ? "" : sourceVersion(src); });

const published = new Map<string, string>();
const lastAt = new Map<string, number>();
addStatePart("pagePublished", () => Object.fromEntries(published));

export async function publish(page: string, html: unknown, base: unknown) {
  if (typeof html !== "string" || !isPage(html)) throw new PageError("invalid_content", "publish takes an HTML page: a whole document (<!doctype html> first), or a fragment as the Artifact tool takes one");
  if (html.length > MAX_PAGE) throw new PageError("too_large", "a page is at most 5 MB");
  const current = sourceOf(page);
  if (current === null) throw new PageError("not_writer", "this page cannot publish itself");
  const live = sourceVersion(current);
  if (base !== live) throw Object.assign(new PageError("conflict", "a newer version of this page was published first"), { live });
  const now = Date.now();
  if (now - (lastAt.get(page) ?? 0) < EVERY_MS) throw new PageError("rate_limited", "one publish every 2 seconds");
  lastAt.set(page, now);
  const text = secrets.mask(html);
  let m = page.match(BRIEF);
  if (m) {
    db.transaction(() => {
      db.query("INSERT INTO page_versions (page, at, by, html) VALUES (?, ?, ?, ?)").run(page, now, "owner", current);
      db.query("DELETE FROM page_versions WHERE page = ? AND id NOT IN (SELECT id FROM page_versions WHERE page = ? ORDER BY at DESC, id DESC LIMIT ?)").run(page, page, MAX_VERSIONS);
      db.query("UPDATE briefs SET body = ? WHERE id = ?").run(text, Number(m![1]));
    })();
  } else if ((m = page.match(ROOM_BRIEF))) {
    setBrief(m[1], { body: text, as: "owner" });
  } else if ((m = page.match(ROOM_FILE))) {
    await saveFile(m[1], m[2], new TextEncoder().encode(text).buffer as ArrayBuffer, { by: "owner", replace: true });
  }
  const version = sourceVersion(text);
  published.set(page, version);
  bump();
  return { version };
}

