// NEEDS YOU: the panel of everything the owner is the blocker on. Each card reads as a QUESTION (options, SEND), a
// TO DO (something the owner must do: DONE or NOT YET) or FYI (OK). NOT YET keeps the card, with a line saying so.
// Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ids: Record<string, number> = {};
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const card = (id: number) => `document.querySelector('#hud [data-ask="${id}"]')`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  ids.decision = (await server.post("/api/asks", { title: "Ship the thing?", kind: "decision", options: ["Yes", "No"], recommended: "Yes" })).id;
  ids.action = (await server.post("/api/asks", { title: "Record the demo video", kind: "action", lane: "golf" })).id;
  ids.info = (await server.post("/api/asks", { title: "The deploy went out", kind: "info" })).id;
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`document.querySelectorAll("#hud .ask").length === 3`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("the panel is NEEDS YOU, and each card says what kind of blocker it is", async () => {
  expect(await page.evaluate(`document.querySelector('[data-qtab="questions"]').firstChild.textContent.trim()`)).toBe("NEEDS YOU");
  const kind = (id: number) => page.evaluate(`${card(id)}.querySelector(".tag.kind").textContent`);
  expect(await kind(ids.decision)).toBe("QUESTION");
  expect(await kind(ids.action)).toBe("TO DO");
  expect(await kind(ids.info)).toBe("FYI");
  const buttons = (id: number) => page.evaluate(`[...${card(id)}.querySelectorAll(".acts button:not(.attach)")].map((b) => b.textContent)`);
  expect(await buttons(ids.action)).toEqual(["NOT YET", "DONE"]);
  expect(await buttons(ids.decision)).toEqual(["SEND"]);
  expect(await buttons(ids.info)).toEqual(["OK"]);
});

test.skipIf(!chromeFound)("NOT YET keeps the card, with the owner's note on it, and empties the box", async () => {
  await page.evaluate(`(() => { const t = ${card(ids.action)}.querySelector("textarea"); t.value = "after lunch"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await page.evaluate(`${card(ids.action)}.querySelector(".notyet").click()`);
  await until(`(${card(ids.action)}?.textContent ?? "").includes("not yet. after lunch")`);
  expect(await page.evaluate(`!!${card(ids.action)}`)).toBe(true);
  expect(await page.evaluate(`${card(ids.action)}.querySelector("textarea").value`)).toBe("");
});

test.skipIf(!chromeFound)("DONE closes it as before; with nothing left the panel says nothing needs you", async () => {
  for (const id of [ids.action, ids.info]) await page.evaluate(`${card(id)}.querySelector(".send").click()`);
  await server.post(`/api/asks/${ids.decision}/answer`, { answer: "Yes" });
  await until(`!document.querySelector("#hud .ask")`);
  expect(await page.evaluate(`document.querySelector("#hud h2").textContent`)).toBe("NOTHING NEEDS YOU");
  expect(errors).toEqual([]);
});
