// Routes for DONE MEANS: a room's Linear project and its acceptance criteria (src/server/acceptance.ts).
import { OWNER } from "../config.ts";
import { json } from "../json.ts";
import { acceptance } from "../room-acceptance.ts";
import type { Route } from "../router.ts";

const at = (tail: string) => new RegExp(`^/api/rooms/([a-z0-9][a-z0-9-]{0,47})${tail}$`);

const routes: Route[] = [
  // { ref } links the room (a project URL, slugId or exact name), { clear: true } unlinks it; by: "owner" from the page.
  { method: "POST", pattern: at("/project"), handle: ({ body, m, caller }) => acceptance.link(m[1], body, body?.by === "owner" ? OWNER : caller().agent ?? "hq") },
  // ?refresh=1 fetches first when the cache is older than a minute. null: the room has no project.
  { method: "GET", pattern: at("/acceptance"), handle: async ({ m, url }) => {
    if (url.searchParams.get("refresh")) await acceptance.refreshRoom(m[1]);
    return json(acceptance.view(m[1]));
  } },
];
export default routes;
