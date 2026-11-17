// THE MONITOR's disk growers: the sizes of the few folders that fill a disk over weeks, read rarely because
// reading them is costly, and kept as long as the longest rollup, so the page can say what grew and by how much. A
// folder's size is a walk of all its files. No folder that macOS guards with a consent prompt is read in any way.
// docs/monitor.md has the costs.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store } from "./monitor-store.ts";

const DAY_MS = 86_400_000;
// A walk of the large folders costs about a minute of CPU: once a day that is 0.07% of one core, beside the ticks'
// 0.35% and under the limit of 0.5%. Once an hour it would be 1.7%.
const EVERY_MS = DAY_MS;
// No walk in a process's first ten minutes: a server that restarts in a loop never gets to walk the disk.
const FIRST_WALK_MS = 10 * 60_000;
const WALK_LIMIT_MS = 5 * 60_000;
const GROWTH_DAYS = 30;

// The user's own temp folder, which only the system can name.
export const USER_TEMP = "(user temp)";
// A path that starts with ~/ is in the home folder.
const place = (path: string, home: string) => (path.startsWith("~/") ? join(home, path.slice(2)) : path);
// The growers are read in the table's order, each the sum of its folders that exist.
export type Grower = { name: string; folders: string[] };
export const GROWERS: Grower[] = [
  { name: "Temp folders", folders: ["/private/tmp", USER_TEMP] },
  { name: "~/Library/Caches", folders: ["~/Library/Caches"] },
  { name: "~/.cache", folders: ["~/.cache"] },
  { name: "Package caches", folders: ["~/.bun/install/cache", "~/.npm"] },
  { name: "Xcode DerivedData", folders: ["~/Library/Developer/Xcode/DerivedData"] },
];

// The places macOS asks the user about before a program may read them. A server started by launchd that touched one
// could put that question on the owner's screen.
const GUARDED = [
  "~/Library/Containers", "~/Library/Group Containers", "~/Library/Mail", "~/Library/Messages", "~/Library/Safari", "~/Library/Calendars", "~/Library/Reminders",
  "~/Library/Application Support/AddressBook", "~/Pictures", "~/Desktop", "~/Documents", "~/Downloads", "~/Movies", "~/Music", "/Volumes",
];
// A path as the guard compares it, without case: the disks of macOS do not tell "Library" from "library".
const plain = (path: string, home: string) => resolve(place(path, home)).toLowerCase();
// Only the root still ends in a slash.
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
// A folder that is a guarded place, lies inside one or holds one: a walk of it would read a guarded place. Asked of
// the path alone, since looking at the folder would be a reading too.
export function guarded(folder: string, home: string) {
  const path = plain(folder, home);
  return GUARDED.map((spot) => plain(spot, home)).some((spot) => inside(path, spot) || inside(spot, path));
}

// Starts a program and waits for it. code is null when it was stopped, by the limit or by the signal.
export type Spawn = (cmd: string[], opts: { limitMs: number; signal: AbortSignal }) => Promise<{ code: number | null; out: string; cpuMs: number }>;
export const run: Spawn = async (cmd, { limitMs, signal }) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: limitMs, signal });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.signalCode ? null : proc.exitCode, out, cpuMs: Number(proc.resourceUsage()?.cpuTime.total ?? 0) / 1000 };
};

