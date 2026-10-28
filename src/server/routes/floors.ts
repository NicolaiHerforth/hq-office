// Routes for a floor's copy of the room: /floor/<id>/src/client/<path> serves exactly the file /src/client/<path> would.
// The browser keeps one instance of a module per URL, so a floor loaded from its own prefix gets its own canvas,
// workers and frame loop from unchanged code (src/client/room/here.js reads the floor from the URL).
import { json } from "../json.ts";
import { clientFile } from "../page.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", pattern: /^\/floor\/[^/]+(\/src\/client\/.*)$/, handle: async ({ req, m }) => (await clientFile(m[1], req)) ?? json({ error: "not found" }, 404) },
];
export default routes;
