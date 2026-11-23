// The stall watch's worker (stall-watch.ts says why): it reads the time the server's thread last wrote and, when that
// is older than the limit, logs it, samples the process on macOS, and under a service ends it. Runs in a thread of its
// own, so it keeps going while the server's thread is stopped; it imports nothing from the server.
declare const self: Worker;

type Setup = { slot: SharedArrayBuffer; pid: number; limitMs: number; dir: string; sample: boolean; kill: boolean };

// A check is due every second; one this late means the process itself was not running (sleep).
const SUSPENDED_MS = 5_000;
const stamp = (t = Date.now()) => new Date(t).toISOString();
const log = (s: string) => console.error(`${stamp()} stall watch: ${s}`);

self.onmessage = (e: MessageEvent<Setup>) => {
  const { slot, pid, limitMs, dir, sample, kill } = e.data;
  const beat = new Float64Array(slot);
  let since = 0; // the beat the current stall started from; 0 while the thread runs
  let busy = false;
  // When this worker last looked, and since when it has looked without a break. A break (a second check that comes
  // many seconds late) means the whole process was stopped, as it is while the machine sleeps: the server's thread
  // missed its beats for the same reason, so a stall counts only from when the worker itself was running again.
  let looked = Date.now();
  let awake = looked;
  setInterval(async () => {
    const now = Date.now();
    if (now - looked > SUSPENDED_MS) awake = now;
    looked = now;
    const last = beat[0];
    const age = now - Math.max(last, awake);
    if (since && last !== since) {
      log(`the server's thread is running again after ${Math.round((Date.now() - since) / 1000)} s`);
      since = 0;
    }
    if (since || busy || age < limitMs) return;
    since = last;
    busy = true;
    log(`the server's thread has not run for ${Math.round(age / 1000)} s (since ${stamp(last)}); requests are waiting`);
    if (sample) {
      const file = `${dir}/stall-${stamp(last).replace(/[:.]/g, "-")}.txt`;
      try {
        const p = Bun.spawn(["/usr/bin/sample", String(pid), "3", "-file", file], { stdout: "ignore", stderr: "ignore" });
        const done = await Promise.race([p.exited, Bun.sleep(15_000).then(() => null)]);
        if (done === null) p.kill();
        else log(`a sample of the process is in ${file}`);
      } catch (err) {
        log(`no sample: ${String(err)}`);
      }
    }
    busy = false;
    // Ended only if it is still the same stall: a thread that came back during the sample is left alone.
    if (kill && beat[0] === since) {
      log("ending the process, so the service starts it again");
      process.kill(pid, "SIGKILL");
    }
  }, 1000);
};
