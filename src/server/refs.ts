// HQ things by reference (src/client/core/refs.js: #brief/12, #room/SLUG, #lane/NAME, ...): the card of each, built
// from the tables with the page's own model (src/client/embeds/model.js). The page draws a card from S and asks here
// only for what S does not hold (a shelf file, a room's brief, an old brief, question or room); hud ref asks here
// whether a thing exists. A summary only (a title, its status, one line), every string with secret values masked.
// Read-only.
//
// An HTML page shows cards with <hud-card ref="brief/12">, and resolves only the references its author wrote into
// it: the ones in its stored source that are also in the newest version a lane or HQ wrote. A page can publish a new
// version of itself (page-publish.ts), so its current source alone would let it name, and so enumerate, anything.
import { readFileSync } from "node:fs";
import { db } from "./db.ts";
import { secrets } from "./push.ts";
import { floorCounts, floorOf } from "./floors.ts";
import { laneStatus, withTree } from "./lanes.ts";
import { isPage, pageText } from "./pages.ts";
import { roomsView } from "./rooms.ts";
import { MAX_VERSIONS, briefVersionsDir, fileVersionsDir, servedFile, versions } from "./room-folder.ts";
import { sourceOf } from "./page-publish.ts";
import type { Ask, Lane } from "./types.ts";
import { parseRef } from "../client/core/refs.js";
import { cardOf } from "../client/embeds/model.js";

export const MAX_REFS = 50;

function finder() {
  let rooms: ReturnType<typeof roomsView> | null = null;
  let lanes: Lane[] | null = null;
  return {
    brief(id: number) {
      const b = db.query("SELECT id, floor, at, by, title, read_at, substr(body, 1, 4000) AS head FROM briefs WHERE id = ?").get(id) as any;
      if (!b) return null;
      const html = isPage(b.head);
      return { id: b.id, floor: b.floor, at: b.at, by: b.by, title: b.title, read: !!b.read_at, html, lead: html ? pageText(b.head).slice(0, 240) : b.head.slice(0, 240) };
    },
    replies: (key: string) => (db.query("SELECT COUNT(*) AS n FROM page_comments WHERE page = ? AND author IS NOT NULL AND read_at IS NULL").get(key) as { n: number }).n,
    room: (slug: string) => (rooms ??= roomsView(true)).find((r) => r.slug === slug) ?? null,
    lane(name: string) {
      if (!lanes) {
        const open = db.query("SELECT lane FROM asks WHERE status = 'open' AND lane IS NOT NULL").all() as { lane: string }[];
        const byLane = new Map<string, number>();
        for (const a of open) byLane.set(a.lane, (byLane.get(a.lane) ?? 0) + 1);
        const now = Date.now();
        lanes = withTree(db.query("SELECT * FROM lanes ORDER BY name").all() as Lane[]).map((l) => ({ ...l, status: laneStatus(l, byLane, now) }));
      }
      return lanes.find((l) => l.name === name) ?? null;
    },
    ask: (id: number) => (db.query("SELECT id, kind, title, body, status, answer, lane, floor FROM asks WHERE id = ?").get(id) as Ask | null) ?? null,
    floor(id: string) {
      const f = floorOf(id);
      return f ? { id: f.id, name: f.name, color: f.color, hq: f.hq, counts: floorCounts(f.id) } : null;
    },
    file(slug: string, name: string) {
      const f = servedFile(slug, encodeURIComponent(name));
      if (!f) return null;
      const row = db.query("SELECT title FROM room_artifacts WHERE slug = ? AND path = ? ORDER BY id DESC LIMIT 1").get(slug, f.path) as { title: string } | null;
      return { title: row?.title ?? name, versions: versions(fileVersionsDir(slug, name)).length };
    },
    roombrief(slug: string) {
      const r = db.query("SELECT brief FROM rooms WHERE slug = ?").get(slug) as { brief: string | null } | null;
      if (!r?.brief) return null;
      const html = isPage(r.brief);
      return { html, lead: html ? pageText(r.brief).slice(0, 240) : r.brief.slice(0, 240), versions: versions(briefVersionsDir(slug)).length };
    },
  };
}

const mask = (v: unknown): unknown =>
  typeof v === "string" ? secrets.mask(v) : Array.isArray(v) ? v.map(mask) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)])) : v;

