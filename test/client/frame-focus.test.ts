// A page in a sandboxed frame (an ask's page, a room's page, a page brief) that calls focus() when it loads does not
// take the keyboard from a HUD text box the owner is typing in: what they type and paste still lands there. Only a
// click into the frame moves the keyboard into it. Covered: a new ask arriving, a room page reloading on a new
// version, and a page brief beside a room reloading when the screen turns dark. Needs Chrome.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-frame-focus-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "working", pane_id: "w1:p2", agent: "claude" }]);
// Focuses its own field as it loads, says so, and says what is typed into that field.
const GRABBY = (n: number) => `<!doctype html><html><body><p>Version ${n}</p><input id="f" style="display:block;width:90%;height:300px"><script>
const f = document.getElementById("f");
f.addEventListener("input", () => parent.postMessage({ typedInFrame: f.value }, "*"));
f.focus();
parent.postMessage({ grabbed: ${n} }, "*");
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
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
const publish = (n: number) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name: "grab.html", title: "grab.html", as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body: GRABBY(n) });
const grabs = () => ev(`window.__grabs.length`) as Promise<number>;

async function click(sel: string) {
  await until(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  const [x, y] = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + Math.min(b.height / 2, 12)]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
// What a dictation app does: its text on the clipboard, then Command-V; and plain typing.
async function typeAndPaste(typed: string, pasted: string) {
  await page.s("Input.insertText", { text: typed });
  await ev(`navigator.clipboard.writeText(${JSON.stringify(pasted)}).then(() => true)`);
  await page.s("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86, commands: ["paste"] });
  await page.s("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "v", code: "KeyV", windowsVirtualKeyCode: 86 });
}
const hasKeyboard = (sel: string) => ev(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Tester" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await publish(1);
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await chrome.cdp.send("Browser.grantPermissions", { origin: server.base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__grabs = []; window.__typed = []; addEventListener("message", (e) => { if (e.data?.grabbed) window.__grabs.push(e.data.grabbed); if (e.data?.typedInFrame) window.__typed.push(e.data.typedInFrame); }), true`);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("typing in TELL HQ when a new ask arrives whose page focuses itself: the typing and a paste land in TELL HQ", async () => {
  await click("#noteText");
  await typeAndPaste("before ", "");
  const before = await grabs();
  await post("/api/asks", { lane: "pm", kind: "decision", title: "Which tier?", body: GRABBY(2) });
  await until(`window.__grabs.includes(2)`);
  expect(await grabs()).toBeGreaterThan(before);
  await typeAndPaste("typed ", "pasted");
  expect(await ev(`document.getElementById("noteText").value`)).toBe("before typed pasted");
  expect(await hasKeyboard("#noteText")).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("typing in a room's send box when the room's page reloads with a new version: the typing and a paste land in the send box", async () => {
  await ev(`location.hash = "#room/pricing+page/rooms/pricing/files/grab.html", true`);
  await until(`window.__grabs.includes(1)`);
  await click(".rsend textarea");
  await typeAndPaste("hello ", "");
  await publish(3);
  await until(`window.__grabs.includes(3)`, 10_000);
  await typeAndPaste("typed ", "pasted");
  expect(await ev(`document.querySelector(".rsend textarea").value`)).toBe("hello typed pasted");
  expect(await hasKeyboard(".rsend textarea")).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a page brief beside a room reloads when the screen turns dark: the room's send box keeps the typing and a paste", async () => {
  const { id } = await post("/api/briefs", { title: "Plan", body: GRABBY(4) });
  await ev(`location.hash = "#room/pricing+brief/${id}", true`);
  await until(`window.__grabs.includes(4) && document.querySelector(".stage").classList.contains("split")`);
  await click(".rsend textarea");
  await ev(`document.querySelector(".rsend textarea").value = "", true`);
  await typeAndPaste("dark ", "");
  const before = await grabs();
  await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await until(`window.__grabs.length > ${before} && [...document.querySelectorAll("iframe.pageframe")].some((f) => f.src.includes("theme=dark"))`, 10_000);
  await typeAndPaste("typed ", "pasted");
  expect(await ev(`document.querySelector(".rsend textarea").value`)).toBe("dark typed pasted");
  expect(await hasKeyboard(".rsend textarea")).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a click into a page's own field still gives it the keyboard", async () => {
  await ev(`location.hash = "#page/rooms/pricing/files/grab.html", true`);
  await until(`!!document.querySelector(".pageview:not([hidden]) iframe.pageframe")`);
  await Bun.sleep(500);
  const [x, y] = await ev(`(() => { const b = document.querySelector(".pageview:not([hidden]) iframe.pageframe").getBoundingClientRect(); return [b.x + 60, b.y + 200]; })()`);
  await ev(`window.__typed = [], true`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await page.s("Input.insertText", { text: "in the page" });
  await until(`window.__typed.at(-1) === "in the page"`);
  expect(errors).toEqual([]);
}, 30_000);
