// Routes for the ask ledger: edit an open question, comment on it (and the owner talks it through), and its checklist. See src/server/ledger.ts.
import { addItems, commentAsk, createAskWithItems, resendComment, talkAsk, tickItem, updateAsk } from "../ledger.ts";
import { refuseMissingPick, refuseMissingPickAfter } from "../asks.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/ledger/asks", handle: ({ body }) => {
    refuseMissingPick(body);
    return { id: createAskWithItems(body) };
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/update$/, handle: ({ body, m }) => {
    refuseMissingPickAfter(Number(m[1]), body);
    updateAsk(Number(m[1]), body);
  } },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/comment$/, handle: ({ body, m }) => commentAsk(Number(m[1]), body.text, body.as) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/talk$/, handle: ({ body, m }) => talkAsk(Number(m[1]), body) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/comments\/(\d+)\/resend$/, handle: ({ m }) => resendComment(Number(m[1]), Number(m[2])) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/items$/, handle: ({ body, m }) => ({ n: addItems(Number(m[1]), [body.text]) }) },
  { method: "POST", pattern: /^\/api\/asks\/(\d+)\/items\/(\d+)$/, handle: ({ body, m }) => {
    if (body.done !== true && body.done !== false) throw new Error("done must be true or false");
    tickItem(Number(m[1]), Number(m[2]), body.done);
  } },
];
export default routes;
