// The page's layouts (MENU › LAYOUT): OFFICE, the default, gives the office the whole right column; LANES BOARD puts
// every lane by name under it (WORKING / WAITING ON YOU / NOT MOVING, parked and done counted). The choice is each
// viewer's own, kept in this browser. Also MENU itself (SECRETS, SETTINGS, SOUND, LAYOUT), the worker card over the
// office, and your answers in MESSAGES. Against a temporary server and a stub herdr; needs Chrome, skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-layouts-"));
const ag = (name: string, status: string, i: number) => ({ name, agent_status: status, pane_id: `w1:p${i}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/p" });
const herdr = fakeHerdr(dir, [ag("hq", "idle", 1), ag("api", "working", 2), ag("asks", "idle", 3), ag("idler", "idle", 4), ag("shelved", "idle", 5), ag("finished", "idle", 6)]);

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
const shown = (sel: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; })()`);
const col = (kind: string) => ev(`[...document.querySelectorAll(".lbcol.${kind} [data-lane-pick]")].map((r) => r.dataset.lanePick)`);
async function load(w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  for (const [name, title, phase] of [["api", "Token refresh", "running"], ["asks", "Page size", "running"], ["idler", "Docs search", "running"], ["shelved", "Later", "parked"], ["finished", "Shipped", "done"]]) await post("/api/lanes", { name, title, phase, machine: "local" });
  await post("/api/asks", { lane: "asks", kind: "decision", title: "Which page size?", options: ["A4", "Letter"] });
  const done = await post("/api/asks", { lane: "api", kind: "decision", title: "Retry failed invoices?", options: ["Yes", "No"] });
  await post(`/api/asks/${done.id}/answer`, { answer: "Yes, three times" });
  const gone = await post("/api/asks", { lane: "api", kind: "decision", title: "Withdrawn one" });
  await post(`/api/asks/${gone.id}/withdraw`, {});
  await post("/api/sync");
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await load();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
}, 20_000);

test.skipIf(!chromeFound)("OFFICE is the default: no panel under the office, no FROM HQ or FLOORS box, MENU in the top bar, no empty card", async () => {
  expect(await ev(`document.documentElement.dataset.layout`)).toBe("office");
  expect(await shown(".under")).toBe(false);
  expect(await ev(`!document.getElementById("sFrom") && !document.querySelector(".ffloors") && !document.getElementById("feed")`)).toBe(true);
  expect(await shown("#menuBtn")).toBe(true);
  expect(await ev(`document.getElementById("card").hidden`)).toBe(true);
  // the office takes the column: the room reaches down to the bottom of the page
  expect(await ev(`innerHeight - document.querySelector(".room").getBoundingClientRect().bottom`)).toBeLessThan(40);
}, 20_000);

test.skipIf(!chromeFound)("MENU: SECRETS, SETTINGS, SOUND and LAYOUT; Esc closes it and gives focus back; a click elsewhere closes it", async () => {
  await ev(`document.getElementById("menuBtn").click()`);
  expect(await shown("#menuDrop")).toBe(true);
  expect(await ev(`[...document.querySelectorAll("#menuDrop .mi")].map((m) => m.firstChild.textContent.trim())`)).toEqual(["SECRETS", "SETTINGS", "SOUND OFF", "LAYOUT"]);
  expect(await ev(`document.getElementById("secretsSay").textContent`)).toBe("none held");
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await shown("#menuDrop")).toBe(false);
  expect(await ev(`document.activeElement?.id`)).toBe("menuBtn");
  await ev(`document.getElementById("menuBtn").click()`);
  await ev(`document.getElementById("hud").click()`);
  expect(await shown("#menuDrop")).toBe(false);
}, 20_000);

