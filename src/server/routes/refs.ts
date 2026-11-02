// HQ things by reference (src/server/refs.ts): GET /api/refs?r=brief/12&r=room/ope-12 gives { cards: { REF: card |
// null } }; with page=KEY (briefs/ID, asks/ID, rooms/SLUG/brief, rooms/SLUG/files/NAME), only the references that
// page's author wrote into it, for its <hud-card> elements. Read-only, behind the same origin rules as /api/state
// (http.ts).
import { json } from "../json.ts";
import { MAX_REFS, cards, cardsForPage } from "../refs.ts";
import { checkPage } from "../page-runtime.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "GET", path: "/api/refs", handle: ({ url }) => {
    const refs = url.searchParams.getAll("r");
    if (refs.length > MAX_REFS) return json({ error: `at most ${MAX_REFS} references at once` }, 400);
    const page = url.searchParams.get("page");
    return json({ cards: page === null ? cards(refs) : cardsForPage(checkPage(page), refs) });
  } },
];
export default routes;
