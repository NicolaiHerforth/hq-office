// THE MONITOR's history, read from its store (monitor-store.ts): the episodes in which something limited the machine
// (monitor-limits.ts), the marks on the timeline, and what keeps coming back. Read-only queries on a database that
// is passed in, and no clock: the time comes with the question. Every time in and out is epoch milliseconds; the
// tables hold seconds.
import type { Database } from "bun:sqlite";
import { dur } from "../client/core/format.js";
import { cpuShare, limits, spanOfBucket, type BucketRow, type Level, type LimitKind, type Span } from "./monitor-limits.ts";
import { TICK_MS } from "./monitor.ts";
import { RES } from "./monitor-store.ts";
import type { OwnerKind } from "./monitor-types.ts";
import { MAX_GAP_MS } from "./monitor-usage.ts";

export const TICK_S = TICK_MS / 1000;
const [MINUTES, QUARTERS] = RES;
const DAY_S = 86_400;
const GB_KB = 1024 * 1024;
const WHO = 3;
const OFFENDER_DAYS = 14;
// An owner is named as the one that keeps leading a kind of episode only with this many episodes to go by, and
// this many of them led.
const EPISODES_TO_JUDGE = 3;
const EPISODES_LED = 2;
const DAYS_ABOVE_KB = [4, 8, 16, 32].map((gb) => gb * GB_KB);
const DAYS_ABOVE = 3;
export const BEFORE_RESTART_S = 900;

const seconds = (ms: number) => Math.ceil(ms / 1000);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// A stretch of one table, in seconds: the buckets that start in [from, to). res says which table: the tick's length
// for the raw one.
export type Piece = { res: number; from: number; to: number };

// Every table read as the rollups' shape, so one query serves all three: a raw tick is a bucket with one sample. A
// tick at second t says what was used up to t, so it counts at t - 1, which is in the bucket it belongs to.
const TABLES = {
  ticks: {
    host: `SELECT t - 1 AS t, ${TICK_S} AS res, 1 AS samples, dt_ms AS covered_ms, cores, busy_ms, mem_free_kb AS mem_free_avg_kb, mem_wired_kb AS mem_wired_avg_kb, mem_app_kb AS mem_app_avg_kb,
      mem_cached_kb AS mem_cached_avg_kb, mem_compressed_kb AS mem_compressed_avg_kb, mem_stored_kb AS mem_stored_avg_kb, swap_used_kb AS swap_used_avg_kb, swap_used_kb AS swap_used_max_kb,
      pressure AS pressure_max, IIF(pressure = 2, dt_ms, 0) AS warn_ms, IIF(pressure = 4, dt_ms, 0) AS critical_ms, thermal AS thermal_max, disk_total_kb, disk_free_kb AS disk_free_min_kb, boot_at,
      available AS available_avg, available AS available_min, held_kb AS held_avg_kb, held_kb AS held_max_kb, IIF(dt_ms > 0, busy_ms * 1.0 / dt_ms, NULL) AS busy_max
      FROM host_raw WHERE t > ? AND t <= ?`,
    rows: `SELECT t - 1 AS t, ${TICK_S} AS res, 1 AS samples, sid, cpu_ms, mem_kb AS mem_avg_kb, mem_kb AS mem_max_kb, n AS n_max FROM raw WHERE t > ? AND t <= ?`,
  },
  buckets: {
    host: `SELECT t, res, samples, covered_ms, cores, busy_ms, mem_free_avg_kb, mem_wired_avg_kb, mem_app_avg_kb, mem_cached_avg_kb, mem_compressed_avg_kb, mem_stored_avg_kb, swap_used_avg_kb, swap_used_max_kb,
      pressure_max, warn_ms, critical_ms, thermal_max, disk_total_kb, disk_free_min_kb, boot_at, available_avg, available_min, held_avg_kb, held_max_kb, busy_max
      FROM host_roll WHERE res = ? AND t >= ? AND t < ?`,
    // CROSS JOIN keeps the bucket on the outside: one seek per bucket for its samples, then its rows in a run.
    rows: `SELECT r.t, r.res, h.samples, r.sid, r.cpu_ms, r.mem_avg_kb, r.mem_max_kb, r.n_max FROM host_roll h CROSS JOIN roll r ON r.res = h.res AND r.t = h.t WHERE h.res = ? AND h.t >= ? AND h.t < ?`,
  },
};
export function view(pieces: Piece[], of: "host" | "rows") {
  return {
    sql: pieces.map((p) => TABLES[p.res === TICK_S ? "ticks" : "buckets"][of]).join(" UNION ALL "),
    args: pieces.flatMap((p) => (p.res === TICK_S ? [p.from, p.to] : [p.res, p.from, p.to])),
  };
}
// The rows of the pieces with whose they are. CROSS JOIN again: the range is read once and each row looks up its
// series, never the range once per series.
export const rowsWithOwner = (rows: string) => `(${rows}) r CROSS JOIN series s ON s.id = r.sid`;

