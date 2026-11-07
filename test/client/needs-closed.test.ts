// A question that closes without you, walked with real input: parked words are never dropped silently, however long the
// question has been gone from the state; NEXT always lands on something real; a picture says it was not sent; and leaving
// FOCUS from a closed card keeps your place. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, startDesk, webkitDriver } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
const RUNS = [
  { name: "phone 390", width: 390, height: 844, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), skip: !findChrome() },
  { name: "desktop 1280", width: 1280, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 1280", width: 1280, height: 800, make: webkitDriver, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";

for (const run of RUNS) {
  describe.skipIf(run.skip)(`a closed question, ${run.name}`, () => {
    let browser: Awaited<ReturnType<typeof chromeDriver>>;
    let k: Awaited<ReturnType<typeof startDesk>> | null = null;
    const ev = (e: string) => k!.ev(e);
    const desk = async (n: number, opts: { floors?: boolean; seed?: (post: any) => Promise<number[]> } = {}) => {
      await k?.stop();
      k = await startDesk(ROOT, async () => browser.driver, {
        width: run.width, height: run.height, noAnchor: true, floors: opts.floors,
        seed: opts.seed ?? (async (post) => {
          const ids: number[] = [];
          for (let i = 1; i <= n; i++) ids.push((await post("/api/asks", { title: `Question ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf" })).id);
          return ids;
        }),
      });
      k.late.go("font.ttf");
      await ev(`try { localStorage.clear(); sessionStorage.clear(); } catch {}`);
      await reload();
      return k;
    };
    const reload = async () => { await k!.d.reload(); await k!.until(`!!document.getElementById("lastNote")?.innerHTML`); await Bun.sleep(500); };
    const away = () => k!.d.goto("about:blank");
    const home = async () => { await k!.d.goto(`${k!.late.base}/`); await k!.until(`!!document.getElementById("lastNote")?.innerHTML`); await Bun.sleep(500); };
    const stage = () => ev(`[...document.querySelectorAll("#hud > .ask")].filter((c) => c.getBoundingClientRect().height > 0).map((c) => Number(c.dataset.ask))`) as Promise<number[]>;
    const count = () => ev(`document.getElementById("below")?.textContent ?? ""`) as Promise<string>;
    const card = (id: number) => `#hud > .ask[data-ask="${id}"]`;
    const press = async (sel: string) => {
      // A card that has just changed takes no press for a moment (needs-gate.test.ts).
      await k!.until(`!document.documentElement.classList.contains("unready")`);
      await ev(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(120);
      await k!.clickEl(`document.querySelector(${JSON.stringify(sel)})`);
    };
    // A list that fits has no row to press: the mode as this browser remembers it.
    const focusOn = async () => {
      if (await ev(`!!document.querySelector(".asknav [data-focus]")`)) await press(".asknav [data-focus]");
      else { await ev(`localStorage.setItem("hq-needs-focus", "1")`); await reload(); }
      await k!.until(`document.getElementById("hud").classList.contains("focus")`);
      await Bun.sleep(200);
    };
    const type = async (id: number, words: string) => {
      await press(`${card(id)} textarea`);
      await k!.until(`document.activeElement?.closest("[data-ask]")?.dataset.ask === "${id}"`);
      await k!.d.type(words);
      await ev(`document.activeElement.blur()`);
      await Bun.sleep(100);
    };
    const onCard = async (id: number) => {
      await ev(`import("/src/client/questions/focus.js").then((m) => m.focusTo(${id}))`);
      await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${id}"`);
      await Bun.sleep(150);
    };
    const attach = async (id: number) => {
      await ev(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0)), t = new DataTransfer(); t.items.add(new File([bytes], "a.png", { type: "image/png" })); const i = document.querySelector(${JSON.stringify(`${card(id)} input[type=file]`)}); i.files = t.files; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(id)} .chips img, ${card(id)} .chips .chip`)})`);
      await Bun.sleep(200);
    };

    const say = (id: number, words: string) => ev(`(() => { const t = document.querySelector(${JSON.stringify(`${card(id)} textarea`)}); t.value = ${JSON.stringify(words)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    const shown = (sel: string) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((c) => c.getClientRects().length).map((c) => Number(c.closest("[data-ask]")?.dataset.ask))`) as Promise<number[]>;
    const rowText = () => ev(`document.querySelector(".leftrow [data-left-open]")?.textContent ?? ""`) as Promise<string>;
    const openRow = async () => { if (await ev(`!!document.querySelector("[data-left-open]")`)) await press("[data-left-open]"); await Bun.sleep(150); };
    const closeWhileAway = async (ids: number[]) => { await away(); for (const id of ids) await k!.server.post(`/api/asks/${id}/withdraw`, { reason: "gone" }); await home(); };

    beforeAll(async () => { browser = await run.make(run.width, run.height); }, 60_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    for (const mode of ["the list", "FOCUS"]) {
      test(`${mode}: words on a question gone from the state come back after a reload, with what it asked and who, until DISCARD`, async () => {
        await desk(50);
        const [one, ...rest] = k!.ids;
        if (mode === "FOCUS") { await focusOn(); await onCard(rest[0]); }
        await type(mode === "FOCUS" ? rest[0] : one, "Words that must not vanish.");
        const held = mode === "FOCUS" ? rest[0] : one, others = k!.ids.filter((x) => x !== held);
        await away();
        await k!.server.post(`/api/asks/${held}/withdraw`, { reason: "gone" });
        for (const id of others.slice(0, 41)) await k!.server.post(`/api/asks/${id}/answer`, { answer: "Yes" });
        const state = await (await fetch(`${k!.server.base}/api/state`)).json();
        expect(state.answered.some((a: { id: number }) => a.id === held)).toBe(false);
        await home();
        const shown = () => ev(`(() => { const c = document.querySelector(${JSON.stringify(card(held))}); return c && { left: c.classList.contains("left"), title: c.querySelector("h3")?.textContent, who: c.querySelector(".meta")?.textContent.includes("golf"), words: c.querySelector("textarea")?.value, note: c.querySelector(".leftnote")?.textContent.includes("not sent") }; })()`);
        const want = { left: true, title: `Question ${k!.ids.indexOf(held) + 1}`, who: true, words: "Words that must not vanish.", note: true };
        expect(await shown()).toEqual(want);
        await reload();
        expect(await shown()).toEqual(want);
        if (mode === "FOCUS") await onCard(held); else await openRow();
        await press(`${card(held)} [data-left-copy]`);
        await Bun.sleep(200);
        expect(await shown()).toEqual(want);
        await press(`${card(held)} [data-left-drop]`);
        await k!.until(`!document.querySelector(${JSON.stringify(card(held))})`);
        await reload();
        expect(await ev(`!!document.querySelector(${JSON.stringify(card(held))})`)).toBe(false);
      });
    }

    test("NEXT on the last closed card, no words: the one before it, and a count that is true", async () => {
      await desk(3);
      const [, b, c] = k!.ids;
      await focusOn();
      await onCard(c);
      await k!.server.post(`/api/asks/${c}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(c)} .leftnote`)})`);
      await press(`${card(c)} [data-left-next]`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(c))})`);
      expect(await stage()).toEqual([b]);
      expect(await count()).toBe("2 OF 2");
    });

    test("NEXT on the last closed card with words: the one before it, the words kept, and ▼ comes back to them", async () => {
      await desk(3);
      const [, b, c] = k!.ids;
      await focusOn();
      await onCard(c);
      await type(c, "Still mine.");
      await k!.server.post(`/api/asks/${c}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(c)} .leftnote`)})`);
      await press(`${card(c)} [data-left-next]`);
      await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${b}"`);
      expect(await stage()).toEqual([b]);
      expect(await count()).toBe("2 OF 2");
      await press('.asknav [data-step="1"]');
      await k!.until(`document.querySelector("#hud > .ask.on")?.dataset.ask === "${c}"`);
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(c)} textarea`)}).value`)).toBe("Still mine.");
    });

    test("NEXT with nothing open, no words: the normal empty state, no row", async () => {
      await desk(2);
      const [a, b] = k!.ids;
      await focusOn();
      await onCard(b);
      await k!.server.post(`/api/asks/${b}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(b)} .leftnote`)})`);
      await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
      await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
      await press(`${card(b)} [data-left-next]`);
      await k!.until(`document.getElementById("hud").textContent.includes("NOTHING NEEDS YOU")`);
      await Bun.sleep(200);
      expect(await stage()).toEqual([]);
      expect(await ev(`!!document.querySelector(".asknav")`)).toBe(false);
    });

    test("NEXT with nothing open, words kept: it says why it stays, and DISCARD gives the empty state", async () => {
      await desk(1);
      const [a] = k!.ids;
      await focusOn();
      await type(a, "Only these.");
      await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(a)} .leftnote`)})`);
      await Bun.sleep(2700); // the toast that said it closed has gone
      await press(`${card(a)} [data-left-next]`);
      await k!.until(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("NOTHING ELSE"))`);
      expect(await stage()).toEqual([a]);
      await press(`${card(a)} [data-left-drop]`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
      await k!.until(`document.getElementById("hud").textContent.includes("NOTHING NEEDS YOU")`);
      expect(await stage()).toEqual([]);
    });

    test("a picture-only draft: the chip says so, and when the card closes it says the picture was not sent", async () => {
      await desk(3);
      const [a, b] = k!.ids;
      await attach(a);
      expect(await ev(`document.querySelector(${JSON.stringify(card(a))}).dataset.mark ?? ""`)).toContain("DRAFT");
      await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(a)} .leftnote`)})`);
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(a)} .leftnote`)}).textContent.toLowerCase()`)).toContain("picture");
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(a)} .leftnote`)}).textContent.toLowerCase()`)).toContain("not sent");
      await attach(b);
      await away();
      await k!.server.post(`/api/asks/${b}/withdraw`, { reason: "gone" });
      await home();
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(b)} .leftnote`)})`);
      expect(await ev(`document.querySelector(${JSON.stringify(`${card(b)} .leftnote`)}).textContent.toLowerCase()`)).toContain("picture");
    });

    for (const words of [true, false]) {
      test(`FOCUS off from a closed card${words ? " with words" : ""}: you stay where you were`, async () => {
        await desk(40);
        const held = k!.ids[25];
        await focusOn();
        await onCard(held);
        if (words) await type(held, "In view, please.");
        await ev(`document.querySelector(${JSON.stringify(`${card(held)} h3`)}).scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(150);
        await k!.server.post(`/api/asks/${held}/withdraw`, { reason: "gone" });
        await k!.until(`!!document.querySelector(${JSON.stringify(`${card(held)} .leftnote`)})`);
        await Bun.sleep(200);
        const top = () => ev(`document.querySelector(${JSON.stringify(`${card(held)} h3`)}).getBoundingClientRect().top`) as Promise<number>;
        const before = await top();
        await k!.clickEl(`document.querySelector(".asknav [data-focus]")`);
        await k!.until(`!document.getElementById("hud").classList.contains("focus")`);
        await Bun.sleep(300);
        // A card's top keeps its 12 px under the edge of the list, as a live card's does.
        expect(Math.abs((await top()) - before)).toBeLessThan(16);
        if (words) expect(await ev(`(() => { const r = document.querySelector(${JSON.stringify(`${card(held)} textarea`)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
      });
    }

    test("after a reload, closed cards are one row at the top: what is open is on the first screen, and one tap opens them, newest first", async () => {
      await desk(20);
      const held = k!.ids.slice(0, 12), first = k!.ids[12];
      for (const id of held) await say(id, `Words on ${id}.`);
      await closeWhileAway(held);
      expect(await ev(`document.querySelector("#hud > :first-child")?.matches(".leftrow")`)).toBe(true);
      expect(await rowText()).toBe("12 CLOSED QUESTIONS HAD YOUR WORDS");
      expect(await shown("#hud > .ask.left")).toEqual([]);
      expect(await ev(`document.querySelector(${JSON.stringify(card(first))}).getBoundingClientRect().top < innerHeight`)).toBe(true);
      expect(await ev(`[...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" ")`)).toContain("THE ROW AT THE TOP");
      await press("[data-left-open]");
      await k!.until(`document.querySelector("[data-left-open]").getAttribute("aria-expanded") === "true"`);
      expect(await shown("#hud > .ask.left")).toEqual([...held].reverse());
      await reload();
      expect(await rowText()).toBe("12 CLOSED QUESTIONS HAD YOUR WORDS");
      expect(await ev(`document.querySelector("[data-left-open]").getAttribute("aria-expanded")`)).toBe("false");
    });

    test.skipIf(run.width >= 1151)("the count does not claim a question while you read closed cards, and ▼ goes to the first open one", async () => {
      await desk(20);
      const held = k!.ids.slice(0, 3);
      for (const id of held) await say(id, `Words on ${id}.`);
      await closeWhileAway(held);
      await openRow();
      await k!.until(`document.getElementById("below").textContent === "17 WAITING"`);
      expect(await ev(`document.querySelector('.asknav [data-step="-1"]').disabled`)).toBe(true);
      await press('.asknav [data-step="1"]');
      await k!.until(`document.getElementById("below").textContent === "1 OF 17"`);
      expect(await ev(`document.querySelector(${JSON.stringify(card(k!.ids[3]))}).getBoundingClientRect().top < innerHeight / 2`)).toBe(true);
    });

    test("DISCARD ALL asks first: keep leaves them all, yes drops every one and the row", async () => {
      await desk(6);
      const held = k!.ids.slice(0, 3);
      for (const id of held) await say(id, `Words on ${id}.`);
      await closeWhileAway(held);
      await press("[data-left-all]");
      await k!.until(`!!document.querySelector(".confirm .confirmno")`);
      expect(await ev(`document.querySelector(".confirm").textContent`)).toContain("3");
      await k!.clickEl(`document.querySelector(".confirm .confirmno")`);
      await k!.until(`!document.querySelector(".confirm")`);
      expect(await rowText()).toBe("3 CLOSED QUESTIONS HAD YOUR WORDS");
      await press("[data-left-all]");
      await k!.until(`!!document.querySelector(".confirm .confirmyes")`);
      await k!.clickEl(`document.querySelector(".confirm .confirmyes")`);
      await k!.until(`!document.querySelector("#hud > .ask.left")`);
      expect(await ev(`!!document.querySelector(".leftrow")`)).toBe(false);
      await reload();
      expect(await ev(`!!document.querySelector("#hud > .ask.left")`)).toBe(false);
    });

    test("one DISCARD at a time counts down, and the row goes with the last", async () => {
      await desk(4);
      const held = k!.ids.slice(0, 2);
      for (const id of held) await say(id, `Words on ${id}.`);
      await closeWhileAway(held);
      await rowText().then((t) => expect(t).toBe("2 CLOSED QUESTIONS HAD YOUR WORDS"));
      await openRow();
      await press(`${card(held[1])} [data-left-drop]`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(held[1]))})`);
      expect(await rowText()).toBe("1 CLOSED QUESTION HAD YOUR WORDS");
      await press(`${card(held[0])} [data-left-drop]`);
      await k!.until(`!document.querySelector(".leftrow")`);
    });

    test("a card closing while you watch stays where it is, with no row", async () => {
      await desk(6);
      const held = k!.ids[2];
      await say(held, "Stays right here.");
      await k!.server.post(`/api/asks/${held}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(held)} .leftnote`)})`);
      expect(await ev(`!!document.querySelector(".leftrow")`)).toBe(false);
      expect(await ev(`[...document.querySelectorAll("#hud > .ask")].map((c) => Number(c.dataset.ask)).indexOf(${held})`)).toBe(2);
      expect(await shown("#hud > .ask.left")).toEqual([held]);
    });

    test("FOCUS is unchanged: no row, the closed card is on the stage; FOCUS off from it opens the row", async () => {
      await desk(20);
      const held = k!.ids[4];
      await focusOn();
      await onCard(held);
      await say(held, "On the stage.");
      await closeWhileAway([held]);
      expect(await shown(".leftrow")).toEqual([]);
      expect(await shown("#hud > .ask.on")).toEqual([held]);
      await k!.clickEl(`document.querySelector(".asknav [data-focus]")`);
      await k!.until(`!document.getElementById("hud").classList.contains("focus")`);
      await Bun.sleep(300);
      expect(await shown("#hud > .ask.left")).toEqual([held]);
      expect(await ev(`document.querySelector("[data-left-open]").getAttribute("aria-expanded")`)).toBe("true");
      expect(await ev(`(() => { const r = document.querySelector(${JSON.stringify(`${card(held)} textarea`)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
    });

    test("a draft that is only a pick goes with its card, whether you watched it close or were away", async () => {
      const parkedNow = () => ev(`import("/src/client/questions/drafts.js").then((m) => { m.keepDrafts(); return JSON.parse(sessionStorage.getItem("hq-drafts")).drafts.map(([id]) => id); })`) as Promise<number[]>;
      await desk(4);
      const [a, b, c] = k!.ids;
      await press(`${card(a)} .opt`);
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(a)} .opt.sel`)})`);
      expect(await parkedNow()).toContain(a);
      await k!.server.post(`/api/asks/${a}/withdraw`, { reason: "gone" });
      await k!.until(`!document.querySelector(${JSON.stringify(card(a))})`);
      expect(await parkedNow()).not.toContain(a);
      await press(`${card(b)} .opt`);
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(b)} .opt.sel`)})`);
      await say(c, "These stay.");
      await closeWhileAway([b, c]);
      const left = await parkedNow();
      expect(left).not.toContain(b);
      expect(left).toContain(c);
    });

    test("answering the card just before a closed one of another floor: the next one you can see takes its place", async () => {
      await desk(0, { floors: true, seed: async (post) => {
        await post("/api/lanes", { name: "crm-search", machine: "local", floor: "crm" });
        const ids: number[] = [];
        for (let i = 1; i <= 8; i++) ids.push((await post("/api/asks", { title: `Here ${i}`, kind: "action", lane: "golf" })).id);
        ids.push((await post("/api/asks", { title: "On CRM", kind: "action", lane: "crm-search" })).id);
        for (let i = 9; i <= 16; i++) ids.push((await post("/api/asks", { title: `Here ${i}`, kind: "action", lane: "golf" })).id);
        return ids;
      } });
      const before = k!.ids[7], hidden = k!.ids[8], next = k!.ids[9];
      const state = await (await fetch(`${k!.server.base}/api/state`)).json();
      const main = state.open.find((a: { id: number }) => a.id === before).floor as string;
      await say(hidden, "Words on CRM.");
      await k!.server.post(`/api/asks/${hidden}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(hidden)} .leftnote`)})`);
      await ev(`import("/src/client/core/scope.js").then((m) => m.enter(${JSON.stringify(main)}))`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(hidden))}).getClientRects().length`);
      await Bun.sleep(200);
      await k!.until(`!document.documentElement.classList.contains("unready")`);
      await ev(`document.querySelector(${JSON.stringify(`${card(before)} .send`)}).scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(200);
      const top = await ev(`document.querySelector(${JSON.stringify(card(before))}).getBoundingClientRect().top`) as number;
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(before)} .send`)})`);
      await k!.until(`!document.querySelector(${JSON.stringify(card(before))})`);
      await Bun.sleep(200);
      const landed = await ev(`document.querySelector(${JSON.stringify(card(next))}).getBoundingClientRect().top`) as number;
      expect(Math.abs(landed - top)).toBeLessThan(2);
    });

    test("entering a floor while scrolled down the list holds nothing: you chose to go there, and the next press counts", async () => {
      await desk(0, { floors: true, seed: async (post) => {
        await post("/api/lanes", { name: "crm-search", machine: "local", floor: "crm" });
        const ids: number[] = [];
        for (let i = 1; i <= 2; i++) ids.push((await post("/api/asks", { title: `On CRM ${i}`, kind: "decision", options: ["Yes", "No"], lane: "crm-search" })).id);
        for (let i = 1; i <= 14; i++) ids.push((await post("/api/asks", { title: `Here ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf" })).id);
        return ids;
      } });
      const [crm] = k!.ids;
      await ev(`(async () => { const { pageScrolls } = await import("/src/client/core/dom.js"); const h = document.getElementById("hud"); if (pageScrolls()) scrollTo(0, 400); else h.scrollTop = 400; })()`);
      await Bun.sleep(300);
      await ev(`import("/src/client/core/scope.js").then((m) => m.enter("crm"))`);
      await k!.until(`!!document.querySelector(${JSON.stringify(card(crm))}) && document.querySelectorAll("#hud > .ask").length === 2`);
      expect(await ev(`document.documentElement.classList.contains("unready")`)).toBe(false);
      await k!.clickEl(`document.querySelector(${JSON.stringify(`${card(crm)} .opt`)})`);
      await k!.until(`document.querySelectorAll(${JSON.stringify(`${card(crm)} .opt.sel`)}).length === 1`);
    });

    test("a closed card is scoped like any other, and carries its floor tag under SHOW ALL", async () => {
      await desk(0, { floors: true, seed: async (post) => {
        await post("/api/lanes", { name: "crm-search", machine: "local", floor: "crm" });
        const ids: number[] = [];
        for (let i = 1; i <= 3; i++) ids.push((await post("/api/asks", { title: `On CRM ${i}`, kind: "decision", options: ["Yes", "No"], lane: "crm-search" })).id);
        for (let i = 1; i <= 3; i++) ids.push((await post("/api/asks", { title: `Here ${i}`, kind: "decision", options: ["Yes", "No"], lane: "golf" })).id);
        return ids;
      } });
      const [parked, live, , here] = k!.ids;
      const state = await (await fetch(`${k!.server.base}/api/state`)).json();
      const main = state.open.find((a: { id: number }) => a.id === here).floor as string;
      const enter = (floor: string) => ev(`import("/src/client/core/scope.js").then((m) => m.enter(${JSON.stringify(floor)}))`).then(() => Bun.sleep(250));
      const tag = (id: number) => ev(`document.querySelector(${JSON.stringify(`${card(id)} .meta .fstripe`)})?.dataset.floor ?? null`);
      await say(parked, "Words on CRM.");
      await closeWhileAway([parked]);
      expect(await rowText()).toBe("1 CLOSED QUESTION HAD YOUR WORDS");
      expect(await tag(parked)).toBe("crm");
      await enter(main);
      expect(await rowText()).toBe("");
      await enter("crm");
      expect(await rowText()).toBe("1 CLOSED QUESTION HAD YOUR WORDS");
      expect(await tag(parked)).toBe(null);
      await ev(`import("/src/client/core/scope.js").then((m) => m.toggleAll())`);
      await Bun.sleep(250);
      expect(await tag(parked)).toBe("crm");
      await ev(`import("/src/client/core/scope.js").then((m) => m.toggleAll())`);
      await Bun.sleep(250);
      await say(live, "Closing while I watch.");
      await k!.server.post(`/api/asks/${live}/withdraw`, { reason: "gone" });
      await k!.until(`!!document.querySelector(${JSON.stringify(`${card(live)} .leftnote`)})`);
      expect(await shown(`${card(live)}`)).toEqual([live]);
      await enter(main);
      expect(await shown(`${card(live)}`)).toEqual([]);
      await enter("crm");
      expect(await shown(`${card(live)}`)).toEqual([live]);
      await focusOn();
      await onCard(live);
      await enter(main);
      expect(await ev(`document.querySelector("#hud > .ask.on")?.dataset.ask`)).toBe(String(here));
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED|Failed to fetch/.test(e))).toEqual([]));
  });
}
