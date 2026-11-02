// Routes for conference rooms (see src/server/rooms.ts), and the files in their folders (src/server/room-folder.ts).
import { bump } from "../push.ts";
import { json } from "../json.ts";
import { addFile, addLink, archive, createRoom, ownerPost, readOwner, removeArtifact, retry, roomVersions, roomView, roomsView, say, seen, setBrief } from "../rooms.ts";
import { briefVersionsDir, fileVersionsDir, LEGACY_FILES, movedTo, servedFile, version } from "../room-folder.ts";
import { SAFE, fileResponse as serve, notFound } from "../attachments.ts";
import type { Route } from "../router.ts";
import { HTML_EXT, isHtmlDoc, pageResponse } from "../pages.ts";
import { readFileSync } from "node:fs";

const S = "([a-z0-9][a-z0-9-]{0,47})";
const at = (tail: string) => new RegExp(`^/api/rooms/${S}${tail}$`);

// A file from a room's folder is shown, never run (attachments.ts); text shows as plain text there.
const fileResponse = (path: string, name: string) => serve(path, name, { textInline: true });

const routes: Route[] = [
  // ?all=1 adds the archived rooms; the caller's floor's only, unless x-hud-floor: all.
  { method: "GET", path: "/api/rooms", handle: ({ url, caller }) => json(roomsView(!!url.searchParams.get("all"), caller().all ? null : caller().floor)) },
  { method: "GET", pattern: at(""), handle: ({ m }) => json(roomView(m[1])) },
  // hud room read: the owner's messages after ?since=ID; with ?wait=S it waits up to S seconds (at most 240) for one.
  { method: "GET", pattern: at("/read"), handle: async ({ m, url }) => json(await readOwner(m[1], url.searchParams.get("since"), Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, 240) * 1000)) },
  // A file's or the brief's versions: ?file=NAME or ?brief=1 (&v=V: a markdown brief's text).
  { method: "GET", pattern: at("/versions"), handle: ({ m, url }) => json(roomVersions(m[1], { file: url.searchParams.get("file"), brief: !!url.searchParams.get("brief"), v: url.searchParams.get("v") })) },
  { method: "POST", path: "/api/rooms", handle: ({ body, caller }) => createRoom(body, caller().floor) },
  { method: "POST", pattern: at("/brief"), handle: ({ body, m }) => setBrief(m[1], body) },
  { method: "POST", pattern: at("/artifacts"), handle: ({ body, m }) => addLink(m[1], body) },
  // The owner takes an item off the shelf (an image removed from the send box): a file in the folder goes too.
  { method: "POST", pattern: at("/artifacts/(\\d+)/remove"), handle: ({ m }) => removeArtifact(m[1], Number(m[2])) },
  // A file travels as raw bytes, so this route reads the body itself; ?name= ?title= ?kind= ?as= describe it.
  { method: "POST", pattern: at("/files"), raw: true, handle: async ({ req, url, m }) => {
    try {
      const out = await addFile(m[1], req, url);
      bump();
      return json(out);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  } },
  { method: "POST", pattern: at("/say"), handle: ({ body, m }) => say(m[1], body) },
  { method: "POST", pattern: at("/post"), handle: ({ body, m }) => ownerPost(m[1], body) },
  { method: "POST", pattern: at("/messages/(\\d+)/retry"), handle: ({ m }) => retry(m[1], Number(m[2])) },
  { method: "POST", pattern: at("/seen"), handle: ({ m }) => seen(m[1]) },
  { method: "POST", pattern: at("/archive"), handle: ({ body, m }) => archive(m[1], body.by) },
  // A file in a room's folder: /rooms/SLUG/files/NAME. ?v=V is an earlier version of it, at the same address so that
  // a page's relative links still find the room's files.
  { method: "GET", prefix: "/rooms/", handle: ({ path, url }) => {
    const v = url.searchParams.get("v");
    if (v != null && !/^\d{1,15}$/.test(v)) return notFound();
    // A room's brief that is a whole HTML page, rendered sandboxed (pages.ts).
    const b = path.match(/^\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/brief\.html$/);
    if (b) {
      if (v) {
        let old = null;
        try { old = version(briefVersionsDir(b[1]), v); } catch {}
        return old?.path.endsWith(".html") ? pageResponse(readFileSync(old.path, "utf8"), "brief.html") : notFound();
      }
      let brief: string | null = null;
      try { brief = roomView(b[1]).brief; } catch {}
      return isHtmlDoc(brief) ? pageResponse(brief!, "brief.html") : notFound();
    }
    const m = path.match(/^\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/files\/([^/]+)$/);
    if (m && v) {
      let name = "";
      try { name = decodeURIComponent(m[2]); } catch { return notFound(); }
      if (!name || /[/\\\0]/.test(name) || name.startsWith(".")) return notFound();
      let old = null;
      try { old = version(fileVersionsDir(m[1], name), v); } catch {}
      if (!old) return notFound();
      return HTML_EXT.test(name) ? pageResponse(readFileSync(old.path, "utf8"), name) : fileResponse(old.path, name);
    }
    const f = m && servedFile(m[1], m[2]);
    if (f && HTML_EXT.test(f.name)) return pageResponse(readFileSync(f.path, "utf8"), f.name);
    return f ? fileResponse(f.path, f.name) : notFound();
  } },
  // A link from before rooms had folders: to where its file moved, or the file itself if it never moved.
  { method: "GET", prefix: "/room-files/", handle: async ({ path }) => {
    let name = "";
    try { name = decodeURIComponent(path.slice("/room-files/".length)); } catch {}
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) return notFound();
    const to = movedTo(name);
    if (to) return new Response(null, { status: 301, headers: { location: to, ...SAFE } });
    const file = Bun.file(`${LEGACY_FILES}/${name}`);
    return (await file.exists()) ? fileResponse(`${LEGACY_FILES}/${name}`, name) : notFound();
  } },
];
export default routes;
