// THE MONITOR's page data (monitor-page.ts): the data is written through the real store, in memory, at a clock the
// test moves, and rolled up; then the page's questions are asked of its database. Every expected value is worked out
// from the fixture by hand.
import { describe, expect, test } from "bun:test";
import { assignSlots, days, events, holderId, incidents, moment, nextSlots, now, patterns, range, type Slot } from "../../src/server/monitor-page.ts";
import { openStore, type Store } from "../../src/server/monitor-store.ts";
import type { HostUsage, OwnerKind, Usage } from "../../src/server/monitor-types.ts";
import { zoneNamed } from "../zone.ts";

const TICK = 10_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const GB = 1024 * 1024;
// B0 is the start of an hour. A tick says what was used in the ten seconds up to it, so minute m after B0 is made of
// the six ticks from B0 + m min + 10 s to B0 + m min + 60 s.
const B0 = Date.parse("2026-03-10T09:00:00Z");
const BOOT = B0 / 1000 - 30 * 86_400;
const SIZE = { bytes: 212 * 1024 * 1024, limit: 500 * 1024 * 1024 };

// A calm machine: ten cores, nothing short. 2% of its cores is 0.2 cores, which is 2000 ms of CPU in a tick.
const host = (more: Partial<HostUsage> = {}): HostUsage => ({
  dtMs: TICK, cores: 10, busyMs: 0, load1: 1, memTotalKb: 64 * GB, memFreeKb: 1000, memWiredKb: 2000, memAppKb: 3000, memCachedKb: 4000, memCompressedKb: 5000, memStoredKb: 6000, swapTotalKb: 20 * GB, swapUsedKb: 0,
  pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotalKb: 900 * GB, diskFreeKb: 100 * GB, bootAt: BOOT, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...more,
});
const used = (kind: OwnerKind, owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}): Usage => ({ kind, owner, name: owner, cpuMs, memKb, n: 1, readKb: 0, writtenKb: 0, ...more });
const lane = (owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}) => used("lane", owner, cpuMs, memKb, more);
const app = (owner: string, cpuMs = 0, memKb = 0, more: Partial<Usage> = {}) => used("app", owner, cpuMs, memKb, more);
const KERNEL = (cpuMs: number) => used("lost", "kernel and unattributed", cpuMs, 0, { name: "(unattributed)" });

const min = (m: number) => B0 + m * MINUTE;
// The six ticks of the minute that starts at `start`. h and rows may differ per tick: i is 1 to 6.
type PerTick<T> = T | ((i: number) => T);
const per = <T>(value: PerTick<T>, i: number) => (typeof value === "function" ? (value as (i: number) => T)(i) : value);
function minuteAt(s: Store, start: number, h: PerTick<Partial<HostUsage>> = {}, rows: PerTick<Usage[]> = []) {
  for (let i = 1; i <= 6; i++) s.write(start + i * TICK, host(per(h, i)), per(rows, i));
}
const minute = (s: Store, m: number, h: PerTick<Partial<HostUsage>> = {}, rows: PerTick<Usage[]> = []) => minuteAt(s, min(m), h, rows);
// Minutes from B0 on, missing where the list has null, rolled up to the end of the last.
function rolled(minutes: (Partial<HostUsage> | null)[], rows: PerTick<Usage[]> = []) {
  const s = openStore(":memory:");
  minutes.forEach((h, m) => h && minute(s, m, h, rows));
  s.roll(min(minutes.length));
  return s;
}
const busy = (share: number) => ({ busyMs: Math.round(share * 10 * TICK) });
const CALM = busy(0.1);
const TIGHT = busy(0.8);
const CAPPED = busy(0.95);
function openStoreWithMinute() {
  const s = openStore(":memory:");
  minute(s, 0);
  return s;
}
const ask = (s: Store, at: number) => now(s.db, { now: at, name: "forge", size: SIZE })!;
const ids = (holders: { id: string }[]) => holders.map((h) => h.id);
const FIXED = ["hq", "lanes", "apps", "system"];

describe("a holder's id", () => {
  test("kind and name when the name is safe as it is", () => {
    expect(holderId("lane", "builder")).toBe("lane:builder");
    expect(holderId("app", "Editor")).toBe("app:Editor");
  });

  test("any other name is cut to what is safe in a URL, and two names that cut alike stay two ids", () => {
    const made = [holderId("pane", "~/work/a/b"), holderId("pane", "~/work/a-b"), holderId("app", "Code Editor"), holderId("other", "~/…/tmp/tool")];
    expect(made[0]).toStartWith("pane:work-a-b~");
    expect(made[1]).toStartWith("pane:work-a-b~");
    expect(new Set(made).size).toBe(4);
    for (const id of made) expect(id).toMatch(/^[a-z]+:[A-Za-z0-9._-]+~[a-z0-9]+$/);
    expect(holderId("pane", "~/work/a/b")).toBe(made[0]);
  });
});

