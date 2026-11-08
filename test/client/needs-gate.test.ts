// One gate for every control on a card, walked with real input. After a card on screen closes or changes, by your press or
// someone else's, no press anywhere does anything for a moment, because the list has moved under where you decided. Keys
// always go. A held press says so in a toast and moves nothing; mashing gets through. NEEDS_PLAYWRIGHT adds Playwright's
// WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, HOLD_CLOCK, HOLD_MS, pressIntoHold, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "phone 390", width: 390, height: 844, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), skip: !findChrome() },
  { name: "desktop 1280", width: 1280, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 1280", width: 1280, height: 800, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const SPY = `(() => { if (window.__posts) return; window.__posts = []; window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("toast")) window.__toasts.push(n.textContent); }).observe(document.body, { childList: true }); window.__slow = 0; const wait = (ms) => new Promise((r) => setTimeout(r, ms)), f = window.fetch; window.fetch = async (u, o) => { if (o?.method !== "POST") return f(u, o); window.__posts.push(String(u) + " " + o.body); if (window.__slow && String(u).includes("/asks/")) await wait(window.__slow); return f(u, o); }; })()`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";
const HELD = "HELD: THE LIST JUST CHANGED. THAT PRESS DID NOT COUNT.";
const PAGE = `<!doctype html><html><body style="margin:0"><div style="height:80px">a page</div></body></html>`;

for (const run of RUNS) {
  describe.skipIf(run.skip)(`one gate, ${run.name}`, () => {
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    let k: Awaited<ReturnType<typeof startDesk>> | null = null;
    const ev = (e: string) => k!.ev(e);
    const desk = async (make: (post: any) => Promise<number[]>, focus = false) => {
      await k?.stop();
      k = await startDesk(ROOT, async () => browser.driver, { width: run.width, height: run.height, noAnchor: true, seed: make });
      k.late.go("font.ttf");
      await ev(`try { localStorage.clear(); sessionStorage.clear(); ${focus ? `localStorage.setItem("hq-needs-focus", "1");` : ""} } catch {}`);
      await k.d.reload();
      await k.until(`!!document.getElementById("lastNote")?.innerHTML`);
      // Gone with the reload: Safari has no scroll anchoring, and Chrome's would put right what is walked here.
      await ev(`(() => { const s = document.createElement("style"); s.textContent = "* { overflow-anchor: none !important; }"; document.head.append(s); })()`);
      await ev(SPY);
      await ev(HOLD_CLOCK);
      await Bun.sleep(500);
    };
    const many = (kind: string, title: string, n: number, extra = {}) => async (post: any) => { const ids: number[] = []; for (let i = 1; i <= n; i++) ids.push((await post("/api/asks", { title: `${title} ${i}`, kind, lane: "golf", options: kind === "decision" ? ["Yes", "No"] : undefined, ...extra })).id); return ids; };
    const card = (id: number) => `#hud > .ask[data-ask="${id}"]`;
    const spot = (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`) as Promise<{ x: number; y: number }>;
    const under = ({ x, y }: { x: number; y: number }) => ev(`document.elementFromPoint(${x}, ${y})?.closest("[data-ask]")?.dataset.ask`) as Promise<string>;
    const posted = (id: number) => ev(`window.__posts.filter((u) => u.includes("/asks/${id}/")).length`) as Promise<number>;
    const open = (id: number) => k!.openIds().then((all) => all.includes(id));
    const center = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center", behavior: "instant" })`).then(() => Bun.sleep(120));
    const typeOn = async (id: number, words: string) => {
      await center(`${card(id)} textarea`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(id)} textarea`)})`);
      await k!.until(`document.activeElement?.closest("[data-ask]")?.dataset.ask === "${id}"`);
      await k!.d.type(words);
    };
    const quiet = () => k!.until(`!document.documentElement.classList.contains("unready")`);
    const refused = () => ev(`window.__toasts.filter((t) => t === ${JSON.stringify(HELD)}).length`) as Promise<number>;
    // Too busy a machine to land the press in time shows nothing about the hold, and the walk stops there.
    const heldPress = async (at: { x: number; y: number }, ms = 100) => {
      const landed = await pressIntoHold(k!, at, ms);
      if (landed >= HOLD_MS) console.log(`LATE: aimed ${ms} ms into the hold, landed at ${Math.round(landed)} ms: this walk shows nothing`);
      return landed < HOLD_MS;
    };
    const pickedOn = (id: number) => ev(`document.querySelectorAll(${JSON.stringify(`${card(id)} .opt.sel`)}).length`) as Promise<number>;
    // SEND on the card in the middle of the screen: its answer closes it, and the next one comes up in its place.
    const answerOne = async (id: number) => {
      await center(`${card(id)} .send`);
      const at = await spot(`${card(id)} .send`);
      await k!.d.click(at.x, at.y);
      await k!.until(`!document.querySelector(${JSON.stringify(card(id))})`);
      return at;
    };
    beforeAll(async () => { browser = await run.make(run.width, run.height); }, 60_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    test("DISCARD pressed again and again takes only the card you pressed it on", async () => {
      await desk(many("decision", "Question", 8));
      const ids = k!.ids.slice(0, 5);
      for (const id of ids) await typeOn(id, `Words on ${id}.`);
      await ev(`document.activeElement.blur()`);
      await k!.d.goto("about:blank");
      for (const id of ids) await k!.server.post(`/api/asks/${id}/withdraw`, { reason: "gone" });
      await k!.d.goto(`${k!.late.base}/`);
      await k!.until(`document.querySelectorAll("#hud > .ask.left").length === 5`);
      await ev(SPY);
      await ev(HOLD_CLOCK);
      await Bun.sleep(400);
      // A reload keeps your place until you touch the page: a scroll from here alone would be undone.
      await k!.d.wheel(run.width / 2, run.height / 2, 1);
      await Bun.sleep(150);
      if (await ev(`!!document.querySelector("[data-left-open]")`)) { await center("[data-left-open]"); await k!.clickEl(`document.querySelector("[data-left-open]")`); await Bun.sleep(200); }
      await ev(`document.querySelector("#hud > .ask.left [data-left-drop]").scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(150);
      const at = await spot("#hud > .ask.left [data-left-drop]");
      await k!.d.click(at.x, at.y);
      for (const ms of [100, 250]) if (!await heldPress(at, ms)) return;
      await Bun.sleep(100);
      expect(await ev(`document.querySelectorAll("#hud > .ask.left").length`)).toBe(4);
    });

    test("two cards closed in place: DISCARD on the first, pressed again, leaves the second's words", async () => {
      await desk(many("decision", "Question", 4));
      const [a, b] = k!.ids;
      await typeOn(a, "Words on the first.");
      await typeOn(b, "Words on the second.");
      await ev(`document.activeElement.blur()`);
      await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
      await k!.server.post(`/api/asks/${b}/withdraw`, { reason: "gone" });
      await k!.until(`document.querySelectorAll("#hud > .ask.left").length === 2`);
      await quiet();
      await center(`${card(a)} [data-left-drop]`);
      const at = await spot(`${card(a)} [data-left-drop]`);
      await k!.d.click(at.x, at.y);
      await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
      if (!await heldPress(at, 200)) return;
      await Bun.sleep(200);
      expect(await ev(`!!document.querySelector(${JSON.stringify(card(b))})`)).toBe(true);
    });

    describe("a hold from your own press", () => {
      for (const ms of [150, 300]) test(`answer one card, then ${ms} ms on press where the next one's DONE stood: the list has moved up, and the card now there is not answered`, async () => {
        await desk(many("action", "Do", 12));
        const [a, b, c] = k!.ids;
        // At the top of the list nothing can scroll to follow: each card comes up by exactly one.
        const meant = await spot(`${card(b)} .send`), first = await spot(`${card(a)} .send`);
        await k!.d.click(first.x, first.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        expect(await under(meant)).toBe(String(c));
        if (!await heldPress(meant, ms)) return;
        await Bun.sleep(250);
        expect(await posted(c)).toBe(0);
        expect(await posted(b)).toBe(0);
        expect(await refused()).toBe(1);
      });

      test("from 400 ms on a press goes: aimed before the list moved, it answers the card now there", async () => {
        await desk(many("action", "Do", 12));
        const [a, b, c] = k!.ids;
        const meant = await spot(`${card(b)} .send`), first = await spot(`${card(a)} .send`);
        await k!.d.click(first.x, first.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        await quiet();
        await k!.d.click(meant.x, meant.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(c))})`);
        expect(await posted(c)).toBe(1);
        expect(await posted(b)).toBe(0);
        expect(await refused()).toBe(0);
      });

      for (const ms of [150, 300]) test(`DISCARD one card's words, then ${ms} ms on press where the next DISCARD stood: the words on the card now there stay`, async () => {
        await desk(many("action", "Do", 6));
        const [a, b, c, d] = k!.ids;
        for (const id of [a, b, c, d]) await typeOn(id, `Words on ${id}.`);
        await ev(`document.activeElement.blur(); scrollTo(0, 0); document.getElementById("hud").scrollTop = 0`);
        await Bun.sleep(200);
        for (const id of [a, b, c, d]) { await k!.server.post(`/api/asks/${id}/withdraw`, {}); await Bun.sleep(60); }
        await k!.until(`document.querySelectorAll("#hud > .ask.left").length === 4`);
        await quiet();
        // Near its top: at 1280 the list is cut off just past the middle of this button.
        const first = await spot(`${card(a)} [data-left-drop]`), meant = await ev(`(() => { const r = document.querySelector(${JSON.stringify(`${card(b)} [data-left-drop]`)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 5 }; })()`) as { x: number; y: number };
        await k!.d.click(first.x, first.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        expect(await under(meant)).toBe(String(c));
        if (!await heldPress(meant, ms)) return;
        await Bun.sleep(250);
        expect(await ev(`[...document.querySelectorAll("#hud > .ask.left")].map((c) => Number(c.dataset.ask))`)).toEqual([b, c, d]);
        expect(await refused()).toBe(1);
      });

      // On a phone the foot of the page is past the list, and no DONE but the last is in reach.
      for (const ms of [150, 300]) test.skipIf(run.width < 1151)(`the last card answered at the foot, then ${ms} ms on a press where the one above stood: the cards came down, and the one now under the press is not answered`, async () => {
        await desk(many("action", "Do", 10));
        const last = k!.ids.at(-1)!, above = k!.ids.at(-2)!;
        await ev(`(async () => { const { pageScrolls } = await import("/src/client/core/dom.js"); const h = document.getElementById("hud"); if (pageScrolls()) scrollTo(0, document.documentElement.scrollHeight - innerHeight); else h.scrollTop = h.scrollHeight - h.clientHeight; })()`);
        await Bun.sleep(350);
        const first = await spot(`${card(last)} .send`), meant = await spot(`${card(above)} .send`);
        const before = await k!.openIds();
        await k!.d.click(first.x, first.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(last))})`);
        expect(await under(meant)).toBe(String(k!.ids.at(-3)));
        if (!await heldPress(meant, ms)) return;
        await Bun.sleep(250);
        const after = await k!.openIds();
        expect(before.filter((id) => !after.includes(id))).toEqual([last]);
        expect(await refused()).toBe(1);
      });

      test("the same press again cannot pick an answer you never read, on a card whose option came under it", async () => {
        await desk(async (post) => [...await many("action", "Do", 2)(post), (await post("/api/asks", { title: "Question", kind: "decision", options: ["An option as wide as the card, so that the same press lands on it, whichever width this is"], lane: "golf" })).id, ...await many("action", "After", 4)(post)]);
        const [, a, b] = k!.ids;
        await center(`${card(a)} .send`);
        // The option stands where SEND stood: the distance between them goes on the card above it.
        await ev(`(() => { const send = document.querySelector(${JSON.stringify(`${card(a)} .send`)}).getBoundingClientRect(), own = document.querySelector(${JSON.stringify(card(a))}).getBoundingClientRect(), opt = document.querySelector(${JSON.stringify(`${card(b)} .opt`)}).getBoundingClientRect(), next = document.querySelector(${JSON.stringify(card(b))}).getBoundingClientRect(), gap = (send.top + send.height / 2 - own.top) - (opt.top + opt.height / 2 - next.top); document.querySelector(${JSON.stringify(`${card(b)} h3`)}).style.marginBottom = (parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(`${card(b)} h3`)})).marginBottom) + gap) + "px"; })()`);
        await Bun.sleep(100);
        await center(`${card(a)} .send`);
        const at = await answerOne(a);
        expect(await ev(`document.elementFromPoint(${at.x}, ${at.y})?.closest(".opt")?.closest("[data-ask]")?.dataset.ask ?? null`)).toBe(String(b));
        if (!await heldPress(at)) return;
        await Bun.sleep(150);
        expect(await pickedOn(b)).toBe(0);
        expect(await ev(`document.querySelector(${JSON.stringify(card(b))}).dataset.mark ?? ""`)).toBe("");
        expect(await refused()).toBe(1);
        await quiet();
        await k!.d.click(at.x, at.y);
        await k!.until(`document.querySelectorAll(${JSON.stringify(`${card(b)} .opt.sel`)}).length === 1`);
      });

      test("a held press does not make the hold longer: it ends 400 ms from the change, however many presses", async () => {
        await desk(many("action", "Do", 12), true);
        const first = k!.ids[0], next = k!.ids[1];
        const at = await spot("#hud > .ask.on .send");
        await k!.d.click(at.x, at.y);
        await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${next}"`);
        if (!await heldPress(at, 300)) return;
        expect(await posted(next)).toBe(0);
        await quiet();
        // Extended, it would run to 700 ms from the change.
        expect(await ev(`window.__freeAt - window.__heldAt`)).toBeLessThan(600);
        await k!.d.click(at.x, at.y);
        await k!.until(`window.__posts.some((u) => u.includes("/asks/${next}/"))`);
        expect(await posted(next)).toBe(1);
        expect(await posted(first)).toBe(1);
      });

      test("an answer given by a key: a press still waits, the list having moved all the same", async () => {
        await desk(many("decision", "Question", 8));
        const [a, b] = k!.ids;
        await typeOn(a, "By key.");
        await k!.d.key("Enter", true);
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        if (!await heldPress(await spot(`${card(b)} .opt`))) return;
        await Bun.sleep(100);
        expect(await pickedOn(b)).toBe(0);
        expect(await refused()).toBe(1);
      });
    });

    describe("a hold from someone else's close", () => {
      test("a card someone else closed: what moved under your finger does not answer, and it says so", async () => {
        await desk(many("action", "Do", 20));
        const [gone, next] = [k!.ids[7], k!.ids[8]];
        await center(`${card(gone)} .send`);
        const at = await spot(`${card(gone)} .send`);
        await k!.server.post(`/api/asks/${gone}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(gone))})`);
        expect(await under(at)).toBe(String(next));
        if (!await heldPress(at)) return;
        await Bun.sleep(200);
        expect(await posted(next)).toBe(0);
        expect(await open(next)).toBe(true);
        expect(await refused()).toBe(1);
        await quiet();
        await k!.d.click(at.x, at.y);
        await k!.until(`!document.querySelector(${JSON.stringify(card(next))})`);
        expect(await posted(next)).toBe(1);
      });

      test("a press on another card waits too", async () => {
        await desk(many("action", "Do", 20));
        const [gone, next, after] = [k!.ids[7], k!.ids[8], k!.ids[9]];
        await center(`${card(gone)} .send`);
        await k!.server.post(`/api/asks/${gone}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(gone))})`);
        if (!await heldPress(await spot(`${card(after)} .send`))) return;
        await Bun.sleep(150);
        expect(await posted(after)).toBe(0);
        expect(await posted(next)).toBe(0);
        expect(await refused()).toBe(1);
      });

      test("a card that turns closed under your finger: the press meant for it discards nothing", async () => {
        await desk(many("decision", "Question", 4));
        const [a] = k!.ids;
        await typeOn(a, "Words that stay.");
        await ev(`document.activeElement.blur()`);
        await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
        await k!.until(`!!document.querySelector(${JSON.stringify(`${card(a)} [data-left-drop]`)})`);
        if (!await heldPress(await spot(`${card(a)} [data-left-drop]`))) return;
        await Bun.sleep(100);
        expect(await ev(`document.querySelector(${JSON.stringify(`${card(a)} textarea`)})?.value`)).toBe("Words that stay.");
        expect(await refused()).toBe(1);
        await quiet();
        await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} [data-left-drop]`)})`);
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
      });

      test("a card closed off the screen starts no hold", async () => {
        await desk(many("action", "Do", 20));
        await center(`${card(k!.ids[2])} .send`);
        await k!.server.post(`/api/asks/${k!.ids[18]}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(k!.ids[18]))})`);
        expect(await ev(`document.documentElement.classList.contains("unready")`)).toBe(false);
      });
    });

    describe("keys go free", () => {
      test("Ctrl+Enter in a whole hold sends, with the words in the box", async () => {
        await desk(many("action", "Do", 12));
        const [a, b] = k!.ids;
        await typeOn(b, "Mine.");
        await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        if (!await ev(`document.documentElement.classList.contains("unready")`)) return;
        await k!.d.key("Enter", true);
        await k!.until(`!document.querySelector(${JSON.stringify(card(b))})`);
        expect(await ev(`window.__posts.find((u) => u.includes("/asks/${b}/"))`)).toContain("Mine.");
        expect(await refused()).toBe(0);
      });

      test("Enter on a focused DONE in a whole hold goes", async () => {
        await desk(many("action", "Do", 12));
        const [a, b] = k!.ids;
        await center(`${card(a)} .send`);
        await ev(`document.querySelector(${JSON.stringify(`${card(b)} .send`)}).focus({ preventScroll: true })`);
        await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
        if (!await ev(`document.documentElement.classList.contains("unready")`)) return;
        await k!.d.key("Enter");
        await k!.until(`!document.querySelector(${JSON.stringify(card(b))})`);
        expect(await refused()).toBe(0);
      });
    });

    describe("what a held press says", () => {
      test("one toast, true on a card that did not move: nothing else on the page changes", async () => {
        await desk(many("action", "Do", 6), true);
        const next = k!.ids[1], at = await spot("#hud > .ask.on .send");
        await k!.d.click(at.x, at.y);
        await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${next}"`);
        const tops = () => ev(`[...document.querySelector("#hud > .ask.on").children].map((e) => Math.round(e.getBoundingClientRect().top))`);
        const was = await tops(), height = await ev(`document.querySelector("#hud > .ask.on").getBoundingClientRect().height`);
        if (!await heldPress(at, 150)) return;
        await Bun.sleep(80);
        expect(await ev(`window.__toasts.at(-1)`)).toBe(HELD);
        expect(await ev(`!!document.querySelector(".heldnote")`)).toBe(false);
        expect(await tops()).toEqual(was);
        expect(await ev(`document.querySelector("#hud > .ask.on").getBoundingClientRect().height`)).toBe(height);
        const send = `document.querySelector("#hud > .ask.on .send")`;
        expect(await ev(`${send}.getAttribute("aria-disabled")`)).toBe(null);
        expect(await ev(`getComputedStyle(${send}).opacity`)).toBe("1");
      });

      test("the toast takes no press: a tap on it lands on what is under it", async () => {
        await desk(many("action", "Do", 6), true);
        const next = k!.ids[1], at = await spot("#hud > .ask.on .send");
        await k!.d.click(at.x, at.y);
        await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${next}"`);
        await k!.d.click(at.x, at.y);
        await k!.until(`!!document.querySelector(".toast")`);
        const inside = await ev(`(() => { const t = [...document.querySelectorAll(".toast")].at(-1), r = t.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && t.contains(hit); })()`);
        expect(inside).toBe(false);
      });
    });

    describe("the foot of the list", () => {
      const room = (left: number) => ev(`(async () => { const { pageScrolls } = await import("/src/client/core/dom.js"); const h = document.getElementById("hud"); if (pageScrolls()) scrollTo(0, document.documentElement.scrollHeight - innerHeight - ${left}); else h.scrollTop = h.scrollHeight - h.clientHeight - ${left}; })()`);
      const onScreenNow = () => ev(`[...document.querySelectorAll("#hud > .ask .send")].find((b) => { const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit && b.contains(hit); })?.closest("[data-ask]").dataset.ask`) as Promise<string>;

      test("a card off the screen above closes within a card of the foot: the press answers the card you meant", async () => {
        await desk(many("action", "Do", 12));
        const [first, second] = k!.ids;
        const pitch = await ev(`document.querySelector(${JSON.stringify(card(second))}).getBoundingClientRect().top - document.querySelector(${JSON.stringify(card(first))}).getBoundingClientRect().top`) as number;
        // The page ends a little short of a card under you: the browser has to shorten the scroll when it closes.
        await room(pitch - 3);
        await Bun.sleep(350);
        const meant = await onScreenNow();
        const at = await spot(`${card(Number(meant))} .send`);
        await k!.server.post(`/api/asks/${first}/withdraw`, { reason: "gone" });
        await k!.until(`!document.querySelector(${JSON.stringify(card(first))})`);
        await Bun.sleep(150);
        const before = await k!.openIds();
        await k!.d.click(at.x, at.y);
        await Bun.sleep(300);
        const after = await k!.openIds();
        expect(before.filter((id) => !after.includes(id))).toEqual([Number(meant)]);
        expect(await refused()).toBe(0);
      });

      // Under a phone's list stands more than a screen of other things: this far down no other card's control is in reach.
      test.skipIf(run.width < 1151)("what you read is pushed down and there is no room to put it back: every control waits", async () => {
        const WORDS = Array.from({ length: 12 }, (_, i) => `Line ${i} of a long question.`).join("\n\n");
        await desk(async (post) => [...await many("action", "Do", 12)(post), (await post("/api/asks", { title: "Long", kind: "action", body: WORDS, lane: "golf" })).id]);
        const last = k!.ids.at(-1)!;
        const tall = await ev(`document.querySelector(${JSON.stringify(`${card(last)} .text`)}).getBoundingClientRect().height`) as number;
        expect(tall).toBeGreaterThan(120);
        await room(tall - 60);
        await Bun.sleep(350);
        const meant = await ev(`[...document.querySelectorAll("#hud > .ask .send")].filter((b) => b.closest("[data-ask]").dataset.ask !== "${last}").findLast((b) => { const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit && b.contains(hit); })?.closest("[data-ask]").dataset.ask`) as string;
        const at = await spot(`${card(Number(meant))} .send`);
        await k!.server.post(`/api/asks/${last}/update`, { body: "Short." });
        await k!.until(`document.querySelector(${JSON.stringify(`${card(last)} .text`)}).textContent.includes("Short.")`);
        const moved = await spot(`${card(Number(meant))} .send`);
        expect(moved.y - at.y).toBeGreaterThan(2);
        if (!await heldPress(moved)) return;
        await Bun.sleep(150);
        expect(await posted(Number(meant))).toBe(0);
        expect(await refused()).toBe(1);
      });
    });

    test("NOT YET in the list moves nothing, so it holds nothing: DONE on another card goes at once", async () => {
      await desk(many("action", "Do", 6));
      const [a, b] = k!.ids;
      await center(`${card(a)} .notyet`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} .notyet`)})`);
      await k!.until(`window.__posts.some((u) => u.includes("/asks/${a}/notyet"))`);
      await Bun.sleep(200);
      expect(await ev(`document.documentElement.classList.contains("unready")`)).toBe(false);
      await center(`${card(b)} .send`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(b)} .send`)})`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(b))})`);
    });

    test("one answer per card in flight: DONE takes the card away at once, so NOT YET cannot follow it", async () => {
      await desk(many("action", "Do", 4));
      const [a] = k!.ids;
      await ev(`window.__slow = 700`);
      await center(`${card(a)} .send`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} .send`)})`);
      expect(await ev(`!document.querySelector(${JSON.stringify(card(a))})`)).toBe(true);
      await Bun.sleep(900);
      await ev(`window.__slow = 0`);
      expect(await posted(a)).toBe(1);
    });

    test("NOT YET's reply clears what it sent, and what you typed since stays", async () => {
      await desk(many("action", "Do", 4));
      const [a] = k!.ids;
      await typeOn(a, "First part");
      await ev(`window.__slow = 600`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} .notyet`)})`);
      await Bun.sleep(100);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} textarea`)})`);
      await k!.until(`document.activeElement?.closest("[data-ask]")?.dataset.ask === "${a}"`);
      await ev(`(() => { const t = document.activeElement; t.setSelectionRange(t.value.length, t.value.length); })()`);
      await k!.d.type(" and what I typed since");
      await k!.until(`window.__posts.some((u) => u.includes("/asks/${a}/notyet"))`);
      await Bun.sleep(900);
      await ev(`window.__slow = 0`);
      expect(await ev(`window.__posts.find((u) => u.includes("/asks/${a}/notyet"))`)).toContain('"First part"');
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(a)} textarea`)}).value`)).toBe("and what I typed since");
    });

    test("NOT YET's reply clears the picture it sent, and one attached since stays", async () => {
      await desk(many("action", "Do", 4));
      const [a] = k!.ids;
      const pictures = () => ev(`document.querySelectorAll(${JSON.stringify(`${card(a)} [data-composer] .chip`)}).length`) as Promise<number>;
      const attach = (name: string) => ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0)), t = new DataTransfer(); t.items.add(new File([bytes], ${JSON.stringify(name)}, { type: "image/png" })); const i = document.querySelector(${JSON.stringify(`${card(a)} input[type=file]`)}); i.files = t.files; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await attach("first.png");
      await k!.until(`document.querySelectorAll(${JSON.stringify(`${card(a)} [data-composer] .chip`)}).length === 1`);
      await Bun.sleep(300);
      await ev(`window.__slow = 1500`);
      await center(`${card(a)} .notyet`);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(a)} .notyet`)})`);
      await Bun.sleep(100);
      await attach("second.png");
      await k!.until(`document.querySelectorAll(${JSON.stringify(`${card(a)} [data-composer] .chip`)}).length === 2`);
      await k!.until(`window.__posts.some((u) => u.includes("/asks/${a}/notyet"))`);
      await k!.until(`!document.querySelector(${JSON.stringify(`${card(a)} .notyet`)}).disabled`);
      await ev(`window.__slow = 0`);
      await Bun.sleep(150);
      const note = await ev(`window.__posts.find((u) => u.includes("/asks/${a}/notyet"))`) as string;
      expect(note.split("[image:").length - 1).toBe(1);
      expect(await pictures()).toBe(1);
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(a)}`)}).dataset.mark ?? ""`)).toContain("DRAFT");
    });

    test.skipIf(run.width < 1151)("the dock says the same, and the toast takes no press from it", async () => {
      await desk(async (post) => [...await many("action", "Do", 4)(post), (await post("/api/asks", { title: "With a page", kind: "action", body: PAGE, lane: "golf" })).id]);
      const page = k!.ids.at(-1)!, first = k!.ids[0];
      await ev(`location.hash = "#page/asks/${page}", true`);
      await k!.until(`!!document.querySelector(".ask.dock .send")`);
      await Bun.sleep(400);
      await ev(`import("/src/client/core/dom.js").then((m) => m.toast("A toast near the dock"))`);
      expect(await ev(`getComputedStyle(document.querySelector(".toast")).pointerEvents`)).toBe("none");
      await k!.server.post(`/api/asks/${first}/withdraw`, { reason: "gone" });
      await k!.until(`!document.querySelector(${JSON.stringify(card(first))})`);
      if (!await heldPress(await spot(".ask.dock .send"))) return;
      await Bun.sleep(150);
      expect(await posted(page)).toBe(0);
      expect(await refused()).toBe(1);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED|Failed to fetch/.test(e))).toEqual([]));
  });
}
