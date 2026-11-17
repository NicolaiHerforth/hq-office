// THE MONITOR's sentences (monitor-words.ts): every form, word for word, and that no number stands without its unit.
import { describe, expect, test } from "bun:test";
import {
  blame, detail, duration, eventLabel, headline, holding, incidentHeadline, incidentSummary, leaders, pageWords, paneNames, partName, patternWords, STATE_WORDS, unsortedLabel, when,
  type IncidentFacts, type Share,
} from "../../src/server/monitor-words.ts";
import { zoneNamed } from "../zone.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const three: Share[] = [
  { label: "Containers", value: 12.74 },
  { label: "lane builder", value: 9.41 },
  { label: "Browser", value: 5.2 },
];
const calmHost = { level: "normal" as const, available: 49, storedGB: 43.3, compressedGB: 10.8, swapUsedGB: 12.4, swapTotalGB: 14, swapMBPerMin: 0.2, busy: 4.4, cores: 16, diskFreeGB: 166.2 };
const incident = (more: Partial<IncidentFacts> = {}): IncidentFacts => ({
  severity: 2,
  ms: 73 * MINUTE,
  cappedMs: 19 * MINUTE,
  ongoing: false,
  peak: { resource: "memory", pressure: 96.2, level: "critical", swapGrewGB: 2.13 },
  mem: { top: three, total: 60.4 },
  cpu: { top: [{ label: "lane builder", value: 6.2 }], total: 12.6 },
  before: [],
  ...more,
});

// A number has its unit when a unit follows it, or "of" and then another number, which is checked like any other. A
// time of day and the day of a month are not amounts.
const UNIT = /^(%| (GB|MB|cores?|min|h|s|days?|times)\b| of (the |the last )?\d)/;
function unitless(sentence: string): string[] {
  const text = sentence.replace(/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) at \d{2}:\d{2}\b/g, "a time");
  return [...text.matchAll(/\d+(\.\d+)?/g)].filter((n) => !UNIT.test(text.slice(n.index + n[0].length))).map((n) => n[0]);
}

test("the three states have fixed words", () => {
  expect([...STATE_WORDS]).toEqual(["Not capped", "Close to the cap", "Capped"]);
});

describe("the headline", () => {
  test("nothing is the limit: it says so, with the machine's name", () => {
    expect(headline("forge", { state: 0 })).toBe("Forge is not capped right now.");
  });

  test("memory: the pressure level with its percentage and how fast swap grows, each only when it counted", () => {
    expect(headline("forge", { state: 1, cause: { limiter: "memory", pressure: "warn", percent: 71.4, swapMBPerMin: null } })).toBe("Memory is close to the cap: pressure warning (71%).");
    expect(headline("forge", { state: 1, cause: { limiter: "memory", pressure: null, percent: 40, swapMBPerMin: 240.4 } })).toBe("Memory is close to the cap: swap growing 240 MB a minute.");
    expect(headline("forge", { state: 2, cause: { limiter: "memory", pressure: "critical", percent: null, swapMBPerMin: null } })).toBe("Memory is capped: pressure critical.");
    expect(headline("forge", { state: 2, cause: { limiter: "memory", pressure: "warn", percent: 80, swapMBPerMin: 1536 } })).toBe("Memory is capped: pressure warning (80%), swap growing 1.5 GB a minute.");
  });

  test("it never says how full swap is", () => {
    for (const pressure of ["warn", "critical", null] as const) {
      for (const swapMBPerMin of [null, 300]) expect(headline("forge", { state: 2, cause: { limiter: "memory", pressure, percent: 80, swapMBPerMin } })).not.toMatch(/full|swap (?!growing)|of swap/);
    }
  });

  test("CPU, heat and disk: the limit and the reading behind it", () => {
    expect(headline("forge", { state: 1, cause: { limiter: "cpu", busy: 13.12, cores: 16 } })).toBe("CPU is close to the cap: 13.1 of 16 cores busy.");
    expect(headline("forge", { state: 2, cause: { limiter: "cpu", busy: 15.4, cores: 16 } })).toBe("CPU is capped: 15.4 of 16 cores busy.");
    expect(headline("forge", { state: 1, cause: { limiter: "heat", thermal: 1 } })).toBe("Heat is close to the cap: thermal pressure moderate.");
    expect(headline("forge", { state: 2, cause: { limiter: "heat", thermal: 2 } })).toBe("Heat is capped: thermal pressure heavy.");
    expect(headline("forge", { state: 1, cause: { limiter: "disk", freeGB: 86.4 } })).toBe("Disk is close to the cap: 86 GB of disk free.");
    expect(headline("forge", { state: 2, cause: { limiter: "disk", freeGB: 12.2 } })).toBe("Disk is capped: 12 GB of disk free.");
  });
});