describe("now: the holders", () => {
  // One minute. big and busy are exactly at half a GB and at 2% of the cores, small and idle just under.
  function tiles() {
    const s = openStore(":memory:");
    minute(s, 0, {}, [
      lane("big", 0, GB / 2), lane("small", 0, GB / 2 - 6000), lane("busy", 2000, 0), lane("idle", 1990, 0),
      app("Editor", 0, 2 * GB), app("Notes", 0, GB / 4), app("Meter", 4000, 0),
      used("other", "~/tmp/tool", 0, 3 * GB), used("other", "other", 0, GB / 8), used("pane", "~/work", 0, 1.5 * GB),
      used("hq", "HQ Office", 600, GB / 8, { name: "bun" }), used("system", "system", 300, GB / 4, { name: "launchd" }), KERNEL(3000),
    ]);
    return ask(s, min(1));
  }

  test("a lane or an app with half a GB of memory or 2% of the cores has an entry of its own; under both it has none", () => {
    expect(ids(tiles().holders).filter((id) => !FIXED.includes(id))).toEqual([holderId("other", "~/tmp/tool"), "app:Editor", holderId("pane", "~/work"), "lane:big", "app:Meter", "lane:busy"]);
  });

  test("the four fixed holders are always there, after the others", () => {
    expect(ids(tiles().holders).slice(-4)).toEqual(FIXED);
    expect(tiles().holders.slice(-4).map((h) => [h.name, h.kind, h.group])).toEqual([["HQ Office", "hq", false], ["Other lanes", "lane", true], ["Other apps", "app", true], ["System", "system", false]]);
  });

  test("a holder without a colour slot still has its own entry, drawn neutral", () => {
    const { holders, now: n } = tiles();
    expect(holders.find((h) => h.id === "lane:big")).toEqual({ id: "lane:big", name: "lane big", kind: "lane", slot: null, group: false, note: "A herdr lane, with everything it started" });
    expect(n.holders.find((h) => h.id === "lane:big")).toEqual({ id: "lane:big", mem: 0.5, cpu: 0, memParts: [{ name: "big", value: 0.5 }], cpuParts: [] });
    expect(holders.every((h) => h.slot === null)).toBe(true);
  });

  test("the ones under both fold into Other lanes and Other apps, each still named inside", () => {
    const held = new Map(tiles().now.holders.map((h) => [h.id, h]));
    // small holds half a GB less 6000 kB, which is 0.49 GB. idle used 1990 ms of every 10 s: 0.2 cores when rounded.
    expect(held.get("lanes")).toEqual({ id: "lanes", mem: 0.49, cpu: 0.2, memParts: [{ name: "lane small", value: 0.49 }], cpuParts: [{ name: "lane idle", value: 0.2 }] });
    // A quarter and an eighth of a GB.
    expect(held.get("apps")).toEqual({ id: "apps", mem: 0.38, cpu: 0, memParts: [{ name: "Notes", value: 0.25 }, { name: "Unsorted processes", value: 0.13 }], cpuParts: [] });
  });

  test("processes that fit no lane, no app and no folder are Unsorted processes, in a group and as a holder of their own, and never Other", () => {
    const s = openStore(":memory:");
    minute(s, 0, { heldKb: 5.25 * GB }, [used("other", "other", 0, 3 * GB, { name: "stray" }), app("Editor", 0, 2 * GB), app("Notes", 0, GB / 4)]);
    const { holders, now: n } = ask(s, min(1));
    expect(holders.find((h) => h.id === "other:other")).toEqual({ id: "other:other", name: "Unsorted processes", kind: "app", slot: null, group: false, note: "Processes that fit no lane and no app, by the folder they run in where there is one" });
    expect(n.sentence).toBe("Unsorted processes (3.0 GB) and Editor (2.0 GB) hold 95% of the 5.3 GB that processes hold.");
    const names = [...holders.map((h) => h.name), ...n.holders.flatMap((h) => h.memParts.map((part) => part.name))];
    expect(names.filter((name) => /^other$/i.test(name))).toEqual([]);
    expect(names.filter((name) => name === "Other apps")).toEqual(["Other apps"]);
  });

  test("a pane goes by the last name of its folder, with all of the folder beside it, and processes that fit no lane or app go with the apps under the name they have", () => {
    const { holders } = tiles();
    expect(holders.find((h) => h.id === holderId("pane", "~/work"))).toEqual({ id: holderId("pane", "~/work"), name: "pane work", full: "pane ~/work", kind: "lane", slot: null, group: false, note: "A herdr pane without a named agent, with everything it started" });
    expect(holders.find((h) => h.id === holderId("other", "~/tmp/tool"))).toMatchObject({ name: "~/tmp/tool", kind: "app", group: false });
    expect(holders.filter((h) => "full" in h).map((h) => h.id)).toEqual([holderId("pane", "~/work")]);
  });

  // Two panes whose folders end alike, one in a folder that ends like no other, one too small for a tile, and a
  // lane named like a folder.
  function panes() {
    const s = openStore(":memory:");
    const pane = (folder: string, memKb: number) => used("pane", folder, 0, memKb, { name: "node" });
    minute(s, 0, { heldKb: 7.25 * GB }, [pane("~/…/trees/shop-web", 3 * GB), pane("~/…/shop-web/shop-web", 2 * GB), pane("~/work/api", GB), pane("~/…/docs/site", GB / 4), lane("shop-web", 0, GB)]);
    s.roll(min(1));
    return s;
  }
  const named = (holders: { id: string; name: string; full?: string }[], folder: string) => { const { name, full } = holders.find((h) => h.id === holderId("pane", folder))!; return [name, full]; };

  test("two panes shown together that share a last name each add the folder before it", () => {
    const { holders, now: n } = ask(panes(), min(1));
    expect(named(holders, "~/…/trees/shop-web")).toEqual(["pane shop-web (trees)", "pane ~/…/trees/shop-web"]);
    expect(named(holders, "~/…/shop-web/shop-web")).toEqual(["pane shop-web (shop-web)", "pane ~/…/shop-web/shop-web"]);
    expect(named(holders, "~/work/api")).toEqual(["pane api", "pane ~/work/api"]);
    expect(holders.find((h) => h.id === "lane:shop-web")!.name).toBe("lane shop-web");
    // The sentence names them the same way.
    expect(n.sentence).toStartWith("Pane shop-web (trees) (3.0 GB), pane shop-web (shop-web) (2.0 GB) and ");
  });

  test("a pane inside Other lanes is a part by its short name, with all of its folder beside it", () => {
    expect(ask(panes(), min(1)).now.holders.find((h) => h.id === "lanes")!.memParts).toEqual([{ name: "pane site", value: 0.25, full: "pane ~/…/docs/site" }]);
  });

  test("a range and a moment of it name panes the same way", () => {
    const s = panes();
    const r = range(s.db, { now: min(1), key: "hour" });
    expect(named(r.holders, "~/…/trees/shop-web")).toEqual(["pane shop-web (trees)", "pane ~/…/trees/shop-web"]);
    expect(named(r.holders, "~/work/api")).toEqual(["pane api", "pane ~/work/api"]);
    expect(moment(s.db, { now: min(1), key: "hour", t: min(0), holders: r.holders })!.holders.find((h) => h.id === "lanes")!.memParts).toEqual([{ name: "pane site", value: 0.25, full: "pane ~/…/docs/site" }]);
  });

  test("nothing that prints as 0.0 GB and 0.00 cores is held: no holder, no group and no part", () => {
    const s = openStore(":memory:");
    // tiny holds 0.04 GB, slow uses 0.004 cores, and the helper of big holds 0.04 GB of its 1 GB.
    minute(s, 0, {}, [lane("big", 0, 0.96 * GB), lane("big", 60, 0.04 * GB, { name: "helper" }), lane("tiny", 0, 0.04 * GB), app("slow", 40, 0), used("system", "system", 0, 0.04 * GB, { name: "launchd" })]);
    const { holders, now: n } = ask(s, min(1));
    expect(n.holders).toEqual([{ id: "lane:big", mem: 1, cpu: 0.01, memParts: [{ name: "big", value: 0.96 }], cpuParts: [{ name: "helper", value: 0.01 }] }]);
    // They keep their place in the list of who there is, which is where the groups have their names from.
    expect(ids(holders)).toEqual(["lane:big", ...FIXED]);
  });

  test("a holder that prints as nothing in memory is still held when it uses CPU, and the other way round", () => {
    const s = openStore(":memory:");
    minute(s, 0, {}, [lane("idle", 0, 0.05 * GB), app("spinner", 100, 0)]);
    expect(ask(s, min(1)).now.holders).toEqual([
      { id: "lanes", mem: 0.05, cpu: 0, memParts: [{ name: "lane idle", value: 0.05 }], cpuParts: [] },
      { id: "apps", mem: 0, cpu: 0.01, memParts: [], cpuParts: [{ name: "spinner", value: 0.01 }] },
    ]);
  });

  test("HQ Office is one holder, and the system carries the kernel's CPU as a part", () => {
    const held = new Map(tiles().now.holders.map((h) => [h.id, h]));
    expect(held.get("hq")).toEqual({ id: "hq", mem: 0.13, cpu: 0.06, memParts: [{ name: "bun", value: 0.13 }], cpuParts: [{ name: "bun", value: 0.06 }] });
    expect(held.get("system")).toEqual({ id: "system", mem: 0.25, cpu: 0.33, memParts: [{ name: "launchd", value: 0.25 }], cpuParts: [{ name: "kernel and unattributed", value: 0.3 }, { name: "launchd", value: 0.03 }] });
  });

  test("a holder's parts are its process groups, largest first, with plain names for the two rows the monitor makes", () => {
    const s = openStore(":memory:");
    minute(s, 0, {}, [lane("builder", 600, 2 * GB, { name: "bun" }), lane("builder", 1200, 0, { name: "(exited)" }), lane("builder", 60, GB / 2, { name: "(small)" })]);
    expect(ask(s, min(1)).now.holders.find((h) => h.id === "lane:builder")).toEqual({
      id: "lane:builder", mem: 2.5, cpu: 0.19,
      memParts: [{ name: "bun", value: 2 }, { name: "many small processes", value: 0.5 }],
      cpuParts: [{ name: "short-lived processes", value: 0.12 }, { name: "bun", value: 0.06 }, { name: "many small processes", value: 0.01 }],
    });
  });

  test("memory is what is held at the newest tick, CPU what was used over the minute that ends with it", () => {
    const s = openStore(":memory:");
    // gone held 2 GB in the first three ticks only: 6000 ms of CPU over the minute is 0.1 cores, and it holds nothing now.
    minute(s, 0, {}, (i) => [lane("grower", 3000, i === 6 ? 3 * GB : GB), ...(i <= 3 ? [lane("gone", 2000, 2 * GB)] : [])]);
    const held = new Map(ask(s, min(1)).now.holders.map((h) => [h.id, h]));
    expect(held.get("lane:grower")).toMatchObject({ mem: 3, cpu: 0.3 });
    expect(held.get("lanes")).toEqual({ id: "lanes", mem: 0, cpu: 0.1, memParts: [], cpuParts: [{ name: "lane gone", value: 0.1 }] });
  });

  test("most memory first, and of those that hold none, most CPU first", () => {
    expect(ids(tiles().now.holders)).toEqual([holderId("other", "~/tmp/tool"), "app:Editor", holderId("pane", "~/work"), "lane:big", "lanes", "apps", "system", "hq", "app:Meter", "lane:busy"]);
  });
});

