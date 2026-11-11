// Routes for REQUESTS (src/server/requests.ts): what the owner asked for, tracked until delivered.
//   GET  /api/requests [?closed=1] [?format=text] [?ref=note:ID]   the caller's floor's requests (hud work list)
//   GET  /api/requests/ID [?format=text]    the request and its moves: { request, moves }
//   POST /api/requests { text, from? }      hud work add
//   POST /api/requests/import { text, dryRun? }
//   POST /api/requests/ID/assign { lane, issue?, pr? } | attach { other } | drop { why } | wait { ask } |
//        move { text } | deliver { link, text } | withdraw { why }      HQ's commands; each answers { line }
// The owner's, from the page only (an agent's hud call is refused):
//   POST /api/requests/seen { ids }   POST /api/requests/ID/close { why? }   POST /api/requests/ID/reopen { text }
import { json } from "../json.ts";
import { bump } from "../push.ts";
import { sortHint } from "../requests.ts";
import { reopenRequest, requests } from "../owner-requests.ts";
import type { Caller } from "../floors.ts";
import type { Ctx, Route } from "../router.ts";

const actor = (c: Caller) => ({ by: c.agent ?? "hq", floor: c.all ? null : c.floor });
const text = (body: string) => new Response(body + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
// hud always says where it runs (x-hud-cwd); the page sends neither header.
const fromAgent = (req: Request) => req.headers.has("x-hud-cwd") || req.headers.has("x-hud-pane");
// A request is read on its own floor by an agent; the page reads every floor.
const reader = ({ req, caller }: Ctx) => (fromAgent(req) ? actor(caller()) : { by: "owner", floor: null });
function ownerOnly(req: Request) {
  if (fromAgent(req)) throw new Error("only the owner does this, from the page: HQ delivers or withdraws a request, the owner closes or reopens it");
}
const at = (verb: string) => new RegExp(`^/api/requests/(\\d+)/${verb}$`);

const routes: Route[] = [
  { method: "GET", path: "/api/requests", handle: ({ url, caller }) => {
    const ref = url.searchParams.get("ref");
    if (ref) return json({ requests: requests.byRef(ref).map((r) => ({ ...r, hint: sortHint(r).trim() })) });
    const o = { floor: caller().all ? null : caller().floor, closed: url.searchParams.get("closed") === "1" };
    return url.searchParams.get("format") === "text" ? text(requests.listText(o)) : json({ requests: requests.list(o) });
  } },
  { method: "GET", pattern: /^\/api\/requests\/(\d+)$/, handle: (ctx) =>
    ctx.url.searchParams.get("format") === "text" ? text(requests.showText(ctx.m[1], reader(ctx))) : json(requests.show(ctx.m[1], reader(ctx))) },
  { method: "POST", path: "/api/requests", handle: ({ body, caller }) => requests.add({ floor: caller().floor, text: body.text, from: body.from }) },
  { method: "POST", path: "/api/requests/import", handle: ({ body, caller }) => {
    if (caller().all) throw new Error("an import goes to one floor: --floor F, or none for yours");
    return requests.importLedger(body.text, { floor: caller().floor, dryRun: body.dryRun === true, by: caller().agent ?? "hq" });
  } },
  { method: "POST", pattern: at("assign"), handle: ({ body, m, caller }) => requests.assign(m[1], body, actor(caller())) },
  { method: "POST", pattern: at("attach"), handle: ({ body, m, caller }) => requests.attach(m[1], body.other, actor(caller())) },
  { method: "POST", pattern: at("drop"), handle: ({ body, m, caller }) => requests.drop(m[1], body.why, actor(caller())) },
  { method: "POST", pattern: at("wait"), handle: ({ body, m, caller }) => requests.wait(m[1], body.ask, actor(caller())) },
  { method: "POST", pattern: at("move"), handle: ({ body, m, caller }) => requests.move(m[1], body.text, actor(caller())) },
  { method: "POST", pattern: at("deliver"), handle: ({ body, m, caller }) => requests.deliver(m[1], body.link, body.text, actor(caller())) },
  { method: "POST", pattern: at("withdraw"), handle: ({ body, m, caller }) => requests.withdraw(m[1], body.why, actor(caller())) },
  // Raw, so a page that reports the same rows again changes nothing and wakes no page: it bumps only when a
  // request was seen for the first time.
  { method: "POST", path: "/api/requests/seen", raw: true, handle: async ({ req }) => {
    ownerOnly(req);
    const seen = requests.seen((await req.json().catch(() => ({})))?.ids);
    if (seen) bump();
    return json({ ok: true, seen });
  } },
  { method: "POST", pattern: at("close"), handle: ({ req, body, m }) => {
    ownerOnly(req);
    return { ok: true, request: requests.close(m[1], body.why) };
  } },
  { method: "POST", pattern: at("reopen"), handle: ({ req, body, m }) => {
    ownerOnly(req);
    return { ok: true, request: reopenRequest(m[1], body.text) };
  } },
];
export default routes;
