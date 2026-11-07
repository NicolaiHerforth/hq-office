// Routes for BRIEF EXPORT (src/server/brief-export.ts): POST /api/exports/check { page } says what to read before there
// is a file; POST /api/exports { page, format } makes the file and says where to fetch it (a POST, so only the HUD's page
// or hud can start Chrome: a page elsewhere cannot send x-hud); GET
// /exports/TOKEN/NAME is that download; GET /exports/print/TOKEN is the document Chrome prints, served once.
import { FILE_CSP, PRINT_CSP, checkExport, heldFile, makeExport, stillCurrent } from "../brief-export.ts";
import { takePrintJob } from "../brief-export-print.ts";
import { agentOnFloor } from "../briefs.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const SAFE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const routes: Route[] = [
  { method: "POST", path: "/api/exports/kept", handle: async ({ body }) => ({ kept: await stillCurrent(String(body.token ?? ""), body.page) }) },
  { method: "POST", path: "/api/exports/check", handle: ({ body, req, caller }) => checkExport(body.page, (floor, what) => agentOnFloor(req, caller, floor, what)) },
  { method: "POST", path: "/api/exports", handle: ({ body, req, caller }) => makeExport(body.page, body.format, (floor, what) => agentOnFloor(req, caller, floor, what)) },
  { method: "GET", pattern: /^\/exports\/print\/([0-9a-f]{64})$/, handle: ({ m }) => {
    const html = takePrintJob(m[1]);
    return html === null ? json({ error: "not found" }, 404) : new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PRINT_CSP, ...SAFE } });
  } },
  { method: "GET", pattern: /^\/exports\/([0-9a-f]{32})\/[^/]+$/, handle: ({ m }) => {
    const f = heldFile(m[1]);
    if (!f) return json({ error: "this file is gone: export it again" }, 404);
    return new Response(f.bytes, { headers: { "content-type": f.type, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "content-security-policy": FILE_CSP, ...SAFE } });
  } },
];
export default routes;
