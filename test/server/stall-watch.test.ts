// The stall watch (src/server/stall-watch.ts): a process whose thread stops is logged, sampled on macOS and, under a
// service, ended so the service starts it again; one whose thread comes back is left running. The fixture stops its
// thread with Atomics.wait, so no test here uses the CPU while it waits.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "stall.ts");

async function run(env: Record<string, string>, meanwhile?: (pid: number) => Promise<void>) {
  const data = mkdtempSync(join(tmpdir(), "hq-stall-test-"));
  const p = Bun.spawn([process.execPath, FIXTURE], { env: { ...process.env, HUD_DATA_DIR: data, HUD_STALL_MS: "1500", ...env }, stdout: "pipe", stderr: "pipe" });
  await meanwhile?.(p.pid);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, signal: p.signalCode, data };
}

describe("the stall watch", () => {
  test("under a service, a thread stopped past the limit is logged with its time and the process is ended", async () => {
    const r = await run({ STALL_FOR: "20000", HUD_SUPERVISED: "1", HUD_STALL_SAMPLE: "0" });
    expect(r.signal).toBe("SIGKILL");
    expect(r.out).toContain("stopping");
    expect(r.out).not.toContain("back");
    expect(r.err).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z stall watch: the server's thread has not run for \d+ s/m);
    expect(r.err).toContain("ending the process, so the service starts it again");
  }, 30_000);

  test("without a service it only logs, and says when the thread runs again", async () => {
    const r = await run({ STALL_FOR: "3500", HUD_STALL_SAMPLE: "0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("back");
    expect(r.err).toContain("has not run for");
    expect(r.err).toMatch(/running again after \d+ s/);
    expect(r.err).not.toContain("ending the process");
  }, 30_000);

  test("a thread that keeps running is never reported", async () => {
    const r = await run({ STALL_FOR: "200", HUD_SUPERVISED: "1", HUD_STALL_SAMPLE: "0" });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("stall watch");
  }, 30_000);

  // As the machine's sleep does: every thread stops, the worker's too, so the beats it missed are no stall. A lid
  // closed for 76 s was reported as one before (23 Nov).
  test("a process stopped whole, as in the machine's sleep, is never reported or ended", async () => {
    // The thread waits 8.7 s; the whole process is stopped from 1 s to 8 s of it, so the thread is still waiting when
    // the worker runs again and no beat of its own can hide the missed ones. Counted from the wake, it waited 1 s.
    const r = await run({ STALL_FOR: "8700", HUD_STALL_MS: "3000", HUD_SUPERVISED: "1", HUD_STALL_SAMPLE: "0" }, async (pid) => {
      await Bun.sleep(1000);
      process.kill(pid, "SIGSTOP");
      await Bun.sleep(7000);
      process.kill(pid, "SIGCONT");
    });
    expect(r.err).not.toContain("stall watch");
    expect(r.code).toBe(0);
    expect(r.out).toContain("back");
  }, 40_000);

  test.skipIf(process.platform !== "darwin")("on macOS the stopped process is sampled into DATA/stalls/", async () => {
    const r = await run({ STALL_FOR: "9000" });
    expect(r.code).toBe(0);
    const dir = join(r.data, "stalls");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^stall-.*\.txt$/);
    expect(r.err).toContain(`a sample of the process is in ${join(dir, files[0])}`);
  }, 40_000);

  test("HUD_STALL_WATCH=0 starts no watch", async () => {
    const r = await run({ STALL_FOR: "3000", HUD_STALL_WATCH: "0" });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  }, 30_000);
});
