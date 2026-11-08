// The shelf's ADD in Chrome against a temporary server: a link with a title, files from the picker, files dropped
// anywhere on the room and an image pasted into it all land on the shelf by the owner (files in the room's folder);
// an image attached to a message goes into the folder and onto the shelf, and comes off it when removed from the
// box; the room's folder shows under the shelf; on a phone ADD works in the SHELF tab. Needs Chrome; skipped without it.
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
const click = (sel: string) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const shelf = async () => (await (await fetch(`${server.base}/api/rooms/ope-3`)).json()).artifactList as any[];
const size = (width: number, height: number, mobile: boolean) => Promise.all([
  page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile }),
  page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }),
]);
const load = async () => {
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/#room/ope-3` });
  await until(`!document.getElementById("roomView")?.hidden && !!document.querySelector("#roomView .rshelf [data-shelf-add]") && !!document.querySelector("#roomView .rfolder")`);
};
// In the page: files from text or a tiny PNG, a DataTransfer holding them.
const HELPERS = `
  window.__files = (specs) => specs.map(([name, type, text]) => type === "image/png"
    ? new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], name, { type })
    : new File([text ?? "x"], name, { type }));
  window.__dt = (specs) => { const dt = new DataTransfer(); for (const f of window.__files(specs)) dt.items.add(f); return dt; };
`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  await server.post("/api/lanes", { name: "alpha", machine: "local" });
  await server.post("/api/sync", {});
  await server.post("/api/rooms", { slug: "ope-3", title: "Folder room", owner: "alpha" });
  page = await newSession(chrome.cdp, errors);
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await size(1440, 900, false);
  await load();
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
}, 20_000);

