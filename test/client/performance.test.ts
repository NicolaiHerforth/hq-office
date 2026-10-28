// The PERFORMANCE setting in a real browser on the frozen clock: in an idle room (nobody walks, a question open)
// POWER SAVER presents no frames at all, BALANCED one a second, SMOOTH two; a choice in the SETTINGS panel switches
// the room at once, without a reload, and reaches the server. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { FREEZE, findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const DAY = Date.UTC(2026, 3, 20, 14, 0); // spring, no event: no weather
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
// Room frames: the loop is the page's only user of animation frames.
const COUNT = `(() => { window.__frames = 0; const raf = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => raf((t) => { window.__frames++; cb(t); }); })();`;
const serverSettings = async () => (await (await fetch(`${server.base}/api/settings`)).json()).settings;
// Frames presented over the next `seconds` of page time.
const framesOver = async (seconds: number) => {
  const a = await page.evaluate("window.__frames");
  await page.evaluate(`__hq.advance(${seconds * 10})`);
  return (await page.evaluate("window.__frames")) - a;
};
const choose = async (mode: string) => {
  await page.evaluate(`(() => { const p = document.getElementById("settings"); if (p.hidden) document.getElementById("settingsBtn").click(); document.querySelector('[data-set="performance"][data-val="${mode}"]').click(); })()`);
  for (let i = 0; i < 100 && (await serverSettings()).performance !== mode; i++) await Bun.sleep(50);
  expect((await serverSettings()).performance).toBe(mode);
  await page.evaluate("__hq.advance(1)"); // the frame the change wakes
};

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  // Nobody idle, so nobody runs errands: no one walks. One question open, so the hero does not dance.
  for (const name of ["alpha", "bravo", "charlie", "golf"]) await server.post("/api/lanes", { name, phase: name === "charlie" ? "waiting" : "running", title: name, machine: "local" });
  await server.post("/api/asks", { lane: "bravo", kind: "decision", title: "Ship it?", options: ["Yes", "No"], recommended: "Yes" });
  await server.post("/api/settings", { settings: { performance: "saver" } });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Web fonts load in real time: in a busy full run one can land late and repaint the room (an extra frame).
  // Block them, as the pixel harness does, and wait for any font loading to settle below.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: FREEZE });
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: COUNT });
  await page.s("Page.navigate", { url: `${server.base}/?season=spring#t=${DAY}` });
  for (let i = 0; i < 300 && !(await page.evaluate("!!window.__hq && window.__hq.ready()").catch(() => false)); i++) await Bun.sleep(50);
  await page.evaluate("document.fonts.ready.then(() => true)");
  await page.evaluate("__hq.advance(20)"); // the first frames: state, fonts
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("POWER SAVER presents no frames in an idle room", async () => {
  expect(await framesOver(30)).toBe(0);
});

test.skipIf(!chromeFound)("the choice switches the room at once and is saved on the server", async () => {
  await choose("balanced");
  expect(await framesOver(10)).toBe(10);
  await choose("smooth");
  expect(await framesOver(10)).toBe(20);
  await choose("saver");
  expect(await framesOver(10)).toBe(0);
  expect(errors).toEqual([]);
});
