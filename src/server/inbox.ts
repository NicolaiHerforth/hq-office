// HQ's inbox: answers and notes it has not acked, and the long poll that waits for them. One floor's (the caller's),
// or every floor's with floor null.
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { listeners } from "./push.ts";

export function inbox(floor: string | null = null) {
  const on = floor ? " AND floor = ?" : "";
  const args = floor ? [floor] : [];
  return {
    answers: (db.query(`SELECT * FROM asks WHERE status IN ('answered', 'defaulted') AND acked_at IS NULL${on} ORDER BY answered_at`).all(...args) as Ask[]).map((a) => ({
      ...a,
      // What HQ reads: a default says so, and an answer after one says it changed.
      summary: a.status === "defaulted" ? `#${a.id} defaulted to "${a.answer}"` : a.defaulted_at ? `#${a.id} answered after the default: ${a.answer}` : undefined,
      options: a.options ? JSON.parse(a.options) : [],
      secrets: a.secrets ? JSON.parse(a.secrets) : [],
    })),
    notes: db.query(`SELECT * FROM notes WHERE acked_at IS NULL${on} ORDER BY at`).all(...args),
  };
}

export async function waitForInbox(timeoutMs: number, floor: string | null = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const box = inbox(floor);
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
  return inbox(floor);
}