describe("who holds most", () => {
  test("memory now: each holder with what it holds, and their share of everything held", () => {
    // 12.74 + 9.41 + 5.2 of 59.8 GB is 45.7%.
    expect(holding(three, 59.8, "memory", "now")).toBe("Containers (12.7 GB), lane builder (9.4 GB) and Browser (5.2 GB) hold 46% of the 59.8 GB that processes hold.");
  });

  test("a lane or a pane that opens the sentence gets a capital, an app keeps its own spelling", () => {
    expect(holding([three[1], three[0]], 59.8, "memory", "now")).toBe("Lane builder (9.4 GB) and Containers (12.7 GB) hold 37% of the 59.8 GB that processes hold.");
    expect(holding([{ label: "pane ~/work", value: 2 }], 8, "memory", "now")).toBe("Pane ~/work (2.0 GB) holds 25% of the 8.0 GB that processes hold.");
    expect(holding([{ label: "iEdit", value: 2 }], 8, "memory", "now")).toBe("iEdit (2.0 GB) holds 25% of the 8.0 GB that processes hold.");
  });

  test("CPU now, and both in the past", () => {
    expect(holding([{ label: "lane builder", value: 6.2 }, { label: "Containers", value: 1.1 }], 12.6, "cpu", "now")).toBe("Lane builder (6.2 cores) and Containers (1.1 cores) use 58% of the 12.6 cores that are busy.");
    expect(holding([{ label: "Browser", value: 0.5 }], 1.0, "cpu", "now")).toBe("Browser (0.5 cores) uses 50% of the 1.0 core that is busy.");
    expect(holding(three, 60.4, "memory", "then")).toBe("Containers (12.7 GB), lane builder (9.4 GB) and Browser (5.2 GB) held 45% of the 60.4 GB that processes held.");
    expect(holding([{ label: "Browser", value: 1.04 }], 12.6, "cpu", "then")).toBe("Browser (1.0 core) used 8% of the 12.6 cores that were busy.");
  });

  test("with nobody to name there is no sentence", () => {
    expect(holding([], 59.8, "memory", "now")).toBe("");
    expect(holding(three, 0, "cpu", "now")).toBe("");
  });

  test("the line under the headline is about what ran short: memory unless CPU or heat is the limit, and nobody for a full disk", () => {
    const mem = { top: [three[0]], total: 59.8 };
    const cpu = { top: [{ label: "lane builder", value: 6.2 }], total: 12.6 };
    expect(blame(null, mem, cpu, "now")).toBe("Containers (12.7 GB) holds 21% of the 59.8 GB that processes hold.");
    expect(blame("memory", mem, cpu, "now")).toBe("Containers (12.7 GB) holds 21% of the 59.8 GB that processes hold.");
    expect(blame("cpu", mem, cpu, "now")).toBe("Lane builder (6.2 cores) uses 49% of the 12.6 cores that are busy.");
    expect(blame("heat", mem, cpu, "now")).toBe("Lane builder (6.2 cores) uses 49% of the 12.6 cores that are busy.");
    expect(blame("disk", mem, cpu, "now")).toBe("The monitor does not record whose files fill the disk.");
  });
});

