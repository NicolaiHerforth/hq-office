// THE MONITOR's page data: what the store recorded (monitor-store.ts), in the shape the monitor page reads. now is
// the newest tick, a range is one of the page's four spans of time as series, and days, incidents, patterns, events
// and moment are the history around them. Read-only queries on a database that is passed in, except assignSlots,
// and no clock, because the time comes with the question. Times out are epoch milliseconds, memory and disk GB, CPU
// cores. A null in a series is a gap. The sentences are made in monitor-words.ts.
import type { Database } from "bun:sqlite";
import { hash } from "../client/core/format.js";
import { BEFORE_RESTART_S, dayPeaks, episodes, mean, offenders, ranked, rowsWithOwner, TICK_S, timeline, verdict, verdicts, view, type Bucket, type Episode, type Piece } from "./monitor-history.ts";
import {
  CPU_CAPPED, CPU_TIGHT, cpuShare, diskLines, limits, spanOfTicks, SWAP_GROWTH_KB_PER_MIN, THERMAL_CAPPED, THERMAL_TIGHT, WARN_SHARE,
  type BucketRow, type Level, type LimitKind, type Span, type TickRow,
} from "./monitor-limits.ts";
import { RES } from "./monitor-store.ts";
import type { OwnerKind } from "./monitor-types.ts";
import * as words from "./monitor-words.ts";

const [MINUTES, QUARTERS] = RES;
const MINUTE_S = 60;
const MINUTE_MS = 60_000;
const HOUR_S = 3600;
const DAY_S = 86_400;
const DAY_MS = DAY_S * 1000;
const GB_KB = 1024 * 1024;
const MB_KB = 1024;
const HISTORY_DAYS = 90;
const PATTERN_DAYS = 14;
const SLOT_DAYS = 7;
// What an incident shows around it: the marks before it, how much each holder grew before its peak, its close-up.
const AROUND_MS = 30 * MINUTE_MS;
const INCIDENTS = 40;
const NAMED = 3;
// A lane or an app has a tile of its own from this much memory, or this share of all cores.
const TILE_KB = GB_KB / 2;
const TILE_CPU_SHARE = 0.02;
const SLOTS = 7;
// An owner keeps its colour while it is among this many largest.
const SLOT_KEPT = 14;
// Under these a holder or a part prints as nothing, 0.0 GB or 0.00 cores, so it is not listed.
const LEAST_GB = 0.05;
const LEAST_CORES = 0.01;
// How many holders a day's worst moment names.
const DAY_TOP = 3;

const seconds = (ms: number) => Math.ceil(ms / 1000);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const gb = (kb: number) => round(kb / GB_KB, 2);
const maybe = <T, R>(value: T | null, read: (value: T) => R): R | null => (value === null ? null : read(value));
const pressureOf = (available: number | null) => maybe(available, (a) => round(100 - a, 1));

export type HolderKind = "lane" | "app" | "hq" | "system";
// One tile of the page. name is what it goes by everywhere, in a tile and in a sentence. full is all of a pane's
// folder, given when the name is the short of it. slot is its colour, 1 to 7, or null for neutral.
export type Holder = { id: string; name: string; full?: string; kind: HolderKind; slot: number | null; group: boolean; note: string };
// A part that is a pane inside a group carries its full name the same way.
export type Part = { name: string; value: number; full?: string };
export type Held = { id: string; mem: number; cpu: number; memParts: Part[]; cpuParts: Part[] };
type Tile = Omit<Holder, "slot">;

const FIXED = {
  hq: { id: "hq", name: "HQ Office", kind: "hq", group: false, note: words.NOTES.hq },
  lanes: { id: "lanes", name: "Other lanes", kind: "lane", group: true, note: words.NOTES.lanes },
  apps: { id: "apps", name: "Other apps", kind: "app", group: true, note: words.NOTES.apps },
  system: { id: "system", name: "System", kind: "system", group: false, note: words.NOTES.system },
} satisfies Record<string, Tile>;

// How each kind of owner the monitor records appears on the page: always inside one fixed holder, or among the lanes
// or the apps, with a tile of its own when it is large enough. What a pane is called depends on the panes shown
// with it (words.paneNames), so a name is asked for with them.
type Named = { name: string; full?: string };
type Panes = Map<string, string>;
type Shown = { fixed: "hq" | "system" } | { among: "lanes" | "apps"; kind: HolderKind; named(owner: string, panes: Panes): Named; note: string };
const asRecorded = (owner: string): Named => ({ name: owner });
function paneNamed(owner: string, panes: Panes): Named {
  const [name, full] = [panes.get(owner) ?? words.paneLabel(owner), words.paneLabel(owner)];
  return name === full ? { name } : { name, full };
}
const SHOWN: Record<OwnerKind, Shown> = {
  lane: { among: "lanes", kind: "lane", named: (owner) => ({ name: words.laneLabel(owner) }), note: words.NOTES.lane },
  pane: { among: "lanes", kind: "lane", named: paneNamed, note: words.NOTES.pane },
  app: { among: "apps", kind: "app", named: asRecorded, note: words.NOTES.app },
  other: { among: "apps", kind: "app", named: (owner) => ({ name: words.unsortedLabel(owner) }), note: words.NOTES.other },
  hq: { fixed: "hq" },
  system: { fixed: "system" },
  lost: { fixed: "system" },
};

type Owned = { kind: OwnerKind; owner: string };
const ownerKey = (o: Owned) => `${o.kind}\0${o.owner}`;

// An owner's holder id: its kind and name when the name is safe in a URL as it is, else a readable cut of the name
// and a hash of all of it, so two names that cut to the same text stay two ids.
export function holderId(kind: OwnerKind, owner: string) {
  if (/^[A-Za-z0-9._-]+$/.test(owner)) return `${kind}:${owner}`;
  const cut = owner.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
  return `${kind}:${cut}~${hash(owner).toString(36)}`;
}

const earnsTile = (owner: Owned, memKb: number, cpu: number, allCores: number) => "among" in SHOWN[owner.kind] && (memKb >= TILE_KB || cpu >= TILE_CPU_SHARE * allCores);

const panesOf = (owners: Iterable<Owned>): Panes => words.paneNames([...owners].filter((o) => o.kind === "pane").map((o) => o.owner));

// The holder a row counts toward and the part of it the row is: a process group in an owner's own tile or in a
// fixed holder, the owner itself inside a group.
function place(row: Owned & { name: string }, own: boolean, panes: Panes): { tile: Tile; part: Named } {
  const shown = SHOWN[row.kind];
  if ("fixed" in shown) return { tile: FIXED[shown.fixed], part: { name: words.partName(row.name) } };
  const named = shown.named(row.owner, panes);
  if (!own) return { tile: FIXED[shown.among], part: named };
  return { tile: { id: holderId(row.kind, row.owner), ...named, kind: shown.kind, group: false, note: shown.note }, part: { name: words.partName(row.name) } };
}
const tileOf = (owner: Owned, own: boolean, panes: Panes) => place({ ...owner, name: "" }, own, panes).tile;

export type Slot = { slot: number; kind: OwnerKind; owner: string; since: number };

function readSlots(db: Database): Slot[] {
  return (db.query("SELECT slot, kind, owner, since FROM slots ORDER BY slot").all() as Slot[]).map((s) => ({ ...s, since: s.since * 1000 }));
}
const slotsById = (db: Database) => new Map(readSlots(db).map((s) => [holderId(s.kind, s.owner), s.slot]));

