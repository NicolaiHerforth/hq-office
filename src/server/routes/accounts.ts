// Routes for accounts. The router loads every file in this folder; see src/server/router.ts.
import { accountsView, swapClaude } from "../accounts.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/accounts", handle: () => json(accountsView()) },
  { method: "POST", path: "/api/accounts/swap", handle: async ({ body }) => ({ ok: true, said: await swapClaude(String(body.machine ?? "")) }) },
];
export default routes;
