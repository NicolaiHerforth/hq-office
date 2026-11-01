// Asks: HQ's questions, and answering them.
import { checkMinutes, checkName, checkValue } from "./secrets.ts";
import { expiresText } from "../client/secrets/expiry.js";
import { OWNER } from "./config.ts";
import { addStatePart } from "./state.ts";
import { bump } from "./push.ts";
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { secrets } from "./push.ts";
import { event } from "./events.ts";
import { notifyHq } from "./hq-link.ts";
import { commentAsk } from "./ledger.ts";
import { floorOr, laneFloor } from "./floors.ts";

// On its lane's floor, else the caller's (the first floor when no caller is known).
export function createAsk(body: any, callerFloor?: string) {
  if (!body.title) throw new Error("title is required");
  const floor = laneFloor(body.lane) ?? floorOr(callerFloor);
  const wanted = [...new Set<string>((body.secrets ?? []).map(checkName))];
  // A deadline goes ahead with the recommended option, so it needs one; and a secret is never defaulted.
  const by = body.default_by == null ? null : Number(body.default_by);
  if (by != null) {
    if (!Number.isFinite(by)) throw new Error("--by must be a time");
    if (!String(body.recommended ?? "").trim()) throw new Error("--by needs --rec: the ask goes ahead with the recommended option");
    if (wanted.length) throw new Error("--by cannot go with --secret: a secret is never defaulted");
  }
  const res = db
    .query("INSERT INTO asks (lane, kind, title, body, options, recommended, link, due, created_at, secrets, floor, default_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      body.lane ?? null,
      body.kind ?? "decision",
      body.title,
      body.body ?? null,
      body.options?.length ? JSON.stringify(body.options) : null,
      body.recommended ?? null,
      body.link ?? null,
      body.due ?? null,
      body.created_at ?? Date.now(),
      wanted.length ? JSON.stringify(wanted) : null,
      floor,
      by,
    );
  event("hq", `asked: ${body.title}`, body.lane, floor);
  return Number(res.lastInsertRowid);
}

export function answerAsk(id: number, answer: string) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open" && ask.status !== "defaulted") throw new Error(`ask ${id} is already ${ask.status}`);
  // An answer after the default is a change of mind: HQ hears it again, even if it had acted on the default.
  const after = ask.status === "defaulted";
  db.query("UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, acked_at = NULL WHERE id = ?").run(answer, Date.now(), id);
  event(OWNER, `answered "${ask.title}": ${answer}${after ? " (after the default)" : ""}`, ask.lane, ask.floor);
  notifyHq(`HUD answer #${id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}" -> ${answer}${after ? ` (after the default: it went ahead with "${ask.answer}")` : ""}`, `ask:${id}`, ask.floor);
}

// The deadline passed and nobody answered: the ask goes ahead with its recommended option. One sweep, one event, one
// word to HQ. It leaves the open questions, stays answerable (answerAsk), and waits in HQ's inbox like an answer.
export function defaultDueAsks(now = Date.now()) {
  const due = db.query("SELECT * FROM asks WHERE status = 'open' AND default_by IS NOT NULL AND default_by <= ? AND recommended IS NOT NULL ORDER BY default_by").all(now) as Ask[];
  for (const ask of due) {
    db.query("UPDATE asks SET status = 'defaulted', answer = recommended, answered_at = ?, defaulted_at = ?, acked_at = NULL WHERE id = ? AND status = 'open'").run(now, now, ask.id);
    event("hud", `ask #${ask.id} went ahead: ${ask.recommended}`, ask.lane, ask.floor);
    notifyHq(`HUD defaulted #${ask.id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}" -> went ahead with "${ask.recommended}"`, `ask:${ask.id}`, ask.floor);
  }
  if (due.length) bump();
}
setInterval(() => defaultDueAsks(), 1_000).unref();

// S.defaulted: asks that went ahead and can still be answered, newest first (the page lists them under the open ones).
addStatePart("defaulted", () =>
  (db.query("SELECT * FROM asks WHERE status = 'defaulted' ORDER BY defaulted_at DESC LIMIT 20").all() as Ask[]).map((a) => ({
    ...a,
    options: a.options ? JSON.parse(a.options) : [],
    secrets: [],
  })),
);

// An ask that requests secrets is answered with their values: each one goes to the secret store, and the
// answer HQ gets (and the database keeps) names them only.
export function answerWithSecrets(id: number, body: any) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  const wanted: string[] = ask.secrets ? JSON.parse(ask.secrets) : [];
  if (!wanted.length) throw new Error(`ask ${id} requests no secrets`);
  const minutes = checkMinutes(body.minutes);
  const values = wanted.map((name) => {
    try {
      return checkValue(body.values?.[name]);
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  });
  const set = wanted.map((name, i) => secrets.set(name, values[i], minutes, "owner"));
  const note = String(body.note ?? "").trim();
  answerAsk(id, `secrets set: ${wanted.join(", ")}, ${expiresText(set[0].expiresAt)}; read with: hud secret get NAME | <command>${note ? `. ${note}` : ""}`);
}

// NOT YET on something the owner must do: it stays open (the owner is still the one it waits on), HQ hears it at
// once, and a line on the card says it, with the owner's note.
export function notYet(id: number, note: unknown) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  const n = String(note ?? "").trim();
  commentAsk(id, `${OWNER}: not yet${n ? `. ${n}` : ""}`);
  event(OWNER, `not yet on "${ask.title}"${n ? `: ${n}` : ""}`, ask.lane, ask.floor);
  notifyHq(`HUD not yet #${id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}"${n ? ` -> ${n}` : ""}`, `notyet:${id}`, ask.floor);
}

// hud ack: an HQ acks what is on its own floor; another floor's needs --all.
export function checkScope(kind: "ask" | "note", id: number, caller: { floor: string; all: boolean }) {
  const row = db.query(`SELECT floor FROM ${kind === "ask" ? "asks" : "notes"} WHERE id = ?`).get(id) as { floor: string | null } | null;
  if (!row || caller.all || !row.floor || row.floor === caller.floor) return;
  throw new Error(`${kind === "ask" ? "answer" : "note"} ${id} is on floor ${row.floor}, not yours (${caller.floor}); its HQ acks it, or use --all`);
}
