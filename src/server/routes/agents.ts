// Route for agents (who is live, since when): the table the 20 s herdr sync keeps; see src/server/herdr.ts.
// The hourly sweep reads it, and so does the queue (src/server/queue.ts). The router loads every file in this folder.
import { db } from "../db.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/agents", handle: () => json(db.query("SELECT name, machine, pane, agent, status, since FROM agents ORDER BY machine, pane").all()) },
];
export default routes;