// The store prunes by the time of the tick it was given last, so what each table still holds is counted back from
// the newest sample, not from a clock.
const newest = (db: Database) => (db.query("SELECT MAX(t) AS t FROM (SELECT MAX(t) AS t FROM host_raw UNION ALL SELECT MAX(t + res) FROM host_roll)").get() as { t: number | null }).t ?? 0;

// Largest first, by the share of all the memory plus the share of all the CPU: whoever holds half the memory and
// no CPU ranks with whoever uses half the CPU.
export function ranked<T>(items: T[], cpu: (item: T) => number, mem: (item: T) => number): T[] {
  const cpuAll = sum(items.map(cpu)) || 1;
  const memAll = sum(items.map(mem)) || 1;
  const score = (item: T) => cpu(item) / cpuAll + mem(item) / memAll;
  return [...items].sort((a, b) => score(b) - score(a));
}

// An average over buckets weighs each by its samples, so it is the average of the ticks.
export const mean = (column: string) => `ROUND(SUM(${column} * samples) * 1.0 / SUM(samples))`;

function samplesIn(db: Database, pieces: Piece[]) {
  const host = view(pieces, "host");
  return (db.query(`SELECT SUM(samples) AS n FROM (${host.sql})`).get(...host.args) as { n: number | null }).n ?? 0;
}

// share is of all owners' total; value is CPU milliseconds or average kB of memory, whichever the episode is about.
export type Who = { kind: OwnerKind; owner: string; share: number; value: number };

function topOwners(db: Database, pieces: Piece[], by: "cpu" | "mem"): Who[] {
  const rows = view(pieces, "rows");
  const used = db
    .query(`SELECT s.kind, s.owner, SUM(r.cpu_ms) AS cpu, SUM(r.mem_avg_kb * r.samples) * 1.0 / ? AS mem FROM ${rowsWithOwner(rows.sql)} GROUP BY s.kind, s.owner`)
    .all(samplesIn(db, pieces), ...rows.args) as { kind: OwnerKind; owner: string; cpu: number; mem: number }[];
  const all = sum(used.map((u) => u[by]));
  return used
    .filter((u) => u[by] > 0)
    .sort((a, b) => b[by] - a[by])
    .slice(0, WHO)
    .map((u) => ({ kind: u.kind, owner: u.owner, share: u[by] / all, value: Math.round(u[by]) }));
}

// A long window is walked in the finest buckets that cover it: the minutes for as far back as they are kept, the
// quarters of an hour before that. cut is where the minutes begin, on a quarter's edge so no time is read twice.
const minutesFrom = (db: Database) => Math.ceil((newest(db) - MINUTES.keepMs / 1000) / QUARTERS.res) * QUARTERS.res;
const tiers = (cut: number, from: number, to: number): Piece[] =>
  [
    { res: QUARTERS.res, from, to: Math.min(to, cut) },
    { res: MINUTES.res, from: Math.max(from, cut), to },
  ].filter((p) => p.from < p.to);

