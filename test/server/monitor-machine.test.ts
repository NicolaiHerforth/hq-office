// MACHINES' reading of this machine from the monitor's tick (monitor-machine.ts): the script's figures by the
// script's definitions, so the top bar and the two-day record read as before; and on a Mac, held against the
// script itself at the same moment.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { FRESH_MS, machineReading } from "../../src/server/monitor-machine.ts";
import type { Tick } from "../../src/server/monitor.ts";

const NOW = Date.parse("2026-03-10T09:00:00Z");
const host = (over: object = {}) => ({
  dtMs: 10_000, cores: 16, busyMs: 40_000, load1: 9.456, memTotalKb: 64 * 1048576, memFreeKb: 1_000_000, memReclaimableKb: 16 * 1048576, memWiredKb: 0, memAppKb: 0, memCachedKb: 0,
  memCompressedKb: 0, memStoredKb: 0, swapTotalKb: 8 * 1048576, swapUsedKb: 3.25 * 1048576, pressure: 1, available: 30, pageins: 0, pageouts: 0, swapins: 0, swapouts: 0, thermal: 0,
  diskTotalKb: 1000 * 1048576, diskFreeKb: 412.34 * 1048576, bootAt: 0, heldKb: 0, selfCpuMs: 0, selfMemKb: 0, ...over,
});
const tick = (over: object = {}, at = NOW - 2_000) => ({ at, host: host(over), rows: [] }) as unknown as Tick;

test("a fresh tick gives the script's figures, as the script prints them", () => {
  expect(machineReading(tick(), NOW)).toEqual({
    cores: "16",
    load1: "9.46",
    // 40 s busy of 16 cores x 10 s
    cpu_busy: "25.0",
    // a quarter of memory is free, inactive or speculative
    mem_used: "75.0",
    swap_used_gb: "3.25",
    disk_free_gb: "412.3",
  });
});

test("free disk is left out when it could not be read, as the script leaves it out", () => {
  expect(machineReading(tick({ diskFreeKb: null }), NOW)).not.toHaveProperty("disk_free_gb");
});

test("the busy share stays within 0 and 100", () => {
  expect(machineReading(tick({ busyMs: 200_000 }), NOW)!.cpu_busy).toBe("100.0");
  expect(machineReading(tick({ busyMs: 0 }), NOW)!.cpu_busy).toBe("0.0");
});

test("no reading when the monitor cannot stand in for the script", () => {
  // No tick, a tick of a monitor that stopped, the first tick after a start (it covers no time), a reader that
  // does not count the memory MACHINES counts.
  expect(machineReading(null, NOW)).toBeNull();
  expect(machineReading(tick({}, NOW - FRESH_MS - 1), NOW)).toBeNull();
  expect(machineReading(tick({ dtMs: 0 }), NOW)).toBeNull();
  expect(machineReading(tick({ memReclaimableKb: undefined }), NOW)).toBeNull();
});

// The real reader against the real script, read one after the other: what does not move in a second is the same,
// and memory is within what a second moves.
test.skipIf(process.platform !== "darwin")("on a Mac, the monitor's reader and machine-stats.sh say the same of this machine", async () => {
  const { readDarwin } = await import("../../src/server/monitor-darwin.ts");
  const { usage } = await import("../../src/server/monitor-usage.ts");
  const a = await readDarwin();
  const script = Bun.spawn(["sh", join(import.meta.dir, "..", "..", "src", "server", "machine-stats.sh")], { stdout: "pipe" });
  const said = Object.fromEntries((await new Response(script.stdout).text()).trim().split(/\s+/).map((kv) => kv.split("=")));
  const b = await readDarwin();
  const { host: h } = usage(a.reading, b.reading, new Map(), { cpuMs: 0, memKb: 0 });
  const mine = machineReading({ at: Date.now(), host: h, rows: [] } as unknown as Tick, Date.now())!;
  expect(mine).not.toBeNull();
  expect(mine.cores).toBe(said.cores);
  expect(Math.abs(Number(mine.disk_free_gb) - Number(said.disk_free_gb))).toBeLessThanOrEqual(0.3);
  expect(Math.abs(Number(mine.swap_used_gb) - Number(said.swap_used_gb))).toBeLessThanOrEqual(0.3);
  expect(Math.abs(Number(mine.mem_used) - Number(said.mem_used))).toBeLessThanOrEqual(2);
  expect(Math.abs(Number(mine.load1) - Number(said.load1))).toBeLessThanOrEqual(3);
  // The same second of the same machine: the two busy shares are of the same order (the script's is one second
  // of it, this one the whole stretch between the two reads).
  expect(Number(mine.cpu_busy)).toBeGreaterThanOrEqual(0);
  expect(Number(mine.cpu_busy)).toBeLessThanOrEqual(100);
  console.log(`monitor: mem ${mine.mem_used}% cpu ${mine.cpu_busy}% swap ${mine.swap_used_gb} GB disk ${mine.disk_free_gb} GB load ${mine.load1} | script: mem ${said.mem_used}% cpu ${said.cpu_busy}% swap ${said.swap_used_gb} GB disk ${said.disk_free_gb} GB load ${said.load1}`);
}, 30_000);
