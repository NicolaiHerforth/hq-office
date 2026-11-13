// Routes for permits (src/server/lane-permits.ts) and the lane settings file (src/server/lane-settings.ts):
//   POST /api/permits/hook    { event, tool, input, mode, cwd, reason, message, type }  the lane hook (bin/lane-hook.ts)
//                             asks; { decision: "allow" }, { decision: "deny", message }, { retry: true } (a classifier
//                             block of a request the owner has allowed: the lane may try again), or {}
//   GET  /api/permits         the caller's floor's recent requests (every floor's with --all); ?format=text for hud
//   GET  /api/permits/ID      one request; ?format=text for hud
//   POST /api/permits/ID/ask  { why }  HQ raises the question for it: { ask, permit, lane }
//   GET  /api/lane-settings   { path }: the lane settings file, written first if it or the hook's copy is missing or stale
import { json } from "../json.ts";
import { bump } from "../push.ts";
import { ensureLaneSettings, fromHook, permitFor, permitLines, permitList, permitText, raise } from "../lane-permits.ts";
import type { Route } from "../router.ts";

const text = (s: string) => new Response(s.endsWith("\n") ? s : `${s}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });

const routes: Route[] = [
  // Raw: PreToolUse asks on every tool call of every lane while an allow waits, and a look that finds nothing must not
  // make every open page refetch. Only an answer that changed something bumps.
  { method: "POST", path: "/api/permits/hook", raw: true, handle: async ({ req, caller }) => {
    const { quiet, ...answer } = fromHook(await req.json().catch(() => ({})) ?? {}, caller());
    if (!quiet) bump();
    return json(answer);
  } },
  { method: "GET", path: "/api/permits", handle: ({ caller, url }) => {
    const c = caller(), floor = c.all ? null : c.floor;
    if (url.searchParams.get("format") !== "text") return json({ permits: permitList(floor) });
    const lines = permitLines(floor);
    return text(lines.length ? lines.join("\n") : "no lane has been refused anything yet");
  } },
  { method: "GET", pattern: /^\/api\/permits\/(\d+)$/, handle: ({ m, caller, url }) => {
    const p = permitFor(Number(m[1]), caller());
    return url.searchParams.get("format") === "text" ? text(permitText(p)) : json({ permit: p });
  } },
  { method: "POST", pattern: /^\/api\/permits\/(\d+)\/ask$/, handle: ({ body, m, caller }) => raise(Number(m[1]), body.why, caller()) },
  { method: "GET", path: "/api/lane-settings", handle: () => json({ path: ensureLaneSettings() }) },
];
export default routes;
