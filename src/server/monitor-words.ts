// THE MONITOR's sentences: every line on the page that is made from data (monitor-page.ts gives the numbers). They
// say what was measured and never why it happened, because the data shows no cause. Memory is GB, CPU is cores, swap
// growth is MB a minute, a time is epoch milliseconds. Pure, with no I/O.
import type { LimitKind } from "./monitor-limits.ts";

export const STATE_WORDS = ["Not capped", "Close to the cap", "Capped"] as const;

export type PressureLevel = "normal" | "warn" | "critical";
// The kernel's levels from calm to worst: a sample of a range carries its level as an index into this.
export const LEVELS: PressureLevel[] = ["normal", "warn", "critical"];
// What the data gives as the reason for a limit. For memory, pressure is the level that counted and swapMBPerMin
// the growth that counted; each is null when it was not part of the verdict.
// percent is the share of memory the kernel does not count as available, null when it could not be read.
export type Cause =
  | { limiter: "memory"; pressure: "warn" | "critical" | null; percent: number | null; swapMBPerMin: number | null }
  | { limiter: "cpu"; busy: number; cores: number }
  | { limiter: "heat"; thermal: number }
  | { limiter: "disk"; freeGB: number };
export type Verdict = { state: 0 } | { state: 1 | 2; cause: Cause };

// A holder as a sentence names it, with what it holds or uses.
export type Share = { label: string; value: number };

export const LIMIT: Record<LimitKind, string> = { memory: "memory", cpu: "CPU", heat: "heat", disk: "disk" };
const LEVEL: Record<PressureLevel, string> = { normal: "normal", warn: "warning", critical: "critical" };
const THERMAL = ["cool", "moderate", "heavy", "trapping", "sleeping"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOBODY = "The monitor does not record whose files fill the disk.";
const BEFORE = 3;

const one = (v: number) => v.toFixed(1);
const gb = (v: number) => `${one(v)} GB`;
const wholeGb = (v: number) => `${Math.round(v)} GB`;
const percent = (v: number) => `${Math.round(v)}%`;
const single = (v: number) => one(v) === "1.0";
const cores = (v: number) => `${one(v)} ${single(v) ? "core" : "cores"}`;
const size = (mb: number) => (mb >= 1000 ? gb(mb / 1024) : `${Math.round(mb)} MB`);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
// Only the words this file put in front of a name get a capital. An app's own name may start in lower case.
const opening = (label: string) => (/^(lane|pane) /.test(label) ? capital(label) : label);

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);

export const laneLabel = (name: string) => `lane ${name}`;
// A pane with all of the folder it was recorded by.
export const paneLabel = (folder: string) => `pane ${folder}`;

// What each of the panes shown together is called: its folder's last name, with the folder before it when two of
// them share that name, and all of the folder when that does not tell them apart either.
export function paneNames(folders: Iterable<string>): Map<string, string> {
  const all = [...new Set(folders)];
  const last = (folder: string) => folder.split("/").at(-1) || folder;
  const withParent = (folder: string) => (folder.split("/").at(-2) ? `${last(folder)} (${folder.split("/").at(-2)})` : folder);
  const alone = (said: (folder: string) => string, folder: string) => all.filter((other) => said(other) === said(folder)).length === 1;
  return new Map(all.map((folder) => [folder, paneLabel(alone(last, folder) ? last(folder) : alone(withParent, folder) ? withParent(folder) : folder)]));
}

// The names of the three rows the monitor makes itself (monitor-usage.ts), as the page writes them.
const PARTS = new Map([
  ["(exited)", "short-lived processes"],
  ["(small)", "many small processes"],
  ["(unattributed)", "kernel and unattributed"],
]);
export const partName = (name: string) => PARTS.get(name) ?? name;

// Processes that fit no lane and no app are recorded under the folder they run in, and under "other" when that says
// nothing. The page has a holder called Other apps, so those go by a name that cannot be taken for it.
const UNSORTED = "Unsorted processes";
export const unsortedLabel = (owner: string) => (owner === "other" ? UNSORTED : owner);

export const NOTES = {
  lane: "A herdr lane, with everything it started",
  pane: "A herdr pane without a named agent, with everything it started",
  app: "An app, with all its helpers",
  other: "Processes that fit no lane and no app, by the folder they run in where there is one",
  hq: "The HQ Office server and what it starts",
  lanes: "Every smaller lane and pane",
  apps: "Every smaller app, each with its helpers",
  system: "The system, its kernel and the CPU no process accounts for",
};

