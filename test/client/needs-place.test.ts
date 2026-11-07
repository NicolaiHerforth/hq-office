// Your place when the card under your eye has gone, and what a tap on a card can move, with real input. A reload falls to
// the nearest question still there; the row of where you are never covers a card's top; a chip moves nothing, whatever the
// lane's name. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(90_000);
const ROOT = join(import.meta.dir, "..", "..");
const phone = (w: number, h: number) => chromeDriver(w, h, { touch: true });
const RUNS = [
  { name: "phone 390", width: 390, height: 844, make: phone, skip: !findChrome() },
  { name: "window 600", width: 600, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "desktop 1280", width: 1280, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 1280", width: 1280, height: 800, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const NAMES = [4, 8, 12, 16, 20, 24, 28, 32, 38, 44, 60].map((n) => "lane-with-a-long-name-that-goes-on-and-on-and-on-and-on-and-on-and-on".slice(0, n).replace(/-$/, "x"));

for (const run of RUNS) {
  describe.skipIf(run.skip)(`your place, ${run.name}`, () => {
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    let k: Awaited<ReturnType<typeof startDesk>> | null = null;
    const ev = (e: string) => k!.ev(e);
    const stacked = run.width < 1151;
    const desk = async (n: number, make?: (post: any) => Promise<number[]>) => {
      await k?.stop();
      k = await startDesk(ROOT, async () => browser.driver, {
        width: run.width, height: run.height, noAnchor: true,
        seed: make ?? (async (post) => { const ids: number[] = []; for (let i = 1; i <= n; i++) ids.push((await post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf" })).id); return ids; }),
      });
      k.late.go("font.ttf");
      await ev(`try { localStorage.clear(); sessionStorage.clear(); } catch {}`);
      await reload();
    };
    const reload = async () => { await k!.d.reload(); await k!.until(`!!document.getElementById("lastNote")?.innerHTML`); await Bun.sleep(700); };
    const away = () => k!.d.goto("about:blank");
    const home = async () => { await k!.d.goto(`${k!.late.base}/`); await k!.until(`!!document.getElementById("lastNote")?.innerHTML`); await Bun.sleep(900); };
    const topOf = (id: number) => ev(`document.querySelector('#hud > .ask[data-ask="${id}"]').getBoundingClientRect().top`) as Promise<number>;
    const count = () => ev(`document.getElementById("below")?.textContent ?? ""`) as Promise<string>;
    const offset = () => ev(`innerWidth < 1151 ? scrollY : document.getElementById("hud").scrollTop`) as Promise<number>;
    const out = (...ids: number[]) => Promise.all(ids.map((id) => k!.server.post(`/api/asks/${id}/withdraw`, { reason: "gone" })));
    beforeAll(async () => { browser = await run.make(run.width, run.height); }, 60_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    const NEAR = 3;
    // Chrome's emulation drops pointer: coarse as a page goes away, so the phone's layout is measured again and the card
    // parked may be the one above, at another pixel. Real Mobile Safari has no emulation to drop. So on a touch run the ones
    // above close too, and what is held is the card, not its pixel.
    const touch = run.width === 390;
    const lineNow = () => ev(`innerWidth < 1151 ? (document.querySelector(".asknav") ?? document.getElementById("qtabs")).getBoundingClientRect().bottom : document.getElementById("hud").getBoundingClientRect().top`) as Promise<number>;
    // The next card has the pixel of the one that closed, or 12 px under the row if that pixel would hide its top.
    const tookOver = async (id: number, was: number) => expect(Math.abs((await topOf(id)) - Math.max(was, (await lineNow()) + 12))).toBeLessThan(NEAR);
    const seenNow = (id: number) => ev(`(() => { const r = document.querySelector('#hud > .ask[data-ask="${id}"]').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`);
    test("the card under your eye closed while you were away: the next one takes its place, and a second reload holds", async () => {
      await desk(85);
      const id = k!.ids[48], next = k!.ids[49];
      await k!.wheelTo(id, 20);
      await Bun.sleep(300);
      const was = await topOf(id);
      await away();
      await out(id, ...(touch ? [k!.ids[47], k!.ids[46]] : []));
      await home();
      expect(await ev(`!!document.querySelector('#hud > .ask[data-ask="${id}"]')`)).toBe(false);
      expect(await offset()).toBeGreaterThan(1000);
      if (touch) expect(await seenNow(next)).toBe(true);
      else await tookOver(next, was);
      if (stacked) expect(await count()).toMatch(touch ? /^4[78] OF 82/ : /^49 OF 84/);
      await reload();
      if (touch) expect(await seenNow(next)).toBe(true);
      else await tookOver(next, was);
    });

    test("the ones after it closed as well: the nearest still there, and the one before when none is after", async () => {
      await desk(60);
      const id = k!.ids[20];
      await k!.wheelTo(id, 20);
      await Bun.sleep(300);
      const was = await topOf(id);
      await away();
      await out(id, k!.ids[21], k!.ids[22], ...(touch ? [k!.ids[19], k!.ids[18]] : []));
      await home();
      if (touch) expect(await seenNow(k!.ids[23])).toBe(true);
      else await tookOver(k!.ids[23], was);
      await k!.wheelTo(k!.ids[35], 20);
      await Bun.sleep(300);
      await away();
      await out(...k!.ids.slice(35), ...(touch ? [k!.ids[34], k!.ids[33]] : []));
      await home();
      expect(await seenNow(touch ? k!.ids[32] : k!.ids[34])).toBe(true);
      expect(await offset()).toBeGreaterThan(500);
    });

    test("partway down a long card that closed: the next one opens with its top in view, under the row", async () => {
      await desk(0, async (post) => { const ids: number[] = []; for (let i = 1; i <= 30; i++) ids.push((await post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf", body: "A long question with a lot to read in it. ".repeat(60) })).id); return ids; });
      const id = k!.ids[15], next = k!.ids[16];
      await ev(`(() => { const c = document.querySelector('#hud > .ask[data-ask="${id}"]'); if (innerWidth < 1151) scrollBy(0, c.getBoundingClientRect().top - 40); else document.getElementById("hud").scrollTop += c.getBoundingClientRect().top - document.getElementById("hud").getBoundingClientRect().top + 200; })()`);
      await Bun.sleep(300);
      await k!.d.wheel(run.width / 2, run.height / 2, 200);
      await Bun.sleep(400);
      expect(await topOf(id)).toBeLessThan(0);
      await away();
      await out(id, ...(touch ? [k!.ids[14], k!.ids[13]] : []));
      await home();
      const line = await lineNow(), top = await topOf(next);
      expect(top).toBeGreaterThanOrEqual(line);
      expect(top).toBeLessThan(line + 40);
    });

    test("FOCUS: the question on the stage has gone from the state too: the next one, not the first", async () => {
      await desk(60);
      await k!.clickEl(`document.querySelector(".asknav [data-focus]")`);
      await k!.until(`document.getElementById("hud").classList.contains("focus")`);
      const id = k!.ids[29];
      await ev(`import("/src/client/questions/focus.js").then((m) => m.focusTo(${id}))`);
      await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${id}"`);
      await Bun.sleep(150);
      await away();
      await out(id);
      for (const x of [...k!.ids.slice(0, 20), ...k!.ids.slice(39, 60)]) await k!.server.post(`/api/asks/${x}/answer`, { answer: "Yes" });
      await home();
      expect(await ev(`document.querySelector("#hud > .ask.on")?.dataset.ask`)).toBe(String(k!.ids[30]));
    });

    test.skipIf(!stacked || run.width === 390)("▼ leaves a card's top clear of the row, and ▲ goes back, where the page scrolls without touch", async () => {
      await desk(30);
      await k!.d.wheel(run.width / 2, run.height / 2, 1400);
      await Bun.sleep(400);
      const settled = async () => { let y = await offset(); for (let i = 0; i < 30; i++) { await Bun.sleep(100); const n = await offset(); if (n === y) return; y = n; } };
      const step = async (n: number) => { await k!.clickEl(`document.querySelector('.asknav [data-step="${n}"]')`); await Bun.sleep(100); await settled(); await Bun.sleep(100); };
      const at = () => count().then((t) => Number(t.split(" ")[0]));
      for (let i = 0; i < 3; i++) {
        const was = await at();
        await step(1);
        expect(await at()).toBe(was + 1);
        const clear = await ev(`(() => { const n = document.querySelector(".asknav").getBoundingClientRect().bottom, t = document.querySelectorAll("#hud > .ask")[${was}].getBoundingClientRect().top; return t >= n; })()`);
        expect(clear).toBe(true);
      }
      for (let i = 0; i < 3; i++) {
        const was = await at();
        await step(-1);
        expect(await at()).toBe(was - 1);
      }
    });

    test("a chip moves nothing you tap, whatever the lane's name", async () => {
      await desk(0, async (post) => {
        const ids: number[] = [];
        for (const lane of NAMES) { await post("/api/lanes", { name: lane, machine: "local" }); ids.push((await post("/api/asks", { title: `On ${lane.length}`, kind: "decision", options: ["Yes", "No", "Later"], lane })).id); }
        return ids;
      });
      const moved: string[] = [];
      for (const [i, id] of k!.ids.entries()) {
        const card = `document.querySelector('#hud > .ask[data-ask="${id}"]')`, tops = () => ev(`[...${card}.querySelectorAll(".opt, textarea, h3")].map((e) => Math.round(e.getBoundingClientRect().top))`) as Promise<number[]>;
        await ev(`${card}.querySelector(".opt").scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(100);
        const before = await tops();
        await k!.clickEl(`${card}.querySelector(".opt")`);
        await k!.until(`${card}.dataset.mark === "DRAFT"`);
        await Bun.sleep(60);
        const after = await tops();
        if (JSON.stringify(after) !== JSON.stringify(before)) moved.push(`${NAMES[i].length}: ${before[1]} to ${after[1]}`);
      }
      expect(moved).toEqual([]);
    });

    const settled = async () => { let y = await offset(); for (let i = 0; i < 30; i++) { await Bun.sleep(100); const n = await offset(); if (n === y) return; y = n; } };
    for (const n of [9, 30]) {
      test(`a reload on the last of ${n} cards: the place holds, and a second reload`, async () => {
        await desk(n);
        const last = k!.ids.at(-1)!;
        await ev(`innerWidth < 1151 ? scrollTo(0, 1e7) : (document.getElementById("hud").scrollTop = 1e7)`);
        await settled();
        await Bun.sleep(150);
        expect(await offset()).toBeGreaterThan(300);
        // Where you are after answering down a list: the end of it, above the middle of the screen.
        if (stacked) expect(await ev(`document.getElementById("hud").getBoundingClientRect().bottom <= innerHeight / 2`)).toBe(true);
        const was = await topOf(last);
        // A fresh load, as when a phone has dropped the page: the browser's own restoring on a reload can hide what we park.
        for (let i = 0; i < 2; i++) {
          await away();
          await home();
          expect(await offset()).toBeGreaterThan(300);
          if (touch) expect(await count()).toBe(`${n} OF ${n}`);
          else expect(Math.abs((await topOf(last)) - was)).toBeLessThan(NEAR);
        }
      });
    }

    test("on a card near the end, and the last two closed while you were away: the card holds", async () => {
      await desk(30);
      const id = k!.ids[27];
      await k!.wheelTo(id, 20);
      await Bun.sleep(300);
      await away();
      await out(k!.ids[28], k!.ids[29]);
      await home();
      expect(await offset()).toBeGreaterThan(300);
      expect(await seenNow(id)).toBe(true);
    });

    // In a short window the page goes on well past the list.
    test.skipIf(run.width !== 600)("wholly under the list, reading what is there: a reload stays there", async () => {
      await k?.stop();
      const short = await run.make(600, 360);
      k = await startDesk(ROOT, async () => short.driver, { width: 600, height: 360, noAnchor: true, seed: async (post) => { const ids: number[] = []; for (let i = 1; i <= 9; i++) ids.push((await post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf" })).id); return ids; } });
      try {
        k.late.go("font.ttf");
        await ev(`try { localStorage.clear(); sessionStorage.clear(); } catch {}`);
        await reload();
        await ev(`scrollTo(0, 1e7)`);
        await settled();
        await Bun.sleep(150);
        const lastBottom = `[...document.querySelectorAll("#hud > .ask")].at(-1).getBoundingClientRect().bottom`, under = `document.querySelector(".tell").getBoundingClientRect().top`;
        expect(await ev(`${lastBottom} <= document.querySelector(".asknav").getBoundingClientRect().bottom`)).toBe(true);
        const was = await ev(under) as number;
        await away();
        await home();
        expect(await offset()).toBeGreaterThan(300);
        expect(Math.abs((await ev(under) as number) - was)).toBeLessThan(NEAR);
      } finally { await k.stop(); k = null; await short.close(); }
    });

    test.skipIf(touch)("the caret in TELL HQ's box, a card still on screen: a new question leaves the box where it is", async () => {
      await desk(9);
      const box = `document.getElementById("noteText")`, top = `${box}.getBoundingClientRect().top`;
      if (stacked) {
        await ev(`scrollBy(0, ${box}.getBoundingClientRect().bottom - innerHeight + 20)`);
        await settled();
        expect(await ev(`[...document.querySelectorAll("#hud > .ask")].at(-1).getBoundingClientRect().bottom > document.querySelector(".asknav").getBoundingClientRect().bottom`)).toBe(true);
      }
      await k!.clickEl(box);
      await k!.until(`document.activeElement === ${box}`);
      await k!.d.type("Typing to HQ");
      await Bun.sleep(200);
      const was = await ev(top) as number, n = await ev(`document.querySelectorAll("#hud > .ask").length`) as number;
      await k!.server.post("/api/asks", { title: "Arrives under the last card", kind: "decision", options: ["Yes", "No"], lane: "golf" });
      await k!.until(`document.querySelectorAll("#hud > .ask").length === ${n + 1}`);
      await Bun.sleep(300);
      expect(Math.abs((await ev(top) as number) - was)).toBeLessThanOrEqual(1);
      await k!.server.post("/api/asks", { title: "Arrives due, at the top", kind: "decision", options: ["Yes", "No"], lane: "golf", due: Date.now() + 3600_000 });
      await k!.until(`document.querySelectorAll("#hud > .ask").length === ${n + 2}`);
      await Bun.sleep(300);
      expect(Math.abs((await ev(top) as number) - was)).toBeLessThanOrEqual(1);
      expect(await ev(`document.activeElement === ${box} && ${box}.value`)).toBe("Typing to HQ");
    });

    test("FOCUS: on a card taller than the window an arrow key scrolls until its end is in view, then steps; up does the same", async () => {
      await desk(0, async (post) => { const ids: number[] = []; for (let i = 1; i <= 4; i++) ids.push((await post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf", body: "A long question with a lot to read in it. ".repeat(160) })).id); return ids; });
      await k!.clickEl(`document.querySelector(".asknav [data-focus]")`);
      await k!.until(`document.getElementById("hud").classList.contains("focus")`);
      await ev(`import("/src/client/questions/focus.js").then((m) => m.focusTo(${k!.ids[1]}))`);
      await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${k!.ids[1]}"`);
      await ev(`document.activeElement?.blur?.()`);
      await ev(`for (const m of document.querySelectorAll("#hud .more")) m.click()`);
      await Bun.sleep(200);
      const now = () => ev(`(() => { const c = document.querySelector("#hud > .ask.on"), r = c.getBoundingClientRect(), h = document.getElementById("hud").getBoundingClientRect(), wide = innerWidth >= 1151; return { on: Number(c.dataset.ask), top: r.top, bottom: r.bottom, edge: wide ? h.bottom : innerHeight, line: wide ? h.top : document.querySelector(".asknav").getBoundingClientRect().bottom }; })()`) as Promise<{ on: number; top: number; bottom: number; edge: number; line: number }>;
      const walk = async (key: string, from: number, to: number) => {
        let was = await now(), steps = 0;
        expect(was.on).toBe(from);
        for (; steps < 40; steps++) {
          await k!.d.key(key);
          await Bun.sleep(80);
          const n = await now();
          if (n.on !== from) {
            expect(n.on).toBe(to);
            // Only once the end of the card was in view.
            if (key === "ArrowDown") expect(was.bottom).toBeLessThanOrEqual(was.edge + 2);
            else expect(was.top).toBeGreaterThanOrEqual(was.line - 2);
            return steps;
          }
          // Nothing skipped: each press leaves some of what you were reading on screen.
          expect(Math.abs(n.top - was.top)).toBeGreaterThan(0);
          expect(Math.abs(n.top - was.top)).toBeLessThan(n.edge - n.line);
          was = n;
        }
        throw new Error(`${key} never left the card`);
      };
      expect((await now()).bottom).toBeGreaterThan((await now()).edge);
      expect(await walk("ArrowDown", k!.ids[1], k!.ids[2])).toBeGreaterThan(0);
      await ev(`import("/src/client/questions/focus.js").then((m) => m.focusTo(${k!.ids[1]}))`);
      await Bun.sleep(150);
      for (let i = 0; i < 2; i++) { await k!.d.key("ArrowDown"); await Bun.sleep(80); }
      expect((await now()).on).toBe(k!.ids[1]);
      expect(await walk("ArrowUp", k!.ids[1], k!.ids[0])).toBeGreaterThan(0);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED|Failed to fetch/.test(e))).toEqual([]));
  });
}
