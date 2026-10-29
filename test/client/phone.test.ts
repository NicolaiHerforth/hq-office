// The page on a phone, in Chrome at 390x664 with touch, against a temporary server: no zoom (the viewport forbids
// it, every text field is 16px or more); the page scrolls between sections, while MESSAGES has a bounded height and
// scrolls inside itself. MESSAGES opens at its newest message and stays there; a live update or a reply keeps the
// place of what you read. Needs Chrome; skipped without it.
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
// The newest message shows: inside the thread's view and on the screen.
const lastInView = () => page.evaluate(`(() => { const r = ${LAST}.getBoundingClientRect(), v = document.getElementById("msgs").getBoundingClientRect();
  return r.top >= Math.max(0, v.top) - 1 && r.bottom <= Math.min(innerHeight, v.bottom) + 1; })()`);
const topOf = (sel: string) => page.evaluate(`document.querySelector('${sel}').getBoundingClientRect().top`);
const scrollTopOf = (id: string) => page.evaluate(`document.getElementById("${id}").scrollTop`);
// Scroll a list that scrolls itself until an item is near the top of its view.
const scrollTo = (id: string, sel: string, offset: number) => page.evaluate(`(() => { const b = document.getElementById("${id}"), e = b.querySelector('${sel}');
  b.scrollTop += e.getBoundingClientRect().top - b.getBoundingClientRect().top - ${offset}; })()`);
const bounded = (id: string) => page.evaluate(`(() => { const b = document.getElementById("${id}"), s = getComputedStyle(b);
  return { overflowY: s.overflowY, overscroll: s.overscrollBehaviorY, clientH: b.clientHeight, scrollH: b.scrollHeight }; })()`);

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

test.skipIf(!chromeFound)("MESSAGES has a bounded height, scrolls itself and opens at the newest, with its tabs and Tell HQ on screen", async () => {
  await page.evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`document.querySelectorAll("#msgs [data-msg]").length > 20`);
  await settle();
  const b = await bounded("msgs");
  expect(b.overflowY).toBe("auto");
  expect(b.overscroll).toBe("contain");
  expect(b.scrollH).toBeGreaterThan(b.clientH);
  expect(b.clientH).toBeLessThanOrEqual(664 - 200);
  expect(await scrollTopOf("msgs")).toBeGreaterThan(0);
  expect(await lastInView()).toBe(true);
  expect(await page.evaluate(`document.getElementById("msgs").dataset.more`)).toBe("up");
  // the tabs and Tell HQ show with the thread, and the page still scrolls on to the room
  expect(await topOf("#qtabs")).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(`document.querySelector(".tell").getBoundingClientRect().bottom`)).toBeLessThanOrEqual(664);
  expect(await page.evaluate(`document.scrollingElement.scrollHeight > innerHeight`)).toBe(true);
});

test.skipIf(!chromeFound)("reading older messages, a live update and a reply above do not move them", async () => {
  await scrollTo("msgs", '[data-msg="u12"]', 60);
  await settle();
  const before = await topOf('#msgs [data-msg="u12"]'), top = await scrollTopOf("msgs");
  await server.post("/api/updates", { lane: "alpha", title: "Arrives while reading" });
  // a reply to an older message lands above what you read
  await server.post("/api/notes", { text: `re: #u2 ("Update 2") A reply above` });
  await until(`document.getElementById("msgs").textContent.includes("A reply above")`);
  await settle();
  expect(Math.abs((await topOf('#msgs [data-msg="u12"]')) - before)).toBeLessThan(1);
  expect(await scrollTopOf("msgs")).toBeGreaterThan(top); // the thread moved its own scroll to keep the place
});

test.skipIf(!chromeFound)("at the newest message, a new one stays in view", async () => {
  await page.evaluate(`document.getElementById("msgs").scrollTop = 1e6`);
  await settle();
  const pageY = await page.evaluate(`scrollY`);
  await server.post("/api/updates", { lane: "alpha", title: "Arrives at the bottom", body: "A longer one.\nWith a second line.\nAnd a third." });
  await until(`document.getElementById("msgs").textContent.includes("Arrives at the bottom")`);
  await settle();
  expect(await page.evaluate(`${LAST}.textContent.includes("Arrives at the bottom")`)).toBe(true);
  expect(await lastInView()).toBe(true);
  // the thread scrolled itself to its end; the page stayed where it was
  expect(await page.evaluate(`(() => { const b = document.getElementById("msgs"); return b.scrollHeight - b.scrollTop - b.clientHeight; })()`)).toBeLessThan(2);
  expect(await page.evaluate(`scrollY`)).toBe(pageY);
});

