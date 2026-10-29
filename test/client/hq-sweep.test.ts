// SETTINGS has an HQ SWEEP row: OFF by default, ON, the interval (20, 30 or 60 min) and the hours, saved on the
// server (they survive a restart), and a line with the last and the next nudge. Needs Chrome; skipped without it.
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
const row = `document.querySelector("#settings [data-sweep]")`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`document.getElementById("alerts")?.textContent.startsWith("SOUND") && !!document.getElementById("lastNote")?.innerHTML`);
  await page.evaluate(`document.getElementById("settingsBtn").click()`);
  await until(`!!${row}`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("off by default, with the interval and hours it would use", async () => {
  expect(await page.evaluate(`${row}.querySelector(".k").textContent`)).toBe("HQ SWEEP");
  expect(await page.evaluate(`${row}.querySelector('[data-sweep-on].on').dataset.sweepOn`)).toBe("false");
  expect(await page.evaluate(`${row}.querySelector('[data-sweep-min].on').dataset.sweepMin`)).toBe("20");
  expect(await page.evaluate(`${row}.querySelector("input[name=hours]").value`)).toBe("8-24");
  expect(await page.evaluate(`${row}.querySelector(".hint").textContent`)).toContain("Off");
});

test.skipIf(!chromeFound)("ON, an interval and hours are saved on the server as they are", async () => {
  await page.evaluate(`${row}.querySelector('[data-sweep-on="true"]').click()`);
  await until(`${row}.querySelector('[data-sweep-on="true"]').classList.contains("on")`);
  await page.evaluate(`${row}.querySelector('[data-sweep-min="30"]').click()`);
  await until(`${row}.querySelector('[data-sweep-min="30"]').classList.contains("on")`);
  await page.evaluate(`(() => { const f = ${row}; f.elements.hours.value = "9-18"; f.requestSubmit(); })()`);
  for (let i = 0; i < 100 && (await serverSettings()).hqSweepHours !== "9-18"; i++) await Bun.sleep(50);
  expect(await serverSettings()).toMatchObject({ hqSweep: true, hqSweepMinutes: 30, hqSweepHours: "9-18" });
  // the row follows the server's state as it streams in
  await until(`${row}.querySelector(".hint").textContent.includes("every 30 min from 09:00 to 18:00")`);
});

test.skipIf(!chromeFound)("hours that are not a window are refused on the page", async () => {
  await page.evaluate(`(() => { const f = ${row}; f.elements.hours.value = "late"; f.requestSubmit(); })()`);
  await Bun.sleep(300);
  expect((await serverSettings()).hqSweepHours).toBe("9-18");
  expect(errors).toEqual([]);
});
