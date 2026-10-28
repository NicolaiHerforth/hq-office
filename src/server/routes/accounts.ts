// Routes for accounts. The router loads every file in this folder; see src/server/router.ts.
import { accountsView, sampleAccounts } from "../accounts.ts";
import { makeHome } from "../claude-home.ts";
import { moveLane } from "../claude-accounts.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/accounts", handle: () => json(accountsView()) },
  // Move one Claude lane to another account, and carry on in the same conversation.
  { method: "POST", path: "/api/accounts/move", handle: async ({ body }) => ({ ok: true, said: await moveLane(String(body.lane ?? ""), String(body.account ?? "")) }) },
  // Make a Claude home with no login in it. The owner logs in to it once.
  { method: "POST", path: "/api/accounts/home", handle: async ({ body }) => {
    const name = String(body.name ?? "");
    const { mcpNeedsSecret } = makeHome(name);
    await sampleAccounts();
    const mcp = mcpNeedsSecret.length ? ` ${mcpNeedsSecret.length} MCP server${mcpNeedsSecret.length > 1 ? "s need" : " needs"} their secret set in this home (it is never copied).` : "";
    return { ok: true, said: `Made the ${name} home. Log in once: CLAUDE_CONFIG_DIR=~/.claude-${name} claude auth login.${mcp}` };
  } },
];
export default routes;
