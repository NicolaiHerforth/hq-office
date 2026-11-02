// HQ things by reference: the address each already has in the HUD, after the #. The one grammar: core/markdown.js
// links them (and marks a paragraph that is only one, which embeds/ draws as a card), src/server/refs.ts summarises
// them, and `hud ref` prints them. Pure: no DOM, so the server imports it too.
//
//   brief/ID                       a floor's brief           page/briefs/ID              the same brief, as a page
//   room/SLUG                      a conference room         page/rooms/SLUG/brief       a room's brief
//   lane/NAME                      a lane (its drawer)       page/rooms/SLUG/files/NAME  a file on a room's shelf
//   ask/ID                         a question or TO DO       floor/ID                    a floor
const SLUG = "[a-z0-9][a-z0-9-]{0,47}";
export const REF_SOURCE = `(?:brief\\/\\d{1,9}|room\\/${SLUG}|lane\\/[A-Za-z0-9][\\w.-]{0,63}|ask\\/\\d{1,9}|floor\\/[a-z0-9][a-z0-9-]{0,31}|page\\/(?:rooms\\/${SLUG}\\/(?:files\\/[^\\s/?#)]+|brief)|briefs\\/\\d{1,9}))`;
const WHOLE = new RegExp(`^#?(${REF_SOURCE})$`);

// What a reference names, or null: { ref, kind, ... }. kind is brief, room, lane, ask, floor, file or roombrief.
export function parseRef(text) {
  const m = String(text ?? "").trim().match(WHOLE);
  if (!m) return null;
  const ref = m[1], [k, a, b, c, d] = ref.split("/");
  if (k === "brief" || k === "ask") return { ref, kind: k, id: Number(a) };
  if (k === "room") return { ref, kind: "room", slug: a };
  if (k === "lane") return { ref, kind: "lane", name: a };
  if (k === "floor") return { ref, kind: "floor", id: a };
  if (a === "briefs") return { ref, kind: "brief", id: Number(b), page: true };
  if (c === "brief") return { ref, kind: "roombrief", slug: b };
  let name = d;
  try { name = decodeURIComponent(d); } catch {}
  if (!name || name.startsWith(".") || /[\\\u0000]/.test(name)) return null;
  return { ref, kind: "file", slug: b, name };
}

// The reference for a kind and an id, as `hud ref KIND ID` takes them (KIND: brief, room, lane, ask, floor, file
// with ID SLUG/NAME, roombrief with ID SLUG), or null when it is not one.
export function refFor(kind, id) {
  const s = String(id ?? "").trim();
  const ref = kind === "file" ? (() => { const i = s.indexOf("/"); return i > 0 ? `page/rooms/${s.slice(0, i)}/files/${encodeURIComponent(s.slice(i + 1)).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))}` : ""; })()
    : kind === "roombrief" ? `page/rooms/${s}/brief`
    : `${kind}/${s}`;
  return parseRef(ref) ? `#${ref}` : null;
}