test.skipIf(!chromeFound)("LANES BOARD: every lane by what it is doing, parked and done counted; the choice survives a reload", async () => {
  await ev(`document.getElementById("menuBtn").click()`);
  await ev(`document.querySelector('#menuDrop [data-layout="board"]').click()`);
  expect(await shown("#menuDrop")).toBe(true); // stays open so the change shows
  expect(await ev(`document.documentElement.dataset.layout`)).toBe("board");
  expect(await shown(".under")).toBe(true);
  await until(`document.querySelectorAll(".lbcol").length === 3`);
  expect(await col("lbwork")).toEqual(["api"]);
  expect(await col("lbyou")).toEqual(["asks"]);
  expect(await ev(`document.querySelector('.lbcol.lbyou [data-lane-pick="asks"] .lbx').textContent`)).toBe("Which page size?");
  expect(await col("lbstill")).toEqual(["idler"]);
  expect(await ev(`document.querySelector('.lbcol.lbstill [data-lane-pick="idler"] .lbx').textContent`)).toBe("Waiting on HQ");
  expect(await ev(`document.querySelector(".lbfoot").textContent`)).toBe("1 PARKED · 1 DONE");
  expect(await ev(`document.querySelector(".lbwhere").textContent`)).toBe("By what they are doing now"); // one floor
  expect(await ev(`document.querySelector(".room").getBoundingClientRect().height`)).toBeGreaterThan(250);
  await load();
  expect(await ev(`localStorage.getItem("hq-layout")`)).toBe("board");
  await until(`document.querySelectorAll(".lbcol").length === 3`);
  expect(await shown(".under")).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("a lane on the board opens its card over the office; ✕ and Esc close it", async () => {
  await ev(`document.querySelector('[data-lane-pick="api"]').click()`);
  await until(`document.querySelector("#card h3")?.textContent === "api"`);
  await Bun.sleep(400); // the drawer's slide-in has ended
  expect(await ev(`(() => { const c = document.getElementById("card").getBoundingClientRect(), r = document.querySelector(".room").getBoundingClientRect(); return c.top >= r.top && c.right <= r.right; })()`)).toBe(true);
  expect(await ev(`document.querySelector('[data-lane-pick="api"]').classList.contains("on")`)).toBe(true);
  await ev(`document.querySelector("[data-card-close]").click()`);
  expect(await ev(`document.getElementById("card").hidden`)).toBe(true);
  await ev(`document.querySelector('[data-lane-pick="idler"]').click()`);
  await until(`!document.getElementById("card").hidden`);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await ev(`document.getElementById("card").hidden`)).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("MENU › SECRETS opens the panel over the office; a saved secret is counted; Esc closes it", async () => {
  await ev(`document.getElementById("menuBtn").click()`);
  await ev(`document.getElementById("secretsBtn").click()`);
  await until(`!document.getElementById("secretsPanel").hidden`);
  expect(await shown("#menuDrop")).toBe(false);
  expect(await ev(`document.activeElement?.id`)).toBe("secName");
  await post("/api/secrets", { name: "DEMO_TOKEN", value: "not-a-real-value", minutes: 5, by: "owner" });
  await until(`document.getElementById("secretList").textContent.includes("DEMO_TOKEN") && document.getElementById("secretsSay").textContent === "1 held"`);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await ev(`document.getElementById("secretsPanel").hidden`)).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("MESSAGES holds your answers (with whether HQ acted), not a withdrawn question", async () => {
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`!!document.querySelector('#msgs [data-msg^="a"]')`);
  const a = await ev(`document.querySelector('#msgs [data-msg^="a"]').innerText`);
  expect(a).toContain("ANSWERED");
  expect(a).toContain("Retry failed invoices?");
  expect(a).toContain("Yes, three times");
  expect(a).toContain("HQ TO ACT");
  expect(await ev(`document.getElementById("msgs").textContent.includes("Withdrawn one")`)).toBe(false);
  await ev(`document.querySelector('[data-qtab="questions"]').click()`);
}, 20_000);

test.skipIf(!chromeFound)("more than eight working lanes fold into a row of names", async () => {
  const many = Array.from({ length: 9 }, (_, i) => `w${i + 1}`);
  herdr.world([...herdr.agents(), ...many.map((n, i) => ag(n, "working", 40 + i))]);
  for (const n of many) await post("/api/lanes", { name: n, title: `Work ${n}`, phase: "running", machine: "local" });
  await post("/api/sync");
  await until(`document.querySelectorAll(".lbcol.lbwork .lbchip").length === 10`);
  expect(await ev(`document.querySelector(".lbcol.lbwork h3 em").textContent`)).toBe("10");
}, 20_000);

test.skipIf(!chromeFound)("on a phone the board stacks, WAITING ON YOU first, with no sideways scroll; OFFICE has no board", async () => {
  await load(390, 844, true);
  await until(`document.querySelectorAll(".lbcol").length === 3`);
  const order = await ev(`[...document.querySelectorAll(".lbcol")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((c) => c.classList[1])`);
  expect(order[0]).toBe("lbyou");
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  // a lane opens its card as a sheet at the bottom of the screen, on screen whatever the page's scroll
  await ev(`document.querySelector('[data-lane-pick="idler"]').click()`);
  await until(`!document.getElementById("card").hidden`);
  await Bun.sleep(400); // the slide-in has ended
  expect(await ev(`(() => { const b = document.getElementById("card").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight && b.top >= 0; })()`)).toBe(true);
  await ev(`document.querySelector("[data-card-close]").click()`);
  // MENU is on the title's row, and opens as a sheet inside the screen
  expect(await ev(`Math.abs(document.getElementById("menuBtn").getBoundingClientRect().top - document.querySelector(".top .title").getBoundingClientRect().top) < 12`)).toBe(true);
  await ev(`document.getElementById("menuBtn").click()`);
  expect(await ev(`(() => { const b = document.getElementById("menuDrop").getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; })()`)).toBe(true);
  await ev(`document.getElementById("menuBtn").click()`);
  await ev(`localStorage.setItem("hq-layout", "office")`);
  await load(390, 844, true);
  expect(await shown(".under")).toBe(false);
  expect(errors).toEqual([]);
}, 20_000);