// The colours after a look at who is largest now. ranking is the lanes and apps, largest first. An owner keeps its
// slot while it is among the SLOT_KEPT largest; a free slot goes to the largest of the first SLOTS that has none.
export function nextSlots(current: Slot[], ranking: Owned[], at: number): Slot[] {
  const rank = new Map(ranking.map((owner, i) => [ownerKey(owner), i]));
  const kept = current.filter((s) => (rank.get(ownerKey(s)) ?? Infinity) < SLOT_KEPT);
  const wearing = new Set(kept.map(ownerKey));
  const free = Array.from({ length: SLOTS }, (_, i) => i + 1).filter((slot) => !kept.some((s) => s.slot === slot));
  const waiting = ranking.slice(0, SLOTS).filter((owner) => !wearing.has(ownerKey(owner)));
  const given = waiting.slice(0, free.length).map(({ kind, owner }, i): Slot => ({ slot: free[i], kind, owner, since: at }));
  return [...kept, ...given].sort((a, b) => a.slot - b.slot);
}

// Ranks the lanes and apps of the last seven days and writes who wears which colour. The one write in this file.
// Run twice at the same time it leaves the same table.
export function assignSlots(db: Database, q: { now: number }): Slot[] {
  const to = seconds(q.now);
  const rows = view(pieces(db, QUARTERS.res, to - SLOT_DAYS * DAY_S, to), "rows");
  const used = db
    .query(`SELECT s.kind, s.owner, SUM(r.cpu_ms) AS cpuMs, SUM(r.mem_avg_kb * r.samples) AS memSamples FROM ${rowsWithOwner(rows.sql)} GROUP BY s.kind, s.owner`)
    .all(...rows.args) as (Owned & { cpuMs: number; memSamples: number })[];
  const ranking = ranked(used.filter((u) => "among" in SHOWN[u.kind]), (u) => u.cpuMs, (u) => u.memSamples);
  const next = nextSlots(readSlots(db), ranking, q.now);
  db.transaction(() => {
    db.run("DELETE FROM slots");
    for (const s of next) db.query("INSERT INTO slots (slot, kind, owner, since) VALUES (?, ?, ?, ?)").run(s.slot, s.kind, s.owner, Math.round(s.since / 1000));
  })();
  return next;
}

// The tables to read a window from, each for the part only it holds: the rollup that fits the step as far as it is
// rolled up, then the minutes, then the ticks of the minute still running. Nothing is read twice. All in seconds.
function pieces(db: Database, step: number, from: number, to: number): Piece[] {
  const found: Piece[] = [];
  let at = from;
  for (const { res } of step >= QUARTERS.res ? [QUARTERS, MINUTES] : [MINUTES]) {
    const newest = (db.query("SELECT MAX(t) AS t FROM host_roll WHERE res = ?").get(res) as { t: number | null }).t;
    const end = Math.min(to, newest === null ? at : Math.max(at, newest + res));
    if (end > at) found.push({ res, from: at, to: end });
    at = end;
  }
  if (to > at) found.push({ res: TICK_S, from: at, to });
  return found;
}

// What each process group held and used over a stretch: memory in kB, averaged over the stretch's samples, and CPU
// in cores.
type Row = Owned & { name: string; memKb: number; cpu: number };
type Stretch = { cores: number; rows: Row[] };

function stretchOf(db: Database, read: Piece[]): Stretch | null {
  if (!read.length) return null;
  const host = view(read, "host");
  const { samples, coveredMs, cores } = db.query(`SELECT SUM(samples) AS samples, SUM(covered_ms) AS coveredMs, MAX(cores) AS cores FROM (${host.sql})`).get(...host.args) as { samples: number | null; coveredMs: number; cores: number };
  if (!samples) return null;
  const rows = view(read, "rows");
  const groups = db
    .query(`SELECT s.kind, s.owner, s.name, SUM(r.cpu_ms) AS cpuMs, SUM(r.mem_avg_kb * r.samples) AS memSamples FROM ${rowsWithOwner(rows.sql)} GROUP BY s.kind, s.owner, s.name`)
    .all(...rows.args) as (Owned & { name: string; cpuMs: number; memSamples: number })[];
  return { cores, rows: groups.map(({ cpuMs, memSamples, ...group }) => ({ ...group, memKb: memSamples / samples, cpu: coveredMs ? cpuMs / coveredMs : 0 })) };
}

// The owners of a stretch that have a tile of their own by the rule.
function large(stretch: Stretch): Set<string> {
  const totals = new Map<string, Owned & { memKb: number; cpu: number }>();
  for (const { kind, owner, memKb, cpu } of stretch.rows) {
    const total = totals.get(ownerKey({ kind, owner })) ?? { kind, owner, memKb: 0, cpu: 0 };
    totals.set(ownerKey(total), { ...total, memKb: total.memKb + memKb, cpu: total.cpu + cpu });
  }
  return new Set([...totals].filter(([, t]) => earnsTile(t, t.memKb, t.cpu, stretch.cores)).map(([key]) => key));
}

// Largest first, and none that prints as nothing. whole has the full name of the parts that have one.
const parts = (values: Map<string, number>, read: (value: number) => number, least: number, whole: Map<string, string>): Part[] =>
  [...values]
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]): Part => ({ name, value: read(value), ...(whole.has(name) ? { full: whole.get(name) } : {}) }))
    .filter((part) => part.value >= least);
const inCores = (cpu: number) => round(cpu, 2);

// A stretch as the page's holders, most memory first and then most CPU. own says which owners have a tile of
// their own. A holder that prints as nothing in memory and in CPU holds nothing: it keeps its tile and is not
// among held.
function holdersOf(stretch: Stretch, own: (owner: Owned) => boolean): { tiles: Tile[]; held: Held[] } {
  type Sums = { tile: Tile; memKb: number; cpu: number; mem: Map<string, number>; cpus: Map<string, number> };
  const byId = new Map<string, Sums>(Object.values(FIXED).map((tile) => [tile.id, { tile, memKb: 0, cpu: 0, mem: new Map(), cpus: new Map() }]));
  const panes = panesOf(stretch.rows);
  const whole = new Map<string, string>();
  for (const row of stretch.rows) {
    const { tile, part } = place(row, own(row), panes);
    if (part.full) whole.set(part.name, part.full);
    const sums = byId.get(tile.id) ?? { tile, memKb: 0, cpu: 0, mem: new Map(), cpus: new Map() };
    byId.set(tile.id, sums);
    sums.memKb += row.memKb;
    sums.cpu += row.cpu;
    sums.mem.set(part.name, (sums.mem.get(part.name) ?? 0) + row.memKb);
    sums.cpus.set(part.name, (sums.cpus.get(part.name) ?? 0) + row.cpu);
  }
  const all = [...byId.values()].sort((a, b) => b.memKb - a.memKb || b.cpu - a.cpu);
  const held = all.map((s): Held => ({ id: s.tile.id, mem: gb(s.memKb), cpu: inCores(s.cpu), memParts: parts(s.mem, gb, LEAST_GB, whole), cpuParts: parts(s.cpus, inCores, LEAST_CORES, whole) }));
  return { tiles: all.map((s) => s.tile), held: held.filter((h) => h.mem >= LEAST_GB || h.cpu >= LEAST_CORES) };
}

