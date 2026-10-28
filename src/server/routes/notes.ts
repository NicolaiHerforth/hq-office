// Routes for notes. The router loads every file in this folder; see src/server/router.ts.
import { OWNER } from "../config.ts";
import { db } from "../db.ts";
import { event } from "../events.ts";
import { notifyHq } from "../hq-link.ts";
import { tellHq } from "../queue.ts";
import type { Route } from "../router.ts";

const routes: Route[] = [
  { method: "POST", path: "/api/notes", handle: ({ body }) => {
    if (!String(body.text ?? "").trim()) throw new Error("text is required");
    // To the queue, or typed straight into HQ's pane as before: tellHq decides (TELL_GOES_TO_QUEUE, and the URGENT toggle).
    if (tellHq(String(body.text).trim(), !!body.urgent).queued) return;
    const { lastInsertRowid } = db.query("INSERT INTO notes (at, text) VALUES (?, ?)").run(Date.now(), String(body.text).trim());
    event(OWNER, `told HQ: ${String(body.text).trim()}`);
    notifyHq(`HUD note from ${OWNER}: ${String(body.text).trim()}`, `note:${lastInsertRowid}`);
  } },
  { method: "POST", pattern: /^\/api\/notes\/(\d+)\/ack$/, handle: ({ m }) => {
    db.query("UPDATE notes SET acked_at = ? WHERE id = ?").run(Date.now(), Number(m[1]));
  } },
];
export default routes;
