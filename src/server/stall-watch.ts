// The stall watch: a worker thread that notices when the server's own thread stops (a request then waits forever,
// though the process is alive and listening) and, under a service manager, ends the process so it is started again.
//
// The main thread writes the time into a shared slot every second; the worker (stall-worker.ts) reads it. Once the
// slot is HUD_STALL_MS old (default 30 s), the worker writes a line with the time to the log and, on macOS, a stack
// sample of the process to DATA/stalls/ (`sample`, a few seconds), the evidence a stall otherwise leaves none of.
// Under a service (HUD_SUPERVISED=1, which bin/service.ts sets for launchd and systemd), a thread still stopped after
// that ends the process with SIGKILL, and the service starts it again in seconds. SIGKILL, because a stopped thread
// runs no handler: secrets held in memory are lost, as in any crash, and the restart says so. Without a service
// nothing would start it again, so it only logs. Costs about 7 MB for the worker's VM and one timer each side.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./config.ts";

const LIMIT_MS = Number(process.env.HUD_STALL_MS) || 30_000;

export function watchStalls() {
  if (process.env.HUD_STALL_WATCH === "0") return;
  const slot = new SharedArrayBuffer(8);
  const beat = new Float64Array(slot);
  const now = () => { beat[0] = Date.now(); };
  now();
  setInterval(now, 1000);
  const dir = join(DATA, "stalls");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const worker = new Worker(new URL("./stall-worker.ts", import.meta.url).href, { smol: true } as WorkerOptions);
  worker.postMessage({
    slot,
    pid: process.pid,
    limitMs: LIMIT_MS,
    dir,
    sample: process.platform === "darwin" && process.env.HUD_STALL_SAMPLE !== "0",
    kill: process.env.HUD_SUPERVISED === "1",
  });
  worker.unref();
}