// The holder list of a view: the coloured ones by their slot, then the other tiles in the order given, then the
// four fixed ones.
function listed(tiles: Tile[], slots: Map<string, number>): Holder[] {
  const holders = tiles.map((tile): Holder => ({ ...tile, slot: slots.get(tile.id) ?? null }));
  const coloured = holders.filter((h) => h.slot !== null).sort((a, b) => a.slot! - b.slot!);
  const neutral = holders.filter((h) => h.slot === null && !(h.id in FIXED));
  const fixed = Object.keys(FIXED).flatMap((id) => holders.filter((h) => h.id === id));
  return [...coloured, ...neutral, ...fixed];
}

// The page's codes for what limits the machine in a sample of a range, 0 for nothing.
export const LIMITERS = [null, "memory", "cpu", "disk", "heat"] as const;
const STATE: Record<Level, 1 | 2> = { tight: 1, capped: 2 };
type Limited = { state: 0 | 1 | 2; limiter: LimitKind | null };
const CALM: Limited = { state: 0, limiter: null };
// The worst of several limits. Of two as bad, the one that comes first in LIMITERS.
function worst(found: Iterable<[LimitKind, Level]>, from: Limited = CALM): Limited {
  let top = from;
  for (const [limiter, level] of found) {
    const state = STATE[level];
    if (state > top.state || (state === top.state && LIMITERS.indexOf(limiter) < LIMITERS.indexOf(top.limiter))) top = { state, limiter };
  }
  return top;
}

type HostTick = TickRow & {
  t: number;
  load1: number;
  mem_total_kb: number;
  mem_free_kb: number;
  mem_wired_kb: number;
  mem_cached_kb: number;
  mem_compressed_kb: number;
  mem_stored_kb: number;
  swap_total_kb: number;
  available: number | null;
  held_kb: number;
  self_cpu_ms: number;
  self_mem_kb: number;
};
const KERNEL_LEVEL: Record<number, words.PressureLevel> = { 1: "normal", 2: "warn", 4: "critical" };

// The newest tick at or before a time and the minute of ticks that ends with it, which is what the verdict on now
// is read from. The tick before that minute is where its swap is counted from.
export function lastMinute(db: Database, at: number) {
  const upTo = db.query("SELECT * FROM host_raw WHERE t <= ? ORDER BY t DESC LIMIT 1");
  const newest = upTo.get(at) as HostTick | null;
  if (!newest) return null;
  const ticks = db.query("SELECT * FROM host_raw WHERE t > ? AND t <= ? ORDER BY t").all(newest.t - MINUTE_S, newest.t) as HostTick[];
  const span = spanOfTicks(ticks, upTo.get(newest.t - MINUTE_S) as HostTick | null);
  return { newest, ticks, span, ...worst(limits(span).map((l): [LimitKind, Level] => [l.kind, l.level])) };
}

// Now as a stretch: what each process group holds at the newest tick, and the CPU it used over the minute that
// ends with it.
function stretchOfNow(db: Database, { newest, span }: NonNullable<ReturnType<typeof lastMinute>>): Stretch {
  const groups = db
    .query("SELECT s.kind, s.owner, s.name, SUM(r.cpu_ms) AS cpuMs, SUM(IIF(r.t = ?, r.mem_kb, 0)) AS memKb FROM raw r CROSS JOIN series s ON s.id = r.sid WHERE r.t > ? AND r.t <= ? GROUP BY s.kind, s.owner, s.name")
    .all(newest.t, newest.t - MINUTE_S, newest.t) as (Owned & { name: string; cpuMs: number; memKb: number })[];
  return { cores: newest.cores, rows: groups.map(({ cpuMs, ...group }) => ({ ...group, cpu: span.ms ? cpuMs / span.ms : 0 })) };
}

const swapKbPerMin = (span: Span) => (span.ms ? span.swapGrowthKb / (span.ms / MINUTE_MS) : null);

// The reason the rules give for a limit, as the headline says it.
function causeOf(limiter: LimitKind, span: Span, available: number | null): words.Cause {
  switch (limiter) {
    case "memory": {
      const grows = swapKbPerMin(span);
      return {
        limiter,
        pressure: span.criticalMs > 0 ? "critical" : span.warnMs >= span.ms * WARN_SHARE ? "warn" : null,
        percent: pressureOf(available),
        swapMBPerMin: grows !== null && grows >= SWAP_GROWTH_KB_PER_MIN ? grows / MB_KB : null,
      };
    }
    case "cpu":
      return { limiter, busy: cpuShare(span) * span.cores, cores: span.cores };
    case "heat":
      return { limiter, thermal: span.thermalMax ?? 0 };
    case "disk":
      return { limiter, freeGB: (span.diskFreeKb ?? 0) / GB_KB };
  }
}

// When the state of now began: back through the minutes for as long as each has that state and the one before it
// is right before it. With no such minute it began inside the minute the verdict was read from. Read in pages that
// double, newest first, because a state that is not calm is seldom old.
function since(db: Database, state: number, newest: number) {
  type Minute = BucketRow & { t: number; res: number };
  const page = db.query("SELECT t, res, covered_ms, cores, busy_ms, warn_ms, critical_ms, swap_used_avg_kb, thermal_max, disk_total_kb, disk_free_min_kb FROM host_roll WHERE res = ? AND t < ? ORDER BY t DESC LIMIT ?");
  let began = (newest - MINUTE_S) * 1000;
  let later: Minute | null = null;
  for (let size = 60, before = newest; ; size *= 2) {
    const minutes = page.all(MINUTES.res, before, size) as Minute[];
    for (const minute of minutes) {
      // The newest minute is the one before the minute still running, or it says nothing about now.
      if (!later && minute.t + 2 * MINUTE_S <= newest) return began;
      if (later) {
        const judged = verdict(later, minute);
        if (worst(judged.levels).state !== state) return began;
        began = later.t * 1000;
        if (!judged.joined) return began;
      }
      later = minute;
    }
    if (minutes.length < size) break;
    before = minutes.at(-1)!.t;
  }
  return later && worst(verdict(later, null).levels).state === state ? later.t * 1000 : began;
}

// The holders a sentence names: the largest that are one lane, one app, HQ Office or the system, since a group is
// not somebody, and only from the size that earns a tile.
function named(shown: { tiles: Tile[]; held: Held[] }, by: "mem" | "cpu", allCores: number): words.Share[] {
  const label = new Map(shown.tiles.filter((t) => !t.group).map((t) => [t.id, t.name]));
  const least = by === "mem" ? TILE_KB / GB_KB : TILE_CPU_SHARE * allCores;
  return shown.held
    .filter((h) => label.has(h.id) && h[by] >= least)
    .sort((a, b) => b[by] - a[by])
    .slice(0, NAMED)
    .map((h) => ({ label: label.get(h.id)!, value: h[by] }));
}

// When the oldest sample the store still holds begins, as exactly as the store still knows: the start of its minute
// while the minutes or the ticks of that time are kept, and of its quarter of an hour once they are gone. A tick
// counts as the minute it will be rolled into, so the answer is the same before and after. It is given once, with
// now, so every range says the same of where recording began.
function beganAt(db: Database) {
  const oldest = db.query(`SELECT (SELECT MIN(t) FROM host_roll WHERE res = ?) AS quarter, (SELECT MIN(t) FROM host_roll WHERE res = ?) AS minute, (SELECT (MIN(t) - 1) / ${MINUTE_S} * ${MINUTE_S} FROM host_raw) AS tick`);
  const { quarter, minute, tick } = oldest.get(QUARTERS.res, MINUTES.res) as Record<"quarter" | "minute" | "tick", number | null>;
  const fine = minute === null ? tick : tick === null ? minute : Math.min(minute, tick);
  // A minute that starts after the oldest quarter of an hour has ended is not where recording began.
  const began = quarter !== null && (fine === null || fine >= quarter + QUARTERS.res) ? quarter : fine;
  return maybe(began, (t) => t * 1000);
}

