// Routes for COMMENTS (src/server/comments.ts): GET /api/comments?page=KEY (the thread), POST /api/comments/post
// { page, text, quote?, reply? } (the owner, from the page), POST /api/comments/reply { page, text, reply?, as? } (an
// author: hud brief reply, hud page reply), POST /api/comments/seen { page }, POST /api/comments/ID/retry.
import { json } from "../json.ts";
import { authorReply, ownerComment, retry, seen, thread } from "../comments.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/comments", handle: ({ url }) => {
    try { return json(thread(url.searchParams.get("page"))); } catch (e) { return json({ error: (e as Error).message }, 404); }
  } },
  { method: "POST", path: "/api/comments/post", handle: ({ body }) => ownerComment(body) },
  { method: "POST", path: "/api/comments/reply", handle: ({ body, caller }) => authorReply(body, caller().agent) },
  { method: "POST", path: "/api/comments/seen", handle: ({ body }) => seen(body.page) },
  { method: "POST", pattern: /^\/api\/comments\/(\d+)\/retry$/, handle: ({ m }) => retry(Number(m[1])) },
];
export default routes;
