// A whole `bun test` run may not outlive HUD_TEST_LIMIT_MIN minutes (default 25; a full run takes about 15, more under load). Bun's
// per-test timeout cannot fire while a test blocks the main thread (a Bun.spawnSync whose child never ends), so the
// clock runs in a worker thread: on time out it stops the run's child processes, then the run itself.
const minutes = Number(process.env.HUD_TEST_LIMIT_MIN ?? 25);
if (minutes > 0) {
  const worker = new Worker(new URL("./watchdog-worker.ts", import.meta.url), { env: { HUD_TEST_LIMIT_MS: String(minutes * 60_000) } } as WorkerOptions);
  worker.unref();
}
