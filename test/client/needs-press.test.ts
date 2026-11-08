// The same press, repeated, on a list that has moved under the finger: it never answers another question, in FOCUS or
// the list, for DONE, OK and NOT YET, with a fast server or a slow one, however soon after the card changed. Every answer
// in flight is yours while it is. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver, HOLD_CLOCK, HOLD_MS, pressIntoHold } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "phone 390", width: 390, height: 844, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), skip: !findChrome() },
  { name: "desktop 1280", width: 1280, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 1280", width: 1280, height: 800, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const SPY = `(() => { if (window.__posts) return; window.__posts = []; window.__slow = 0; window.__late = 0; const wait = (ms) => new Promise((r) => setTimeout(r, ms)), f = window.fetch; window.fetch = async (u, o) => { if (o?.method !== "POST") return f(u, o); window.__posts.push(String(u)); if (window.__slow) await wait(window.__slow); const r = await f(u, o); if (window.__late) await wait(window.__late); return r; }; })()`;

for (const run of RUNS) {
  describe.skipIf(run.skip)(`a repeated press, ${run.name}`, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    const ev = (e: string) => k.ev(e);
    const stageId = () => ev(`Number(document.querySelector("#hud > .ask.on")?.dataset.ask)`) as Promise<number>;
    const spot = (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number }>;
    const under = ({ x, y }: { x: number; y: number }) => ev(`document.elementFromPoint(${x}, ${y})?.closest("[data-ask]")?.dataset.ask`) as Promise<string>;
    const posted = (id: number) => ev(`window.__posts.filter((u) => u.includes("/asks/${id}/")).length`) as Promise<number>;
    const quiet = () => k.until(`!document.documentElement.classList.contains("unready")`);
    const toFocus = async (on: boolean) => {
      if ((await ev(`document.getElementById("hud").classList.contains("focus")`)) === on) return;
      await k.clickEl(`document.querySelector(".asknav [data-focus]")`);
      await k.until(`document.getElementById("hud").classList.contains("focus") === ${on}`);
      await Bun.sleep(200);
    };
    // On the first card of a run of one kind, with the next of that kind right after it.
    const stageOn = async (title: string) => {
      const id = await ev(`Number([...document.querySelectorAll("#hud > .ask")].find((c) => c.querySelector("h3").textContent.startsWith(${JSON.stringify(title)}))?.dataset.ask)`);
      await ev(`import("/src/client/questions/focus.js").then((m) => m.focusTo(${id}))`);
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${id}"`);
      await quiet();
      await Bun.sleep(150);
      return id as number;
    };

    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      k = await startDesk(ROOT, async () => browser.driver, {
        ...run, noAnchor: true,
        seed: async (post) => {
          const ids: number[] = [];
          for (const [kind, title, n] of [["action", "Do", 34], ["info", "Note", 10], ["action", "Hold", 8], ["action", "Slow", 12], ["decision", "Pick", 4]] as const)
            for (let i = 1; i <= n; i++) ids.push((await post("/api/asks", { title: `${title} ${i}`, kind, lane: "golf", options: kind === "decision" ? ["Yes", "No"] : undefined })).id);
          return ids;
        },
      });
      k.late.go("font.ttf");
      await ev(SPY);
      await ev(HOLD_CLOCK);
      await Bun.sleep(400);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    for (const [button, sel, title] of [["DONE", ".send", "Do"], ["OK on an FYI", ".send", "Note"]] as const) {
      for (const gap of [500, 800]) {
        test(`FOCUS, ${button}: pressed again ${gap} ms after the card changed, the press goes and answers the next question`, async () => {
          await toFocus(true);
          const first = await stageOn(title), at = await spot(`#hud > .ask.on ${sel}`);
          await k.d.click(at.x, at.y);
          await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${first}"`);
          const next = await stageId();
          await quiet();
          await pressIntoHold(k, at, gap);
          await k.until(`window.__posts.some((u) => u.includes("/asks/${next}/"))`);
          await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${next}"`);
        });
      }
      for (const gap of [0, 150, 300]) {
        test(`FOCUS, ${button}: pressed again ${gap} ms after the card changed, the next question is not answered`, async () => {
          await toFocus(true);
          const first = await stageOn(title), at = await spot(`#hud > .ask.on ${sel}`);
          await k.d.click(at.x, at.y);
          await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${first}"`);
          const next = await stageId();
          // Under the finger: without this the second press would prove nothing.
          expect(await under(at)).toBe(String(next));
          if (await pressIntoHold(k, at, gap) >= HOLD_MS) return;
          await Bun.sleep(300);
          expect(await stageId()).toBe(next);
          expect(await posted(next)).toBe(0);
          expect((await k.openIds()).includes(next)).toBe(true);
        });
      }
    }

    test("once the press has been held back for its moment, it answers", async () => {
      await toFocus(true);
      const first = await stageOn("Do"), at = await spot("#hud > .ask.on .send");
      await k.d.click(at.x, at.y);
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${first}"`);
      const next = await stageId();
      await quiet();
      await k.d.click(at.x, at.y);
      await k.until(`!document.querySelector('#hud [data-ask="${next}"]')`);
      expect(await posted(next)).toBe(1);
    });

    test("a slow server: pressed while it is in flight and again once the card changed, only the first is answered", async () => {
      await toFocus(true);
      const first = await stageOn("Slow"), at = await spot("#hud > .ask.on .send");
      await ev(`window.__slow = 900`);
      await k.d.click(at.x, at.y);
      await Bun.sleep(300);
      await k.d.click(at.x, at.y);
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${first}"`);
      const next = await stageId();
      expect(await under(at)).toBe(String(next));
      const landed = await pressIntoHold(k, at, 150);
      await Bun.sleep(1300);
      await ev(`window.__slow = 0`);
      expect(await posted(first)).toBe(1);
      if (landed >= HOLD_MS) return;
      expect(await posted(next)).toBe(0);
      expect((await k.openIds()).includes(next)).toBe(true);
    });

    test("NOT YET twice tells only the one you meant", async () => {
      await toFocus(true);
      const first = await stageOn("Hold"), at = await spot("#hud > .ask.on .notyet");
      await k.d.click(at.x, at.y);
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask !== "${first}"`);
      const next = await stageId();
      expect(await under(at)).toBe(String(next));
      if (await pressIntoHold(k, at, 200) >= HOLD_MS) return;
      await Bun.sleep(300);
      expect(await posted(first)).toBe(1);
      expect(await posted(next)).toBe(0);
      expect(await stageId()).toBe(next);
    });

    test("in the list, the next card under the finger is not answered either", async () => {
      await quiet();
      await toFocus(false);
      const first = (await k.openIds())[0];
      await ev(`document.querySelector('#hud [data-ask="${first}"]').scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(200);
      const at = await spot(`#hud [data-ask="${first}"] .send`);
      await k.d.click(at.x, at.y);
      await k.until(`!document.querySelector('#hud [data-ask="${first}"]')`);
      const next = Number(await under(at));
      expect(next).toBeGreaterThan(0);
      if (await pressIntoHold(k, at, 200) >= HOLD_MS) return;
      await Bun.sleep(300);
      expect(await posted(next)).toBe(0);
    });

    test("two answers in flight: neither is reported as not sent", async () => {
      await quiet();
      await toFocus(false);
      const [a, b] = await k.openIds();
      // Slow both ways: the second press comes before the first reaches the server, and each push before its own reply.
      // The first card leaves at the press, so the second waits out the hold that starts.
      await ev(`window.__slow = 900; window.__late = 900`);
      for (const id of [a, b]) {
        const box = `#hud [data-ask="${id}"] textarea`;
        await ev(`document.querySelector(${JSON.stringify(box)}).scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(100);
        await k.clickEl(`document.querySelector(${JSON.stringify(box)})`);
        await k.until(`document.activeElement === document.querySelector(${JSON.stringify(box)})`);
        await k.d.type(`My words on ${id}.`);
      }
      for (const id of [a, b]) {
        await quiet();
        await ev(`document.querySelector('#hud [data-ask="${id}"] .send').scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(50);
        await k.clickEl(`document.querySelector('#hud [data-ask="${id}"] .send')`);
      }
      await k.until(`!document.querySelector('#hud > .ask:not(.left)[data-ask="${a}"]') && !document.querySelector('#hud > .ask:not(.left)[data-ask="${b}"]')`);
      await Bun.sleep(1200);
      await ev(`window.__slow = 0; window.__late = 0`);
      const open = await k.openIds();
      expect(open.includes(a) || open.includes(b)).toBe(false);
      expect(await ev(`document.querySelectorAll("#hud > .ask.left").length`)).toBe(0);
      expect(await ev(`document.getElementById("hud").textContent.includes("not sent")`)).toBe(false);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED/.test(e))).toEqual([]));
  });
}