export function duration(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} min`;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// A time zone: how many minutes east of UTC its clocks are at a time. A function of the time and not one number,
// because the clocks change: a past time is printed by the offset of its own date, and a day starts at its own
// midnight.
export type Zone = (t: number) => number;

export function when(t: number, zone: Zone) {
  const local = new Date(t + zone(t) * 60_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} at ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
}

// Why a limit was reached, in the fewest words. The page fills the same phrases for a sample of the past.
const REASON = {
  pressure: "pressure {level} ({percent})",
  level: "pressure {level}",
  swap: "swap growing {rate} a minute",
  cpu: "{busy} of {cores} cores busy",
  heat: "thermal pressure {level}",
  disk: "{free} of disk free",
  join: ", ",
};

function reason(cause: Cause) {
  switch (cause.limiter) {
    case "memory":
      return [
        ...(cause.pressure ? [fill(cause.percent === null ? REASON.level : REASON.pressure, { level: LEVEL[cause.pressure], percent: percent(cause.percent ?? 0) })] : []),
        ...(cause.swapMBPerMin !== null ? [fill(REASON.swap, { rate: size(cause.swapMBPerMin) })] : []),
      ].join(REASON.join);
    case "cpu":
      return fill(REASON.cpu, { busy: one(cause.busy), cores: String(cause.cores) });
    case "heat":
      return fill(REASON.heat, { level: THERMAL[cause.thermal] });
    case "disk":
      return fill(REASON.disk, { free: wholeGb(cause.freeGB) });
  }
}

export function headline(machine: string, verdict: Verdict) {
  if (verdict.state === 0) return `${capital(machine)} is not capped right now.`;
  const what = `${capital(LIMIT[verdict.cause.limiter])} is ${verdict.state === 2 ? "capped" : "close to the cap"}`;
  const why = reason(verdict.cause);
  return why ? `${what}: ${why}.` : `${what}.`;
}

// Who holds most of the memory or uses most of the CPU, largest first, and their share of the total.
export function holding(top: Share[], total: number, of: "memory" | "cpu", tense: "now" | "then") {
  if (!top.length || total <= 0) return "";
  const amount = of === "memory" ? gb : cores;
  const names = list(top.map((s, i) => `${i ? s.label : opening(s.label)} (${amount(s.value)})`));
  const share = percent((top.reduce((sum, s) => sum + s.value, 0) / total) * 100);
  const [past, alone] = [tense === "then", top.length === 1];
  if (of === "memory") return `${names} ${past ? "held" : alone ? "holds" : "hold"} ${share} of the ${gb(total)} that processes ${past ? "held" : "hold"}.`;
  const are = past ? (single(total) ? "was" : "were") : single(total) ? "is" : "are";
  return `${names} ${past ? "used" : alone ? "uses" : "use"} ${share} of the ${cores(total)} that ${are} busy.`;
}

// The line under the headline: who holds most of what ran short, and most of the memory when nothing did. Nobody is
// named for a full disk.
export function blame(limiter: LimitKind | null, mem: { top: Share[]; total: number }, cpu: { top: Share[]; total: number }, tense: "now" | "then") {
  if (limiter === "disk") return NOBODY;
  return limiter === "cpu" || limiter === "heat" ? holding(cpu.top, cpu.total, "cpu", tense) : holding(mem.top, mem.total, "memory", tense);
}

// The line under the blame: the numbers behind the verdict, whatever the verdict is. Without a verb, so the page
// fills the same phrases for a sample of the past.
const DETAIL = {
  pressure: "Pressure {level}, {available} of memory available.",
  level: "Pressure {level}.",
  compressed: "{stored} compressed into {compressed}.",
  swap: "Swap {used} of {total}, {trend}.",
  noSwap: "No swap.",
  busy: "{busy} of {cores} cores busy.",
  disk: "{free} of disk free.",
  steady: "steady",
  growing: "growing {rate} a minute",
  shrinking: "shrinking {rate} a minute",
};

function swapTrend(mbPerMin: number | null) {
  const moved = mbPerMin === null ? 0 : Math.round(mbPerMin);
  return moved ? fill(moved > 0 ? DETAIL.growing : DETAIL.shrinking, { rate: size(Math.abs(moved)) }) : DETAIL.steady;
}

// A figure that could not be read has no phrase.
export function detail(host: {
  level: PressureLevel | null;
  available: number | null;
  storedGB: number;
  compressedGB: number;
  swapUsedGB: number;
  swapTotalGB: number;
  swapMBPerMin: number | null;
  busy: number | null;
  cores: number;
  diskFreeGB: number | null;
}) {
  const lines: string[] = [];
  if (host.level) lines.push(fill(host.available === null ? DETAIL.level : DETAIL.pressure, { level: LEVEL[host.level], available: percent(host.available ?? 0) }));
  if (host.storedGB > 0) lines.push(fill(DETAIL.compressed, { stored: gb(host.storedGB), compressed: gb(host.compressedGB) }));
  lines.push(host.swapTotalGB > 0 ? fill(DETAIL.swap, { used: one(host.swapUsedGB), total: gb(host.swapTotalGB), trend: swapTrend(host.swapMBPerMin) }) : DETAIL.noSwap);
  if (host.busy !== null) lines.push(fill(DETAIL.busy, { busy: one(host.busy), cores: String(host.cores) }));
  if (host.diskFreeGB !== null) lines.push(fill(DETAIL.disk, { free: wholeGb(host.diskFreeGB) }));
  return lines.join(" ");
}

// What an incident's kind of limit read at its worst. For memory, pressure is the percent of memory the kernel did
// not count as available and level the highest level it reached.
export type Peak =
  | { resource: "memory"; pressure: number | null; level: PressureLevel | null; swapGrewGB: number }
  | { resource: "cpu"; busy: number; cores: number }
  | { resource: "heat"; thermal: number }
  | { resource: "disk"; freeGB: number };

// before is the marks that came ahead of the incident, with how long ahead.
export type IncidentFacts = {
  severity: 1 | 2;
  ms: number;
  cappedMs: number;
  ongoing: boolean;
  peak: Peak;
  mem: { top: Share[]; total: number };
  cpu: { top: Share[]; total: number };
  before: { label: string; ms: number }[];
};

export function incidentHeadline(f: IncidentFacts) {
  const what = capital(LIMIT[f.peak.resource]);
  const was = f.ongoing ? "has been" : "was";
  if (f.severity === 1) return `${what} ${was} close to the cap for ${duration(f.ms)}.`;
  if (f.cappedMs >= f.ms) return `${what} ${was} capped for ${duration(f.ms)}.`;
  return f.ongoing ? `${what} has been capped for ${duration(f.cappedMs)} of the last ${duration(f.ms)}.` : `${what} ran short for ${duration(f.ms)} and was capped for ${duration(f.cappedMs)} of it.`;
}

function atPeak(peak: Peak) {
  switch (peak.resource) {
    case "memory": {
      const level = peak.level ? `the kernel's ${LEVEL[peak.level]} level` : "";
      const reached = peak.pressure === null ? (level ? `Memory pressure reached ${level}.` : "") : `Memory pressure peaked at ${percent(peak.pressure)}${level ? `, at ${level}` : ""}.`;
      const swap = peak.swapGrewGB >= 0.05 ? `Swap grew by ${gb(peak.swapGrewGB)} over it.` : "Swap did not grow over it.";
      return [reached, swap].filter(Boolean).join(" ");
    }
    case "cpu":
      return `At its peak ${one(peak.busy)} of ${peak.cores} cores were busy.`;
    case "heat":
      return `The thermal pressure reached ${THERMAL[peak.thermal]}.`;
    case "disk":
      return `Free disk fell to ${wholeGb(peak.freeGB)}.`;
  }
}

