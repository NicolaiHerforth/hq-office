// The one request book (requests.ts) on the server's database: in /api/state as S.requests, every not-closed request
// on all floors, oldest first. Its housekeeping runs after each herdr sync (hq-sweep.ts calls it), with no timer.
import { createRequests } from "./requests.ts";
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";
import { addStatePart } from "./state.ts";
import { firstFloor } from "./floors.ts";
import { notifyHq } from "./hq-link.ts";
import { fileItem, queueOn } from "./hq-queue.ts";

export const requests = createRequests({ db, firstFloor });
addStatePart("requests", () => requests.view());

export function housekeepRequests() {
  if (requests.housekeep()) bump();
}

// The owner reopened a delivered or withdrawn request: its HQ hears it as it hears a note (queued with the HQ QUEUE on).
export function reopenRequest(id: unknown, text: unknown) {
  const r = requests.reopen(id, text);
  const told = `HUD: ${OWNER} reopened request #${r.id}: ${String(text).trim()}`;
  if (queueOn()) fileItem({ floor: r.floor, from: "owner", text: told, via: "page" });
  else notifyHq(told, undefined, r.floor);
  return r;
}
