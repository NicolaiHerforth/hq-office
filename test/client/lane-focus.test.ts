// Who needs the owner, and a lane in focus, on a phone (390x844, touch) against a temporary server: a lane with an
// open question carries the red bubble and a lane waiting on HQ carries none; a tap on a worker puts its lane in focus
// over the question column, which then shows only its questions (answerable there) or its messages; the empty floor
// and Esc show everyone again. Needs Chrome; skipped without it.
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
const state = async () => (await fetch(`${server.base}/api/state`)).json();
// A click on the canvas where a worker (or, with null, an empty floor tile) is drawn.
const tap = (lane: string | null) => page.evaluate(`import("/src/client/room/workers.js").then(({ workers }) => {
  const cv = document.getElementById("room"), r = cv.getBoundingClientRect();
  const at = ${lane ? `workers.get(${JSON.stringify(lane)})` : `{ x: 8, y: 14.5 }`};
  cv.dispatchEvent(new MouseEvent("click", { clientX: r.left + ((at.x * 16 + 8) / 384) * r.width, clientY: r.top + ((at.y * 16 + 2) / 256) * r.height, bubbles: true }));
})`);
// Pixels of a colour in the box over a worker's head, where a status bubble is drawn (canvas pixels: 16px tiles, x3).
const bubblePixels = (lane: string, rgb: number[]) => page.evaluate(`import("/src/client/room/workers.js").then(({ workers }) => {
  const w = workers.get(${JSON.stringify(lane)}), sx = w.x * 16, sy = w.y * 16 - 6;
  const d = document.getElementById("room").getContext("2d").getImageData((sx + 6) * 3, (sy - 18) * 3, 18 * 3, 18 * 3).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === ${rgb[0]} && d[i + 1] === ${rgb[1]} && d[i + 2] === ${rgb[2]}) n++;
  return n;
})`);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  // The fake herdr: golf working, alpha idle (its turn is over: waiting on HQ). bravo has a question for the owner.
  await server.post("/api/lanes", { name: "alpha", phase: "running", machine: "local", role: "pm", projects: ["Plans=https://linear.app/acme/project/plans-1a2b3c4d5e6f"] });
  await server.post("/api/lanes", { name: "bravo", phase: "running", machine: "local", role: "builder" });
  await server.post("/api/lanes", { name: "golf", phase: "running", machine: "local" });
  await server.post("/api/asks", { lane: "bravo", kind: "decision", title: "Ship the thing?", options: ["Yes", "No"] });
  await server.post("/api/asks", { lane: "golf", kind: "action", title: "Approve the deploy" });
  await server.post("/api/updates", { lane: "alpha", title: "Plan is written" });
  await server.post("/api/updates", { lane: "golf", title: "Golf news" });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
  // the workers walk to their places
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === 3 && [...workers.values()].every((w) => !w.path.length))`);
  await Bun.sleep(300);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  chrome?.close();
});

test.skipIf(!chromeFound)("a lane with a question for the owner carries the red bubble; a lane waiting on HQ carries no bubble", async () => {
  const s = await state();
  expect(s.lanes.find((l: any) => l.name === "bravo").status).toBe("needs_you");
  expect(s.lanes.find((l: any) => l.name === "alpha").status).toBe("hq_turn");
  expect(await bubblePixels("bravo", [214, 60, 60])).toBeGreaterThan(50); // the red bubble
  expect(await bubblePixels("alpha", [214, 60, 60])).toBe(0);
  expect(await bubblePixels("alpha", [255, 255, 255])).toBe(0); // no white bubble with a "?"
});

test.skipIf(!chromeFound)("a tap on a worker with a question focuses its lane: only its question, answerable there", async () => {
  await tap("bravo");
  await until(`!document.getElementById("card").hidden && document.querySelector("#card h3")?.textContent === "bravo"`);
  expect(await page.evaluate(`document.querySelector("#card .tag.role").textContent`)).toBe("BUILDER");
  expect(await page.evaluate(`[...document.querySelectorAll("#hud .ask h3")].map((h) => h.textContent)`)).toEqual(["Ship the thing?"]);
  expect(await page.evaluate(`document.getElementById("qtCount").textContent`)).toBe("1");
  // the page went up to the column
  expect(await page.evaluate(`document.getElementById("card").getBoundingClientRect().top < innerHeight`)).toBe(true);
  await page.evaluate(`document.querySelector('#hud .opt[data-opt="Yes"]').click()`);
  await until(`document.querySelector('#hud .opt.sel')?.dataset.opt === "Yes"`);
  await page.evaluate(`document.querySelector("#hud .send").click()`);
  await until(`(document.querySelector("#hud h2")?.textContent ?? "").includes("NOTHING FROM BRAVO")`);
  expect((await state()).answered.find((a: any) => a.title === "Ship the thing?")?.answer).toBe("Yes");
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("a lane without a question opens on its own messages, with its projects linked", async () => {
  await tap("alpha");
  await until(`document.querySelector("#card h3")?.textContent === "alpha" && !document.getElementById("msgs").hidden`);
  await until(`document.getElementById("msgs").textContent.includes("Plan is written")`);
  expect(await page.evaluate(`document.getElementById("msgs").textContent.includes("Golf news")`)).toBe(false);
  expect(await page.evaluate(`document.querySelector("#card a.proj").href`)).toBe("https://linear.app/acme/project/plans-1a2b3c4d5e6f");
  expect(await page.evaluate(`document.querySelector("#card a.proj").textContent`)).toBe("Plans");
});

test.skipIf(!chromeFound)("the empty floor shows everyone again, and so does Esc", async () => {
  await tap(null);
  await until(`document.getElementById("card").hidden`);
  await until(`document.getElementById("msgs").textContent.includes("Golf news")`);
  await tap("golf");
  await until(`document.querySelector("#card h3")?.textContent === "golf"`);
  await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await until(`document.getElementById("card").hidden`);
  await page.evaluate(`document.querySelector('[data-qtab="questions"]').click()`);
  await until(`document.querySelectorAll("#hud .ask").length === 1`);
  expect(errors).toEqual([]);
});