describe("the numbers behind the verdict on now", () => {
  test("pressure, compression, swap and its trend, CPU and disk", () => {
    expect(detail(calmHost)).toBe("Pressure normal, 49% of memory available. 43.3 GB compressed into 10.8 GB. Swap 12.4 of 14.0 GB, steady. 4.4 of 16 cores busy. 166 GB of disk free.");
  });

  test("swap that grows or shrinks says by how much a minute", () => {
    expect(detail({ ...calmHost, level: "warn", swapMBPerMin: 240 })).toStartWith("Pressure warning, 49% of memory available.");
    expect(detail({ ...calmHost, swapMBPerMin: 240 })).toContain("Swap 12.4 of 14.0 GB, growing 240 MB a minute.");
    expect(detail({ ...calmHost, swapMBPerMin: -1200 })).toContain("Swap 12.4 of 14.0 GB, shrinking 1.2 GB a minute.");
  });

  test("what could not be read has no phrase", () => {
    expect(detail({ ...calmHost, level: null, available: null, storedGB: 0, swapTotalGB: 0, busy: null, diskFreeGB: null })).toBe("No swap.");
    expect(detail({ ...calmHost, available: null, busy: null, diskFreeGB: null })).toBe("Pressure normal. 43.3 GB compressed into 10.8 GB. Swap 12.4 of 14.0 GB, steady.");
  });

  test("the page gets the same phrases, to fill for a sample of the past", () => {
    const said = pageWords("forge", 16, LIMITS).detail;
    const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);
    const lines = [
      fill(said.pressure, { level: "normal", available: "49%" }), fill(said.compressed, { stored: "43.3 GB", compressed: "10.8 GB" }), fill(said.swap, { used: "12.4", total: "14.0 GB", trend: said.steady }),
      fill(said.busy, { busy: "4.4", cores: "16" }), fill(said.disk, { free: "166 GB" }),
    ];
    expect(lines.join(" ")).toBe(detail(calmHost));
  });
});

describe("a pane's name", () => {
  const names = (...folders: string[]) => [...paneNames(folders).values()];

  test("the last name of its folder", () => {
    expect(names("~/…/shop-web/shop-web", "~/work/shop", "~/notes", "~")).toEqual(["pane shop-web", "pane shop", "pane notes", "pane ~"]);
  });

  test("a label that is no path stays whole", () => {
    expect(names("a temp folder", "w1:p2", "/")).toEqual(["pane a temp folder", "pane w1:p2", "pane /"]);
  });

  test("two that share a last name each add the folder before it, and the others stay short", () => {
    expect(names("~/…/trees/shop-web", "~/…/shop-web/shop-web", "~/work/api")).toEqual(["pane shop-web (trees)", "pane shop-web (shop-web)", "pane api"]);
    expect(names("~/shop", "~/work/shop")).toEqual(["pane shop (~)", "pane shop (work)"]);
  });

  test("two that share the folder before it too keep all of the folder", () => {
    expect(names("~/…/trees/shop", "…/trees/shop", "/shop")).toEqual(["pane ~/…/trees/shop", "pane …/trees/shop", "pane /shop"]);
  });

  test("a folder named twice is one pane", () => {
    expect(names("~/work/shop", "~/work/shop")).toEqual(["pane shop"]);
  });
});

