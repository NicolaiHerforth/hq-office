// Routes for asks. The router loads every file in this folder; see src/server/router.ts.
import { db } from "../db.ts";
import { event } from "../events.ts";
import { answerAsk, checkScope, createAsk, notYet } from "../asks.ts";
import type { Route } from "../router.ts";
import { json } from "../json.ts";
import { askPageKey, hasAskPage, serveAskPage } from "../ask-pages.ts";

// The new ask's id, and its page's key when it has one (hud ask prints where to read what the owner does in it).
export const withPage = (id: number) => (hasAskPage(id) ? { id, page: askPageKey(id) } : { id });

const routes: Route[] = [
  // An ask's HTML page, served sandboxed like every page (ask-pages.ts), whatever the ask's status.
  { method: "GET", pattern: /^\/asks\/(\d+)\.html$/, handle: ({ m, url }) => serveAskPage(Number(m[1]), url.searchParams.get("theme")) ?? json({ error: `ask #${m[1]} has no page` }, 404) },
  { method: "POST", path: "/api/asks", handle: ({ body, caller }) => withPage(createAsk(body, caller().floor)) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/answer$/, handle: ({ body, m }) => {
    answerAsk(Number(m[1]), String(body.answer ?? "").trim() || "done");
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/notyet$/, handle: ({ body, m }) => notYet(Number(m[1]), body.note) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/withdraw$/, handle: ({ body, m }) => {
    db.query("UPDATE asks SET status = 'withdrawn', answer = ?, answered_at = ?, acked_at = ? WHERE id = ? AND status = 'open'").run(
      body.reason ?? "withdrawn by HQ",
      Date.now(),
      Date.now(),
      Number(m[1]),
    );
    const ask = db.query("SELECT lane, floor FROM asks WHERE id = ?").get(Number(m[1])) as { lane: string | null; floor: string | null } | null;
    event("hq", `withdrew ask #${m[1]}${body.reason ? `: ${body.reason}` : ""}`, ask?.lane, ask?.floor);
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/ack$/, handle: ({ m, caller }) => {
    checkScope("ask", Number(m[1]), caller());
    db.query("UPDATE asks SET acked_at = ? WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
