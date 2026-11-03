// A page in the HUD's theme: every page frame asks for ?theme=light|dark, from the root's data-theme (the HUD's THEME)
// or, when that is unset, from the screen's setting, and loads again when either changes. The server puts data-theme
// and a matching color-scheme on the page's <html>, the signal an artifact gets, so a page written for artifacts
// (:root[data-theme=dark]) follows it. The brief view and the page view are drawn with the tokens of core/base.css.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-theme-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
// A page written for artifacts: dark under :root[data-theme=dark]. It says how it looks, and at which address.
const PAGE = `<!doctype html><html><head><style>
:root { background: rgb(250, 250, 250); }
:root[data-theme="dark"] { background: rgb(1, 1, 1); }
</style></head><body><h1>Theme</h1><script>
const s = getComputedStyle(document.documentElement);
parent.postMessage({ look: { theme: document.documentElement.dataset.theme ?? null, scheme: s.colorScheme, bg: s.backgroundColor }, at: location.pathname + location.search }, "*");
</script></body></html>`;
// The same page reporting a moment after it loads, and again as it leaves: a document the frame has moved on from is
// still heard, before the new one reports.
const LEAVING = PAGE.replace("parent.postMessage(", "const report = () => parent.postMessage(").replace(`"*");\n</script>`, `"*");\nsetTimeout(report, 300); addEventListener("pagehide", report);\n</script>`);
// Fragments, as artifacts may be: one that only sets a light background, and one that opts into dark itself. Each
// says how its text looks.
const REPORT = `<script>const s = getComputedStyle(document.documentElement); parent.postMessage({ look: { theme: document.documentElement.dataset.theme ?? null, scheme: s.colorScheme, text: getComputedStyle(document.querySelector("p")).color }, at: location.pathname + location.search }, "*");</script>`;
const LIGHT_FRAGMENT = `<style>body { background: #fafafa }</style><p>Readable on any screen</p>${REPORT}`;
const DARK_FRAGMENT = `<style>:root[data-theme="dark"] body { background: #111 }</style><p>Dark when the HUD is</p>${REPORT}`;
const LIGHT = { theme: "light", scheme: "light", bg: "rgb(250, 250, 250)" };
const DARK = { theme: "dark", scheme: "dark", bg: "rgb(1, 1, 1)" };

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
const screen = (dark: boolean) => page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
const frame = `document.querySelector(".pageview:not([hidden]) iframe, .briefview:not([hidden]) iframe")`;
async function load(hash = "") {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__looks = []; addEventListener("message", (e) => { if (e.data?.look) window.__looks.push(e.data); }), true`);
  await until(`!!${frame}`);
}
// The frame's page once it has loaded at SRC (loaded again first, so its report is not missed). Only a report from SRC
// counts: a document the frame has moved on from can still be heard after the reload is asked for.
async function lookAt(src: string) {
  await until(`${frame}.getAttribute("src") === "${src}"`);
  await ev(`(() => { window.__from = window.__looks.length; const f = ${frame}; f.src = f.getAttribute("src"); return true; })()`);
  const at = `window.__looks.slice(window.__from).find((l) => l.at === ${JSON.stringify(src)})`;
  await until(`!!${at}`);
  return ev(`${at}.look`);
}
let brief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "plans", title: "Plans", owner: "pm" });
  await fetch(`${server.base}/api/rooms/plans/files?name=theme.html&as=pm`, { method: "POST", headers: { "x-hud": "1" }, body: PAGE });
  for (const [name, body] of [["light.html", LIGHT_FRAGMENT], ["dark.html", DARK_FRAGMENT], ["leaving.html", LEAVING]]) await fetch(`${server.base}/api/rooms/plans/files?name=${name}&as=pm`, { method: "POST", headers: { "x-hud": "1" }, body });
  brief = (await post("/api/briefs", { title: "Themed page", body: PAGE }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("no theme set: the frame asks for the screen's, and follows a change of the screen at once", async () => {
  await screen(false);
  await load("#page/rooms/plans/files/theme.html");
  expect(await ev(`document.documentElement.dataset.theme ?? null`)).toBe(null);
  expect(await lookAt("/rooms/plans/files/theme.html?theme=light")).toEqual(LIGHT);
  await screen(true);
  expect(await lookAt("/rooms/plans/files/theme.html?theme=dark")).toEqual(DARK);
}, 30_000);

test.skipIf(!chromeFound)("the root's data-theme wins over the screen, and a change of it reaches the frame at once; a floor brief's too", async () => {
  await screen(false);
  await load("#page/rooms/plans/files/theme.html");
  await ev(`document.documentElement.dataset.theme = "dark"`);
  expect(await lookAt("/rooms/plans/files/theme.html?theme=dark")).toEqual(DARK);
  await screen(true);
  await ev(`document.documentElement.dataset.theme = "light"`);
  expect(await lookAt("/rooms/plans/files/theme.html?theme=light")).toEqual(LIGHT);
  await ev(`delete document.documentElement.dataset.theme`);
  expect(await lookAt("/rooms/plans/files/theme.html?theme=dark")).toEqual(DARK);
  await screen(false);
  await load(`#brief/${brief}`);
  expect(await lookAt(`/briefs/${brief}.html?theme=light`)).toEqual(LIGHT);
  await ev(`document.documentElement.dataset.theme = "dark"`);
  expect(await lookAt(`/briefs/${brief}.html?theme=dark`)).toEqual(DARK);
}, 30_000);

