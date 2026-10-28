// The room: a working lane with a question open stays at its desk, working, with a still "!" over it; only a lane
// that is not working queues at the counter. Choosing a lane narrows the questions and Escape goes back. Needs Chrome (CHROME_BIN); skipped without it.
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

// Where each worker stands (desk or counter queue), its lane's status and asks, and whether the bubble's white
// inside is painted over its head: the bubble is 10x9 room pixels at (x + 9, y - 9), its inside starts one pixel in.
const PROBE = `(async () => {
  const { workers } = await import("/src/client/room/workers.js");
  const { SEATS, QUEUE } = await import("/src/client/room/spots.js");
  const { ctx, TS, SC } = await import("/src/client/room/canvas.js");
  const out = {};
  for (const [name, w] of workers) {
    const at = (list) => list.some((p) => Math.abs(p.x - w.target.x) < 0.5 && Math.abs(p.y - w.target.y) < 0.5);
    // The worker bobs a pixel while it works: probe a pixel of the bubble's inside that is white either way.
    const bx = w.x * TS + 9, by = w.y * TS - 6 - 9;
    const d = ctx.getImageData(Math.round((bx + 2) * SC), Math.round((by + 3) * SC), 1, 1).data;
    out[name] = { status: w.lane.status, asks: w.lane.asks, desk: at(SEATS), queue: at(QUEUE), still: !w.path.length, bubble: d[0] === 255 && d[1] === 255 && d[2] === 255 };
  }
  return out;
})()`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  // The stub herdr reports golf working and alpha idle.
  server = await startServer(ROOT);
  for (const name of ["golf", "alpha"]) await server.post("/api/lanes", { name, machine: "local" });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === 2)`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("a working lane with an open ask works at its desk under a still bubble; an idle one queues", async () => {
  const before = await page.evaluate(PROBE);
  expect(before.golf).toMatchObject({ status: "moving", asks: 0, desk: true, bubble: false });
  await server.post("/api/asks", { lane: "golf", title: "Go live?" });
  await server.post("/api/asks", { lane: "alpha", title: "Which one?" });
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.get("golf").lane.asks === 1 && workers.get("alpha").lane.status === "needs_you")`);
  // Let the queued worker walk to the counter and the room draw a few frames.
  await until(`(${PROBE}).then((p) => p.alpha.still && p.alpha.queue && p.golf.bubble)`, 15_000);
  const after = await page.evaluate(PROBE);
  expect(after.golf).toMatchObject({ status: "moving", asks: 1, desk: true, queue: false, still: true, bubble: true });
  expect(after.alpha).toMatchObject({ status: "needs_you", asks: 1, desk: false, queue: true });
  // The top bar still counts both questions.
  expect(await page.evaluate(`document.querySelector("#sWait .count").textContent`)).toBe("2");
  expect(errors).toEqual([]);
}, 40_000);

test.skipIf(!chromeFound)("choosing a lane narrows the questions, says so, and Escape and the chip go back", async () => {
  const shown = () => page.evaluate(`[...document.querySelectorAll("#hud .ask")].map((a) => a.dataset.lane)`);
  const text = (sel: string) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  expect(await shown()).toEqual(["golf", "alpha"]);
  // A question's lane tag chooses that lane: its question stays, the other's is counted in the first line.
  await page.evaluate(`document.querySelector('#hud .ask[data-lane="golf"] [data-select]').click()`);
  await until(`document.querySelectorAll("#hud .ask").length === 1`);
  expect(await shown()).toEqual(["golf"]);
  expect(await text(".scopechip")).toBe("golf ✕");
  expect(await text("#hud .scopeline")).toBe("+1 FROM OTHER AGENTS · SHOW ALL");
  expect(await text("#sWait .count")).toBe("1");
  expect(await text("#card h3")).toBe("golf");
  expect(await page.evaluate(`!document.querySelector(".scopeborder").hidden`)).toBe(true);
  // SHOW ALL lists everything again and says how to narrow.
  await page.evaluate(`document.querySelector("#hud .scopeline").click()`);
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
  expect(await text("#hud .scopeline")).toBe("ALL AGENTS · ONLY golf");
  // Escape goes out a level: nothing chosen, nothing narrowed, no chip, no border.
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await until(`document.querySelector(".scopechip").hidden`);
  expect(await page.evaluate(`document.querySelector(".scopeborder").hidden`)).toBe(true);
  expect(await page.evaluate(`!document.querySelector("#hud .scopeline")`)).toBe(true);
  expect(await shown()).toEqual(["golf", "alpha"]);
  // The chip's ✕ does the same.
  await page.evaluate(`document.querySelector('#hud .ask[data-lane="alpha"] [data-select]').click()`);
  await until(`document.querySelectorAll("#hud .ask").length === 1`);
  await page.evaluate(`document.querySelector(".scopechip").click()`);
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
  expect(errors).toEqual([]);
}, 40_000);
