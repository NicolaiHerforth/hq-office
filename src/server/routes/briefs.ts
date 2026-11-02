// Routes for BRIEFS (src/server/briefs.ts): POST /api/briefs { title, body } (hud brief, on the caller's floor),
// GET /api/briefs/ID (the whole brief; an agent, its own floor's only unless --all), POST /api/briefs/ID/read (the owner opened it).
import { json } from "../json.ts";
import { agentOnFloor, briefOf, briefPage, postBrief, readBrief } from "../briefs.ts";
import { servePage } from "../pages.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/briefs", handle: ({ body, caller }) => { const c = caller(); return postBrief(body, c.floor, c.agent); } },
  // A brief that is a whole HTML page, rendered sandboxed (pages.ts).
  { method: "GET", pattern: /^\/briefs\/(\d+)\.html$/, handle: ({ m, url }) => { const p = briefPage(Number(m[1])); return p ? servePage(p, `brief-${m[1]}.html`, url.searchParams.get("theme"), `briefs/${m[1]}`) : json({ error: `brief #${m[1]} is not a page` }, 404); } },
  { method: "GET", pattern: /^\/api\/briefs\/(\d+)$/, handle: ({ m, req, caller }) => {
    const b = briefOf(Number(m[1]));
    if (!b) return json({ error: `no brief #${m[1]}` }, 404);
    try { agentOnFloor(req, caller, b.floor, `brief #${b.id}`); } catch (e) { return json({ error: (e as Error).message }, 403); }
    return json(b);
  } },
  { method: "POST", pattern: /^\/api\/briefs\/(\d+)\/read$/, handle: ({ m }) => readBrief(Number(m[1])) },
];
export default routes;
