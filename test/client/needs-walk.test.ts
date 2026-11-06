// NEEDS YOU on a phone with 85 open questions, walked with real touch at 390x844: nothing that arrives moves what you
// read, and the draft, its caret and the focus (on a phone, the keyboard) survive. iOS Safari has no scroll anchoring,
// so every walk also runs with Chrome's turned off: Chrome's own anchoring must not be what holds the page still.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const LONG = "A long question body that takes up room on a small screen. ".repeat(12);
const LANE = "a-lane-with-a-really-long-name";

for (const anchoring of [false, true]) {
  describe.skipIf(!chromeFound)(`85 questions, scroll anchoring ${anchoring ? "on" : "off"}`, () => {
    let chrome: Awaited<ReturnType<typeof startChrome>>;
    let server: Awaited<ReturnType<typeof startServer>>;
    let page: Awaited<ReturnType<typeof newSession>>;
    const errors: string[] = [];
    let ids: number[] = [];
    let target = 0, firstNew = 0;
    const ev = (e: string) => page.evaluate(e);
    const until = async (expr: string, ms = 8000) => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
      throw new Error(`timed out waiting for ${expr}`);
    };
    const settle = () => Bun.sleep(350);
    const card = (id: number) => `document.querySelector('#hud [data-ask="${id}"]')`;
    const openIds = async () => (await (await fetch(`${server.base}/api/state`)).json()).open.map((a: { id: number }) => a.id) as number[];
    const newAsk = (i: number, extra: object = {}) => server.post("/api/asks", { title: `Arrived ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf", ...extra });
    // An open question on the far side of the one being read, picked fresh so a step never uses one another step closed.
    const above = async () => { const all = await openIds(); return all[Math.max(0, all.indexOf(target) - 6 - Math.floor(Math.random() * 10))]; };
    const below = async () => { const all = await openIds(); return all[all.indexOf(target) + 8]; };

    async function swipeTo(sel: string, at: number) {
      for (let i = 0; i < 30; i++) {
        const d = (await ev(`${sel}.getBoundingClientRect().top`)) - at;
        if (Math.abs(d) < 2) return;
        await page.s("Input.synthesizeScrollGesture", { x: 195, y: 700, yDistance: -d, gestureSourceType: "touch", speed: 12000, preventFling: true });
        await Bun.sleep(30);
      }
      throw new Error(`could not swipe ${sel} to ${at}`);
    }
    async function tapAt(x: number, y: number) {
      await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    async function tap(sel: string) {
      const r = await ev(`(() => { const e = ${sel}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await tapAt(r.x, r.y);
    }
    // The reader: where the card is on the screen, whether the very same text box still has the focus and the draft.
    const reading = () => ev(`(() => {
      const c = ${card(target)}, t = c?.querySelector("textarea");
      return { top: t?.getBoundingClientRect().top ?? -1, value: t?.value, sameBox: t === window.__box, focused: document.activeElement === t, blurs: window.__blurs, caret: t?.selectionStart };
    })()`);
    const DRAFT = "A draft that must survive.";
    let held: Awaited<ReturnType<typeof reading>>;
    const expectHeld = async () => {
      await settle();
      const now = await reading();
      // A correction lands on a whole device pixel, a third of a CSS pixel at this density, and this walk makes many.
      expect(Math.abs(now.top - held.top)).toBeLessThanOrEqual(2);
      expect({ ...now, top: held.top }).toEqual(held);
    };

    beforeAll(async () => {
      chrome = await startChrome();
      server = await startServer(ROOT);
      for (const name of ["golf", "alpha"]) await server.post("/api/lanes", { name, machine: "local" });
      for (let i = 1; i <= 85; i++) {
        const kind = ["decision", "action", "info"][i % 3];
        const a = await server.post("/api/asks", {
          title: `Question ${i}: ${i % 5 === 0 ? "a title that goes on and on across several lines of a small screen, as they do" : "short"}`,
          kind, lane: i % 2 ? LANE : "golf", body: i % 4 === 0 ? LONG : undefined, options: kind === "decision" ? ["Yes", "No", "Later"] : undefined,
        });
        ids.push(a.id);
      }
      for (let i = 1; i <= 24; i++) await server.post("/api/updates", { lane: "alpha", title: `Update ${i}`, body: "Two lines of news.\nThe second line." });
      await server.post("/api/rooms", { slug: "ope-1", title: "A room", owner: "alpha" });
      await server.post("/api/rooms/ope-1/brief", { body: Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of a brief that is longer than the screen.`).join("\n\n") });
      page = await newSession(chrome.cdp, errors);
      await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
      await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      // A clock the walk can move, so every timer goes through its wider and narrower texts.
      await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const real = Date.now.bind(Date); window.__skew = 0; Date.now = () => real() + window.__skew; })();` });
      if (!anchoring) await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = "* { overflow-anchor: none !important; }"; document.head.append(s); });` });
      await page.s("Page.navigate", { url: `${server.base}/` });
      await until(`document.querySelectorAll("#hud .ask").length === 85 && !!document.getElementById("lastNote")?.innerHTML`);
      await Bun.sleep(300);
      target = ids[44];
    }, 90_000);

    afterAll(async () => {
      await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
      await server?.stop();
      await chrome?.close();
    });

    test("swipe to a question in the middle and type a draft in it", async () => {
      await swipeTo(card(target), 200);
      await tap(`${card(target)}.querySelector("textarea")`);
      await until(`document.activeElement === ${card(target)}.querySelector("textarea")`);
      await page.s("Input.insertText", { text: DRAFT });
      await ev(`(() => { const t = ${card(target)}.querySelector("textarea"); window.__box = t; window.__blurs = 0; t.addEventListener("blur", () => window.__blurs++); })()`);
      await settle();
      held = await reading();
      expect(held.value).toBe(DRAFT);
      expect(held.focused).toBe(true);
      expect(held.top).toBeGreaterThan(0);
    });

    test("a new question at the end of the list", async () => {
      firstNew = (await newAsk(1)).id;
      await until(`document.querySelectorAll("#hud .ask").length === 86`);
      await expectHeld();
    });
    test("a question that is due, which sorts to the top of the list", async () => {
      await newAsk(2, { due: Date.now() + 3600_000 });
      await until(`document.querySelectorAll("#hud .ask").length === 87`);
      await expectHeld();
    });
    test("a question above is answered", async () => {
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await server.post(`/api/asks/${await above()}/answer`, { answer: "Yes" });
      await until(`document.querySelectorAll("#hud .ask").length === ${n - 1}`);
      await expectHeld();
    });
    test("a question above is withdrawn", async () => {
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await server.post(`/api/asks/${await above()}/withdraw`, { reason: "no longer needed" });
      await until(`document.querySelectorAll("#hud .ask").length === ${n - 1}`);
      await expectHeld();
    });
    test("a question below is answered", async () => {
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await server.post(`/api/asks/${await below()}/answer`, { answer: "Yes" });
      await until(`document.querySelectorAll("#hud .ask").length === ${n - 1}`);
      await expectHeld();
    });
    test("a comment lands on a question above", async () => {
      const id = await above();
      await server.post(`/api/asks/${id}/comment`, { text: "HQ has a thought.\n\nIn two paragraphs, so the card grows." });
      await until(`!!${card(id)}.querySelector(".ledger")`);
      await expectHeld();
    });
    test("a comment lands on the question being typed in", async () => {
      await server.post(`/api/asks/${target}/comment`, { text: "HQ comments on this very question." });
      await until(`!!${card(target)}.querySelector(".ledger")`);
      await expectHeld();
    });
    test("a question above is edited to a longer one", async () => {
      const id = await above();
      await server.post(`/api/asks/${id}/update`, { title: "Edited: now a much longer title than it was before, on several lines", body: LONG });
      await until(`${card(id)}.textContent.includes("Edited: now")`);
      await expectHeld();
    });
    test("the question being typed in is edited: the draft stays", async () => {
      await server.post(`/api/asks/${target}/update`, { title: "This question was edited while you typed" });
      await until(`${card(target)}.textContent.includes("edited while you typed")`);
      await expectHeld();
    });
    test("a strip appears above the list", async () => {
      await ev(`(() => { const s = document.getElementById("stall"); s.textContent = "2 STALLED ITEMS"; s.hidden = false; })()`);
      await expectHeld();
      await ev(`document.getElementById("stall").hidden = true`);
      await expectHeld();
    });
    test("updates, notes, lanes and syncs arrive", async () => {
      await server.post("/api/updates", { lane: "alpha", title: "News" });
      await server.post("/api/notes", { text: "A note." });
      await server.post("/api/lanes", { name: "golf", machine: "local", phase: "waiting", title: "Waiting now" });
      await server.post("/api/sync", {});
      await expectHeld();
    });
    test("every timer goes through its wider and narrower texts", async () => {
      for (const skew of [9 * 60_000, 11 * 60_000, 3600_000, 26 * 3600_000]) {
        await ev(`window.__skew = ${skew}`);
        await Bun.sleep(1200);
        await expectHeld();
      }
    });

    test("a swipe while questions arrive goes as far as the finger went", async () => {
      await ev(`document.activeElement?.blur?.()`);
      await settle();
      const start = await ev(`scrollY`);
      const gesture = page.s("Input.synthesizeScrollGesture", { x: 195, y: 700, yDistance: -1500, gestureSourceType: "touch", speed: 800, preventFling: true });
      for (let i = 0; i < 6; i++) { await newAsk(100 + i); await server.post(`/api/asks/${await above()}/comment`, { text: "HQ has one more thought." }); await Bun.sleep(150); }
      await gesture;
      await settle();
      expect(Math.abs((await ev(`scrollY`)) - start - 1500)).toBeLessThan(600);
      await swipeTo(card(target), 200);
      await tap(`${card(target)}.querySelector("textarea")`);
      await until(`document.activeElement === ${card(target)}.querySelector("textarea")`);
      await settle();
      held = { ...(await reading()), blurs: await ev(`window.__blurs`) };
    });

    test("nothing was built again: the other cards are the same elements", async () => {
      const id = await above();
      await ev(`window.__other = ${card(id)}; window.__added = 0; window.__hudWatch = new MutationObserver((l) => { for (const m of l) window.__added += m.addedNodes.length; }); window.__hudWatch.observe(document.getElementById("hud"), { childList: true });`);
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await newAsk(3);
      await until(`document.querySelectorAll("#hud .ask").length === ${n + 1}`);
      await settle();
      expect(await ev(`window.__other === ${card(id)}`)).toBe(true);
      expect(await ev(`window.__added`)).toBe(1);
      await ev(`window.__hudWatch.disconnect()`);
    });

    test("the pill says how many are new, and tapping it goes to the next of them below you", async () => {
      await ev(`document.activeElement?.blur?.()`);
      await swipeTo(card(target), 200);
      await settle();
      await newAsk(4);
      const b = await newAsk(5);
      await until(`!!${card(b.id)}`);
      await settle();
      const pill = await ev(`(() => { const p = document.getElementById("below"), r = p.getBoundingClientRect(); return { hidden: p.hidden, text: p.textContent, inView: r.top >= 0 && r.bottom <= innerHeight, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === p || p.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; })()`);
      expect(pill.hidden).toBe(false);
      expect(pill.inView).toBe(true);
      expect(pill.hit).toBe(true);
      const newCount = (text: string) => Number(text.match(/(\d+) NEW/)?.[1]);
      expect(newCount(pill.text)).toBeGreaterThanOrEqual(2);
      await tap(`document.getElementById("below")`);
      await until(`(() => { const r = ${card(firstNew)}.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight / 2; })()`, 15_000);
      await until(`(() => { const c = ${card(firstNew)}; const s = c.getBoundingClientRect().top; return new Promise((ok) => setTimeout(() => ok(Math.abs(c.getBoundingClientRect().top - s) < 1), 200)); })()`, 15_000);
      const row = await ev(`document.querySelector(".asknav").getBoundingClientRect().bottom`);
      expect(await ev(`${card(firstNew)}.getBoundingClientRect().top`)).toBeGreaterThanOrEqual(row - 1);
      expect(newCount(await ev(`document.getElementById("below").textContent`))).toBeLessThan(newCount(pill.text));
    });

    test("answering a question leaves you at the next one", async () => {
      const all = await openIds();
      const at = all[all.indexOf(target) + 2], next = all[all.indexOf(at) + 1];
      await swipeTo(card(at), 120);
      await settle();
      const opt = `${card(at)}.querySelector(".opt")`;
      if (await ev(`!!${opt}`)) { await tap(opt); await settle(); }
      await tap(`${card(at)}.querySelector(".send")`);
      await until(`!${card(at)}`);
      await settle();
      const top = await ev(`${card(next)}.getBoundingClientRect().top`);
      const row = await ev(`document.querySelector(".asknav").getBoundingClientRect().bottom`);
      expect(top).toBeGreaterThanOrEqual(row - 1);
      expect(top).toBeLessThan(200);
    });

    test("MORE on a long question keeps the card where it is", async () => {
      const more = `document.querySelector('#hud .ask .more[data-more]')`;
      const id = await ev(`${more}.closest("[data-ask]").dataset.ask`);
      await swipeTo(card(Number(id)), 150);
      await settle();
      const box = await ev(`${card(Number(id))}.getBoundingClientRect().top`);
      await tap(more);
      await until(`${more} && ${card(Number(id))}.querySelector(".more").textContent === "LESS"`);
      await settle();
      expect(Math.abs((await ev(`${card(Number(id))}.getBoundingClientRect().top`)) - box)).toBeLessThan(1);
    });

    test("▼ and ▲ step through the questions and say where you are", async () => {
      await ev(`document.activeElement?.blur?.()`);
      await swipeTo(card(target), 200);
      await settle();
      const pill = `document.getElementById("below").textContent`;
      const at = async () => Number((await ev(pill)).match(/^(\d+) OF (\d+)/)?.[1]);
      const was = await at();
      const total = Number((await ev(pill)).match(/OF (\d+)/)?.[1]);
      expect(total).toBe(await ev(`document.querySelectorAll("#hud .ask").length`));
      await tap(`document.querySelector('.asknav [data-step="1"]')`);
      await until(`document.getElementById("below").textContent.startsWith("${was + 1} OF")`, 15_000);
      await tap(`document.querySelector('.asknav [data-step="-1"]')`);
      await until(`document.getElementById("below").textContent.startsWith("${was} OF")`, 15_000);
      await until(`(() => { const s = scrollY; return new Promise((ok) => setTimeout(() => ok(scrollY === s), 200)); })()`, 15_000);
    });

    test("an answer button at the foot of the screen takes a real tap, and so does the last card's", async () => {
      await ev(`document.activeElement?.blur?.()`);
      const all = await openIds();
      const sendOf = (id: number) => `${card(id)}.querySelector(".send")`;
      for (const id of [all[all.indexOf(target) + 3], all[all.length - 1]]) {
        await ev(`scrollBy(0, ${sendOf(id)}.getBoundingClientRect().bottom - innerHeight + 4)`);
        await settle();
        const hit = await ev(`(() => { const r = ${sendOf(id)}.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2; return { onScreen: r.bottom <= innerHeight, mine: document.elementFromPoint(x, y) === ${sendOf(id)} }; })()`);
        expect(hit).toEqual({ onScreen: true, mine: true });
        if (await ev(`${sendOf(id)}.disabled`)) { await tap(`${card(id)}.querySelector(".opt")`); await settle(); await ev(`scrollBy(0, ${sendOf(id)}.getBoundingClientRect().bottom - innerHeight + 4)`); await settle(); }
        await tap(sendOf(id));
        await until(`!${card(id)}`);
        await settle();
      }
    });

    test("the toast of the last answer does not take the tap meant for what lies under it", async () => {
      const all = await openIds();
      const id = all[all.indexOf(target) + 1];
      await ev(`scrollBy(0, ${card(id)}.getBoundingClientRect().top - 160)`);
      await settle();
      if (await ev(`!!${card(id)}.querySelector(".opt")`)) { await tap(`${card(id)}.querySelector(".opt")`); await settle(); }
      await tap(`${card(id)}.querySelector(".send")`);
      await until(`!!document.querySelector(".toast")`);
      const under = await ev(`(() => { const t = document.querySelector(".toast").getBoundingClientRect(); const h = document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2); return !h.closest(".toast"); })()`);
      expect(under).toBe(true);
      await settle();
    });

    test("answering and scrolling away before the answer comes back stays where you scrolled to", async () => {
      const all = await openIds();
      const id = all[all.indexOf(target) + 1];
      await ev(`scrollBy(0, ${card(id)}.getBoundingClientRect().top - 160)`);
      await settle();
      // The stream is held up, as on a slow connection, while the swipe goes on.
      await page.s("Network.emulateNetworkConditions", { offline: false, latency: 800, downloadThroughput: -1, uploadThroughput: -1 });
      if (await ev(`!!${card(id)}.querySelector(".opt")`)) { await tap(`${card(id)}.querySelector(".opt")`); await settle(); }
      await tap(`${card(id)}.querySelector(".send")`);
      await ev(`scrollBy(0, 3000)`);
      await until(`!${card(id)}`);
      await page.s("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await settle();
      expect(await ev(`Math.abs(${card(all[all.indexOf(id) + 1])}.getBoundingClientRect().top) > 1500`)).toBe(true);
    });

    test("with the list ending above the middle of the screen, what is under it stays put as the list grows", async () => {
      await ev(`scrollBy(0, document.querySelector(".tell").getBoundingClientRect().top - 12)`);
      await settle();
      const top = `document.querySelector(".tell").getBoundingClientRect().top`;
      const before = await ev(top);
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await newAsk(10);
      await until(`document.querySelectorAll("#hud .ask").length === ${n + 1}`);
      await settle();
      expect(Math.abs((await ev(top)) - before)).toBeLessThanOrEqual(1);
      // the row of where you are goes with the list, and stays out of what is under it
      expect(await ev(`document.querySelector(".asknav").getBoundingClientRect().bottom <= document.getElementById("hud").getBoundingClientRect().bottom`)).toBe(true);
    });

    test("typing in TELL HQ under the list, a new question leaves the box where it is", async () => {
      await ev(`scrollBy(0, document.querySelector(".tell").getBoundingClientRect().top - 300)`);
      await settle();
      await tap(`document.getElementById("noteText")`);
      await until(`document.activeElement === document.getElementById("noteText")`);
      await settle();
      const top = `document.getElementById("noteText").getBoundingClientRect().top`;
      const before = await ev(top);
      const n = await ev(`document.querySelectorAll("#hud .ask").length`);
      await newAsk(11);
      await until(`document.querySelectorAll("#hud .ask").length === ${n + 1}`);
      await settle();
      expect(Math.abs((await ev(top)) - before)).toBeLessThanOrEqual(1);
      await ev(`document.activeElement.blur()`);
    });

    test("a reload puts you back on the question you were reading, with the draft", async () => {
      await swipeTo(card(target), 200);
      await settle();
      // As the page itself reloads. Chrome's device emulation drops between beforeunload and pagehide (pointer: coarse goes
      // false, also on a plain page), so the place can be measured in the wrong layout: within 30 px here. Real Mobile
      // Safari, which has no emulation to drop, restored the exact pixel.
      await ev(`setTimeout(() => location.reload(), 0), true`);
      await Bun.sleep(300);
      await until(`document.querySelectorAll("#hud .ask").length > 80 && !!document.getElementById("lastNote")?.innerHTML`);
      await settle();
      expect(await ev(`${card(target)}.querySelector("textarea").value`)).toBe(DRAFT);
      const top = await ev(`${card(target)}.getBoundingClientRect().top`);
      expect(Math.abs(top - 200)).toBeLessThan(30);
    });

    test("reading MESSAGES, an arriving question leaves the tab and the page where they were", async () => {
      await tap(`document.querySelector('[data-qtab="messages"]')`);
      await until(`!document.getElementById("msgs").hidden`);
      await ev(`document.getElementById("msgs").scrollTop = 200`);
      await settle();
      const look = `({ y: Math.round(scrollY), box: Math.round(document.getElementById("msgs").scrollTop), onMessages: !document.getElementById("msgs").hidden })`;
      const before = await ev(look);
      await newAsk(6);
      await Bun.sleep(600);
      expect(await ev(look)).toEqual(before);
    });

    test("reading WORK, an arriving question leaves the tab and the page where they were", async () => {
      await tap(`document.querySelector('[data-qtab="work"]')`);
      await until(`!document.getElementById("work").hidden`);
      await settle();
      const look = `({ y: Math.round(scrollY), onWork: !document.getElementById("work").hidden })`;
      const before = await ev(look);
      await newAsk(7);
      await Bun.sleep(600);
      expect(await ev(look)).toEqual(before);
    });

    test("in an open room, an arriving question leaves the room where it was", async () => {
      await ev(`location.hash = "#room/ope-1"`);
      await until(`!document.getElementById("roomView").hidden`);
      await settle();
      await page.s("Input.synthesizeScrollGesture", { x: 195, y: 600, yDistance: -300, gestureSourceType: "touch", speed: 4000, preventFling: true });
      await settle();
      const look = `({ y: Math.round(scrollY), room: !document.getElementById("roomView").hidden, top: Math.round(document.getElementById("roomView").getBoundingClientRect().top) })`;
      const before = await ev(look);
      await newAsk(8);
      await Bun.sleep(600);
      expect(await ev(look)).toEqual(before);
      await ev(`location.hash = ""`);
      await until(`document.getElementById("roomView").hidden`);
    });

    test("with a lane's drawer open, an arriving question leaves it where it was", async () => {
      await tap(`document.querySelector('[data-qtab="questions"]')`);
      await until(`!document.getElementById("hud").hidden`);
      await settle();
      await ev(`document.querySelector('#hud [data-select]').scrollIntoView({ block: "center", behavior: "instant" })`);
      await settle();
      await tap(`document.querySelector('#hud [data-select="golf"]')`);
      await until(`!document.getElementById("card").hidden && !!document.querySelector("#card .agterm, #card .agnone")`);
      await Bun.sleep(600);
      const look = `({ y: Math.round(scrollY), card: Math.round(document.getElementById("card").scrollTop), open: !document.getElementById("card").hidden })`;
      const before = await ev(look);
      await newAsk(9, { lane: "golf" });
      await Bun.sleep(600);
      expect(await ev(look)).toEqual(before);
    });

    test("no errors", () => { expect(errors).toEqual([]); });
  });
}

// The same rule where the list scrolls itself, with a mouse.
describe.skipIf(!chromeFound)("on a desktop", () => {
  let chrome: Awaited<ReturnType<typeof startChrome>>;
  let server: Awaited<ReturnType<typeof startServer>>;
  let page: Awaited<ReturnType<typeof newSession>>;
  const errors: string[] = [];
  const ids: number[] = [];
  const ev = (e: string) => page.evaluate(e);
  const until = async (expr: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${expr}`);
  };
  const card = (id: number) => `document.querySelector('#hud [data-ask="${id}"]')`;
  const click = async (sel: string) => {
    const { x, y } = await ev(`(() => { const r = ${sel}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  const reading = (id: number) => ev(`(() => { const t = ${card(id)}.querySelector("textarea"); return { top: Math.round(t.getBoundingClientRect().top), same: t === window.__box, focused: document.activeElement === t, value: t.value }; })()`);

  beforeAll(async () => {
    chrome = await startChrome();
    server = await startServer(ROOT);
    for (let i = 1; i <= 20; i++) ids.push((await server.post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf", body: i % 3 ? LONG : undefined })).id);
    await server.post("/api/updates", { lane: "golf", title: "News" });
    page = await newSession(chrome.cdp, errors);
    await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.s("Page.navigate", { url: `${server.base}/` });
    await until(`document.querySelectorAll("#hud .ask").length === 20 && !!document.getElementById("lastNote")?.innerHTML`);
    await Bun.sleep(300);
  }, 30_000);
  afterAll(async () => {
    await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
    await server?.stop();
    await chrome?.close();
  });

  test("arrivals leave the list, the draft and the focus; the pill counts the new ones and goes to them", async () => {
    const t = ids[9];
    await ev(`(() => { const h = document.getElementById("hud"); h.scrollTop += ${card(t)}.getBoundingClientRect().top - h.getBoundingClientRect().top - 40; })()`);
    await click(`${card(t)}.querySelector("textarea")`);
    await until(`document.activeElement === ${card(t)}.querySelector("textarea")`);
    await page.s("Input.insertText", { text: "A desktop draft." });
    await ev(`window.__box = ${card(t)}.querySelector("textarea")`);
    await Bun.sleep(200);
    const held = await reading(t);
    const a = await server.post("/api/asks", { title: "Arrived below", kind: "decision", options: ["A", "B"] });
    await server.post("/api/asks", { title: "Arrived on top", kind: "decision", options: ["A", "B"], due: Date.now() + 3600_000 });
    await server.post(`/api/asks/${ids[2]}/comment`, { text: "A comment above." });
    await server.post(`/api/asks/${ids[1]}/answer`, { answer: "Yes" });
    await until(`!${card(ids[1])} && !!${card(ids[2])}.querySelector(".ledger")`);
    await Bun.sleep(300);
    expect(await reading(t)).toEqual(held);
    expect(await ev(`document.getElementById("below").textContent`)).toContain("2 NEW");
    await click(`document.getElementById("below")`);
    await until(`(() => { const r = ${card(a.id)}.getBoundingClientRect(), h = document.getElementById("hud").getBoundingClientRect(); return r.top >= h.top && r.top < h.bottom; })()`);
  });

  test("the dock under an ask's page keeps its box and focus when a question arrives", async () => {
    const asked = await server.post("/api/asks", { title: "With a page", kind: "decision", options: ["A", "B"], page: "<title>A page</title><h1>Hello</h1>" });
    await until(`!!${card(asked.id)}`);
    await ev(`location.hash = "#page/asks/${asked.id}"`);
    await until(`!!document.querySelector(".askdock textarea")`);
    await click(`document.querySelector(".askdock textarea")`);
    await until(`document.activeElement === document.querySelector(".askdock textarea")`);
    await page.s("Input.insertText", { text: "Typed in the dock." });
    await ev(`window.__dockBox = document.querySelector(".askdock textarea")`);
    await server.post("/api/asks", { title: "Arrived again", kind: "info" });
    await Bun.sleep(500);
    expect(await ev(`document.querySelector(".askdock textarea") === window.__dockBox && document.activeElement === window.__dockBox && window.__dockBox.value`)).toBe("Typed in the dock.");
    await ev(`location.hash = ""`);
  });

  test("no errors", () => { expect(errors).toEqual([]); });
});
