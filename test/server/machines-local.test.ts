// MACHINES takes this machine's reading from whoever already has it (the monitor, while it runs), and starts
// machine-stats.sh only when there is none (docs/footprint.md).
// The sampler runs in a child (test/machines-local-child.ts) on a throwaway data folder.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
async function child(mode: string, env: Record<string, string> = {}) {
  const data = mkdtempSync(join(tmpdir(), "hq-machines-local-"));
  dirs.push(data);
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUD_") && !k.startsWith("HERDR_")));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "machines-local-child.ts"), mode], {
    env: { ...base, HUD_DATA_DIR: data, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HERDR_BIN: "/usr/bin/false", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err || out);
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("a reading someone already has is the sample: no script is started", async () => {
  const { ms, sample } = await child("reader");
  expect(sample).toMatchObject({ machine: "local", ok: 1, cores: 8, load1: 1.25, cpu_busy: 12.5, mem_used: 50, swap_used_gb: 1, disk_free_gb: 100, temp_gb: 3.21 });
  // The script waits a second on iostat on a Mac and on top on Linux: a sample in a fraction of that started neither.
  expect(ms).toBeLessThan(600);
}, 30_000);

test("with no reading, the script reads as on any machine", async () => {
  const { ms, sample } = await child("no-reading");
  expect(sample.ok).toBe(1);
  expect(sample.cores).toBeGreaterThan(0);
  expect(sample.mem_used).toBeGreaterThan(0);
  expect(ms).toBeGreaterThanOrEqual(900);
}, 60_000);
