// The queue: what a lane (or the owner) sends HQ or an orchestrator, as asks whose recipient is not the owner.
// A message waits in the queue until it is read; only an urgent one also types a line into the recipient's pane.
// A request closes only when the answer has reached the lane's pane, so waiting is a row to drain, not a guess
// from pane state. A BLOCK or QUESTION may carry the lane's own default and a time; when the time comes the item is
// marked defaulted and drops out of the open queue, because the lane goes ahead on its own.
//
// The wire shape is the one lanes already use (/api/requests, hud request, hud req): toRequest maps an ask back to it.
import { readFileSync } from "node:fs";
import { ORCHESTRATION, OWNER } from "./config.ts";
import { db } from "./db.ts";
import { createAsk } from "./asks.ts";
import { event } from "./events.ts";
import { postUpdate } from "./updates.ts";
import { agentWhere, lastSync, promptAgent } from "./herdr.ts";
import { addStatePart } from "./state.ts";
import { firstLine } from "./urgent.ts";
import type { Ask } from "./types.ts";

export const KINDS = ["READY", "BLOCK", "QUESTION", "DONE", "NOTE"] as const;
// A default is what a lane does when nobody answers; READY, DONE and NOTE ask for nothing to default.
const DEFAULTABLE = ["BLOCK", "QUESTION"];
// HUD_DELIVER_TIMEOUT_MS shortens it for tests.
const DELIVER_TIMEOUT_MS = Number(process.env.HUD_DELIVER_TIMEOUT_MS) || 20_000;

// Whether the owner's Tell HQ goes to the queue (true) or is typed straight into HQ's pane (false). The URGENT toggle
// on Tell HQ takes the other path. The owner decided on HUD #180: "Queue by default, URGENT sends straight to HQ".
export const TELL_GOES_TO_QUEUE = true;

export type RequestRow = {
  id: number;
  kind: string;
  lane: string | null;
  pr: string | null;
  text: string;
  default_action: string | null;
  default_by: number | null;
  created_at: number;
  status: "open" | "defaulted" | "closed" | "withdrawn";
  defaulted_at: number | null;
  answer: string | null;
  answered_at: number | null;
  last_error: string | null;
  lead: string;
  urgent_at: number | null;
};

export function toRequest(a: Ask): RequestRow {
  return {
    id: a.id,
    kind: a.kind,
    lane: a.lane,
    pr: a.link,
    text: a.body ?? a.title,
    default_action: a.recommended,
    default_by: a.due,
    created_at: a.created_at,
    status: a.status === "answered" ? "closed" : a.status,
    defaulted_at: a.status === "defaulted" ? a.answered_at : null,
    answer: a.answer,
    answered_at: a.status === "defaulted" ? null : a.answered_at,
    last_error: a.last_error,
    lead: a.recipient,
    urgent_at: a.urgent_at,
  };
}

