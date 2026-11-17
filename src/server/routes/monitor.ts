// Routes for THE MONITOR, and where it starts. The router loads every file in this folder; see src/server/router.ts.
// It runs on macOS, and only where HUD_MONITOR=1 asks for it: the plugin asks for the server it starts and for its
// service (bin/hud-plugin.ts), and a server that a test, a script or a lane starts samples nothing unless it says so.
// Nothing here may throw while the file loads, whatever state the monitor's database is in: the router loads this
// file with the server, so an error here would take the question panel down with the monitor.
// HUD_MONITOR_HERDR names the herdr the monitor reads its panes from, when that is not the server's own: a server
// that is tried out against a stub herdr can still see the real panes, which the monitor only ever reads.
// HUD_MONITOR_DISK=0 leaves the disk growers unread (monitor-disk.ts): a server that is only tried out walks no folder.
// HUD_MONITOR_REPLAY names a folder whose monitor.db is shown as if its newest sample were now: nothing is sampled,
// no process table and no herdr is read, and the page looks the same on every run (scripts/monitor-fixture.ts
// writes such a database).
import type { Database } from "bun:sqlite";
import { DATA, DIR, HERDR, LOCAL } from "../config.ts";
import { json } from "../json.ts";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createMonitor } from "../monitor.ts";
import { localLists } from "../herdr.ts";
import { growers } from "../monitor-disk.ts";
import { machineReading } from "../monitor-machine.ts";
import { setLocalReader } from "../machines.ts";
import { marks } from "../monitor-history.ts";
import { assignSlots, days, events, incidents, moment, now, patterns, range, type RangeKey } from "../monitor-page.ts";
import { standing } from "../monitor-standing.ts";
import { openStore } from "../monitor-store.ts";
import { bump, secrets } from "../push.ts";
import type { Route } from "../router.ts";
import { addStatePart } from "../state.ts";

const mask = (text: string) => secrets.mask(text);
const REPLAY = process.env.HUD_MONITOR_REPLAY;
let ticked = () => {};
// Why there is nothing to read though something was asked for: a database that could not be opened, in words the
// page shows as they are. null when all is well, and when the monitor is simply off.
let failed: string | null = null;
function opened<T>(what: string, open: () => T): T | null {
  try {
    return open();
  } catch (e) {
    failed = `${what} could not be opened (${(e as Error).message}), so the monitor is off and there is nothing to draw. The rest of HQ Office runs as usual. The server tries again when it next starts.`;
    console.error(`monitor: ${failed}`);
    return null;
  }
}
const monitor =
  !REPLAY && process.platform === "darwin" && process.env.HUD_MONITOR === "1"
    ? opened("The monitor's database, monitor.db in the data folder,", () =>
        createMonitor({
          dir: DATA,
          herdr: process.env.HUD_MONITOR_HERDR ?? HERDR,
          mask,
          disk: process.env.HUD_MONITOR_DISK === "0" ? undefined : { home: homedir() },
          ticked: () => ticked(),
          // The panes and agents the server's own sync has, unless the monitor reads another herdr than the server.
          lists: (process.env.HUD_MONITOR_HERDR ?? HERDR) === HERDR ? localLists : undefined,
        }),
      )
    : null;
if (monitor?.setAside) console.error(`monitor: monitor.db could not be read and was set aside as ${monitor.setAside}; recording began anew`);
monitor?.start();

// MACHINES takes this machine's reading from the monitor while it runs, instead of starting machine-stats.sh every
// minute for what the newest tick already has, and the temp folders' size from the monitor's daily reading instead
// of walking them every ten minutes (monitor-machine.ts). A reading of the temp folders counts for two days: after
// that the walks are failing, and MACHINES walks them itself as on a machine without a monitor.
const TEMP = "Temp folders", TEMP_FRESH_MS = 2 * 86_400_000;
if (monitor) {
  const walks = process.env.HUD_MONITOR_DISK !== "0";
  setLocalReader(() => {
    let tempGb: number | undefined;
    try {
      const temp = walks ? growers(monitor.store.db, { now: Date.now() }).find((g) => g.name === TEMP) : undefined;
      if (temp && Date.now() - temp.at <= TEMP_FRESH_MS) tempGb = Math.round((temp.kb / 1048576) * 100) / 100;
    } catch {}
    return { stats: machineReading(monitor.last(), Date.now()), tempGb };
  });
}

