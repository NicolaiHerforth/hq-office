// The agent drawer: clicking a worker (or a lane on the lanes board) slides in a read-only panel from the right with
// the lane's open question, its terminal (read every 3 seconds while open, never after), what it last said and its
// work. Against a temporary server and a stub herdr whose pane read answers a file; needs Chrome, skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-agent-drawer-"));
const SECRET = "sk_demo_5e4d3c2b1a09";
const ag = (name: string, status: string, i: number) => ({ name, agent_status: status, pane_id: `w1:p${i}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/p" });
const herdr = fakeHerdr(dir, [ag("hq", "idle", 1), ag("api", "working", 2), ag("asks", "idle", 3)]);
const pane = (text: string) => writeFileSync(join(dir, "block-start"), text);

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
const reads = (p: string) => herdr.calls().filter((c) => c[0] === "pane" && c[1] === "read" && c[2] === p).length;
const pick = (name: string) => ev(`import("/src/client/room/input.js").then((m) => m.select(${JSON.stringify(name)}))`);
async function load(w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  pane(`• Ran bun test\n  └ 14 pass, 0 fail\n• Ran curl -H "Authorization: Bearer ${SECRET}" https://api.example.com\n✻ Waiting for CI on #812`);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "api", title: "Token refresh", phase: "running", machine: "local", pr: "812" });
  await post("/api/lanes", { name: "asks", title: "Page size", phase: "running", machine: "local" });
  await post("/api/sync");
  await post("/api/secrets", { name: "API_TOKEN", value: SECRET, minutes: 5, by: "owner" });
  await post("/api/updates", { lane: "api", title: "Token refresh is up for review" });
  await post("/api/asks", { lane: "asks", kind: "decision", title: "Which page size?", options: ["A4", "Letter"], recommended: "A4" });
  await post("/api/rooms", { slug: "auth", title: "Auth work", owner: "api" });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await load();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a worker opens the drawer from the right, full height: its terminal, what it said, its work and room; nothing to type in", async () => {
  await pick("api");
  await until(`document.querySelector("#card .agterm:not(.wait)")?.textContent.includes("14 pass, 0 fail")`);
  const box = await ev(`(() => { const c = document.getElementById("card").getBoundingClientRect(), r = document.querySelector(".room").getBoundingClientRect(); return { w: c.width, right: Math.round(r.right - c.right), tall: c.height / r.height }; })()`);
  expect(box.w).toBeGreaterThan(480);
  expect(box.right).toBeLessThan(20);
  expect(box.tall).toBeGreaterThan(0.9);
  expect(await ev(`document.querySelector("#card .agsaid").textContent`)).toContain("Token refresh is up for review");
  expect(await ev(`[...document.querySelectorAll("#card .agroom")].map((a) => a.getAttribute("href"))`)).toEqual(["#room/auth"]);
  expect(await ev(`document.querySelectorAll("#card input, #card textarea, #card [contenteditable]").length`)).toBe(0);
  expect(await ev(`document.querySelector("#card .agfoot").textContent`)).toContain("write in its room");
}, 20_000);

test.skipIf(!chromeFound)("scrolled up in the terminal, a refresh keeps your place; at its end, it follows new output", async () => {
  pane(Array.from({ length: 30 }, (_, i) => `line ${i + 1} ` + "x".repeat(20)).join("\n"));
  await until(`document.querySelector("#card .agterm").textContent.includes("line 30")`, 6000);
  await ev(`(() => { const t = document.querySelector("#card .agterm"); t.scrollTop = 40; t.dispatchEvent(new Event("scroll")); })()`);
  pane(Array.from({ length: 30 }, (_, i) => `line ${i + 2} ` + "x".repeat(20)).join("\n"));
  await until(`document.querySelector("#card .agterm").textContent.includes("line 31")`, 6000);
  expect(await ev(`document.querySelector("#card .agterm").scrollTop`)).toBe(40);
  await ev(`(() => { const t = document.querySelector("#card .agterm"); t.scrollTop = t.scrollHeight; t.dispatchEvent(new Event("scroll")); })()`);
  pane(`• Ran bun test\n  └ 14 pass, 0 fail\n• Ran curl -H "Authorization: Bearer ${SECRET}" https://api.example.com\n✻ Waiting for CI on #812`);
  await until(`document.querySelector("#card .agterm").textContent.includes("Waiting for CI")`, 6000);
}, 30_000);

test.skipIf(!chromeFound)("a secret's value never reaches the page: the terminal shows its name", async () => {
  expect(await ev(`document.getElementById("card").textContent.includes("[secret API_TOKEN]")`)).toBe(true);
  expect(await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)})`)).toBe(false);
}, 20_000);

test.skipIf(!chromeFound)("the terminal is read every 3 seconds while the drawer is open, and not at all once it is closed", async () => {
  const a = reads("w1:p2");
  await Bun.sleep(6800);
  const n = reads("w1:p2") - a;
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(3);
  pane("• new output line\n✻ Waiting for CI on #812");
  await until(`document.querySelector("#card .agterm").textContent.includes("new output line")`, 5000);
  await ev(`document.querySelector("[data-card-close]").click()`);
  expect(await ev(`document.getElementById("card").hidden`)).toBe(true);
  const b = reads("w1:p2");
  await Bun.sleep(4000);
  expect(reads("w1:p2")).toBe(b);
}, 30_000);

test.skipIf(!chromeFound)("a lane waiting on you shows its question first; ANSWER IN NEEDS YOU goes to it", async () => {
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await pick("asks");
  await until(`!!document.querySelector("#card .agq")`);
  expect(await ev(`[...document.getElementById("card").children].findIndex((e) => e.classList.contains("agq")) < [...document.getElementById("card").children].findIndex((e) => e.classList.contains("agsec"))`)).toBe(true);
  expect(await ev(`document.querySelector("#card .agq").textContent`)).toContain("Which page size?");
  await ev(`document.querySelector("[data-answer-jump]").click()`);
  await until(`!document.getElementById("hud").hidden && document.querySelector('.ask[data-lane="asks"]')?.classList.contains("flash")`);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await ev(`document.getElementById("card").hidden`)).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("its room link opens the room and closes the drawer", async () => {
  await pick("api");
  await until(`!!document.querySelector("#card .agroom")`);
  await ev(`document.querySelector("#card .agroom").click()`);
  await until(`location.hash === "#room/auth" && document.getElementById("card").hidden`);
  await ev(`location.hash = ""`);
  await until(`document.getElementById("roomView").hidden`);
}, 20_000);

test.skipIf(!chromeFound)("on a phone it is a sheet inside the screen; ANSWER IN NEEDS YOU closes it at the question", async () => {
  await load(390, 844, true);
  await pick("api");
  await until(`!document.getElementById("card").hidden && !!document.querySelector("#card .agterm:not(.wait)")`);
  await Bun.sleep(400); // the slide-in has ended
  const b = await ev(`(() => { const b = document.getElementById("card").getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth }; })()`);
  expect(b.l >= 0 && b.r <= b.w && b.b <= b.h && b.t >= 0).toBe(true);
  expect(b.sw <= b.w).toBe(true);
  await pick("asks");
  await until(`!!document.querySelector("#card [data-answer-jump]")`);
  await ev(`document.querySelector("#card [data-answer-jump]").click()`);
  await until(`document.getElementById("card").hidden && !!document.querySelector('.ask[data-lane="asks"].flash')`);
  expect(errors).toEqual([]);
}, 20_000);