export type Bucket = BucketRow & {
  t: number;
  res: number;
  samples: number;
  mem_stored_avg_kb: number;
  swap_used_max_kb: number;
  pressure_max: number | null;
  boot_at: number | null;
  available_avg: number | null;
  available_min: number | null;
  held_avg_kb: number;
  held_max_kb: number;
  busy_max: number | null;
};
// Each bucket of the window in order, with the one before it. For the first that is the last one before the
// window, so what happened at the window's edge is not taken for a start.
function walk(db: Database, cut: number, from: number, to: number): { bucket: Bucket; prev: Bucket | null }[] {
  const read = (pieces: Piece[], order: string) => {
    if (!pieces.length) return [];
    const host = view(pieces, "host");
    return db.query(`SELECT * FROM (${host.sql}) ORDER BY ${order}`).all(...host.args) as Bucket[];
  };
  const before = read(tiers(cut, 0, from), "t DESC LIMIT 1")[0] ?? null;
  const buckets = read(tiers(cut, from, to), "t");
  return buckets.map((bucket, i) => ({ bucket, prev: i ? buckets[i - 1] : before }));
}

// peak holds what its kind of limit is read from: the busiest bucket's share of all cores, the highest memory
// pressure and how much swap grew over its buckets, the highest thermal level, the least free disk. who is the
// three owners that used most of what ran short.
export type Episode = {
  kind: LimitKind;
  level: Level;
  from: number;
  to: number;
  peak: { cpuShare?: number; pressureMax?: number; swapGrowthKb?: number; thermalMax?: number; diskFreeKb?: number };
  who: Who[];
};

type Hit = { bucket: Bucket; span: Span; level: Level };
const most = (values: (number | null)[]) => values.reduce<number | undefined>((top, v) => (v === null || (top !== undefined && top >= v) ? top : v), undefined);
// Per kind of limit: what its owners are ranked by, and its peak. Heat goes by CPU time, since work is what heats
// a machine. Nobody is blamed for a full disk: the monitor does not know whose the files are.
const KIND: Record<LimitKind, { by: "cpu" | "mem" | null; peak(hits: Hit[]): Episode["peak"] }> = {
  memory: { by: "mem", peak: (hits) => ({ pressureMax: most(hits.map((h) => h.bucket.pressure_max)), swapGrowthKb: sum(hits.map((h) => h.span.swapGrowthKb)) }) },
  cpu: { by: "cpu", peak: (hits) => ({ cpuShare: most(hits.map((h) => cpuShare(h.span))) }) },
  heat: { by: "cpu", peak: (hits) => ({ thermalMax: most(hits.map((h) => h.span.thermalMax)) }) },
  disk: { by: null, peak: (hits) => ({ diskFreeKb: Math.min(...hits.map((h) => h.span.diskFreeKb!)) }) },
};
const KINDS = Object.keys(KIND) as LimitKind[];

// What limits the machine in one bucket, by the table of rules. joined says the bucket before it is right before
// it. Swap grew since that one only when it is as long: an average over a quarter of an hour says nothing about the
// minute after it.
export type Verdict<B = Bucket> = { bucket: B; span: Span; joined: boolean; levels: Map<LimitKind, Level> };
export function verdict<B extends BucketRow & { t: number; res: number }>(bucket: B, prev: B | null): Verdict<B> {
  const joined = prev !== null && prev.t + prev.res === bucket.t;
  const span = spanOfBucket(bucket, joined && prev.res === bucket.res ? prev.swap_used_avg_kb : null);
  return { bucket, span, joined, levels: new Map(limits(span).map((limit) => [limit.kind, limit.level])) };
}

// Each bucket of a window in order with its verdict: the minutes for as far back as they are kept, the quarters
// of an hour before that.
export function verdicts(db: Database, q: { from: number; to: number }): Verdict[] {
  return walk(db, minutesFrom(db), seconds(q.from), seconds(q.to)).map(({ bucket, prev }) => verdict(bucket, prev));
}

