// BRIEFS on the page: the tab lists a floor's briefs newest first with a NEW count; the line in MESSAGES opens the
// brief at full width with its markdown (headings, a table, a list); opening marks it read; NEWER, OLDER, BACK and Esc;
// inside a floor, that floor's briefs; on a phone it fills the screen. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-briefs-page-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
const BODY = "## Where we are\n\nThe pricing page is **live**.\n\n| Lane | State |\n| --- | --- |\n| api | merged |\n| docs | in review |\n\n- one\n- two\n\n### Next\n\nShip the copy.";

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const asHq = (pane: string, b: object) => fetch(`${server.base}/api/briefs`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", "x-hud-pane": pane, "x-hud-machine": "local" }, body: JSON.stringify(b) }).then((r) => r.json());
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
async function load(w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
let first = 0, second = 0, crm = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/sync");
  first = (await asHq("w1:p1", { title: "Monday: where we are", body: BODY })).id;
  crm = (await asHq("w1:p2", { title: "CRM import plan", body: "# Plan\n\nImport in two steps." })).id;
  second = (await asHq("w1:p1", { title: "Tuesday: pricing shipped", body: "Short one." })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await load();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("the BRIEFS tab: every floor's briefs newest first, with dates, and how many are new", async () => {
  expect(await ev(`document.getElementById("qtBriefs").textContent`)).toBe("3");
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`document.querySelectorAll("#briefs .brow").length === 3`);
  expect(await ev(`[...document.querySelectorAll("#briefs .brow .bt")].map((b) => b.textContent)`)).toEqual(["Tuesday: pricing shipped", "CRM import plan", "Monday: where we are"]);
  expect(await ev(`document.querySelector("#briefs .brow .when").textContent.length > 5`)).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("the line in MESSAGES opens the brief at full width, with headings, a table and a list; it is read", async () => {
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`!!document.querySelector('#msgs a[href="#brief/${first}"]')`);
  expect(await ev(`document.getElementById("msgs").textContent.includes("New brief: Monday: where we are")`)).toBe(true);
  await ev(`document.querySelector('#msgs a[href="#brief/${first}"]').click()`);
  await until(`location.hash === "#brief/${first}" && !!document.querySelector(".briefview .bbody h1")`);
  expect(await ev(`document.querySelector(".briefview h1").textContent`)).toBe("Monday: where we are");
  expect(await ev(`[...document.querySelectorAll(".briefview .md h4, .briefview .md h5")].map((h) => h.textContent)`)).toEqual(["Where we are", "Next"]);
  expect(await ev(`[...document.querySelectorAll(".briefview .md th")].map((h) => h.textContent)`)).toEqual(["Lane", "State"]);
  expect(await ev(`document.querySelectorAll(".briefview .md li").length`)).toBe(2);
  expect(await ev(`document.querySelector(".briefview .md").getBoundingClientRect().width`)).toBeGreaterThan(600);
  expect(await ev(`getComputedStyle(document.querySelector(".building")).display`)).toBe("none"); // the brief has the stage
  await until(`document.getElementById("qtBriefs").textContent === "2"`);
}, 20_000);

test.skipIf(!chromeFound)("NEWER and OLDER step through the briefs; BACK and Esc return to the office", async () => {
  await ev(`document.querySelector(".bvbar a:not(.off)").click()`); // NEWER from the oldest
  await until(`location.hash === "#brief/${crm}" && document.querySelector(".briefview h1")?.textContent === "CRM import plan"`);
  await ev(`document.querySelector("[data-brief-back]").click()`);
  await until(`document.querySelector(".briefview").hidden && !document.querySelector(".stage").classList.contains("inbrief") && location.hash === ""`);
  await ev(`location.hash = "#brief/${second}"`);
  await until(`document.querySelector(".briefview h1")?.textContent === "Tuesday: pricing shipped"`);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(`document.querySelector(".briefview").hidden`);
  await ev(`location.hash = "#brief/99999"`);
  await until(`location.hash === "" && document.querySelector(".briefview").hidden`);
  // that unknown brief's 404 is the one console line Chrome writes for it; nothing else may show
  expect(errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
  errors.length = 0;
}, 20_000);

test.skipIf(!chromeFound)("inside a floor, that floor's briefs only", async () => {
  await ev(`document.querySelector('[data-floor-go="crm"]').click()`);
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`document.querySelectorAll("#briefs .brow").length === 1`);
  expect(await ev(`document.querySelector("#briefs .brow .bt").textContent`)).toBe("CRM import plan");
}, 20_000);

test.skipIf(!chromeFound)("on a phone a brief fills the screen, with BACK in reach and no sideways scroll", async () => {
  await load(390, 844, true);
  await ev(`location.hash = "#brief/${first}"`);
  await until(`!!document.querySelector(".briefview .bbody h1")`);
  const b = await ev(`(() => { const r = document.querySelector(".briefview").getBoundingClientRect(), k = document.querySelector("[data-brief-back]").getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight, back: k.top < 80 && k.height >= 44, sw: document.documentElement.scrollWidth }; })()`);
  expect(b.l).toBe(0);
  expect(b.t).toBe(0);
  expect(Math.round(b.w)).toBe(b.iw);
  expect(Math.round(b.h)).toBe(b.ih);
  expect(b.back).toBe(true);
  expect(b.sw).toBeLessThanOrEqual(b.iw);
  expect(errors).toEqual([]);
}, 20_000);
