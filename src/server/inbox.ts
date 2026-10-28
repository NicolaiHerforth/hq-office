// HQ's inbox: answers and notes it has not acked, and the long poll that waits for them.
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { listeners } from "./push.ts";

export function inbox() {
  return {
    answers: (db.query("SELECT * FROM asks WHERE status = 'answered' AND recipient = 'owner' AND acked_at IS NULL ORDER BY answered_at").all() as Ask[]).map((a) => ({
      ...a,
      options: a.options ? JSON.parse(a.options) : [],
      secrets: a.secrets ? JSON.parse(a.secrets) : [],
    })),
    notes: db.query("SELECT * FROM notes WHERE acked_at IS NULL ORDER BY at").all(),
  };
}

export async function waitForInbox(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = inbox();
    if (box.answers.length || box.notes.length) return box;
    await new Promise<void>((resolve) => {
      const done = () => {
        listeners.delete(done);
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(done, deadline - Date.now());
      listeners.add(done);
    });
  }
  return inbox();
}