// What the page's routes read: a database, the time that counts as now, and the database's size.
type Recorded = { db: Database; now: () => number; size: () => { bytes: number; limit: number } };

// A recorded database with its newest sample as now. Opening it adds a table this version has and the recording
// lacks; after that the colour slots are the one thing written to it.
function replayOf(folder: string): Recorded {
  const store = openStore(join(folder, "monitor.db"));
  const newest = (store.db.query("SELECT MAX(t) AS t FROM host_raw").get() as { t: number | null }).t;
  const at = newest === null ? Date.now() : newest * 1000;
  assignSlots(store.db, { now: at });
  return { db: store.db, now: () => at, size: store.size };
}
const recorded: Recorded | null = REPLAY ? opened("The recording to replay, monitor.db in the folder HUD_MONITOR_REPLAY names,", () => replayOf(REPLAY)) : monitor ? { db: monitor.store.db, now: Date.now, size: () => monitor.store.size() } : null;
// What a route says when there is nothing to read: that the monitor is off, and why when it should have been on.
const off = () => (failed ? { on: false, failed } : { on: false });

// S.monitor: what the monitor says of this machine now. MACHINES in the HUD's top bar takes its word for the local
// machine from it, so the top bar and the monitor's page cannot disagree. It is in the state only while there is
// something to read it from: with the monitor off the top bar goes by its own readings, as it did before. The page
// hears of a change with the tick that brought it, and not a minute later with MACHINES' next sample.
if (recorded) {
  // Every page of the HUD loads the state. A database that can no longer be read says nothing there, as a monitor
  // that has stopped does, and costs the HUD nothing else.
  const said = () => {
    try {
      const now = standing(recorded.db, { now: recorded.now() });
      return now && { machine: LOCAL, state: now.state, said: now.said };
    } catch {
      return null;
    }
  };
  addStatePart("monitor", said);
  let last = JSON.stringify(said());
  ticked = () => {
    const now = JSON.stringify(said());
    if (now !== last) bump();
    last = now;
  };
}

const HOUR_MS = 3_600_000;

// What the page asks for (monitor-page.ts), each part kept for as long as it can go without changing much: the hour
// moves with every tick, the 90 days with every quarter of an hour. The long ranges read millions of rows, and the
// page asks again every few seconds. An answer that is made anew takes the ones that have run out with it, so a
// part that is asked for in many ways (the hours of a timeline) does not pile up.
const RANGES: Record<RangeKey, number> = { hour: 10_000, day: 60_000, week: 5 * 60_000, quarter: 15 * 60_000 };
const kept = new Map<string, { until: number; value: unknown }>();
function keep<T>(key: string, ms: number, make: () => T): T {
  const hit = kept.get(key);
  if (hit && Date.now() < hit.until) return hit.value as T;
  for (const [old, { until }] of kept) if (Date.now() >= until) kept.delete(old);
  const value = make();
  kept.set(key, { until: Date.now() + ms, value });
  return value;
}
// The machine's name in the page's sentences: its own, as it calls itself.
const NAME = hostname().split(".")[0].replace(/^./, (c) => c.toUpperCase());
// This machine's zone: minutes east of UTC at a time, by the clocks as they stood then.
const zone = (t: number) => -new Date(t).getTimezoneOffset();
const rangeKey = (url: URL) => (Object.keys(RANGES).includes(url.searchParams.get("key") ?? "") ? (url.searchParams.get("key") as RangeKey) : "hour");