// The thresholds of monitor-limits.ts as the page draws them, so it has none of its own. CPU is in cores of this
// machine, disk in GB free on a disk of this machine's size, swap growth in MB a minute, the thermal pressure as its
// level.
const limitsFor = (allCores: number, diskTotalKb: number | null) => ({
  warnShare: WARN_SHARE,
  swapGrowthMBPerMin: SWAP_GROWTH_KB_PER_MIN / MB_KB,
  cpuTight: round(CPU_TIGHT * allCores, 1),
  cpuCapped: round(CPU_CAPPED * allCores, 1),
  thermalTight: THERMAL_TIGHT,
  thermalCapped: THERMAL_CAPPED,
  diskTight: gb(diskLines(diskTotalKb).tightKb),
  diskCapped: gb(diskLines(diskTotalKb).cappedKb),
});

// The machine right now: the newest tick, with the verdict and the CPU of the minute that ends with it. name is
// the machine's name and size the store's. null before the first tick.
export function now(db: Database, q: { now: number; name: string; size: { bytes: number; limit: number } }) {
  const last = lastMinute(db, seconds(q.now));
  if (!last) return null;
  const { newest, span, state, limiter } = last;
  const stretch = stretchOfNow(db, last);
  const own = large(stretch);
  const shown = holdersOf(stretch, (owner) => own.has(ownerKey(owner)));
  const busy = span.ms ? inCores(cpuShare(span) * span.cores) : null;
  const level = newest.pressure === null ? null : KERNEL_LEVEL[newest.pressure];
  const grows = maybe(swapKbPerMin(span), (kb) => kb / MB_KB);
  const lanes = (db.query("SELECT COUNT(DISTINCT s.owner) AS n FROM raw r CROSS JOIN series s ON s.id = r.sid WHERE r.t = ? AND s.kind = 'lane'").get(newest.t) as { n: number }).n;
  const mem = { top: named(shown, "mem", newest.cores), total: gb(newest.held_kb) };
  const cpu = { top: named(shown, "cpu", newest.cores), total: busy ?? 0 };
  const drawn = limitsFor(newest.cores, newest.disk_total_kb);
  return {
    host: { name: q.name, cores: newest.cores, ramGB: gb(newest.mem_total_kb), swapTotalGB: gb(newest.swap_total_kb), diskTotalGB: maybe(newest.disk_total_kb, (kb) => round(kb / GB_KB, 1)) },
    limits: drawn,
    // From what size a lane or an app has a tile of its own, so the page folds a moment by the rule the server names by.
    tiles: { memGB: TILE_KB / GB_KB, cores: round(TILE_CPU_SHARE * newest.cores, 2) },
    tickSeconds: TICK_S,
    // The time this was asked for, by the server's clock: the page counts the newest sample's age from it, not from
    // a clock of its own.
    asOf: q.now,
    began: beganAt(db),
    words: words.pageWords(q.name, newest.cores, drawn),
    self: {
      cpuPercentOfOneCore: span.ms ? round((sum(last.ticks.map((t) => t.self_cpu_ms)) / span.ms) * 100, 2) : null,
      memMB: Math.round(newest.self_mem_kb / MB_KB),
      dbMB: round(q.size.bytes / (1024 * 1024), 1),
      dbLimitMB: Math.round(q.size.limit / (1024 * 1024)),
    },
    holders: listed(shown.tiles, slotsById(db)),
    now: {
      t: newest.t * 1000,
      state,
      limiter,
      since: since(db, state, newest.t),
      headline: words.headline(q.name, state && limiter ? { state, cause: causeOf(limiter, span, newest.available) } : { state: 0 }),
      sentence: words.blame(limiter, mem, cpu, "now"),
      // Who uses the CPU, whatever the limit is: what the page says while its map shows CPU.
      sentenceCpu: words.holding(cpu.top, cpu.total, "cpu", "now"),
      detail: words.detail({
        level,
        available: newest.available,
        storedGB: gb(newest.mem_stored_kb),
        compressedGB: gb(newest.mem_compressed_kb),
        swapUsedGB: gb(newest.swap_used_kb),
        swapTotalGB: gb(newest.swap_total_kb),
        swapMBPerMin: grows,
        busy,
        cores: newest.cores,
        diskFreeGB: maybe(newest.disk_free_kb, (kb) => kb / GB_KB),
      }),
      pressure: pressureOf(newest.available),
      kernelLevel: level,
      swapUsed: gb(newest.swap_used_kb),
      swapFrac: newest.swap_total_kb ? round(newest.swap_used_kb / newest.swap_total_kb, 2) : 0,
      swapGrowth: maybe(grows, (mb) => Math.round(mb)),
      stored: gb(newest.mem_stored_kb),
      compressed: gb(newest.mem_compressed_kb),
      wired: gb(newest.mem_wired_kb),
      cached: gb(newest.mem_cached_kb),
      free: gb(newest.mem_free_kb),
      held: gb(newest.held_kb),
      busy,
      load: round(newest.load1, 2),
      diskFree: maybe(newest.disk_free_kb, (kb) => round(kb / GB_KB, 1)),
      diskUsedFrac: newest.disk_total_kb && newest.disk_free_kb !== null ? round(1 - newest.disk_free_kb / newest.disk_total_kb, 2) : null,
      thermal: newest.thermal,
      lanesRunning: lanes,
      holders: shown.held,
    },
  };
}

export type RangeKey = "hour" | "day" | "week" | "quarter";
const RANGES: Record<RangeKey, { label: string; step: number; n: number }> = {
  hour: { label: "1 hour", step: 60, n: 60 },
  day: { label: "24 hours", step: 300, n: 288 },
  week: { label: "7 days", step: 1800, n: 336 },
  quarter: { label: "90 days", step: 21_600, n: 360 },
};

// A range's samples, in seconds: sample i covers step seconds from t0 + i * step, and the last one holds now. A
// tick at second t says what was used up to t, so now counts at the second before it.
function frame(key: RangeKey, at: number) {
  const { step, n } = RANGES[key];
  const to = seconds(at);
  return { step, n, to, t0: Math.floor((to - 1) / step) * step - (n - 1) * step };
}

type Series = (number | null)[];
export type Range = {
  key: RangeKey;
  label: string;
  t0: number;
  step: number;
  n: number;
  // state is 0, 1 or 2 and limiter an index into LIMITERS. pressure is 100 minus the percent of memory the kernel
  // counts as available. level is the kernel's highest pressure level in the sample, an index into words.LEVELS,
  // and thermal the highest thermal pressure level. stored is the memory handed to the compressor and compressed
  // the RAM it takes.
  host: Record<"pressure" | "pressureMax" | "level" | "swap" | "stored" | "compressed" | "held" | "heldMax" | "busy" | "busyMax" | "diskFree" | "thermal" | "state" | "limiter", Series>;
  mem: Record<string, Series>;
  cpu: Record<string, Series>;
  holders: Holder[];
};

