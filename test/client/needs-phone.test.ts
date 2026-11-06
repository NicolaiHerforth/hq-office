// The question panel's phone layout at 390x844, 360x780 and 430x932 with touch: nothing spills out of a card or
// sideways off the page whatever a question holds, everything to tap is at least 44 px, and a button pair is one
// height. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

setDefaultTimeout(40_000);
const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const WORD = "averyveryveryverylongwordwithoutanyspacesthatgoesonandonandonandon".repeat(2);
const TABLE = `| Region | Second column | Third column | Fourth column |\n|---|---|---|---|\n| ${WORD} | b | c | d |`;
const CODE = "```\nbun test --a-very-long-flag-that-does-not-wrap=" + "x".repeat(120) + "\n```";
const SHOTS = process.env.NEEDS_SHOTS;

describe.skipIf(!chromeFound)("the question panel on a phone", () => {
  let chrome: Awaited<ReturnType<typeof startChrome>>;
  let server: Awaited<ReturnType<typeof startServer>>;
  let page: Awaited<ReturnType<typeof newSession>>;
  const errors: string[] = [];
  const ev = (e: string) => page.evaluate(e);
  const until = async (expr: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${expr}`);
  };

  beforeAll(async () => {
    chrome = await startChrome();
    server = await startServer(ROOT);
    await server.post("/api/asks", { title: `A title with ${WORD} in it`, kind: "decision", lane: "a-lane-with-a-really-really-really-long-name-indeed", body: `${WORD}\n\n${CODE}\n\n${TABLE}`, options: ["Yes", `An option with ${WORD}`, "A plain option that is long enough to go over more than one line on a phone"], recommended: "Yes", link: "https://example.com/" });
    await server.post("/api/asks", { title: "Record the demo video", kind: "action", lane: "golf" });
    await server.post("/api/asks", { title: "The deploy went out", kind: "info", lane: "golf" });
    await server.post("/api/asks", { title: "Paste the keys", kind: "action", secrets: ["FIRST_KEY_WITH_A_VERY_LONG_NAME_INDEED_YES", "SECOND"] });
    const paged = await server.post("/api/asks", { title: "Pick one from the page", kind: "decision", options: ["A", "B"], page: `<title>A page with a long title that goes on</title><h1>Hello</h1>` });
    expect(paged.id).toBeGreaterThan(0);
    for (const name of ["golf"]) await server.post("/api/lanes", { name, machine: "local" });
    // Two-digit counts on the tabs, as on the morning this is for.
    for (let i = 6; i <= 85; i++) await server.post("/api/asks", { title: `Question ${i}`, kind: "info" });
    for (let i = 1; i <= 12; i++) await server.post("/api/updates", { lane: "golf", title: `Update ${i}` });
    page = await newSession(chrome.cdp, errors);
    await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }, 30_000);

  afterAll(async () => {
    await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
    await server?.stop();
    await chrome?.close();
  });

  for (const [width, height] of [[390, 844], [360, 780], [430, 932]]) {
    test(`${width}x${height}: no spill, 44 px to tap, one button height`, async () => {
      await page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 3, mobile: true });
      await page.s("Page.navigate", { url: `${server.base}/` });
      await until(`document.querySelectorAll("#hud .ask").length === 85 && !!document.getElementById("lastNote")?.innerHTML`);
      await Bun.sleep(400);
      if (SHOTS) {
        const { data } = await page.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: 1400, scale: 1 } });
        await Bun.write(join(SHOTS, `phone-${width}.png`), Buffer.from(data, "base64"));
      }
      expect(await ev(`scrollY`)).toBe(0);
      expect(await ev(`document.scrollingElement.scrollWidth`)).toBeLessThanOrEqual(width);

      const spills: string[] = await ev(`(() => {
        const out = [];
        for (const card of document.querySelectorAll("#hud .ask")) {
          const c = card.getBoundingClientRect();
          for (const el of card.querySelectorAll("*")) {
            if (el.closest("pre, .tablewrap, table, .tray")) continue;
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > c.right + 0.5 || r.left < c.left - 0.5)) out.push(el.tagName + "." + el.className + " " + Math.round(r.right - c.right));
          }
        }
        return out;
      })()`);
      expect(spills).toEqual([]);

      const small: string[] = await ev(`(() => {
        const targets = document.querySelectorAll("#qtabs .tab, #hud .ask .opt, #hud .ask .send, #hud .ask .notyet, #hud .ask .attach, #hud .ask .askstrip, #hud .ask .tag[data-select], #hud .ask a.tag");
        const out = [];
        for (const el of targets) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height < 44) out.push(el.tagName + "." + el.className + " " + Math.round(r.height));
        }
        return out;
      })()`);
      expect(small).toEqual([]);

      const pair = await ev(`(() => { const c = [...document.querySelectorAll("#hud .ask")].find((x) => x.querySelector(".notyet")); return [c.querySelector(".notyet").offsetHeight, c.querySelector(".send").offsetHeight]; })()`);
      expect(pair[0]).toBe(pair[1]);

      const tabs = await ev(`(() => { const q = document.getElementById("qtabs"), b = q.querySelector('[data-qtab="briefs"]').getBoundingClientRect(); return { right: b.right, edge: q.getBoundingClientRect().right, scrolls: q.scrollWidth - q.clientWidth }; })()`);
      expect(tabs.right).toBeLessThanOrEqual(tabs.edge + 0.5);
      expect(tabs.scrolls).toBeLessThanOrEqual(0);

      // a lane tag is a 44 px target that still looks like a tag, and its row does not grow by the difference
      const tag = await ev(`(() => { const t = document.querySelector('#hud .ask .tag.lane[data-select="golf"]'), s = getComputedStyle(t), row = t.closest(".meta"); return { box: t.offsetHeight, chip: t.offsetHeight - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth), row: row.offsetHeight }; })()`);
      expect(tag.box).toBeGreaterThanOrEqual(44);
      expect(tag.chip).toBeLessThanOrEqual(24);
      expect(tag.row).toBeLessThanOrEqual(32);

      // the row of where you are reads on the page's dark ground, in the theme under test
      const quiet = await ev(`(() => {
        const lum = (c) => { const [r, g, b] = c.match(/[0-9.]+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const s = getComputedStyle(document.getElementById("below")), a = lum(s.color), b = lum(s.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      })()`);
      expect(quiet).toBeGreaterThanOrEqual(4.5);

      // an option's text starts at its box's padding; the marker shows only once it is picked
      const gutter = await ev(`(() => {
        const o = [...document.querySelectorAll("#hud .ask .opt")].find((b) => !b.classList.contains("sel")), range = document.createRange();
        range.selectNodeContents(o);
        return { inset: range.getBoundingClientRect().left - o.getBoundingClientRect().left, marker: getComputedStyle(o, "::before").display };
      })()`);
      expect(gutter.inset).toBeLessThanOrEqual(13);
      expect(gutter.marker).toBe("none");
      await ev(`document.querySelector("#hud .ask .opt").click()`);
      const picked = await ev(`(() => { const s = getComputedStyle(document.querySelector("#hud .ask .opt.sel"), "::before"); return { display: s.display, hidden: s.color === "rgba(0, 0, 0, 0)" }; })()`);
      expect(picked).toEqual({ display: "block", hidden: false });
      await ev(`document.querySelector("#hud .ask .opt").click()`);

      // a pre scrolls inside its card, and a long title keeps its words on screen
      expect(await ev(`(() => { const p = document.querySelector("#hud .ask pre"); return !!p && p.getBoundingClientRect().right <= innerWidth; })()`)).toBe(true);
    });
  }

  test("no errors", () => { expect(errors).toEqual([]); });
});
