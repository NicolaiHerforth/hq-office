// Writes a monitor.db for HUD_MONITOR_REPLAY (src/server/routes/monitor.ts) through the real store, with a clock
// it moves itself: `calm`, an hour in which nothing is the limit, or `capped`, an hour that ends capped by memory
// (the kernel's pressure critical, swap growing, one lane holding most of it, a full suite marked just before).
// Every lane, pane and app in it is invented, and the same call writes the same database. Tests and screenshots
// read it; nothing in it comes from a machine.
//   bun scripts/monitor-fixture.ts calm|capped DIR
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/server/monitor-store.ts";
import type { HostUsage, OwnerKind, Usage } from "../src/server/monitor-types.ts";

export type FixtureKind = "calm" | "capped";
export const FIXTURES: FixtureKind[] = ["calm", "capped"];

const TICK_MS = 10_000;
const TICKS = 360;
const GB = 1024 * 1024;
const DAY_MS = 86_400_000;
// The newest sample of every fixture, which a replay takes as now.
export const FIXTURE_END = Date.UTC(2026, 2, 10, 10, 0, 0);
const CORES = 16;

// In `capped` the builder's node grows from this tick on; the kernel warns from WARN_FROM and is critical from
// CRITICAL_FROM to the end, which is the last eight minutes.
const GROW_FROM = 258;
const WARN_FROM = 282;
const CRITICAL_FROM = 312;
const SUITE_AT = 252;
// By this much, which takes what all hold past the 64 GB of RAM, so the spill past the RAM line is there to draw.
const GROWS_GB = 37;

// A slow, repeatable wobble between -1 and 1, so no series is a ruler-straight line.
const wave = (i: number, period: number, phase = 0) => Math.sin(((i + phase) / period) * 2 * Math.PI);
const between = (i: number, from: number, to: number) => Math.min(1, Math.max(0, (i - from) / (to - from)));

type Group = { kind: OwnerKind; owner: string; name: string; gb: number; cpuMs: number; period: number };
// What runs on the invented machine: each process group with what it holds and the CPU it uses in a tick.
const GROUPS: Group[] = [
  { kind: "lane", owner: "builder", name: "bun", gb: 2.2, cpuMs: 2600, period: 31 },
  { kind: "lane", owner: "builder", name: "node", gb: 1.6, cpuMs: 1800, period: 47 },
  { kind: "lane", owner: "builder", name: "agent", gb: 0.6, cpuMs: 300, period: 23 },
  { kind: "lane", owner: "tester", name: "bun", gb: 1.4, cpuMs: 1500, period: 37 },
  { kind: "lane", owner: "tester", name: "agent", gb: 0.5, cpuMs: 250, period: 29 },
  { kind: "lane", owner: "docs", name: "agent", gb: 0.45, cpuMs: 200, period: 41 },
  { kind: "lane", owner: "shop-web", name: "node", gb: 0.3, cpuMs: 150, period: 53 },
  { kind: "pane", owner: "~/work/shop", name: "node", gb: 0.9, cpuMs: 400, period: 43 },
  // Two panes whose folders end alike, deep under the home folder, so the page has to tell them apart.
  { kind: "pane", owner: "~/…/trees/shop-web", name: "bun", gb: 0.8, cpuMs: 350, period: 45 },
  { kind: "pane", owner: "~/…/shop-web/shop-web", name: "node", gb: 0.6, cpuMs: 200, period: 49 },
  { kind: "pane", owner: "~/…/docs/site", name: "node", gb: 0.03, cpuMs: 20, period: 51 },
  { kind: "app", owner: "Containers", name: "Containers Helper", gb: 9.5, cpuMs: 2400, period: 59 },
  { kind: "app", owner: "Containers", name: "shop: db", gb: 0.6, cpuMs: 300, period: 61 },
  { kind: "app", owner: "Browser", name: "Browser Helper", gb: 3.8, cpuMs: 1900, period: 33 },
  { kind: "app", owner: "Browser", name: "Browser", gb: 0.6, cpuMs: 300, period: 67 },
  { kind: "app", owner: "Editor", name: "Editor", gb: 2.4, cpuMs: 900, period: 71 },
  { kind: "app", owner: "Mail", name: "Mail", gb: 0.7, cpuMs: 100, period: 73 },
  { kind: "app", owner: "Chat", name: "Chat", gb: 0.4, cpuMs: 150, period: 79 },
  { kind: "app", owner: "Notes", name: "Notes", gb: 0.2, cpuMs: 30, period: 83 },
  { kind: "hq", owner: "HQ Office", name: "bun", gb: 0.15, cpuMs: 120, period: 89 },
  { kind: "system", owner: "system", name: "launchd", gb: 1.2, cpuMs: 500, period: 97 },
  { kind: "system", owner: "system", name: "(small)", gb: 2.0, cpuMs: 900, period: 101 },
  { kind: "lost", owner: "kernel and unattributed", name: "(unattributed)", gb: 0, cpuMs: 2200, period: 103 },
];

