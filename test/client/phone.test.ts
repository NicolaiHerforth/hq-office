// The page on a phone, in Chrome at 390x664 with touch, against a temporary server: no zoom (the viewport forbids
// it, every text field is 16px or more); one page scroll, MESSAGES included: a thumb on the thread moves the page.
// MESSAGES opens at its newest message and stays there; a live update or a reply keeps the place of what you read.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const settle = () => Bun.sleep(300);
const LAST = `[...document.querySelectorAll("#msgs [data-msg]")].pop()`;
// The newest message shows, on the screen.
const lastInView = () => page.evaluate(`(() => { const r = ${LAST}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })()`);
const topOf = (sel: string) => page.evaluate(`document.querySelector('${sel}').getBoundingClientRect().top`);
const pageY = () => page.evaluate(`scrollY`);
// A thumb dragging on the screen: up moves the page down.
const swipe = (x: number, y: number, by: number) => page.s("Input.synthesizeScrollGesture", { x, y, yDistance: by, gestureSourceType: "touch", speed: 3000 });

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  await server.post("/api/asks", { lane: "alpha", kind: "action", title: "One question" });
  for (let i = 1; i <= 24; i++) {
    await server.post("/api/updates", { lane: "alpha", title: `Update ${i}`, body: "Two lines of news.\nThe second line." });
    if (i % 3 === 0) await server.post("/api/notes", { text: `Note ${i}` });
  }
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 664, deviceScaleFactor: 3, mobile: true });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector(".ask")`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("no zoom: the viewport forbids it, and no text field is under 16px", async () => {
  const meta = await page.evaluate(`document.querySelector('meta[name="viewport"]').content`);
  expect(meta).toContain("maximum-scale=1");
  expect(meta).toContain("user-scalable=no");
  expect(await page.evaluate(`getComputedStyle(document.documentElement).touchAction`)).toBe("pan-x pan-y");
  const sizes: number[] = await page.evaluate(`[...document.querySelectorAll("textarea, input, select")].map((e) => parseFloat(getComputedStyle(e).fontSize))`);
  expect(sizes.length).toBeGreaterThan(1);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
});

test.skipIf(!chromeFound)("MESSAGES is the page's scroll: no inner box, it opens at the newest, TELL HQ right under it", async () => {
  await page.evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`document.querySelectorAll("#msgs [data-msg]").length > 20`);
  await page.evaluate(`document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => ok(true))))`);
  await settle();
  const box = await page.evaluate(`(() => { const b = document.getElementById("msgs"), s = getComputedStyle(b); return { y: s.overflowY, inner: b.scrollHeight > b.clientHeight + 1 }; })()`);
  expect(box).toEqual({ y: "visible", inner: false });
  expect(await lastInView()).toBe(true);
  expect(await topOf("#qtabs")).toBeGreaterThanOrEqual(0);
  const tell = await topOf(".tell"), end = await page.evaluate(`${LAST}.getBoundingClientRect().bottom`);
  expect(tell).toBeGreaterThanOrEqual(end);
});

test.skipIf(!chromeFound)("a thumb on the thread moves the page: all the way up to MENU and down to TELL HQ, and never stuck", async () => {
  await page.evaluate(`document.scrollingElement.scrollTop = 1e6`);
  await settle();
  // Upward from a thread in the middle of the screen, until the page is at its top.
  for (let i = 0; i < 40 && (await pageY()) > 0; i++) await swipe(195, 400, 500);
  expect(await pageY()).toBe(0);
  expect(await page.evaluate(`(() => { const r = document.getElementById("menuBtn").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  for (let i = 0; i < 40 && (await topOf(".tell")) > 500; i++) await swipe(195, 500, -500);
  expect(await topOf(".tell")).toBeLessThanOrEqual(500);
  // Back at the newest.
  await page.evaluate(`document.querySelector(".tell").scrollIntoView({ block: "end", behavior: "instant" })`);
  await settle();
}, 60_000);

test.skipIf(!chromeFound)("at the newest message, a reflow keeps it in view; reading older ones, it leaves them be", async () => {
  await page.evaluate(`${LAST}.scrollIntoView({ block: "end", behavior: "instant" })`);
  await settle();
  // Taller lines arrive with no scroll event, as when the fonts land after the thread opened.
  await page.evaluate(`document.head.insertAdjacentHTML("beforeend", '<style id="late">#msgs .msg { padding-bottom: 24px; }</style>')`);
  await settle();
  expect(await lastInView()).toBe(true);
  await page.evaluate(`document.getElementById("late").remove()`);
  await settle();
  // A real thumb moves off the end: the same reflow now leaves the newest message below the screen.
  await swipe(195, 300, 700);
  await settle();
  expect(await lastInView()).toBe(false);
  await page.evaluate(`document.head.insertAdjacentHTML("beforeend", '<style id="late">#msgs .msg { padding-bottom: 24px; }</style>')`);
  await settle();
  expect(await lastInView()).toBe(false);
  await page.evaluate(`document.getElementById("late").remove()`);
  await settle();
});

test.skipIf(!chromeFound)("reading older messages, a live update and a reply above do not move them", async () => {
  await page.evaluate(`document.querySelector('#msgs [data-msg="u12"]').scrollIntoView({ block: "center", behavior: "instant" })`);
  await settle();
  const before = await topOf('#msgs [data-msg="u12"]');
  await server.post("/api/updates", { lane: "alpha", title: "Arrives while reading" });
  // a reply to an older message lands above what you read
  await server.post("/api/notes", { text: `re: #u2 ("Update 2") A reply above` });
  await until(`document.getElementById("msgs").textContent.includes("A reply above")`);
  await settle();
  expect(Math.abs((await topOf('#msgs [data-msg="u12"]')) - before)).toBeLessThan(1);
});

test.skipIf(!chromeFound)("at the newest message, a new one stays in view", async () => {
  await page.evaluate(`${LAST}.scrollIntoView({ block: "end", behavior: "instant" })`);
  await settle();
  await server.post("/api/updates", { lane: "alpha", title: "Arrives at the bottom", body: "A longer one.\nWith a second line.\nAnd a third." });
  await until(`document.getElementById("msgs").textContent.includes("Arrives at the bottom")`);
  await settle();
  expect(await page.evaluate(`${LAST}.textContent.includes("Arrives at the bottom")`)).toBe(true);
  expect(await lastInView()).toBe(true);
});