export function range(db: Database, q: { now: number; key: RangeKey }): Range {
  const { step, n, to, t0 } = frame(q.key, q.now);
  const read = pieces(db, step, t0, to);
  const host = view(read, "host");
  type Sampled = { i: number; samples: number; coveredMs: number; cores: number; busyMs: number; busyMax: number | null; available: number | null; availableMin: number | null; swapKb: number; storedKb: number; compressedKb: number; heldKb: number; heldMaxKb: number; diskFreeKb: number | null; pressureLevel: number | null; thermal: number | null };
  const sampled = db
    .query(
      `SELECT CAST((t - ?) / ? AS INTEGER) AS i, SUM(samples) AS samples, SUM(covered_ms) AS coveredMs, MAX(cores) AS cores, SUM(busy_ms) AS busyMs, MAX(busy_max) AS busyMax,
         SUM(available_avg * samples) / SUM(IIF(available_avg IS NULL, NULL, samples)) AS available, MIN(available_min) AS availableMin,
         ${mean("swap_used_avg_kb")} AS swapKb, ${mean("mem_stored_avg_kb")} AS storedKb, ${mean("held_avg_kb")} AS heldKb, MAX(held_max_kb) AS heldMaxKb, MIN(disk_free_min_kb) AS diskFreeKb,
         ${mean("mem_compressed_avg_kb")} AS compressedKb, MAX(pressure_max) AS pressureLevel, MAX(thermal_max) AS thermal
       FROM (${host.sql}) GROUP BY i`,
    )
    .all(t0, step, ...host.args) as Sampled[];
  const at = new Map(sampled.map((s) => [s.i, s]));
  const ofHost = (read: (s: Sampled) => number | null): Series => Array.from({ length: n }, (_, i) => maybe(at.get(i) ?? null, read));

  const limited = Array.from({ length: n }, (_, i): Limited | null => (at.has(i) ? CALM : null));
  const raise = (i: number, found: Iterable<[LimitKind, Level]>) => {
    if (limited[i]) limited[i] = worst(found, limited[i]!);
  };
  for (const v of verdicts(db, { from: t0 * 1000, to: q.now })) raise(Math.floor((v.bucket.t - t0) / step), v.levels);
  // The minute still running is in no rollup, so the last sample also takes the verdict on now.
  const last = lastMinute(db, to);
  const newest = last && last.newest.t > t0 + (n - 1) * step ? last.newest : null;
  if (last && newest && last.limiter) raise(n - 1, [[last.limiter, last.state === 2 ? "capped" : "tight"]]);

  // Per sample, what each owner held in kB and used in cores.
  type Use = { memKb: number[]; cpu: number[] };
  const none = (): Use => ({ memKb: new Array<number>(n).fill(0), cpu: new Array<number>(n).fill(0) });
  const rows = view(read, "rows");
  const grid = db
    .query(`SELECT CAST((r.t - ?) / ? AS INTEGER) AS i, s.kind, s.owner, SUM(r.cpu_ms) AS cpuMs, SUM(r.mem_avg_kb * r.samples) AS memSamples FROM ${rowsWithOwner(rows.sql)} GROUP BY i, s.kind, s.owner`)
    .all(t0, step, ...rows.args) as (Owned & { i: number; cpuMs: number; memSamples: number })[];
  const owners = new Map<string, Owned & Use>();
  for (const { i, kind, owner, cpuMs, memSamples } of grid) {
    const use = owners.get(ownerKey({ kind, owner })) ?? { kind, owner, ...none() };
    owners.set(ownerKey(use), use);
    const { samples, coveredMs } = at.get(i)!;
    use.memKb[i] = memSamples / samples;
    use.cpu[i] = coveredMs ? cpuMs / coveredMs : 0;
  }
  // The last sample holds now, so its memory is what is held at the newest tick, as now() reads it, and not the
  // average of a sample that may be hours long. Otherwise the tiles of now hold more than any peak of the range.
  if (newest) {
    const heldNow = db.query("SELECT s.kind, s.owner, SUM(r.mem_kb) AS memKb FROM raw r CROSS JOIN series s ON s.id = r.sid WHERE r.t = ? GROUP BY s.kind, s.owner").all(newest.t) as (Owned & { memKb: number })[];
    for (const use of owners.values()) use.memKb[n - 1] = 0;
    for (const { memKb, ...owner } of heldNow) {
      const use = owners.get(ownerKey(owner)) ?? { ...owner, ...none() };
      owners.set(ownerKey(use), use);
      use.memKb[n - 1] = memKb;
    }
  }

  // An owner has a tile of its own in a range when it earns one in any of the range's samples.
  const allCores = Math.max(0, ...sampled.map((s) => s.cores));
  const peaks = [...owners.values()].map((use) => ({ use, memKb: Math.max(...use.memKb), cpu: Math.max(...use.cpu) })).sort((a, b) => b.memKb - a.memKb || b.cpu - a.cpu);
  const tiles = new Map<string, Tile>(Object.values(FIXED).map((tile) => [tile.id, tile]));
  const held = new Map<string, Use>([...tiles.keys()].map((id) => [id, none()]));
  const panes = panesOf(owners.values());
  for (const { use, memKb, cpu } of peaks) {
    const tile = tileOf(use, earnsTile(use, memKb, cpu, allCores), panes);
    tiles.set(tile.id, tile);
    const into = held.get(tile.id) ?? none();
    held.set(tile.id, into);
    for (let i = 0; i < n; i++) {
      into.memKb[i] += use.memKb[i];
      into.cpu[i] += use.cpu[i];
    }
  }
  const ofHolders = (of: keyof Use, read: (value: number) => number) => Object.fromEntries([...held].map(([id, use]): [string, Series] => [id, use[of].map((value, i) => (at.has(i) ? read(value) : null))]));

  // The machine's memory at the last sample is the newest tick's too.
  const ofMemory = (read: (s: Sampled) => number | null, ofNow: (tick: HostTick) => number | null): Series => ofHost(read).map((v, i) => (newest && i === n - 1 ? ofNow(newest) : v));

  return {
    key: q.key,
    label: RANGES[q.key].label,
    t0: t0 * 1000,
    step: step * 1000,
    n,
    host: {
      pressure: ofMemory((s) => pressureOf(s.available), (tick) => pressureOf(tick.available)),
      pressureMax: ofHost((s) => pressureOf(s.availableMin)),
      level: ofHost((s) => maybe(s.pressureLevel, (level) => words.LEVELS.indexOf(KERNEL_LEVEL[level]))),
      swap: ofMemory((s) => gb(s.swapKb), (tick) => gb(tick.swap_used_kb)),
      stored: ofMemory((s) => gb(s.storedKb), (tick) => gb(tick.mem_stored_kb)),
      compressed: ofMemory((s) => gb(s.compressedKb), (tick) => gb(tick.mem_compressed_kb)),
      held: ofMemory((s) => gb(s.heldKb), (tick) => gb(tick.held_kb)),
      heldMax: ofHost((s) => gb(s.heldMaxKb)),
      busy: ofHost((s) => (s.coveredMs ? inCores(s.busyMs / s.coveredMs) : null)),
      busyMax: ofHost((s) => maybe(s.busyMax, inCores)),
      diskFree: ofHost((s) => maybe(s.diskFreeKb, (kb) => round(kb / GB_KB, 1))),
      thermal: ofHost((s) => s.thermal),
      state: limited.map((l) => maybe(l, (v) => v.state)),
      limiter: limited.map((l) => maybe(l, (v) => LIMITERS.indexOf(v.limiter))),
    },
    mem: ofHolders("memKb", gb),
    cpu: ofHolders("cpu", inCores),
    holders: listed([...tiles.values()], slotsById(db)),
  };
}

