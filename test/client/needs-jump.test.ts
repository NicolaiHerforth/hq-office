// Going somewhere from a question and coming back, walked with real input in both modes: a lane's tag opens its drawer
// and leaves your place and the floor alone; ANSWER IN NEEDS YOU lands on that very question; following NEW or a jump
// leaves a way back; a card shows that it is new or holds your draft. And on a desktop no name pushes SEND out of the
// panel. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const LONG_LANE = `${"averyveryverylonglanename".repeat(5)}-and-then-the-rest-of-it`;
const RUNS = [
  { name: "desktop 1440", width: 1440, height: 900, noAnchor: true, make: chromeDriver, touch: false, skip: !findChrome() },
  { name: "desktop 1280", width: 1280, height: 800, noAnchor: true, make: chromeDriver, touch: false, skip: !findChrome() },
  { name: "phone 390", width: 390, height: 844, noAnchor: true, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), touch: true, skip: !findChrome() },
  { name: "WebKit 1440", width: 1440, height: 900, noAnchor: true, make: webkitDriver, touch: false, skip: !process.env.NEEDS_PLAYWRIGHT },
];

for (const run of RUNS) {
  describe.skipIf(run.skip)(`going and coming back, ${run.name}`, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    const crm: number[] = [];
    let longId = 0;
    const ev = (e: string) => k.ev(e);
    const cardQ = (id: number) => `document.querySelector('#hud > .ask[data-ask="${id}"]')`;
    const top = (id: number) => ev(`${cardQ(id)}.getBoundingClientRect().top`) as Promise<number>;
    const scope = () => ev(`sessionStorage.getItem("hq-scope")`);
    const pill = () => ev(`document.getElementById("below").textContent`) as Promise<string>;
    const click = (sel: string) => k.clickEl(sel);
    const button = (sel: string) => `document.querySelector(${JSON.stringify(sel)})`;
    const closeDrawer = async () => { await ev(`document.querySelector("[data-card-close]").scrollIntoView({ block: "center", behavior: "instant" })`); await click(button("[data-card-close]")); await k.until(`document.getElementById("card").hidden`); };

    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      k = await startDesk(ROOT, async () => browser.driver, { ...run, floors: true });
      k.late.go("font.ttf"); k.late.go("late-above.svg"); k.late.go("late-own.svg");
      await k.server.post("/api/lanes", { name: "crm-search", machine: "local", floor: "crm" });
      await k.server.post("/api/lanes", { name: LONG_LANE, machine: "local" });
      for (let i = 0; i < 4; i++) crm.push((await k.server.post("/api/asks", { title: `On the other floor ${i}`, kind: "decision", options: ["Yes", "No"], lane: "crm-search" })).id);
      longId = (await k.server.post("/api/asks", { title: "A question from a lane with a very long name", kind: "decision", options: ["Yes", "No"], lane: LONG_LANE })).id;
      for (let i = 0; i < 6; i++) await k.server.post("/api/asks", { title: `Under them ${i}`, kind: "decision", options: ["Yes", "No"], lane: "alpha" });
      await k.until(`document.querySelectorAll("#hud > .ask").length >= 55`);
      await k.d.reload();
      await k.until(`document.querySelectorAll("#hud > .ask").length >= 55`);
      await Bun.sleep(400);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    test.skipIf(run.touch)("no lane's name pushes SEND or the title out of the panel", async () => {
      const cut = await ev(`[...document.querySelectorAll("#hud > .ask")].filter((c) => { const h = document.getElementById("hud").getBoundingClientRect(); return [...c.querySelectorAll(".send, h3, .tag.lane")].some((e) => e.getBoundingClientRect().right > h.right + 1); }).length`);
      expect(cut).toBe(0);
      expect(await ev(`document.getElementById("hud").scrollWidth <= document.getElementById("hud").clientWidth + 1`)).toBe(true);
    });

    test.skipIf(run.touch)("nor inside a floor, where a card shows no floor tag", async () => {
      await ev(`import("/src/client/core/scope.js").then((m) => m.enter("hq"))`);
      await k.until(`!!${cardQ(longId)} && !document.querySelector("#hud > .ask .fswatch")`);
      await Bun.sleep(150);
      const cut = await ev(`[...document.querySelectorAll("#hud > .ask")].filter((c) => { const h = document.getElementById("hud").getBoundingClientRect(); return [...c.querySelectorAll(".send, h3, .tag.lane")].some((e) => e.getBoundingClientRect().right > h.right + 1); }).length`);
      const wide = await ev(`document.getElementById("hud").scrollWidth - document.getElementById("hud").clientWidth`);
      await ev(`import("/src/client/core/scope.js").then((m) => m.toBuilding())`);
      await k.until(`!!document.querySelector("#hud > .ask .fswatch")`);
      expect(cut).toBe(0);
      expect(wide).toBeLessThanOrEqual(1);
    });

    test("a lane's name stays on one line, cut with an ellipsis, the whole name on hold", async () => {
      const tag = await ev(`(() => { const t = ${cardQ(longId)}.querySelector(".tag.lane"), r = t.getBoundingClientRect(); return { lines: Math.round((r.height) / 100), title: t.title, nowrap: getComputedStyle(t).whiteSpace, overflow: getComputedStyle(t).textOverflow, inside: r.right <= ${cardQ(longId)}.getBoundingClientRect().right }; })()`);
      expect(tag).toEqual({ lines: 0, title: LONG_LANE, nowrap: "nowrap", overflow: "ellipsis", inside: true });
    });

    test("a lane's chip anywhere else still enters its floor: a room's chip does", async () => {
      await k.server.post("/api/rooms", { slug: "chips", title: "Chips", owner: "crm-search" });
      const before = await ev(`sessionStorage.getItem("hq-scope")`);
      await k.until(`import("/src/client/core/state.js").then((m) => m.S.rooms?.some((r) => r.slug === "chips"))`);
      await ev(`location.hash = "#room/chips", true`);
      const chip = `[...document.querySelectorAll('.roomview [data-select="crm-search"]')].find((e) => e.getBoundingClientRect().height > 0)`;
      await k.until(`!document.getElementById("roomView").hidden`);
      if (run.touch) { await k.clickEl(`document.querySelector('[data-ptab="brief"]')`); await Bun.sleep(200); }
      await k.until(`!!${chip}`);
      await Bun.sleep(200);
      await ev(`${chip}.scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(100);
      await k.clickEl(chip);
      await k.until(`JSON.parse(sessionStorage.getItem("hq-scope") ?? "{}").floor === "crm"`);
      await ev(`location.hash = "", true`);
      await k.until(`document.getElementById("roomView").hidden`);
      await ev(`(async () => { const m = await import("/src/client/core/scope.js"), r = await import("/src/client/room/input.js"); m.toBuilding?.(); r.select(null); })()`);
      await k.until(`sessionStorage.getItem("hq-scope") === ${JSON.stringify(before)} || !JSON.parse(sessionStorage.getItem("hq-scope") ?? "{}").floor`);
      await Bun.sleep(300);
    });

    test("a question's lane tag on the stage's dock opens the drawer; the floor stays", async () => {
      const PAGE = `<!doctype html><html><body style="margin:0"><div style="height:80px">a page</div></body></html>`;
      const id = (await k.server.post("/api/asks", { title: "On the other floor, with a page", kind: "decision", options: ["Yes", "No"], body: PAGE, lane: "crm-search" })).id;
      const before = await scope();
      await ev(`location.hash = "#page/asks/${id}", true`);
      await k.until(`!!document.querySelector(".ask.dock .tag.lane")`);
      await Bun.sleep(300);
      await ev(`document.querySelector(".ask.dock .tag.lane").scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(100);
      await click(button(".ask.dock .tag.lane"));
      await k.until(`!document.getElementById("card").hidden`);
      expect(await scope()).toBe(before);
      await closeDrawer();
      await ev(`location.hash = "", true`);
      await k.until(`!document.querySelector(".ask.dock")`);
      await k.server.post(`/api/asks/${id}/withdraw`, { reason: "gone" });
      await k.until(`!${cardQ(id)}`);
      await Bun.sleep(300);
    });

    test("tapping a card's lane tag opens the drawer; the floor, the list and your place stay; closing it changes nothing", async () => {
      const n = await k.count();
      await k.wheelTo(crm[2], 40);
      await Bun.sleep(250);
      const was = await top(crm[2]), s = await scope();
      await click(`${cardQ(crm[2])}.querySelector(".tag.lane")`);
      await k.until(`!document.getElementById("card").hidden`);
      await Bun.sleep(400);
      expect(await scope()).toBe(s);
      expect(await k.count()).toBe(n);
      expect(Math.abs((await top(crm[2])) - was)).toBeLessThanOrEqual(2);
      await closeDrawer();
      await Bun.sleep(300);
      expect(await scope()).toBe(s);
      expect(await k.count()).toBe(n);
      expect(Math.abs((await top(crm[2])) - was)).toBeLessThanOrEqual(2);
    });

    test("ANSWER IN NEEDS YOU lands on that question, not the lane's first; BACK returns", async () => {
      await k.wheelTo(k.ids[3], 40);
      await Bun.sleep(250);
      await click(`${cardQ(k.ids[3])}.querySelector(".tag.lane")`);
      await k.until(`!document.getElementById("card").hidden`);
      await closeDrawer();
      await k.wheelTo(crm[0], 40);
      await Bun.sleep(250);
      await click(`${cardQ(crm[0])}.querySelector(".tag.lane")`);
      await k.until(`document.querySelectorAll(".agjump").length === 4`);
      // The list moves on behind a desktop's drawer; a phone's sheet lies over it.
      const from = run.touch ? crm[0] : k.ids[3];
      if (!run.touch) { await k.wheelTo(from, 40); await Bun.sleep(600); }
      await ev(`document.querySelectorAll(".agjump")[2].scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(100);
      await click(`document.querySelectorAll(".agjump")[2]`);
      await k.until(`(() => { const r = ${cardQ(crm[2])}.getBoundingClientRect(), h = document.getElementById("hud").getBoundingClientRect(), a = innerWidth < 1151 ? 56 : h.top, b = innerWidth < 1151 ? innerHeight : h.bottom; return r.top >= a - 1 && r.top < b - 40; })()`);
      expect(await ev(`${cardQ(crm[2])}.classList.contains("flash")`)).toBe(true);
      if (!(await ev(`document.getElementById("card").hidden`))) await closeDrawer();
      await k.until(`!document.querySelector(".askback").hidden`);
      expect(await ev(`document.querySelector(".askback").textContent`)).toMatch(/BACK TO \d+/);
      await click(button(".askback"));
      await k.until(`(() => { const r = ${cardQ(from)}.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })()`);
      await k.until(`document.querySelector(".askback").hidden`);
    });

    test("in FOCUS: the same question comes on the stage; BACK returns to where you were", async () => {
      await k.wheelTo(k.ids[5], 30);
      await Bun.sleep(250);
      await click(button(".asknav [data-focus]"));
      await k.until(`document.getElementById("hud").classList.contains("focus")`);
      const was = await ev(`document.querySelector("#hud > .ask.on").dataset.ask`);
      await click(`${button("#hud > .ask.on")}.querySelector(".tag.lane")`);
      await k.until(`!document.getElementById("card").hidden`);
      expect(await ev(`document.querySelector("#hud > .ask.on").dataset.ask`)).toBe(was);
      await closeDrawer();
      await k.server.post("/api/asks", { title: "New while in focus", kind: "decision", options: ["Yes", "No"], lane: "crm-search" });
      await k.until(`/1 NEW/.test(document.getElementById("below").textContent)`);
      await click(button("#below"));
      await k.until(`document.querySelector("#hud > .ask.on").dataset.ask !== "${was}"`);
      expect(await ev(`getComputedStyle(document.querySelector("#hud > .ask.on > .meta"), "::before").content`)).toBe('"NEW"');
      await k.until(`!document.querySelector(".askback").hidden`);
      await click(button(".askback"));
      await k.until(`document.querySelector("#hud > .ask.on").dataset.ask === "${was}"`);
    });

    test("a card holding your words says DRAFT, and BACK says so too; a new card says NEW once you are on it", async () => {
      const a = await ev(`Number(document.querySelector("#hud > .ask.on").dataset.ask)`);
      await ev(`document.querySelector("#hud > .ask.on textarea").scrollIntoView({ block: "center", behavior: "instant" })`);
      await click(button("#hud > .ask.on textarea"));
      await k.until(`document.activeElement === document.querySelector("#hud > .ask.on textarea")`);
      await k.d.type("My draft.");
      await k.until(`getComputedStyle(document.querySelector("#hud > .ask.on > .meta"), "::before").content === '"DRAFT"'`);
      await k.server.post("/api/asks", { title: "New again", kind: "decision", options: ["Yes", "No"], lane: "crm-search" });
      await k.until(`/1 NEW/.test(document.getElementById("below").textContent)`);
      await click(button("#below"));
      await k.until(`document.querySelector("#hud > .ask.on").dataset.ask !== "${a}"`);
      await k.until(`!document.querySelector(".askback").hidden`);
      expect(await ev(`document.querySelector(".askback").textContent`)).toContain("YOUR DRAFT");
      await click(button(".askback"));
      await k.until(`document.querySelector("#hud > .ask.on").dataset.ask === "${a}"`);
      await click(button(".asknav [data-focus]"));
      await k.until(`!document.getElementById("hud").classList.contains("focus")`);
    });

    test("the floor's scope and SHOW ALL change what is counted in FOCUS; a floor without the question starts at its first", async () => {
      await k.wheelTo(crm[1], 40);
      await Bun.sleep(250);
      await click(button(".asknav [data-focus]"));
      await k.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${crm[1]}"`);
      const all = await k.count();
      expect(await pill()).toContain(`OF ${all}`);
      await ev(`import("/src/client/core/scope.js").then((m) => { m.enter("crm"); })`);
      await k.until(`document.querySelectorAll("#hud > .ask").length < ${all}`);
      expect(await ev(`document.querySelector("#hud > .ask.on").dataset.ask`)).toBe(String(crm[1]));
      const here = await k.count();
      expect(await pill()).toContain(`OF ${here}`);
      await ev(`import("/src/client/core/scope.js").then((m) => m.enter("hq"))`);
      await k.until(`document.querySelectorAll("#hud > .ask").length !== ${here}`);
      expect(await ev(`document.querySelector("#hud > .ask.on").dataset.ask`)).toBe(String((await k.openIds())[0]));
      await ev(`import("/src/client/core/scope.js").then((m) => m.toBuilding())`);
      await k.until(`document.querySelectorAll("#hud > .ask").length === ${all}`);
      // The page moves as it leaves a floor; a tap is aimed once it has stopped.
      await Bun.sleep(400);
      await click(button(".asknav [data-focus]"));
      await k.until(`!document.getElementById("hud").classList.contains("focus")`);
    });

    test("a checklist does not look like something to tick: no boxes, and it says whose it is", async () => {
      const on = await k.server.post("/api/asks", { title: "With a checklist", kind: "action", lane: "alpha", due: Date.now() + 60_000 });
      await k.server.post(`/api/asks/${on.id}/items`, { text: "A check HQ keeps" });
      await k.until(`!!${cardQ(on.id)}?.querySelector(".lchk .ltick")`);
      const look = await ev(`(() => { const t = ${cardQ(on.id)}.querySelector(".ltick"), s = getComputedStyle(t); return { border: s.borderTopStyle, head: ${cardQ(on.id)}.querySelector(".lchkh")?.textContent ?? "" }; })()`);
      expect(look.border).toBe("none");
      expect(look.head).toContain("HQ");
      await k.server.post(`/api/asks/${on.id}/withdraw`, { reason: "done with it" });
      await k.until(`!${cardQ(on.id)}`);
    });

    test("the pick is a real label; a disabled SEND is quiet and keeps its target", async () => {
      const on = await k.server.post("/api/asks", { title: "Which one?", kind: "decision", options: ["This", "That"], recommended: "This", lane: "alpha" });
      await k.until(`!!${cardQ(on.id)}?.querySelector(".pick")`);
      const look = await ev(`(() => { const c = ${cardQ(on.id)}, p = getComputedStyle(c.querySelector(".pick")), b = c.querySelector(".send"), s = getComputedStyle(b); return { size: parseFloat(p.fontSize), disabled: b.disabled, fill: s.backgroundColor, h: b.getBoundingClientRect().height }; })()`);
      expect(look.size).toBeGreaterThanOrEqual(11);
      expect(look.disabled).toBe(true);
      expect(look.fill).toBe("rgba(0, 0, 0, 0)");
      expect(look.h).toBeGreaterThanOrEqual(run.touch ? 44 : 32);
      await k.server.post(`/api/asks/${on.id}/withdraw`, { reason: "done with it" });
      await k.until(`!${cardQ(on.id)}`);
    });

    test("SENT lies clear of the next question's text", async () => {
      const ids = await k.openIds(), a = ids[Math.floor(ids.length / 2)], next = ids[ids.indexOf(a) + 1];
      await k.wheelTo(a, 30);
      await Bun.sleep(250);
      await ev(`${cardQ(a)}.querySelector(".send").scrollIntoView({ block: "nearest", behavior: "instant" })`);
      if (await ev(`!!${cardQ(a)}.querySelector(".opt")`)) await click(`${cardQ(a)}.querySelector(".opt")`);
      await k.until(`!${cardQ(a)}.querySelector(".send").disabled`);
      await click(`${cardQ(a)}.querySelector(".send")`);
      await k.until(`!!document.querySelector(".toast") && !${cardQ(a)}`);
      // What has already scrolled under the sticky row is not being read.
      const hits = await ev(`(() => { const t = document.querySelector(".toast").getBoundingClientRect(), under = innerWidth < 1151 ? document.querySelector(".asknav").getBoundingClientRect().bottom : 0; return [...document.querySelectorAll("#hud > .ask h3, #hud > .ask .text, #hud > .ask .opt, #hud > .ask textarea, #hud > .ask .send")].filter((e) => { const r = e.getBoundingClientRect(); return r.height && r.bottom > under && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top; }).map((e) => e.textContent.slice(0, 30)); })()`);
      expect(hits).toEqual([]);
      expect(next).toBeGreaterThan(0);
    });

    test(run.touch ? "no ⌘↩ on a touch screen" : "⌘↩ stays on a desktop", async () => {
      const seen = await ev(`getComputedStyle(document.querySelector(".tell .hint")).display !== "none"`);
      expect(seen).toBe(!run.touch);
      await ev(`import("/src/client/core/dom.js").then((m) => { window.__hint = m.keysHint; })`);
      expect(await ev(`window.__hint(" ⌘↩ sends.").includes("⌘")`)).toBe(!run.touch);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED/.test(e))).toEqual([]));
  });
}