describe("an incident", () => {
  test("the headline: what limited the machine and for how long", () => {
    expect(incidentHeadline(incident({ severity: 1, cappedMs: 0 }))).toBe("Memory was close to the cap for 1 h 13 min.");
    expect(incidentHeadline(incident())).toBe("Memory ran short for 1 h 13 min and was capped for 19 min of it.");
    expect(incidentHeadline(incident({ ms: 19 * MINUTE }))).toBe("Memory was capped for 19 min.");
    expect(incidentHeadline(incident({ peak: { resource: "cpu", busy: 15.4, cores: 16 }, ms: 3 * MINUTE, cappedMs: 3 * MINUTE }))).toBe("CPU was capped for 3 min.");
  });

  test("one that is still going on is in the present", () => {
    expect(incidentHeadline(incident({ severity: 1, ongoing: true }))).toBe("Memory has been close to the cap for 1 h 13 min.");
    expect(incidentHeadline(incident({ ongoing: true }))).toBe("Memory has been capped for 19 min of the last 1 h 13 min.");
    expect(incidentHeadline(incident({ ongoing: true, peak: { resource: "disk", freeGB: 12 }, ms: 72 * HOUR, cappedMs: 72 * HOUR }))).toBe("Disk has been capped for 3 days.");
  });

  test("the summary: the peak, who held most of what ran short, and the marks before it", () => {
    expect(incidentSummary(incident({ before: [{ label: "Lane builder started", ms: 12 * MINUTE }, { label: "full suite started", ms: 4 * MINUTE }] }))).toBe(
      "Memory pressure peaked at 96%, at the kernel's critical level. Swap grew by 2.1 GB over it. Containers (12.7 GB), lane builder (9.4 GB) and Browser (5.2 GB) held 45% of the 60.4 GB that processes held. Lane builder started 12 min before it. Full suite started 4 min before it.",
    );
  });

  test("memory without swap growth, and without a reading of the pressure", () => {
    expect(incidentSummary(incident({ peak: { resource: "memory", pressure: 71, level: "warn", swapGrewGB: 0 }, mem: { top: [], total: 0 } }))).toBe("Memory pressure peaked at 71%, at the kernel's warning level. Swap did not grow over it.");
    expect(incidentSummary(incident({ peak: { resource: "memory", pressure: null, level: "critical", swapGrewGB: 0 }, mem: { top: [], total: 0 } }))).toBe("Memory pressure reached the kernel's critical level. Swap did not grow over it.");
  });

  test("CPU and heat name who used the CPU, a full disk names nobody", () => {
    expect(incidentSummary(incident({ peak: { resource: "cpu", busy: 15.4, cores: 16 } }))).toBe("At its peak 15.4 of 16 cores were busy. Lane builder (6.2 cores) used 49% of the 12.6 cores that were busy.");
    expect(incidentSummary(incident({ peak: { resource: "heat", thermal: 2 } }))).toBe("The thermal pressure reached heavy. Lane builder (6.2 cores) used 49% of the 12.6 cores that were busy.");
    expect(incidentSummary(incident({ peak: { resource: "disk", freeGB: 12.4 } }))).toBe("Free disk fell to 12 GB. The monitor does not record whose files fill the disk.");
  });

  test("only the last three marks before it are named, and none is called a cause", () => {
    const before = [40, 30, 20, 10].map((minutes) => ({ label: `mark ${minutes}`, ms: minutes * MINUTE }));
    const summary = incidentSummary(incident({ before }));
    expect(summary).not.toContain("Mark 40");
    expect(summary).toEndWith("Mark 30 30 min before it. Mark 20 20 min before it. Mark 10 10 min before it.");
    expect(summary).not.toMatch(/because|caused|took|due to|led to/);
  });
});

