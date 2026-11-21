// The stall watch (src/server/stall-watch.ts): a process whose thread stops is logged, sampled on macOS and, under a
// service, ended so the service starts it again; one whose thread comes back is left running. The fixture stops its
// thread with Atomics.wait, so no test here uses the CPU while it waits.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "stall.ts");

async function run(env: Record<string, string>) {
  const data = mkdtempSync(join(tmpdir(), "hq-stall-test-"));
  const p = Bun.spawn([process.execPath, FIXTURE], { env: { ...process.env, HUD_DATA_DIR: data, HUD_STALL_MS: "1500", ...env }, stdout: "pipe", stderr: "pipe" });
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
