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
import { homedir } from "node:os";
import { join } from "node:path";
import { createMonitor } from "../monitor.ts";
import { localLists } from "../herdr.ts";
import { growers } from "../monitor-disk.ts";
import { machineReading } from "../monitor-machine.ts";
import { setLocalReader } from "../machines.ts";
import type { RangeKey } from "../monitor-page.ts";
import { createReader, type Reader } from "../monitor-reader.ts";
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

// What the routes read: a database, the time that counts as now, and the database's size, on the server's thread for
// what is small (the newest minute, for the state); and the reader, a worker thread with its own connection, for
// every part of the page (monitor-reader.ts says why).
type Recorded = { db: Database; now: () => number; size: () => { bytes: number; limit: number }; reader: Reader };

// A recorded database with its newest sample as now. Opening it adds a table this version has and the recording
// lacks; after that the colour slots are the one thing written to it.
function replayOf(folder: string): Recorded {
  const path = join(folder, "monitor.db");
  const store = openStore(path);
  const newest = (store.db.query("SELECT MAX(t) AS t FROM host_raw").get() as { t: number | null }).t;
  const at = newest === null ? Date.now() : newest * 1000;
  const reader = createReader({ path, at });
  reader.slots().catch(() => {});
  return { db: store.db, now: () => at, size: store.size, reader };
}
const recorded: Recorded | null = REPLAY
  ? opened("The recording to replay, monitor.db in the folder HUD_MONITOR_REPLAY names,", () => replayOf(REPLAY))
  : monitor
    ? { db: monitor.store.db, now: Date.now, size: () => monitor.store.size(), reader: createReader({ path: join(DATA, "monitor.db"), at: null }) }
    : null;
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

// What the page asks for is kept in the reader for as long as each part can go without changing much
// (monitor-reader-worker.ts); the key is checked there too.
const rangeKey = (url: URL) => (url.searchParams.get("key") ?? "hour") as RangeKey;

// The colour slots follow who mattered over the last week, so they are looked at again every quarter of an hour:
// at the start, for a database that has a history already, and a few ticks in, for one that had none.
const SLOTS_MS = 15 * 60_000;
if (monitor && recorded) {
  const slots = () => void recorded.reader.slots().catch(() => {});
  slots();
  setTimeout(slots, 15_000);
  setInterval(slots, SLOTS_MS);
}
// A part of the page's data, made by the reader, or that the monitor is off when there is nothing to read it from.
const page = (make: (from: Recorded, url: URL) => Promise<unknown>) => async ({ url }: { url: URL }) => json(recorded ? await make(recorded, url) : off());
// The timeline of the last hours, whole ones: 24 unless ?hours= says otherwise, 90 days at most, oldest first. Kept a
// minute per number of hours; it changes with a minute's rollup, and with a mark, which drops what is kept.
const MOST_HOURS = 90 * 24;
const hours = (url: URL) => Math.min(Math.max(Math.ceil(Number(url.searchParams.get("hours") ?? 24)) || 24, 1), MOST_HOURS);

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
  { method: "GET", path: "/api/monitor/page/now", handle: page((r) => r.reader.now(r.size())) },
  { method: "GET", path: "/api/monitor/page/range", handle: page((r, url) => r.reader.range(rangeKey(url))) },
  // Who held what at ?t= in the range ?key=: what the page asks when a holder is opened at a past moment.
  { method: "GET", path: "/api/monitor/page/moment", handle: page((r, url) => r.reader.moment(rangeKey(url), Number(url.searchParams.get("t")))) },
  { method: "GET", path: "/api/monitor/page/days", handle: page((r) => r.reader.days()) },
  { method: "GET", path: "/api/monitor/page/incidents", handle: page((r) => r.reader.incidents()) },
  { method: "GET", path: "/api/monitor/page/patterns", handle: page((r) => r.reader.patterns()) },
  { method: "GET", path: "/api/monitor/page/events", handle: page((r, url) => r.reader.events(hours(url))) },
  // What takes the most room on the disk (monitor-disk.ts), largest first. Empty until something has been read.
  { method: "GET", path: "/api/monitor/page/growers", handle: page((r) => r.reader.growers()) },
  // The same timeline as plain marks, for a script. An empty list when there is nothing to read it from.
  { method: "GET", path: "/api/monitor/marks", handle: async ({ url }) => json(recorded ? await recorded.reader.marks(hours(url)) : []) },
  // A mark on the timeline: { text, kind? }. `hud monitor mark` posts it. With the monitor off, or a replay on, it
  // is not kept, and that is no error: whoever marks a test run must not fail because of it.
  {
    method: "POST",
    path: "/api/monitor/marks",
    handle: ({ body }) => {
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!monitor || !text) return { ok: true, kept: false };
      monitor.store.mark(Date.now(), typeof body.kind === "string" ? body.kind : undefined, mask(text));
      recorded?.reader.marked();
      return { ok: true, kept: true };
    },
  },
];
export default routes;
