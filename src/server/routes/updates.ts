// Routes for updates. The router loads every file in this folder; see src/server/router.ts.
import { db } from "../db.ts";
import { addStatePart } from "../state.ts";
import { markRead, postUpdate, unreadByLane } from "../updates.ts";
import type { Route } from "../router.ts";

addStatePart("updatesUnreadByLane", unreadByLane);

const routes: Route[] = [
  { method: "POST", path: "/api/updates", handle: ({ body }) => ({ id: postUpdate(body) }) },
  { method: "POST", path: "/api/updates/read-all", handle: ({ body }) => {
    markRead({ floor: typeof body?.floor === "string" ? body.floor : undefined, lane: typeof body?.lane === "string" ? body.lane : undefined });
  } },
  { method: "POST", pattern: /^\/api\/updates\/(\d+)\/read$/, handle: ({ m }) => {
    db.query("UPDATE updates SET read_at = COALESCE(read_at, ?) WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
