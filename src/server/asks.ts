// Asks: HQ's questions, and answering them.
import { checkMinutes, checkName, checkValue } from "./secrets.ts";
import { expiresText } from "../client/secrets/expiry.js";
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { secrets } from "./push.ts";
import { event } from "./events.ts";
import { notifyHq } from "./hq-link.ts";
import { recordUrgent } from "./urgent.ts";
import { commentAsk } from "./ledger.ts";

// An ask for the owner's desk, or (with body.recipient) a message in an orchestrator's queue; see queue.ts.
// body.urgent files it at the top of its recipient's list; body.by names who is being urgent (default: its lane).
export function createAsk(body: any) {
  if (!body.title) throw new Error("title is required");
  const wanted = [...new Set<string>((body.secrets ?? []).map(checkName))];
  const recipient = body.recipient ?? "owner";
  const created = body.created_at ?? Date.now();
  const res = db
    .query("INSERT INTO asks (lane, kind, title, body, options, recommended, link, due, created_at, secrets, recipient, urgent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      body.lane ?? null,
      body.kind ?? "decision",
      body.title,
      body.body ?? null,
      body.options?.length ? JSON.stringify(body.options) : null,
      body.recommended ?? null,
      body.link ?? null,
      body.due ?? null,
      created,
      wanted.length ? JSON.stringify(wanted) : null,
      recipient,
      body.urgent ? Date.now() : null,
    );
  const id = Number(res.lastInsertRowid);
  if (recipient === "owner") event("hq", `asked: ${body.title}`, body.lane);
  if (body.urgent) recordUrgent(db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask, body.by ?? body.lane ?? "hq");
  return id;
}

// An ask on the owner's desk. The desk's routes (withdraw, update, comment, ack, secrets) refuse an item in someone's
// queue: that one is answered with hud req, and closing it from the desk would skip its delivery.
export function ownerAsk(id: number): Ask {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.recipient !== "owner") throw new Error(`ask ${id} is for ${ask.recipient}, not the owner: use hud req ${id}`);
  return ask;
}

export function answerAsk(id: number, answer: string) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  if (ask.recipient !== "owner") throw new Error(`ask ${id} is for ${ask.recipient}, not the owner: answer it with hud req answer ${id}`);
  db.query("UPDATE asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, Date.now(), id);
  event(OWNER, `answered "${ask.title}": ${answer}`, ask.lane);
  notifyHq(`HUD answer #${id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}" -> ${answer}`, `ask:${id}`);
}

// An ask that requests secrets is answered with their values: each one goes to the secret store, and the
// answer HQ gets (and the database keeps) names them only.
export function answerWithSecrets(id: number, body: any) {
  const ask = ownerAsk(id);
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
  event(OWNER, `not yet on "${ask.title}"${n ? `: ${n}` : ""}`, ask.lane);
  notifyHq(`HUD not yet #${id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}"${n ? ` -> ${n}` : ""}`, `notyet:${id}`);
}
