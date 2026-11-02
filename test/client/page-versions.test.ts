// VERSIONS on the page: a page a lane replaced keeps its earlier versions. The shelf's card shows the newest (V2); the
// page view's VERSIONS lists them, an older one opens read-only under a line that says so, SHOW LATEST returns, and
// a new version replaces the newest in place. The room's brief pane lists the brief's versions: an earlier markdown
// brief shows in place, an earlier page opens on the stage. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-versions-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
// Each version tells its parent which one it is.
const PAGE = (n: number) => `<!doctype html><html><body><h1>Version ${n}</h1><script>parent.postMessage({ ver: ${n} }, "*")</script></body></html>`;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
const upload = (name: string, body: string) => fetch(`${server.base}/api/rooms/plans/files?${new URLSearchParams({ name, title: "Model", as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body }).then((r) => r.json());
async function load(hash = "", w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__ver = null; addEventListener("message", (e) => { if (e.data?.ver) window.__ver = e.data.ver; }), true`);
}
// The frame loads again once the test listens, so its message is not missed.
const reframe = () => ev(`(() => { const f = document.querySelector(".pageview iframe"); f.src = f.getAttribute("src"); return true; })()`);
let askId = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "plans", title: "Plans", owner: "pm" });
  await upload("model.html", PAGE(1));
  await Bun.sleep(5); // each version its own moment
  await upload("model.html", PAGE(2));
  // the brief: markdown first, then a page, then the page that is current now
  await post("/api/rooms/plans/brief", { body: "# The old plan\n\nWritten in markdown.", as: "pm" });
  await Bun.sleep(5);
  await post("/api/rooms/plans/brief", { body: PAGE(10), as: "pm" });
  await Bun.sleep(5);
  await post("/api/rooms/plans/brief", { body: PAGE(11), as: "pm" });
  askId = (await post("/api/asks", { lane: "pm", title: "Ship the model?" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

const versionsButton = `document.querySelector(".pageview [data-page-versions]")`;

test.skipIf(!chromeFound)("the shelf's card shows the newest, marked V2; VERSIONS opens the older one read-only; SHOW LATEST; BACK to the room", async () => {
  await load("#room/plans");
  await until(`[...document.querySelectorAll(".art.page")].length === 1`);
  expect(await ev(`document.querySelector(".art.page .av").textContent`)).toBe("V2");
  await ev(`document.querySelector(".art.page .open").click()`);
  await until(`${versionsButton}?.textContent === "VERSIONS (2)"`);
  await until(`window.__ver === 2`);
  expect(await ev(`document.querySelector(".pvold").hidden`)).toBe(true);
  // an open question stays in view while a page is on the stage
  expect(await ev(`(() => { const r = document.querySelector('#hud [data-ask="${askId}"]').getBoundingClientRect(); return r.width > 0 && r.top < innerHeight && r.bottom > 0; })()`)).toBe(true);
  await ev(`${versionsButton}.click()`);
  await until(`!document.querySelector(".pvvers").hidden`);
  expect(await ev(`[...document.querySelectorAll(".pvv b")].map((b) => b.textContent)`)).toEqual(["LATEST", "V1"]);
  await ev(`window.__ver = null; document.querySelectorAll(".pvv")[1].click()`);
  await until(`/^#room\\/plans\\+page\\/rooms\\/plans\\/files\\/model\\.html\\?v=\\d+$/.test(location.hash) && window.__ver === 1`);
  expect(await ev(`document.querySelector(".pageview iframe").getAttribute("src")`)).toMatch(/^\/rooms\/plans\/files\/model\.html\?v=\d+&theme=(light|dark)$/);
  await until(`!document.querySelector(".pvold").hidden && document.querySelector(".pvold").textContent.includes("OLDER VERSION V1read-only")`);
  await ev(`window.__ver = null; [...document.querySelectorAll(".pvold a")].find((a) => a.textContent === "SHOW LATEST").click()`);
  await until(`location.hash === "#room/plans+page/rooms/plans/files/model.html" && window.__ver === 2`);
  expect(await ev(`document.querySelector(".pvold").hidden`)).toBe(true);
  // the version steps replaced the address: BACK still lands in the room
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "#room/plans" && document.querySelector(".pageview").hidden`);
}, 30_000);

test.skipIf(!chromeFound)("a lane's new version replaces the newest in place while it is open", async () => {
  await load("#page/rooms/plans/files/model.html");
  await until(`!!document.querySelector(".pageview iframe")`);
  await reframe();
  await until(`window.__ver === 2 && ${versionsButton}?.textContent === "VERSIONS (2)"`);
  await ev(`window.__ver = null`);
  await upload("model.html", PAGE(3));
  await until(`window.__ver === 3 && ${versionsButton}?.textContent === "VERSIONS (3)"`, 10_000);
}, 30_000);

test.skipIf(!chromeFound)("the room's brief: VERSIONS in its pane; an earlier markdown brief shows in place, an earlier page on the stage", async () => {
  await load("#room/plans");
  await until(`!!document.querySelector(".rbrief [data-brief-versions]")`);
  expect(await ev(`document.querySelector(".rbrief [data-brief-versions]").textContent`)).toBe("VERSIONS (3)");
  await ev(`document.querySelector(".rbrief [data-brief-versions]").click()`);
  await until(`document.querySelectorAll(".rbrief .bver").length === 3`);
  expect(await ev(`[...document.querySelectorAll(".rbrief .bver b")].map((b) => b.textContent)`)).toEqual(["LATEST", "V2", "V1"]);
  // V1 was markdown: it shows here, read-only
  await ev(`document.querySelectorAll(".rbrief .bver")[2].click()`);
  await until(`!!document.querySelector(".rbrief .bold")`);
  expect(await ev(`document.querySelector(".rbrief .bold").textContent`)).toContain("OLDER VERSION V1read-only");
  expect(await ev(`document.querySelector(".rbrief .md h3")?.textContent`)).toBe("The old plan");
  await ev(`document.querySelector(".rbrief .bold [data-brief-version]").click()`);
  await until(`!document.querySelector(".rbrief .bold") && document.querySelector(".rbrief").textContent.includes("This brief is a page.")`);
  // V2 was a page: it opens on the stage, and the page view lists the brief's page versions
  await ev(`document.querySelector(".rbrief [data-brief-versions]").click()`);
  await until(`!!document.querySelector('.rbrief a.bver[href^="#page/rooms/plans/brief?v="]')`);
  await ev(`window.__ver = null; document.querySelector('.rbrief a.bver').click()`);
  await until(`window.__ver === 10 && !document.querySelector(".pvold").hidden`);
  expect(await ev(`${versionsButton}.textContent`)).toBe("VERSIONS (2)");
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "#room/plans"`);
}, 30_000);

test.skipIf(!chromeFound)("on a phone: the bar and the older version's line fit the screen", async () => {
  await load("#page/rooms/plans/files/model.html", 390, 844, true);
  await until(`!!${versionsButton}`);
  await ev(`${versionsButton}.click()`);
  await until(`!document.querySelector(".pvvers").hidden`);
  await ev(`[...document.querySelectorAll(".pvv")].at(-1).click()`);
  await until(`!document.querySelector(".pvold").hidden && document.querySelector(".pvold").textContent.includes("read-only")`);
  expect(await ev(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  const f = await ev(`(() => { const r = document.querySelector(".pageview iframe").getBoundingClientRect(); return [r.top, r.bottom]; })()`);
  expect(f[0]).toBeLessThan(844 / 2);
  expect(f[1]).toBeGreaterThan(780);
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
