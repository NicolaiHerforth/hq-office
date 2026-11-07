// What you hold your place on does not creep as questions arrive. WebKit keeps a page's scroll in whole pixels and a card's
// height is fractional, so each correction falls a little short: what is short must be made up by the next one, not added to
// it. Its own file, because a second WebKit browser in one process stalls on its first page. NEEDS_PLAYWRIGHT adds WebKit.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "window 600", make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 600", make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const ask = (title: string) => ({ title, kind: "decision", options: ["Yes", "No"], lane: "golf" });

for (const run of RUNS) {
  describe.skipIf(run.skip)(`no creep, ${run.name}`, () => {
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    let k: Awaited<ReturnType<typeof startDesk>>;
    const ev = (e: string) => k.ev(e);
    const arrivals = async (top: string) => {
      const was = await ev(top) as number, n = await ev(`document.querySelectorAll("#hud > .ask").length`) as number;
      for (let i = 1; i <= 6; i++) {
        await k.server.post("/api/asks", ask(`Arrives ${n + i}`));
        await k.until(`document.querySelectorAll("#hud > .ask").length === ${n + i}`);
        await Bun.sleep(150);
      }
      return Math.abs((await ev(top) as number) - was);
    };
    beforeAll(async () => {
      browser = await run.make(600, 800);
      k = await startDesk(ROOT, async () => browser.driver, { width: 600, height: 800, noAnchor: true, seed: async (post) => { const ids: number[] = []; for (let i = 1; i <= 9; i++) ids.push((await post("/api/asks", ask(`Question ${i}`))).id); return ids; } });
      k.late.go("font.ttf");
      await Bun.sleep(400);
    }, 60_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    test("the caret in TELL HQ's box: six questions arrive and the box has not moved", async () => {
      const box = `document.getElementById("noteText")`;
      await ev(`scrollBy(0, ${box}.getBoundingClientRect().bottom - innerHeight + 20)`);
      await Bun.sleep(300);
      await k.clickEl(box);
      await k.until(`document.activeElement === ${box}`);
      await k.d.type("Typing to HQ");
      await Bun.sleep(200);
      expect(await arrivals(`${box}.getBoundingClientRect().top`)).toBeLessThanOrEqual(1);
      await ev(`${box}.blur()`);
    });

    test("reading a card: six questions arrive under it and the card has not moved", async () => {
      const id = k.ids[4];
      await k.wheelTo(id, 120);
      await Bun.sleep(300);
      // Above the card, where the arrivals with a due date go, so every one has to be corrected for.
      const top = `document.querySelector('#hud > .ask[data-ask="${id}"]').getBoundingClientRect().top`, was = await ev(top) as number, n = await ev(`document.querySelectorAll("#hud > .ask").length`) as number;
      for (let i = 1; i <= 6; i++) {
        await k.server.post("/api/asks", { ...ask(`Due ${i}`), due: Date.now() + 3600_000 + i * 60_000 });
        await k.until(`document.querySelectorAll("#hud > .ask").length === ${n + i}`);
        await Bun.sleep(150);
      }
      expect(Math.abs((await ev(top) as number) - was)).toBeLessThanOrEqual(1);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED|Failed to fetch/.test(e))).toEqual([]));
  });
}
