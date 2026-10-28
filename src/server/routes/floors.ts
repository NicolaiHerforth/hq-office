// Routes for floors (see src/server/floors.ts): list them, add one, change or remove one, and one HQ telling another
// floor's HQ something. The router loads every file in this folder.
//   GET  /api/floors                 { floors: S.floors, caller: the caller's floor id }
//   GET  /api/floors/agents          { agents: [{ name, machine, status, lane, floor }] } herdr's live named agents
//   POST /api/floors                 { id, name?, hq, color? }  add;  { id, name?, color?, start: true }  start its HQ
//                                    (hq-<id>, in a new herdr tab) and add the floor once it runs
//   POST /api/floors/ID              { name?, hq?, color? }  change;  { rm: true }  remove (only an empty floor)
//   POST /api/floors/ID/tell         { text }  types "HUD from floor <caller's floor>: TEXT" into that floor's HQ
import { addFloor, floorList, floorOfHq, insertFloor, mustFloor, newFloor, removeFloor, setFloor } from "../floors.ts";
import { event } from "../events.ts";
import { forgetLink, notifyHq } from "../hq-link.ts";
import { live, syncHerdr } from "../herdr.ts";
import { startHq } from "../floor-start.ts";
import { guideFor } from "../../hq-guide.ts";
import { LOCAL } from "../config.ts";
import { state } from "../state.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const ID = "([a-z0-9][a-z0-9-]{0,31})";
// A floor added, or given another HQ: check its link now rather than at the next sync.
const recheck = () => void syncHerdr().catch(() => {});

const routes: Route[] = [
  { method: "GET", path: "/api/floors", handle: ({ caller }) => json({ floors: (state() as any).floors, caller: caller().floor }) },
  { method: "GET", path: "/api/floors/agents", handle: () => json({ agents: live.map((a) => ({ ...a, floor: floorOfHq(a.name) })) }) },
  { method: "POST", path: "/api/floors", handle: async ({ body }) => {
    let f;
    if (body.start === true) {
      const want = newFloor(body, true);
      await startHq(want);
      f = insertFloor(newFloor(body, true)); // checked again: another floor may have taken the id meanwhile
      event("hud", `floor ${f.id} added (${f.name}); started its HQ ${f.hq} in herdr`, null, f.id);
    } else {
      f = addFloor(body);
      event("hud", `floor ${f.id} added (${f.name}, HQ ${f.hq})`, null, f.id);
    }
    // The new HQ hears which floor it owns: held until the sync that first finds it in herdr, then typed in and
    // confirmed. An agent that is not running yet gets it from the plugin's greet when it starts.
    if (body.start === true || live.some((a) => a.name === f.hq && a.machine === LOCAL)) notifyHq(guideFor(f), undefined, f.id);
    recheck();
    return { id: f.id };
  } },
  { method: "POST", pattern: new RegExp(`^/api/floors/${ID}/tell$`), handle: ({ body, m, caller }) => {
    const to = mustFloor(m[1]);
    const from = caller().floor;
    const text = String(body.text ?? "").trim();
    if (!text) throw new Error("say something: hud floor tell FLOOR TEXT");
    if (to.id === from) throw new Error(`floor ${to.id} is your own floor`);
    event(caller().agent ?? "hq", `floor ${from} told floor ${to.id}: ${text}`, null, to.id);
    notifyHq(`HUD from floor ${from}: ${text}`, undefined, to.id);
  } },
  { method: "POST", pattern: new RegExp(`^/api/floors/${ID}$`), handle: ({ body, m }) => {
    const f = mustFloor(m[1]);
    if (body.rm === true) {
      removeFloor(f.id);
      forgetLink(f.id);
      event("hud", `floor ${f.id} removed`);
      return { floors: floorList().map((x) => x.id) };
    }
    if (setFloor(f.id, body)) {
      forgetLink(f.id);
      recheck();
    }
    event("hud", `floor ${f.id} changed`, null, f.id);
  } },
];
export default routes;
