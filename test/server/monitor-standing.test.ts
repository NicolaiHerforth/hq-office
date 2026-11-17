// THE MONITOR's verdict on now by itself (monitor-standing.ts), which MACHINES in the HUD's top bar speaks by: the
// state and the limit are the ones the monitor's page gets, and a monitor that has stopped says nothing.
import { describe, expect, test } from "bun:test";
import { now } from "../../src/server/monitor-page.ts";
import { standing } from "../../src/server/monitor-standing.ts";
import { openStore, type Store } from "../../src/server/monitor-store.ts";
import type { HostUsage } from "../../src/server/monitor-types.ts";

const TICK = 10_000;
const GB = 1024 * 1024;
const T0 = Date.parse("2026-03-10T09:00:00Z");
const host = (more: Partial<HostUsage> = {}): HostUsage => ({
  dtMs: TICK, cores: 10, busyMs: 10_000, load1: 1, memTotalKb: 64 * GB, memFreeKb: GB, memWiredKb: GB, memAppKb: GB, memCachedKb: GB, memCompressedKb: GB, memStoredKb: GB, swapTotalKb: 20 * GB, swapUsedKb: 0,
  pressure: 1, available: 50, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0, diskTotalKb: 900 * GB, diskFreeKb: 400 * GB, bootAt: T0 / 1000 - 86_400, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...more,
});
// A minute of six ticks that ends at T0 + 60 s.
function minuteOf(more: Partial<HostUsage> = {}): Store {
  const s = openStore(":memory:");
  for (let i = 1; i <= 6; i++) s.write(T0 + i * TICK, host(more), []);
  return s;
}
const END = T0 + 6 * TICK;

describe("the monitor's standing", () => {
  test("nothing short: state 0 and no limit, a few seconds after the newest tick too", () => {
    expect(standing(minuteOf().db, { now: END + 3000 })).toEqual({ state: 0, limiter: null, said: "Not capped" });
  });

  test("a 256 GB disk with 80 GB free is not short: the disk's lines follow its size", () => {
    expect(standing(minuteOf({ diskTotalKb: 256 * GB, diskFreeKb: 80 * GB }).db, { now: END })).toEqual({ state: 0, limiter: null, said: "Not capped" });
    expect(standing(minuteOf({ diskTotalKb: 256 * GB, diskFreeKb: 10 * GB }).db, { now: END })).toEqual({ state: 1, limiter: "disk", said: "Close to the cap by disk" });
  });

  test("close to the cap and capped, with what limits the machine", () => {
    expect(standing(minuteOf({ busyMs: 80_000 }).db, { now: END })).toEqual({ state: 1, limiter: "cpu", said: "Close to the cap by CPU" });
    expect(standing(minuteOf({ pressure: 4 }).db, { now: END })).toEqual({ state: 2, limiter: "memory", said: "Capped by memory" });
    expect(standing(minuteOf({ diskFreeKb: 10 * GB }).db, { now: END })).toEqual({ state: 2, limiter: "disk", said: "Capped by disk" });
  });

  test.each([{}, { busyMs: 80_000 }, { pressure: 4 }, { thermal: 2, busyMs: 96_000 }])("it is the state and the limit the monitor's page gets: %j", (more) => {
    const { db } = minuteOf(more);
    const page = now(db, { now: END, name: "forge", size: { bytes: 0, limit: 1 } })!.now;
    expect(standing(db, { now: END })).toMatchObject({ state: page.state, limiter: page.limiter });
  });

  test("before the first tick there is none", () => {
    expect(standing(openStore(":memory:").db, { now: END })).toBeNull();
  });

  test("a newest tick three ticks old still counts, and one four ticks old does not: the monitor has stopped", () => {
    const { db } = minuteOf({ pressure: 4 });
    expect(standing(db, { now: END + 3 * TICK })?.state).toBe(2);
    expect(standing(db, { now: END + 4 * TICK })).toBeNull();
  });
});
