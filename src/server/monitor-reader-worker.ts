// THE MONITOR's reader (monitor-reader.ts says why): a worker thread with a connection of its own to monitor.db that
// makes every part of the page's data, so the server's thread never waits on SQLite for it. One question at a time,
// in the order asked; each part is kept for as long as it can go without changing much, so the same part asked
// twice while it was being made is made once.
import { Database } from "bun:sqlite";
import { growers } from "./monitor-disk.ts";
import { marks } from "./monitor-history.ts";
import { assignSlots, days, events, incidents, moment, now, patterns, range, type RangeKey } from "./monitor-page.ts";
import { TIMELINE, type Ask, type Setup } from "./monitor-reader.ts";

declare const self: Worker;

const HOUR_MS = 3_600_000;
// How long each part is kept: the hour moves with every tick, the 90 days with every quarter of an hour.
const RANGES: Record<RangeKey, number> = { hour: 10_000, day: 60_000, week: 5 * 60_000, quarter: 15 * 60_000 };
const rangeKey = (key: unknown): RangeKey => (typeof key === "string" && Object.hasOwn(RANGES, key) ? (key as RangeKey) : "hour");
// This machine's zone: minutes east of UTC at a time, by the clocks as they stood then.
const zone = (t: number) => -new Date(t).getTimezoneOffset();

let db: Database;
let setup: Setup;
// A recording to replay holds its newest sample as now; the live database goes by the clock.
const at = () => setup.at ?? Date.now();

// An answer that is made anew takes the ones that have run out with it, so a part that is asked for in many ways (the
// hours of a timeline) does not pile up.
const kept = new Map<string, { until: number; value: unknown }>();
function keep<T>(key: string, ms: number, make: () => T): T {
  const hit = kept.get(key);
  if (hit && Date.now() < hit.until) return hit.value as T;
  for (const [old, { until }] of kept) if (Date.now() >= until) kept.delete(old);
  const value = make();
  kept.set(key, { until: Date.now() + ms, value });
  return value;
}

const timeline = <T>(what: string, hours: number, read: (db: Database, q: { from: number; to: number }) => T) =>
  keep(`${TIMELINE}${what}:${hours}`, 60_000, () => read(db, { from: at() - hours * HOUR_MS, to: at() + 1000 }));

const PARTS: Record<string, (args: Record<string, unknown>) => unknown> = {
  now: (a) => keep("now", 2_000, () => now(db, { now: at(), name: setup.name, size: a.size as { bytes: number; limit: number } })) ?? { on: true, waiting: true },
  range: (a) => keep(`range:${rangeKey(a.key)}`, RANGES[rangeKey(a.key)], () => range(db, { now: at(), key: rangeKey(a.key) })),
  // Who held what at a past moment: the holders are the range's, so a holder keeps its colour and its name.
  moment: (a) => {
    const key = rangeKey(a.key);
    const { holders } = PARTS.range({ key }) as ReturnType<typeof range>;
    return moment(db, { now: at(), key, t: Number(a.t) || at(), holders });
  },
  days: () => keep("days", 5 * 60_000, () => days(db, { now: at(), zone })),
  incidents: () => keep("incidents", 60_000, () => incidents(db, { now: at() })),
  patterns: () => keep("patterns", 15 * 60_000, () => patterns(db, { now: at(), zone })),
  events: (a) => timeline("events", a.hours as number, events),
  marks: (a) => timeline("marks", a.hours as number, marks),
  growers: () => keep("growers", 5 * 60_000, () => growers(db, { now: at() })),
  // The colour slots: the one thing the page's side writes.
  slots: () => void assignSlots(db, { now: at() }),
  // What a new mark makes out of date.
  forget: (a) => {
    for (const key of kept.keys()) if (key.startsWith(a.prefix as string)) kept.delete(key);
  },
};

self.onmessage = (e: MessageEvent<Setup | Ask>) => {
  if (!("id" in e.data)) {
    setup = e.data;
    db = new Database(setup.path);
    // The monitor's own tick writes to the same file from the server's thread, and a slot write here waits for it.
    db.exec("PRAGMA busy_timeout = 5000");
    return;
  }
  const { id, part, args } = e.data;
  try {
    const make = PARTS[part];
    if (!make) throw new Error(`no part ${part}`);
    self.postMessage({ id, value: make(args) });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
