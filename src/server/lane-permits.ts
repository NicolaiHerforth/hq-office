// The one permit book (permits.ts) on the server's database: what the lane hook is answered, the question HQ raises
// for one request (hud permit ask), what the owner's answer to it does, and the log of every allow and every use.
//
// Whose yes it is: only the owner's, on the HUD's page. The question's body is the request as recorded, never HQ's
// wording; an answer to it from an agent's pane or a command is refused, and so is "Allow this once" on a question
// that was edited after it was raised. HQ carries the question and "try again", never the yes. What this does not
// stop is in the README: a lane runs as the same user as the HUD.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOW, ALLOW_MS, NO, TITLE, askBody, cannotAllow, createPermits, oneLine, shortOf, type Row } from "./permits.ts";
import { DATA, DIR, HOST, OWNER, PORT } from "./config.ts";
import { db } from "./db.ts";
import { secrets } from "./push.ts";
import { event } from "./events.ts";
import { askHooks, createAsk, laneCaller } from "./asks.ts";
import { hasAskPage } from "./ask-pages.ts";
import { commentAsk } from "./ledger.ts";
import { laneFloor, type Caller } from "./floors.ts";
import { copyLaneHook, laneSettings, writeLaneSettings } from "./lane-settings.ts";

export const permits = createPermits({ db, mask: (s) => secrets.mask(s) });

// The lane settings file (lane-settings.ts), the hook's copy it runs and the marker its PreToolUse command tests for,
// all in the data folder, where a plugin update moves nothing.
const PERMIT_MARKER = join(DATA, "lane-permits-open");
const ANY_ADDRESS = new Set(["0.0.0.0", "::", "[::]"]);
// hud lane-settings: the file's path. The hook's copy and the file are written first if missing or different.
export function ensureLaneSettings() {
  const hook = copyLaneHook(join(DIR, "bin", "lane-hook.ts"), join(DATA, "lane-hook.ts"));
  return writeLaneSettings(join(DATA, "lane-settings.json"), laneSettings({ bun: process.execPath, hook, url: `http://${ANY_ADDRESS.has(HOST) ? "127.0.0.1" : HOST}:${PORT}`, marker: PERMIT_MARKER }));
}

export const REFUSED = "nobody answers prompts in this pane; do it another way, or tell HQ what you need";
const askStatus = (id: number | null) => (id ? ((db.query("SELECT status FROM asks WHERE id = ?").get(id) as { status: string } | null)?.status ?? null) : null);
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

// The marker is there while an allow waits to be used.
function marker() {
  try {
    permits.expire();
    if (!permits.open()) rmSync(PERMIT_MARKER, { force: true });
    else if (!existsSync(PERMIT_MARKER)) writeFileSync(PERMIT_MARKER, "");
  } catch {}
}

function refusal(p: Row, lane: string | null) {
  const no = cannotAllow(p);
  if (no) return `${REFUSED}. This request cannot be allowed from the HUD: ${no} (permit #${p.id})`;
  if (!lane) return `${REFUSED}. Nothing can be allowed here: this pane is not a registered lane (permit #${p.id})`;
  if (askStatus(p.ask) === "open") return `${REFUSED}. This exact request is permit #${p.id}, and the owner has been asked (ask #${p.ask}): do not retry it until the answer comes`;
  return `${REFUSED}. This exact request is permit #${p.id} (HQ: hud permit ask ${p.id})`;
}

function used(p: Row) {
  event("hud", `permit #${p.id} used by ${p.lane}: ${shortOf(p)}`, p.lane, p.floor);
}