describe("a pattern", () => {
  test("days-above: the finding with its numbers, then the spread of the daily peaks", () => {
    expect(patternWords({ pattern: "days-above", label: "Containers", gb: 8, days: 11, of: 14, window: 14, highest: 15.3, lowest: 5.62 })).toEqual({
      title: "Containers at or above 8 GB on 11 of the last 14 days",
      detail: "Its highest daily peak was 15.3 GB and its lowest was 5.6 GB.",
    });
  });

  test("days-above: with fewer days recorded than asked about it says so", () => {
    expect(patternWords({ pattern: "days-above", label: "lane builder", gb: 4, days: 3, of: 4, window: 14, highest: 6, lowest: 4.5 }).title).toBe("Lane builder at or above 4 GB on 3 of the 4 days recorded");
  });

  test("top-in-episodes: per kind of limit", () => {
    expect(patternWords({ pattern: "top-in-episodes", label: "lane builder", limit: "memory", episodes: 5, of: 7, window: 14 })).toEqual({
      title: "Lane builder held the most memory in 5 of the 7 times memory ran short in the last 14 days",
      detail: "Each time is one stretch in which memory was close to the cap or capped, and it counts for the holder that held the most memory over it.",
    });
    expect(patternWords({ pattern: "top-in-episodes", label: "Browser", limit: "cpu", episodes: 2, of: 3, window: 14 }).title).toBe("Browser used the most CPU in 2 of the 3 times CPU ran short in the last 14 days");
    expect(patternWords({ pattern: "top-in-episodes", label: "Browser", limit: "heat", episodes: 2, of: 3, window: 14 })).toEqual({
      title: "Browser used the most CPU in 2 of the 3 times the machine ran hot in the last 14 days",
      detail: "Each time is one stretch in which the thermal pressure was moderate or worse, and it counts for the holder that used the most CPU over it.",
    });
    expect(leaders("lane builder", "memory")).toEqual(["Lane builder held the most memory", "Another holder held the most memory"]);
  });

  test("before-restart: who held most, when, and what was the limit; never why it restarted", () => {
    const at = Date.parse("2026-03-10T09:04:00Z");
    expect(patternWords({ pattern: "before-restart", label: "lane builder", gb: 30, overMs: 15 * MINUTE, at, zone: () => 60, limit: "memory" })).toEqual({
      title: "Lane builder held 30.0 GB before the restart on 10 Mar at 10:04",
      detail: "That was more than any other holder held over the last 15 min sampled before it, and memory was the limit then.",
    });
    expect(patternWords({ pattern: "before-restart", label: "Browser", gb: 10, overMs: 15 * MINUTE, at, zone: () => 0, limit: null })).toEqual({
      title: "Browser held 10.0 GB before the restart on 10 Mar at 09:04",
      detail: "That was more than any other holder held over the last 15 min sampled before it, and nothing was the limit then.",
    });
    expect(patternWords({ pattern: "before-restart", label: "Browser", gb: 10, overMs: 15 * MINUTE, at, zone: () => 0, limit: "cpu" }).detail).toEndWith("and CPU was the limit then.");
  });
});

describe("small words", () => {
  test("a length of time: seconds, minutes, hours with minutes, then days", () => {
    expect([40_000, 59_000, MINUTE, 59 * MINUTE, HOUR, 73 * MINUTE, 47 * HOUR, 48 * HOUR, 76 * HOUR].map(duration)).toEqual(["40 s", "59 s", "1 min", "59 min", "1 h", "1 h 13 min", "47 h", "2 days", "3 days"]);
  });

  test("a time of day is in the zone that is passed in", () => {
    const t = Date.parse("2026-11-05T23:30:00Z");
    expect(when(t, () => 0)).toBe("5 Nov at 23:30");
    expect(when(t, () => 60)).toBe("6 Nov at 00:30");
    expect(when(t, () => -480)).toBe("5 Nov at 15:30");
  });

  test("a time is printed by the offset of its own date, also on the days the clocks change", () => {
    // The clocks of this zone go back at 01:00 UTC on 25 October 2026 and forward at 01:00 UTC on 29 March.
    const zone = zoneNamed("Europe/Berlin");
    const said = (iso: string) => when(Date.parse(iso), zone);
    expect([said("2026-10-25T00:30:00Z"), said("2026-10-25T01:30:00Z")]).toEqual(["25 Oct at 02:30", "25 Oct at 02:30"]);
    expect([said("2026-03-29T00:30:00Z"), said("2026-03-29T01:30:00Z")]).toEqual(["29 Mar at 01:30", "29 Mar at 03:30"]);
    expect([said("2026-07-01T10:00:00Z"), said("2026-12-01T10:00:00Z")]).toEqual(["1 Jul at 12:00", "1 Dec at 11:00"]);
  });

  test("the three rows the monitor makes itself have plain names, and a process keeps its own", () => {
    expect(["(exited)", "(small)", "(unattributed)", "bun", "constructor"].map(partName)).toEqual(["short-lived processes", "many small processes", "kernel and unattributed", "bun", "constructor"]);
  });

  test("processes with no lane, no app and no folder to go by are Unsorted processes, and a folder keeps its name", () => {
    expect(["other", "~/work/shop", "a temp folder"].map(unsortedLabel)).toEqual(["Unsorted processes", "~/work/shop", "a temp folder"]);
  });

  test("an event's label: lanes, a restart, a gap, and a mark as it was put down", () => {
    expect(eventLabel({ kind: "lane-start", text: "builder" })).toBe("Lane builder started");
    expect(eventLabel({ kind: "lane-end", text: "builder" })).toBe("Lane builder ended");
    expect(eventLabel({ kind: "reboot", text: "restart after 3d4h up", forMs: 76 * HOUR })).toBe("The machine restarted after 3 days up");
    expect(eventLabel({ kind: "gap", text: "no samples for 20:00", forMs: 20 * MINUTE })).toBe("No samples for 20 min");
    expect(eventLabel({ kind: "test-run", text: "full suite started" })).toBe("Full suite started");
    expect(eventLabel({ kind: "reboot", text: "rebooted by hand" })).toBe("Rebooted by hand");
  });
});