// The peak, who held most of what ran short at the peak, and the last marks before it began. A mark is given with
// how long before. Whether it caused anything is not in the data.
export function incidentSummary(f: IncidentFacts) {
  const marks = f.before.slice(-BEFORE).map((m) => `${capital(m.label)} ${duration(m.ms)} before it.`);
  return [atPeak(f.peak), blame(f.peak.resource, f.mem, f.cpu, "then"), ...marks].filter(Boolean).join(" ");
}

// Nobody leads the episodes of a full disk, because the monitor does not know whose the files are.
export type Blamed = Exclude<LimitKind, "disk">;
const SHORT: Record<Blamed, { held: string; ran: string; was: string }> = {
  memory: { held: "held the most memory", ran: "memory ran short", was: "memory was close to the cap or capped" },
  cpu: { held: "used the most CPU", ran: "CPU ran short", was: "CPU was close to the cap or capped" },
  heat: { held: "used the most CPU", ran: "the machine ran hot", was: "the thermal pressure was moderate or worse" },
};

// The numbers behind one finding (monitor-history.ts offenders), with the holder as a sentence names it.
//   top-in-episodes  it led `episodes` of the `of` episodes of that limit in the last `window` days
//   days-above       its memory reached `gb` on `days` of the `of` days with data in the last `window` days;
//                    highest and lowest are its daily peaks
//   before-restart   it held `gb`, the most of any holder over the last `overMs` sampled before the restart at `at`;
//                    limit is what limited the machine then
export type PatternFacts =
  | { pattern: "top-in-episodes"; label: string; limit: Blamed; episodes: number; of: number; window: number }
  | { pattern: "days-above"; label: string; gb: number; days: number; of: number; window: number; highest: number; lowest: number }
  | { pattern: "before-restart"; label: string; gb: number; overMs: number; at: number; zone: Zone; limit: LimitKind | null };

