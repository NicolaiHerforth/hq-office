// The brief view and the page view: BACK closes them whole, the comment thread included (it once stayed on screen);
// the thread is closed until COMMENTS in the bar opens it, a choice this browser keeps; FULL SCREEN shows the brief
// alone; NEW WINDOW opens it in a window of its own, beside a room or a lane. On a phone COMMENTS opens the thread's
// sheet. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-brief-controls-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
// On screen: laid out with a size, and not inside anything hidden.
const onScreen = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })()`;
async function load(hash: string, w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
// A real click (full screen needs one), at the middle of the element.
async function realClick(sel: string) {
  const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
let md = 0, pg = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  md = (await post("/api/briefs", { title: "A markdown brief", body: "## Hello\n\nSome text to read." }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  pg = (await post("/api/briefs", { title: "A page brief", body: "<!doctype html><html><body><h1>Page</h1></body></html>" }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await fetch(`${server.base}/api/rooms/pricing/files?name=model.html&title=Model&as=pm`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body: "<!doctype html><html><body><h1>Model</h1></body></html>" });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("BACK closes the brief whole, its comment thread included, for a markdown brief, a page brief and a room's page", async () => {
  for (const [hash, view, back] of [[`#brief/${md}`, ".briefview", "[data-brief-back]"], [`#brief/${pg}`, ".briefview", "[data-brief-back]"], ["#page/rooms/pricing/files/model.html", ".pageview", "[data-page-back]"]] as const) {
    await load(hash);
    await until(onScreen(view));
    await until(`document.querySelector("[data-comments-toggle]")?.hasAttribute("aria-pressed")`);
    await ev(`(() => { const b = document.querySelector("[data-comments-toggle]"); if (b.getAttribute("aria-pressed") !== "true") b.click(); return true; })()`);
    await until(onScreen(`${view} .cmount`)); // the thread is open beside it
    await ev(`document.querySelector(${JSON.stringify(back)}).click(); true`);
    await until(`!(${onScreen(view)}) && ![...document.querySelectorAll(".cmount")].some((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; })`);
    expect(await ev(onScreen(".stage > .room"))).toBe(true); // the office is back
  }
}, 60_000);

test.skipIf(!chromeFound)("the thread is closed until COMMENTS opens it; the choice is kept; the brief takes the width", async () => {
  await load("");
  await ev(`localStorage.removeItem("hq-comments-open"); true`);
  await load(`#brief/${md}`);
  await until(onScreen(".briefview .bbody"));
  await until(`document.querySelector("[data-comments-toggle]")?.hasAttribute("aria-pressed")`); // the thread has loaded
  expect(await ev(onScreen(".briefview .cmount"))).toBe(false);
  expect(await ev(`document.querySelector("[data-comments-toggle]").getAttribute("aria-pressed")`)).toBe("false");
  const narrow = await ev(`document.querySelector(".briefview .bbody").getBoundingClientRect().width`);
  await ev(`document.querySelector("[data-comments-toggle]").click(); true`);
  await until(onScreen(".briefview .cmount"));
  expect(await ev(`document.querySelector("[data-comments-toggle]").getAttribute("aria-pressed")`)).toBe("true");
  expect(await ev(`document.querySelector(".briefview .bbody").getBoundingClientRect().width`)).toBeLessThan(narrow);
  // kept: a reload opens it again
  await load(`#brief/${md}`);
  await until(onScreen(".briefview .cmount"));
  await ev(`document.querySelector("[data-comments-toggle]").click(); true`);
  await until(`!(${onScreen(".briefview .cmount")})`);
  await load(`#brief/${md}`);
  await until(onScreen(".briefview .bbody"));
  await Bun.sleep(300);
  expect(await ev(onScreen(".briefview .cmount"))).toBe(false);
}, 60_000);

test.skipIf(!chromeFound)("FULL SCREEN shows the brief alone, and the button leaves it; NEW WINDOW is a window of its own", async () => {
  await load(`#brief/${md}`);
  await until(onScreen("[data-view-full]"));
  await realClick("[data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await until(`document.querySelector("[data-view-full]").textContent === "EXIT FULL SCREEN"`);
  await realClick("[data-view-full]");
  await until(`!document.fullscreenElement`);
  const a = await ev(`(() => { const a = [...document.querySelectorAll(".bvbar a")].find((x) => x.textContent === "NEW WINDOW"); return [a.getAttribute("href"), a.target]; })()`);
  expect(a).toEqual([`./#brief/${md}`, "_blank"]);
  // a room's page has FULL SCREEN too
  await load("#page/rooms/pricing/files/model.html");
  await until(onScreen(".pvbar [data-view-full]"));
  await realClick(".pvbar [data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".pageview")`);
  await realClick(".pvbar [data-view-full]");
  await until(`!document.fullscreenElement`);
}, 60_000);

test.skipIf(!chromeFound)("leaving a brief or a page while it is full screen leaves full screen too: BACK, the browser's back, Esc", async () => {
  for (const [hash, view, back] of [[`#brief/${md}`, ".briefview", "[data-brief-back]"], ["#page/rooms/pricing/files/model.html", ".pageview", "[data-page-back]"]] as const) {
    for (const how of ["button", "history", "esc"]) {
      await load("");
      await ev(`location.hash = ${JSON.stringify(hash)}; true`);
      await until(onScreen(`${view} [data-view-full]`));
      await realClick(`${view} [data-view-full]`);
      await until(`document.fullscreenElement === document.querySelector(${JSON.stringify(view)})`);
      if (how === "button") await realClick(back);
      else if (how === "history") await ev(`history.back(); true`);
      else await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      // never a hidden element left full screen (a blank, frozen-looking screen)
      await until(`!document.fullscreenElement`);
      await until(`!(${onScreen(view)})`);
    }
  }
}, 90_000);

test.skipIf(!chromeFound)("on a phone COMMENTS opens the thread's sheet; FULL SCREEN and NEW WINDOW are not offered", async () => {
  await load(`#brief/${pg}`, 390, 844, true);
  await until(onScreen(".briefview [data-comments-toggle]"));
  expect(await ev(onScreen(".bvbar [data-view-full]"))).toBe(false);
  expect(await ev(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  await ev(`document.querySelector("[data-comments-toggle]").click(); true`);
  await until(`document.querySelector(".briefview .cmount").classList.contains("open")`);
}, 60_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