test.skipIf(!chromeFound)("ADD: a link with a title, and files from the picker, land on the shelf by you", async () => {
  const folder = await page.evaluate(`document.querySelector("#roomView .rfolder code").textContent`);
  expect(folder).toMatch(/\/rooms\/ope-3\/files\/$/);
  await click("[data-shelf-add]");
  await until(`!document.querySelector("#roomView .radd").hidden`);
  await page.evaluate(`(() => { const f = document.querySelector("#roomView .radd"); f.url.value = "https://example.com/spec"; f.title.value = "The spec"; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll("#roomView .art")].some((a) => a.innerText.includes("The spec"))`);
  // The form survives the update the link caused, and its fields are cleared.
  expect(await page.evaluate(`[document.querySelector("#roomView .radd").hidden, document.querySelector("#roomView .radd").url.value]`)).toEqual([false, ""]);
  // A link without a title gets one from its address; something that is not a link is refused.
  await page.evaluate(`(() => { const f = document.querySelector("#roomView .radd"); f.url.value = "https://example.com/board/"; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll("#roomView .art .at")].some((a) => a.textContent === "example.com/board")`);
  await page.evaluate(`(() => { const f = document.querySelector("#roomView .radd"); f.url.value = "javascript:alert(1)"; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("HTTP"))`);
  // Files from the picker, the way the phone's menu hands them over.
  await page.evaluate(`(() => { const i = document.querySelector("#roomView [data-shelf-file]"); i.files = window.__dt([["plan notes.md", "text/markdown", "# plan"], ["chart.png", "image/png"]]).files; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until(`document.querySelectorAll("#roomView .art").length === 4`);
  const items = await shelf();
  // The picker's files upload side by side, so either may land first.
  expect(items.slice(0, 2).map((a) => [a.title, a.kind, a.by])).toEqual([["The spec", "link", "owner"], ["example.com/board", "link", "owner"]]);
  expect(items.slice(2).map((a) => [a.title, a.kind, a.by]).sort()).toEqual([["chart.png", "image", "owner"], ["plan notes.md", "file", "owner"]]);
  const plan = items.find((a) => a.title === "plan notes.md")!;
  expect(plan.path).toEndWith("/rooms/ope-3/files/plan notes.md");
  expect(await (await fetch(`${server.base}${plan.url}`)).text()).toBe("# plan");
  expect(await page.evaluate(`[...document.querySelectorAll("#roomView .art .am")].every((m) => m.textContent.startsWith("you"))`)).toBe(true);
  // The image shows inline, from the room's folder.
  await until(`document.querySelector("#roomView .art.image img")?.naturalWidth === 1`);
}, 20_000);

test.skipIf(!chromeFound)("a drop anywhere on the room and a paste into it put files on the shelf; not into Tell HQ", async () => {
  const n = (await shelf()).length;
  // Dropped on the thread: a text file and an image, both to the shelf.
  const over = await page.evaluate(`(() => { const t = document.querySelector("#roomView .rthread"), dt = window.__dt([["log.txt", "text/plain", "dropped"], ["drop.png", "image/png"]]);
    const ev = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev);
    const shown = document.getElementById("roomView").classList.contains("dropping");
    t.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    return [ev.defaultPrevented, shown]; })()`);
  expect(over).toEqual([true, true]);
  await until(`document.querySelectorAll("#roomView .art").length === ${n + 2}`);
  expect(await page.evaluate(`document.getElementById("roomView").classList.contains("dropping")`)).toBe(false);
  // Pasted with nothing focused: to the shelf, not Tell HQ's tray.
  await page.evaluate(`(() => { document.activeElement?.blur(); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: window.__dt([["image.png", "image/png"]]), bubbles: true, cancelable: true })); })()`);
  await until(`document.querySelectorAll("#roomView .art").length === ${n + 3}`);
  const items = await shelf();
  expect(items.slice(-3).map((a) => [a.title, a.by])).toEqual([["log.txt", "owner"], ["drop.png", "owner"], ["image.png", "owner"]]);
  expect(await page.evaluate(`document.querySelectorAll('[data-chips="note"] .chip').length`)).toBe(0);
}, 20_000);

test.skipIf(!chromeFound)("an image attached to a message goes into the room's folder and onto the shelf; removed from the box, it comes off", async () => {
  const n = (await shelf()).length;
  const k = "room:ope-3";
  const pick = (name: string) => page.evaluate(`(() => { const i = document.querySelector('input[data-attach="${k}"]'); i.files = window.__dt([["${name}", "image/png"]]).files; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await pick("attached.png");
  await until(`document.querySelector('[data-chips="${k}"] .chip.done') !== null`);
  await until(`document.querySelectorAll("#roomView .art").length === ${n + 1}`);
  expect((await shelf()).at(-1)).toMatchObject({ title: "attached.png", kind: "image", by: "owner" });
  await until(`[...document.querySelectorAll("#roomView .art.image img")].some((i) => i.getAttribute("src").endsWith("/attached.png") && i.naturalWidth === 1)`);
  // Removed from the box before sending: off the shelf, and out of the folder.
  const gone = (await shelf()).at(-1);
  await click(`[data-chips="${k}"] [data-chip-rm]`);
  await until(`document.querySelectorAll("#roomView .art").length === ${n}`);
  expect((await fetch(`${server.base}${gone.url}`)).status).toBe(404);
  // Sent: the message carries the image from the folder, and it shows in the thread.
  await pick("sent.png");
  await until(`document.querySelector('[data-chips="${k}"] .chip.done') !== null`);
  await page.evaluate(`(() => { const ta = document.querySelector("#roomView .rsend textarea"); ta.value = "see this"; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await click("[data-room-send]");
  await until(`[...document.querySelectorAll("#roomView .msg.you img.thumb")].some((i) => i.getAttribute("src") === "/rooms/ope-3/files/sent.png" && i.naturalWidth === 1)`);
  const msg = (await (await fetch(`${server.base}/api/rooms/ope-3`)).json()).messages.at(-1);
  expect(msg.text).toMatch(/^see this \[image: \/.+\/rooms\/ope-3\/files\/sent\.png\]$/);
  expect((await shelf()).at(-1)).toMatchObject({ title: "sent.png", by: "owner" });
}, 20_000);

test.skipIf(!chromeFound)("phone: ADD in the SHELF tab, with no zoom on its fields and no sideways page", async () => {
  await size(390, 664, true);
  await load();
  await click('[data-ptab="shelf"]');
  await click("[data-shelf-add]");
  await until(`!document.querySelector("#roomView .radd").hidden`);
  const v = await page.evaluate(`(() => {
    const f = document.querySelector("#roomView .radd"), r = f.getBoundingClientRect();
    return { shown: r.width > 0 && r.height > 0 && r.right <= innerWidth, font: parseFloat(getComputedStyle(f.url).fontSize), wide: document.documentElement.scrollWidth > innerWidth,
      pick: document.querySelector("#roomView .rpick").getBoundingClientRect().height };
  })()`);
  expect(v).toMatchObject({ shown: true, font: 16, wide: false });
  expect(v.pick).toBeGreaterThanOrEqual(30);
  await page.evaluate(`(() => { const f = document.querySelector("#roomView .radd"); f.url.value = "https://example.com/phone"; f.title.value = "From the phone"; f.requestSubmit(); })()`);
  await until(`[...document.querySelectorAll("#roomView .art")].some((a) => a.innerText.includes("From the phone"))`);
  expect(errors).toEqual([]);
}, 30_000);
