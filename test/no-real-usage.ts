// No test reads the owner's real subscription usage: every server a test starts reads this machine's usage from an
// empty home of its own (HUD_SUBS_HOME, src/server/sub-usage.ts), unless the test gives it another.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.HUD_SUBS_HOME) {
  const home = mkdtempSync(join(tmpdir(), "hq-subs-home-"));
  process.env.HUD_SUBS_HOME = home;
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}
