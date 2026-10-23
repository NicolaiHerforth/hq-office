// Routes for lanes. The router loads every file in this folder; see src/server/router.ts.
import { db } from "../db.ts";
import { event } from "../events.ts";
import { laneStream, upsertLane } from "../lanes.ts";
import { json } from "../json.ts";
import { board } from "../work-board.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/lanes/stream", handle: ({ url }) => json({ lane: url.searchParams.get("lane") ?? "", items: laneStream(url.searchParams.get("lane") ?? "") }) },
  { method: "POST", path: "/api/lanes", handle: ({ body }) => {
    upsertLane(body);
    board.linkLane(body);
  } },
  { method: "POST", path: "/api/lanes/delete", handle: ({ body }) => {
    db.query("DELETE FROM lanes WHERE name = ?").run(body.name);
    db.query("DELETE FROM lane_meta WHERE lane = ?").run(body.name);
    event("hq", "removed from the board", body.name);
  } },
];
export default routes;
