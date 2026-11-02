// A brief shows only inside its own floor (docs/floors.md): from inside floor A, a link to a floor B brief enters
// floor B, its BRIEFS list shows B's only, and NEWER and OLDER stay in B; in the building a brief opens where you are
// and steps through every floor's; going into another floor with a brief open leaves it. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-brief-floors-page-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const asHq = (pane: string, p: string, b: object) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", "x-hud-pane": pane, "x-hud-machine": "local" }, body: JSON.stringify(b) }).then((r) => r.json());
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
const floorNow = `(JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor ?? null)`;
const titles = `[...document.querySelectorAll("#briefs .brow .bt")].map((b) => b.textContent)`;
const shows = (t: string) => `document.querySelector(".briefview h1")?.textContent === ${JSON.stringify(t)}`;
const step = (which: "NEWER" | "OLDER") => `[...document.querySelectorAll(".bvbar [data-brief-step]")].find((a) => a.textContent === "${which}")`;
let crm1 = 0, hq1 = 0, crm2 = 0, hq2 = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/sync");
  // interleaved, so every floor's order and one floor's differ
  crm1 = (await asHq("w1:p2", "/api/briefs", { title: "CRM one", body: "First CRM brief." })).id;
  hq1 = (await asHq("w1:p1", "/api/briefs", { title: "HQ one", body: "First HQ brief." })).id;
  crm2 = (await asHq("w1:p2", "/api/briefs", { title: "CRM two", body: "Second CRM brief." })).id;
  hq2 = (await asHq("w1:p1", "/api/briefs", { title: "HQ two", body: "Second HQ brief." })).id;
  // an HQ message on floor hq that links to the CRM floor's brief
  await asHq("w1:p1", "/api/updates", { title: "See CRM's plan", body: `[CRM two](#brief/${crm2})` });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML && !!document.querySelector('[data-floor-go="hq"]')`);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("in the building a brief opens where you are, and NEWER and OLDER walk every floor's", async () => {
  await ev(`location.hash = "#brief/${crm2}"`);
  await until(shows("CRM two"));
  expect(await ev(floorNow)).toBe(null);
  expect(await ev(`${step("OLDER")}.getAttribute("href")`)).toBe(`#brief/${hq1}`);
  expect(await ev(`${step("NEWER")}.getAttribute("href")`)).toBe(`#brief/${hq2}`);
  await ev(`document.querySelector("[data-brief-back]").click()`);
  await until(`document.querySelector(".briefview").hidden`);
}, 20_000);

test.skipIf(!chromeFound)("from inside floor hq, a link to a CRM brief enters CRM: its list, and NEWER and OLDER stay in CRM", async () => {
  await ev(`document.querySelector('[data-floor-go="hq"]').click()`);
  await until(`${floorNow} === "hq"`);
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`!!document.querySelector('#msgs a[href="#brief/${crm2}"]')`);
  await ev(`document.querySelector('#msgs a[href="#brief/${crm2}"]').click()`);
  await until(`${shows("CRM two")} && ${floorNow} === "crm"`);
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`document.querySelectorAll("#briefs .brow").length === 2`);
  expect(await ev(titles)).toEqual(["CRM two", "CRM one"]);
  // NEWER: none on CRM (HQ two is newer, on another floor); OLDER: CRM one, not HQ one
  expect(await ev(`${step("NEWER")}.classList.contains("off") && !${step("NEWER")}.hasAttribute("href")`)).toBe(true);
  expect(await ev(`${step("OLDER")}.getAttribute("href")`)).toBe(`#brief/${crm1}`);
  await ev(`${step("OLDER")}.click()`);
  await until(shows("CRM one"));
  expect(await ev(floorNow)).toBe("crm");
  expect(await ev(`${step("OLDER")}.classList.contains("off")`)).toBe(true);
  expect(await ev(`${step("NEWER")}.getAttribute("href")`)).toBe(`#brief/${crm2}`);
}, 20_000);

test.skipIf(!chromeFound)("a brief's address typed inside another floor enters the brief's floor too", async () => {
  await ev(`document.querySelector("[data-brief-back]").click()`);
  await until(`document.querySelector(".briefview").hidden`);
  // back inside floor hq, then the address
  await ev(`(async () => { const { enter } = await import("/src/client/core/scope.js"); enter("hq"); })()`);
  await until(`${floorNow} === "hq"`);
  await ev(`location.hash = "#brief/${crm1}"`);
  await until(`${shows("CRM one")} && ${floorNow} === "crm"`);
}, 20_000);

test.skipIf(!chromeFound)("going into another floor with a brief open leaves the brief", async () => {
  await ev(`(async () => { const { enter } = await import("/src/client/core/scope.js"); enter("hq"); })()`);
  await until(`document.querySelector(".briefview").hidden && ${floorNow} === "hq"`);
  expect(await ev(`location.hash`)).toBe("");
  expect(errors).toEqual([]);
}, 20_000);
