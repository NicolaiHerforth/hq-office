// Routes for the HQ QUEUE (src/server/hq-queue.ts):
//   POST /api/queue/hook   { event, session_id, prompt, stop_hook_active }  HQ's hook asks what to do; {} for anyone
//                          but a floor's HQ in its own session, or with the queue off
//   POST /api/queue        { text, urgent? }  hud request: the caller's message for its floor's HQ
//   GET  /api/queue        [?all=1]  the caller's floor's items (open ones, or all)
//   GET  /api/queue/line   the count line, or null
//   POST /api/queue/next   HQ reads the next item
//   POST /api/queue/ID/answer { text }   POST /api/queue/ID/close { why }
import { json } from "../json.ts";
import { answerItem, closeItem, fileItem, hookDecision, listItems, nextItem, queueLine, queueOn } from "../hq-queue.ts";
import { promptAgent } from "../herdr.ts";
import { hqOf } from "../floors.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/queue/hook", handle: ({ body }) => hookDecision(body ?? {}) },
  // A lane's message: queued while the queue is on; typed into HQ's pane while it is off (as a lane does today), and
  // always when urgent (then also kept, read, so it stays open until HQ answers).
  { method: "POST", path: "/api/queue", handle: async ({ body, caller }) => {
    const c = caller();
    const from = c.agent ?? "unknown";
    const text = String(body.text ?? "").trim();
    if (!text) throw new Error("say something: hud request TEXT");
    const urgent = body.urgent === true;
    if (queueOn() && !urgent) return { id: fileItem({ floor: c.floor, from, text, via: "hud" }), queued: true };
    const r = await promptAgent(hqOf(c.floor), `${urgent ? "URGENT from" : "From"} ${from}: ${text}`);
    if (!r.ok) throw new Error(`HQ did not take it (${r.error}); try again`);
    return { queued: false, id: queueOn() ? fileItem({ floor: c.floor, from, text, via: "hud", urgent, read: true }) : null };
  } },
  { method: "GET", path: "/api/queue", handle: ({ caller, url }) => { const c = caller(); return json({ on: queueOn(), items: listItems(c.all ? null : c.floor, url.searchParams.get("all") === "1") }); } },
  { method: "GET", path: "/api/queue/line", handle: ({ caller }) => json({ line: queueLine(caller().floor) }) },
  { method: "POST", path: "/api/queue/next", handle: ({ caller }) => ({ item: nextItem(caller().floor) }) },
  { method: "POST", pattern: /^\/api\/queue\/(\d+)\/answer$/, handle: ({ body, m, caller }) => answerItem(Number(m[1]), body.text, caller().all ? null : caller().floor) },
  { method: "POST", pattern: /^\/api\/queue\/(\d+)\/close$/, handle: ({ body, m, caller }) => closeItem(Number(m[1]), body.why, caller().all ? null : caller().floor) },
];
export default routes;
