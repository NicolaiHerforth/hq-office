// Routes for THE PAGE RUNTIME (src/server/page-runtime.ts). The HUD's bridge (src/client/page-runtime/index.js) calls
// the POST routes for a page it found in one of its sandboxed frames; a page never calls them itself (it has an opaque
// origin and no x-hud header). They are raw: a read must not bump the state, and a db write bumps it itself.
//   POST /api/page-runtime/storage { page, set: { key: value | null }, clear? }
//   POST /api/page-runtime/db      { page, op: get|query|set|update|delete|acquire, path, data?, query?, holder?, ttlMs? }
//   POST /api/page-runtime/publish { page, html, base }   artifact.publish (page-publish.ts)
//   GET  /api/page-runtime/room/events?tab=ID        one HUD tab's stream for every room its pages are in (page-room.ts)
//   POST /api/page-runtime/room    { tab, op: join|leave|presence|emit, page, room, peer, patch?, topic?, data? }
//   GET  /api/page-runtime/room/peers?page=&room=   POST /api/page-runtime/room/say { page, room, topic, data }
//   GET  /api/page-runtime/room/listen?page=&room=   an agent in the room while it listens (hud page room)
//   POST /api/page-runtime/sample  { page, input, tier }   a model's answer, streamed (page-sample.ts; off by default)
//   GET  /api/page-runtime/data?page=PAGE&path=PATH   hud page data: a document, a collection, or all a page keeps;
//                                                     without page, every page that keeps anything. An agent
//                                                     reads its own floor's briefs and asks only, unless --all.
import { json } from "../json.ts";
import { checkPage, dbCall, LIMITS, PageError, pageData, pagesWithData, writeStorage } from "../page-runtime.ts";
import { MAX_PAGE, publish } from "../page-publish.ts";
import { sample } from "../page-sample.ts";
import { closeTab, emit, isTabId, join, leave, openTab, peersOf, presence } from "../page-room.ts";
import type { Ctx, Route } from "../router.ts";
import { agentOnFloor, briefOf } from "../briefs.ts";
import { askFloor } from "../ask-pages.ts";

// The body is read even when it is too large: a reply that leaves it unread leaves the client's connection stuck.
async function bodyOf(req: Request, max = LIMITS.body) {
  const text = await req.text();
  if (text.length > max) throw new PageError("invalid_argument", "request too large");
  try { return JSON.parse(text); } catch { throw new PageError("invalid_argument", "not JSON"); }
}
// Errors carry the artifact db's code (invalid_argument, quota_exceeded, ...), so the page can branch on it.
const raw = (fn: (b: any, ctx: Ctx) => unknown, max?: number) => async (ctx: Ctx) => {
  try {
    const b = await bodyOf(ctx.req, max);
    return json((await fn(b, ctx)) ?? { ok: true });
  } catch (e) {
    const err = e as PageError & { live?: string };
    return json({ error: err.message, code: err.code ?? "invalid_argument", ...(err.live ? { live: err.live } : {}) }, 400);
  }
};

// An event stream that lasts as long as the client holds it: open() starts it, close() runs when it ends.
function events(open: (send: (event: object) => void) => void, close: () => void) {
  let done = false, ping: ReturnType<typeof setInterval>;
  const end = () => { if (done) return; done = true; clearInterval(ping); close(); };
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (text: string) => { try { controller.enqueue(enc.encode(text)); } catch { end(); } };
      open((event) => write(`data: ${JSON.stringify(event)}\n\n`));
      write(`: open\n\n`);
      ping = setInterval(() => write(`: ping\n\n`), 25_000);
    },
    cancel: end,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
const agentOf = (ctx: Ctx, as?: string | null) => {
  const name = String(ctx.caller().agent || as || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48);
  if (!name) throw new PageError("not_permitted", "only an agent (a lane or HQ, with its herdr pane) speaks in a page's room");
  return name;
};
// A brief's data stays on the brief's floor, an ask's on the ask's: an agent on another floor is refused (it throws)
// unless --all.
function onFloor(key: string, req: Request, caller: Ctx["caller"]) {
  const m = /^briefs\/(\d+)$/.exec(key), b = m && briefOf(Number(m[1]));
  if (b) agentOnFloor(req, caller, b.floor, `brief #${b.id}`);
  const a = /^asks\/(\d+)$/.exec(key), floor = a && askFloor(Number(a[1]));
  if (floor) agentOnFloor(req, caller, floor, `ask #${a[1]}`);
}
const mayRead = (key: string, req: Request, caller: Ctx["caller"]) => { try { onFloor(key, req, caller); return true; } catch { return false; } };

