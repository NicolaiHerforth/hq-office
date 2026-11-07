// What a sheet owes the keyboard and what closes it, with real input at a phone's size and in a narrow window: nothing
// behind a sheet takes the focus, focus goes in and comes back, TELL HQ only goes away when the words went, MESSAGES and
// back lands on the card you left, one confirm at a time, and a sheet that is done with leaves nothing behind.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome, startChrome } from "../../scripts/room-hash.ts";
import { openPhone, openSurface, startOffice, SURFACES, type Office, type Tab } from "../mobile-walk.ts";

setDefaultTimeout(120_000);
const ROOT = join(import.meta.dir, "..", "..");
const NO_CHROME = !findChrome();
const KEYS: Record<string, number> = { Tab: 9, Enter: 13, Escape: 27 };

// The window: a finger at a phone's size, a mouse otherwise. `go` in SURFACES only says tap.
async function openWindow(chrome: Awaited<ReturnType<typeof startChrome>>, errors: string[], width: number, height: number, touch: boolean) {
  const t = await openPhone(chrome, errors);
  await t.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: touch ? 3 : 1, mobile: touch });
  await t.s("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  const at = async (x: number, y: number) => {
    if (touch) return t.tapAt(x, y);
    await t.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await t.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await t.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await Bun.sleep(120);
  };
  const spot = (sel: string, scroll: boolean) => t.ev(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0);
    if (!e) return "not shown";
    ${scroll ? `e.scrollIntoView({ block: "center", behavior: "instant" });` : ""}
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit) || hit.contains(e)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  const press = async (sel: string, scroll = true) => {
    await t.until(`[...document.querySelectorAll(${JSON.stringify(sel)})].some((x) => x.getBoundingClientRect().width > 0)`, 30_000);
    const p = await spot(sel, scroll);
    if (!Array.isArray(p)) throw new Error(`cannot press ${sel}: ${p}`);
    await at(p[0], p[1]);
  };
  const key = async (name: string, shift = false) => {
    const base = { key: name, code: name, windowsVirtualKeyCode: KEYS[name], modifiers: shift ? 8 : 0, text: name === "Enter" ? "\r" : undefined };
    await t.s("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await t.s("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await Bun.sleep(40);
  };
  const type = (text: string) => t.s("Input.insertText", { text });
  // Bring a card's title to `below` px under the top of the screen with real scroll input.
  const scrollCard = async (id: number, below: number) => {
    for (let i = 0; i < 80; i++) {
      const dy = (await t.ev(`document.querySelector('#hud > .ask[data-ask="${id}"] h3').getBoundingClientRect().top`)) - below;
      if (Math.abs(dy) < 3) return;
      if (touch) await t.s("Input.synthesizeScrollGesture", { x: width / 2, y: height / 2, yDistance: -dy, gestureSourceType: "touch", speed: 12000, preventFling: true });
      else await t.s("Input.dispatchMouseEvent", { type: "mouseWheel", x: width / 2, y: height / 2, deltaX: 0, deltaY: dy });
      await Bun.sleep(100);
    }
    throw new Error(`could not scroll to card ${id}`);
  };
  // Each wait here ends at the page's word; ms only stops one that never will, and a run has fifteen minutes.
  const until = async (expr: string, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (await t.ev(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${expr}`);
  };
  return { ...t, until, tap: press, press, key, type, at, scrollCard, width, height, touch };
}

describe.skipIf(NO_CHROME)("sheets and the keyboard", () => {
  let chrome: Awaited<ReturnType<typeof startChrome>>, office: Office;
  const errors: string[] = [];
  beforeAll(async () => {
    office = await startOffice(ROOT);
    chrome = await startChrome();
  }, 120_000);
  afterAll(async () => { await chrome?.close(); await office?.stop(); });

  const sheets = SURFACES.filter((s) => s.sheet);
  // What had the focus before the sheet, in the narrow window, where a click focuses a button.
  const OPENER: Record<string, string> = {
    "floor-list": "[data-pill]", "floor-add": "[data-pill]", "floor-edit": "[data-pill]", "agent-drawer": "[data-lane-pick]", "new-room": ".rnew",
    "page-comments": ".pageview [data-comments-toggle]", menu: "#menuBtn", secrets: "#menuBtn", settings: "#menuBtn", subs: "#subsBtn", "tell-sheet": "#menuBtn",
    "close-room-confirm": "[data-room-close]", "secret-delete-confirm": "[data-secret-rm]", "brief-comment-sheet": ".bvbar [data-comments-toggle]", export: ".bvbar [data-export]",
  };
  const label = `(() => { const a = document.activeElement; return a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (typeof a.className === "string" && a.className ? "." + a.className.split(" ")[0] : ""); })()`;

  for (const [name, width, height, touch] of [["390 touch", 390, 844, true], ["600 mouse", 600, 800, false]] as const) {
    describe(name, () => {
      let t: Awaited<ReturnType<typeof openWindow>>;
      beforeAll(async () => { t = await openWindow(chrome, errors, width, height, touch); });
      afterAll(async () => { await t.s("Page.navigate", { url: "about:blank" }); });

      for (const s of sheets) {
        test(`${s.name}: the focus goes in and Tab never reaches what is behind it`, async () => {
          await openSurface(t as unknown as Tab, office, s);
          const top = `[...document.querySelectorAll(${JSON.stringify(s.sheet)})].filter((e) => e.getBoundingClientRect().width > 0).at(-1)`;
          expect(await t.ev(`${top}.contains(document.activeElement)`)).toBe(true);
          const behind: string[] = [];
          let inside = 0;
          for (const shift of [false, true]) {
            for (let i = 0; i < 24; i++) {
              await t.key("Tab", shift);
              const where = await t.ev(`(() => { const a = document.activeElement; return a === document.body ? "nowhere" : ${top}.contains(a) ? "inside" : ${label}; })()`);
              if (where === "inside") inside++;
              else if (where !== "nowhere") behind.push(where);
            }
          }
          expect(behind).toEqual([]);
          // SUBS only shows numbers: nothing in it to tab to, and the focus on the sheet itself.
          if (s.name !== "subs") expect(inside).toBeGreaterThan(0);
        });

        if (!touch) test(`${s.name}: Esc closes it and the focus goes back to what opened it`, async () => {
          await openSurface(t as unknown as Tab, office, s);
          await t.key("Escape");
          await t.until(`![...document.querySelectorAll(${JSON.stringify(s.sheet)})].some((e) => e.getBoundingClientRect().width > 0 && e.classList.contains("sheet"))`);
          expect(await t.ev(`document.activeElement.matches(${JSON.stringify(OPENER[s.name])})`) ? "back" : await t.ev(label)).toBe("back");
        });
      }

      test("the drawer over a TO DO: Tab reaches nothing of it, so Enter cannot answer it", async () => {
        const id = (await office.post("/api/asks", { lane: "ops-tls", kind: "action", title: `A TO DO at ${width}` })).id;
        await t.load(office.base, "", {});
        const open = () => fetch(`${office.base}/api/state`).then((r) => r.json()).then((j) => j.open.some((a: { id: number }) => a.id === id));
        await t.press(`#hud > .ask[data-ask="${id}"] .meta [data-select]`);
        await t.until(`!!document.querySelector("#card.sheet")`);
        for (let i = 0; i < 16; i++) {
          await t.key("Tab");
          if (await t.ev(`!!document.activeElement.closest('#hud .send')`)) await t.key("Enter");
        }
        await Bun.sleep(200);
        expect(await open()).toBe(true);
      });

      test("a stacked confirm: the sheet under it takes no focus either, and closing it goes back to DELETE", async () => {
        await t.load(office.base, "", {});
        await t.press("#menuBtn");
        await t.press("#secretsBtn");
        await t.press("[data-secret-rm]");
        await t.until(`!!document.querySelector(".confirm.sheet")`);
        const trail: boolean[] = [];
        for (let i = 0; i < 10; i++) { await t.key("Tab"); trail.push(await t.ev(`document.activeElement === document.body || !!document.activeElement.closest(".confirm")`)); }
        expect(trail).not.toContain(false);
        await t.key("Escape");
        await t.until(`!document.querySelector(".confirm:not([hidden])")`);
        expect(await t.ev(`!!document.querySelector("#secretsPanel.sheet")`)).toBe(true);
        expect(await t.ev(`document.activeElement.closest("#secretsPanel") !== null`)).toBe(true);
      });

      test("a panel that moves while it is open, into another part of the page: the scrim and what is shut out go with it", async () => {
        await t.load(office.base, "", {});
        const moved = await t.ev(`import("/src/client/core/sheet.js").then(async (m) => {
          const wait = () => new Promise((ok) => setTimeout(ok, 50));
          const el = document.createElement("div");
          el.hidden = true;
          el.innerHTML = "<button id=inMoved>IN IT</button>";
          document.body.append(el);
          m.sheet(el, () => { el.hidden = true; });
          el.hidden = false;
          await wait();
          const old = document.querySelector(".wrap").inert;
          document.querySelector(".stage").append(el);
          await wait();
          const out = { scrim: el.previousElementSibling?.className, oldInert: old, inert: [...document.querySelector(".stage").children].filter((k) => k !== el && !k.classList.contains("sheetbg")).every((k) => k.inert), bodyKept: !document.querySelector(".wrap").inert, sheet: el.classList.contains("sheet") };
          window.__moved = el;
          return out;
        })`);
        expect(moved).toMatchObject({ scrim: "sheetbg", oldInert: true, inert: true, sheet: true });
        const trail: string[] = [];
        for (let i = 0; i < 8; i++) { await t.key("Tab"); trail.push(await t.ev(`document.activeElement === document.body || window.__moved.contains(document.activeElement) ? "ok" : ${label}`)); }
        expect(trail.filter((x) => x !== "ok")).toEqual([]);
        await t.ev(`window.__moved.hidden = true; undefined`);
        await t.until(`!document.querySelector(".sheet") && !document.querySelector("[inert]")`);
      });

      test("from MENU, what the next sheet focuses takes the focus: SECRETS' name, TELL HQ's box, a new floor's name", async () => {
        await t.load(office.base, "", {});
        await t.press("#menuBtn");
        await t.press("#secretsBtn");
        await t.until(`!!document.querySelector("#secretsPanel.sheet")`);
        expect(await t.ev(`document.activeElement.id`)).toBe("secName");
        await t.key("Escape");
        await t.until(`!document.querySelector(".sheet")`);
        await t.press("#menuBtn");
        await t.press("#menuTell");
        await t.until(`!!document.querySelector(".tell.sheet")`);
        expect(await t.ev(`document.activeElement.id`)).toBe("noteText");
        await t.key("Escape");
        await t.until(`!document.querySelector(".sheet")`);
        await t.press("[data-pill]");
        await t.press("[data-floor-add]");
        await t.until(`!!document.querySelector(".fpanel.sheet")`);
        expect(await t.ev(`document.activeElement.name`)).toBe("name");
      });

      test("from MENU, SUBS opens and stays open", async () => {
        await t.load(office.base, "", {});
        await t.press("#menuBtn");
        await t.press("#menuSubs");
        await t.until(`!!document.querySelector("#subsDrop.sheet")`);
        await Bun.sleep(400);
        expect(await t.ev(`!!document.querySelector("#subsDrop.sheet")`)).toBe(true);
      });

      test("TELL HQ: Esc closes it and keeps the words", async () => {
        await t.load(office.base, "", {});
        await t.press("#menuBtn");
        await t.press("#menuTell");
        await t.until(`!!document.querySelector(".tell.sheet")`);
        await t.type("Words kept over Esc");
        await t.key("Escape");
        await t.until(`!document.querySelector(".tell.sheet")`);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("Words kept over Esc");
      });

      const openTell = async () => {
        await t.load(office.base, "", {});
        await t.press("#menuBtn");
        await t.press("#menuTell");
        await t.until(`!!document.querySelector(".tell.sheet")`);
        await t.rest();
      };
      test("a picture's preview over the sheet takes the taps and Esc, and the sheet is still there after", async () => {
        await openTell();
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        await t.ev(`import("/src/client/images/images.js").then((m) => m.addFiles([new File([Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0))], "a.png", { type: "image/png" })], "note"))`);
        await t.press(".tell [data-chip-open]");
        await t.until(`!!document.querySelector("dialog.preview[open]")`);
        expect(await t.ev(`document.getElementById("imgPreview").inert`)).toBe(false);
        await t.key("Escape");
        await t.until(`!document.querySelector("dialog.preview[open]")`);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        await t.press(".tell [data-chip-open]");
        await t.until(`!!document.querySelector("dialog.preview[open]")`);
        await t.press(".pclose");
        await t.until(`!document.querySelector("dialog.preview[open]")`);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
      });

      const notes = () => fetch(`${office.base}/api/state`).then((r) => r.json()).then((j) => j.notes.map((n: { text: string }) => n.text));

      test("TELL HQ: an empty SEND stays open and says so", async () => {
        await openTell();
        await t.press(".tell .send");
        await t.until(`!!document.querySelector(".toast")`);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        expect(await t.ev(`document.querySelector(".toast").textContent`)).toMatch(/NOTHING TO SEND/);
      });

      test("TELL HQ: a failed send keeps the sheet and the words, and says so", async () => {
        await openTell();
        await t.type("Words that fail to send");
        await t.s("Network.enable");
        await t.s("Network.setBlockedURLs", { urls: ["*/api/notes*"] });
        await t.press(".tell .send");
        await t.until(`!!document.querySelector(".toast")`);
        await t.s("Network.setBlockedURLs", { urls: [] });
        const seen = await t.ev(`(() => { const s = document.querySelector(".tell"), o = document.querySelector(".toast"), r = o.getBoundingClientRect(), z = (e) => Number(getComputedStyle(e).zIndex) || 0; return { open: s.classList.contains("sheet"), words: document.getElementById("noteText").value, says: o.textContent, onScreen: r.top >= 0 && r.bottom <= innerHeight, overIt: z(o) > z(s) }; })()`);
        expect(seen).toMatchObject({ open: true, words: "Words that fail to send", onScreen: true, overIt: true });
        expect(seen.says).toMatch(/NOT SENT/);
      });

      test("TELL HQ: a picture still uploading keeps the sheet and says so, and the words go when it is up", async () => {
        await openTell();
        await t.type("Words with a picture");
        await t.ev(`(() => { const real = window.fetch; window.__letGo = null; window.fetch = (u, o) => String(u).includes("/api/uploads") ? new Promise((ok) => { window.__letGo = () => ok(real(u, o)); }) : real(u, o); })()`);
        // Not awaited: the upload it starts is held back on purpose.
        await t.ev(`(import("/src/client/images/images.js").then((m) => m.addFiles([new File([new Uint8Array(4)], "a.png", { type: "image/png" })], "note")), undefined)`);
        await t.until(`!!window.__letGo`);
        const before = (await notes()).length;
        await t.press(".tell .send");
        await t.until(`!!document.querySelector(".toast")`);
        expect(await t.ev(`document.querySelector(".toast").textContent`)).toMatch(/STILL UPLOADING/);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        expect((await notes()).length).toBe(before);
        await t.ev(`window.__letGo(); undefined`);
      });

      // The newest is the one on top.
      const toast = () => t.ev(`[...document.querySelectorAll(".toast")].at(-1)?.textContent ?? ""`);
      test("TELL HQ: SEND with words sends once however often it is pressed, and then it closes", async () => {
        await openTell();
        const said = `Sent once at ${width}`;
        await t.type(said);
        await t.ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes("/api/notes") ? new Promise((ok) => setTimeout(() => ok(real(u, o)), 300)) : real(u, o); })()`);
        await t.press(".tell .send");
        await t.press(".tell .send");
        await t.until(`!document.querySelector(".tell.sheet")`);
        await Bun.sleep(200);
        expect((await notes()).filter((n: string) => n === said).length).toBe(1);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("");
        expect(await toast()).toMatch(/HQ/);
      });

      // A send held at the door until let go, so what happens during it is what the test says, not a race.
      const holdSend = () => t.ev(`(() => { const real = window.fetch; window.__sent = null; window.fetch = (u, o) => String(u).includes("/api/notes") && o?.method === "POST" ? new Promise((ok, no) => { window.__sent = () => ok(real(u, o)); window.__refuse = () => no(new TypeError("Failed to fetch")); }) : real(u, o); })()`);
      const backInBox = async () => { await t.press("#noteText"); await t.ev(`(() => { const b = document.getElementById("noteText"); b.setSelectionRange(b.value.length, b.value.length); })()`); };

      test("TELL HQ: words typed while it sends stay, with the sheet, and a second SEND says it is still sending", async () => {
        await openTell();
        const said = `First part at ${width}`;
        await t.type(said);
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await backInBox();
        await t.type(" and what I typed while it went");
        await t.press(".tell .send");
        await t.until(`([...document.querySelectorAll(".toast")].at(-1)?.textContent ?? "").includes("STILL SENDING THE LAST ONE")`);
        await t.ev(`window.__sent(); undefined`);
        await t.until(`(document.querySelector(".toast")?.textContent ?? "").includes("SENT")`);
        expect(await toast()).toMatch(/STILL HERE/);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("and what I typed while it went");
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        expect((await notes()).filter((n: string) => n === said).length).toBe(1);
      });

      test("TELL HQ: SEND, Esc, reopen and start a new note: the first send's return leaves the new note and the sheet alone", async () => {
        await openTell();
        await t.type(`Gone first at ${width}`);
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await t.key("Escape");
        await t.until(`!document.querySelector(".tell.sheet")`);
        await t.press("#menuBtn");
        await t.press("#menuTell");
        await t.until(`!!document.querySelector(".tell.sheet")`);
        await t.rest();
        await t.ev(`(() => { const b = document.getElementById("noteText"); b.value = ""; b.focus(); })()`);
        await t.type("A new note");
        await t.ev(`window.__sent(); undefined`);
        await t.until(`(document.querySelector(".toast")?.textContent ?? "").includes("SENT")`);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("A new note");
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
      });

      test("TELL HQ: an edit of what is being sent is never cut: the box is left as it is, and says so", async () => {
        await openTell();
        await t.type("Words as sent");
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await t.ev(`(() => { const b = document.getElementById("noteText"); b.value = "Words now changed"; })()`);
        await t.ev(`window.__sent(); undefined`);
        await t.until(`(document.querySelector(".toast")?.textContent ?? "").includes("SENT")`);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("Words now changed");
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
      });

      test("TELL HQ: what went is cleared, a picture attached while it sends stays", async () => {
        await openTell();
        await t.type("With a first picture");
        const add = (name: string) => t.ev(`(import("/src/client/images/images.js").then((m) => m.addFiles([new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], ${JSON.stringify(name)}, { type: "image/png" })], "note")), undefined)`);
        const tray = () => t.ev(`[...document.querySelectorAll('[data-chips="note"] .chip')].length`);
        await add("first.png");
        await t.until(`document.querySelectorAll('[data-chips="note"] .chip').length === 1`);
        await t.until(`(async () => (await import("/src/client/images/images.js")).notReady("note") === "")()`);
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await add("second.png");
        await t.until(`document.querySelectorAll('[data-chips="note"] .chip').length === 2`);
        await t.until(`(async () => (await import("/src/client/images/images.js")).notReady("note") === "")()`);
        await t.ev(`window.__sent(); undefined`);
        await t.until(`(document.querySelector(".toast")?.textContent ?? "").includes("SENT")`);
        expect(await tray()).toBe(1);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("");
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        await t.ev(`(async () => (await import("/src/client/images/images.js")).clearImages("note"))()`);
      });

      test("TELL HQ: Esc while sending, and it went: the box is empty and stays shut", async () => {
        await openTell();
        await t.type("Left it to send");
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await t.key("Escape");
        await t.until(`!document.querySelector(".tell.sheet")`);
        await t.ev(`window.__sent(); undefined`);
        await t.until(`document.getElementById("noteText").value === ""`);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(false);
      });

      test("TELL HQ: Esc while sending, and it failed: the toast says TELL HQ has the words, and it does", async () => {
        await openTell();
        await t.type("Words that fail behind the sheet");
        await holdSend();
        await t.press(".tell .send");
        await t.until(`!!window.__sent`);
        await t.key("Escape");
        await t.until(`!document.querySelector(".tell.sheet")`);
        await t.ev(`window.__refuse(); undefined`);
        await t.until(`(document.querySelector(".toast")?.textContent ?? "").includes("NOT SENT")`);
        expect(await toast()).toMatch(/TELL HQ HAS/);
        expect(await toast()).not.toMatch(/STILL HERE/);
        expect(await t.ev(`document.getElementById("noteText").value`)).toBe("Words that fail behind the sheet");
      });

      test("Esc while a real input method composes: the sheet stays; the next Esc closes it", async () => {
        await openTell();
        await t.s("Input.imeSetComposition", { text: "´", selectionStart: 1, selectionEnd: 1 });
        await t.key("Escape");
        await Bun.sleep(100);
        expect(await t.ev(`!!document.querySelector(".tell.sheet")`)).toBe(true);
        await t.s("Input.insertText", { text: "x" });
        await t.ev(`document.getElementById("noteText").value = ""`);
        await t.key("Escape");
        await t.until(`!document.querySelector(".tell.sheet")`);
      });
    });
  }

  describe("MESSAGES and back", () => {
    const ids: number[] = [];
    beforeAll(async () => {
      for (let i = 1; i <= 40; i++) ids.push((await office.post("/api/asks", { lane: "ops-tls", kind: "decision", title: `Round trip ${i}`, options: ["Yes", "No"] })).id);
    });
    const top = (id: number) => `document.querySelector('#hud > .ask[data-ask="${id}"] h3').getBoundingClientRect().top`;
    const box = (id: number) => `#hud > .ask[data-ask="${id}"] textarea`;

    describe("390 touch", () => {
      let t: Awaited<ReturnType<typeof openWindow>>;
      beforeAll(async () => { t = await openWindow(chrome, errors, 390, 844, true); await t.load(office.base, "", {}); await t.until(`document.querySelectorAll("#hud > .ask").length > 40`); await t.rest(); });
      afterAll(async () => { await t.s("Page.navigate", { url: "about:blank" }); });

      for (const n of [16, 39]) test(`card ${n} comes back within 1 px, its draft with it`, async () => {
        const id = ids[n - 1];
        await t.scrollCard(id, 200);
        await t.press(box(id));
        await t.until(`document.activeElement === document.querySelector(${JSON.stringify(box(id))})`);
        await t.type(`A draft on ${n}`);
        await t.ev(`document.activeElement.blur()`);
        await t.scrollCard(id, 200);
        await Bun.sleep(300);
        const was = await t.ev(top(id));
        await t.press('[data-qtab="messages"]', false);
        await t.until(`!document.getElementById("msgs").hidden`);
        await Bun.sleep(300);
        await t.press('[data-qtab="questions"]', false);
        await t.until(`!document.getElementById("hud").hidden`);
        await Bun.sleep(400);
        expect(Math.abs((await t.ev(top(id))) - was)).toBeLessThanOrEqual(1);
        expect(await t.ev(`document.querySelector(${JSON.stringify(box(id))}).value`)).toContain(`A draft on ${n}`);
      });

      test("something arriving above while you read MESSAGES does not move it", async () => {
        const id = ids[19];
        await t.scrollCard(id, 200);
        await Bun.sleep(200);
        const was = await t.ev(top(id));
        await t.press('[data-qtab="messages"]', false);
        await t.until(`!document.getElementById("msgs").hidden`);
        await office.post("/api/asks", { lane: "ops-tls", kind: "decision", title: "New and due, sorts first", options: ["Yes"], due: Date.now() + 3600_000 });
        await Bun.sleep(500);
        await t.press('[data-qtab="questions"]', false);
        await t.until(`!document.getElementById("hud").hidden`);
        await Bun.sleep(400);
        expect(Math.abs((await t.ev(top(id))) - was)).toBeLessThanOrEqual(1);
      });

      test("the card closed while you were away: the one after it is there, not the top of the list", async () => {
        const id = ids[24];
        await t.scrollCard(id, 60);
        await Bun.sleep(200);
        await t.press('[data-qtab="messages"]', false);
        await t.until(`!document.getElementById("msgs").hidden`);
        await office.post(`/api/asks/${id}/withdraw`, { reason: "gone" });
        await Bun.sleep(500);
        await t.press('[data-qtab="questions"]', false);
        await t.until(`!document.getElementById("hud").hidden`);
        await Bun.sleep(400);
        expect(await t.ev(`scrollY`)).toBeGreaterThan(1000);
      });
    });

    describe("600 mouse", () => {
      let t: Awaited<ReturnType<typeof openWindow>>;
      beforeAll(async () => { t = await openWindow(chrome, errors, 600, 800, false); await t.load(office.base, "", {}); await t.until(`document.querySelectorAll("#hud > .ask").length > 40`); await t.rest(); });
      afterAll(async () => { await t.s("Page.navigate", { url: "about:blank" }); });

      // The tabs do not stick here, so a mouse presses them only with them on screen.
      test("with the tabs just on screen, the page does not move", async () => {
        const up = await t.ev(`document.getElementById("qtabs").getBoundingClientRect().top`);
        await t.s("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 400, deltaX: 0, deltaY: up + 6 });
        await Bun.sleep(300);
        const place = `(() => { const c = [...document.querySelectorAll("#hud > .ask")].find((x) => x.getBoundingClientRect().bottom > 80); return [c.dataset.ask, c.getBoundingClientRect().top]; })()`;
        const [id, was] = await t.ev(place);
        await t.press('[data-qtab="messages"]', false);
        await t.until(`!document.getElementById("msgs").hidden`);
        await Bun.sleep(300);
        // MESSAGES opens at its newest, far from the tabs: only a keyboard or a script presses the tab from there.
        await t.ev(`document.querySelector('[data-qtab="questions"]').click()`);
        await t.until(`!document.getElementById("hud").hidden`);
        await Bun.sleep(400);
        const now = await t.ev(`document.querySelector('#hud > .ask[data-ask="${id}"]').getBoundingClientRect().top`);
        expect(Math.abs(now - was)).toBeLessThanOrEqual(1);
      });

      test("from deep in the list, pressed by a script: card 16 comes back within 1 px", async () => {
        const id = ids[15];
        await t.scrollCard(id, 200);
        await Bun.sleep(200);
        const was = await t.ev(top(id));
        await t.ev(`document.querySelector('[data-qtab="messages"]').click()`);
        await t.until(`!document.getElementById("msgs").hidden`);
        await Bun.sleep(300);
        await t.ev(`document.querySelector('[data-qtab="questions"]').click()`);
        await t.until(`!document.getElementById("hud").hidden`);
        await Bun.sleep(400);
        expect(Math.abs((await t.ev(top(id))) - was)).toBeLessThanOrEqual(1);
      });
    });
  });

  describe("1280 mouse", () => {
    let t: Awaited<ReturnType<typeof openWindow>>;
    beforeAll(async () => { t = await openWindow(chrome, errors, 1280, 800, false); });
    afterAll(async () => { await t.s("Page.navigate", { url: "about:blank" }); });
    const shown = `[...document.querySelectorAll(".confirm")].filter((e) => !e.hidden).length`;
    const NAME = "TWICE_DELETED";

    test("DELETE pressed twice: one confirm, and one yes ends it and deletes the secret", async () => {
      await office.post("/api/secrets", { name: NAME, value: "not-a-real-value", minutes: 5, by: "owner" });
      await t.load(office.base, "", {});
      await t.press("#menuBtn");
      await t.press("#secretsBtn");
      const row = `[data-secret-rm="${NAME}"]`;
      await t.press(row);
      await t.until(`${shown} === 1`);
      await t.press(row);
      await Bun.sleep(200);
      expect(await t.ev(shown)).toBe(1);
      await t.press(".confirm:not([hidden]) .confirmyes");
      await Bun.sleep(200);
      expect(await t.ev(`document.querySelectorAll(".confirm").length`)).toBe(0);
      await t.until(`!document.querySelector(${JSON.stringify(row)})`);
    });

    test("above the phone sizes a sheet changes nothing: no scrim, nothing inert, the focus left alone", async () => {
      await t.load(office.base, "", {});
      await t.press("#menuBtn");
      await t.until(`!document.getElementById("menuDrop").hidden`);
      expect(await t.ev(`({ inert: document.querySelectorAll("[inert]").length, scrim: document.querySelectorAll(".sheetbg").length, tab: document.getElementById("menuDrop").hasAttribute("tabindex") })`)).toEqual({ inert: 0, scrim: 0, tab: false });
    });
  });

  describe("a sheet that is done with", () => {
    let t: Awaited<ReturnType<typeof openWindow>>;
    // Every MutationObserver the page starts and what it watches, kept from before the first module runs.
    const SPY = `if (window === top) { const live = window.__watched = new Map(), O = window.MutationObserver; window.MutationObserver = class extends O { observe(el, o) { if (!live.has(this)) live.set(this, new Set()); live.get(this).add(el); return super.observe(el, o); } disconnect() { live.delete(this); return super.disconnect(); } }; }`;
    const watching = (sel: string) => `[...window.__watched.values()].filter((s) => [...s].some((e) => e.matches?.(${JSON.stringify(sel)}))).length`;
    let seed: { identifier: string };
    beforeAll(async () => {
      t = await openWindow(chrome, errors, 390, 844, true);
      seed = await t.s("Page.addScriptToEvaluateOnNewDocument", { source: SPY });
    });
    afterAll(async () => { await t.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: seed.identifier }); await t.s("Page.navigate", { url: "about:blank" }); });

    test("twenty confirms leave no watcher behind", async () => {
      await t.load(office.base, "", {});
      await t.ev(`import("/src/client/core/sheet.js").then(async (m) => { for (let i = 0; i < 20; i++) { const a = m.ask({ text: "?", yes: "YES" }); await new Promise((ok) => setTimeout(ok, 5)); document.querySelector(".confirm:not([hidden]) .confirmno").click(); await a; while (history.state?.hqSheet) await new Promise((ok) => setTimeout(ok, 5)); } })`);
      await Bun.sleep(100);
      expect(await t.ev(watching(".confirm"))).toBe(0);
    });

    test("a comment mount leaves no watcher behind once it has left the page", async () => {
      const other = (await office.post("/api/briefs", { title: "Another brief", body: "Short." }, "w3:p1")).id;
      const to = async (id: number) => {
        await t.ev(`location.hash = "#brief/${id}"; undefined`);
        await t.until(`!!document.querySelector('.cmount[data-comments="briefs/${id}"]')`);
      };
      await t.load(office.base, `#brief/${office.ids.brief}`, {});
      await t.until(`!!document.querySelector(".cmount[data-comments]")`);
      for (let i = 0; i < 4; i++) { await to(other); await to(office.ids.brief); }
      await Bun.sleep(100);
      expect(await t.ev(`[...window.__watched.values()].filter((s) => [...s].some((e) => e.matches?.(".cmount") && !e.isConnected)).length`)).toBeLessThanOrEqual(1);
    });

    test("sheet() gives back an off switch: open it lets go of the page, and a panel not yet attached stays registered", async () => {
      await t.load(office.base, "", {});
      const out = await t.ev(`import("/src/client/core/sheet.js").then(async (m) => {
        const wait = () => new Promise((ok) => setTimeout(ok, 50));
        const later = document.createElement("div");
        later.hidden = true;
        const offLater = m.sheet(later, () => { later.hidden = true; });
        await wait();
        document.body.append(later);
        later.hidden = false;
        await wait();
        const kept = later.classList.contains("sheet");
        const off = typeof offLater === "function";
        offLater?.();
        await wait();
        const gone = { kept, off, sheet: later.classList.contains("sheet"), lock: document.documentElement.classList.contains("sheetopen"), inert: document.querySelectorAll("[inert]").length };
        later.remove();
        offLater?.();
        return gone;
      })`);
      expect(out).toEqual({ kept: true, off: true, sheet: false, lock: false, inert: 0 });
    });
  });

  test("no page errors", () => expect(errors.filter((e) => !/fonts\.|net::ERR_ABORTED|ERR_BLOCKED|Failed to fetch/.test(e))).toEqual([]));
});