// POST /api/permits/hook: what the lane hook sends for each of its events, and what it is answered: a decision, that
// the lane may retry, or nothing. Only a registered lane can use an allow; a request from an HQ's pane, or from a
// pane the HUD knows no lane in, is recorded and refused. `quiet` is for the route: nothing changed, so no page need
// refetch (PreToolUse runs on every tool call of every lane while an allow waits).
export function fromHook(body: any, caller: Caller): { decision?: "allow" | "deny"; message?: string; retry?: boolean; permit?: number; quiet?: boolean } {
  const lane = laneCaller(caller.agent);
  // A request is its lane's: the registered lane's name, else whatever herdr calls the caller, which can use nothing.
  const req = { floor: caller.floor, lane: lane ?? caller.agent, tool: body.tool, input: body.input, mode: body.mode, cwd: body.cwd };
  permits.expire();
  try {
    switch (body.event) {
      case "PreToolUse": {
        // Not a request: only a look for the owner's yes to a call the classifier blocked. Nothing is recorded.
        const hit = lane ? permits.take({ ...req, kind: "classifier" }, "pre") : null;
        if (!hit) return { quiet: true };
        used(hit);
        return { decision: "allow", permit: hit.id };
      }
      case "PermissionRequest": {
        const hit = lane ? permits.take({ ...req, kind: "prompt" }, "prompt") : null;
        if (hit) {
          used(hit);
          return { decision: "allow", permit: hit.id };
        }
        const p = permits.seen({ ...req, kind: "prompt" });
        return { decision: "deny", message: refusal(p, lane), permit: p.id };
      }
      case "PermissionDenied": {
        // The classifier blocked it. If the owner has allowed this exact request, the lane may try again: the allow
        // now waits at PreToolUse, which comes before the classifier.
        const b = lane ? permits.blocked({ ...req, kind: "classifier", reason: body.reason }) : { row: permits.seen({ ...req, kind: "classifier", reason: body.reason }), retry: false };
        return b.retry ? { retry: true, permit: b.row.id } : { permit: b.row.id };
      }
      case "Notification": {
        if (body.type !== "permission_prompt") return { quiet: true };
        const p = permits.seen({ ...req, kind: "stuck", reason: body.message });
        event("hook", `is showing a prompt its hook did not answer${p.reason ? `: ${oneLine(p.reason, 120)}` : ""} (permit #${p.id})`, lane, caller.floor);
        return { permit: p.id };
      }
      default:
        return { quiet: true };
    }
  } finally {
    marker();
  }
}

// The floor a permit is on now: its lane's (a lane can move), else the one it was recorded on.
const floorOf = (p: Row) => laneFloor(p.lane) ?? p.floor;
// A permit the caller may read: its own floor's, or any with --all.
export function permitFor(id: number, caller: Pick<Caller, "floor" | "all">) {
  permits.expire();
  const p = permits.row(id);
  if (!p) throw new Error(`no permit ${id}: hud permit list shows them`);
  const floor = floorOf(p);
  if (!caller.all && floor && floor !== caller.floor) throw new Error(`permit #${id} is on floor ${floor}, not yours (${caller.floor}); its HQ asks, or use --all`);
  return p;
}
export const permitText = (p: Row) => permits.show({ ...p, floor: floorOf(p) }, askStatus(p.ask));
// One floor's recent requests, or every floor's with null: the newest 30.
export const permitList = (floor: string | null) => permits.list().filter((p) => !floor || floorOf(p) === floor).slice(0, 30);
export const permitLines = (floor: string | null) => permitList(floor).map((p) => permits.line(p, askStatus(p.ask)));

