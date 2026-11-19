// Routes for SHIP (src/server/ship-server.ts, docs/ship.md): filing a PR (hud ship, HQ or a lane), a page opening
// SHIP, and the owner's MERGE, a held press and its UNDO, and SEND BACK, which only the HUD's page may send.
import type { Route } from "../router.ts";
import { fileShip, holdPress, look, mergeItems, ownerOnly, sendBack, undoPress } from "../ship-server.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/ship", handle: ({ body, caller }) => fileShip({ url: body.url, lane: body.lane, note: body.note, urgent: body.urgent }, caller()) },
  { method: "POST", path: "/api/ship/look", handle: () => look() },
  { method: "POST", path: "/api/ship/merge", handle: ({ body, req }) => {
    ownerOnly(req, "merges");
    return mergeItems(body.items, body.kind);
  } },
  { method: "POST", pattern: /^\/api\/ship\/(\d+)\/hold$/, handle: ({ body, m, req }) => {
    ownerOnly(req, body?.verb === "back" ? "sends a PR back" : "merges");
    return holdPress(m[1], body);
  } },
  { method: "POST", pattern: /^\/api\/ship\/(\d+)\/undo$/, handle: ({ m, req }) => {
    ownerOnly(req, "takes a press back");
    return undoPress(m[1]);
  } },
  { method: "POST", pattern: /^\/api\/ship\/(\d+)\/back$/, handle: ({ body, m, req }) => {
    ownerOnly(req, "sends a PR back");
    sendBack(m[1], body.note);
  } },
];
export default routes;