const routes: Route[] = [
  { method: "POST", raw: true, path: "/api/page-runtime/storage", handle: raw((b) => writeStorage(checkPage(b.page), b.set, b.clear === true)) },
  { method: "POST", raw: true, path: "/api/page-runtime/db", handle: raw((b) => dbCall(checkPage(b.page), b)) },
  { method: "POST", raw: true, path: "/api/page-runtime/publish", handle: raw((b) => publish(checkPage(b.page), b.html, b.base), MAX_PAGE + 100_000) },
  { method: "GET", path: "/api/page-runtime/room/events", handle: ({ url }) => {
    const id = url.searchParams.get("tab") ?? "";
    if (!isTabId(id)) return json({ error: "bad tab id" }, 400);
    let tab: ReturnType<typeof openTab>;
    return events((send) => { tab = openTab(id, send); }, () => closeTab(id, tab));
  } },
  { method: "POST", raw: true, path: "/api/page-runtime/room", handle: raw((b) => {
    const page = checkPage(b.page), tab = String(b.tab ?? "");
    switch (b.op) {
      case "join": return join(page, b.room, b.peer, tab, { kind: "viewer", by: "owner" });
      case "leave": return leave(page, b.room, b.peer);
      case "presence": return presence(page, b.room, b.peer, tab, b.patch);
      case "emit": return emit(page, b.room, { peer: b.peer, tab }, b.topic, b.data);
    }
    throw new PageError("invalid_argument", `unknown room call ${b.op}`);
  }) },
  // An agent reaches a brief's room on the brief's floor only, as its data (onFloor); the HUD's own page is not an agent.
  { method: "GET", path: "/api/page-runtime/room/peers", handle: ({ url, req, caller }) => {
    const page = checkPage(url.searchParams.get("page"));
    try { onFloor(page, req, caller); } catch (e) { return json({ error: (e as Error).message }, 403); }
    return json({ peers: peersOf(page, url.searchParams.get("room") ?? "") });
  } },
  { method: "POST", raw: true, path: "/api/page-runtime/room/say", handle: raw((b, ctx) => {
    const page = checkPage(b.page);
    try { onFloor(page, ctx.req, ctx.caller); } catch (e) { throw new PageError("not_permitted", (e as Error).message); }
    return emit(page, b.room, { agent: agentOf(ctx, b.as) }, b.topic, b.data);
  }) },
  { method: "GET", path: "/api/page-runtime/room/listen", handle: (ctx) => {
    const page = checkPage(ctx.url.searchParams.get("page")), room = ctx.url.searchParams.get("room") ?? "";
    try { onFloor(page, ctx.req, ctx.caller); } catch (e) { return json({ error: (e as Error).message }, 403); }
    const agent = agentOf(ctx, ctx.url.searchParams.get("as"));
    const tab = `agent-${crypto.randomUUID().slice(0, 8)}`;
    let open: ReturnType<typeof openTab>;
    return events((send) => {
      open = openTab(tab, (e: any) => send(e.t === "msg" ? e.msg : { peers: e.peers.map(({ peer, by, kind, presence }: any) => ({ peer, by, kind, presence })) }));
      join(page, room, `agent:${agent}:${tab.slice(6)}`, tab, { kind: "agent", by: agent });
    }, () => closeTab(tab, open));
  } },
  { method: "POST", raw: true, path: "/api/page-runtime/sample", handle: async ({ req }) => {
    try {
      const b = await bodyOf(req, 300_000);
      return sample(checkPage(b.page), b, req.signal);
    } catch (e) {
      return json({ error: (e as Error).message, code: (e as PageError).code ?? "invalid_request" }, 400);
    }
  } },
  { method: "GET", path: "/api/page-runtime/data", handle: ({ url, req, caller }) => {
    const page = url.searchParams.get("page");
    if (!page) return json({ pages: pagesWithData().filter((p) => mayRead(p.page, req, caller)) });
    const key = checkPage(page);
    try { onFloor(key, req, caller); } catch (e) { return json({ error: (e as Error).message }, 403); }
    return json(pageData(key, url.searchParams.get("path") || undefined));
  } },
];
export default routes;
