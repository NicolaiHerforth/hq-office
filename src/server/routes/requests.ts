// Routes for the queue: what a lane sends HQ, as requests over asks (see src/server/queue.ts), and the urgent report.
// The router loads every file in this folder; see src/server/router.ts.
import { json } from "../json.ts";
import { allRequests, answerRequest, closeRequest, fileRequest, nextRequest, openRequests } from "../queue.ts";
import { pushUrgent, sinceMs, urgentReport } from "../urgent.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/requests", handle: ({ url }) => json(url.searchParams.get("all") ? allRequests(url.searchParams.get("lead") || undefined) : openRequests(url.searchParams.get("lead") || undefined)) },
  { method: "GET", path: "/api/requests/next", handle: ({ url }) => json(nextRequest(url.searchParams.get("lead") || undefined)) },
  { method: "POST", path: "/api/requests", handle: ({ body }) => fileRequest(body) },
  { method: "POST", pattern: /^\/api\/requests\/(\d+)\/answer$/, handle: ({ body, m }) => answerRequest(Number(m[1]), String(body.text ?? "")) },
  { method: "POST", pattern: /^\/api\/requests\/(\d+)\/close$/, handle: ({ body, m }) => closeRequest(Number(m[1]), String(body.reason ?? "")) },
  { method: "GET", path: "/api/urgent", handle: ({ url }) => json(urgentReport(sinceMs(url.searchParams.get("since") || "7d"))) },
  // Push an open item, on the desk or in a queue, to the top of its list.
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/urgent$/, handle: ({ body, m }) => pushUrgent(Number(m[1]), String(body.by || "hq")) },
];
export default routes;