const LIMITS = { warnShare: 0.5, swapGrowthMBPerMin: 100, cpuTight: 12.8, cpuCapped: 15, thermalTight: 1, thermalCapped: 2, diskTight: 100, diskCapped: 20 };

describe("the words the page fills in itself", () => {
  const said = pageWords("forge", 16, LIMITS);
  const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);

  test("the three states, each with what it means under the limits that are passed in", () => {
    expect(said.states.map((s) => [s.state, s.label])).toEqual([[0, "Not capped"], [1, "Close to the cap"], [2, "Capped"]]);
    expect(said.states[1].meaning).toBe("The kernel's memory pressure is at its warning level for 50% of a minute or more, or swap grows by 100 MB a minute, or 12.8 of 16 cores are busy, or under 100 GB of disk is free, or the thermal pressure is moderate.");
    expect(said.states[2].meaning).toBe("The kernel's memory pressure is at its critical level, or at its warning level while swap grows that fast, or 15 of 16 cores are busy, or under 20 GB of disk is free, or the thermal pressure is heavy or worse.");
  });

  test("the limits by the names the sentences use, and the levels in the order a sample counts them", () => {
    expect(said.limiters).toEqual([{ id: "memory", label: "memory" }, { id: "cpu", label: "CPU" }, { id: "heat", label: "heat" }, { id: "disk", label: "disk" }]);
    expect(said.levels).toEqual(["normal", "warning", "critical"]);
    expect(said.thermal).toEqual(["cool", "moderate", "heavy", "trapping", "sleeping"]);
  });

  test("a past sample: what limited the machine, when, and the reasons that applied", () => {
    expect(fill(said.past.calm, { time: "10:29" })).toBe("Forge was not capped at 10:29.");
    const why = fill(said.past.why, { reasons: [fill(said.reason.pressure, { level: "critical", percent: "78%" }), fill(said.reason.swap, { rate: "250 MB" })].join(said.reason.join) });
    expect(fill(said.past.capped.memory, { time: "10:52", why })).toBe("Memory was capped at 10:52: pressure critical (78%), swap growing 250 MB a minute.");
    expect(fill(said.past.close.cpu, { time: "10:52", why: fill(said.past.why, { reasons: fill(said.reason.cpu, { busy: "13.1", cores: "16" }) }) })).toBe("CPU was close to the cap at 10:52: 13.1 of 16 cores busy.");
    expect(fill(said.past.close.heat, { time: "10:52", why: "" })).toBe("Heat was close to the cap at 10:52.");
    expect(Object.keys(said.past.capped)).toEqual(["memory", "cpu", "heat", "disk"]);
  });

  test("the live headline is made of the same reasons", () => {
    const reasons = [fill(said.reason.pressure, { level: "warning", percent: "80%" }), fill(said.reason.swap, { rate: "240 MB" })].join(said.reason.join);
    expect(headline("forge", { state: 2, cause: { limiter: "memory", pressure: "warn", percent: 80, swapMBPerMin: 240 } })).toBe(`Memory is capped: ${reasons}.`);
    expect(headline("forge", { state: 2, cause: { limiter: "disk", freeGB: 12 } })).toBe(`Disk is capped: ${fill(said.reason.disk, { free: "12 GB" })}.`);
  });

  test("the frame of a moment that is not now, the state of now beside it, and where a strip starts", () => {
    expect(fill(said.viewing, { when: "10:29", ago: "31 min" })).toBe("Viewing 10:29, 31 min ago");
    expect(fill(said.live, { state: "Capped" })).toBe("Now: Capped");
    expect(fill(said.began, { when: "Tue 10 Mar, 09:00" })).toBe("Recording began Tue 10 Mar, 09:00. The strip starts there.");
  });

  test("who held most, filled in, reads as the server's own sentence of the past", () => {
    const list = "Containers (12.7 GB), lane builder (9.4 GB) and Browser (5.2 GB)";
    expect(fill(said.past.held, { list, share: "45%", total: "60.4 GB" })).toBe(holding(three, 60.4, "memory", "then"));
    expect(fill(said.past.used, { list: "Browser (1.0 core)", share: "8%", total: "12.6 cores" })).toBe("Browser (1.0 core) used 8% of the busy CPU, 12.6 cores.");
    expect(said.past.nobody).toBe(blame("disk", { top: [], total: 0 }, { top: [], total: 0 }, "then"));
  });
});