// Sends text into a lane's pane. Injected in tests; the real one is herdr.
export type Deliver = (lane: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;

// Who must answer a lane's request, from the orchestration registry: the PM a lane works under, else the orchestrator
// that lists it, else HQ. A missing or unreadable registry, or an unknown agent, means HQ.
function resolveLead(lane: string): string {
  const where = agentWhere(lane) ?? (db.query("SELECT machine, pane FROM lanes WHERE name = ?").get(lane) as { machine: string; pane: string } | null);
  if (!where?.machine || !where.pane || !ORCHESTRATION) return "HQ";
  try {
    const reg = JSON.parse(readFileSync(ORCHESTRATION, "utf8"));
    const key = `${where.machine} ${where.pane}`;
    const pm = reg.under?.[key]?.[0];
    if (typeof pm === "string" && pm) return pm;
    for (const [name, o] of Object.entries<any>(reg.orchestrators ?? {})) if (o?.lanes && key in o.lanes) return name;
  } catch {}
  return "HQ";
}

export function fileRequest(body: any, now = Date.now()) {
  const kind = String(body.kind ?? "NOTE").toUpperCase();
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const lane = String(body.lane ?? "").trim();
  if (!lane) throw new Error("lane is required: your herdr agent name");
  const text = String(body.text ?? "").trim();
  if (!text) throw new Error("the request text is required");
  const action = body.default ? String(body.default).trim() : null;
  const by = body.by === undefined || body.by === null ? null : Number(body.by);
  if (!!action !== (by !== null)) throw new Error("--default and --by go together");
  if (action) {
    if (!DEFAULTABLE.includes(kind)) throw new Error(`a ${kind} request has nothing to default`);
    if (!Number.isFinite(by) || by! <= now) throw new Error("--by must be a time in the future");
  }
  const pr = body.pr === undefined || body.pr === null || body.pr === "" ? null : String(body.pr).replace(/^#/, "");
  const lead = String(body.lead ?? "").trim() || resolveLead(lane);
  if (lead.toLowerCase() === "owner") throw new Error("a request goes to HQ or an orchestrator; the owner's questions are asks");
  const id = createAsk({ lane, kind, title: firstLine(text), body: text, link: pr, recommended: action, due: by, created_at: now, recipient: lead, urgent: !!body.urgent, by: lane });
  event(lane, `request #${id} ${kind}${pr ? ` PR #${pr}` : ""}${body.urgent ? " URGENT" : ""}: ${text.slice(0, 120)}`, lane);
  // A lane HQ cannot type into could never be answered; say so while the lane can still fix the name.
  const known = !!agentWhere(lane);
  return { id, warning: known ? undefined : `no live herdr agent is named ${lane}: HQ's answer cannot reach you until the name matches` };
}

// The owner's Tell HQ. A plain tell goes where TELL_GOES_TO_QUEUE says; URGENT takes the other path: when the queue
// is the default, an urgent tell is filed urgent and types its line into HQ's pane. `toQueue` is for tests.
export function tellHq(text: string, urgent: boolean, toQueue = TELL_GOES_TO_QUEUE, now = Date.now()): { queued: boolean; id?: number } {
  if (!toQueue && !urgent) return { queued: false };
  const id = createAsk({ lane: null, kind: "NOTE", title: firstLine(text), body: text, created_at: now, recipient: "HQ", urgent, by: OWNER });
  event(OWNER, `told HQ: ${text.slice(0, 120)}`);
  return { queued: true, id };
}

// Marks every default that has come due. Returns whether anything changed.
export function expireDefaults(now = Date.now()): boolean {
  const due = db.query("SELECT * FROM asks WHERE status = 'open' AND recipient != 'owner' AND due IS NOT NULL AND due <= ?").all(now) as Ask[];
  for (const a of due) {
    db.query("UPDATE asks SET status = 'defaulted', answered_at = ?, acked_at = ? WHERE id = ?").run(a.due, a.due, a.id);
    event("hq", `request #${a.id} defaulted: ${a.lane} goes ahead with: ${a.recommended}`, a.lane);
  }
  return due.length > 0;
}

// Open items, urgent first and then oldest first: what the recipient still has to answer. With a lead, only that
// lead's; without, every queue.
export function openRequests(lead?: string, now = Date.now()): RequestRow[] {
  expireDefaults(now);
  const rows = db
    .query("SELECT * FROM asks WHERE status = 'open' AND recipient != 'owner' AND (? IS NULL OR recipient = ?) ORDER BY urgent_at IS NULL, created_at, id")
    .all(lead ?? null, lead ?? null) as Ask[];
  return rows.map(toRequest);
}

// Everything, newest first, capped: for `hud req list --all`. With a lead, only that lead's.
export function allRequests(lead?: string, now = Date.now()): RequestRow[] {
  expireDefaults(now);
  return (db.query("SELECT * FROM asks WHERE recipient != 'owner' AND (? IS NULL OR recipient = ?) ORDER BY id DESC LIMIT 200").all(lead ?? null, lead ?? null) as Ask[]).map(toRequest);
}

// The first open item. Reading a note from the owner (no lane) is how the owner's page learns HQ has it.
export function nextRequest(lead?: string, now = Date.now()) {
  const r = openRequests(lead, now)[0] ?? null;
  if (r && !r.lane) db.query("UPDATE asks SET acked_at = COALESCE(acked_at, ?) WHERE id = ?").run(now, r.id);
  return r;
}

export const herdrDeliver: Deliver = async (lane, text) => {
  const a = agentWhere(lane);
  if (!a) return { ok: false, error: `no live herdr agent is named ${lane}` };
  return promptAgent(lane, text, a.machine, { timeoutMs: DELIVER_TIMEOUT_MS });
};

// A queue item by its ask id, or else by the number it had as a request before the copy (lanes still hold those).
function queued(id: number): Ask {
  const a = (db.query("SELECT * FROM asks WHERE id = ? AND recipient != 'owner'").get(id) ?? db.query("SELECT * FROM asks WHERE request_id = ? AND recipient != 'owner'").get(id)) as Ask | null;
  if (!a) throw new Error(`no request #${id}`);
  if (a.status === "answered" || a.status === "withdrawn") throw new Error(`request #${id} is already closed`);
  return a;
}

// Closes a request whose lane is gone (its pane closed after its push), with the reason on the record. A live lane is
// refused: its answer must reach its pane, so it is answered, never closed. Why: on 24 Oct 2026 a PM closed a builder's
// pane after the push and its READY could neither be answered nor closed.
export function closeRequest(id: number, reason: string, now = Date.now()) {
  const text = reason.trim();
  if (!text) throw new Error("the reason is required");
  const r = queued(id);
  // The agents table keeps the last sync's answer across a restart; a table with no sync behind it (a first start) proves nothing.
  if (r.lane && agentWhere(r.lane)) throw new Error(`${r.lane} is live: answer it with hud req answer ${id} so the answer reaches its pane`);
  if (r.lane && lastSync.at === 0) throw new Error(`HUD has not listed herdr's agents since it started, so it cannot tell whether ${r.lane} is gone: try again in a minute`);
  // The owner's note has no pane to deliver to: closing it is HQ saying it needs no reply.
  const why = r.lane ? `not delivered: no live agent named ${r.lane}` : null;
  db.query("UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, acked_at = ?, last_error = ? WHERE id = ?").run(text, now, now, why, r.id);
  event("hq", r.lane ? `closed request #${r.id} from ${r.lane}, which is gone: ${text.slice(0, 120)}` : `closed the owner's note #${r.id} with no reply: ${text.slice(0, 120)}`, r.lane);
  return { id: r.id, lane: r.lane };
}

// Answers can overlap (two HQ turns, a retry): one delivery per request at a time.
const delivering = new Set<number>();

// Delivers the answer to the lane's pane and closes the item in the same step. A defaulted request can still be
// answered: HQ may correct a lane that has gone ahead. Throws, leaving the item open, when the pane is not reached.
export async function answerRequest(id: number, answer: string, deliver: Deliver = herdrDeliver, now = Date.now()) {
  const text = answer.trim();
  if (!text) throw new Error("the answer text is required");
  const r = queued(id);
  id = r.id;
  if (delivering.has(id)) throw new Error(`request #${id} is being answered right now`);
  delivering.add(id);
  try {
    // A note from the owner has no lane to type into: the answer is an HQ update (what hud tell makes), so it lands in
    // FROM HQ and MESSAGES, titled with the note it answers.
    if (!r.lane) postUpdate({ title: `Re: ${firstLine(r.title).slice(0, 80)}`, body: text });
    const sent = r.lane ? await deliver(r.lane, `${r.recipient} answer to your request #${id} (${r.kind}): ${text}`) : { ok: true as const };
    if (!sent.ok) {
      db.query("UPDATE asks SET last_error = ? WHERE id = ?").run(sent.error, id);
      throw new Error(`not delivered to ${r.lane}: ${sent.error}. Request #${id} stays open`);
    }
    db.query("UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, acked_at = ?, last_error = NULL WHERE id = ?").run(text, now, now, id);
    event("hq", `answered request #${id} from ${r.lane}: ${text.slice(0, 120)}`, r.lane);
    return { id, lane: r.lane };
  } finally {
    delivering.delete(id);
  }
}

// The board's view of HQ's queue: how many wait, since when, and whether any is urgent.
export function queueView(lead = "HQ", now = Date.now()) {
  const rows = openRequests(lead, now);
  return { lead, count: rows.length, oldest: rows.length ? Math.min(...rows.map((r) => r.created_at)) : null, urgent: rows.filter((r) => r.urgent_at).length };
}
// tellToQueue lets the page word the URGENT toggle for what the constant says.
addStatePart("queue", () => ({ ...queueView(process.env.HUD_LEAD || "HQ"), tellToQueue: TELL_GOES_TO_QUEUE }));
