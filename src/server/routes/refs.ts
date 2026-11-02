// HQ things by reference (src/server/refs.ts): GET /api/refs?r=brief/12&r=room/ope-12 gives { cards: { REF: card |
// null } }. Read-only, behind the same origin rules as /api/state (http.ts).
import { json } from "../json.ts";
import { MAX_REFS, cards } from "../refs.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/refs", handle: ({ url }) => {
    const refs = url.searchParams.getAll("r");
    if (refs.length > MAX_REFS) return json({ error: `at most ${MAX_REFS} references at once` }, 400);
    return json({ cards: cards(refs) });
  } },
];
export default routes;