describe("no number appears without its unit", () => {
  const sentences = [
    ...pageWords("forge", 16, LIMITS).states.map((s) => s.meaning),
    headline("forge", { state: 2, cause: { limiter: "memory", pressure: "warn", percent: 80, swapMBPerMin: 240 } }),
    headline("forge", { state: 2, cause: { limiter: "memory", pressure: null, percent: null, swapMBPerMin: 2400 } }),
    headline("forge", { state: 1, cause: { limiter: "cpu", busy: 13.1, cores: 16 } }),
    headline("forge", { state: 1, cause: { limiter: "disk", freeGB: 86 } }),
    holding(three, 59.8, "memory", "now"),
    holding(three, 12.6, "cpu", "then"),
    detail(calmHost),
    detail({ ...calmHost, swapMBPerMin: 240 }),
    incidentHeadline(incident()),
    incidentHeadline(incident({ ongoing: true, ms: 72 * HOUR })),
    incidentSummary(incident({ before: [{ label: "Lane builder started", ms: 12 * MINUTE }, { label: "full suite started", ms: 40_000 }] })),
    incidentSummary(incident({ peak: { resource: "cpu", busy: 15.4, cores: 16 } })),
    incidentSummary(incident({ peak: { resource: "disk", freeGB: 12 } })),
    ...Object.values(patternWords({ pattern: "days-above", label: "Containers", gb: 8, days: 11, of: 14, window: 14, highest: 15.3, lowest: 5.6 })),
    ...Object.values(patternWords({ pattern: "days-above", label: "Containers", gb: 8, days: 3, of: 4, window: 14, highest: 15.3, lowest: 5.6 })),
    ...Object.values(patternWords({ pattern: "top-in-episodes", label: "lane builder", limit: "memory", episodes: 5, of: 7, window: 14 })),
    ...Object.values(patternWords({ pattern: "before-restart", label: "lane builder", gb: 30, overMs: 15 * MINUTE, at: Date.parse("2026-03-10T09:04:00Z"), zone: () => 0, limit: "memory" })),
    eventLabel({ kind: "reboot", text: "", forMs: 76 * HOUR }),
    eventLabel({ kind: "gap", text: "", forMs: 20 * MINUTE }),
  ];

  test("the check itself sees a bare number", () => {
    expect(unitless("Swap grew by 2.1 over it.")).toEqual(["2.1"]);
    expect(unitless("It held 46 of the memory at 14.")).toEqual(["46", "14"]);
    expect(unitless("4.4 of 16 cores are busy on 11 of the last 14 days.")).toEqual([]);
  });

  test.each(sentences)("%s", (sentence) => {
    expect(unitless(sentence)).toEqual([]);
  });

  test("and none has a long dash, or a colon outside the fixed headline form", () => {
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/[\u2013\u2014]/);
      if (!/^(Memory|CPU|Heat|Disk) is (capped|close to the cap): /.test(sentence)) expect(sentence.replace(/\d{2}:\d{2}/g, "")).not.toContain(":");
    }
  });
});
