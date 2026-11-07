// FOCUS in NEEDS YOU, walked with real input at desktop and phone sizes: one question on the stage, nothing about the
// others can move it, drafts stay with their cards, and a question that closes says so in place. A card that closes with
// your words in it does the same in the list. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "desktop 1280", width: 1280, height: 800, noAnchor: true, make: chromeDriver, touch: false, skip: !findChrome() },
  { name: "phone 390", width: 390, height: 844, noAnchor: true, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), touch: true, skip: !findChrome() },
  { name: "WebKit 1440", width: 1440, height: 900, noAnchor: true, make: webkitDriver, touch: false, skip: !process.env.NEEDS_PLAYWRIGHT },
];

for (const run of RUNS) {
  describe.skipIf(run.skip)(`FOCUS, ${run.name}`, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    const ev = (e: string) => k.ev(e);
    const shown = `[...document.querySelectorAll("#hud > .ask")].filter((c) => c.getBoundingClientRect().height > 0)`;
    const onStage = () => ev(`${shown}.map((c) => Number(c.dataset.ask))`) as Promise<number[]>;
    const pill = () => ev(`document.getElementById("below").textContent`) as Promise<string>;
    const click = (sel: string) => k.clickEl(`document.querySelector(${JSON.stringify(sel)})`);
    const bring = (sel: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(), h = document.getElementById("hud").getBoundingClientRect(), end = innerWidth < 1151 ? innerHeight - 8 : h.bottom - 8; if (e.closest(".asknav")) return; if (r.top < (innerWidth < 1151 ? 110 : h.top) || r.bottom > end) e.scrollIntoView({ block: "center", behavior: "instant" }); })()`);
    // A card that has just changed takes no press for a moment (needs-gate.test.ts).
    const press = async (sel: string) => { await k.until(`!document.documentElement.classList.contains("unready")`); await bring(sel); await Bun.sleep(80); await click(sel); };
    const stageId = async () => (await onStage())[0];
    const inStage = (sel: string) => `#hud > .ask.on ${sel}`;
    const typeInto = async (text: string) => {
      await press(inStage("textarea"));
      await k.until(`document.activeElement === document.querySelector(${JSON.stringify(inStage("textarea"))})`);
      await k.d.type(text);
    };

    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      k = await startDesk(ROOT, async () => browser.driver, run);
      k.late.go("font.ttf"); k.late.go("late-above.svg"); k.late.go("late-own.svg");
      await Bun.sleep(400);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    test("off by default; FOCUS sits at the head of the list; on it, one question and where it stands", async () => {
      expect((await onStage()).length).toBeGreaterThan(5);
      await ev(`localStorage.getItem("hq-needs-focus")`).then((v) => expect(v).toBe(null));
      await k.wheelTo(k.ids[12], 40);
      await Bun.sleep(300);
      await press(".asknav [data-focus]");
      await k.until(`document.getElementById("hud").classList.contains("focus")`);
      expect(await onStage()).toEqual([k.ids[12]]);
      expect(await ev(`document.querySelector(".asknav [data-focus]").getAttribute("aria-pressed")`)).toBe("true");
      expect(await pill()).toMatch(/^13 OF \d+$/);
      expect(await ev(`localStorage.getItem("hq-needs-focus")`)).toBe("1");
      const nav = await ev(`(() => { const r = document.querySelector(".asknav").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
      expect(nav).toBe(true);
    });

    test("nothing moves when the others change: arrivals, answers, withdrawals, edits, comments; only the count", async () => {
      const on = await stageId(), all = (await k.openIds()).filter((x) => x !== on);
      await typeInto("Held while the others change.");
      await Bun.sleep(200);
      await k.arm(on);
      const before = await ev(`({ page: document.documentElement.scrollHeight, y: scrollY, list: document.getElementById("hud").scrollHeight, top: document.getElementById("hud").scrollTop })`);
      await k.server.post("/api/asks", { title: "New at the end", kind: "decision", options: ["Yes"], lane: "golf" });
      await k.until(`document.querySelectorAll("#hud > .ask").length === ${all.length + 2}`);
      await k.server.post("/api/asks", { title: "New and due, sorts first", kind: "decision", options: ["Yes"], lane: "golf", due: Date.now() + 3600_000 });
      await k.server.post(`/api/asks/${all[2]}/answer`, { answer: "Yes" });
      await k.server.post(`/api/asks/${all[3]}/withdraw`, { reason: "gone" });
      await k.server.post(`/api/asks/${all[4]}/update`, { body: "Longer. ".repeat(80) });
      await k.server.post(`/api/asks/${all[5]}/comment`, { text: "A comment on another card." });
      await k.server.post(`/api/asks/${all[6]}/items`, { text: "An item on another card." });
      await Bun.sleep(900);
      const r = await k.read();
      expect(r.frames).toBeGreaterThan(0);
      expect(r.peak).toBeLessThanOrEqual(1);
      expect(await ev(`({ page: document.documentElement.scrollHeight, y: scrollY, list: document.getElementById("hud").scrollHeight, top: document.getElementById("hud").scrollTop })`)).toEqual(before);
      expect(await onStage()).toEqual([on]);
      expect(await pill()).toMatch(/ OF \d+ · 2 NEW$/);
      expect(await ev(`document.activeElement === document.querySelector(${JSON.stringify(inStage("textarea"))})`)).toBe(true);
    });

    test("▲▼ move one question; the draft stays with its card; the picked option too", async () => {
      const first = await stageId();
      await press(".asknav [data-step='1']");
      const second = await stageId();
      expect(second).not.toBe(first);
      expect(await onStage()).toEqual([second]);
      if (await ev(`!!document.querySelector(${JSON.stringify(inStage(".opt"))})`)) await press(inStage(".opt"));
      await typeInto("A second draft.");
      await press(".asknav [data-step='-1']");
      expect(await stageId()).toBe(first);
      expect(await ev(`document.querySelector(${JSON.stringify(inStage("textarea"))}).value`)).toBe("Held while the others change.");
      await press(".asknav [data-step='1']");
      expect(await stageId()).toBe(second);
      expect(await ev(`document.querySelector(${JSON.stringify(inStage("textarea"))}).value`)).toBe("A second draft.");
    });

    test.skipIf(run.touch)("the arrow keys move, except while you type", async () => {
      await ev(`document.activeElement?.blur?.()`);
      const a = await stageId();
      await k.d.key("ArrowDown");
      await k.until(`${shown}[0].dataset.ask !== "${a}"`);
      await k.d.key("ArrowUp");
      await k.until(`${shown}[0].dataset.ask === "${a}"`);
      await press(inStage("textarea"));
      await k.d.key("ArrowDown");
      await Bun.sleep(150);
      expect(await stageId()).toBe(a);
      await ev(`document.activeElement?.blur?.()`);
    });

    test("answering goes to the next one", async () => {
      const ids = await k.openIds(), a = await stageId(), next = ids[ids.indexOf(a) + 1];
      if (await ev(`!!document.querySelector(${JSON.stringify(inStage(".opt"))}) && !document.querySelector(${JSON.stringify(inStage(".opt.sel"))})`)) await press(inStage(".opt"));
      await k.until(`!document.querySelector(${JSON.stringify(inStage(".send"))}).disabled`);
      await press(inStage(".send"));
      await k.until(`${shown}[0]?.dataset.ask === "${next}"`);
      expect(await onStage()).toEqual([next]);
      expect((await k.openIds()).includes(a)).toBe(false);
    });

    test("your card is withdrawn: the words and the box stay, it says so, COPY and NEXT", async () => {
      const ids = await k.openIds(), a = await stageId(), next = ids[ids.indexOf(a) + 1];
      await typeInto("Half a thought that must not vanish");
      await ev(`window.__box = document.activeElement`);
      await Bun.sleep(200);
      const at = await ev(`window.__box.getBoundingClientRect().top`);
      await k.server.post(`/api/asks/${a}/withdraw`, { reason: "no longer needed" });
      await k.until(`!!document.querySelector("#hud > .ask.left.on")`);
      await Bun.sleep(300);
      expect(Math.abs((await ev(`window.__box.getBoundingClientRect().top`)) - at)).toBeLessThanOrEqual(2);
      expect(await onStage()).toEqual([a]);
      expect(await ev(`document.querySelector("#hud > .ask.left .leftnote .sk").textContent`)).toBe("WITHDRAWN");
      expect(await ev(`(() => { const t = document.querySelector("#hud > .ask.left textarea"); return { same: t === window.__box, focused: document.activeElement === t, value: t.value, ro: t.readOnly }; })()`)).toEqual({ same: true, focused: true, value: "Half a thought that must not vanish", ro: true });
      expect(await ev(`!!document.querySelector("#hud > .ask.left .send, #hud > .ask.left .opt:not(:disabled)")`)).toBe(false);
      expect(await pill()).toMatch(/^\d+ WAITING/);
      await press("#hud > .ask.left [data-left-drop]");
      await k.until(`${shown}[0]?.dataset.ask === "${next}"`);
      expect(await ev(`document.querySelectorAll("#hud > .ask.left").length`)).toBe(0);
    });

    test("your card is answered elsewhere with nothing typed: it says so too, no silent jump", async () => {
      const a = await stageId();
      await k.server.post(`/api/asks/${a}/answer`, { answer: "Answered on another screen" });
      await k.until(`!!document.querySelector("#hud > .ask.left.on")`);
      expect(await onStage()).toEqual([a]);
      expect(await ev(`document.querySelector("#hud > .ask.left .leftnote").textContent`)).toContain("ANSWERED ELSEWHERE");
      expect(await ev(`document.querySelector("#hud > .ask.left .leftnote").textContent`)).toContain("Answered on another screen");
      await press("#hud > .ask.left [data-left-next]");
      await k.until(`!document.querySelector("#hud > .ask.left")`);
      expect((await onStage()).length).toBe(1);
    });

    test("a secret typed in is kept out of the markup, stays with its card, and is cleared when the card closes", async () => {
      const s = await k.server.post("/api/asks", { title: "A secret, please", kind: "action", secrets: ["API_TOKEN"], lane: "golf", due: Date.now() + 60_000 });
      await k.until(`!!document.querySelector('#hud > .ask[data-ask="${s.id}"]')`);
      const was = await stageId();
      await press(".asknav .below");
      await k.until(`document.querySelector('#hud > .ask.on')?.dataset.ask === "${s.id}"`);
      await press(inStage("[data-secret]"));
      await k.d.type("tok-en-value");
      await press(".asknav [data-step='1']");
      expect(await ev(`document.querySelector("#hud").innerHTML.includes("tok-en-value")`)).toBe(false);
      await press(".asknav [data-step='-1']");
      expect(await ev(`document.querySelector(${JSON.stringify(inStage("[data-secret]"))}).value`)).toBe("tok-en-value");
      await k.server.post(`/api/asks/${s.id}/withdraw`, { reason: "not needed" });
      await k.until(`!!document.querySelector("#hud > .ask.left.on")`);
      expect(await ev(`document.querySelector("#hud > .ask.left [data-secret]")`)).toBe(null);
      expect(await ev(`document.querySelector("#hud > .ask.left").textContent`)).toContain("cleared");
      await press("#hud > .ask.left [data-left-next]");
      await k.until(`!document.querySelector("#hud > .ask.left")`);
      expect(was).toBeGreaterThan(0);
    });

    test("the ledger and an ask's page show on the focused card", async () => {
      const ids = await k.openIds(), withNote = k.ids.filter((_, i) => (i + 1) % 3 === 0).find((id) => ids.includes(id))!;
      await ev(`document.querySelector('#hud > .ask[data-ask="${withNote}"]')`);
      await press(".asknav [data-focus]");
      await k.wheelTo(withNote, 40);
      await Bun.sleep(200);
      await press(".asknav [data-focus]");
      expect(await stageId()).toBe(withNote);
      expect(await ev(`(() => { const l = document.querySelector("#hud > .ask.on > .ledger"); return !!l && l.getBoundingClientRect().height > 0; })()`)).toBe(true);
      if (run.width > 640) {
        await press(".asknav [data-focus]");
        await k.wheelTo(k.framed, 40);
        await Bun.sleep(200);
        await press(".asknav [data-focus]");
        expect(await stageId()).toBe(k.framed);
        await k.until(`document.querySelector("#hud > .ask.on iframe.askframe")?.getBoundingClientRect().height > 30`);
      } else {
        await press(".asknav [data-focus]");
        await k.wheelTo(k.framed, 40);
        await Bun.sleep(200);
        await press(".asknav [data-focus]");
        expect(await ev(`!!document.querySelector("#hud > .ask.on .askstrip")`)).toBe(true);
      }
    });

    test("a reload brings back the same question, the mode and the draft", async () => {
      await press(".asknav [data-step='1']");
      const a = await stageId();
      await typeInto("Through a reload.");
      await k.d.reload();
      await k.until(`document.querySelectorAll("#hud > .ask").length > 5 && document.getElementById("hud").classList.contains("focus")`);
      await Bun.sleep(400);
      expect(await onStage()).toEqual([a]);
      expect(await ev(`document.querySelector(${JSON.stringify(inStage("textarea"))}).value`)).toBe("Through a reload.");
      expect(await pill()).toMatch(/ OF \d+/);
    });

    test("a card that closed while the page was away: after a reload it says so, with the words", async () => {
      const ids = await k.openIds(), a = await stageId();
      await ev(`setTimeout(() => location.reload(), 300), true`);
      await k.server.post(`/api/asks/${a}/withdraw`, { reason: "while away" });
      await Bun.sleep(900);
      await k.until(`!!document.querySelector("#hud > .ask.left.on")`);
      expect(await ev(`document.querySelector("#hud > .ask.left textarea").value`)).toBe("Through a reload.");
      expect(await ev(`document.querySelector("#hud > .ask.left .sk").textContent`)).toBe("WITHDRAWN");
      await press("#hud > .ask.left [data-left-drop]");
      await k.until(`!document.querySelector("#hud > .ask.left")`);
      expect(ids.length).toBeGreaterThan(1);
      expect(await pill()).toMatch(/ OF \d+/);
    });

    test("FOCUS off: the list comes back with the same card under the eye", async () => {
      const a = await stageId(), top = await ev(`document.querySelector('#hud > .ask[data-ask="${a}"]').getBoundingClientRect().top`);
      await press(".asknav [data-focus]");
      await k.until(`!document.getElementById("hud").classList.contains("focus")`);
      await Bun.sleep(300);
      expect((await onStage()).length).toBeGreaterThan(1);
      const now = await ev(`document.querySelector('#hud > .ask[data-ask="${a}"]').getBoundingClientRect().top`);
      expect(Math.abs(now - top)).toBeLessThanOrEqual(run.touch ? 16 : 14);
      expect(await ev(`localStorage.getItem("hq-needs-focus")`)).toBe(null);
    });

    test("in the list, a card with your words closes: it stays where it is, says so, and CLOSE lets the next one up", async () => {
      const ids = await k.openIds(), mid = Math.floor(ids.length / 2), a = ids[mid], next = ids[mid + 1];
      await k.wheelTo(a);
      await press(`#hud > .ask[data-ask="${a}"] textarea`);
      await k.until(`document.activeElement === document.querySelector('#hud > .ask[data-ask="${a}"] textarea')`);
      await k.d.type("Words in the list.");
      await Bun.sleep(200);
      const box = `document.querySelector('#hud > .ask[data-ask="${a}"] textarea')`, at = await ev(`${box}.getBoundingClientRect().top`);
      const n = await k.count();
      await k.server.post(`/api/asks/${a}/answer`, { answer: "From elsewhere" });
      await k.until(`!!document.querySelector('#hud > .ask.left[data-ask="${a}"]')`);
      await Bun.sleep(400);
      expect(Math.abs((await ev(`${box}.getBoundingClientRect().top`)) - at)).toBeLessThanOrEqual(2);
      expect(await ev(`document.querySelector('#hud > .ask.left[data-ask="${a}"] textarea').value`)).toBe("Words in the list.");
      expect(await ev(`document.querySelector('#hud > .ask.left[data-ask="${a}"] [data-left-copy]') !== null`)).toBe(true);
      await k.server.post("/api/asks", { title: "Arrives while it stays", kind: "info", lane: "golf" });
      await Bun.sleep(500);
      expect(await ev(`document.querySelector('#hud > .ask.left[data-ask="${a}"]').nextElementSibling?.dataset.ask`)).toBe(String(next));
      await press(`#hud > .ask.left[data-ask="${a}"] [data-left-drop]`);
      await k.until(`!document.querySelector("#hud > .ask.left")`);
      expect(await k.count()).toBe(n);
    });

    test("the last question answered: the normal empty state, no stuck focus view; the next arrival shows", async () => {
      await ev(`localStorage.setItem("hq-needs-focus", "1")`);
      await k.d.reload();
      await k.until(`document.getElementById("hud").classList.contains("focus") && document.querySelectorAll("#hud > .ask").length > 0`);
      const a = await stageId(), rest = (await k.openIds()).filter((x) => x !== a);
      for (const id of rest) await k.server.post(`/api/asks/${id}/answer`, { answer: "Yes" });
      await k.until(`document.querySelectorAll("#hud > .ask:not(.left)").length === 1`);
      await Bun.sleep(300);
      expect(await pill()).toBe("1 OF 1");
      if (await ev(`!!document.querySelector(${JSON.stringify(inStage(".opt"))})`)) await press(inStage(".opt"));
      await k.until(`!document.querySelector(${JSON.stringify(inStage(".send"))}).disabled`);
      await press(inStage(".send"));
      await k.until(`document.querySelectorAll("#hud > .ask:not(.left)").length === 0`);
      // Words typed in cards that closed meanwhile come up first, one at a time, then the empty list.
      for (let i = 0; i < 6 && (await ev(`!!document.querySelector("#hud > .ask.left")`)); i++) {
        await k.until(`!!document.querySelector("#hud > .ask.left.on textarea")`);
        expect(await ev(`document.querySelector("#hud > .ask.left.on textarea").value`)).toBeTruthy();
        await press("#hud > .ask.left.on [data-left-drop]");
        await Bun.sleep(150);
      }
      await k.until(`document.querySelectorAll("#hud > .ask").length === 0`);
      await Bun.sleep(200);
      expect(await ev(`document.querySelector("#hud > .box h2")?.textContent`)).toContain("NOTHING");
      expect(await ev(`!!document.querySelector(".asknav")`)).toBe(false);
      const fresh = await k.server.post("/api/asks", { title: "One more", kind: "info", lane: "golf" });
      await k.until(`${shown}[0]?.dataset.ask === "${fresh.id}"`);
      expect(await pill()).toMatch(/^1 OF 1/);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED/.test(e))).toEqual([]));
  });
}