describe("the colour slots", () => {
  const owner = (name: string) => ({ kind: "lane" as const, owner: name });
  const ranking = (...names: string[]) => names.map(owner);
  const r = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${from + i}`);
  const wearing = (slots: Slot[]) => Object.fromEntries(slots.map((s) => [s.slot, s.owner]));

  test("the first seven of the ranking get the seven slots, best first", () => {
    expect(nextSlots([], ranking(...r(1, 9)), 500)).toEqual(r(1, 7).map((name, i) => ({ slot: i + 1, kind: "lane", owner: name, since: 500 })));
  });

  test("a holder keeps its slot while it is among the top 14, and the free slots go to the best without one", () => {
    const next = nextSlots([{ slot: 3, ...owner("old"), since: 5 }], ranking(...r(1, 13), "old"), 500);
    expect(wearing(next)).toEqual({ 1: "r1", 2: "r2", 3: "old", 4: "r3", 5: "r4", 6: "r5", 7: "r6" });
    expect(next.find((s) => s.owner === "old")!.since).toBe(5);
  });

  test("below the top 14 it loses its slot", () => {
    expect(wearing(nextSlots([{ slot: 3, ...owner("old"), since: 5 }], ranking(...r(1, 14), "old"), 500))).toEqual({ 1: "r1", 2: "r2", 3: "r3", 4: "r4", 5: "r5", 6: "r6", 7: "r7" });
    expect(wearing(nextSlots([{ slot: 3, ...owner("old"), since: 5 }], ranking(...r(1, 9)), 500))[3]).toBe("r3");
  });

  test("a newcomer takes no slot from a holder that keeps its own, and takes the one that comes free", () => {
    const current = nextSlots([], ranking(...r(1, 7)), 1);
    expect(nextSlots(current, ranking("new", ...r(1, 7)), 500)).toEqual(current);
    // r4 is gone. new is the best of the first seven without a slot; r8 is the eighth.
    expect(wearing(nextSlots(current, ranking("new", "r1", "r2", "r3", "r5", "r6", "r7", "r8"), 500))).toEqual({ 1: "r1", 2: "r2", 3: "r3", 4: "new", 5: "r5", 6: "r6", 7: "r7" });
  });

  test("a second run with the same ranking changes nothing", () => {
    const order = ranking("new", ...r(1, 5), "other", ...r(6, 12));
    const once = nextSlots([{ slot: 2, ...owner("r9"), since: 5 }, { slot: 6, ...owner("gone"), since: 5 }], order, 500);
    expect(nextSlots(once, order, 900)).toEqual(once);
  });

  // One minute. Of the lanes' and apps' memory and CPU: runner has 1/11 + 3/3, holder 8/11, third 2/11. The system
  // and HQ Office are not ranked, however much they hold.
  function ranked() {
    const s = openStore(":memory:");
    minute(s, 0, {}, [lane("holder", 0, 8 * GB), app("runner", 3000, GB), lane("third", 0, 2 * GB), used("system", "system", 9000, 30 * GB), used("hq", "HQ Office", 9000, 30 * GB)]);
    return s;
  }
  const table = (s: Store) => s.db.query("SELECT slot, kind, owner, since FROM slots ORDER BY slot").all();

  test("the store's ranking is by share of the memory plus share of the CPU, lanes and apps only", () => {
    const s = ranked();
    expect(assignSlots(s.db, { now: min(1) })).toEqual([
      { slot: 1, kind: "app", owner: "runner", since: min(1) },
      { slot: 2, kind: "lane", owner: "holder", since: min(1) },
      { slot: 3, kind: "lane", owner: "third", since: min(1) },
    ]);
    expect(table(s)).toEqual([
      { slot: 1, kind: "app", owner: "runner", since: min(1) / 1000 },
      { slot: 2, kind: "lane", owner: "holder", since: min(1) / 1000 },
      { slot: 3, kind: "lane", owner: "third", since: min(1) / 1000 },
    ]);
  });

  test("written twice, the table is the same, and a later run keeps who had what since when", () => {
    const s = ranked();
    assignSlots(s.db, { now: min(1) });
    const first = table(s);
    assignSlots(s.db, { now: min(1) });
    expect(table(s)).toEqual(first);
    assignSlots(s.db, { now: min(1) + 15 * MINUTE });
    expect(table(s)).toEqual(first);
  });

  test("the holders of every view carry their slot, coloured ones first in slot order", () => {
    const s = ranked();
    assignSlots(s.db, { now: min(1) });
    const slots = (holders: { id: string; slot: number | null }[]) => holders.map((h) => [h.id, h.slot]);
    const expected = [["app:runner", 1], ["lane:holder", 2], ["lane:third", 3], ["hq", null], ["lanes", null], ["apps", null], ["system", null]];
    expect(slots(ask(s, min(1)).holders)).toEqual(expected);
    expect(slots(range(s.db, { now: min(1), key: "hour" }).holders)).toEqual(expected);
  });
});

describe("now: the verdict", () => {
  // One minute of the same reading, or of a reading per tick, and what now says of it.
  const verdict = (h: PerTick<Partial<HostUsage>>) => {
    const s = openStore(":memory:");
    minute(s, 0, h);
    const { state, limiter, headline } = ask(s, min(1)).now;
    return [state, limiter, headline];
  };

  test("nothing short: not capped", () => {
    expect(verdict(CALM)).toEqual([0, null, "Forge is not capped right now."]);
  });

  test("memory follows the kernel's pressure: warn for half the minute is close to the cap, critical at any time is capped", () => {
    expect(verdict({ pressure: 2 })).toEqual([1, "memory", "Memory is close to the cap: pressure warning (50%)."]);
    expect(verdict((i) => ({ pressure: i <= 3 ? 2 : 1 }))[0]).toBe(1);
    expect(verdict((i) => ({ pressure: i <= 2 ? 2 : 1 }))[0]).toBe(0);
    expect(verdict((i) => ({ pressure: i === 4 ? 4 : 1 }))).toEqual([2, "memory", "Memory is capped: pressure critical (50%)."]);
  });

  test("memory follows swap that grows: 100 MB a minute is close to the cap, and with the pressure at warn it is capped", () => {
    // A minute without swap, then one in which it grows to `mb` MB, as much with every tick.
    const after = (mb: number, h: Partial<HostUsage> = {}) => {
      const s = openStore(":memory:");
      minute(s, 0);
      minute(s, 1, (i) => ({ ...h, swapUsedKb: Math.round((i * mb * 1024) / 6) }));
      const { state, limiter, headline } = ask(s, min(2)).now;
      return [state, limiter, headline];
    };
    expect(after(100)).toEqual([1, "memory", "Memory is close to the cap: swap growing 100 MB a minute."]);
    expect(after(99)).toEqual([0, null, "Forge is not capped right now."]);
    expect(after(100, { pressure: 2 })).toEqual([2, "memory", "Memory is capped: pressure warning (50%), swap growing 100 MB a minute."]);
  });

  test("a swap that is nearly full and does not grow is not capped", () => {
    expect(verdict({ swapUsedKb: 19.9 * GB })).toEqual([0, null, "Forge is not capped right now."]);
  });

  test("CPU: 80% of the cores is close to the cap, 15 of every 16 is capped", () => {
    expect(verdict(TIGHT)).toEqual([1, "cpu", "CPU is close to the cap: 8.0 of 10 cores busy."]);
    expect(verdict(CAPPED)).toEqual([2, "cpu", "CPU is capped: 9.5 of 10 cores busy."]);
  });

  test("heat: moderate thermal pressure is close to the cap, heavy is capped", () => {
    expect(verdict({ thermal: 1 })).toEqual([1, "heat", "Heat is close to the cap: thermal pressure moderate."]);
    expect(verdict((i) => ({ thermal: i === 2 ? 2 : 0 }))).toEqual([2, "heat", "Heat is capped: thermal pressure heavy."]);
  });

  test("disk, a 900 GB one: under a tenth of it free is close to the cap, under a fiftieth is capped", () => {
    expect(verdict({ diskFreeKb: 50 * GB })).toEqual([1, "disk", "Disk is close to the cap: 50 GB of disk free."]);
    expect(verdict({ diskFreeKb: 10 * GB })).toEqual([2, "disk", "Disk is capped: 10 GB of disk free."]);
  });

  test("disk, a 256 GB one: 80 GB free is not close to the cap; the lines are at 25.6 and 5.12 GB", () => {
    const small = (free: number) => verdict({ diskTotalKb: 256 * GB, diskFreeKb: free * GB });
    expect(small(80)).toEqual([0, null, "Forge is not capped right now."]);
    expect(small(26)).toEqual([0, null, "Forge is not capped right now."]);
    expect(small(25)).toEqual([1, "disk", "Disk is close to the cap: 25 GB of disk free."]);
    expect(small(6)).toEqual([1, "disk", "Disk is close to the cap: 6 GB of disk free."]);
    expect(small(5)).toEqual([2, "disk", "Disk is capped: 5 GB of disk free."]);
  });

  test("disk, one whose size could not be read: under 100 GB free is close to the cap, under 20 GB is capped", () => {
    const unsized = (free: number) => verdict({ diskTotalKb: null, diskFreeKb: free * GB });
    expect(unsized(100)).toEqual([0, null, "Forge is not capped right now."]);
    expect(unsized(95)).toEqual([1, "disk", "Disk is close to the cap: 95 GB of disk free."]);
    expect(unsized(19)).toEqual([2, "disk", "Disk is capped: 19 GB of disk free."]);
  });

  test("of two limits the worse one is named, and of two as bad, memory before CPU", () => {
    expect(verdict({ ...CAPPED, pressure: 2 }).slice(0, 2)).toEqual([2, "cpu"]);
    expect(verdict({ ...TIGHT, pressure: 2 }).slice(0, 2)).toEqual([1, "memory"]);
  });

  test("the first tick after a start says nothing about CPU: no busy cores, and no cost of the monitor yet", () => {
    const s = openStore(":memory:");
    s.write(B0, host({ dtMs: 0 }), [lane("a", 0, 2 * GB)]);
    const { now: n, self } = ask(s, B0);
    expect([n.state, n.limiter, n.busy, n.since, self.cpuPercentOfOneCore]).toEqual([0, null, null, B0 - MINUTE, null]);
    expect(n.holders[0]).toMatchObject({ id: "lane:a", mem: 2, cpu: 0 });
    expect(n.detail).not.toContain("cores");
  });

  test("there is no now before the first tick, and now is the newest tick at or before the time asked", () => {
    const s = openStore(":memory:");
    expect(now(s.db, { now: B0, name: "forge", size: SIZE })).toBeNull();
    minute(s, 0);
    minute(s, 1);
    expect(now(s.db, { now: B0, name: "forge", size: SIZE })).toBeNull();
    expect(ask(s, min(1) + 5000).now.t).toBe(min(1));
    expect(ask(s, min(9)).now.t).toBe(min(2));
  });
});

describe("now: since", () => {
  const since = (s: Store, at: number) => ask(s, at).now.since;

  test("the start of the first of the minutes that have the state of now without a break", () => {
    expect(since(rolled([CALM, CALM, TIGHT, TIGHT]), min(4))).toBe(min(2));
    expect(since(rolled([TIGHT, CALM, CALM, CALM]), min(4))).toBe(min(1));
  });

  test("a minute without samples ends the walk back: nothing is known before it", () => {
    expect(since(rolled([TIGHT, null, TIGHT, TIGHT]), min(4))).toBe(min(2));
  });

  test("the minutes are judged by the lines of the disk's size: a 256 GB disk is close to the cap since it fell to 10 GB free", () => {
    const small = (free: number) => ({ diskTotalKb: 256 * GB, diskFreeKb: free * GB });
    const s = rolled([small(80), small(10), small(10), small(10)]);
    expect(ask(s, min(4)).now.state).toBe(1);
    expect(since(s, min(4))).toBe(min(1));
  });

  test("a state that began inside the minute still running began with the minute the verdict was read from", () => {
    const s = rolled([CALM, CALM]);
    for (let i = 1; i <= 3; i++) s.write(min(2) + i * TICK, host({ thermal: 2 }), []);
    s.roll(min(2) + 30_000);
    expect(ask(s, min(2) + 30_000).now.state).toBe(2);
    expect(since(s, min(2) + 30_000)).toBe(min(1) + 30_000);
  });

  test("minutes from before a stop of the monitor say nothing about now", () => {
    const s = rolled([TIGHT, TIGHT]);
    s.write(min(10) + TICK, host({ ...TIGHT }), []);
    s.write(min(10) + 2 * TICK, host({ ...TIGHT }), []);
    s.roll(min(10) + 2 * TICK);
    expect(ask(s, min(10) + 2 * TICK).now.state).toBe(1);
    expect(since(s, min(10) + 2 * TICK)).toBe(min(9) + 2 * TICK);
  });
});

describe("now: the machine's numbers and the sentences", () => {
  // Nine small lanes fold into Other lanes with 4.05 GB, more than lane c holds, and a group is still not named.
  const small = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => lane(`small-${n}`, 0, 0.45 * GB));
  function machine(h: Partial<HostUsage> = {}) {
    const s = openStore(":memory:");
    minute(
      s, 0,
      { busyMs: 25_000, load1: 6.49, memFreeKb: GB / 2, memWiredKb: 4 * GB, memCachedKb: 8 * GB, memCompressedKb: 10 * GB, memStoredKb: 40 * GB, swapUsedKb: 5 * GB, available: 30, diskFreeKb: 450 * GB, heldKb: 24.5 * GB, selfCpuMs: 30, selfMemKb: 38 * 1024, ...h },
      [lane("a", 15_000, 8 * GB), app("b", 5000, 6 * GB), lane("c", 1000, 4 * GB), app("d", 0, 2 * GB), used("pane", "~/work", 0, 0), ...small],
    );
    return ask(s, min(1));
  }

  test("the readings of the newest tick, in the page's units", () => {
    expect(machine().now).toMatchObject({
      t: min(1), pressure: 70, kernelLevel: "normal", swapUsed: 5, swapFrac: 0.25, swapGrowth: 0, stored: 40, compressed: 10, wired: 4, cached: 8, free: 0.5, held: 24.5, busy: 2.5, load: 6.49, diskFree: 450, diskUsedFrac: 0.5, lanesRunning: 11,
    });
    expect(machine({ pressure: 2 }).now.kernelLevel).toBe("warn");
    expect(machine({ pressure: 4 }).now.kernelLevel).toBe("critical");
    expect([machine().now.thermal, machine({ thermal: 2 }).now.thermal, machine({ thermal: null }).now.thermal]).toEqual([0, 2, null]);
  });

  test("what the page needs to draw by the server's rules: the tile sizes, the tick, and its own words for these limits", () => {
    const seen = machine();
    // 2% of ten cores.
    expect(seen.tiles).toEqual({ memGB: 0.5, cores: 0.2 });
    expect(seen.tickSeconds).toBe(10);
    expect(ask(openStoreWithMinute(), min(1) + 4000)).toMatchObject({ asOf: min(1) + 4000, now: { t: min(1) } });
    expect(seen.words.past.calm).toBe("Forge was not capped at {time}.");
    expect(seen.words.states[1].meaning).toContain("8 of 10 cores are busy");
  });

  test("the machine, the monitor's own cost and the limits as the page draws them", () => {
    const { host: h, self, limits } = machine();
    expect(h).toEqual({ name: "forge", cores: 10, ramGB: 64, swapTotalGB: 20, diskTotalGB: 900 });
    // 30 ms of every 10 s is 0.3% of one core.
    expect(self).toEqual({ cpuPercentOfOneCore: 0.3, memMB: 38, dbMB: 212, dbLimitMB: 500 });
    // A tenth and a fiftieth of the 900 GB disk.
    expect(limits).toEqual({ warnShare: 0.5, swapGrowthMBPerMin: 100, cpuTight: 8, cpuCapped: 9.4, thermalTight: 1, thermalCapped: 2, diskTight: 90, diskCapped: 18 });
  });

  test("the disk's lines are the ones for this machine's disk, in the limits and in the words", () => {
    const lines = (diskTotalKb: number | null) => {
      const { limits, words } = machine({ diskTotalKb });
      return [limits.diskTight, limits.diskCapped, /under [\d.]+ GB of disk is free/.exec(words.states[1].meaning)![0], /under [\d.]+ GB of disk is free/.exec(words.states[2].meaning)![0]];
    };
    expect(lines(256 * GB)).toEqual([25.6, 5.12, "under 25.6 GB of disk is free", "under 5.12 GB of disk is free"]);
    expect(lines(512 * GB)).toEqual([51.2, 10.24, "under 51.2 GB of disk is free", "under 10.24 GB of disk is free"]);
    expect(lines(1858 * GB)).toEqual([100, 20, "under 100 GB of disk is free", "under 20 GB of disk is free"]);
    expect(lines(null)).toEqual([100, 20, "under 100 GB of disk is free", "under 20 GB of disk is free"]);
  });

  test("the sentence names the three largest that are somebody, with their share of what all processes hold", () => {
    // 8 + 6 + 4 of 24.5 GB.
    expect(machine().now.sentence).toBe("Lane a (8.0 GB), b (6.0 GB) and lane c (4.0 GB) hold 73% of the 24.5 GB that processes hold.");
  });

  test("with CPU as the limit it names who uses the CPU, and nobody under 2% of the cores", () => {
    // a uses 1.5 cores and b 0.5 of the 8 that are busy; c uses 0.1.
    expect(machine(TIGHT).now.sentence).toBe("Lane a (1.5 cores) and b (0.5 cores) use 25% of the 8.0 cores that are busy.");
  });

  test("who uses the CPU is said beside it whatever the limit is, in cores, for the page's CPU view", () => {
    // a uses 1.5 cores and b 0.5 of the 2.5 that are busy. Nothing is the limit, so the sentence is about memory.
    const { sentence, sentenceCpu } = machine().now;
    expect(sentenceCpu).toBe("Lane a (1.5 cores) and b (0.5 cores) use 80% of the 2.5 cores that are busy.");
    expect(sentence).toContain("GB");
    expect(machine(TIGHT).now.sentenceCpu).toBe(machine(TIGHT).now.sentence);
  });

  test("where recording began is said once, for every range: the start of the minute the oldest sample is in, rolled up or not", () => {
    const s = openStore(":memory:");
    // The oldest tick is on the full minute, so it closes the minute before: recording began with minute 16.
    for (let i = 0; i <= 12; i++) s.write(min(17) + i * TICK, host(), []);
    const at = min(17) + 12 * TICK;
    expect(ask(s, at).began).toBe(min(16));
    s.roll(at);
    expect(ask(s, at).began).toBe(min(16));
    // A range starts where its own steps do, which is not where recording began.
    expect(new Set((["hour", "day", "week"] as const).map((key) => { const r = range(s.db, { now: at, key }); return r.t0 + r.host.held.findIndex((v) => v !== null) * r.step; })).size).toBe(3);
    // Half an hour on there is a quarter of an hour that starts at minute 15. The minutes still say it exactly.
    for (let m = 19; m < 47; m++) minute(s, m);
    s.roll(min(47));
    expect(ask(s, min(47)).began).toBe(min(16));
  });

  test("once the minutes of that time are gone, recording began with the oldest quarter of an hour", () => {
    const s = openStore(":memory:");
    for (let m = 16; m < 31; m++) minuteAt(s, B0 - 8 * DAY + m * MINUTE);
    s.roll(B0 - 8 * DAY + 31 * MINUTE);
    minute(s, 0);
    s.roll(min(1));
    expect(ask(s, min(1)).began).toBe(B0 - 8 * DAY + 16 * MINUTE);
    // Minutes are kept seven days: after that only the quarter of an hour from minute 15 on knows of that time.
    s.prune(min(1));
    expect(ask(s, min(1)).began).toBe(B0 - 8 * DAY + 15 * MINUTE);
  });

  test("the detail gives the numbers behind the verdict", () => {
    expect(machine().now.detail).toBe("Pressure normal, 30% of memory available. 40.0 GB compressed into 10.0 GB. Swap 5.0 of 20.0 GB, steady. 2.5 of 10 cores busy. 450 GB of disk free.");
  });
});

describe("a range: its samples", () => {
  const empty = () => openStore(":memory:").db;
  const frame = (at: number, key: Parameters<typeof range>[1]["key"]) => {
    const { label, t0, step, n, host: h } = range(empty(), { now: at, key });
    return { label, t0, step, n, length: h.held.length };
  };

  test("an hour is 60 samples of a minute, a day 288 of five, a week 336 of thirty, 90 days 360 of six hours", () => {
    // Ninety seconds past nine: the minute from 9:01, the five minutes and the half hour from 9:00, the six hours from 6:00.
    const at = B0 + 90_000;
    expect(frame(at, "hour")).toEqual({ label: "1 hour", t0: B0 + MINUTE - 59 * MINUTE, step: MINUTE, n: 60, length: 60 });
    expect(frame(at, "day")).toEqual({ label: "24 hours", t0: B0 - 287 * 5 * MINUTE, step: 5 * MINUTE, n: 288, length: 288 });
    expect(frame(at, "week")).toEqual({ label: "7 days", t0: B0 - 335 * 30 * MINUTE, step: 30 * MINUTE, n: 336, length: 336 });
    expect(frame(at, "quarter")).toEqual({ label: "90 days", t0: B0 - 3 * HOUR - 359 * 6 * HOUR, step: 6 * HOUR, n: 360, length: 360 });
  });

  test("the last sample is the one that holds now: a tick on the full minute closes the minute before", () => {
    expect(frame(B0, "hour").t0).toBe(B0 - 60 * MINUTE);
    expect(frame(B0 + 1000, "hour").t0).toBe(B0 - 59 * MINUTE);
  });

  test("a range the monitor has not recorded is null in every series, with the four fixed holders", () => {
    const r = range(empty(), { now: B0, key: "week" });
    for (const series of [...Object.values(r.host), ...Object.values(r.mem), ...Object.values(r.cpu)]) expect(series).toEqual(new Array(336).fill(null));
    expect(Object.keys(r.mem)).toEqual(FIXED);
    expect(ids(r.holders)).toEqual(FIXED);
  });
});

describe("a range: what was recorded", () => {
  // Minutes 0, 1 and 3 of the hour; minute 2 is missing. Asked at the end of minute 3, they are samples 56 to 59.
  function hour() {
    const s = openStore(":memory:");
    minute(s, 0, { heldKb: 6 * GB, busyMs: 20_000 }, [lane("a", 10_000, 4 * GB), app("b", 5000, 2 * GB), KERNEL(3000)]);
    minute(s, 1, { heldKb: 7 * GB, busyMs: 20_000 }, [lane("a", 10_000, 5 * GB), app("b", 5000, 2 * GB), KERNEL(3000)]);
    minute(s, 3, { heldKb: 9.5 * GB, busyMs: 30_000 }, [lane("a", 20_000, 5 * GB), app("b", 5000, 4 * GB), used("system", "system", 2000, GB / 2), KERNEL(3000)]);
    s.roll(min(4));
    return range(s.db, { now: min(4), key: "hour" });
  }
  const tail = (series: (number | null)[]) => series.slice(55);

  test("each holder's memory and CPU per sample, and null where nothing was sampled", () => {
    const r = hour();
    expect(r.t0 + 56 * r.step).toBe(min(0));
    expect(tail(r.mem["lane:a"])).toEqual([null, 4, 5, null, 5]);
    expect(tail(r.cpu["lane:a"])).toEqual([null, 1, 1, null, 2]);
    expect(tail(r.mem["app:b"])).toEqual([null, 2, 2, null, 4]);
    expect(tail(r.mem.system)).toEqual([null, 0, 0, null, 0.5]);
  });

  test("a gap is null in every series, and before the first sample too", () => {
    const r = hour();
    for (const series of [...Object.values(r.host), ...Object.values(r.mem), ...Object.values(r.cpu)]) {
      expect(series.length).toBe(60);
      expect([series[55], series[58]]).toEqual([null, null]);
      expect(series[57]).not.toBeNull();
    }
  });

  test("the holders' memory adds up to what all processes hold, and their CPU to the busy cores", () => {
    const r = hour();
    for (const i of [56, 57, 59]) {
      expect(Object.values(r.mem).reduce((sum, series) => sum + series[i]!, 0)).toBeCloseTo(r.host.held[i]!, 5);
    }
    expect(tail(r.host.held)).toEqual([null, 6, 7, null, 9.5]);
    // Minute 3: a 2 cores, b 0.5, the system 0.2 and the kernel 0.3.
    expect(Object.values(r.cpu).reduce((sum, series) => sum + series[59]!, 0)).toBeCloseTo(r.host.busy[59]!, 5);
    expect(tail(r.host.busy)).toEqual([null, 2, 2, null, 3]);
  });

  test("the kernel's CPU is part of System", () => {
    expect(tail(hour().cpu.system)).toEqual([null, 0.3, 0.3, null, 0.5]);
  });

  // One minute whose sixth tick is the worst one.
  const WORST_SIXTH = (i: number) => (i < 6 ? { available: 40, heldKb: 6 * GB, busyMs: 20_000, swapUsedKb: 5 * GB, memStoredKb: 8 * GB, memCompressedKb: 2 * GB, diskFreeKb: 300 * GB } : { available: 30, heldKb: 9 * GB, busyMs: 80_000, swapUsedKb: 2 * GB, memStoredKb: 9 * GB, memCompressedKb: 3 * GB, diskFreeKb: 280 * GB });
  const sampleOf = (h: ReturnType<typeof range>["host"], i: number) => Object.fromEntries(Object.entries(h).map(([name, series]) => [name, series[i]]));

  test("the machine's series: averages over the sample's ticks and the worst tick beside them", () => {
    const s = openStore(":memory:");
    minute(s, 0, WORST_SIXTH);
    minute(s, 1);
    s.roll(min(2));
    // Available 38.3% on average and 30% at the least. Swap (5 x 5 + 2) / 6 GB, held (5 x 6 + 9) / 6 GB, stored (5 x 8 + 9) / 6 GB, busy 180 s of CPU in 60 s.
    expect(sampleOf(range(s.db, { now: min(2), key: "hour" }).host, 58)).toEqual({ pressure: 61.7, pressureMax: 70, level: 0, swap: 4.5, stored: 8.17, compressed: 2.17, held: 6.5, heldMax: 9, busy: 3, busyMax: 8, diskFree: 280, thermal: 0, state: 0, limiter: 0 });
  });

  test("the last sample holds now: its memory is the newest tick's, so no peak of the range is under what now holds", () => {
    const s = openStore(":memory:");
    minute(s, 0, WORST_SIXTH, (i) => [lane("grower", 3000, i === 6 ? 3 * GB : GB), ...(i <= 3 ? [lane("gone", 0, 2 * GB)] : [])]);
    s.roll(min(1));
    const r = range(s.db, { now: min(1), key: "hour" });
    // CPU is still what was used over the sample, and the worst tick is still beside it.
    expect(sampleOf(r.host, 59)).toEqual({ pressure: 70, pressureMax: 70, level: 0, swap: 2, stored: 9, compressed: 3, held: 9, heldMax: 9, busy: 3, busyMax: 8, diskFree: 280, thermal: 0, state: 0, limiter: 0 });
    expect([r.mem["lane:grower"][59], r.cpu["lane:grower"][59]]).toEqual([3, 0.3]);
    // gone held 2 GB in half the minute and holds nothing now: it is no holder of this range, as it is none of now.
    expect([r.mem["lane:gone"], r.mem.lanes[59]]).toEqual([undefined, 0]);
    const seen = ask(s, min(1));
    expect(r.host.held[59]).toBe(seen.now.held);
    expect(r.mem["lane:grower"][59]).toBe(seen.now.holders.find((h) => h.id === "lane:grower")!.mem);
    // Asked a minute later the same minute is a sample of the past, and an average again.
    minute(s, 1);
    s.roll(min(2));
    expect(range(s.db, { now: min(2), key: "hour" }).mem["lane:grower"][58]).toBe(1.33);
  });

  test("the kernel's highest pressure level and the highest thermal level of a sample, and neither where they could not be read", () => {
    const s = openStore(":memory:");
    minute(s, 0, (i) => ({ pressure: i === 3 ? 4 : i === 2 ? 2 : 1, thermal: i === 5 ? 2 : 0 }));
    minute(s, 1, { pressure: 2, thermal: 1 });
    minute(s, 2, { pressure: null, thermal: null });
    s.roll(min(3));
    const { host: h } = range(s.db, { now: min(3), key: "hour" });
    expect(h.level.slice(-3)).toEqual([2, 1, null]);
    expect(h.thermal.slice(-3)).toEqual([2, 1, null]);
  });

  test("state and limiter per sample come from the rules: 0 none, 1 memory, 2 CPU, 3 disk, 4 heat", () => {
    const s = rolled([CALM, { pressure: 4 }, CAPPED, { diskFreeKb: 50 * GB }, { thermal: 1 }, { ...TIGHT, pressure: 2 }]);
    const { host: h } = range(s.db, { now: min(6), key: "hour" });
    expect(h.state.slice(54)).toEqual([0, 2, 2, 1, 1, 1]);
    expect(h.limiter.slice(54)).toEqual([0, 1, 2, 3, 4, 1]);
  });

  test("the ticks of the minute still running are the last sample, and it takes the verdict on now", () => {
    const s = openStore(":memory:");
    minute(s, 0, { heldKb: 2 * GB }, [lane("a", 0, 2 * GB)]);
    for (let i = 1; i <= 3; i++) s.write(min(1) + i * TICK, host({ heldKb: 4 * GB, thermal: 2 }), [lane("a", 0, 4 * GB)]);
    s.roll(min(1) + 30_000);
    const r = range(s.db, { now: min(1) + 30_000, key: "hour" });
    expect(r.t0 + 59 * r.step).toBe(min(1));
    expect(r.mem["lane:a"].slice(58)).toEqual([2, 4]);
    expect(r.host.held.slice(58)).toEqual([2, 4]);
    expect(r.host.state.slice(58)).toEqual([0, 2]);
    expect(r.host.limiter.slice(58)).toEqual([0, 4]);
  });

  test("a day's sample is five minutes: averages over all of them, and the state of the worst minute", () => {
    const s = openStore(":memory:");
    for (let m = 0; m < 6; m++) minute(s, m, m === 2 ? CAPPED : CALM, [lane("a", 0, (m === 4 ? 6 : 1) * GB)]);
    s.roll(min(6));
    const r = range(s.db, { now: min(6), key: "day" });
    expect(r.t0 + 286 * r.step).toBe(B0);
    // (4 x 1 + 6) / 5 GB. Busy (4 x 1 + 9.5) / 5 cores, and 9.5 at the most.
    expect([r.mem["lane:a"][286], r.host.busy[286], r.host.busyMax[286], r.host.state[286], r.host.limiter[286]]).toEqual([2, 2.7, 9.5, 2, 2]);
    expect(r.mem["lane:a"][285]).toBeNull();
  });

  test("a week and 90 days read the quarters of an hour, and the minutes after the last full one, each once", () => {
    const s = openStore(":memory:");
    for (let m = 0; m < 20; m++) minute(s, m, { heldKb: (m < 15 ? 2 : 4) * GB, swapUsedKb: (m < 15 ? 2 : 4) * GB }, [lane("a", m < 15 ? 1000 : 3000, (m < 15 ? 2 : 4) * GB)]);
    s.roll(min(20));
    // Fifteen minutes at 2 GB of swap and 0.1 cores, five at 4 GB and 0.3 cores: 2.5 GB and 0.15 cores over the
    // twenty. Read twice, the quarter's minutes would weigh more.
    for (const [key, n] of [["week", 336], ["quarter", 360]] as const) {
      const r = range(s.db, { now: min(20), key });
      expect([r.cpu["lane:a"][n - 1], r.host.busy[n - 1]]).toEqual([0.15, 0]);
      expect(r.mem["lane:a"][n - 2]).toBeNull();
    }
    // An hour later the twenty minutes are a sample of the past: its memory is the average too.
    minute(s, 80, {}, []);
    s.roll(min(81));
    const week = range(s.db, { now: min(81), key: "week" });
    expect([week.mem["lane:a"][333], week.host.held[333], week.host.swap[333]]).toEqual([2.5, 2.5, 2.5]);
  });

  // Two minutes. spike reaches 1.5 GB in the second only, burst 2% of the cores in the second only; flat stays under
  // both.
  function spiky() {
    const s = openStore(":memory:");
    minute(s, 0, {}, [lane("spike", 0, 0.2 * GB), lane("flat", 0, 0.4 * GB, { name: "node" })]);
    minute(s, 1, {}, [lane("spike", 0, 1.5 * GB), lane("flat", 0, 0.4 * GB, { name: "node" }), app("burst", 2000, 0)]);
    s.roll(min(2));
    return s;
  }

  test("in a range, a lane or an app has its own series when it reaches half a GB or 2% of the cores in any sample", () => {
    const r = range(spiky().db, { now: min(2), key: "hour" });
    expect(ids(r.holders)).toEqual(["lane:spike", "app:burst", ...FIXED]);
    expect(r.mem["lane:spike"].slice(58)).toEqual([0.2, 1.5]);
    expect(r.cpu["app:burst"].slice(58)).toEqual([0, 0.2]);
    expect(r.mem.lanes.slice(58)).toEqual([0.4, 0.4]);
    expect(r.mem["lane:flat"]).toBeUndefined();
  });

  describe("moment", () => {
    const at = (t: number, holders?: ReturnType<typeof range>["holders"]) => {
      const { db } = spiky();
      return moment(db, { now: min(2), key: "hour", t, holders: holders ?? range(db, { now: min(2), key: "hour" }).holders });
    };

    test("who held what in the sample that holds a time, as the range's holders, each with its parts", () => {
      // spike is under half a GB in this minute and still its own holder, because the range says so.
      expect(at(min(0) + 20_000)).toEqual({
        t: min(0), step: MINUTE,
        holders: [
          { id: "lanes", mem: 0.4, cpu: 0, memParts: [{ name: "lane flat", value: 0.4 }], cpuParts: [] },
          { id: "lane:spike", mem: 0.2, cpu: 0, memParts: [{ name: "spike", value: 0.2 }], cpuParts: [] },
        ],
      });
      expect(at(min(1))!.holders.slice(0, 2)).toEqual([
        { id: "lane:spike", mem: 1.5, cpu: 0, memParts: [{ name: "spike", value: 1.5 }], cpuParts: [] },
        { id: "lanes", mem: 0.4, cpu: 0, memParts: [{ name: "lane flat", value: 0.4 }], cpuParts: [] },
      ]);
    });

    test("an owner the range folds stays folded, whatever it holds at that time", () => {
      expect(at(min(1), [])!.holders[0]).toEqual({ id: "lanes", mem: 1.9, cpu: 0, memParts: [{ name: "lane spike", value: 1.5 }, { name: "lane flat", value: 0.4 }], cpuParts: [] });
    });

    test("nothing where there was no sample, and nothing outside the range", () => {
      expect(at(min(-5))).toBeNull();
      expect(at(min(-70))).toBeNull();
      expect(at(min(2))).toBeNull();
    });
  });
});

describe("days", () => {
  test("a day starts at midnight of the zone that is passed in", () => {
    // Four minutes around 22:00 UTC, which is midnight two hours east of it.
    const midnight = Date.parse("2026-03-10T22:00:00Z");
    const s = openStore(":memory:");
    for (const m of [-2, -1, 0, 1]) minuteAt(s, midnight + m * MINUTE);
    s.roll(midnight + 2 * MINUTE);
    const at = { now: midnight + 2 * MINUTE };
    expect(days(s.db, { ...at, zone: () => 120 }).map((d) => [d.t, d.date])).toEqual([[midnight - DAY, "2026-03-10"], [midnight, "2026-03-11"]]);
    expect(days(s.db, { ...at, zone: () => 0 }).map((d) => [d.t, d.date])).toEqual([[Date.parse("2026-03-10T00:00:00Z"), "2026-03-10"]]);
    expect(days(s.db, { ...at, zone: () => -480 }).map((d) => [d.t, d.date])).toEqual([[Date.parse("2026-03-10T08:00:00Z"), "2026-03-10"]]);
  });

  // A zone whose clocks go back an hour on 25 October 2026 and forward on 29 March 2026, both at 01:00 UTC. Two
  // minutes are written on either side of each of the given midnights, and now is the end of the last.
  const BERLIN = zoneNamed("Europe/Berlin");
  function around(midnights: string[], rows: (m: number) => Usage[] = () => []) {
    const s = openStore(":memory:");
    for (const midnight of midnights) for (const m of [-2, -1, 0, 1]) minuteAt(s, Date.parse(midnight) + m * MINUTE, {}, rows(Date.parse(midnight) + m * MINUTE));
    const end = Date.parse(midnights.at(-1)!) + 2 * MINUTE;
    s.roll(end);
    return days(s.db, { now: end, zone: BERLIN });
  }

  test("the day the clocks go back is 25 hours long: it starts at its own midnight and ends at the next day's", () => {
    // Midnight of 25 October is 22:00 UTC, by summer time. Midnight of the 26th is 23:00 UTC, by winter time.
    const found = around(["2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"]);
    expect(found.map((d) => [d.date, new Date(d.t).toISOString(), d.gapMinutes])).toEqual([
      ["2026-10-24", "2026-10-23T22:00:00.000Z", 24 * 60 - 2],
      ["2026-10-25", "2026-10-24T22:00:00.000Z", 25 * 60 - 4],
      ["2026-10-26", "2026-10-25T23:00:00.000Z", 0],
    ]);
  });

  test("the day the clocks go forward is 23 hours long", () => {
    // Midnight of 29 March is 23:00 UTC, by winter time. Midnight of the 30th is 22:00 UTC, by summer time.
    const found = around(["2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z"]);
    expect(found.map((d) => [d.date, new Date(d.t).toISOString(), d.gapMinutes])).toEqual([
      ["2026-03-28", "2026-03-27T23:00:00.000Z", 24 * 60 - 2],
      ["2026-03-29", "2026-03-28T23:00:00.000Z", 23 * 60 - 4],
      ["2026-03-30", "2026-03-29T22:00:00.000Z", 0],
    ]);
  });

  test("the 25th hour belongs to the long day: who held the most in it is that day's, and its suite run too", () => {
    const lastHour = Date.parse("2026-10-25T22:58:00Z");
    const s = openStore(":memory:");
    minuteAt(s, lastHour, {}, [lane("night", 0, 8 * GB)]);
    minuteAt(s, lastHour + 2 * MINUTE, {}, [lane("morning", 0, 4 * GB)]);
    s.mark(lastHour + 30_000, "suite", "full suite started");
    s.roll(lastHour + 3 * MINUTE);
    expect(days(s.db, { now: lastHour + 3 * MINUTE, zone: BERLIN }).map((d) => [d.date, d.runs, d.top.map((t) => t.id)])).toEqual([
      ["2026-10-25", 1, ["lane:night"]],
      ["2026-10-26", 0, ["lane:morning"]],
    ]);
  });

  test("runs are the suite marks of the day, and a day with samples missing is partial", () => {
    const midnight = Date.parse("2026-03-10T22:00:00Z");
    const s = openStore(":memory:");
    for (const m of [-2, -1, 0, 1]) minuteAt(s, midnight + m * MINUTE);
    s.roll(midnight + 2 * MINUTE);
    s.mark(midnight - 90_000, "suite", "full suite started");
    s.mark(midnight + 30_000, "suite", "full suite started");
    s.mark(midnight + 60_000, "suite", "full suite started");
    s.mark(midnight + 70_000, "release", "0.1.0");
    // The first day has two of its 1440 minutes. The second is two minutes old and has both.
    expect(days(s.db, { now: midnight + 2 * MINUTE, zone: () => 120 }).map((d) => [d.date, d.runs, d.gapMinutes, d.partial])).toEqual([["2026-03-10", 1, 1438, true], ["2026-03-11", 2, 0, true]]);
  });

  // All of 9 March and the first minute of 10 March, UTC. Three minutes of 9 March are capped by memory and two are
  // close to the cap by heat; minute 600 has the day's worst readings.
  function fullDay() {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    for (let m = 0; m <= 1440; m++) {
      const worst = m === 600 ? { available: 4, swapUsedKb: 14 * GB, busyMs: 60_000, heldKb: 66 * GB, diskFreeKb: 150 * GB } : {};
      minuteAt(s, start + m * MINUTE, { diskFreeKb: 200 * GB, heldKb: 40 * GB, ...(m >= 600 && m < 603 ? { pressure: 4 } : {}), ...(m === 700 || m === 701 ? { thermal: 1 } : {}), ...worst });
    }
    s.roll(start + 1441 * MINUTE);
    return days(s.db, { now: start + 1441 * MINUTE, zone: () => 0 });
  }

  test("a whole day: its state, the minutes capped and close to the cap, and its worst readings", () => {
    expect(fullDay()[0]).toEqual({
      t: Date.parse("2026-03-09T00:00:00Z"), date: "2026-03-09", state: 2, cappedMinutes: 3, tightMinutes: 2, gapMinutes: 0,
      pressureMax: 96, swapMax: 14, busyMax: 6, heldMax: 66, diskFree: 150, runs: 0, partial: false,
      // Minute 600 is the one up to 10:01, and is named by that.
      worst: { t: Date.parse("2026-03-09T10:01:00Z"), top: [] },
      top: [],
    });
  });

  test("a day's worst moment and who held the most in it, though they held little over the day", () => {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    // sitter holds 6 GB all day. In minute 3 memory is capped and burst holds 20 GB, pane ~/work/shop 2 GB.
    for (let m = 0; m < 6; m++) {
      minuteAt(s, start + m * MINUTE, m === 3 ? { pressure: 4, available: 5 } : {}, [lane("sitter", 0, 6 * GB), ...(m === 3 ? [lane("burst", 0, 20 * GB), used("pane", "~/work/shop", 0, 2 * GB), lane("tiny", 0, 0.2 * GB)] : [])]);
    }
    s.roll(start + 6 * MINUTE);
    expect(days(s.db, { now: start + 6 * MINUTE, zone: () => 0 })[0].worst).toEqual({
      t: start + 4 * MINUTE,
      top: [{ id: "lane:burst", name: "lane burst", mem: 20 }, { id: "lane:sitter", name: "lane sitter", mem: 6 }, { id: holderId("pane", "~/work/shop"), name: "pane shop", mem: 2 }],
    });
  });

  test("a calm day's worst moment is the one with the least memory available", () => {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    for (let m = 0; m < 4; m++) minuteAt(s, start + m * MINUTE, { available: m === 2 ? 35 : 50 }, [lane("a", 0, (m + 1) * GB)]);
    s.roll(start + 4 * MINUTE);
    expect(days(s.db, { now: start + 4 * MINUTE, zone: () => 0 })[0].worst).toEqual({ t: start + 3 * MINUTE, top: [{ id: "lane:a", name: "lane a", mem: 3 }] });
  });

  // Six minutes of one day. steady holds 6 GB throughout. late starts in the last minute and holds 30 GB at the
  // newest sample, which is 30 GB in 6 of the day's 36 samples: 5 GB on average. brief holds 2 GB for one minute,
  // a third of a GB on average, which is under the half GB that earns a name.
  function lateRiser() {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    for (let m = 0; m < 6; m++) minuteAt(s, start + m * MINUTE, {}, [lane("steady", 0, 6 * GB), ...(m === 5 ? [lane("late", 0, 30 * GB)] : []), ...(m === 2 ? [lane("brief", 0, 2 * GB)] : [])]);
    return { s, start };
  }

  test("who held the most over a day is the average over all its samples, not what the newest sample holds", () => {
    const { s, start } = lateRiser();
    s.roll(start + 6 * MINUTE);
    const [day] = days(s.db, { now: start + 6 * MINUTE, zone: () => 0 });
    expect(day.top).toEqual([{ id: "lane:steady", name: "lane steady", mem: 6 }, { id: "lane:late", name: "lane late", mem: 5 }]);
    // What the newest sample holds is another answer, and now gives it.
    expect(ask(s, start + 6 * MINUTE).now.holders.slice(0, 2).map((h) => [h.id, h.mem])).toEqual([["lane:late", 30], ["lane:steady", 6]]);
  });

  test("the average counts the ticks no minute holds yet", () => {
    const { s, start } = lateRiser();
    // The sixth minute is still running: its six ticks are in no bucket.
    s.roll(start + 5 * MINUTE);
    expect(days(s.db, { now: start + 6 * MINUTE, zone: () => 0 })[0].top.map((t) => [t.id, t.mem])).toEqual([["lane:steady", 6], ["lane:late", 5]]);
  });

  test("each day is averaged over its own samples, and a day that is over says the same when it is asked again", () => {
    const midnight = Date.parse("2026-03-10T00:00:00Z");
    const s = openStore(":memory:");
    for (const m of [-3, -2, -1]) minuteAt(s, midnight + m * MINUTE, {}, [lane("a", 0, 4 * GB)]);
    for (const m of [0, 1]) minuteAt(s, midnight + m * MINUTE, {}, [lane("a", 0, 8 * GB)]);
    s.roll(midnight + 2 * MINUTE);
    const tops = (now: number) => days(s.db, { now, zone: () => 0 }).map((d) => d.top.map((t) => t.mem));
    expect(tops(midnight + 2 * MINUTE)).toEqual([[4], [8]]);
    // Today goes on, with a at 2 GB for a minute: 18 GB over three minutes. Yesterday is as it was.
    minuteAt(s, midnight + 2 * MINUTE, {}, [lane("a", 0, 2 * GB)]);
    s.roll(midnight + 3 * MINUTE);
    expect(tops(midnight + 3 * MINUTE)).toEqual([[4], [6]]);
  });

  // A day whose second minute is capped with 10% of memory available, and whose third gets worse with every tick.
  function worsening(ticks: number) {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    minuteAt(s, start, {}, [lane("a", 0, 5 * GB)]);
    minuteAt(s, start + MINUTE, { pressure: 4, available: 10 }, [lane("a", 0, 10 * GB)]);
    for (let i = 1; i <= ticks; i++) s.write(start + 2 * MINUTE + i * TICK, host({ pressure: 4, available: 10 - i }), [lane("a", 0, (10 + 5 * i) * GB)]);
    s.roll(start + 2 * MINUTE + ticks * TICK);
    return { s, start, now: start + 2 * MINUTE + ticks * TICK };
  }

  test("a day's worst moment is now when the newest sample is at least as bad as its worst minute, with the time and the holders now has", () => {
    const { s, now: at } = worsening(3);
    const [day] = days(s.db, { now: at, zone: () => 0 });
    expect(day.worst).toEqual({ t: at, top: [{ id: "lane:a", name: "lane a", mem: 25 }] });
    // The incident that still runs and now itself say the same time and the same figure.
    expect(incidents(s.db, { now: at }).incidents[0]).toMatchObject({ peak: at, ongoing: true });
    expect(ask(s, at).now).toMatchObject({ t: at, holders: [{ id: "lane:a", mem: 25 }] });
  });

  test("the minute the newest sample closes is that sample: what is held now, not the minute's average", () => {
    const { s, now: at, start } = worsening(6);
    expect(at).toBe(start + 3 * MINUTE);
    // Over its six ticks a held 15 to 40 GB, 27.5 on average. The newest holds 40.
    expect(days(s.db, { now: at, zone: () => 0 })[0].worst).toEqual({ t: at, top: [{ id: "lane:a", name: "lane a", mem: 40 }] });
    expect(incidents(s.db, { now: at }).incidents[0].peak).toBe(at);
  });

  test("a day whose worst is behind it keeps it there: the minute, by the time it ends", () => {
    const { s, start } = worsening(0);
    for (let i = 1; i <= 2; i++) s.write(start + 2 * MINUTE + i * TICK, host({ pressure: 4, available: 40 }), [lane("a", 0, 3 * GB)]);
    const at = start + 2 * MINUTE + 2 * TICK;
    expect(days(s.db, { now: at, zone: () => 0 })[0].worst).toEqual({ t: start + 2 * MINUTE, top: [{ id: "lane:a", name: "lane a", mem: 10 }] });
    expect(incidents(s.db, { now: at }).incidents[0].peak).toBe(start + 2 * MINUTE);
  });

  test("a day's peaks count the ticks of the minute still running", () => {
    const start = Date.parse("2026-03-09T00:00:00Z");
    const s = openStore(":memory:");
    minuteAt(s, start, { heldKb: 10 * GB, swapUsedKb: GB });
    s.roll(start + MINUTE);
    s.write(start + MINUTE + TICK, host({ heldKb: 30 * GB, swapUsedKb: 3 * GB, available: 8, diskFreeKb: 60 * GB }), []);
    expect(days(s.db, { now: start + MINUTE + TICK, zone: () => 0 })[0]).toMatchObject({ heldMax: 30, swapMax: 3, pressureMax: 92, diskFree: 60 });
  });

  test("the day still running is partial, and is the last", () => {
    expect(fullDay()[1]).toMatchObject({ date: "2026-03-10", state: 0, cappedMinutes: 0, tightMinutes: 0, gapMinutes: 0, partial: true });
    expect(fullDay().length).toBe(2);
  });

  test("90 days at most, and only the days that have data", () => {
    const s = openStore(":memory:");
    for (const ago of [95, 89, 40, 0]) minuteAt(s, B0 - ago * DAY);
    s.roll(B0 + MINUTE);
    expect(days(s.db, { now: B0 + MINUTE, zone: () => 0 }).map((d) => d.date)).toEqual(["2025-12-11", "2026-01-29", "2026-03-10"]);
  });
});

describe("events", () => {
  const all = { from: B0 - HOUR, to: B0 + HOUR };

  test("a restart is a reboot, with how long the machine had been up", () => {
    const s = openStore(":memory:");
    const before = B0 / 1000 - 5 * 3600;
    const after = B0 / 1000 + 200;
    for (const m of [0, 1]) minute(s, m, { bootAt: before });
    for (const m of [5, 6]) minute(s, m, { bootAt: after });
    s.roll(min(7));
    // Up from five hours before B0 to the last sample of that run, two minutes after it.
    expect(events(s.db, all)).toEqual([{ t: after * 1000, kind: "reboot", label: "The machine restarted after 5 h 2 min up", holder: null }]);
  });

  test("a gap keeps its kind and says how long", () => {
    const s = openStore(":memory:");
    for (const m of [0, 21]) minute(s, m);
    s.roll(min(22));
    expect(events(s.db, all)).toEqual([{ t: min(1), kind: "gap", label: "No samples for 20 min", holder: null }]);
  });

  test("a lane that started or ended, with the lane's holder id", () => {
    const s = openStore(":memory:");
    for (let m = 0; m < 6; m++) minute(s, m, {}, [lane("runner"), ...(m >= 2 && m < 4 ? [lane("builder")] : [])]);
    s.roll(min(6));
    expect(events(s.db, all)).toEqual([
      { t: min(2), kind: "lane-start", label: "Lane builder started", holder: "lane:builder" },
      { t: min(4), kind: "lane-end", label: "Lane builder ended", holder: "lane:builder" },
    ]);
  });

  test("a suite mark is a test run, and any other mark keeps its kind", () => {
    const s = openStore(":memory:");
    s.mark(B0, "suite", "full suite started");
    s.mark(B0 + 1000, "release", "0.1.0");
    s.mark(B0 + 2000, undefined, "moved the cache");
    expect(events(s.db, all)).toEqual([
      { t: B0, kind: "test-run", label: "Full suite started", holder: null },
      { t: B0 + 1000, kind: "release", label: "0.1.0", holder: null },
      { t: B0 + 2000, kind: "note", label: "Moved the cache", holder: null },
    ]);
  });
});

describe("incidents", () => {
  // Six minutes: calm, close to the cap, capped, close, calm, calm. builder uses 80% of what is busy, and Editor
  // holds more memory than builder does.
  function cpu() {
    const s = openStore(":memory:");
    [CALM, TIGHT, CAPPED, TIGHT, CALM, CALM].forEach((h, m) => minute(s, m, h, [lane("builder", h.busyMs * 0.8, 2 * GB), app("Editor", 1000, 3 * GB), KERNEL(500)]));
    s.roll(min(6));
    return incidents(s.db, { now: min(6) });
  }

  test("CPU: its times, its peak at the busiest minute, named by when that minute ends, and how long it was capped", () => {
    const [incident, ...more] = cpu().incidents;
    expect(more).toEqual([]);
    expect(incident).toMatchObject({
      id: `cpu-${min(1) / MINUTE}`, resource: "cpu", severity: 2, t0: min(1), t1: min(4), peak: min(3), closeT0: min(1) - 30 * MINUTE, closeT1: min(6), minutes: 3, cappedMinutes: 1, ongoing: false,
      host: { pressure: 50, swap: 0, held: 0, busy: 9.5, stored: 0.01, diskFree: 100 },
    });
  });

  test("CPU: the holders at the peak, most CPU first, with their parts, and the one that used most of it as the culprit", () => {
    const { incidents: [incident], holders } = cpu();
    // There is no sample half an hour before the peak, so nothing is known about growth.
    expect(incident.holders).toEqual([
      { id: "lane:builder", mem: 2, cpu: 7.6, grew: null, parts: [{ name: "builder", value: 7.6 }] },
      { id: "app:Editor", mem: 3, cpu: 0.1, grew: null, parts: [{ name: "Editor", value: 0.1 }] },
      { id: "system", mem: 0, cpu: 0.05, grew: null, parts: [{ name: "kernel and unattributed", value: 0.05 }] },
    ]);
    expect(incident.culprits).toEqual(["lane:builder"]);
    expect(incident.events).toEqual([]);
    expect(ids(holders)).toEqual(["app:Editor", "lane:builder", ...FIXED]);
  });

  test("CPU: the words say what limited the machine, for how long, the peak and who used most", () => {
    const [incident] = cpu().incidents;
    expect(incident.headline).toBe("CPU ran short for 3 min and was capped for 1 min of it.");
    expect(incident.summary).toBe("At its peak 9.5 of 10 cores were busy. Lane builder (7.6 cores) used 80% of the 9.5 cores that were busy.");
  });

  // 41 minutes. Memory is capped in minutes 35 and 36, and 36 is the worse. Lane a grows from 2 to 6 GB at minute
  // 35, app b comes with 3 GB at minute 20, lane late at minute 30. A suite is marked at minute 31.
  function memory(skip: number[] = []) {
    const s = openStore(":memory:");
    for (let m = 0; m <= 40; m++) {
      if (skip.includes(m)) continue;
      const rows = [lane("a", 0, (m >= 35 && m <= 36 ? 6 : 2) * GB), lane("tiny", 0, 0.4 * GB), ...(m >= 20 ? [app("b", 0, 3 * GB)] : []), ...(m >= 30 ? [lane("late", 0, 0.3 * GB)] : [])];
      const held = { heldKb: rows.reduce((sum, row) => sum + row.memKb, 0) };
      minute(s, m, m === 35 ? { ...held, pressure: 4, available: 10 } : m === 36 ? { ...held, pressure: 4, available: 4 } : held, rows);
    }
    s.roll(min(41));
    s.mark(min(31), "suite", "full suite started");
    return incidents(s.db, { now: min(41) });
  }

  test("memory: the peak is the minute with the least memory available, and grew is the change over the half hour before it", () => {
    const [incident] = memory().incidents;
    expect(incident).toMatchObject({ id: `memory-${min(35) / MINUTE}`, resource: "memory", severity: 2, t0: min(35), t1: min(37), peak: min(37), minutes: 2, cappedMinutes: 2, ongoing: false, host: { pressure: 96, held: 9.7 } });
    // At minute 6, half an hour before the peak: a held 2 GB, b was not running, and only tiny was among the small lanes.
    expect(incident.holders).toEqual([
      { id: "lane:a", mem: 6, cpu: 0, grew: 4, parts: [{ name: "a", value: 6 }] },
      { id: "app:b", mem: 3, cpu: 0, grew: 3, parts: [{ name: "b", value: 3 }] },
      { id: "lanes", mem: 0.7, cpu: 0, grew: 0.3, parts: [{ name: "lane tiny", value: 0.4 }, { name: "lane late", value: 0.3 }] },
    ]);
    // a held 6 of the 9.7 GB: more than half by itself.
    expect(incident.culprits).toEqual(["lane:a"]);
  });

  test("memory: with no sample half an hour before the peak, grew is unknown", () => {
    expect(memory([6]).incidents[0].holders.map((h) => h.grew)).toEqual([null, null, null]);
  });

  test("its events are the marks from half an hour before it to its end, and the words give them without a cause", () => {
    const [incident] = memory().incidents;
    expect(incident.events).toEqual([
      { t: min(30), kind: "lane-start", label: "Lane late started", holder: "lane:late" },
      { t: min(31), kind: "test-run", label: "Full suite started", holder: null },
    ]);
    expect(incident.headline).toBe("Memory was capped for 2 min.");
    expect(incident.summary).toBe(
      "Memory pressure peaked at 96%, at the kernel's critical level. Swap did not grow over it. Lane a (6.0 GB) and b (3.0 GB) held 93% of the 9.7 GB that processes held. Lane late started 5 min before it. Full suite started 4 min before it.",
    );
  });

  test("of an incident that lasts longer than a day, the events are those of its first day", () => {
    const s = openStore(":memory:");
    for (let m = 0; m < 26 * 60; m++) minute(s, m, { thermal: 1 });
    s.roll(B0 + 26 * HOUR);
    for (const hours of [-1, 1, 25]) s.mark(B0 + hours * HOUR + 15 * MINUTE, "note", `${hours} h`);
    for (const minutes of [-20, 20]) s.mark(B0 + minutes * MINUTE, "note", `${minutes} min`);
    const [incident] = incidents(s.db, { now: B0 + 26 * HOUR }).incidents;
    expect(incident).toMatchObject({ resource: "heat", t0: B0, t1: B0 + 26 * HOUR, minutes: 26 * 60 });
    expect(incident.events.map((e) => e.label)).toEqual(["-20 min", "20 min", "1 h"]);
    expect(incident.summary).toBe("The thermal pressure reached moderate. -20 min 20 min before it.");
  });

  test("close to the cap is severity 1, and one that reaches the newest minute is ongoing", () => {
    const s = rolled([CALM, { thermal: 1 }, { thermal: 1 }]);
    expect(incidents(s.db, { now: min(3) }).incidents).toMatchObject([
      { resource: "heat", severity: 1, t0: min(1), t1: min(3), minutes: 2, cappedMinutes: 0, ongoing: true, headline: "Heat has been close to the cap for 2 min.", summary: "The thermal pressure reached moderate." },
    ]);
  });

  test("oldest first, and with a limit only the worst are kept: capped before close, longer before shorter", () => {
    const s = rolled([TIGHT, CALM, CALM, CAPPED, CALM, CALM, TIGHT, TIGHT, CALM, CALM]);
    const found = (limit?: number) => incidents(s.db, { now: min(10), limit }).incidents.map((i) => [i.severity, (i.t0 - B0) / MINUTE, i.minutes]);
    expect(found()).toEqual([[1, 0, 1], [2, 3, 1], [1, 6, 2]]);
    expect(found(2)).toEqual([[2, 3, 1], [1, 6, 2]]);
    expect(found(1)).toEqual([[2, 3, 1]]);
    const scores = incidents(s.db, { now: min(10) }).incidents.map((i) => i.score);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBeGreaterThan(scores[0]);
  });

  // Four minutes. Memory is capped from minute 1 on, and lane a grows with every tick: at the newest tick it holds
  // 12 GB, and 11.5 GB on average over the last minute.
  function growing(upTo = 4) {
    const s = openStore(":memory:");
    for (let m = 0; m < upTo; m++) {
      minute(s, m, (i) => ({ heldKb: (m * 3 + i / 2 + 1) * GB, ...(m ? { pressure: 4 as const, available: 20 - m * 3 - i / 2 } : {}) }), (i) => [lane("a", 0, (m * 3 + i / 2) * GB), app("b", 0, GB)]);
    }
    s.roll(min(upTo));
    return s;
  }

  test("an incident that still runs peaks at the newest tick when that is its worst reading, and says what now says", () => {
    const s = growing();
    const [incident] = incidents(s.db, { now: min(4) }).incidents;
    const seen = ask(s, min(4)).now;
    expect(incident).toMatchObject({ resource: "memory", ongoing: true, t0: min(1), t1: min(4), peak: min(4), host: { held: 13, pressure: 92 } });
    expect(incident.host.held).toBe(seen.held);
    expect(incident.holders.map((h) => [h.id, h.mem])).toEqual([["lane:a", 12], ["app:b", 1]]);
    expect(incident.holders[0].mem).toBe(seen.holders.find((h) => h.id === "lane:a")!.mem);
    expect(incident.summary).toContain("Lane a (12.0 GB) and b (1.0 GB) held 100% of the 13.0 GB that processes held.");
  });

  test("the ticks of the minute still running count too, though no bucket holds them yet", () => {
    const s = growing();
    for (let i = 1; i <= 2; i++) s.write(min(4) + i * TICK, host({ heldKb: (14 + i) * GB, pressure: 4, available: 5 - i }), [lane("a", 0, (13 + i) * GB), app("b", 0, GB)]);
    const [incident] = incidents(s.db, { now: min(4) + 2 * TICK }).incidents;
    expect(incident).toMatchObject({ peak: min(4) + 2 * TICK, host: { held: 16, pressure: 97 } });
    expect(incident.holders[0]).toMatchObject({ id: "lane:a", mem: 15 });
  });

  test("one whose worst is behind it keeps its peak there, and one that ended is read from its buckets", () => {
    const s = growing();
    // It eases: still critical, with more memory available than at its worst.
    for (let i = 1; i <= 2; i++) s.write(min(4) + i * TICK, host({ heldKb: 9 * GB, pressure: 4, available: 30 }), [lane("a", 0, 8 * GB), app("b", 0, GB)]);
    expect(incidents(s.db, { now: min(4) + 2 * TICK }).incidents[0]).toMatchObject({ peak: min(4), ongoing: true, host: { held: 11.75 } });
    const ended = growing();
    for (const m of [4, 5, 6]) minute(ended, m, { heldKb: GB });
    ended.roll(min(7));
    expect(incidents(ended.db, { now: min(7) }).incidents[0]).toMatchObject({ peak: min(4), ongoing: false, host: { held: 11.75 } });
  });

  test("a full disk has nobody to blame", () => {
    const s = rolled([{ diskFreeKb: 150 * GB }, { diskFreeKb: 12 * GB }, { diskFreeKb: 4 * GB }], [lane("builder", 0, 2 * GB)]);
    const [incident] = incidents(s.db, { now: min(3) }).incidents;
    // It still runs and now is its worst reading, so its peak is the newest tick, at the end of minute 2.
    expect(incident).toMatchObject({ resource: "disk", severity: 2, peak: min(3), culprits: [], host: { diskFree: 4 }, headline: "Disk has been capped for 2 min.", summary: "Free disk fell to 4 GB. The monitor does not record whose files fill the disk." });
  });
});

describe("patterns", () => {
  const NOW = B0 + DAY;

  test("days-above: the holder, the finding in words, and its peak on each day that has data, oldest first", () => {
    const s = openStore(":memory:");
    // One tick an hour before the end of each of four days counted back from NOW. Editor's two process groups peak
    // at 9 GB together on the three newest and at 3 GB on the oldest.
    for (const day of [0, 1, 2, 3]) {
      s.write(NOW - day * DAY - HOUR, host(), [app("Browser", 0, 40 * GB), app("Editor", 0, (day < 3 ? 5 : 2) * GB), app("Editor", 0, (day < 3 ? 4 : 1) * GB, { name: "Editor Helper" })]);
    }
    s.roll(NOW);
    const t = [4, 3, 2, 1].map((back) => NOW - back * DAY);
    expect(patterns(s.db, { now: NOW, zone: () => 0 })).toEqual({
      holders: [
        { id: "app:Browser", name: "Browser", kind: "app", slot: null, group: false, note: "An app, with all its helpers" },
        { id: "app:Editor", name: "Editor", kind: "app", slot: null, group: false, note: "An app, with all its helpers" },
      ],
      patterns: [
        {
          id: "above-app:Browser", holder: "app:Browser", resource: "memory",
          title: "Browser at or above 32 GB on 4 of the 4 days recorded", detail: "Its highest daily peak was 40.0 GB and its lowest was 40.0 GB.",
          evidence: { type: "days", unit: "GB", threshold: 32, values: [40, 40, 40, 40], t },
        },
        {
          id: "above-app:Editor", holder: "app:Editor", resource: "memory",
          title: "Editor at or above 8 GB on 3 of the 4 days recorded", detail: "Its highest daily peak was 9.0 GB and its lowest was 3.0 GB.",
          evidence: { type: "days", unit: "GB", threshold: 8, values: [3, 9, 9, 9], t },
        },
      ],
    });
  });

  test("top-in-episodes: who led how many of the times a limit was reached", () => {
    const s = openStore(":memory:");
    // Three minutes at the limit, each on its own. builder used the most CPU in the first and the third.
    ["builder", "tester", "builder"].forEach((leader, i) => {
      minute(s, 3 * i, TIGHT, [lane(leader, 900), lane("bystander", 100, GB)]);
      for (const calm of [1, 2]) minute(s, 3 * i + calm, CALM);
    });
    s.roll(min(9));
    expect(patterns(s.db, { now: min(9), zone: () => 0 }).patterns).toEqual([
      {
        id: "led-cpu-lane:builder", holder: "lane:builder", resource: "cpu",
        title: "Lane builder used the most CPU in 2 of the 3 times CPU ran short in the last 14 days",
        detail: "Each time is one stretch in which CPU was close to the cap or capped, and it counts for the holder that used the most CPU over it.",
        evidence: { type: "count", unit: "times", values: [2, 1], labels: ["Lane builder used the most CPU", "Another holder used the most CPU"] },
      },
    ]);
  });

  test("before-restart: who held the most before the machine restarted, at the time in the zone passed in", () => {
    const s = openStore(":memory:");
    const first = B0 / 1000 - 3600;
    const second = B0 / 1000 + 240;
    for (const m of [0, 1]) minute(s, m, { bootAt: first }, [lane("builder", 0, 30 * GB), app("Editor", 0, 10 * GB)]);
    minute(s, 2, { bootAt: first, pressure: 4 }, [lane("builder", 0, 30 * GB), app("Editor", 0, 10 * GB)]);
    for (const m of [6, 7]) minute(s, m, { bootAt: second }, [app("Editor", 0, 10 * GB)]);
    s.roll(min(8));
    expect(patterns(s.db, { now: min(8), zone: () => 60 }).patterns).toEqual([
      {
        id: `restart-${second}`, holder: "lane:builder", resource: "memory",
        title: "Lane builder held 30.0 GB before the restart on 10 Mar at 10:04",
        detail: "That was more than any other holder held over the last 15 min sampled before it, and memory was the limit then.",
        evidence: { type: "count", unit: "GB", values: [30], labels: ["lane builder"] },
      },
    ]);
  });
});
