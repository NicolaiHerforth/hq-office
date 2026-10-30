// Routes for BRIEFS (src/server/briefs.ts): POST /api/briefs { title, body } (hud brief, on the caller's floor),
// GET /api/briefs/ID (the whole brief), POST /api/briefs/ID/read (the owner opened it).
import { json } from "../json.ts";
import { briefOf, postBrief, readBrief } from "../briefs.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/briefs", handle: ({ body, caller }) => { const c = caller(); return postBrief(body, c.floor, c.agent); } },
  { method: "GET", pattern: /^\/api\/briefs\/(\d+)$/, handle: ({ m }) => { const b = briefOf(Number(m[1])); return b ? json(b) : json({ error: `no brief #${m[1]}` }, 404); } },
  { method: "POST", pattern: /^\/api\/briefs\/(\d+)\/read$/, handle: ({ m }) => readBrief(Number(m[1])) },
];
export default routes;
