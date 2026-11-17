// Routes for sync. The router loads every file in this folder; see src/server/router.ts.
import { syncHerdr } from "../herdr.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/sync", handle: async () => {
    // Asked for by hand (hud sync): every pane that is read at all is read now.
    await syncHerdr({ readAll: true });
  } },
];
export default routes;
