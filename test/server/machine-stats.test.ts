// The minute record: swap, free disk and the temp folders' size join CPU, memory and load. A database from before them
// keeps its rows, and the slow temp reading never holds up or fails a sample.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "src/server/machine-stats.sh");
const data = mkdtempSync(join(tmpdir(), "machine-stats-"));
const OLD_AT = Date.now() - 3600_000;

// A database as it was before the three columns, with one row in it.
const old = new Database(join(data, "hud.db"), { create: true });
old.exec("CREATE TABLE machine_stats (at INTEGER NOT NULL, machine TEXT NOT NULL, ok INTEGER NOT NULL, cores INTEGER, load1 REAL, cpu_busy REAL, mem_used REAL, error TEXT)");
old.query("INSERT INTO machine_stats (at, machine, ok, cores, load1, cpu_busy, mem_used) VALUES (?, 'local', 1, 8, 1.5, 20, 40)").run(OLD_AT);
old.close();

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_STATS_MS: "1500", HERDR_BIN: "/usr/bin/true" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const history = async () => (await (await fetch(`${server.base}/api/machines?hours=2`)).json()) as Record<string, number | null>[];
async function until<T>(read: () => Promise<T | undefined>) {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["sh", SCRIPT, ...args]);
  expect(p.exitCode).toBe(0);
  return Object.fromEntries(p.stdout.toString().trim().split(/\s+/).map((kv) => kv.split("=")));
};

test("the script reports swap and free disk, and leaves the temp walk to its own mode", () => {
  const s = run();
  expect(Number(s.swap_used_gb)).toBeGreaterThanOrEqual(0);
  expect(Number(s.disk_free_gb)).toBeGreaterThan(0);
  expect(s.temp_gb).toBeUndefined();
  const t = run("temp");
  expect(Number(t.temp_gb)).toBeGreaterThanOrEqual(0);
  expect(Object.keys(t)).toEqual(["temp_gb"]);
}, 60_000); // It walks this machine's real temp folders, however large they have grown.

test("a database from before the columns keeps its rows, with the new readings empty", async () => {
  const rows = await history();
  const row = rows.find((r) => r.at === OLD_AT)!;
  expect(row).toMatchObject({ load1: 1.5, mem_used: 40, swap_used_gb: null, disk_free_gb: null, temp_gb: null });
});

test("each minute's row carries swap, free disk and the latest temp size", async () => {
  const row = await until(async () => (await history()).find((r) => r.at !== OLD_AT && r.ok && r.temp_gb !== null));
  expect(row.swap_used_gb).toBeGreaterThanOrEqual(0);
  expect(row.disk_free_gb).toBeGreaterThan(0);
  expect(row.temp_gb).toBeGreaterThanOrEqual(0);
  expect(row.load1).toBeGreaterThanOrEqual(0);
});
