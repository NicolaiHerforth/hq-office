// Routes for asks. The router loads every file in this folder; see src/server/router.ts.
import { db } from "../db.ts";
import { event } from "../events.ts";
import { answerAsk, createAsk, deferAsk, notYet, ownerAsk, refuseMissingPick } from "../asks.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/asks", handle: ({ body }) => {
    refuseMissingPick(body);
    return { id: createAsk(body) };
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/answer$/, handle: ({ body, m }) => {
    answerAsk(Number(m[1]), String(body.answer ?? "").trim() || "done");
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/defer$/, handle: ({ body, m }) => {
    deferAsk(Number(m[1]), body.until);
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/notyet$/, handle: ({ body, m }) => notYet(Number(m[1]), body.note) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/withdraw$/, handle: ({ body, m }) => {
    ownerAsk(Number(m[1]));
    db.query("UPDATE asks SET status = 'withdrawn', answer = ?, answered_at = ?, acked_at = ? WHERE id = ? AND status = 'open'").run(
      body.reason ?? "withdrawn by HQ",
      Date.now(),
      Date.now(),
      Number(m[1]),
    );
    event("hq", `withdrew ask #${m[1]}${body.reason ? `: ${body.reason}` : ""}`);
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/ack$/, handle: ({ m }) => {
    ownerAsk(Number(m[1]));
    db.query("UPDATE asks SET acked_at = ? WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
