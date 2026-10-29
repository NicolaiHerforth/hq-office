// The agent drawer's read of one lane: GET /api/lanes/NAME/live (see src/server/lane-live.ts). Read-only: nothing
// here types into a lane; talking to it goes through its room.
import { json } from "../json.ts";
import { laneLive } from "../lane-live.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", pattern: /^\/api\/lanes\/([A-Za-z0-9._-]{1,80})\/live$/, handle: async ({ m }) => json(await laneLive(m[1])) },
];
export default routes;
