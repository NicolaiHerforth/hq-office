// Routes for BRIEF EXPORT (src/server/brief-export.ts): POST /api/exports/check { page } says what to read before there
// is a file; POST /api/exports { page, format } makes the file and says where to fetch it (a POST, so only the HUD's page
// or hud can start Chrome: a page elsewhere cannot send x-hud); GET
// /exports/TOKEN/NAME is that download; GET /exports/print/TOKEN is the document Chrome prints, served once.
// The export and its printer are loaded the first time one is asked for: with what they load (the transpiler, the
// scan, the web fetcher, the guards), they are about 5 MB of a server at rest, and a day may never export
// (docs/footprint.md). They hold nothing at the start that a request could miss: their files and print jobs begin empty.
import { agentOnFloor } from "../briefs.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const exporter = () => import("../brief-export.ts");
const printer = () => import("../brief-export-print.ts");
const SAFE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

const routes: Route[] = [
  { method: "POST", path: "/api/exports/kept", handle: async ({ body }) => ({ kept: await (await exporter()).stillCurrent(String(body.token ?? ""), body.page) }) },
  { method: "POST", path: "/api/exports/check", handle: async ({ body, req, caller }) => (await exporter()).checkExport(body.page, (floor, what) => agentOnFloor(req, caller, floor, what)) },
  { method: "POST", path: "/api/exports", handle: async ({ body, req, caller }) => (await exporter()).makeExport(body.page, body.format, (floor, what) => agentOnFloor(req, caller, floor, what)) },
  { method: "GET", pattern: /^\/exports\/print\/([0-9a-f]{64})$/, handle: async ({ m }) => {
    const html = (await printer()).takePrintJob(m[1]);
    return html === null ? json({ error: "not found" }, 404) : new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": (await exporter()).PRINT_CSP, ...SAFE } });
  } },
  { method: "GET", pattern: /^\/exports\/([0-9a-f]{32})\/[^/]+$/, handle: async ({ m }) => {
    const { heldFile, FILE_CSP } = await exporter();
    const f = heldFile(m[1]);
    if (!f) return json({ error: "this file is gone: export it again" }, 404);
    return new Response(f.bytes, { headers: { "content-type": f.type, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "content-security-policy": FILE_CSP, ...SAFE } });
  } },
];
export default routes;