// One kind of limit over the buckets in order. A bucket without the limit pauses an episode and the next one with
// it carries it on; a second one without it ends it. A missing bucket ends it at once: nothing is known about the
// time in between.
type State = { at: "clear" } | { at: "limited" | "paused"; hits: Hit[] };
type Seen = Hit | "nothing" | "missing";
function next(state: State, seen: Seen): { state: State; ended?: Hit[] } {
  if (typeof seen === "object") {
    const hits = state.at === "clear" ? [] : state.hits;
    hits.push(seen);
    return { state: { at: "limited", hits } };
  }
  if (state.at === "clear") return { state };
  if (state.at === "limited" && seen === "nothing") return { state: { at: "paused", hits: state.hits } };
  return { state: { at: "clear" }, ended: state.hits };
}

// The stretches in which something limited the machine, newest first.
export function episodes(db: Database, q: { from: number; to: number }): Episode[] {
  const cut = minutesFrom(db);
  const state = new Map<LimitKind, State>(KINDS.map((kind) => [kind, { at: "clear" }]));
  const found: Episode[] = [];
  const see = (kind: LimitKind, seen: Seen) => {
    const { state: now, ended } = next(state.get(kind)!, seen);
    state.set(kind, now);
    if (!ended) return;
    const first = ended[0].bucket;
    const last = ended.at(-1)!.bucket;
    const { by, peak } = KIND[kind];
    found.push({
      kind,
      level: ended.some((hit) => hit.level === "capped") ? "capped" : "tight",
      from: first.t * 1000,
      to: (last.t + last.res) * 1000,
      peak: peak(ended),
      who: by ? topOwners(db, tiers(cut, first.t, last.t + last.res), by) : [],
    });
  };
  for (const { bucket, span, joined, levels } of verdicts(db, q)) {
    for (const kind of KINDS) {
      if (!joined) see(kind, "missing");
      const level = levels.get(kind);
      see(kind, level ? { bucket, span, level } : "nothing");
    }
  }
  for (const kind of KINDS) see(kind, "missing");
  return found.sort((a, b) => b.from - a.from || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

// kind is one of the four the history finds by itself (restart, gap, lane-started, lane-ended), or the kind a mark
// was put down with (monitor-store.ts mark()).
export type Mark = { at: number; kind: string; label: string };
// A mark with the number its label is written from: how long the machine had been up before a restart, how long a
// gap lasted. A mark that was put down has none.
export type Found = Mark & { forMs?: number };

// Where the samples stop and start again. A restart is at the time the machine started, with the start of the run
// it ended and that run's last sample; a gap is at its start.
type Restart = { is: "restart"; at: number; ranFrom: number; sampledUntil: number };
type Break = Restart | { is: "gap"; at: number; forS: number };
function breaks(steps: { bucket: Bucket; prev: Bucket | null }[], from: number, to: number): Break[] {
  return steps
    .flatMap(({ bucket, prev }): Break[] => {
      if (!prev) return [];
      const end = prev.t + prev.res;
      // A machine that restarted started after the samples before it. A start time that differs and is not later
      // than those is the same run with its clock set anew.
      if (bucket.boot_at !== null && prev.boot_at !== null && bucket.boot_at !== prev.boot_at && bucket.boot_at > prev.t) {
        return [{ is: "restart", at: bucket.boot_at, ranFrom: prev.boot_at, sampledUntil: Math.min(end, bucket.boot_at) }];
      }
      // Whole buckets are missing for this long, so the samples on either side are further apart than that.
      const forS = bucket.t - end;
      return forS * 1000 >= MAX_GAP_MS ? [{ is: "gap", at: end, forS }] : [];
    })
    .filter((b) => b.at >= from && b.at < to);
}

// What happened, for the timeline: the marks that were put down (a test run, a release), restarts, gaps in the
// samples, and the lanes that started or ended inside the window. A lane that runs across the window's edge did
// neither there.
export function timeline(db: Database, q: { from: number; to: number }): Found[] {
  const cut = minutesFrom(db);
  const [from, to] = [seconds(q.from), seconds(q.to)];
  const put = (db.query("SELECT t, kind, label FROM marks WHERE t >= ? AND t < ?").all(from, to) as { t: number; kind: string; label: string }[]).map((m): Found => ({ at: m.t * 1000, kind: m.kind, label: m.label }));
  const byTime = (found: Found[]) => found.sort((a, b) => a.at - b.at || a.label.localeCompare(b.label));
  const steps = walk(db, cut, from, to);
  if (!steps.length) return byTime(put);
  const found: Found[] = breaks(steps, from, to).map((b) => {
    const forMs = (b.is === "restart" ? b.sampledUntil - b.ranFrom : b.forS) * 1000;
    return { at: b.at * 1000, kind: b.is, label: b.is === "restart" ? `restart after ${dur(forMs)} up` : `no samples for ${dur(forMs)}`, forMs };
  });
  found.push(...put);
  const first = steps[0].bucket.t;
  const last = steps.at(-1)!.bucket.t + steps.at(-1)!.bucket.res;
  const rows = view(tiers(cut, from, to), "rows");
  const lanes = db.query(`SELECT s.owner, MIN(r.t) AS first, MAX(r.t + r.res) AS last FROM ${rowsWithOwner(rows.sql)} WHERE s.kind = 'lane' GROUP BY s.owner`).all(...rows.args) as { owner: string; first: number; last: number }[];
  for (const lane of lanes) {
    if (lane.first !== first) found.push({ at: lane.first * 1000, kind: "lane-started", label: lane.owner });
    if (lane.last !== last) found.push({ at: lane.last * 1000, kind: "lane-ended", label: lane.owner });
  }
  return byTime(found);
}

export function marks(db: Database, q: { from: number; to: number }): Mark[] {
  return timeline(db, q).map(({ at, kind, label }) => ({ at, kind, label }));
}

// What keeps coming back, as the numbers behind each finding. The page makes the sentences.
//   top-in-episodes  the owner led `episodes` of the `of` episodes of that limit
//   days-above       the owner's memory reached memKb at its peak on `days` of the `of` days that have data
//   before-restart   who held the most memory in the last quarter of an hour sampled before the machine restarted at
//                    `at`, and what limited it then. Whether it was shut down or fell over is not known.
export type Fact =
  | { pattern: "top-in-episodes"; limit: LimitKind; kind: OwnerKind; owner: string; episodes: number; of: number }
  | { pattern: "days-above"; kind: OwnerKind; owner: string; memKb: number; days: number; of: number }
  | { pattern: "before-restart"; at: number; limit: LimitKind | null; kind: OwnerKind; owner: string; memKb: number };

function topInEpisodes(found: Episode[]): Fact[] {
  return KINDS.flatMap((limit) => {
    const of = found.filter((e) => e.kind === limit);
    if (of.length < EPISODES_TO_JUDGE) return [];
    const led = new Map<string, { kind: OwnerKind; owner: string; episodes: number }>();
    for (const [top] of of.map((e) => e.who)) {
      if (!top) continue;
      const key = `${top.kind}\0${top.owner}`;
      led.set(key, { kind: top.kind, owner: top.owner, episodes: (led.get(key)?.episodes ?? 0) + 1 });
    }
    return [...led.values()].filter((l) => l.episodes >= EPISODES_LED).map((l): Fact => ({ pattern: "top-in-episodes", limit, ...l, of: of.length }));
  });
}

// A day is 24 hours counted back from `to`, so no time zone decides where one ends. An owner's peak in a bucket
// is the peaks of its process groups added up, from the quarters of an hour, which reach back furthest.
function daysAbove(db: Database, from: number, to: number): Fact[] {
  const day = `CAST((? - 1 - t) / ${DAY_S} AS INTEGER)`;
  const of = (db.query(`SELECT COUNT(DISTINCT ${day}) AS n FROM host_roll WHERE res = ? AND t >= ? AND t < ?`).get(to, QUARTERS.res, from, to) as { n: number }).n;
  const peaks = db
    .query(
      `SELECT kind, owner, MAX(kb) AS kb FROM (
         SELECT ${day} AS day, s.kind, s.owner, SUM(r.mem_max_kb) AS kb FROM roll r CROSS JOIN series s ON s.id = r.sid WHERE r.res = ? AND r.t >= ? AND r.t < ? GROUP BY r.t, s.kind, s.owner
       ) GROUP BY day, kind, owner HAVING MAX(kb) >= ? ORDER BY kind, owner`,
    )
    .all(to, QUARTERS.res, from, to, DAYS_ABOVE_KB[0]) as { kind: OwnerKind; owner: string; kb: number }[];
  const byOwner = new Map<string, { kind: OwnerKind; owner: string; peaks: number[] }>();
  for (const { kind, owner, kb } of peaks) {
    const key = `${kind}\0${owner}`;
    byOwner.set(key, { kind, owner, peaks: [...(byOwner.get(key)?.peaks ?? []), kb] });
  }
  return [...byOwner.values()].flatMap(({ kind, owner, peaks }): Fact[] => {
    const passed = DAYS_ABOVE_KB.map((memKb) => ({ memKb, days: peaks.filter((kb) => kb >= memKb).length })).filter((p) => p.days >= DAYS_ABOVE);
    return passed.length ? [{ pattern: "days-above", kind, owner, ...passed.at(-1)!, of }] : [];
  });
}

// One owner's highest memory on each day that has data, oldest first, by the days and the peaks days-above counts.
// at is the day's start. On a day the owner did not run it is 0.
export function dayPeaks(db: Database, q: { now: number; days?: number; kind: OwnerKind; owner: string }): { at: number; memKb: number }[] {
  const [from, to] = [seconds(q.now) - (q.days ?? OFFENDER_DAYS) * DAY_S, seconds(q.now)];
  const peaks = db
    .query(
      `SELECT day, MAX(kb) AS kb FROM (
         SELECT CAST((? - 1 - h.t) / ${DAY_S} AS INTEGER) AS day, COALESCE(SUM(r.mem_max_kb), 0) AS kb
         FROM host_roll h LEFT JOIN roll r ON r.res = h.res AND r.t = h.t AND r.sid IN (SELECT id FROM series WHERE kind = ? AND owner = ?)
         WHERE h.res = ? AND h.t >= ? AND h.t < ? GROUP BY h.t
       ) GROUP BY day ORDER BY day DESC`,
    )
    .all(to, q.kind, q.owner, QUARTERS.res, from, to) as { day: number; kb: number }[];
  return peaks.map(({ day, kb }) => ({ at: (to - (day + 1) * DAY_S) * 1000, memKb: kb }));
}

function beforeRestart(db: Database, cut: number, restarts: Restart[], found: Episode[]): Fact[] {
  return restarts.flatMap((restart): Fact[] => {
    // Not further back than the run's own start: what an earlier run held is another restart's finding.
    const from = Math.max(restart.sampledUntil - BEFORE_RESTART_S, restart.ranFrom);
    const [top] = topOwners(db, tiers(cut, from, restart.sampledUntil), "mem");
    if (!top) return [];
    const then = found.filter((e) => e.from < restart.sampledUntil * 1000 && e.to > from * 1000);
    const limit = (then.find((e) => e.level === "capped") ?? then[0])?.kind ?? null;
    return [{ pattern: "before-restart", at: restart.at * 1000, limit, kind: top.kind, owner: top.owner, memKb: top.value }];
  });
}

// The most evidence first: the episodes led, the days above. A restart is one event, so those come last, newest
// first.
export function offenders(db: Database, q: { now: number; days?: number }): Fact[] {
  const cut = minutesFrom(db);
  const [from, to] = [seconds(q.now) - (q.days ?? OFFENDER_DAYS) * DAY_S, seconds(q.now)];
  const found = episodes(db, { from: from * 1000, to: to * 1000 });
  const restarts = breaks(walk(db, cut, from, to), from, to).filter((b): b is Restart => b.is === "restart");
  const evidence = (fact: Fact) => (fact.pattern === "top-in-episodes" ? fact.episodes : fact.pattern === "days-above" ? fact.days : 1);
  return [...topInEpisodes(found), ...daysAbove(db, from, to), ...beforeRestart(db, cut, restarts.reverse(), found)].sort((a, b) => evidence(b) - evidence(a));
}
