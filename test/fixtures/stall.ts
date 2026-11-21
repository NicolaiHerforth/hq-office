// A process that starts the stall watch, then stops its own thread for STALL_FOR ms without using the CPU
// (Atomics.wait), as a stuck server does: test/server/stall-watch.test.ts watches what the worker does.
import { watchStalls } from "../../src/server/stall-watch.ts";

watchStalls();
await Bun.sleep(300);
console.log("stopping");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.STALL_FOR));
console.log("back");
await Bun.sleep(1500);
process.exit(0);
