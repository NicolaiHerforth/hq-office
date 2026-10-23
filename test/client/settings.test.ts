// The owner's settings in a real browser against a temporary server: settings remembered by a browser from before
// the server kept them are sent up once; after a cleared browser the server's settings come back; a change on the
// page reaches the server, and a change on the server reaches the page. Needs Chrome; skipped without it.
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
const serverSettings = async () => (await (await fetch(`${server.base}/api/settings`)).json()).settings;
const open = async () => {
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`document.getElementById("alerts")?.textContent.startsWith("SOUND") && !!document.getElementById("hud")?.innerHTML`);
};
const shownHero = () => page.evaluate(`(() => { const p = document.getElementById("settings"); if (p.hidden) document.getElementById("settingsBtn").click(); return document.querySelector('[data-set="hero"].on')?.dataset.val; })()`);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

afterAll(async () => {
  await server?.stop();
  chrome?.close();
});

test.skipIf(!chromeFound)("settings this browser remembered from before are sent up once", async () => {
  // A page of this origin that is not the office, to write what an older version left in local storage.
  await page.s("Page.navigate", { url: `${server.base}/api/settings` });
  await until(`document.readyState === "complete"`);
  await page.evaluate(`localStorage.setItem("hq-settings", JSON.stringify({ hero: "IVY", season: "winter", hat: "auto" })); localStorage.setItem("hq-sound", "1")`);
  expect(await serverSettings()).toEqual({});
  errors.length = 0; // that page's missing favicon
  await open();
  for (let i = 0; i < 100 && !Object.keys(await serverSettings()).length; i++) await Bun.sleep(50);
  expect(await serverSettings()).toEqual({ hero: "IVY", season: "winter", hat: "auto", sound: true, performance: "smooth" });
  expect(await page.evaluate(`document.getElementById("alerts").textContent`)).toBe("SOUND ON");
  await until(`localStorage.getItem("hq-sound") === null`);
  expect(await shownHero()).toBe("IVY");
});

test.skipIf(!chromeFound)("after the browser's data is cleared, the server's settings come back", async () => {
  await page.evaluate(`localStorage.clear()`);
  await open();
  await until(`document.getElementById("alerts").textContent === "SOUND ON"`);
  expect(await shownHero()).toBe("IVY");
  expect(await page.evaluate(`JSON.parse(localStorage.getItem("hq-settings")).season`)).toBe("winter");
  expect(await serverSettings()).toEqual({ hero: "IVY", season: "winter", hat: "auto", sound: true, performance: "smooth" });
});

test.skipIf(!chromeFound)("the server's settings win over a different copy in the browser", async () => {
  await page.evaluate(`localStorage.setItem("hq-settings", JSON.stringify({ hero: "MARA", season: "summer", hat: "none", sound: false }))`);
  await open();
  await until(`JSON.parse(localStorage.getItem("hq-settings")).hero === "IVY"`);
  expect(await shownHero()).toBe("IVY");
  expect((await serverSettings()).hero).toBe("IVY");
});

test.skipIf(!chromeFound)("a change on the page reaches the server, and one on the server reaches the page", async () => {
  await page.evaluate(`document.querySelector('[data-set="hero"][data-val="KENJI"]').click()`);
  for (let i = 0; i < 100 && (await serverSettings()).hero !== "KENJI"; i++) await Bun.sleep(50);
  expect((await serverSettings()).hero).toBe("KENJI");
  await page.evaluate(`document.getElementById("alerts").click()`);
  for (let i = 0; i < 100 && (await serverSettings()).sound !== false; i++) await Bun.sleep(50);
  expect((await serverSettings()).sound).toBe(false);
  await server.post("/api/settings", { settings: { hero: "MARA", sound: true } });
  await until(`document.querySelector('[data-set="hero"].on')?.dataset.val === "MARA" && document.getElementById("alerts").textContent === "SOUND ON"`);
  await page.evaluate(`document.querySelector("[data-reset]").click()`);
  for (let i = 0; i < 100 && (await serverSettings()).hero !== "YOU"; i++) await Bun.sleep(50);
  expect(await serverSettings()).toEqual({ hero: "YOU", season: "auto", hat: "auto", sound: false, performance: "smooth" });
  expect(errors).toEqual([]);
});