export function createDisk(opts: { store: Store; now?: () => number; home: string; spawn?: Spawn; growers?: Grower[] }) {
  const { store, home } = opts;
  const now = opts.now ?? Date.now;
  const spawn = opts.spawn ?? run;
  const table = opts.growers ?? GROWERS;
  // When each grower's walk was last tried, from the store, so a restart does not repeat a walk that is less than a
  // day old, whether it gave a size or failed. A database from before the tries were kept has only the sizes'
  // times.
  const last = new Map<string, number>();
  for (const row of store.db.query("SELECT name, MAX(t) AS t FROM (SELECT name, t FROM grower_tries UNION ALL SELECT name, t FROM growers) GROUP BY name").all() as { name: string; t: number }[]) last.set(row.name, row.t * 1000);
  const walksFrom = now() + FIRST_WALK_MS;
  const stop = new AbortController();
  let userTemp: string | null = null;
  let reading = false;

  const dueNow = () => (now() >= walksFrom ? table.filter(({ name }) => now() - (last.get(name) ?? -Infinity) >= EVERY_MS) : []);

  async function walk(grower: Grower) {
    let cpuMs = 0;
    if (grower.folders.includes(USER_TEMP) && !userTemp) {
      const asked = await spawn(["getconf", "DARWIN_USER_TEMP_DIR"], { limitMs: 5000, signal: stop.signal });
      cpuMs += asked.cpuMs;
      if (asked.code === 0) userTemp = asked.out.trim() || null;
    }
    const folders = grower.folders
      .map((folder) => (folder === USER_TEMP ? userTemp : place(folder, home)))
      .filter((folder): folder is string => !!folder && !guarded(folder, home) && existsSync(folder));
    if (!folders.length) return { kb: null, cpuMs };
    const walked = await spawn(["nice", "-n", "19", "du", "-sk", ...folders], { limitMs: WALK_LIMIT_MS, signal: stop.signal });
    cpuMs += walked.cpuMs;
    const sizes = walked.out.split("\n").flatMap((line) => line.match(/^(\d+)\t/)?.[1] ?? []).map(Number);
    // du's exit code is not asked: it is 1 whenever a folder inside could not be opened, and du still prints the
    // size of all the rest. A du that was stopped, or has no line for a folder it was given, counts for nothing.
    const whole = walked.code !== null && sizes.length === folders.length;
    return { kb: whole ? sizes.reduce((sum, kb) => sum + kb, 0) : null, cpuMs };
  }

  return {
    // Something is due, and no reading is under way: one walk at a time.
    due: () => !reading && !stop.signal.aborted && dueNow().length > 0,
    // Reads what is due, one after another, and gives the CPU milliseconds its child processes used. A reading that
    // was stopped or failed writes nothing: no size is better than a wrong one.
    async read() {
      if (reading || stop.signal.aborted) return 0;
      reading = true;
      let cpuMs = 0;
      for (const grower of dueNow()) {
        // Stopped: nothing more is started, and the store may be closed.
        if (stop.signal.aborted) break;
        last.set(grower.name, now());
        try {
          // Written before the walk, so one that a restart cuts short counts as tried.
          store.tried(now(), grower.name);
          const size = await walk(grower);
          cpuMs += size.cpuMs;
          if (size.kb !== null && !stop.signal.aborted) store.grower(now(), grower.name, size.kb);
        } catch {}
      }
      reading = false;
      return cpuMs;
    },
    // Ends a walk under way and writes nothing more: the store may be closed after this.
    stop: () => stop.abort(),
  };
}

export type Grown = { name: string; kb: number; at: number; grewKb: number | null; overDays: number | null };

// For the page: each grower's newest size, and how much it grew since the reading nearest to 30 days before now,
// which is its oldest reading while there are fewer days. overDays is the time between the two readings, to a tenth
// of a day. Largest first. Only the growers of the table as it is now: the sizes of one that an earlier version
// read and this one does not stay in the database for 90 days, and are nothing the page should list.
export function growers(db: Database, { now, table = GROWERS }: { now: number; table?: Grower[] }): Grown[] {
  const named = table.map((grower) => grower.name);
  const newest = db
    .query(`SELECT name, t, kb FROM growers g WHERE name IN (${named.map(() => "?").join(", ")}) AND t = (SELECT MAX(t) FROM growers WHERE name = g.name) ORDER BY kb DESC, name`)
    .all(...named) as { name: string; t: number; kb: number }[];
  const before = db.query("SELECT t, kb FROM growers WHERE name = ?1 AND t < ?2 ORDER BY ABS(t - ?3), t LIMIT 1");
  return newest.map(({ name, t, kb }) => {
    const then = before.get(name, t, Math.round((now - GROWTH_DAYS * DAY_MS) / 1000)) as { t: number; kb: number } | null;
    return { name, kb, at: t * 1000, grewKb: then ? kb - then.kb : null, overDays: then ? Math.round(((t - then.t) * 10_000) / DAY_MS) / 10 : null };
  });
}
