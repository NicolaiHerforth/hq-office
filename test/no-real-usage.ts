// No test reads the owner's real subscription usage: every server a test starts reads this machine's usage from an
// empty home of its own (HUD_SUBS_HOME, src/server/sub-usage.ts), unless the test gives it another.
// The home goes when the run ends. bun test runs no process "exit" handler, so that never removed it, and every run
// left one in the temp folder (600 of them on the build machine); a preload's afterAll runs once, after the last file.
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HUD_SUBS_HOME) {
  const home = mkdtempSync(join(tmpdir(), "hq-subs-home-"));
  process.env.HUD_SUBS_HOME = home;
  const gone = () => rmSync(home, { recursive: true, force: true });
  afterAll(gone);
  process.on("exit", gone);
}

// No test reaches the owner's real GitHub: every server a test starts runs `false` for gh (SHIP, the work board) unless
// the test gives it a stub of its own (test/fake-gh-world.ts).
process.env.HUD_GH_BIN ??= "false";
