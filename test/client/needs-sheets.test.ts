// FOCUS on a phone's top row and under the sheets, walked with real input: the row stays reachable under the tabs, and
// a sheet opened over the question leaves the question, its draft and the page where they were, whatever comes in
// meanwhile. Back walks the sheets one entry at a time. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped
// without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { fakeHome } from "../fake-subs.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "phone 390", width: 390, height: 844, noAnchor: true, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), touch: true, skip: !findChrome() },
  { name: "narrow window 600", width: 600, height: 800, noAnchor: true, make: chromeDriver, touch: false, skip: !findChrome() },
  { name: "WebKit 600", width: 600, height: 800, noAnchor: true, make: webkitDriver, touch: false, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const ROW = ['[data-step="-1"]', "#below", '[data-step="1"]', "[data-focus]"];

for (const run of RUNS) {
  describe.skipIf(run.skip)(`FOCUS and sheets, ${run.name}`, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    let brief = 0, home = "";
    const ev = (e: string) => k.ev(e);
    const click = (sel: string) => k.clickEl(`document.querySelector(${JSON.stringify(sel)})`);
    const stage = () => ev(`[...document.querySelectorAll("#hud > .ask")].filter((c) => c.getBoundingClientRect().height > 0).map((c) => Number(c.dataset.ask))`) as Promise<number[]>;
    const count = () => ev(`document.getElementById("below").textContent`) as Promise<string>;
    const y = () => ev(`scrollY`) as Promise<number>;
    const toTop = async () => { await k.d.wheel(run.width / 2, run.height / 2, -20000); await k.until(`scrollY === 0`); };
    const toFocusOff = async () => {
      if (!(await ev(`document.getElementById("hud").classList.contains("focus")`))) return;
      await toTop();
      await click("[data-focus]");
      await k.until(`!document.getElementById("hud").classList.contains("focus")`);
      await Bun.sleep(200);
    };
    const noSheet = `!document.querySelector(".sheet") && !history.state?.hqSheet`;
    const scrim = () => k.d.click(run.width / 2, 3);
    const draft = `#hud > .ask.on textarea`;
    const overMenu = (row: string) => async () => { await click("#menuBtn"); await k.until(`!!document.querySelector("#menuDrop.sheet")`); await click(row); };
    const tab = (name: string) => click(`[data-qtab="${name}"]`);
    const go = (hash: string) => ev(`location.hash = ${JSON.stringify(hash)}, true`);
    type Sheet = { name: string; sel: string; open: () => Promise<void>; touch?: boolean; scrims?: number; leave?: () => Promise<unknown> };
    const SHEETS: Sheet[] = [
      { name: "MENU", sel: "#menuDrop", open: () => click("#menuBtn") },
      { name: "the lane's drawer", sel: "#card", open: () => click("#hud > .ask.on .meta [data-select]") },
      { name: "TELL HQ", sel: ".tell", open: overMenu("#menuTell") },
      { name: "SECRETS", sel: "#secretsPanel", open: overMenu("#secretsBtn") },
      { name: "SETTINGS", sel: "#settings", open: overMenu("#settingsBtn"), touch: true },
      { name: "SUBS", sel: "#subsDrop", open: overMenu("#menuSubs"), touch: true },
      { name: "the floor list", sel: ".fmenu", open: () => click("[data-pill]"), touch: true },
      { name: "the floor panel", sel: ".fpanel", open: async () => { await click("[data-pill]"); await k.until(`!!document.querySelector(".fmenu.sheet")`); await click("[data-floor-add]"); }, touch: true },
      { name: "a confirmation", sel: ".confirm", scrims: 2, open: async () => { await overMenu("#secretsBtn")(); await k.until(`!!document.querySelector("#secretsPanel.sheet [data-secret-rm]")`); await click("[data-secret-rm]"); }, touch: true },
      { name: "NEW ROOM", sel: ".nrpanel", open: async () => { await tab("rooms"); await k.until(`!!document.querySelector(".rnew")`); await click(".rnew"); }, leave: () => tab("questions"), touch: true },
      { name: "the comment sheet", sel: ".cmount.open", open: async () => { await go(`#brief/${brief}`); await k.until(`!!document.querySelector(".bvbar [data-comments-toggle]")`); await click(".bvbar [data-comments-toggle]"); }, leave: () => go(""), touch: true },
    ].filter((s) => !s.touch || run.touch);
    const pops = () => ev(`window.__pops`) as Promise<number>;
    const countPops = () => ev(`(() => { window.__pops = 0; if (!window.__popsOn) { window.__popsOn = true; addEventListener("popstate", () => { window.__pops++; }, true); } })()`);
    const back = async () => { await ev(`history.back(), true`); await Bun.sleep(350); };
    const mark = async () => {
      await ev(`history.replaceState({ mark: "older" }, ""); history.pushState({ mark: "before" }, "")`);
      await countPops();
      return ev(`history.length`) as Promise<number>;
    };
    const entry = () => ev(`({ mark: history.state?.mark ?? null, sheet: !!history.state?.hqSheet })`);

    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      // SUBS is on the page once a source is; a made-up home, never the owner's.
      if (run.touch) home = fakeHome();
      k = await startDesk(ROOT, async () => browser.driver, { ...run, env: home ? { HUD_SUBS_HOME: home, HUD_SUBS_MS: "150" } : {} });
      brief = (await k.server.post("/api/briefs", { title: "A brief with comments", body: "Short." })).id;
      await k.server.post("/api/secrets", { name: "A_MADE_UP_NAME", value: "not-a-real-value", minutes: 5, by: "owner" });
      if (run.touch) await k.until(`!!document.querySelector("#subsBtn")`);
      k.late.go("font.ttf"); k.late.go("late-above.svg"); k.late.go("late-own.svg");
      await Bun.sleep(400);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); if (home) rmSync(home, { recursive: true, force: true }); });

    test("under the new top row: FOCUS's row is reachable and the question comes up", async () => {
      await click("[data-focus]");
      await k.until(`document.getElementById("hud").classList.contains("focus")`);
      for (const sel of ROW) {
        const hit = await ev(`(() => { const e = document.querySelector(${JSON.stringify(`.asknav ${sel}`)}), r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e === h || e.contains(h); })()`);
        expect(hit).toBe(true);
      }
      const seen = await ev(`(() => { const n = document.querySelector(".asknav").getBoundingClientRect(), t = document.querySelector("#hud > .ask.on h3").getBoundingClientRect(), m = document.getElementById("menuBtn").getBoundingClientRect(); return { order: m.bottom <= n.top, up: t.top >= n.bottom && t.top < innerHeight / 2 }; })()`);
      expect(seen).toEqual({ order: true, up: true });
    });

    test("scrolled down a long question, the row stays over the question, under the tabs on a touch screen", async () => {
      await ev(`document.querySelector("#hud > .ask.on").scrollIntoView({ block: "start", behavior: "instant" })`);
            const box = await ev(`(() => { const r = document.querySelector("#hud > .ask.on").getBoundingClientRect(); return { x: r.x + r.width / 2, y: innerHeight / 2 }; })()`);
      await k.d.wheel(box.x, box.y, 120);
      await Bun.sleep(300);
      const at = await ev(`(() => { const t = document.querySelector(".qtabs").getBoundingClientRect(), n = document.querySelector(".asknav").getBoundingClientRect(); return { below: n.top >= t.bottom - 1, close: n.top - t.bottom < 12, inView: t.top >= -1 && n.bottom <= innerHeight, y: scrollY }; })()`);
      if (run.touch) expect(at).toMatchObject({ below: true, close: true, inView: true });
      const hit = await ev(`(() => { const e = document.querySelector('[data-step="1"]'), r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e === h || e.contains(h); })()`);
      expect(hit).toBe(true);
    });

    for (const { name, sel, open, scrims = 1, leave } of SHEETS) {
      test(`${name} over the question: what comes in changes the count, closing leaves question, draft and page in place`, async () => {
        await toTop();
        const on = (await stage())[0];
        const typed = `Held under ${name}.`;
        await ev(`document.querySelector(${JSON.stringify(draft)}).scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(100);
        await click(draft);
        await k.until(`document.activeElement === document.querySelector(${JSON.stringify(draft)})`);
        await k.d.type(typed);
        await ev(`document.activeElement.blur()`);
        await Bun.sleep(150);
        await toTop();
        await Bun.sleep(100);
        const before = { y: await y(), top: await ev(`document.querySelector("#hud > .ask.on h3").getBoundingClientRect().top`), n: await count() };
        await open();
        await k.until(`!!document.querySelector(${JSON.stringify(`${sel}.sheet`)})`);
        await Bun.sleep(300);
        // What is behind the sheet cannot be reached: the middle of ▼ is the sheet or the scrim.
        const reach = await ev(`(() => { const e = document.querySelector('[data-step="1"]'); if (!e) return true; const r = e.getBoundingClientRect(), h = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(e === h || e.contains(h)); })()`);
        expect(reach).toBe(true);
        await k.server.post("/api/asks", { title: `Came in under ${name}`, kind: "decision", options: ["Yes"], lane: "golf" });
        if (!leave) {
          await k.until(`document.getElementById("below").textContent !== ${JSON.stringify(before.n)}`);
          expect(await stage()).toEqual([on]);
          expect(await y()).toBe(before.y);
        } else await Bun.sleep(300);
        for (let i = 0; i < scrims; i++) { await scrim(); await Bun.sleep(150); }
        await k.until(noSheet);
        await leave?.();
        await k.until(`document.querySelector("#hud > .ask.on")?.getBoundingClientRect().height > 0`);
        await k.until(`document.getElementById("below").textContent !== ${JSON.stringify(before.n)}`);
        await Bun.sleep(400);
        expect(await stage()).toEqual([on]);
        if (!leave) {
          expect(await y()).toBe(before.y);
          expect(await ev(`document.querySelector("#hud > .ask.on h3").getBoundingClientRect().top`)).toBeCloseTo(before.top, 0);
        }
        expect(await ev(`document.querySelector(${JSON.stringify(draft)}).value`)).toContain(typed);
      });
    }

    test("a reload with a sheet open brings back the question, the mode and no sheet", async () => {
      await toTop();
      const on = (await stage())[0];
      await click("#menuBtn");
      await k.until(`!!document.querySelector("#menuDrop.sheet")`);
      await k.d.reload();
      await k.until(`document.getElementById("hud").classList.contains("focus") && !!document.querySelector("#hud > .ask.on")`);
      await Bun.sleep(600);
      expect(await stage()).toEqual([on]);
      expect(await ev(`!!document.querySelector(".sheet")`)).toBe(false);
      if (run.noAnchor) await ev(`(() => { const s = document.createElement("style"); s.textContent = "* { overflow-anchor: none !important; }"; document.head.append(s); })()`);
    });

    for (const row of ["#menuTell", "#secretsBtn", ...(run.touch ? ["#settingsBtn", "#menuSubs"] : [])]) {
      test(`MENU to ${row}: one Back entry between them, one Back ends before MENU, and the next Back is not dead`, async () => {
        await toTop();
        const length = await mark();
        await overMenu(row)();
        await k.until(`document.querySelectorAll(".sheet:not(#menuDrop)").length === 1`);
        await Bun.sleep(200);
        expect(await ev(`history.length`)).toBe(length + 1);
        await back();
        await k.until(noSheet);
        expect(await entry()).toEqual({ mark: "before", sheet: false });
        expect(await pops()).toBe(1);
        await back();
        expect(await entry()).toEqual({ mark: "older", sheet: false });
        expect(await pops()).toBe(2);
      });

      test(`MENU to ${row}, closed on the scrim: it leaves the entry from before MENU`, async () => {
        await toTop();
        await mark();
        await overMenu(row)();
        await k.until(`document.querySelectorAll(".sheet:not(#menuDrop)").length === 1`);
        await Bun.sleep(200);
        await scrim();
        await k.until(noSheet);
        await Bun.sleep(300);
        expect(await entry()).toEqual({ mark: "before", sheet: false });
        expect(await pops()).toBe(1);
      });
    }

    test("Back walks a real stack, a confirmation over SECRETS, one sheet a press", async () => {
      await toTop();
      await mark();
      await overMenu("#secretsBtn")();
      await k.until(`!!document.querySelector("#secretsPanel.sheet [data-secret-rm]")`);
      await click("[data-secret-rm]");
      await k.until(`!!document.querySelector(".confirm.sheet")`);
      await Bun.sleep(200);
      await back();
      expect(await ev(`!!document.querySelector(".confirm.sheet")`)).toBe(false);
      expect(await ev(`!!document.querySelector("#secretsPanel.sheet")`)).toBe(true);
      expect(await pops()).toBe(1);
      await back();
      await k.until(noSheet);
      expect(await entry()).toEqual({ mark: "before", sheet: false });
      expect(await pops()).toBe(2);
    });

    test("Back closes a sheet and leaves the question where it was", async () => {
      const on = (await stage())[0], before = await y();
      await click("#hud > .ask.on .meta [data-select]");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await ev(`history.back()`);
      await k.until(noSheet);
      await Bun.sleep(400);
      expect(await stage()).toEqual([on]);
      expect(await y()).toBe(before);
    });

    test("an arrow key with a sheet open does not step the question behind it", async () => {
      const on = (await stage())[0];
      await click("#hud > .ask.on .meta [data-select]");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await ev(`document.activeElement?.blur?.()`);
      await k.d.key("ArrowDown");
      await Bun.sleep(200);
      expect(await stage()).toEqual([on]);
      await scrim();
      await k.until(noSheet);
    });

    test("your question closes while a sheet is open: closing the sheet, it says so in place", async () => {
      const on = (await stage())[0];
      await click("#hud > .ask.on .meta [data-select]");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await k.server.post(`/api/asks/${on}/withdraw`, { reason: "gone" });
      await k.until(`!!document.querySelector("#hud > .ask.on .leftnote")`);
      await scrim();
      await k.until(noSheet);
      expect(await stage()).toEqual([on]);
      expect(await ev(`document.querySelector("#hud > .ask.on .leftnote").textContent`)).toContain("WITHDRAWN");
      await ev(`document.querySelector("#hud > .ask.on [data-left-drop]").scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(100);
      // A card that has just changed takes no press for a moment (needs-gate.test.ts).
      await k.until(`!document.documentElement.classList.contains("unready")`);
      await click("#hud > .ask.on [data-left-drop]");
      await k.until(`!document.querySelector('#hud [data-ask="${on}"]')`);
    });

    test("ANSWER IN NEEDS YOU from the drawer: the sheet goes, the question is on the stage, and it stays there", async () => {
      await click("#hud > .ask.on .meta [data-select]");
      await k.until(`!!document.querySelector("#card.sheet [data-answer-jump]")`);
      const to = Number(await ev(`document.querySelector("#card [data-answer-jump]").dataset.answerAsk`));
      await click("#card [data-answer-jump]");
      await k.until(noSheet);
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${to}"`);
      await Bun.sleep(600);
      expect(await stage()).toEqual([to]);
      const seen = await ev(`(() => { const n = document.querySelector(".asknav").getBoundingClientRect(), t = document.querySelector("#hud > .ask.on h3").getBoundingClientRect(); return t.top >= n.bottom - 1 && t.top < innerHeight; })()`);
      expect(seen).toBe(true);
    });

    test("a toast over the top row lets a click through to MENU", async () => {
      await toTop();
      await ev(`import("/src/client/core/dom.js").then((m) => m.toast("A toast over the top row"))`);
      await k.until(`!!document.querySelector(".toast")`);
      await click("#menuBtn");
      await k.until(`!!document.querySelector("#menuDrop.sheet")`);
      await scrim();
      await k.until(noSheet);
      await k.until(`!document.querySelector(".toast")`);
    });

    test("THE OFFICE from MENU and ▲ BACK return to the same question (phone sizes)", async () => {
      await toTop();
      const on = (await stage())[0], before = await y();
      await click("#menuBtn");
      await k.until(`!!document.querySelector("#menuDrop.sheet")`);
      await click("#menuOffice");
      await k.until(`!!document.querySelector(".jumpback") && !document.querySelector(".sheet")`);
      await Bun.sleep(300);
      await click(".jumpback");
      await k.until(`!document.querySelector(".jumpback")`);
      await Bun.sleep(300);
      expect(await stage()).toEqual([on]);
      expect(await y()).toBe(before);
    });

    test("behind an open sheet nothing takes the focus, Tab or a script, and it comes back on close", async () => {
      await toTop();
      const tag = "#hud > .ask.on .meta [data-select]";
      await ev(`document.querySelector(${JSON.stringify(tag)}).focus()`);
      await k.d.key("Enter");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await Bun.sleep(200);
      expect(await ev(`document.getElementById("hud").closest("[inert]") !== null`)).toBe(true);
      const behind = `document.activeElement?.closest("#hud, .asknav") !== null`;
      expect(await ev(behind)).toBe(false);
      for (let i = 0; i < 12; i++) {
        await k.d.key("Tab");
        expect(await ev(behind)).toBe(false);
      }
      await ev(`document.querySelector("#hud > .ask.on textarea").focus()`);
      expect(await ev(behind)).toBe(false);
      await k.d.key("Escape");
      await k.until(noSheet);
      await Bun.sleep(150);
      expect(await ev(`document.getElementById("hud").closest("[inert]") === null`)).toBe(true);
      expect(await ev(`document.activeElement === document.querySelector(${JSON.stringify(tag)})`)).toBe(true);
    });

    test("FOCUS off: a sheet over the list and an arrival above leave the card under the eye", async () => {
      await click("[data-focus]");
      await k.until(`!document.getElementById("hud").classList.contains("focus")`);
      const open = await k.openIds(), on = open[Math.min(20, open.length - 2)];
      await k.wheelTo(on, 150);
      await Bun.sleep(300);
      await k.arm(on);
      await click(`#hud [data-ask="${on}"] .meta [data-select]`);
      await k.until(`!!document.querySelector("#card.sheet")`);
      await k.server.post("/api/asks", { title: "New and due, sorts first", kind: "decision", options: ["Yes"], lane: "golf", due: Date.now() + 3600_000 });
      await k.until(`[...document.querySelectorAll("#hud .ask h3")].some((h) => h.textContent.includes("New and due"))`);
      await Bun.sleep(300);
      await scrim();
      await k.until(noSheet);
      await Bun.sleep(600);
      const r = await k.read();
      expect(Math.abs(r.last - r.base)).toBeLessThan(2);
    });

    test("TELL HQ over the list, its box focused: an arrival above leaves the card under the eye", async () => {
      await toFocusOff();
      const open = await k.openIds(), on = open[Math.min(20, open.length - 2)];
      await k.wheelTo(on, 150);
      await Bun.sleep(300);
      await k.arm(on);
      // MENU is at the top of the page: on a phone TELL HQ's box is reached from there, and the walk puts it up as MENU would.
      await ev(`import("/src/client/tell/tell.js").then((m) => m.openTell())`);
      await k.until(`!!document.querySelector(".tell.sheet") && document.activeElement?.id === "noteText"`);
      await Bun.sleep(200);
      await k.server.post("/api/asks", { title: "Due and sorted first, under TELL", kind: "decision", options: ["Yes"], lane: "golf", due: Date.now() + 3600_000 });
      await k.until(`[...document.querySelectorAll("#hud .ask h3")].some((h) => h.textContent.includes("under TELL"))`);
      await Bun.sleep(300);
      await scrim();
      await k.until(noSheet);
      await Bun.sleep(600);
      const r = await k.read();
      expect(Math.abs(r.last - r.base)).toBeLessThan(2);
    });

    test("MENU to TELL HQ a little way down the page, an arrival, and closed: the page stays", async () => {
      await toFocusOff();
      await toTop();
      await Bun.sleep(600); // the wheel's way up is still animating: a small step now would be taken in by it
      await k.d.wheel(run.width / 2, run.height / 2, 24);
      await Bun.sleep(400);
      const first = (await k.openIds())[1];
      await k.arm(first);
      const y0 = await y();
      expect(y0).toBeGreaterThan(0);
      await overMenu("#menuTell")();
      await k.until(`!!document.querySelector(".tell.sheet")`);
      await Bun.sleep(200);
      await k.server.post("/api/asks", { title: "New at the end, under TELL", kind: "decision", options: ["Yes"], lane: "golf" });
      await Bun.sleep(300);
      await scrim();
      await k.until(noSheet);
      await Bun.sleep(600);
      expect(Math.abs((await y()) - y0)).toBeLessThan(2);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED/.test(e))).toEqual([]));
  });
}