// The card of each reference (with or without its #), or null for one that is not a reference or names nothing.
export function cards(refs: string[]) {
  const find = finder();
  const out: Record<string, unknown> = {};
  for (const raw of refs.slice(0, MAX_REFS)) {
    const p = parseRef(raw);
    out[raw] = p ? mask(cardOf(p, find) ?? null) : null;
  }
  return out;
}

// ---- references in an HTML page ----

// The references a page's HTML names in its <hud-card ref> elements: each card's first ref before its >. A walk, not one
// search per card: the next ref is kept from card to card, and a card with no ref before its > skips to that >, since
// any other card before it has none either.
export function refsIn(html: string | null | undefined) {
  const out = new Set<string>(), text = String(html ?? "");
  const card = /<hud-card\b/gi, ref = /\sref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null = null;
  while (card.exec(text)) {
    if (!m || m.index < card.lastIndex) {
      ref.lastIndex = card.lastIndex;
      m = ref.exec(text);
    }
    if (!m) break;
    const gt = text.slice(card.lastIndex, m.index).indexOf(">");
    if (gt >= 0) { card.lastIndex += gt; continue; }
    const p = parseRef((m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, "&"));
    if (p) out.add(p.ref);
    card.lastIndex = m.index + m[0].length;
  }
  return out;
}
// A page's own publish is written as the owner: any other author is a lane or HQ.
const byAuthor = (by: string | null | undefined) => !!by && by !== "owner";
const SLUG = "([a-z0-9][a-z0-9-]{0,47})";
// The newest version of a page its author wrote (not the page publishing itself), or null when none is kept.
function authorSource(page: string): string | null {
  let m = page.match(/^asks\/(\d{1,9})$/);
  if (m) return (db.query("SELECT html FROM ask_pages WHERE ask_id = ?").get(Number(m[1])) as { html: string } | null)?.html ?? null; // an ask's page cannot publish itself
  if ((m = page.match(/^briefs\/(\d{1,9})$/))) {
    // Only a publish changes a brief's body, and each keeps the body it replaced: the first kept is the author's,
    // unless as many publishes have pushed it out.
    const kept = db.query("SELECT html FROM page_versions WHERE page = ? ORDER BY at, id").all(page) as { html: string }[];
    return !kept.length ? sourceOf(page) : kept.length < MAX_VERSIONS ? kept[0].html : null;
  }
  const older = (dir: string) => { const v = versions(dir).find((x) => byAuthor(x.by)); return v ? readFileSync(v.path, "utf8") : null; };
  if ((m = page.match(new RegExp(`^rooms/${SLUG}/brief$`)))) {
    const r = db.query("SELECT brief_by FROM rooms WHERE slug = ?").get(m[1]) as { brief_by: string | null } | null;
    if (!r) return null;
    return byAuthor(r.brief_by) ? sourceOf(page) : older(briefVersionsDir(m[1]));
  }
  if ((m = page.match(new RegExp(`^rooms/${SLUG}/files/(.+)$`)))) {
    const f = servedFile(m[1], encodeURIComponent(m[2]));
    if (!f) return null;
    const row = db.query("SELECT by FROM room_artifacts WHERE slug = ? AND path = ? ORDER BY id DESC LIMIT 1").get(m[1], f.path) as { by: string } | null;
    return !row || byAuthor(row.by) ? sourceOf(page) : older(fileVersionsDir(m[1], m[2]));
  }
  return null;
}
// What PAGE may resolve: the references in its stored source that its author wrote.
export function pageRefs(page: string) {
  const now = refsIn(page.startsWith("asks/") ? authorSource(page) : sourceOf(page)), author = refsIn(authorSource(page));
  return new Set([...now].filter((r) => author.has(r)));
}
// The cards PAGE asks for: each reference it may resolve gets its card (null when gone); any other gets null too, so
// a page cannot tell a reference it may not resolve from one that names nothing.
export function cardsForPage(page: string, refs: string[]) {
  const allowed = pageRefs(page);
  const mine = refs.slice(0, MAX_REFS).filter((r) => allowed.has(parseRef(r)?.ref ?? ""));
  return { ...Object.fromEntries(refs.slice(0, MAX_REFS).map((r) => [r, null])), ...cards(mine) };
}