// The colour slots follow who mattered over the last week, so they are looked at again every quarter of an hour:
// at the start, for a database that has a history already, and a few ticks in, for one that had none.
const SLOTS_MS = 15 * 60_000;
if (monitor) {
  const slots = () => {
    try {
      assignSlots(monitor.store.db, { now: Date.now() });
    } catch {}
  };
  slots();
  setTimeout(slots, 15_000);
  setInterval(slots, SLOTS_MS);
}
// A part of the page's data, or that the monitor is off when there is nothing to read it from.
const page = (make: (from: Recorded, url: URL) => unknown) => ({ url }: { url: URL }) => json(recorded ? make(recorded, url) : off());
// The timeline of the last hours, whole ones: 24 unless ?hours= says otherwise, 90 days at most, oldest first. Kept a
// minute per number of hours, since the page asks for a week of it every minute and reading that takes a tenth of
// a second. It changes with a minute's rollup, and with a mark, which drops what is kept.
const MOST_HOURS = 90 * 24;
const TIMELINE = "timeline:";
const hours = (url: URL) => Math.min(Math.max(Math.ceil(Number(url.searchParams.get("hours") ?? 24)) || 24, 1), MOST_HOURS);
const timeline = <T>(what: string, read: (db: Database, q: { from: number; to: number }) => T) => (r: Recorded, url: URL) => {
  const back = hours(url);
  return keep(`${TIMELINE}${what}:${back}`, 60_000, () => read(r.db, { from: r.now() - back * HOUR_MS, to: r.now() + 1000 }));
};
const marked = timeline("marks", marks);

// The monitor's page is one file that asks the routes below for its data. What it may load is said here and not
// left to the file: itself, and its two fonts.
const PAGE = join(DIR, "public", "monitor.html");
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const routes: Route[] = [
  // Served with the monitor off too: the page then says that it is off.
  { method: "GET", path: "/monitor", handle: () => new Response(Bun.file(PAGE), { headers: PAGE_HEADERS }) },
  // The sampler's own newest tick. A replay has no sampler.
  // setAside names the file a database that could not be read was moved to when this server started.
  { method: "GET", path: "/api/monitor/now", handle: () => json(monitor ? { on: true, failed: monitor.failed(), setAside: monitor.setAside, size: monitor.store.size(), ...monitor.last() } : off()) },
  { method: "GET", path: "/api/monitor/page/now", handle: page((r) => keep("now", 2_000, () => now(r.db, { now: r.now(), name: NAME, size: r.size() })) ?? { on: true, waiting: true }) },
  { method: "GET", path: "/api/monitor/page/range", handle: page((r, url) => keep(`range:${rangeKey(url)}`, RANGES[rangeKey(url)], () => range(r.db, { now: r.now(), key: rangeKey(url) }))) },
  // Who held what at ?t= in the range ?key=: what the page asks when a holder is opened at a past moment.
  {
    method: "GET",
    path: "/api/monitor/page/moment",
    handle: page((r, url) => {
      const key = rangeKey(url);
      const holders = keep(`range:${key}`, RANGES[key], () => range(r.db, { now: r.now(), key })).holders;
      return moment(r.db, { now: r.now(), key, t: Number(url.searchParams.get("t")) || r.now(), holders });
    }),
  },
  { method: "GET", path: "/api/monitor/page/days", handle: page((r) => keep("days", 5 * 60_000, () => days(r.db, { now: r.now(), zone }))) },
  { method: "GET", path: "/api/monitor/page/incidents", handle: page((r) => keep("incidents", 60_000, () => incidents(r.db, { now: r.now() }))) },
  { method: "GET", path: "/api/monitor/page/patterns", handle: page((r) => keep("patterns", 15 * 60_000, () => patterns(r.db, { now: r.now(), zone }))) },
  { method: "GET", path: "/api/monitor/page/events", handle: page(timeline("events", events)) },
  // What takes the most room on the disk (monitor-disk.ts), largest first. Empty until something has been read.
  { method: "GET", path: "/api/monitor/page/growers", handle: page((r) => keep("growers", 5 * 60_000, () => growers(r.db, { now: r.now() }))) },
  // The same timeline as plain marks, for a script. An empty list when there is nothing to read it from.
  { method: "GET", path: "/api/monitor/marks", handle: ({ url }) => json(recorded ? marked(recorded, url) : []) },
  // A mark on the timeline: { text, kind? }. `hud monitor mark` posts it. With the monitor off, or a replay on, it
  // is not kept, and that is no error: whoever marks a test run must not fail because of it.
  {
    method: "POST",
    path: "/api/monitor/marks",
    handle: ({ body }) => {
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!monitor || !text) return { ok: true, kept: false };
      monitor.store.mark(Date.now(), typeof body.kind === "string" ? body.kind : undefined, mask(text));
      for (const key of kept.keys()) if (key.startsWith(TIMELINE)) kept.delete(key);
      return { ok: true, kept: true };
    },
  },
];
export default routes;
