// HQ things by reference (src/client/core/refs.js: #brief/12, #room/SLUG, #lane/NAME, ...): the card of each, built
// from the tables with the page's own model (src/client/embeds/model.js). The page draws a card from S and asks here
// only for what S does not hold (a shelf file, a room's brief, an old brief, question or room); hud ref asks here
// whether a thing exists. A summary only (a title, its status, one line), every string with secret values masked.
// Read-only.
import { db } from "./db.ts";
import { secrets } from "./push.ts";
import { floorCounts, floorOf } from "./floors.ts";
import { laneStatus, withTree } from "./lanes.ts";
import { isPage, pageText } from "./pages.ts";
import { roomsView } from "./rooms.ts";
import { briefVersionsDir, fileVersionsDir, servedFile, versions } from "./room-folder.ts";
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
