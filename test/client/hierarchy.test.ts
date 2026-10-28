// The lane tree in the page: each theme paints a distinct look per depth (compared pixel by pixel, the same worker
// in each), a room with no tree wears the everyday look, the workers dress by their lane's depth and the chosen
// theme, and the worker card shows the level and the path up to HQ. Needs Chrome (CHROME_BIN); skipped without it.
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
// A sample tree: two managers, a lead under one, an engineer under the lead.
const TREE = [["web-pm", ""], ["data-pm", ""], ["api-lead", "web-pm"], ["api-auth", "api-lead"]];

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  for (const [name] of TREE) await server.post("/api/lanes", { name, machine: "local" });
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("card")?.innerHTML`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

// Paints one worker in each look of each theme, facing down and up, and returns each painting's pixels as a string.
const PAINT = `(async () => {
  const { drawSprite } = await import("/src/client/room/sprites.js");
  const { setCtx, ctx: live } = await import("/src/client/room/canvas.js");
  const { dressed, lookFor, themeOf } = await import("/src/client/room/looks.js");
  const { palette } = await import("/src/client/room/palette.js");
  const paint = (pal, dir) => {
    const c = document.createElement("canvas"); c.width = 48; c.height = 48;
    const g = c.getContext("2d");
    setCtx(g);
    try { drawSprite(pal, 0, 0, dir, 0); } finally { setCtx(live); }
    return Array.from(g.getImageData(0, 0, 48, 48).data).join(",");
  };
  const out = {};
  for (const t of ["office", "arena"]) for (const dir of ["down", "up"]) {
    for (const d of [1, 2, 3, 4, 5, 6]) out[t + "|" + dir + "|" + d] = paint(dressed("sample-worker", lookFor(themeOf(t), d, false), 7), dir);
    out[t + "|" + dir + "|flat"] = paint(dressed("sample-worker", lookFor(themeOf(t), 1, true), 7), dir);
  }
  for (const dir of ["down", "up"]) out["everyday|" + dir] = paint(palette("sample-worker"), dir);
  return out;
})()`;

test.skipIf(!chromeFound)("a room with no tree wears the everyday look, and the card shows no path", async () => {
  const looks = await page.evaluate(`import("/src/client/room/workers.js").then(({ workers }) => [...workers.values()].map((w) => w.pal.look?.id ?? null))`);
  expect(looks).toEqual([null, null, null, null]);
  expect(await page.evaluate(`import("/src/client/room/workers.js").then(({ workers }) => [...workers.values()].map((w) => w.mark ?? null))`)).toEqual([null, null, null, null]);
  await page.evaluate(`(() => { const b = document.createElement("button"); b.dataset.select = "web-pm"; document.body.append(b); b.click(); b.remove(); })()`);
  await until(`document.querySelector("#card h3")?.textContent === "web-pm"`);
  expect(await page.evaluate(`!!document.querySelector("#card .path")`)).toBe(false);
  // Choosing a lane scopes the page to it; with one floor the chip names only the lane.
  expect(await page.evaluate(`document.querySelector(".scopechip").textContent`)).toBe("web-pm ✕");
});

test.skipIf(!chromeFound)("each theme paints a distinct look for each depth, from the front and from behind", async () => {
  const px = await page.evaluate(PAINT);
  for (const t of ["office", "arena"]) for (const dir of ["down", "up"]) {
    const looks = [1, 2, 3, 4, 5, 6].map((d) => px[`${t}|${dir}|${d}`]);
    const count = t === "office" ? 3 : 5; // office: blazer, cardigan, everyday; arena: star, square, triangle, circle, player
    expect(new Set(looks.slice(0, count)).size).toBe(count);
    for (const deeper of looks.slice(count)) expect(deeper).toBe(looks[count - 1]); // past the theme's list: the last look
  }
  // Office: rank 3 and a room with no tree are the everyday look, pixel for pixel.
  for (const dir of ["down", "up"]) {
    expect(px[`office|${dir}|3`]).toBe(px[`everyday|${dir}`]);
    expect(px[`office|${dir}|flat`]).toBe(px[`everyday|${dir}`]);
  }
  // the two themes dress the same depth differently
  expect(px["office|down|1"]).not.toBe(px["arena|down|1"]);
});

test.skipIf(!chromeFound)("with a tree, workers dress by depth and theme, and the card shows the level and the path", async () => {
  for (const [name, parent] of TREE) if (parent) await server.post("/api/lanes", { name, parent });
  // web-pm runs a lead with a report, so it heads a floor of its own: its lanes are workers on that floor's copy of the
  // room (loaded from /floor/web-pm/...), and web-pm stands at that floor's terminal, not at a desk. Every floor's
  // workers together are the office's.
  await until(`!!document.getElementById("room-web-pm")`);
  const everyFloor = (pick: string) => `Promise.all(["/src/client/room/workers.js", "/floor/web-pm/src/client/room/workers.js"].map((u) => import(u))).then((ms) => JSON.stringify(Object.fromEntries(ms.flatMap(({ workers }) => [...workers].map(([n, w]) => [n, ${pick}])))))`;
  const looksNow = everyFloor("w.pal.look?.id ?? null");
  await until(`${looksNow}.then((s) => JSON.parse(s)["api-auth"] === null && JSON.parse(s)["data-pm"] === "blazer")`);
  expect(JSON.parse(await page.evaluate(looksNow))).toEqual({ "api-auth": null, "api-lead": "cardigan", "data-pm": "blazer" });
  // the label marks: three pips at the top level, then two, then one, so the level reads from behind too
  const marks = everyFloor("w.mark?.pips ?? null");
  expect(JSON.parse(await page.evaluate(marks))).toEqual({ "api-auth": 1, "api-lead": 2, "data-pm": 3 });
  await server.post("/api/settings", { settings: { theme: "arena" } });
  await until(`${looksNow}.then((s) => JSON.parse(s)["data-pm"] === "guard-star")`);
  expect(JSON.parse(await page.evaluate(looksNow))).toEqual({ "api-auth": "guard-triangle", "api-lead": "guard-square", "data-pm": "guard-star" });
  // Arena's label marks are the masks' own shapes
  const symbols = everyFloor("w.mark?.symbol ?? null");
  expect(JSON.parse(await page.evaluate(symbols))).toEqual({ "api-auth": "triangle", "api-lead": "square", "data-pm": "star" });
  // a level set by hand wins over the tree: api-auth is made a Manager, the top rank
  await server.post("/api/lanes", { name: "api-auth", level: "manager" });
  await until(`${looksNow}.then((s) => JSON.parse(s)["api-auth"] === "guard-star")`);
  await server.post("/api/lanes", { name: "api-auth", level: "auto" });
  await until(`${looksNow}.then((s) => JSON.parse(s)["api-auth"] === "guard-triangle")`);

  await page.evaluate(`(() => { const b = document.createElement("button"); b.dataset.select = "api-auth"; document.body.append(b); b.click(); b.remove(); })()`);
  await until(`document.querySelector("#card h3")?.textContent === "api-auth" && !!document.querySelector("#card .path")`);
  expect(await page.evaluate(`document.querySelector("#card .path .level").textContent`)).toBe("ENGINEER");
  expect(await page.evaluate(`document.querySelector("#card .path .chain").textContent`)).toBe("HQ > web-pm > api-lead > api-auth");
  // web-pm directs a lead, so it heads a floor of its own: the chip names the floor, then the lane.
  expect(await page.evaluate(`document.querySelector(".scopechip").textContent`)).toBe("WEB-PM FLOOR › api-auth ✕");
  // a step in the path selects that lane
  await page.evaluate(`document.querySelector('#card .path [data-select="web-pm"]').click()`);
  await until(`document.querySelector("#card h3")?.textContent === "web-pm"`);
  expect(await page.evaluate(`document.querySelector("#card .path .level").textContent`)).toBe("MANAGER");
  expect(await page.evaluate(`document.querySelector(".scopechip").textContent`)).toBe("WEB-PM FLOOR › web-pm ✕");
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("SETTINGS saves the level names and the theme", async () => {
  await page.evaluate(`document.getElementById("settingsBtn").click()`);
  await until(`!!document.querySelector("[data-levels]")`);
  await page.evaluate(`(() => { const f = document.querySelector("[data-levels]"); f.elements.levels.value = " PM ,Senior,, Junior "; f.requestSubmit(); })()`);
  for (let i = 0; i < 100 && (await (await fetch(`${server.base}/api/settings`)).json()).settings.levels !== "PM, Senior, Junior"; i++) await Bun.sleep(50);
  expect((await (await fetch(`${server.base}/api/settings`)).json()).settings.levels).toBe("PM, Senior, Junior");
  await until(`document.querySelector("#card .path .level")?.textContent === "PM"`);
  await page.evaluate(`document.querySelector('[data-set="theme"][data-val="office"]').click()`);
  for (let i = 0; i < 100 && (await (await fetch(`${server.base}/api/settings`)).json()).settings.theme !== "office"; i++) await Bun.sleep(50);
  expect((await (await fetch(`${server.base}/api/settings`)).json()).settings.theme).toBe("office");
  expect(errors).toEqual([]);
});
