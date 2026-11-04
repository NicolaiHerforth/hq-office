// A herdr that never answers `machine list`: the server asks it once at a time, kills the call after its timeout and
// waits before asking again, however fast SUBS ticks; and a stopped test server takes its children with it.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    Bun.spawnSync(["pkill", "-KILL", "-f", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

function hangingHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "hq-hang-herdr-"));
  dirs.push(dir);
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${dir}/calls.log"\ncase "$*" in\n  "machine list"*) while :; do sleep 1; done ;;\n  *"agent list"*) echo '{"result":{"agents":[]}}' ;;\nesac\n`);
  chmodSync(bin, 0o755);
  const alive = () => Bun.spawnSync(["pgrep", "-f", dir]).stdout.toString().trim().split("\n").filter(Boolean).length;
  const asked = () => Bun.spawnSync(["grep", "-c", "^machine list", join(dir, "calls.log")]).stdout.toString().trim();
  return { dir, bin, alive, asked };
}

const serve = (herdr: ReturnType<typeof hangingHerdr>, env: Record<string, string> = {}) =>
  spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: herdr.dir, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local,far-away", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_SUBS_MS: "150", ...env } });

const until = async (what: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end && !what(); ) await Bun.sleep(50);
};

test("SUBS every 150 ms against a herdr that hangs: one call at a time, killed after its timeout, not asked again at once", async () => {
  const herdr = hangingHerdr();
  const server = await serve(herdr, { HUD_HERDR_ASK_MS: "1000" });
  try {
    await Bun.sleep(700);
    expect({ alive: herdr.alive(), asked: herdr.asked() }).toEqual({ alive: 1, asked: "1" });
    await Bun.sleep(1800);
    expect({ alive: herdr.alive(), asked: herdr.asked() }).toEqual({ alive: 0, asked: "1" });
  } finally {
    await server.stop();
  }
});

test("a test server stopped in the middle of a herdr call leaves no child behind", async () => {
  const herdr = hangingHerdr();
  const server = await serve(herdr);
  await until(() => herdr.alive() > 0, 3000);
  expect(herdr.alive()).toBeGreaterThan(0);
  await server.stop();
  await until(() => herdr.alive() === 0, 500);
  expect(herdr.alive()).toBe(0);
});
