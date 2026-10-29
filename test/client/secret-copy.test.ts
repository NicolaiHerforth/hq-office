// COPY on the SECRETS tab: one button per live secret puts its value on the clipboard on a click, and the value is
// never written into the page. Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const VALUE = "TEST_ONLY_CLIPBOARD_VALUE_91c2";
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  await fetch(`${server.base}/api/secrets`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ name: "REVIEW_LOGIN", value: VALUE, minutes: 60, by: "owner" }) });
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await chrome.cdp.send("Browser.grantPermissions", { origin: server.base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await page.s("Page.navigate", { url: `${server.base}/` });
  // MENU › SECRETS opens the panel over the office
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await page.evaluate(`document.getElementById("menuBtn").click()`);
  await page.evaluate(`document.getElementById("secretsBtn").click()`);
  await until(`!document.getElementById("secretsPanel").hidden`);
  await until(`!!document.querySelector('#secretList [data-secret-copy="REVIEW_LOGIN"]')`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("COPY puts the value on the clipboard, says so, and the page never holds it", async () => {
  // Toasts last 2.4 s: record each one as it appears, so a busy machine cannot miss it.
  await page.evaluate(`(() => { window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("toast")) window.__toasts.push(n.textContent); }).observe(document.body, { childList: true }); return true; })()`);
  const box = await page.evaluate(`(() => { const r = document.querySelector('#secretList [data-secret-copy="REVIEW_LOGIN"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await until(`window.__toasts.includes("COPIED REVIEW_LOGIN.")`, 15_000);
  expect(await page.evaluate(`navigator.clipboard.readText()`)).toBe(VALUE);
  expect(await page.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(VALUE)})`)).toBe(false);
  expect(await page.evaluate(`JSON.stringify({ ...localStorage, ...sessionStorage }).includes(${JSON.stringify(VALUE)})`)).toBe(false);
  const s = await (await fetch(`${server.base}/api/state`)).json();
  expect(s.events.some((e: any) => e.text === "copied REVIEW_LOGIN")).toBe(true);
  expect(errors).toEqual([]);
}, 20_000);