// Who held what at one time of a range: the sample that holds t, as that range's holders (range().holders), each
// with its parts. null where the range has no sample.
export function moment(db: Database, q: { now: number; key: RangeKey; t: number; holders: Holder[] }) {
  const { step, n, to, t0 } = frame(q.key, q.now);
  const i = Math.floor((q.t / 1000 - t0) / step);
  if (i < 0 || i >= n) return null;
  const from = t0 + i * step;
  const stretch = stretchOf(db, pieces(db, step, from, Math.min(from + step, to)));
  if (!stretch) return null;
  const own = new Set(q.holders.map((h) => h.id));
  return { t: from * 1000, step: step * 1000, holders: holdersOf(stretch, (owner) => own.has(holderId(owner.kind, owner.owner))).held };
}

export type Day = {
  t: number;
  date: string;
  state: 0 | 1 | 2;
  cappedMinutes: number;
  tightMinutes: number;
  gapMinutes: number;
  pressureMax: number | null;
  swapMax: number;
  busyMax: number | null;
  heldMax: number;
  diskFree: number | null;
  runs: number;
  partial: boolean;
  // The day's worst minute or quarter of an hour, by state and then by memory pressure, and who held the most in it.
  // t is when it ends, as a tick's time is, and the newest tick's own time when now is at least as bad.
  worst: { t: number; top: Top[] } | null;
  // Who held the most over the day, on average over all its samples.
  top: Top[];
};
type Top = { id: string; name: string; mem: number };

// Who a stretch names: the largest that are one lane, one app, HQ Office or the system, most memory first.
function topOf(stretch: Stretch | null): Top[] {
  if (!stretch) return [];
  const tiled = large(stretch);
  const shown = holdersOf(stretch, (owner) => tiled.has(ownerKey(owner)));
  const tile = new Map(shown.tiles.map((t) => [t.id, t]));
  return shown.held.filter((h) => !tile.get(h.id)!.group && h.mem >= LEAST_GB).slice(0, DAY_TOP).map((h) => ({ id: h.id, name: tile.get(h.id)!.name, mem: h.mem }));
}

// A day that is over keeps its averages, by the database and the day's start: reading 90 days anew with every
// answer would cost more than the monitor itself, and nothing is written to a day once it has passed.
const pastTops = new WeakMap<Database, Map<number, Top[]>>();

// The dates of a zone, each by its number (days since 1970 on the zone's calendar), with times in seconds. A date
// starts at its own midnight by the offset of that moment, so the day the clocks change is 23 or 25 hours long.
function calendar(zone: words.Zone) {
  const dayOf = (t: number) => Math.floor((t + zone(t * 1000) * 60) / DAY_S);
  const starts = new Map<number, number>();
  // The first second of a date, found and not worked out from an offset: which offset holds at a midnight is the
  // question. No zone is further from UTC than 14 hours, so the start is inside these two.
  const startOf = (day: number) => {
    if (starts.has(day)) return starts.get(day)!;
    let [before, start] = [day * DAY_S - 15 * HOUR_S, day * DAY_S + 13 * HOUR_S];
    while (start - before > 1) {
      const middle = Math.floor((before + start) / 2);
      if (dayOf(middle) < day) before = middle;
      else start = middle;
    }
    starts.set(day, start);
    return start;
  };
  return { dayOf, startOf };
}

// One entry per calendar day that has data, newest last, HISTORY_DAYS at most. A day is a date in the zone, from
// its midnight to the next. A day with samples missing, or still running, is partial.
export function days(db: Database, q: { now: number; zone: words.Zone }): Day[] {
  const { dayOf, startOf } = calendar(q.zone);
  const to = seconds(q.now);
  const today = dayOf(to - 1);
  const from = startOf(today - (HISTORY_DAYS - 1));
  type Sums = { state: 0 | 1 | 2; ms: [number, number, number]; availableMin: number | null; swapMaxKb: number; busyMax: number | null; heldMaxKb: number; diskFreeKb: number | null; worst: { state: number; pressure: number; bucket: Bucket } | null };
  const badness = (available: number | null) => 100 - (available ?? 100);
  const byDay = new Map<number, Sums>();
  const pick = (of: (a: number, b: number) => number) => (a: number | null, b: number | null) => (a === null ? b : b === null ? a : of(a, b));
  const least = pick(Math.min);
  const most = pick(Math.max);
  const judged = verdicts(db, { from: from * 1000, to: q.now });
  for (const { bucket, levels } of judged) {
    const day = dayOf(bucket.t);
    const sums = byDay.get(day) ?? { state: 0, ms: [0, 0, 0], availableMin: null, swapMaxKb: 0, busyMax: null, heldMaxKb: 0, diskFreeKb: null, worst: null };
    byDay.set(day, sums);
    const { state } = worst(levels);
    const pressure = badness(bucket.available_min);
    if (!sums.worst || state > sums.worst.state || (state === sums.worst.state && pressure > sums.worst.pressure)) sums.worst = { state, pressure, bucket };
    sums.state = Math.max(sums.state, state) as 0 | 1 | 2;
    sums.ms[state] += bucket.covered_ms;
    sums.availableMin = least(sums.availableMin, bucket.available_min);
    sums.swapMaxKb = Math.max(sums.swapMaxKb, bucket.swap_used_max_kb);
    sums.busyMax = most(sums.busyMax, bucket.busy_max);
    sums.heldMaxKb = Math.max(sums.heldMaxKb, bucket.held_max_kb);
    sums.diskFreeKb = least(sums.diskFreeKb, bucket.disk_free_min_kb);
  }
  // The ticks after the last full minute are in no bucket yet, and a day's peaks count them too.
  const judgedTo = judged.length ? judged.at(-1)!.bucket.t + judged.at(-1)!.bucket.res : 0;
  const last = lastMinute(db, to);
  for (const tick of last?.ticks ?? []) {
    const sums = byDay.get(dayOf(tick.t - 1));
    if (!sums || tick.t <= judgedTo) continue;
    sums.availableMin = least(sums.availableMin, tick.available);
    sums.swapMaxKb = Math.max(sums.swapMaxKb, tick.swap_used_kb);
    sums.heldMaxKb = Math.max(sums.heldMaxKb, tick.held_kb);
    sums.diskFreeKb = least(sums.diskFreeKb, tick.disk_free_kb);
  }
  // The newest tick is in no bucket yet, or is one of several a bucket averages. Its day is at its worst now when
  // now is at least as bad as the day's worst bucket: the rule of an incident that still runs, so the day, the
  // incident and now give one time and one figure.
  const dayOfNow = last ? byDay.get(dayOf(last.newest.t - 1)) : undefined;
  const worstIsNow = !!last && !!dayOfNow?.worst && (last.state > dayOfNow.worst.state || (last.state === dayOfNow.worst.state && badness(last.newest.available) >= dayOfNow.worst.pressure));
  const worstOf = (sums: Sums): Day["worst"] => {
    if (sums === dayOfNow && worstIsNow) return { t: last!.newest.t * 1000, top: topOf(stretchOfNow(db, last!)) };
    if (!sums.worst) return null;
    const { t, res } = sums.worst.bucket;
    return { t: (t + res) * 1000, top: topOf(stretchOf(db, [{ res, from: t, to: t + res }])) };
  };
  const kept = pastTops.get(db) ?? new Map<number, Top[]>();
  pastTops.set(db, kept);
  // Averaged over the day's own samples, from its midnight to the next or to now.
  const topOfDay = (day: number) => {
    const start = startOf(day);
    if (kept.has(start)) return kept.get(start)!;
    const top = topOf(stretchOf(db, pieces(db, QUARTERS.res, start, Math.min(startOf(day + 1), to))));
    if (day < today) kept.set(start, top);
    return top;
  };
  const runs = new Map<number, number>();
  for (const { t } of db.query("SELECT t FROM marks WHERE kind = 'suite' AND t >= ? AND t < ?").all(from, to) as { t: number }[]) runs.set(dayOf(t), (runs.get(dayOf(t)) ?? 0) + 1);
  const minutes = (ms: number) => Math.round(ms / MINUTE_MS);
  return [...byDay]
    .sort(([a], [b]) => a - b)
    .map(([day, sums]): Day => {
      const elapsed = (Math.min(startOf(day + 1), to) - startOf(day)) * 1000;
      // Whole minutes only, because the tick after a start covers no time and the minute still running is in no
      // bucket.
      const gapMinutes = Math.floor(Math.max(0, elapsed - sum(sums.ms)) / MINUTE_MS);
      return {
        t: startOf(day) * 1000,
        date: new Date(day * DAY_MS).toISOString().slice(0, 10),
        state: sums.state,
        cappedMinutes: minutes(sums.ms[2]),
        tightMinutes: minutes(sums.ms[1]),
        gapMinutes,
        pressureMax: maybe(pressureOf(sums.availableMin), Math.round),
        swapMax: gb(sums.swapMaxKb),
        busyMax: maybe(sums.busyMax, (v) => round(v, 1)),
        heldMax: gb(sums.heldMaxKb),
        diskFree: maybe(sums.diskFreeKb, (kb) => round(kb / GB_KB, 1)),
        runs: runs.get(day) ?? 0,
        partial: day === today || gapMinutes > 0,
        worst: worstOf(sums),
        top: topOfDay(day),
      };
    });
}

