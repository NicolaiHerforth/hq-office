// Routes for THE PAGE RUNTIME (src/server/page-runtime.ts). The HUD's bridge (src/client/page-runtime/index.js) calls
// the POST routes for a page it found in one of its sandboxed frames; a page never calls them itself (it has an opaque
// origin and no x-hud header). They are raw: a read must not bump the state, and a db write bumps it itself.
//   POST /api/page-runtime/storage { page, set: { key: value | null }, clear? }
//   POST /api/page-runtime/db      { page, op: get|query|set|update|delete|acquire, path, data?, query?, holder?, ttlMs? }
//   GET  /api/page-runtime/data?page=PAGE&path=PATH   hud page data: a document, a collection, or all a page keeps;
//                                                     without page, every page that keeps anything. An agent
//                                                     reads its own floor's briefs only, unless --all (briefs.ts).
import { json } from "../json.ts";
import { checkPage, dbCall, LIMITS, PageError, pageData, pagesWithData, writeStorage } from "../page-runtime.ts";
import type { Ctx, Route } from "../router.ts";
import { agentOnFloor, briefOf } from "../briefs.ts";

// The body is read even when it is too large: a reply that leaves it unread leaves the client's connection stuck.
async function bodyOf(req: Request) {
  const text = await req.text();
  if (text.length > LIMITS.body) throw new PageError("invalid_argument", "request too large");
  try { return JSON.parse(text); } catch { throw new PageError("invalid_argument", "not JSON"); }
}
// Errors carry the artifact db's code (invalid_argument, quota_exceeded, ...), so the page can branch on it.
const raw = (fn: (b: any) => unknown) => async ({ req }: { req: Request }) => {
  try {
    const b = await bodyOf(req);
    return json(fn(b) ?? { ok: true });
  } catch (e) {
    return json({ error: (e as Error).message, code: (e as PageError).code ?? "invalid_argument" }, 400);
  }
};

// A brief's data stays on the brief's floor: an agent on another floor is refused (it throws) unless --all.
function onFloor(key: string, req: Request, caller: Ctx["caller"]) {
  const m = /^briefs\/(\d+)$/.exec(key), b = m && briefOf(Number(m[1]));
  if (b) agentOnFloor(req, caller, b.floor, `brief #${b.id}`);
}
const mayRead = (key: string, req: Request, caller: Ctx["caller"]) => { try { onFloor(key, req, caller); return true; } catch { return false; } };

const routes: Route[] = [
  { method: "POST", raw: true, path: "/api/page-runtime/storage", handle: raw((b) => writeStorage(checkPage(b.page), b.set, b.clear === true)) },
  { method: "POST", raw: true, path: "/api/page-runtime/db", handle: raw((b) => dbCall(checkPage(b.page), b)) },
  { method: "GET", path: "/api/page-runtime/data", handle: ({ url, req, caller }) => {
    const page = url.searchParams.get("page");
    if (!page) return json({ pages: pagesWithData().filter((p) => mayRead(p.page, req, caller)) });
    const key = checkPage(page);
    try { onFloor(key, req, caller); } catch (e) { return json({ error: (e as Error).message }, 403); }
    return json(pageData(key, url.searchParams.get("path") || undefined));
  } },
];
export default routes;
