// A sheet must never hold the page once it is off the screen: following a link out of any sheet that can hold one, or a
// sheet's parent hidden or redrawn while it is up, leaves nothing inert and no lock, and the question panel answers the
// next tap. NEEDS_PLAYWRIGHT adds Playwright's WebKit. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome } from "../../scripts/room-hash.ts";
import { chromeDriver, type Driver, startDesk } from "./needs-scenes.ts";

setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..", "..");
// Playwright's WebKit with a new page on request: its page can stop answering when it is sent away just after Back took
// two steps, so a walk here starts on a new one instead of leaving the last. One browser for both widths: the second of
// two launched in one run stopped answering from its first test.
let webkitBrowser: Promise<any> | null = null;
afterAll(async () => { await (await webkitBrowser)?.close(); });
async function webkitPages(width: number, height: number) {
  const { webkit } = await import(process.env.NEEDS_PLAYWRIGHT!);
  const b = await (webkitBrowser ??= webkit.launch({ headless: true }));
  const errors: string[] = [];
  let context: any, p: any;
  const fresh = async () => {
    const was = context;
    context = await b.newContext({ viewport: { width, height } });
    p = await context.newPage();
    p.on("pageerror", (e: Error) => errors.push(e.message));
    p.on("crash", () => errors.push("the page crashed"));
    was?.close().catch(() => {});
  };
  await fresh();
  const driver: Driver = {
    ev: (code) => p.evaluate(code),
    wheel: async (x, y, dy) => { await p.mouse.move(x, y); await p.mouse.wheel(0, dy); },
    click: async (x, y) => { await p.mouse.click(x, y); },
    type: async (text) => { await p.keyboard.insertText(text); },
    key: async (key) => { await p.keyboard.press(key); },
    goto: async (url) => { await p.goto(url, { waitUntil: "commit" }); },
    reload: async () => { await p.reload({ waitUntil: "commit" }); },
  };
  return { driver, errors, fresh, close: () => context.close() };
}
const RUNS = [
  { name: "phone 390", width: 390, height: 844, make: (w: number, h: number) => chromeDriver(w, h, { touch: true }), skip: !findChrome() },
  { name: "narrow window 600", width: 600, height: 800, make: chromeDriver, skip: !findChrome() },
  { name: "WebKit 390", width: 390, height: 844, make: webkitPages, skip: !process.env.NEEDS_PLAYWRIGHT },
  { name: "WebKit 600", width: 600, height: 800, make: webkitPages, skip: !process.env.NEEDS_PLAYWRIGHT },
];
const LOCK = `(() => ({ inert: document.querySelectorAll("[inert]").length, locked: document.documentElement.classList.contains("sheetopen"), sheets: document.querySelectorAll(".sheet").length }))()`;
const FREE = { inert: 0, locked: false, sheets: 0 };

