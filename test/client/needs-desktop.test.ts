// NEEDS YOU on a desktop, in the list's own scroll box, with a real mouse wheel: whatever changes the list's height, the
// question you read stays at its pixel, in every frame. Chrome with its scroll anchoring off, since Safari has none, and
// on, as it ships. NEEDS_PLAYWRIGHT=/path/to/playwright/index.js adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { SCENES, chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "Chrome 1280, anchoring off", width: 1280, height: 800, noAnchor: true, make: chromeDriver, skip: !findChrome() },
  { name: "Chrome 1440, anchoring on", width: 1440, height: 900, noAnchor: false, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 1280, anchoring off", width: 1280, height: 800, noAnchor: true, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
  { name: "WebKit 1440, anchoring off", width: 1440, height: 900, noAnchor: true, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];

for (const run of RUNS) {
  describe.skipIf(run.skip)(run.name, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      k = await startDesk(ROOT, async () => browser.driver, run);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });
    for (const [name, walk] of SCENES) {
      test(name, async () => {
        await walk(k);
        const r = k.results.at(-1)!;
        expect(r.scene).toBe(name);
        expect(r.settled).toBeLessThanOrEqual(2);
        expect(r.peak).toBeLessThanOrEqual(2);
        // What grows on your own card, its own words in the late font too, lies above what you tap; anywhere else it stays.
        if (r.options != null && !/your card$|lands on your|MORE|box grows|image on your|web font/.test(name) || name.startsWith("you pick")) expect(r.options ?? 0).toBeLessThanOrEqual(2);
      });
    }
    test("no page errors", () => expect(browser.errors).toEqual([]));
  });
}