// The two sides of the count behind a top-in-episodes finding.
export const leaders = (label: string, limit: Blamed) => [`${opening(label)} ${SHORT[limit].held}`, `Another holder ${SHORT[limit].held}`];

export function patternWords(f: PatternFacts): { title: string; detail: string } {
  const who = opening(f.label);
  switch (f.pattern) {
    case "top-in-episodes":
      return {
        title: `${who} ${SHORT[f.limit].held} in ${f.episodes} of the ${f.of} times ${SHORT[f.limit].ran} in the last ${f.window} days`,
        detail: `Each time is one stretch in which ${SHORT[f.limit].was}, and it counts for the holder that ${SHORT[f.limit].held} over it.`,
      };
    case "days-above":
      return {
        title: `${who} at or above ${wholeGb(f.gb)} on ${f.days} of the ${f.of === f.window ? `last ${f.of} days` : `${f.of} days recorded`}`,
        detail: `Its highest daily peak was ${gb(f.highest)} and its lowest was ${gb(f.lowest)}.`,
      };
    case "before-restart":
      return {
        title: `${who} held ${gb(f.gb)} before the restart on ${when(f.at, f.zone)}`,
        detail: `That was more than any other holder held over the last ${duration(f.overMs)} sampled before it, and ${f.limit ? LIMIT[f.limit] : "nothing"} was the limit then.`,
      };
  }
}

// A mark on the timeline, as the page labels it. text is a lane's name or what a mark was put down with; forMs is
// how long the machine had been up before a restart, or how long a gap lasted.
export function eventLabel(e: { kind: string; text: string; forMs?: number }) {
  if (e.kind === "lane-start") return `${capital(laneLabel(e.text))} started`;
  if (e.kind === "lane-end") return `${capital(laneLabel(e.text))} ended`;
  if (e.kind === "reboot" && e.forMs !== undefined) return `The machine restarted after ${duration(e.forMs)} up`;
  if (e.kind === "gap" && e.forMs !== undefined) return `No samples for ${duration(e.forMs)}`;
  return capital(e.text);
}

// What the page says by itself, because no request keeps up with a pointer that drags through time: the three
// states with what each means under these limits, and the phrases of a past sample, which the page fills in.
// {list} is the holders with their amounts, {share} their percentage, {total} what all held or used. A past
// headline takes {time} and {why}, which is past.why around the reasons that apply, joined by reason.join, or
// nothing.
export function pageWords(
  machine: string,
  allCores: number,
  l: { warnShare: number; swapGrowthMBPerMin: number; cpuTight: number; cpuCapped: number; thermalTight: number; thermalCapped: number; diskTight: number; diskCapped: number },
) {
  const kinds = Object.keys(LIMIT) as LimitKind[];
  const was = (how: string) => Object.fromEntries(kinds.map((kind) => [kind, `${capital(LIMIT[kind])} was ${how} at {time}{why}.`])) as Record<LimitKind, string>;
  return {
    states: [
      { state: 0, label: STATE_WORDS[0], meaning: "The kernel's memory pressure is normal, swap is not growing fast, and CPU, disk and heat have room." },
      {
        state: 1,
        label: STATE_WORDS[1],
        meaning: `The kernel's memory pressure is at its ${LEVEL.warn} level for ${percent(l.warnShare * 100)} of a minute or more, or swap grows by ${size(l.swapGrowthMBPerMin)} a minute, or ${l.cpuTight} of ${allCores} cores are busy, or under ${l.diskTight} GB of disk is free, or the thermal pressure is ${THERMAL[l.thermalTight]}.`,
      },
      {
        state: 2,
        label: STATE_WORDS[2],
        meaning: `The kernel's memory pressure is at its ${LEVEL.critical} level, or at its ${LEVEL.warn} level while swap grows that fast, or ${l.cpuCapped} of ${allCores} cores are busy, or under ${l.diskCapped} GB of disk is free, or the thermal pressure is ${THERMAL[l.thermalCapped]} or worse.`,
      },
    ],
    limiters: kinds.map((id) => ({ id, label: LIMIT[id] })),
    levels: LEVELS.map((level) => LEVEL[level]),
    thermal: THERMAL,
    past: {
      calm: `${capital(machine)} was not capped at {time}.`,
      close: was("close to the cap"),
      capped: was("capped"),
      why: ": {reasons}",
      held: "{list} held {share} of the {total} that processes held.",
      used: "{list} used {share} of the busy CPU, {total}.",
      nobody: NOBODY,
    },
    reason: REASON,
    detail: DETAIL,
    // The moment shown when it is not now, and the state of now beside it.
    viewing: "Viewing {when}, {ago} ago",
    live: "Now: {state}",
    began: "Recording began {when}. The strip starts there.",
    noSamples: "No samples at this moment.",
  };
}
