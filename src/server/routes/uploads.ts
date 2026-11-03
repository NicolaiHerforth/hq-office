// Routes for uploads: what the owner attaches to a message outside a room (images and files, see attachments.ts).
// The router loads every file in this folder; see src/server/router.ts.
import { IMAGE_EXT, UPLOADS } from "../config.ts";
import { IMAGE_EXTS, extOf, fileResponse, namedFile, notFound, refusal, safeName, writeFree } from "../attachments.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", prefix: "/uploads/", handle: ({ path }) => {
    const f = namedFile(UPLOADS, path.slice("/uploads/".length));
    return f ? fileResponse(f.path, f.name) : notFound();
  } },
  // Bytes travel raw, so this route reads the body itself. An image (by its content type, re-encoded by the page)
  // keeps its name with the extension of its type; any other file, of any type, keeps its own name.
  { method: "POST", path: "/api/uploads", raw: true, handle: async ({ req, url }) => {
    const given = safeName(url.searchParams.get("name") ?? "file");
    const imageExt = IMAGE_EXT[req.headers.get("content-type") ?? ""];
    const name = imageExt ? `${given.replace(/\.[^.]*$/, "") || "image"}.${imageExt}` : given;
    const early = refusal(name, Number(req.headers.get("content-length") ?? 0));
    // Refused by its declared size: the body is read and dropped as it streams (never held), so the
    // connection stays clean for the next request.
    if (early) {
      for await (const _ of req.body ?? []) {}
      return json({ error: early }, 413);
    }
    const bytes = await req.arrayBuffer();
    if (!bytes.byteLength) return json({ error: "the file is empty" }, 400);
    const why = refusal(name, bytes.byteLength);
    if (why) return json({ error: why }, 413);
    const saved = writeFree(UPLOADS, name, bytes);
    return json({ path: `${UPLOADS}/${saved}`, url: `/uploads/${encodeURIComponent(saved)}`, name: saved, kind: IMAGE_EXTS.has(extOf(saved)) ? "image" : "file" });
  } },
];
export default routes;
