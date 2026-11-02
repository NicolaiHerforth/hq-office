// Routes for the ask ledger: edit an open question, comment on it, and its checklist. See src/server/ledger.ts.
import { addItems, commentAsk, createAskWithItems, tickItem, updateAsk } from "../ledger.ts";
import type { Route } from "../router.ts";
import { withPage } from "./asks.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/ledger/asks", handle: ({ body, caller }) => withPage(createAskWithItems(body, caller().floor, caller().agent)) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/update$/, handle: ({ body, m }) => updateAsk(Number(m[1]), body) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/comment$/, handle: ({ body, m }) => commentAsk(Number(m[1]), body.text) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/items$/, handle: ({ body, m }) => ({ n: addItems(Number(m[1]), [body.text]) }) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/items\/(\d+)$/, handle: ({ body, m }) => {
    if (body.done !== true && body.done !== false) throw new Error("done must be true or false");
    tickItem(Number(m[1]), Number(m[2]), body.done);
  } },
];
export default routes;
