// Routes for asks. The router loads every file in this folder; see src/server/router.ts.
import { db } from "../db.ts";
import { event } from "../events.ts";
import { answerAsk, checkScope, createAsk, laneCaller, notYet } from "../asks.ts";
import type { Route } from "../router.ts";
import { json } from "../json.ts";
import { askPageKey, hasAskPage, serveAskPage } from "../ask-pages.ts";
import { requests } from "../owner-requests.ts";

// The new ask's id, and its page's key when it has one (hud ask prints where to read what the owner does in it).
export const withPage = (id: number) => (hasAskPage(id) ? { id, page: askPageKey(id) } : { id });

const routes: Route[] = [
  // An ask's HTML page, served sandboxed like every page (ask-pages.ts), whatever the ask's status.
  { method: "GET", pattern: /^\/asks\/(\d+)\.html$/, handle: ({ m, url }) => serveAskPage(Number(m[1]), url.searchParams.get("theme")) ?? json({ error: `ask #${m[1]} has no page` }, 404) },
  { method: "POST", path: "/api/asks", handle: ({ body, caller }) => withPage(createAsk(body, caller().floor, caller().agent)) },
  // Who sent it goes along: a question that allows a lane's request takes only the owner's answer on the page.
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/answer$/, handle: ({ body, m, req }) => {
    answerAsk(Number(m[1]), String(body.answer ?? "").trim() || "done", { pane: req.headers.get("x-hud-pane"), page: req.headers.has("origin") });
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/notyet$/, handle: ({ body, m }) => notYet(Number(m[1]), body.note) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/withdraw$/, handle: ({ body, m, caller }) => {
    const by = laneCaller(caller().agent);
    db.query("UPDATE asks SET status = 'withdrawn', answer = ?, answered_at = ?, acked_at = ? WHERE id = ? AND status = 'open'").run(
      body.reason ?? `withdrawn by ${by ?? "HQ"}`,
      Date.now(),
      Date.now(),
      Number(m[1]),
    );
    // A request that waited on this ask goes back to its lane (requests.ts).
    requests.askSettled(Number(m[1]));
    const ask = db.query("SELECT lane, floor FROM asks WHERE id = ?").get(Number(m[1])) as { lane: string | null; floor: string | null } | null;
    event(by ?? "hq", `withdrew ask #${m[1]}${body.reason ? `: ${body.reason}` : ""}`, ask?.lane, ask?.floor);
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/ack$/, handle: ({ m, caller }) => {
    checkScope("ask", Number(m[1]), caller());
    db.query("UPDATE asks SET acked_at = ? WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
