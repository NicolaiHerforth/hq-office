// HQ's inbox: answers and notes it has not acked, and the long poll that waits for them. One floor's (the caller's),
// or every floor's with floor null.
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { listeners } from "./push.ts";
import { askPageKey, hasAskPage } from "./ask-pages.ts";

export function inbox(floor: string | null = null) {
  const on = floor ? " AND floor = ?" : "";
  const args = floor ? [floor] : [];
  return {
    answers: (db.query(`SELECT * FROM asks WHERE status = 'answered' AND acked_at IS NULL${on} ORDER BY answered_at`).all(...args) as Ask[]).map((a) => ({
      ...a,
      options: a.options ? JSON.parse(a.options) : [],
      secrets: a.secrets ? JSON.parse(a.secrets) : [],
      // An answer to an ask with a page: what the owner did in the page is read with hud page data PAGE.
      ...(hasAskPage(a.id) ? { page: askPageKey(a.id) } : {}),
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
