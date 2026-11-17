// THE MONITOR, what limits the machine: one table of rules, asked about the last minute of ticks for the verdict on
// now and about every rollup bucket for the history's episodes (monitor-history.ts), so the two cannot disagree.
// Pure: no I/O.

export type LimitKind = "memory" | "cpu" | "heat" | "disk";
export type Level = "tight" | "capped";
// A stretch of time, however long: a minute of ticks or one rollup bucket. ms is the time its samples cover.
export type Span = { ms: number; cores: number; busyMs: number; warnMs: number; criticalMs: number; swapGrowthKb: number; thermalMax: number | null; diskTotalKb: number | null; diskFreeKb: number | null };

const MB = 1024;
const GB = 1024 * MB;
// The share of a span the kernel's memory pressure must be at "warn" to count.
export const WARN_SHARE = 0.5;
export const SWAP_GROWTH_KB_PER_MIN = 100 * MB;
export const CPU_TIGHT = 0.8;
export const CPU_CAPPED = 15 / 16;
// Thermal pressure levels: 1 is moderate, 2 heavy.
export const THERMAL_TIGHT = 1;
export const THERMAL_CAPPED = 2;
const DISK_TIGHT_KB = 100 * GB;
const DISK_CAPPED_KB = 20 * GB;
// Or this part of the disk, when that is less: a tenth, a fiftieth.
const DISK_TIGHT_PART = 10;
const DISK_CAPPED_PART = 50;
// The kernel's memory pressure levels, as host_raw stores them.
const WARN = 2;
const CRITICAL = 4;

export const cpuShare = (s: Span) => s.busyMs / (s.ms * s.cores);
const warned = (s: Span) => s.warnMs >= s.ms * WARN_SHARE;
const swapGrew = (s: Span) => s.swapGrowthKb / (s.ms / 60_000) >= SWAP_GROWTH_KB_PER_MIN;

// Under how much free space a disk of this size is tight and capped: the fixed amount or its part of the disk,
// whichever is less, or a small disk would be tight for as long as it is used. A disk whose size could not be read
// goes by the fixed amounts.
export function diskLines(totalKb: number | null): { tightKb: number; cappedKb: number } {
  if (totalKb === null) return { tightKb: DISK_TIGHT_KB, cappedKb: DISK_CAPPED_KB };
  return { tightKb: Math.min(DISK_TIGHT_KB, totalKb / DISK_TIGHT_PART), cappedKb: Math.min(DISK_CAPPED_KB, totalKb / DISK_CAPPED_PART) };
}

const RULES: { kind: LimitKind; capped(s: Span): boolean; tight(s: Span): boolean }[] = [
  // The kernel's pressure and whether swap grows, never how full swap is: a machine sits at 90% swap for days and is
  // fine, and one whose swap grows by the minute is not.
  { kind: "memory", capped: (s) => s.criticalMs > 0 || (warned(s) && swapGrew(s)), tight: (s) => warned(s) || swapGrew(s) },
  { kind: "cpu", capped: (s) => cpuShare(s) >= CPU_CAPPED, tight: (s) => cpuShare(s) >= CPU_TIGHT },
  { kind: "heat", capped: (s) => s.thermalMax !== null && s.thermalMax >= THERMAL_CAPPED, tight: (s) => s.thermalMax !== null && s.thermalMax >= THERMAL_TIGHT },
  { kind: "disk", capped: (s) => s.diskFreeKb !== null && s.diskFreeKb < diskLines(s.diskTotalKb).cappedKb, tight: (s) => s.diskFreeKb !== null && s.diskFreeKb < diskLines(s.diskTotalKb).tightKb },
];

// What limits the machine in a span, in the table's order. Empty: nothing does. A span that covers no time says
// nothing.
export function limits(span: Span): { kind: LimitKind; level: Level }[] {
  if (span.ms <= 0) return [];
  return RULES.flatMap(({ kind, capped, tight }): { kind: LimitKind; level: Level }[] => (capped(span) ? [{ kind, level: "capped" }] : tight(span) ? [{ kind, level: "tight" }] : []));
}

// The columns of host_raw and of host_roll a span is made from.
export type TickRow = { dt_ms: number; cores: number; busy_ms: number; swap_used_kb: number; pressure: number | null; thermal: number | null; disk_total_kb: number | null; disk_free_kb: number | null };
export type BucketRow = { covered_ms: number; cores: number; busy_ms: number; warn_ms: number; critical_ms: number; swap_used_avg_kb: number; thermal_max: number | null; disk_total_kb: number | null; disk_free_min_kb: number | null };

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
// The largest or the smallest of the values that could be read; null when none could.
const extreme = (pick: (...v: number[]) => number, values: (number | null)[]) => {
  const read = values.filter((v): v is number => v !== null);
  return read.length ? pick(...read) : null;
};

// host_raw rows in the order of their time, and the tick right before the first, null when there is none. Swap grew by
// what each tick holds more than the tick before it, so the growth is over the time ms counts: six ticks are 60 s of
// it, where the first tick to the last is 50 s. A tick that covers no time, the first after a start or a gap, adds
// none: what swap did while nobody watched is not growth in this span.
export function spanOfTicks(rows: TickRow[], before: TickRow | null): Span {
  const msAt = (level: number) => sum(rows.filter((r) => r.pressure === level).map((r) => r.dt_ms));
  const swapGrew = (r: TickRow, prev: TickRow | null) => (prev && r.dt_ms > 0 ? r.swap_used_kb - prev.swap_used_kb : 0);
  return {
    ms: sum(rows.map((r) => r.dt_ms)),
    cores: Math.max(0, ...rows.map((r) => r.cores)),
    busyMs: sum(rows.map((r) => r.busy_ms)),
    warnMs: msAt(WARN),
    criticalMs: msAt(CRITICAL),
    swapGrowthKb: sum(rows.map((r, i) => swapGrew(r, i ? rows[i - 1] : before))),
    thermalMax: extreme(Math.max, rows.map((r) => r.thermal)),
    diskTotalKb: extreme(Math.max, rows.map((r) => r.disk_total_kb)),
    diskFreeKb: extreme(Math.min, rows.map((r) => r.disk_free_kb)),
  };
}

// One host_roll row. swapBefore is swap_used_avg_kb of the bucket right before it, null when there is none: then
// nothing is known about growth, and it counts as none.
export function spanOfBucket(row: BucketRow, swapBefore: number | null): Span {
  return {
    ms: row.covered_ms,
    cores: row.cores,
    busyMs: row.busy_ms,
    warnMs: row.warn_ms,
    criticalMs: row.critical_ms,
    swapGrowthKb: swapBefore === null ? 0 : row.swap_used_avg_kb - swapBefore,
    thermalMax: row.thermal_max,
    diskTotalKb: row.disk_total_kb,
    diskFreeKb: row.disk_free_min_kb,
  };
}
