// + NEW ROOM on the ROOMS tab: the owner opens a room from the page (a title, the owning lane, other lanes, an issue,
// a first message), lands in it, and the first message is typed into the owning lane. Against a temporary server and a
// stub herdr; needs Chrome, skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-new-room-"));
const ag = (name: string, i: number) => ({ name, agent_status: "idle", pane_id: `w1:p${i}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/p" });
const herdr = fakeHerdr(dir, [ag("hq", 1), ag("pm", 2), ag("eng", 3), ag("design", 4)]);

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
const set = (sel: string, v: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event(e.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()`);
async function load(w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`document.querySelector('[data-qtab="rooms"]').click()`);
  await until(`!!document.querySelector("[data-room-new]")`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  for (const name of ["pm", "eng", "design"]) await post("/api/lanes", { name, title: `${name} work`, machine: "local" });
  await post("/api/sync");
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await load();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("with no rooms, the ROOMS tab offers + NEW ROOM; the panel opens over the office at its title", async () => {
  expect(await ev(`document.getElementById("rooms").textContent.includes("Open one with + NEW ROOM")`)).toBe(true);
  await ev(`document.querySelector("[data-room-new]").click()`);
  await until(`!!document.querySelector(".nrpanel:not([hidden]) #nrTitle")`);
  expect(await ev(`document.activeElement?.id`)).toBe("nrTitle");
  expect(await ev(`[...document.querySelectorAll("#nrOwner option")].map((o) => o.value)`)).toEqual(["", "design", "eng", "pm", "hq"]);
}, 20_000);

test.skipIf(!chromeFound)("it says what is missing; the owner is never offered as another lane", async () => {
  await ev(`document.querySelector(".nrpanel [type=submit]").click()`);
  await until(`document.querySelector(".nrerr")?.textContent === "Give the room a title."`);
  await set("#nrTitle", "Pricing page");
  await ev(`document.querySelector(".nrpanel [type=submit]").click()`);
  await until(`document.querySelector(".nrerr")?.textContent === "Pick the lane that owns the room."`);
  await set("#nrOwner", "pm");
  expect(await ev(`[...document.querySelectorAll(".nrlane input")].map((i) => i.value)`)).toEqual(["design", "eng"]);
  expect(await ev(`document.getElementById("nrTitle").value`)).toBe("Pricing page");
}, 20_000);

test.skipIf(!chromeFound)("OPEN ROOM: the room opens, with its lanes and issue, and the first message goes to the owning lane", async () => {
  await ev(`document.querySelector('.nrlane input[value="eng"]').click()`);
  await set("#nrIssue", "ope-12");
  await set("#nrText", "Draft the pricing copy here, please.");
  await ev(`document.querySelector(".nrpanel [type=submit]").click()`);
  await until(`location.hash === "#room/pricing-page"`);
  expect(await ev(`document.querySelector(".nrpanel").hidden`)).toBe(true);
  const v = await (await fetch(`${server.base}/api/rooms/pricing-page`)).json();
  expect(v).toMatchObject({ title: "Pricing page", owner: "pm", members: ["eng"], issues: ["OPE-12"] });
  for (let i = 0; i < 160 && !herdr.typedInto("pm").some((t) => t.includes("Draft the pricing copy here, please.")); i++) await Bun.sleep(25);
  expect(herdr.typedInto("pm").find((t) => t.includes("Draft the pricing copy here"))).toContain("hud room say pricing-page");
  expect(herdr.typedInto("hq").some((t) => t.includes("opened room pricing-page"))).toBe(true);
  await until(`document.getElementById("roomView")?.textContent.includes("Draft the pricing copy here")`);
}, 20_000);

test.skipIf(!chromeFound)("Esc closes the panel; on a phone it is a sheet inside the screen", async () => {
  await ev(`location.hash = ""`);
  await until(`document.getElementById("roomView").hidden`);
  await ev(`document.querySelector("[data-room-new]").click()`);
  await until(`!document.querySelector(".nrpanel").hidden`);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await ev(`document.querySelector(".nrpanel").hidden`)).toBe(true);
  expect(await ev(`!document.getElementById("roomView").hidden`)).toBe(false); // still in the office
  await load(390, 844, true);
  await ev(`document.querySelector("[data-room-new]").click()`);
  await until(`!!document.querySelector(".nrpanel:not([hidden])")`);
  expect(await ev(`(() => { const b = document.querySelector(".nrpanel").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight && b.top >= 0; })()`)).toBe(true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(errors).toEqual([]);
}, 20_000);
