// Routes for floors (see src/server/floors.ts): list them, add one, change or remove one, and one HQ telling another
// floor's HQ something. The router loads every file in this folder.
//   GET  /api/floors                 { floors: S.floors, caller: the caller's floor id }
//   GET  /api/floors/agents          { agents: [{ name, machine, status, kind, lane, floor }] } herdr's live named agents
//   GET  /api/floors/kinds           { kinds, ready, lead } the agent kinds herdr can start, those with herdr's
//                                    integration installed (herdr reads their state), and the first floor's HQ's kind
//   POST /api/floors                 { id, name?, hq, color? }  add;  { id, name?, color?, start: true, kind? }  start
//                                    its HQ (hq-<id>, in a new herdr tab, of that herdr agent kind; by default the
//                                    first floor's HQ's) and add the floor once it runs, or waits on a startup prompt
//   POST /api/floors/ID              { name?, hq?, color? }  change;  { rm: true }  remove (only an empty floor);
//                                    { start: true, kind? }  START ITS HQ: start hq-<id> in a new herdr tab and make it
//                                    the HQ (of the kind it last ran, unless kind says another)
// A floor's HQ (USE AN AGENT, PICK ANOTHER, hud floor add/set --hq) must run in herdr on this machine: the HUD types
// into HQ here. Only START A NEW HQ adds a floor whose HQ is not up yet (STARTING until the next sync finds it).
//   POST /api/floors/ID/tell         { text }  types "HUD from floor <caller's floor>: TEXT" into that floor's HQ
import { addFloor, floorList, floorOfHq, hqKindOf, insertFloor, mustFloor, newFloor, rememberKind, removeFloor, setFloor } from "../floors.ts";
import { event } from "../events.ts";
import { forgetLink, neverSeen, notifyHq } from "../hq-link.ts";
import { live, syncHerdr, whereRuns } from "../herdr.ts";
import { agentKind, agentKinds, startHq } from "../floor-start.ts";
import { guideFor } from "../../hq-guide.ts";
import { LOCAL } from "../config.ts";
import { state } from "../state.ts";
import { json } from "../json.ts";
import type { Route } from "../router.ts";

const ID = "([a-z0-9][a-z0-9-]{0,31})";
// A floor added, or given another HQ: check its link now rather than at the next sync.
const recheck = () => void syncHerdr().catch(() => {});
// The agent asked for as a floor's HQ runs here: read herdr again when the last sync did not show it.
async function mustRunHere(hq: unknown) {
  const name = String(hq ?? "").trim();
  if (!name) return;
  if (whereRuns(name) !== LOCAL) await syncHerdr().catch(() => {});
  const at = whereRuns(name);
  if (at === LOCAL) return;
  if (at) throw new Error(`${name} runs on ${at}, not on this machine: the HUD types into a floor's HQ here. Pick an agent that runs here, or START A NEW HQ`);
  throw new Error(`${name} is not running in herdr: pick an agent that runs, or START A NEW HQ`);
}
const running = (a: { name: string; machine: string; status: string }) => a.machine === LOCAL && a.status !== "gone";

const routes: Route[] = [
  { method: "GET", path: "/api/floors", handle: ({ caller }) => json({ floors: (state() as any).floors, caller: caller().floor }) },
  { method: "GET", path: "/api/floors/agents", handle: () => json({ agents: live.filter(running).map((a) => ({ ...a, floor: floorOfHq(a.name) })) }) },
  { method: "GET", path: "/api/floors/kinds", handle: async () => json(await agentKinds()) },
  { method: "POST", path: "/api/floors", handle: async ({ body }) => {
    let f, waiting: string | null = null;
    if (body.start === true) {
      const want = newFloor(body, true);
      const got = await startHq(want, agentKind(body.kind));
      f = insertFloor(newFloor(body, true)); // checked again: another floor may have taken the id meanwhile
      rememberKind(f.id, got.kind);
      event("hud", `floor ${f.id} added (${f.name}); started its HQ ${f.hq} (${got.kind}) in herdr${got.waiting ? `; it waits on a prompt in its pane: ${got.waiting.split("\n").join(" / ")}` : ""}`, null, f.id);
      waiting = got.waiting;
    } else {
      newFloor(body); // a bad id or a taken HQ says so before herdr is read
      await mustRunHere(body.hq);
      f = addFloor(body);
      event("hud", `floor ${f.id} added (${f.name}, HQ ${f.hq})`, null, f.id);
    }
    // The new HQ hears which floor it owns: held until the sync that first finds it in herdr, then typed in and
    // confirmed. An agent that is not running yet gets it from the plugin's greet when it starts.
    if (body.start === true || live.some((a) => a.name === f.hq && a.machine === LOCAL)) notifyHq(guideFor(f), undefined, f.id);
    recheck();
    return { id: f.id, waiting };
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
  { method: "POST", pattern: new RegExp(`^/api/floors/${ID}$`), handle: async ({ body, m }) => {
    const f = mustFloor(m[1]);
    if (body.start === true) {
      const hq = `hq-${f.id}`;
      const other = floorOfHq(hq);
      if (other && other !== f.id) throw new Error(`${hq} is already the HQ of floor ${other}: one HQ runs one floor`);
      // A never-started HQ still has its guide held; one that ran and stopped starts as a fresh agent and needs it.
      const held = neverSeen(f.id) && f.hq === hq;
      const got = await startHq({ id: f.id, name: f.name, hq }, agentKind(body.kind) ?? hqKindOf(f.id) ?? undefined);
      rememberKind(f.id, got.kind);
      event("hud", `started ${hq} (${got.kind}) in herdr as the HQ of floor ${f.id}${got.waiting ? `; it waits on a prompt in its pane: ${got.waiting.split("\n").join(" / ")}` : ""}`, null, f.id);
      // A new tab, never the stopped HQ's old pane: its link starts over, and the new HQ hears which floor it owns.
      setFloor(f.id, { hq });
      forgetLink(f.id);
      if (!held) notifyHq(guideFor(mustFloor(f.id)), undefined, f.id);
      recheck();
      return { waiting: got.waiting };
    }
    if (body.hq !== undefined && String(body.hq).trim() !== f.hq) await mustRunHere(body.hq);
    if (body.rm === true) {
      removeFloor(f.id);
      forgetLink(f.id);
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
