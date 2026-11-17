// THE MONITOR's verdict on now by itself, for whoever else speaks of this machine: MACHINES in the HUD's top bar
// takes its word for the local machine from here (routes/monitor.ts puts it in the state as S.monitor), so the top
// bar and the monitor's page cannot disagree. The state and the limit are the ones now() gives (monitor-page.ts).
import type { Database } from "bun:sqlite";
import { TICK_S } from "./monitor-history.ts";
import type { LimitKind } from "./monitor-limits.ts";
import { lastMinute } from "./monitor-page.ts";
import { LIMIT, STATE_WORDS } from "./monitor-words.ts";

// A monitor whose newest tick is older than this many ticks has stopped, and says nothing about now.
const STALE_TICKS = 3.5;

// said is the state in the page's own words, with what limits the machine: "Capped by memory".
export type Standing = { state: 0 | 1 | 2; limiter: LimitKind | null; said: string };

// null before the first tick and when the newest one is stale: MACHINES then goes by its own readings.
export function standing(db: Database, q: { now: number }): Standing | null {
  const last = lastMinute(db, Math.ceil(q.now / 1000));
  if (!last || q.now - last.newest.t * 1000 > STALE_TICKS * TICK_S * 1000) return null;
  const { state, limiter } = last;
  return { state, limiter, said: state && limiter ? `${STATE_WORDS[state]} by ${LIMIT[limiter]}` : STATE_WORDS[state] };
}