// hud permit ask ID [--why TEXT]: the question for one request, on the lane's floor, for the lane (its answer goes
// there, as ask-routing does). The body is the request as recorded and nothing else; --why is a comment under the
// question (the ask ledger's), one line, marked as HQ's.
export function raise(id: number, why: unknown, caller: Caller) {
  if (laneCaller(caller.agent)) throw new Error(`a lane does not ask the owner for its own permit: tell your HQ what you need and why (hud request TEXT); HQ runs hud permit ask ${id}`);
  const p = permitFor(id, caller);
  const no = cannotAllow(p);
  if (no) throw new Error(`permit #${id} cannot be allowed: ${no}`);
  if (!p.lane || !laneCaller(p.lane)) throw new Error(`permit #${id} is not from a registered lane (${p.lane ?? "a pane herdr has no agent in"}): the lane settings file is for lanes only`);
  if (p.status === "allowed") throw new Error(`permit #${id} is already allowed, until ${hhmm((p.allowed_at ?? 0) + ALLOW_MS)}: tell ${p.lane} to retry the exact same call`);
  if (p.status === "used") throw new Error(`permit #${id} was allowed and used; a new try is a new permit`);
  if (askStatus(p.ask) === "open") throw new Error(`the owner has already been asked about permit #${id}: ask #${p.ask}`);
  const note = secrets.mask(oneLine(String(why ?? "")));
  const said = askBody(p);
  const ask = createAsk({ lane: p.lane, kind: "decision", title: TITLE, body: said, options: [ALLOW, NO] }, floorOf(p) ?? caller.floor, p.lane, caller.agent ?? "hq");
  permits.setAsk(p.id, ask, said);
  if (note) commentAsk(ask, `**HQ's note** (HQ's words, not part of the request): ${note}`);
  return { ask, permit: p.id, lane: p.lane };
}

const isAllow = (answer: string) => answer === ALLOW || answer.startsWith(`${ALLOW}. `);

askHooks.push({
  // Before the answer is stored. A permit ask takes an answer only from the HUD's page: a browser's POST carries an
  // Origin (http.ts lets only the HUD's own through) and no herdr pane.
  check(ask, answer, from) {
    const p = permits.byAsk(ask.id);
    if (!p) return;
    if (!from?.page || from.pane) throw new Error(`ask #${ask.id} asks the owner to allow a lane's request: only the owner's answer on the HUD's page counts, never one from an agent's pane or a command`);
    if (!isAllow(answer)) return;
    if (ask.title !== TITLE || !p.said || ask.body !== p.said || ask.options !== JSON.stringify([ALLOW, NO]) || hasAskPage(ask.id)) {
      throw new Error(`this question was changed after it was raised, so it no longer shows the request as recorded and cannot allow it. HQ: hud withdraw ${ask.id}, then hud permit ask ${p.id}`);
    }
    if (p.status !== "refused" && p.status !== "expired") throw new Error(`permit #${p.id} is already ${p.status}`);
    const no = cannotAllow(p);
    if (no) throw new Error(`permit #${p.id} cannot be allowed: ${no}`);
    if (!p.lane || !laneCaller(p.lane)) throw new Error(`${p.lane ?? "its lane"} is no longer a lane, so nothing could use the allow. HQ: hud withdraw ${ask.id}`);
  },
  // Once it is stored: the allow, the log, and what the lane is told in place of the answer's usual line.
  answered(ask, answer) {
    const p = permits.byAsk(ask.id);
    if (!p) return null;
    if (isAllow(answer)) {
      permits.allow(p.id);
      marker();
      event(OWNER, `allowed once: permit #${p.id} for ${p.lane}: ${shortOf(p)}`, p.lane, p.floor);
      const more = answer.slice(ALLOW.length + 2).trim();
      return `HUD permit #${p.id}: allowed once by ${OWNER}${more ? ` ("${more}")` : ""}. Retry the exact same call now (${shortOf(p)})${p.cwd ? `, from ${p.cwd}` : ""}. It is good for one use within the hour; a changed call is a new request.`;
    }
    const words = answer === NO ? "" : answer.startsWith(`${NO}. `) ? answer.slice(NO.length + 2) : answer;
    event(OWNER, `refused permit #${p.id} for ${p.lane}: ${shortOf(p)}`, p.lane, p.floor);
    return `HUD permit #${p.id}: refused by ${OWNER}${words ? ` ("${words}")` : ""}. Do it another way (${shortOf(p)}).`;
  },
});

// At every start: the settings file names this server, the hook's copy is this code's, and the marker says what the
// table says. A data folder that cannot be written must not stop the server: hud lane-settings then says why.
try {
  ensureLaneSettings();
} catch (e) {
  console.error(`lane settings not written: ${(e as Error).message}`);
}
marker();