const EVENT_KIND = new Map([
  ["restart", "reboot"],
  ["lane-started", "lane-start"],
  ["lane-ended", "lane-end"],
  ["suite", "test-run"],
]);
export type PageEvent = { t: number; kind: string; label: string; holder: string | null };

// The marks of a window, oldest first, as the page's events. holder is the lane's holder id when the mark is about
// a lane.
export function events(db: Database, q: { from: number; to: number }): PageEvent[] {
  return timeline(db, q).map((mark) => {
    const kind = EVENT_KIND.get(mark.kind) ?? mark.kind;
    const lane = mark.kind === "lane-started" || mark.kind === "lane-ended";
    return { t: mark.at, kind, label: words.eventLabel({ kind, text: mark.label, forMs: mark.forMs }), holder: lane ? holderId("lane", mark.label) : null };
  });
}

// Per kind of limit: whether its holders are ranked by memory or by CPU, what makes one bucket of an incident worse
// than another, and what its peak read. Heat goes by CPU, since work is what heats a machine.
const share = (span: Span) => (span.ms ? cpuShare(span) : 0);
// What an incident reads at its peak: a bucket, or the newest tick as one.
type Reading = Pick<Bucket, "t" | "cores" | "available_min" | "thermal_max" | "disk_free_min_kb" | "swap_used_max_kb" | "held_avg_kb" | "mem_stored_avg_kb">;
const readingOf = (tick: HostTick): Reading => ({
  t: tick.t, cores: tick.cores, available_min: tick.available, thermal_max: tick.thermal, disk_free_min_kb: tick.disk_free_kb, swap_used_max_kb: tick.swap_used_kb, held_avg_kb: tick.held_kb, mem_stored_avg_kb: tick.mem_stored_kb,
});
const RESOURCE: Record<LimitKind, { by: "mem" | "cpu"; badness(bucket: Reading, span: Span): number; peak(episode: Episode, bucket: Reading, span: Span): words.Peak }> = {
  memory: {
    by: "mem",
    badness: (bucket) => 100 - (bucket.available_min ?? 100),
    peak: (episode, bucket) => ({
      resource: "memory",
      pressure: maybe(bucket.available_min, (available) => 100 - available),
      level: episode.peak.pressureMax === undefined ? null : KERNEL_LEVEL[episode.peak.pressureMax],
      swapGrewGB: (episode.peak.swapGrowthKb ?? 0) / GB_KB,
    }),
  },
  cpu: { by: "cpu", badness: (_, span) => share(span), peak: (_, __, span) => ({ resource: "cpu", busy: share(span) * span.cores, cores: span.cores }) },
  heat: { by: "cpu", badness: (bucket, span) => (bucket.thermal_max ?? 0) * 10 + share(span), peak: (episode) => ({ resource: "heat", thermal: episode.peak.thermalMax ?? 0 }) },
  disk: { by: "mem", badness: (bucket) => -(bucket.disk_free_min_kb ?? Infinity), peak: (episode) => ({ resource: "disk", freeGB: (episode.peak.diskFreeKb ?? 0) / GB_KB }) },
};

// The first of an episode's largest owners that together held more than half of what ran short, and all of them
// when they did not.
function leading<T extends { share: number }>(who: T[]): T[] {
  const reached = who.findIndex((_, i) => sum(who.slice(0, i + 1).map((w) => w.share)) > 0.5);
  return reached < 0 ? who : who.slice(0, reached + 1);
}

export type Incident = {
  id: string;
  resource: LimitKind;
  severity: 1 | 2;
  t0: number;
  t1: number;
  peak: number;
  closeT0: number;
  closeT1: number;
  minutes: number;
  cappedMinutes: number;
  headline: string;
  summary: string;
  ongoing: boolean;
  score: number;
  host: { pressure: number | null; swap: number; held: number; busy: number | null; stored: number; diskFree: number | null };
  // At the peak, most of what ran short first. grew is the change in memory over the half hour before the peak,
  // null when that time was not sampled. parts are of what ran short.
  holders: { id: string; mem: number; cpu: number; grew: number | null; parts: Part[] }[];
  culprits: string[];
  // The marks from half an hour before it to its end, or to a day after it began when it lasts longer.
  events: PageEvent[];
};