function rowsAt(kind: FixtureKind, i: number): Usage[] {
  return GROUPS.map((g, n): Usage => {
    const grows = kind === "capped" && g.owner === "builder" && g.name === "node";
    const gb = g.gb * (1 + 0.04 * wave(i, g.period, n * 7)) + (grows ? GROWS_GB * between(i, GROW_FROM, TICKS - 1) : 0);
    const cpuMs = g.cpuMs * (1 + 0.3 * wave(i, g.period / 2, n * 5)) * (grows && i >= GROW_FROM ? 3 : 1);
    return { kind: g.kind, owner: g.owner, name: g.name, cpuMs: Math.round(cpuMs), memKb: Math.round(gb * GB), n: 1, readKb: 0, writtenKb: 0 };
  });
}

function hostAt(kind: FixtureKind, i: number, rows: Usage[]): HostUsage {
  const short = kind === "capped" ? between(i, GROW_FROM, TICKS - 1) : 0;
  const critical = kind === "capped" && i >= CRITICAL_FROM;
  // From the critical stretch on, swap grows by 50 MB a tick, which is 300 MB a minute.
  const swapGb = 5 + (critical ? (i - CRITICAL_FROM) * (50 / 1024) : 0);
  return {
    dtMs: TICK_MS,
    cores: CORES,
    busyMs: rows.reduce((sum, r) => sum + r.cpuMs, 0),
    load1: 3 + wave(i, 90),
    memTotalKb: 64 * GB,
    memFreeKb: Math.round((1.5 - 1.3 * short) * GB),
    memWiredKb: 6 * GB,
    memAppKb: 30 * GB,
    memCachedKb: Math.round((8 - 6 * short) * GB),
    memCompressedKb: Math.round((4 + 8 * short) * GB),
    memStoredKb: Math.round((14 + 26 * short) * GB),
    swapTotalKb: 16 * GB,
    swapUsedKb: Math.round(swapGb * GB),
    pressure: critical ? 4 : kind === "capped" && i >= WARN_FROM ? 2 : 1,
    available: Math.round((46 + 2 * wave(i, 120) - 40 * short) * 10) / 10,
    pageins: 0,
    pageouts: 0,
    swapins: 0,
    swapouts: critical ? 12_800 : 0,
    thermal: 0,
    diskTotalKb: 1000 * GB,
    diskFreeKb: 420 * GB,
    bootAt: Math.round((FIXTURE_END - 5 * DAY_MS) / 1000),
    heldKb: rows.reduce((sum, r) => sum + r.memKb, 0),
    selfCpuMs: 32,
    selfMemKb: 44 * 1024,
  };
}

// Writes DIR/monitor.db, in a folder that has none yet.
export function writeFixture(dir: string, kind: FixtureKind) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "monitor.db");
  if (existsSync(file)) throw new Error(`${file} is there already: a fixture is written to a folder of its own`);
  const store = openStore(file);
  for (let i = 0; i < TICKS; i++) {
    const at = FIXTURE_END - (TICKS - 1 - i) * TICK_MS;
    const rows = rowsAt(kind, i);
    store.write(at, hostAt(kind, i, rows), rows);
    store.roll(at);
    if (kind === "capped" && i === SUITE_AT) store.mark(at, "suite", "full suite started");
  }
  // Two readings of the disk, twenty days apart, so the growers have a size and a growth.
  for (const [name, gb] of [["~/Library/Caches", 110], ["Xcode DerivedData", 64], ["Package caches", 45], ["Temp folders", 22]] as const) {
    store.grower(FIXTURE_END - 20 * DAY_MS, name, Math.round(gb * GB * 0.86));
    store.grower(FIXTURE_END - 3_600_000, name, gb * GB);
  }
  store.close();
  return { file, end: FIXTURE_END };
}

if (import.meta.main) {
  const [kind, dir] = process.argv.slice(2);
  if (!FIXTURES.includes(kind as FixtureKind) || !dir) {
    console.error("usage: bun scripts/monitor-fixture.ts calm|capped DIR");
    process.exit(2);
  }
  console.log(writeFixture(dir, kind as FixtureKind).file);
}
