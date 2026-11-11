// Routes for notes. The router loads every file in this folder; see src/server/router.ts.
import { OWNER } from "../config.ts";
import { db } from "../db.ts";
import { event } from "../events.ts";
import { notifyHq } from "../hq-link.ts";
import { checkScope } from "../asks.ts";
import { firstFloor } from "../floors.ts";
import { fileItem, queueOn } from "../hq-queue.ts";
import { sortHint } from "../requests.ts";
import { requests } from "../owner-requests.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  // A note from the page goes to the floor it sends (floor in the body), else the first floor. With the HQ QUEUE on it
  // waits in HQ's queue; urgent (the URGENT switch on Tell HQ) or with the queue off, it is typed into HQ's pane.
  { method: "POST", path: "/api/notes", handle: ({ body, caller }) => {
    if (!String(body.text ?? "").trim()) throw new Error("text is required");
    if (caller().all) throw new Error("a note goes to one floor");
    const floor = caller().explicit ?? firstFloor();
    const text = String(body.text).trim();
    const { lastInsertRowid } = db.query("INSERT INTO notes (at, text, floor) VALUES (?, ?, ?)").run(Date.now(), text, floor);
    // Every note is a request (requests.ts); an acknowledgement is filed closed and gets no hint.
    const request = requests.fileNote({ floor, text, note: Number(lastInsertRowid) });
    event(OWNER, `told HQ: ${text}`, null, floor);
    // Queued, HQ reads it with hud req next, which names the request; typed in, the line ends with it.
    if (queueOn() && body.urgent !== true) fileItem({ floor, from: "owner", text, via: "page", ref: `note:${lastInsertRowid}` });
    else notifyHq(`HUD note from ${OWNER}${body.urgent === true ? " (URGENT)" : ""}: ${text}${sortHint(request)}`, `note:${lastInsertRowid}`, floor);
    return { ok: true, request: request.status === "new" ? request.id : null };
  } },
  { method: "POST", pattern: /^\/api\/notes\/(\d+)\/ack$/, handle: ({ m, caller }) => {
    checkScope("note", Number(m[1]), caller());
    db.query("UPDATE notes SET acked_at = ? WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
