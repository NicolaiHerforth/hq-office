// Asks: HQ's questions, and answering them.
import { checkMinutes, checkName, checkValue } from "./secrets.ts";
import { expiresText } from "../client/secrets/expiry.js";
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { secrets } from "./push.ts";
import { event } from "./events.ts";
import { notifyHq } from "./hq-link.ts";
import { commentAsk } from "./ledger.ts";
import { floorOr, laneFloor } from "./floors.ts";
import { askPageKey, hasAskPage, pageOfFields, setAskPage } from "./ask-pages.ts";

// On its lane's floor, else the caller's (the first floor when no caller is known). With an HTML page (--file q.html,
// or a body that is a page): ask-pages.ts.
export function createAsk(body: any, callerFloor?: string) {
  if (!body.title) throw new Error("title is required");
  const { page, body: text } = pageOfFields(body);
  const floor = laneFloor(body.lane) ?? floorOr(callerFloor);
  const wanted = [...new Set<string>((body.secrets ?? []).map(checkName))];
  const res = db
    .query("INSERT INTO asks (lane, kind, title, body, options, recommended, link, due, created_at, secrets, floor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      body.lane ?? null,
      body.kind ?? "decision",
      body.title,
      text ?? null,
      body.options?.length ? JSON.stringify(body.options) : null,
      body.recommended ?? null,
      body.link ?? null,
      body.due ?? null,
      body.created_at ?? Date.now(),
      wanted.length ? JSON.stringify(wanted) : null,
      floor,
    );
  const id = Number(res.lastInsertRowid);
  if (page !== undefined) setAskPage(id, page);
  event("hq", `asked: ${body.title}`, body.lane, floor);
  return id;
}

export function answerAsk(id: number, answer: string) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  db.query("UPDATE asks SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, Date.now(), id);
  event(OWNER, `answered "${ask.title}": ${answer}`, ask.lane, ask.floor);
  // An ask with a page: what the owner did in it (picks, rows, notes) is in the page's data, not in the answer.
  const data = hasAskPage(id) ? ` (it has a page: what the owner did in it: hud page data ${askPageKey(id)})` : "";
  notifyHq(`HUD answer #${id}${ask.lane ? ` (${ask.lane})` : ""}: "${ask.title}" -> ${answer}${data}`, `ask:${id}`, ask.floor);
}

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
