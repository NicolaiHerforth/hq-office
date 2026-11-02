// Routes for SUBS: each subscription's 5-hour and weekly room, as the page has it (S.subs). See src/server/sub-usage.ts.
import { startSubs, subsView } from "../sub-usage.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

startSubs();

const routes: Route[] = [{ method: "GET", path: "/api/subs", handle: () => json(subsView()) }];
export default routes;