test.skipIf(!chromeFound)("a report from the frame's earlier document is not taken for the new one's", async () => {
  await screen(false);
  await load("#page/rooms/plans/files/leaving.html");
  expect(await lookAt("/rooms/plans/files/leaving.html?theme=light")).toEqual(LIGHT);
  await ev(`document.documentElement.dataset.theme = "dark"`);
  expect(await lookAt("/rooms/plans/files/leaving.html?theme=dark")).toEqual(DARK);
  await ev(`delete document.documentElement.dataset.theme`);
}, 30_000);

test.skipIf(!chromeFound)("on a dark screen a fragment with a light background stays readable; one that opts into dark goes dark", async () => {
  await screen(true);
  await load("#page/rooms/plans/files/light.html");
  expect(await lookAt("/rooms/plans/files/light.html?theme=dark")).toEqual({ theme: "dark", scheme: "light", text: "rgb(0, 0, 0)" });
  await load("#page/rooms/plans/files/dark.html");
  expect(await lookAt("/rooms/plans/files/dark.html?theme=dark")).toEqual({ theme: "dark", scheme: "dark", text: "rgb(255, 255, 255)" });
  await screen(false);
}, 30_000);

test.skipIf(!chromeFound)("the brief view and the page view are drawn with the tokens of core/base.css", async () => {
  const id = (await post("/api/briefs", { title: "Words", body: "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |" }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await page.s("Page.navigate", { url: `${server.base}/#brief/${id}` });
  await until(`!!document.querySelector(".briefview h1")`);
  await ev(`(() => { const r = document.documentElement.style; r.setProperty("--box", "rgb(10, 20, 30)"); r.setProperty("--ink", "rgb(200, 210, 220)"); r.setProperty("--edge-2", "rgb(10, 20, 30)"); return true; })()`);
  const look = await ev(`(() => { const v = document.querySelector(".briefview"); return [getComputedStyle(v).backgroundColor, getComputedStyle(v.querySelector("h1")).color, getComputedStyle(v.querySelector(".md th")).backgroundColor]; })()`);
  // a mix of two tokens (color-mix) reads back as color(srgb ...): the same colour
  expect(look.map((c: string) => c.replace("color(srgb 0.0392157 0.0784314 0.117647)", "rgb(10, 20, 30)"))).toEqual(["rgb(10, 20, 30)", "rgb(200, 210, 220)", "rgb(10, 20, 30)"]);
  await page.s("Page.navigate", { url: `${server.base}/#page/rooms/plans/files/theme.html` });
  await until(`!!document.querySelector(".pageview iframe")`);
  await ev(`document.documentElement.style.setProperty("--box", "rgb(10, 20, 30)")`);
  expect(await ev(`[getComputedStyle(document.querySelector(".pageview")).backgroundColor, getComputedStyle(document.querySelector(".pageview iframe")).backgroundColor]`)).toEqual(["rgb(10, 20, 30)", "rgb(10, 20, 30)"]);
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
