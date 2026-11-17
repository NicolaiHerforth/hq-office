// Every request comes here. Routes live in routes/, one file per resource, each a default-exported list of
// { method, path | prefix | pattern, handle }; this file loads them all, so adding a route is adding to a file
// there, or adding a file. Routes must not overlap (the restructure checked the ones it moved).
//
// GET: the handler returns the Response. POST needs the x-hud header (a page on another origin cannot send it
// without a preflight, which this server never grants). A raw POST reads the body itself; any other POST gets the
// parsed JSON body, and its return value is the JSON reply ({ ok: true } when it returns nothing). Every write is
// followed by bump(), so open pages hear of it. A thrown error is a 400 with its message.
// caller() says who is calling and on which floor (floors.ts), worked out the first time a handler asks.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { json } from "./json.ts";
import { bump, touch } from "./push.ts";
import { dbStamp } from "./db-stamp.ts";
import { callerOf, type Caller } from "./floors.ts";

export type Ctx = { req: Request; url: URL; path: string; body: any; m: RegExpMatchArray; caller: () => Caller };
export type Route = {
  method: "GET" | "POST";
  path?: string;
  prefix?: string;
  pattern?: RegExp;
  raw?: boolean;
  handle: (ctx: Ctx) => unknown;
};

const dir = join(import.meta.dir, "routes");
const routes: Route[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
  routes.push(...((await import(join(dir, f))).default as Route[]));
}

function find(method: string, path: string, raw: boolean): { route: Route; m: RegExpMatchArray } | null {
  for (const route of routes) {
    if (route.method !== method || !!route.raw !== raw) continue;
    if (route.path !== undefined ? route.path === path : route.prefix !== undefined ? path.startsWith(route.prefix) : false) return { route, m: [] as unknown as RegExpMatchArray };
    const m = route.pattern ? path.match(route.pattern) : null;
    if (m) return { route, m };
  }
  return null;
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  let body: any;
  let who: Caller | undefined;
  const caller = () => (who ??= callerOf(req, body, url));
  try {
    if (req.method === "GET") {
      const hit = find("GET", path, false);
      return hit ? ((await hit.route.handle({ req, url, path, body: undefined, m: hit.m, caller })) as Response) : json({ error: "not found" }, 404);
    }
    if (req.method !== "POST" || req.headers.get("x-hud") !== "1") return json({ error: "forbidden" }, 403);
    const raw = find("POST", path, true);
    if (raw) return (await raw.route.handle({ req, url, path, body: undefined, m: raw.m, caller })) as Response;
    body = await req.json().catch(() => ({}));
    const hit = find("POST", path, false);
    if (!hit) return json({ error: "not found" }, 404);
    // A write is followed by bump(), so open pages hear of it and whoever waits on a write wakes. A POST that left
    // the database as it was (a hook that had nothing to say, a "seen" for what was seen) bumps nothing: pages are
    // only told to look, for what it may have changed in memory.
    const before = dbStamp();
    const result = await hit.route.handle({ req, url, path, body, m: hit.m, caller });
    const cause = `POST ${hit.route.path ?? hit.route.prefix ?? hit.route.pattern?.source ?? path}`;
    if (dbStamp() !== before) bump(cause);
    else touch(cause);
    return json(result === undefined ? { ok: true } : result);
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
}
