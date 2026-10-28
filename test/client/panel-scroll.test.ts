// Clicking in a panel never moves it. The owner: "whenever I click an option in a dropdown in the questions menu, it
// sometimes slides away from the option". Clicking an option used to build the list again and put the focus back on
// the card's text box, and focus() scrolled the list to that box. Now an option changes the card in place, a rebuild
// (a new question arriving) keeps the list where it was, and focus goes back only to a field being typed in, without
// scrolling. Needs Chrome (CHROME_BIN); skipped without it.
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
const LONG = "A long question body that takes up room. ".repeat(14);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  for (let i = 1; i <= 6; i++) await server.post("/api/asks", { title: `Question ${i}`, kind: "decision", body: LONG, options: ["Yes", "No", "Later"], recommended: "Yes", lane: "golf" });
  page = await newSession(chrome.cdp, errors);
  // Web fonts arriving mid-test reflow the list: blocked, as in the other page tests, so what moves is the click.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`document.querySelectorAll("#hud .ask").length >= 6`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

// Scrolls the list so that an option sits near the bottom of the list's view, with its card's text box below it.
const SETUP = `(() => {
  const hud = document.getElementById("hud");
  const opt = [...hud.querySelectorAll('.ask .opt[data-opt="No"]')][3];
  hud.scrollTop += opt.getBoundingClientRect().bottom - hud.getBoundingClientRect().bottom + 30;
  return true;
})()`;
const where = `(() => { const hud = document.getElementById("hud"); const opt = [...hud.querySelectorAll('.ask .opt[data-opt="No"]')][3]; return { top: Math.round(hud.scrollTop), opt: Math.round(opt.getBoundingClientRect().top), sel: opt.classList.contains("sel") }; })()`;

test.skipIf(!chromeFound)("clicking an option leaves the list and the option where they were", async () => {
  await page.evaluate(SETUP);
  const before = await page.evaluate(where);
  // a real click: the button takes focus, as it does in Chrome
  const box = await page.evaluate(`(() => { const r = [...document.querySelectorAll('#hud .ask .opt[data-opt="No"]')][3].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await until(`${where}.sel === true`);
  await Bun.sleep(200);
  expect(await page.evaluate(where)).toEqual({ ...before, sel: true });
});

test.skipIf(!chromeFound)("a question arriving while an option has focus does not move the list", async () => {
  const before = await page.evaluate(where);
  await server.post("/api/asks", { title: "Question 7", kind: "decision", options: ["A", "B"], recommended: "A" });
  await until(`document.querySelectorAll("#hud .ask").length === 7`);
  await Bun.sleep(200);
  const after = await page.evaluate(where);
  expect(after.opt).toBe(before.opt); // the option you were on stays under the pointer
  expect(after.sel).toBe(true);
  expect(errors).toEqual([]);
});
