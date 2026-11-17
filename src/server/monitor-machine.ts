// MACHINES' reading of this machine, taken from the monitor's newest tick: the same figures machine-stats.sh prints
// (cores, load, the busy share of the CPU, memory used, swap, free disk), each by the script's own definition, so the
// top bar and the two-day record read as before. While the monitor runs, the script and its fifteen processes a
// minute are not started for this machine at all (docs/footprint.md).
//
// The differences, all to the reading's good: the CPU share is over the tick's ten seconds where the script looked
// at one second, and every figure is of the same instant.
import type { Tick } from "./monitor.ts";

// A tick older than this is a monitor that has stopped: the script reads then, as on a machine without a monitor.
export const FRESH_MS = 30_000;

export function machineReading(tick: Tick | null, now: number): Record<string, string> | null {
  if (!tick || now - tick.at > FRESH_MS) return null;
  const h = tick.host;
  // The first tick after a start or a gap covers no time, so it has no CPU share; a reader that does not give the
  // memory count (a test's) cannot stand in for the script.
  if (!(h.dtMs > 0) || h.memReclaimableKb === undefined || !(h.memTotalKb > 0)) return null;
  const out: Record<string, string> = {
    cores: String(h.cores),
    load1: h.load1.toFixed(2),
    cpu_busy: Math.min(100, Math.max(0, (h.busyMs / (h.dtMs * h.cores)) * 100)).toFixed(1),
    mem_used: ((1 - h.memReclaimableKb / h.memTotalKb) * 100).toFixed(1),
    swap_used_gb: (h.swapUsedKb / 1048576).toFixed(2),
  };
  if (h.diskFreeKb !== null) out.disk_free_gb = (h.diskFreeKb / 1048576).toFixed(1);
  return out;
}
