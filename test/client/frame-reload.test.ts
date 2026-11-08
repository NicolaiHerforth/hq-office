// A page frame sent somewhere new while its first load is still on its way (here the THEME switch, the way a publish,
// a newer version or an ask's update also reload one) ends on the new address: Chrome can drop a navigation asked
// for just as it moves the frame into a process of its own, so the HUD waits for that first load
// (src/client/pages/frame-nav.js). Twenty tries, each a few milliseconds into the first load. Needs Chrome.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-frame-reload-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
// The page says which theme it was loaded in.
const PAGE = `<!doctype html><html><body><p>Theme</p><script>parent.postMessage({ loadedIn: new URLSearchParams(location.search).get("theme") }, "*");</script></body></html>`;

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
const frame = `document.querySelector(".pageview:not([hidden]) iframe")`;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Tester" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name: "theme.html", title: "theme.html", as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body: PAGE });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__loads = []; addEventListener("message", (e) => { if (e.data?.loadedIn) window.__loads.push(e.data.loadedIn); }), true`);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("the theme switched a few milliseconds into a page's first load: the page ends in the new theme, every time", async () => {
  const stale: string[] = [];
  for (let i = 0; i < 20; i++) {
    const to = i % 2 ? "light" : "dark", ms = i % 10;
    await ev(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(to === "dark" ? "light" : "dark")}; window.__loads = []; location.hash = "#page/rooms/pricing/files/theme.html"; setTimeout(() => { document.documentElement.dataset.theme = ${JSON.stringify(to)}; }, ${ms}); return true; })()`);
    await until(`!!${frame}`);
    // The frame switches only once its first load is done, and that load can take seconds on a busy machine: wait for the
    // end, a while, instead of a fixed time. A frame that never gets there is still caught.
    const read = async () => JSON.parse(await ev(`JSON.stringify({ last: window.__loads.at(-1) ?? null, src: ${frame}?.getAttribute("src") })`));
    let { last, src } = await read();
    for (const end = Date.now() + 10_000; (last !== to || !src?.endsWith(`theme=${to}`)) && Date.now() < end; await Bun.sleep(100)) ({ last, src } = await read());
    if (last !== to || !src.endsWith(`theme=${to}`)) stale.push(`try ${i} (${ms} ms): wanted ${to}, the page last loaded in ${last}, the frame asks for ${src}`);
    await ev(`location.hash = "", true`);
    await until(`!${frame}`);
  }
  expect(stale).toEqual([]);
  expect(errors).toEqual([]);
}, 300_000);
