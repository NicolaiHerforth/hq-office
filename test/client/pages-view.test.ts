// HTML PAGES on the page: a room's .html file opens from the shelf as a page on the stage, in a sandboxed frame. The
// page's own scripts, styles and pictures (inline, and from the room's files/) work; the HUD does not: it cannot read
// the HUD's document, fetch its data or use its storage. A room brief that is a page and a floor brief that is one
// open the same way; BACK returns to the room; on a phone it fills the screen. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-pages-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
// A 1x1 PNG, for a picture the page loads from the room's files/.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
// The page reports what it could and could not do, to its parent.
const PROBE = (pic = "dot.png") => `<!doctype html><html><head><style>h1{color:rgb(1,2,3)}</style></head><body><h1>Probe</h1><img id=pic src="${pic}"><script>
const out = { ran: true, color: getComputedStyle(document.querySelector("h1")).color };
try { out.parentDoc = !!parent.document.body; } catch { out.parentDoc = false; }
try { localStorage.setItem("x", "1"); out.storage = true; } catch { out.storage = false; }
try { out.cookie = document.cookie; out.cookieOk = true; } catch { out.cookieOk = false; }
const pic = document.getElementById("pic");
const picDone = new Promise((ok) => { if (pic.complete) ok(); pic.onload = pic.onerror = ok; });
Promise.all([fetch("/api/state").then(() => true, () => false), fetch(location.origin + "/api/state").then(() => true, () => false), picDone]).then(([a, b]) => {
  out.fetchState = a || b; out.pic = pic.naturalWidth;
  parent.postMessage({ probe: out }, "*");
});
</script></body></html>`;

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
const upload = (name: string, body: string | Uint8Array, type: string) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name, title: name, as: "pm" })}`, { method: "POST", headers: { "content-type": type, "x-hud": "1" }, body }).then((r) => r.json());
async function load(hash = "", w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  // a fresh load each time (from one hash to another would only change the hash)
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__probe = null; addEventListener("message", (e) => { if (e.data?.probe) window.__probe = e.data.probe; }), true`);
}
let brief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await upload("dot.png", PNG, "image/png");
  await upload("probe.html", PROBE(), "text/html");
  // the brief sits at the room folder's top, its files in files/ (as on disk); a floor brief carries its pictures inline
  await post("/api/rooms/pricing/brief", { body: PROBE("files/dot.png"), as: "pm" });
  brief = (await post("/api/briefs", { title: "Pricing as a page", body: PROBE(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`) }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

// The frame loads again once the test listens, so its report is not missed.
const sandboxedProbe = async () => {
  await ev(`(() => { window.__probe = null; const f = document.querySelector(".pageview:not([hidden]) iframe, .briefview:not([hidden]) iframe"); f.src = f.getAttribute("src"); return true; })()`);
  await until(`!!window.__probe`, 10_000);
  const p = await ev(`window.__probe`);
  expect(p).toMatchObject({ ran: true, color: "rgb(1, 2, 3)", parentDoc: false, storage: false, cookieOk: false, fetchState: false, pic: 1 });
};

test.skipIf(!chromeFound)("the shelf's OPEN on a .html file: the page on the stage, sandboxed: its scripts, styles and pictures work, the HUD is out of reach", async () => {
  await load("#room/pricing");
  await until(`[...document.querySelectorAll(".art.page .open")].some((a) => a.getAttribute("href") === "#page/rooms/pricing/files/probe.html")`);
  // a picture on the shelf is still a picture
  expect(await ev(`!!document.querySelector('.art.image img[src="/rooms/pricing/files/dot.png"]')`)).toBe(true);
  await ev(`[...document.querySelectorAll(".art.page .open")].find((a) => a.getAttribute("href").endsWith("probe.html")).click()`);
  await until(`!document.querySelector(".pageview").hidden`);
  const f = await ev(`(() => { const f = document.querySelector(".pageview iframe"); return { src: f.getAttribute("src"), sandbox: f.getAttribute("sandbox") }; })()`);
  expect(f.src).toBe("/rooms/pricing/files/probe.html");
  expect(f.sandbox).toContain("allow-scripts");
  expect(f.sandbox).not.toContain("allow-same-origin");
  expect(await ev(`document.querySelector(".pvtitle").textContent`)).toBe("probe.html");
  expect(await ev(`getComputedStyle(document.querySelector(".roomview")).display`)).toBe("none");
  await sandboxedProbe();
  // BACK: to the room
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "#room/pricing" && document.querySelector(".pageview").hidden`);
  expect(await ev(`getComputedStyle(document.querySelector(".roomview")).display`)).not.toBe("none");
}, 30_000);

test.skipIf(!chromeFound)("a room brief that is a page: OPEN THE BRIEF, the same sandbox", async () => {
  await load("#room/pricing");
  await until(`!!document.querySelector('a[href="#page/rooms/pricing/brief"]')`);
  await ev(`document.querySelector('a[href="#page/rooms/pricing/brief"]').click()`);
  await until(`document.querySelector(".pageview iframe")?.getAttribute("src") === "/rooms/pricing/brief.html"`);
  await sandboxedProbe();
  await ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await until(`location.hash === "#room/pricing"`);
}, 30_000);

test.skipIf(!chromeFound)("a floor brief that is a page: the brief view shows it in the sandboxed frame", async () => {
  await load(`#brief/${brief}`);
  await until(`document.querySelector(".briefview .pageframe")?.getAttribute("src") === "/briefs/${brief}.html"`);
  expect(await ev(`document.querySelector(".briefview .pageframe").getAttribute("sandbox").includes("allow-same-origin")`)).toBe(false);
  expect(await ev(`document.querySelector(".briefview .pageframe").getBoundingClientRect().height > 300`)).toBe(true);
  await sandboxedProbe();
  // its lead in the list is its text, not its markup
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`document.querySelectorAll("#briefs .brow").length === 1`);
  expect(await ev(`document.querySelector("#briefs .blead").textContent`)).toContain("Probe");
}, 30_000);

test.skipIf(!chromeFound)("opened by its link: a page fills a phone's screen; BACK goes to the office", async () => {
  await load("#page/rooms/pricing/files/probe.html", 390, 844, true);
  await until(`!document.querySelector(".pageview").hidden`);
  const r = await ev(`(() => { const b = document.querySelector(".pageview").getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
  expect(r).toEqual([0, 0, 390, 844]);
  expect(await ev(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  await sandboxedProbe();
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "" && document.querySelector(".pageview").hidden`);
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
