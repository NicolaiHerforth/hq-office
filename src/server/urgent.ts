// Urgent: a flag on any ask, whoever it is for. An urgent item sorts first on its recipient's list; for an
// orchestrator it also types one line into that recipient's pane, and for the owner it marks the desk. Every use is
// a row in urgent_uses, which is what `hud urgent` reports.
import { db } from "./db.ts";
import { event } from "./events.ts";
import { agentWhere, promptAgent } from "./herdr.ts";
import { notifyHq } from "./hq-link.ts";
import type { Ask } from "./types.ts";

// The first line of an ask's words: what the pane line and the lists show.
export const firstLine = (text: string) => text.trim().split("\n")[0].trim().slice(0, 200);

// Records one urgent use of an ask and, for an orchestrator, types the line into its pane. A recipient that is a pane
// key ("machine pane", from the registry) has no agent name to type to; it still gets the sort.
export function recordUrgent(ask: Ask, by: string, now = Date.now(), type = true) {
  db.query("INSERT INTO urgent_uses (ask_id, by, at) VALUES (?, ?, ?)").run(ask.id, by, now);
  event(by, `urgent #${ask.id} for ${ask.recipient}: ${ask.title.slice(0, 120)}`, ask.lane);
  if (!type || ask.recipient === "owner" || /\s/.test(ask.recipient)) return;
  const line = `URGENT from ${ask.lane ?? by}: ${firstLine(ask.title)}`;
  // HQ's line goes through the outbox, which holds it while HQ is not receiving; another recipient is typed at once.
  if (ask.recipient === "HQ") return notifyHq(line, `ask:${ask.id}`);
  promptAgent(ask.recipient, line, agentWhere(ask.recipient)?.machine).then((r) => {
    if (!r.ok) event("hud", `could not reach ${ask.recipient}: ${r.error}`);
  });
}

// Pushes an open ask to the top of its list. Asking twice records the use twice but types the line once.
export function pushUrgent(id: number, by: string, now = Date.now()) {
  const ask = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Ask | null;
  if (!ask) throw new Error(`no ask ${id}`);
  if (ask.status !== "open") throw new Error(`ask ${id} is already ${ask.status}`);
  db.query("UPDATE asks SET urgent_at = COALESCE(urgent_at, ?) WHERE id = ?").run(now, id);
  recordUrgent(ask, by, now, ask.urgent_at === null);
}

const UNITS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86_400_000 };
export function sinceMs(text: string) {
  const m = text.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error("since must look like 90m, 24h or 7d");
  return Number(m[1]) * UNITS[m[2]];
}

// Urgent uses in the window, by who and by recipient.
export function urgentReport(window: number, now = Date.now()) {
  return db
    .query("SELECT u.by AS by, a.recipient AS recipient, COUNT(*) AS n FROM urgent_uses u JOIN asks a ON a.id = u.ask_id WHERE u.at >= ? GROUP BY u.by, a.recipient ORDER BY n DESC, u.by, a.recipient")
    .all(now - window) as { by: string; recipient: string; n: number }[];
}