// The stretches in which something limited the machine over the last HISTORY_DAYS days, oldest first: the `limit`
// worst of them, where capped is worse than close, and longer is worse. holders is every holder they name.
export function incidents(db: Database, q: { now: number; limit?: number }): { holders: Holder[]; incidents: Incident[] } {
  const window = { from: q.now - HISTORY_DAYS * DAY_MS, to: q.now };
  const judged = verdicts(db, window);
  const end = judged.length ? (judged.at(-1)!.bucket.t + judged.at(-1)!.bucket.res) * 1000 : 0;
  const slots = slotsById(db);
  const tiles = new Map<string, Tile>();
  const last = lastMinute(db, seconds(q.now));

  const sized = episodes(db, window).map((episode) => {
    const inside = judged.filter((v) => v.bucket.t * 1000 >= episode.from && v.bucket.t * 1000 < episode.to);
    const cappedMs = sum(inside.filter((v) => v.levels.get(episode.kind) === "capped").map((v) => v.bucket.res * 1000));
    const ms = episode.to - episode.from;
    const severity = STATE[episode.level];
    return { episode, inside, ms, cappedMs, severity, score: severity * 1e12 + Math.round(cappedMs / MINUTE_MS) * 1e6 + Math.round(ms / MINUTE_MS) };
  });
  const worstFirst = sized.sort((a, b) => b.score - a.score).slice(0, q.limit ?? INCIDENTS);

  const found = worstFirst.map(({ episode, inside, ms, cappedMs, severity, score }): Incident => {
    const { by, badness, peak } = RESOURCE[episode.kind];
    const rank = (v: (typeof inside)[number]) => (v.levels.has(episode.kind) ? STATE[v.levels.get(episode.kind)!] : 0);
    const top = inside.reduce((a, b) => (rank(b) > rank(a) || (rank(b) === rank(a) && badness(b.bucket, b.span) > badness(a.bucket, a.span)) ? b : a));
    const ongoing = episode.to >= end;
    // An incident that still runs peaks now when now is at least as bad as its worst bucket. The newest tick is in
    // no bucket yet, or is one of several a bucket averages, so the buckets alone never show it.
    const level = ongoing && last ? limits(last.span).find((l) => l.kind === episode.kind)?.level : undefined;
    const now = last && level && (STATE[level] > rank(top) || (STATE[level] === rank(top) && badness(readingOf(last.newest), last.span) >= badness(top.bucket, top.span))) ? last : null;
    const bucket: Reading = now ? readingOf(now.newest) : top.bucket;
    const span = now ? now.span : top.span;
    const at = (from: number) => stretchOf(db, [{ res: top.bucket.res, from, to: from + top.bucket.res }]);
    const then = now ? stretchOfNow(db, now) : at(top.bucket.t)!;
    const tiled = large(then);
    const own = (owner: Owned) => tiled.has(ownerKey(owner));
    const shown = holdersOf(then, own);
    for (const tile of shown.tiles) tiles.set(tile.id, tile);
    const earlier = at(top.bucket.t - AROUND_MS / 1000);
    const before = earlier && new Map(holdersOf(earlier, own).held.map((h) => [h.id, h.mem]));
    // Of an incident that lasts for days, only the first day's marks: reading every lane's rows over weeks costs
    // seconds, and what the page says of an incident is what came just before it.
    const marks = events(db, { from: episode.from - AROUND_MS, to: Math.min(episode.to, episode.from + DAY_MS) });
    const busy = span.ms ? share(span) * span.cores : null;
    const facts: words.IncidentFacts = {
      severity,
      ms,
      cappedMs,
      ongoing,
      peak: peak(episode, bucket, span),
      mem: { top: named(shown, "mem", bucket.cores), total: gb(bucket.held_avg_kb) },
      cpu: { top: named(shown, "cpu", bucket.cores), total: busy ?? 0 },
      before: marks.filter((m) => m.t < episode.from && m.kind !== "gap").map((m) => ({ label: m.label, ms: episode.from - m.t })),
    };
    return {
      id: `${episode.kind}-${episode.from / MINUTE_MS}`,
      resource: episode.kind,
      severity,
      t0: episode.from,
      t1: episode.to,
      // Named by when it ends, as a tick is: the minute up to 10:59 is 10:59.
      peak: (now ? now.newest.t : top.bucket.t + top.bucket.res) * 1000,
      closeT0: episode.from - AROUND_MS,
      closeT1: Math.min(episode.to + AROUND_MS, q.now),
      minutes: Math.round(ms / MINUTE_MS),
      cappedMinutes: Math.round(cappedMs / MINUTE_MS),
      headline: words.incidentHeadline(facts),
      summary: words.incidentSummary(facts),
      ongoing,
      score,
      host: {
        pressure: pressureOf(bucket.available_min),
        swap: gb(bucket.swap_used_max_kb),
        held: gb(bucket.held_avg_kb),
        busy: maybe(busy, inCores),
        stored: gb(bucket.mem_stored_avg_kb),
        diskFree: maybe(bucket.disk_free_min_kb, (kb) => round(kb / GB_KB, 1)),
      },
      holders: shown.held
        .sort((a, b) => b[by] - a[by])
        .map((h) => ({ id: h.id, mem: h.mem, cpu: h.cpu, grew: before ? round(h.mem - (before.get(h.id) ?? 0), 2) : null, parts: by === "mem" ? h.memParts : h.cpuParts })),
      culprits: [...new Set(leading(episode.who).map((who) => tileOf(who, own(who), new Map()).id))],
      events: marks,
    };
  });
  return { holders: listed([...tiles.values()], slots), incidents: found.sort((a, b) => a.t0 - b.t0) };
}

export type Pattern = {
  id: string;
  holder: string;
  resource: LimitKind;
  title: string;
  detail: string;
  evidence: { type: "days" | "count"; unit: string; threshold?: number; values: number[]; t?: number[]; labels?: string[] };
};

// What keeps coming back over the last `days` days (monitor-history.ts offenders), the finding with the most behind
// it first. zone is for the time of a restart, printed by the offset of its own date. holders is every holder they
// name. Each is named by itself, however small it is now.
export function patterns(db: Database, q: { now: number; zone: words.Zone; days?: number }): { holders: Holder[]; patterns: Pattern[] } {
  const window = q.days ?? PATTERN_DAYS;
  const tiles = new Map<string, Tile>();
  const facts = offenders(db, { now: q.now, days: window });
  const panes = panesOf(facts);
  const found = facts.flatMap((fact): Pattern[] => {
    const tile = tileOf(fact, true, panes);
    tiles.set(tile.id, tile);
    switch (fact.pattern) {
      case "top-in-episodes": {
        // Nobody leads the episodes of a full disk.
        if (fact.limit === "disk") return [];
        const said = words.patternWords({ pattern: fact.pattern, label: tile.name, limit: fact.limit, episodes: fact.episodes, of: fact.of, window });
        return [{ id: `led-${fact.limit}-${tile.id}`, holder: tile.id, resource: fact.limit, ...said, evidence: { type: "count", unit: "times", values: [fact.episodes, fact.of - fact.episodes], labels: words.leaders(tile.name, fact.limit) } }];
      }
      case "days-above": {
        const peaks = dayPeaks(db, { now: q.now, days: window, kind: fact.kind, owner: fact.owner });
        const values = peaks.map((p) => round(p.memKb / GB_KB, 1));
        const said = words.patternWords({ pattern: fact.pattern, label: tile.name, gb: fact.memKb / GB_KB, days: fact.days, of: fact.of, window, highest: Math.max(...values), lowest: Math.min(...values) });
        return [{ id: `above-${tile.id}`, holder: tile.id, resource: "memory", ...said, evidence: { type: "days", unit: "GB", threshold: fact.memKb / GB_KB, values, t: peaks.map((p) => p.at) } }];
      }
      case "before-restart": {
        const held = round(fact.memKb / GB_KB, 1);
        const said = words.patternWords({ pattern: fact.pattern, label: tile.name, gb: held, overMs: BEFORE_RESTART_S * 1000, at: fact.at, zone: q.zone, limit: fact.limit });
        return [{ id: `restart-${fact.at / 1000}`, holder: tile.id, resource: "memory", ...said, evidence: { type: "count", unit: "GB", values: [held], labels: [tile.name] } }];
      }
    }
  });
  return { holders: listed([...new Set(found.map((p) => p.holder))].map((id) => tiles.get(id)!), slotsById(db)), patterns: found };
}
