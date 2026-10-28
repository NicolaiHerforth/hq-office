// The daily bank: points lost to waiting asks, won by quick answers.
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { waitedMinutes } from "./waited.ts";

function startOfDay(now: number) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// The game: a daily bank of 1000. Every minute an ask waits past a
// 5-minute grace costs one point; an answer inside 10 minutes earns 20.
// A deferred ask does not wait: the owner chose when it comes back.
export function score(now: number) {
  const asks = db
    .query("SELECT id, created_at, answered_at, status FROM asks WHERE recipient = 'owner' AND status != 'withdrawn' AND (created_at >= ? OR status = 'open' OR answered_at >= ?)")
    .all(startOfDay(now), startOfDay(now)) as Ask[];
  const defers = db.query("SELECT from_at, to_at FROM ask_defers WHERE ask_id = ?");
  const deferredNow = db.query("SELECT 1 FROM ask_defers WHERE ask_id = ? AND to_at > ?");
  let lost = 0;
  let bonus = 0;
  let fast = 0;
  for (const a of asks) {
    const from = Math.max(a.created_at, startOfDay(now));
    const to = a.answered_at ?? now;
    lost += Math.max(0, waitedMinutes(from, to, defers.all(a.id) as { from_at: number; to_at: number }[]) - 5);
    if (a.answered_at && a.answered_at - a.created_at <= 10 * 60_000) {
      bonus += 20;
      fast++;
    }
  }
  const open = asks.filter((a) => a.status === "open" && !deferredNow.get(a.id, now)).length;
  return { bank: 1000 - lost + bonus, lost, bonus, fast, burnPerMin: open };
}