for (const run of RUNS) {
  describe.skipIf(run.skip)(`a sheet that left the screen, ${run.name}`, () => {
    let k: Awaited<ReturnType<typeof startDesk>>;
    let browser: { driver: Driver; errors: string[]; fresh?: () => Promise<void>; close: () => unknown };
    let one = 0, two = 0;
    const ev = (e: string) => k.ev(e);
    const lock = () => ev(LOCK);
    const press = async (sel: string) => {
      await k.until(`[...document.querySelectorAll(${JSON.stringify(sel)})].some((e) => e.getBoundingClientRect().width > 0)`);
      const e = `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getBoundingClientRect().width > 0).at(-1)`;
      // On screen and at rest: a page comes back at your place a moment after it loads, and a sheet slides in.
      let at = "";
      for (let i = 0; i < 8; i++) {
        await ev(`${e}.scrollIntoView({ block: "center", behavior: "instant" })`);
        await Bun.sleep(250);
        at = await ev(`(() => { const t = ${e}, r = t.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, h = document.elementFromPoint(x, y); return h && (h === t || t.contains(h) || h.contains(t)) ? "" : "covered at " + Math.round(x) + "," + Math.round(y) + " scrollY " + Math.round(scrollY) + " by " + (h ? h.tagName + "." + h.className : "nothing"); })()`);
        if (!at) break;
      }
      if (at) throw new Error(`cannot press ${sel}: ${at}`);
      await k.clickEl(e);
    };
    // A fresh page each time, so one walk's history is not the next one's.
    const load = async (hash = "") => {
      if (browser.fresh) await browser.fresh();
      else {
        await ev(`localStorage.removeItem("hq-qtab")`).catch(() => {});
        // Closing a sheet steps back a moment later, and that step can drop a navigation sent just then.
        for (let i = 0; ; i++) {
          await k.d.goto("about:blank");
          try { await k.until(`location.href === "about:blank"`, 2000); break; } catch (e) { if (i === 4) throw e; }
        }
      }
      await k.d.goto(`${k.late.base}/${hash}`);
      await k.until(`document.readyState === "complete" && document.querySelectorAll("#hud > .ask").length > 0 && !!document.getElementById("lastNote")?.innerHTML && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`);
      await Bun.sleep(300);
    };
    const comments = async (from: string) => {
      await load(from);
      await k.until(`!!document.querySelector("[data-comments-toggle]")`);
      const key = await ev(`document.querySelector("[data-comments-toggle]").dataset.commentsToggle`);
      return key as string;
    };
    const openThread = async () => {
      await press("[data-comments-toggle]");
      await k.until(`!!document.querySelector(".cmount.sheet")`);
      await k.until(`!!document.querySelector(".cmount.sheet .cthread .msg a")`);
    };
    const menu = async (row: string, sel: string) => {
      await press("#menuBtn");
      try { await k.until(`!!document.querySelector("#menuDrop.sheet")`, 3000); } catch { throw new Error("MENU did not open: " + JSON.stringify(await ev(`({ y: scrollY, hidden: document.getElementById("menuDrop").hidden, cls: document.getElementById("menuDrop").className, rect: document.getElementById("menuDrop").getClientRects().length, btn: document.getElementById("menuBtn").getBoundingClientRect().top, hash: location.hash, inert: document.querySelectorAll("[inert]").length, expanded: document.getElementById("menuBtn").getAttribute("aria-expanded") })`))); }
      await press(row);
      await k.until(`!!document.querySelector(${JSON.stringify(`${sel}.sheet`)})`);
    };
    // The page answers: the room's own BACK takes a real tap, all the way out, and a question that came in meanwhile
    // takes one on its DONE. A room or a brief has the whole screen on a phone.
    const stillAnswers = async () => {
      const q = (await k.server.post("/api/asks", { title: "Came in meanwhile", kind: "action", lane: "golf" })).id;
      for (let i = 0; i < 3 && (await ev(`location.hash`)); i++) {
        const from = await ev(`location.hash`);
        await press("[data-room-back], [data-brief-back], [data-page-back]");
        await k.until(`location.hash !== ${JSON.stringify(from)}`);
        await Bun.sleep(150);
      }
      expect(await ev(`location.hash`)).toBe("");
      const card = `#hud > .ask[data-ask="${q}"]`;
      await k.until(`!!document.querySelector(${JSON.stringify(`${card} .send`)})`);
      await ev(`document.querySelector(${JSON.stringify(`${card} .send`)}).scrollIntoView({ block: "center", behavior: "instant" })`);
      await Bun.sleep(1200); // past the hold a card arriving may start
      await press(`${card} .send`);
      await k.until(`!document.querySelector(${JSON.stringify(card)})`);
    };

    beforeAll(async () => {
      browser = await run.make(run.width, run.height);
      k = await startDesk(ROOT, async () => browser.driver, {
        ...run,
        seed: async (post) => {
          const ids: number[] = [];
          for (let i = 1; i <= 3; i++) ids.push((await post("/api/asks", { title: `To do ${i}`, kind: "action", lane: "golf" })).id);
          return ids;
        },
      });
      k.late.go("font.ttf");
      await k.server.post("/api/rooms", { slug: "r1", title: "A room", owner: "golf" });
      one = (await k.server.post("/api/briefs", { title: "Brief one", body: "Words one." })).id;
      two = (await k.server.post("/api/briefs", { title: "Brief two", body: "Words two." })).id;
      const put = await fetch(`${k.server.base}/api/rooms/r1/files?name=p.html`, { method: "POST", headers: { "x-hud": "1" }, body: "<!doctype html><html><body><h1>hi</h1></body></html>" });
      expect(put.ok).toBe(true);
    }, 120_000);
    afterAll(async () => { await k?.stop(); await browser?.close(); });

    // A link in a comment, by where it goes. A comment that is only a reference draws as a card, the same tap.
    for (const [what, text, lands] of [
      ["to a room", "[go](#room/r1)", "#room/r1"],
      ["to a page", "[go](#page/rooms/r1/files/p.html)", "#page/rooms/r1/files/p.html"],
      ["that is only a reference", "#room/r1", "#room/r1"],
    ] as const) {
      test(`a comment's link ${what}: nothing stays locked, and Back brings the brief with no sheet`, async () => {
        const key = await comments(`#brief/${one}`);
        await k.server.post("/api/comments/post", { page: key, text });
        await openThread();
        await press(".cmount.sheet .cthread .msg:last-of-type a");
        await k.until(`location.hash === ${JSON.stringify(lands)}`);
        await k.until(`!document.documentElement.classList.contains("sheetopen")`);
        expect(await lock()).toEqual(FREE);
        await ev(`history.back(), true`);
        try { await k.until(`location.hash === "#brief/${one}" && !history.state?.hqSheet`); }
        catch { throw new Error("Back did not arrive: " + JSON.stringify(await ev(`({ hash: location.hash, state: history.state, length: history.length, at: navigation?.currentEntry?.index, frames: frames.length, entries: navigation?.entries().map((e) => new URL(e.url).hash + (e.sameDocument ? "" : " other")) })`))); }
        await Bun.sleep(150);
        expect(await lock()).toEqual(FREE);
        expect(await ev(`!!document.querySelector(".cmount.open")`)).toBe(false);
      });
    }

    test("a comment's link to a room: a question that came in meanwhile answers to a real tap", async () => {
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: "[go](#room/r1)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`location.hash === "#room/r1"`);
      await stillAnswers();
      expect(await lock()).toEqual(FREE);
    });

    test("a comment's link to another brief: it stays there, nothing locked", async () => {
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: `[go](#brief/${two})` });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`location.hash === "#brief/${two}"`);
      await Bun.sleep(300);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`location.hash`)).toBe(`#brief/${two}`);
    });

    test("a page's comment to a room: nothing locked", async () => {
      const key = await comments("#page/rooms/r1/files/p.html");
      await k.server.post("/api/comments/post", { page: key, text: "[go](#room/r1)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`location.hash === "#room/r1"`);
      await Bun.sleep(300);
      expect(await lock()).toEqual(FREE);
    });

    test("a comment's link to a lane: the drawer stacks, and closing both leaves nothing locked", async () => {
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: "[go](#lane/golf)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`!!document.querySelector("#card.sheet")`);
      expect(await ev(`!!document.querySelector(".cmount.sheet")`)).toBe(true);
      await k.d.key("Escape");
      await k.until(`!document.querySelector("#card.sheet")`);
      await k.d.key("Escape");
      await k.until(`!document.querySelector(".sheet")`);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`location.hash`)).toBe(`#brief/${one}`);
    });

    test("two sheets closed at once by two Esc with no gap: Back stops at the brief, it does not leave the app", async () => {
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: "[go](#lane/golf)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await Bun.sleep(200);
      await Promise.all([k.d.key("Escape"), k.d.key("Escape")]);
      await Bun.sleep(500);
      expect(await ev(`location.href.replace(/^http[^#]*/, "")`)).toBe(`#brief/${one}`);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`!!history.state?.hqSheet`)).toBe(false);
    });

    test("TELL HQ's last note holds a link: following it leaves nothing locked, and the words typed stay", async () => {
      await k.server.post("/api/notes", { text: "[go](#room/r1)" });
      await load("");
      await menu("#menuTell", ".tell");
      await k.d.type("Words I was typing");
      await press(".tell #lastNote a");
      await k.until(`location.hash === "#room/r1"`);
      await k.until(`!document.documentElement.classList.contains("sheetopen")`);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`document.getElementById("noteText").value`)).toBe("Words I was typing");
      await ev(`document.getElementById("noteText").value = ""`);
    });

    test("a drawer over a brief's comments links to another brief, a move that replaces the step: it stays there, nothing locked", async () => {
      await k.server.post("/api/lanes", { name: "golf", machine: "local", note: `[go](#brief/${two})` });
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: "[go](#lane/golf)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`!!document.querySelector("#card.sheet .note a")`);
      await press("#card.sheet .note a");
      await k.until(`location.hash === "#brief/${two}"`);
      await Bun.sleep(400);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`location.hash`)).toBe(`#brief/${two}`);
      expect(await ev(`!!history.state?.hqSheet`)).toBe(false);
      await k.server.post("/api/lanes", { name: "golf", machine: "local", note: "[go](#room/r1)" });
    });

    // A sheet only comes off the screen by something taking it: opening one from anywhere still shows it.
    for (const tab of ["questions", "messages", "work", "rooms", "briefs"]) {
      for (const [row, sel] of [["#menuTell", ".tell"], ["#secretsBtn", "#secretsPanel"]] as const) {
        test(`${sel} from MENU on the ${tab} tab opens, and closes to a free page`, async () => {
          await load("");
          await press(`[data-qtab="${tab}"]`);
          await Bun.sleep(150);
          await menu(row, sel);
          await Bun.sleep(100);
          const r = await ev(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().height`);
          expect(r).toBeGreaterThan(0);
          await k.d.key("Escape");
          await k.until(`!document.querySelector(".sheet")`);
          expect(await lock()).toEqual(FREE);
        });
      }
    }

    test("a lane's note in the drawer holds a link: following it leaves nothing locked", async () => {
      await k.server.post("/api/lanes", { name: "golf", machine: "local", note: "[go](#room/r1)" });
      await load("");
      await press("#hud > .ask .meta [data-select]");
      await k.until(`!!document.querySelector("#card.sheet .note a")`);
      await press("#card.sheet .note a");
      await k.until(`location.hash === "#room/r1"`);
      await k.until(`!document.documentElement.classList.contains("sheetopen")`);
      expect(await lock()).toEqual(FREE);
    });

    // ---- the net: whatever took the sheet off the screen, and whatever the panel thinks ----

    // A panel that never closes itself: only the core can let go of the page.
    const stubborn = (parent: string) => `(async () => {
      const { sheet } = await import("/src/client/core/sheet.js");
      const outer = document.createElement("section"); outer.id = "outerT";
      const inner = document.createElement("div"); inner.id = "innerT";
      const panel = document.createElement("div"); panel.id = "panelT"; panel.innerHTML = "<button>Inside</button>"; panel.hidden = true;
      inner.append(panel); outer.append(inner); ${parent}.append(outer);
      window.__off = sheet(panel, () => {});
      panel.hidden = false;
    })()`;
    const cleanup = `(() => { window.__off?.(); document.getElementById("outerT")?.remove(); document.getElementById("styleT")?.remove(); })()`;

    for (const [what, hide] of [
      ["its parent hidden", `document.getElementById("innerT").hidden = true`],
      ["a far parent put out of the page by a rule", `(() => { const s = document.createElement("style"); s.id = "styleT"; s.textContent = ".gone-t { display: none !important; }"; document.head.append(s); document.getElementById("outerT").classList.add("gone-t"); })()`],
      ["its parent redrawn", `document.getElementById("innerT").innerHTML = ""`],
      ["its parent taken out of the page", `document.getElementById("outerT").remove()`],
    ] as const) {
      test(`a panel that will not close, ${what}: the page lets go`, async () => {
        await load("");
        await ev(stubborn("document.querySelector('.stage')"));
        await k.until(`!!document.querySelector("#panelT.sheet")`);
        expect((await lock()).locked).toBe(true);
        await ev(hide);
        await k.until(`!document.documentElement.classList.contains("sheetopen")`);
        expect(await lock()).toEqual(FREE);
        expect(await ev(`(() => { const s = document.querySelector(".sheetbg"); return !s || s.hidden; })()`)).toBe(true);
        await ev(cleanup);
      });
    }

    test("a panel opened inside something hidden never locks the page", async () => {
      await load("");
      await ev(`(async () => {
        const { sheet } = await import("/src/client/core/sheet.js");
        const outer = document.createElement("section"); outer.id = "outerT"; outer.hidden = true;
        const panel = document.createElement("div"); panel.id = "panelT"; panel.hidden = true; outer.append(panel); document.querySelector(".stage").append(outer);
        window.__off = sheet(panel, () => {});
        panel.hidden = false;
      })()`);
      await Bun.sleep(100);
      expect(await lock()).toEqual(FREE);
      await ev(cleanup);
    });

    test("a brief's view hidden with its comment sheet up: the sheet closes, and does not come back with the view", async () => {
      await comments(`#brief/${one}`);
      await press("[data-comments-toggle]");
      await k.until(`!!document.querySelector(".cmount.sheet")`);
      await ev(`document.querySelector(".briefview").hidden = true`);
      await k.until(`!document.documentElement.classList.contains("sheetopen")`);
      expect(await lock()).toEqual(FREE);
      await ev(`document.querySelector(".briefview").hidden = false`);
      await Bun.sleep(150);
      expect(await lock()).toEqual(FREE);
      expect(await ev(`!!document.querySelector(".cmount.open")`)).toBe(false);
    });

    test("a brief's view redrawn with its comment sheet up: nothing locked", async () => {
      await comments(`#brief/${one}`);
      await press("[data-comments-toggle]");
      await k.until(`!!document.querySelector(".cmount.sheet")`);
      await ev(`document.querySelector(".briefview").innerHTML = ""`);
      await k.until(`!document.documentElement.classList.contains("sheetopen")`);
      expect(await lock()).toEqual(FREE);
    });

    test("a sheet stacked over one whose view went: the top stays and works, and closing it leaves nothing locked", async () => {
      const key = await comments(`#brief/${one}`);
      await k.server.post("/api/comments/post", { page: key, text: "[go](#lane/golf)" });
      await openThread();
      await press(".cmount.sheet .cthread .msg:last-of-type a");
      await k.until(`!!document.querySelector("#card.sheet")`);
      await ev(`document.querySelector(".briefview").hidden = true`);
      await k.until(`!document.querySelector(".cmount.sheet")`);
      expect(await ev(`!!document.querySelector("#card.sheet")`)).toBe(true);
      expect(await ev(`document.getElementById("card").closest("[inert]") === null`)).toBe(true);
      await k.d.key("Escape");
      await k.until(`!document.querySelector(".sheet")`);
      expect(await lock()).toEqual(FREE);
    });

    test("a confirm whose box is taken out from under it: the question ends as no, and the page lets go", async () => {
      await load("");
      await ev(`(async () => {
        const { ask } = await import("/src/client/core/sheet.js");
        window.__said = "waiting";
        ask({ text: "Sure?", yes: "YES" }).then((a) => { window.__said = a; });
      })()`);
      await k.until(`!!document.querySelector(".confirm.sheet")`);
      await ev(`document.querySelector(".confirm").remove()`);
      await k.until(`window.__said === false`);
      expect(await lock()).toEqual(FREE);
    });

    test("a sheet with nothing wrong stays through a push: only leaving closes it", async () => {
      await comments(`#brief/${one}`);
      await press("[data-comments-toggle]");
      await k.until(`!!document.querySelector(".cmount.sheet")`);
      await k.server.post("/api/asks", { title: "Pushed while the sheet was up", kind: "action", lane: "golf" });
      await Bun.sleep(600);
      expect(await ev(`!!document.querySelector(".cmount.sheet")`)).toBe(true);
      await k.d.key("Escape");
      await k.until(`!document.querySelector(".sheet")`);
    });

    // ---- Esc that belongs to an input method ----

    test("Esc while an input method composes: the sheet stays and nothing behind hears it", async () => {
      await load("");
      await menu("#menuTell", ".tell");
      const send = (composing: boolean, code: number) => ev(`(() => { const b = document.getElementById("noteText"); b.focus(); let behind = 0; const hear = () => { behind++; }; document.addEventListener("keydown", hear); const e = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: ${code}, isComposing: ${composing}, bubbles: true, cancelable: true }); b.dispatchEvent(e); document.removeEventListener("keydown", hear); return { behind, kept: !e.defaultPrevented }; })()`);
      expect(await send(true, 27)).toEqual({ behind: 0, kept: true });
      // Safari ends the composition first: the key then comes with isComposing off and keyCode 229.
      expect(await send(false, 229)).toEqual({ behind: 0, kept: true });
      await Bun.sleep(100);
      expect(await ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
      await send(false, 27);
      await k.until(`!document.querySelector(".tell.sheet")`);
    });

    test("no page errors", () => expect(browser.errors.filter((e) => !/fonts\.|net::ERR_ABORTED|ERR_BLOCKED|Failed to fetch|Load failed|ResizeObserver loop/.test(e))).toEqual([]));
  });
}
