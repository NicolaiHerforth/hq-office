// What a card of an HQ thing says, from the thing's row: the page builds it from S (embeds/index.js), the server from
// its tables (src/server/refs.ts, for what S does not hold and for hud ref). Pure: no DOM, so both import it.
//
// A card: { ref, kind, word, title, chips: [{ t, c, status? }], preview, floor, href, tab, thumb }. word is the kind
// as the card says it, c a chip's look (new, hot, ok, muted, lane, st for a lane's status), preview one line of
// markdown, floor the floor it is on, href where a click goes (tab: in a new tab), thumb a picture's address.
import { headingOf } from "../core/heading.js";

const KIND_WORD = { decision: "QUESTION", action: "TO DO", info: "FYI" };
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
const PAGE = /\.html?$/i;

// The first line of a body worth reading: its first line of text, past headings, with no quote or list marks (a
// heading when there is nothing else).
export function firstLine(text) {
  let heading = "";
  for (const l of String(text ?? "").split("\n")) {
    const h = headingOf(l);
    if (h) { heading ||= h.text; continue; }
    const t = l.replace(/^\s*(?:>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/, "").trim();
    if (t && !/^(?:`{3,}|~{3,}|\|?\s*:?-{2,})/.test(t)) return clip(t);
  }
  return clip(heading);
}
const clip = (t) => (t.length > 160 ? `${t.slice(0, 159)}…` : t);
const fileUrl = (slug, name) => `/rooms/${slug}/files/${encodeURIComponent(name)}`;
const chip = (t, c) => ({ t, c });

// The card for a parsed reference (core/refs.js parseRef), with find answering each kind's row: the row, null when
// it is gone, undefined when this side does not know (the page then asks the server). Returns the card, null or
// undefined the same way.
export function cardOf(p, find) {
  const card = (row, c) => (row === undefined ? undefined : row === null ? null : { ref: p.ref, kind: p.kind, chips: [], preview: "", floor: null, tab: false, thumb: null, ...c(row) });
  if (p.kind === "brief") return card(find.brief(p.id), (b) => ({
    word: "BRIEF",
    title: b.title,
    chips: [!b.read && chip("NEW", "new"), find.replies(`briefs/${b.id}`) > 0 && chip("REPLY", "new"), b.html && chip("PAGE", "muted")].filter(Boolean),
    preview: firstLine(b.lead) || `by ${b.by}`,
    floor: b.floor,
    href: b.html && p.page ? `#page/briefs/${b.id}` : `#brief/${b.id}`,
  }));
  if (p.kind === "room") return card(find.room(p.slug), (r) => ({
    word: "ROOM",
    title: r.title,
    chips: [r.unread > 0 && chip(`${r.unread} NEW`, "new"), r.owner && chip(r.owner, "lane"), r.archivedAt && chip("ARCHIVED", "muted")].filter(Boolean),
    preview: r.last ? `${r.last.who === "owner" ? "You" : r.last.who}: ${r.last.text}` : "No messages yet",
    floor: r.floor,
    href: `#room/${r.slug}`,
  }));
  if (p.kind === "lane") return card(find.lane(p.name), (l) => ({
    word: "LANE",
    title: l.name,
    chips: [{ t: l.status, c: "st", status: l.status, boss: l.parent ?? null }, l.level && chip(String(l.level).toUpperCase(), "muted")].filter(Boolean),
    preview: l.title || "",
    floor: l.floor,
    href: `#lane/${l.name}`,
  }));
  if (p.kind === "ask") return card(find.ask(p.id), (a) => ({
    word: KIND_WORD[a.kind] ?? "QUESTION",
    title: a.title,
    chips: [a.status === "open" ? chip("OPEN", "hot") : a.status === "withdrawn" ? chip("WITHDRAWN", "muted") : chip("ANSWERED", "ok"), a.lane && chip(a.lane, "lane")].filter(Boolean),
    preview: a.status === "open" ? firstLine(a.body) : a.answer ? `You: ${firstLine(a.answer)}` : "",
    floor: a.floor,
    href: `#ask/${a.id}`,
  }));
  if (p.kind === "floor") return card(find.floor(p.id), (f) => {
    const c = f.counts ?? {}, waits = c.blocking ?? c.needsYou ?? 0, working = c.working ?? 0, active = Math.max(c.active ?? 0, working);
    return {
      word: "FLOOR",
      title: f.name,
      chips: [waits > 0 && chip(`${waits} WAIT ON YOU`, "hot"), chip(`${working} OF ${active} WORKING`, working ? "ok" : "muted")].filter(Boolean),
      preview: `HQ: ${f.hq}`,
      floor: f.id,
      href: `#floor/${f.id}`,
    };
  });
  const room = find.room(p.slug);
  if (room === null) return null;
  if (p.kind === "roombrief") return card(room === undefined ? undefined : find.roombrief(p.slug), (b) => ({
    word: "ROOM BRIEF",
    title: room.title,
    chips: [b.html && chip("PAGE", "muted"), b.versions > 0 && chip(`V${b.versions + 1}`, "muted")].filter(Boolean),
    preview: firstLine(b.lead),
    floor: room.floor,
    href: b.html ? `#page/rooms/${p.slug}/brief` : `#room/${p.slug}`,
  }));
  if (p.kind === "file") return card(room === undefined ? undefined : find.file(p.slug, p.name), (f) => {
    const page = PAGE.test(p.name), image = IMAGE.test(p.name);
    return {
      word: page ? "PAGE" : image ? "IMAGE" : "FILE",
      title: f.title || p.name,
      chips: f.versions > 0 ? [chip(`V${f.versions + 1}`, "muted")] : [],
      preview: `On the shelf of ${room.title}`,
      floor: room.floor,
      href: page ? `#page${fileUrl(p.slug, p.name)}` : fileUrl(p.slug, p.name),
      tab: !page,
      thumb: image ? fileUrl(p.slug, p.name) : null,
    };
  });
  return null;
}
