// FLOORS on the page (docs/floors.md, "The page"). One floor is the page as it was: no building, tag, scope line or
// FLOOR select. With four floors the stage shows the building (a tile per floor with its counts, a red mark when its
// HQ isn't receiving); a click enters a floor, whose office shows only its lanes, and every list and count follows
// it with a "+N on other floors · show all" line; SHOW ALL and the building tag each card with its floor; Esc steps
// out. TELL HQ goes to the floor you are in, or the one picked beside SEND, and the stub herdr logs which HQ was
// typed into. SETTINGS adds, renames and removes a floor. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
setDefaultTimeout(30_000);
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-floors-page-"));
const herdr = join(dir, "herdr");
const prompted = join(dir, "prompted.log");
// Three HQs are in herdr (hq, hq-backend, hq-legal); hq-sales is not, so the sales floor's HQ isn't receiving.
// ops-desk is an agent with no lane and no floor: SETTINGS offers it as an HQ.
const agent = (name: string, status = "idle") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude" });
const AGENTS = [agent("hq"), agent("hq-backend"), agent("hq-legal"), agent("ops-desk"), agent("golf", "working"), agent("be-api", "working"), agent("be-db"), agent("lg-contract", "working")];
writeFileSync(join(dir, "agents.json"), JSON.stringify(AGENTS));
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${dir}/agents.json")" ;;
  "agent prompt")
    grep -q "\\"name\\":\\"$3\\"" "${dir}/agents.json" || { echo '{"error":{"code":"agent_not_found","message":"not found"}}' >&2; exit 1; }
    printf '%s\\t%s\\n' "$3" "$4" >> "${prompted}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const ev = (expr: string) => page.evaluate(expr);
const click = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const lanesIn = (sel: string) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.dataset.lane).sort()`);
const state = async () => (await fetch(`${server.base}/api/state`)).json();
// What the stub herdr typed into each agent.
const typedInto = (name: string) => (existsSync(prompted) ? readFileSync(prompted, "utf8") : "").split("\n").filter((l) => l.startsWith(`${name}\t`)).join("\n");
const key = (k: string) => page.s("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
async function tell(words: string) {
  await ev(`document.getElementById("noteText").value = ${JSON.stringify(words)}`);
  await ev(`document.getElementById("compose").requestSubmit()`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr, HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" });
  await server.post("/api/lanes", { name: "golf", machine: "local", title: "On the first floor" });
  await server.post("/api/asks", { lane: "golf", kind: "decision", title: "First floor question", options: ["Yes", "No"] });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector(".ask")`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("one floor: the page as it was, with no building, tag, scope line or FLOOR select", async () => {
  expect(await ev(`!!document.querySelector(".floorbar, .building, .floortag, .scopeline, #tellFloor")`)).toBe(false);
  expect(await ev(`document.querySelector(".stage").hasAttribute("data-floors")`)).toBe(false);
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("An order, a change of plan, a question.");
  expect(await ev(`getComputedStyle(document.querySelector(".stage > .room")).display`)).not.toBe("none");
});

test.skipIf(!chromeFound)("four floors: the building, a tile per floor with its counts and a red mark when its HQ isn't receiving", async () => {
  await server.post("/api/floors", { id: "backend", name: "Backend", hq: "hq-backend", color: "#3c6fd6" });
  await server.post("/api/floors", { id: "legal", name: "Legal", hq: "hq-legal", color: "#6a6a82" });
  await server.post("/api/floors", { id: "sales", name: "Sales", hq: "hq-sales", color: "#e0901e" });
  await server.post("/api/lanes", { name: "be-api", machine: "local", title: "The API", floor: "backend" });
  await server.post("/api/lanes", { name: "be-db", machine: "local", title: "The database", floor: "backend" });
  await server.post("/api/lanes", { name: "lg-contract", machine: "local", title: "A contract", floor: "legal" });
  await server.post("/api/asks", { lane: "be-api", kind: "decision", title: "Backend question", options: ["A", "B"] });
  await server.post("/api/asks", { lane: "be-db", kind: "action", title: "Backend to do" });
  await server.post("/api/asks", { lane: "lg-contract", kind: "decision", title: "Legal question", options: ["Sign", "Wait"] });
  await server.post("/api/updates", { lane: "be-api", title: "Backend update" });
  await server.post("/api/updates", { lane: "lg-contract", title: "Legal update" });
  await server.post("/api/board/track", { issue: "BE-1", lane: "be-api" });
  await server.post("/api/board/track", { issue: "LG-1", lane: "lg-contract" });
  await server.post("/api/rooms", { slug: "be-room", title: "Backend room", owner: "be-api" });
  await server.post("/api/rooms", { slug: "lg-room", title: "Legal room", owner: "lg-contract" });
  await server.post("/api/notes", { text: "Backend note", floor: "backend" });
  await server.post("/api/notes", { text: "Legal note", floor: "legal" });
  await server.post("/api/sync", {});
  await until(`document.querySelectorAll(".building .ftile").length === 4`);
  await until(`!!document.querySelector('.ftile[data-floor="sales"] .fdown')`);
  expect(await ev(`[...document.querySelectorAll(".ftile")].map((t) => t.dataset.floor)`)).toEqual(["sales", "legal", "backend", "hq"]);
  const backend = await text('.ftile[data-floor="backend"]');
  expect(backend).toContain("BACKEND");
  expect(backend).toContain("hq-backend");
  expect(backend).toMatch(/2 NEED YOU/);
  expect(backend).toMatch(/1 WORKING/);
  expect(backend).toMatch(/2 LANES/);
  expect(await text('.ftile[data-floor="sales"] .fdown')).toContain("ISN'T RECEIVING");
  expect(await ev(`!!document.querySelector('.ftile[data-floor="backend"] .fdown')`)).toBe(false);
  // The office rests under the building; the lists show every floor, each card tagged.
  expect(await ev(`getComputedStyle(document.querySelector(".stage > .room")).display`)).toBe("none");
  expect(await ev(`document.querySelectorAll("#hud .ask").length`)).toBe(4);
  expect(await ev(`[...document.querySelectorAll("#hud .ask")].every((a) => a.querySelector(".floortag"))`)).toBe(true);
  expect(await ev(`document.querySelector("#sWait .count").textContent`)).toBe("4");
  // One line per floor whose HQ isn't receiving.
  expect(await text(".hqdown")).toContain("SALES");
});

test.skipIf(!chromeFound)("entering a floor: its office and every list and count follow it, with a line for the other floors", async () => {
  await click('.ftile[data-floor="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  const bar = await text(".floorbar");
  expect(bar).toContain("◀ BUILDING");
  expect(bar).toContain("BACKEND");
  expect(await ev(`getComputedStyle(document.querySelector(".stage > .room")).display`)).not.toBe("none");
  expect(await ev(`getComputedStyle(document.querySelector(".building")).display`)).toBe("none");
  const { workers } = await ev(`import("/src/client/room/workers.js").then((m) => ({ workers: [...m.workers.keys()].sort() }))`);
  expect(workers).toEqual(["be-api", "be-db"]);
  // NEEDS YOU and its count; WAITING ON YOU still counts every floor.
  expect(await lanesIn("#hud .ask")).toEqual(["be-api", "be-db"]);
  expect(await text("#hud .scopeline")).toBe("+2 ON OTHER FLOORS · SHOW ALL");
  expect(await ev(`document.getElementById("qtCount").textContent`)).toBe("2");
  expect(await ev(`document.querySelector("#sWait .count").textContent`)).toBe("4");
  expect(await ev(`!!document.querySelector("#hud .floortag")`)).toBe(false);
  // MESSAGES: this floor's, and opening it marks only this floor's updates read.
  expect(await ev(`document.getElementById("qtUnread").textContent`)).toBe("1 NEW");
  await click('[data-qtab="messages"]');
  await until(`document.getElementById("msgs").innerText.includes("Backend update") && document.getElementById("msgs").innerText.includes("Backend note")`);
  const msgs = await text("#msgs");
  expect(msgs).toContain("Backend note");
  expect(msgs).not.toContain("Legal update");
  expect(msgs).not.toContain("Legal note");
  for (let i = 0; i < 40; i++) { const s = await state(); if (s.updates.find((u: any) => u.title === "Backend update").read_at) break; await Bun.sleep(50); }
  const after = await state();
  expect(after.updates.find((u: any) => u.title === "Backend update").read_at).toBeTruthy();
  expect(after.updates.find((u: any) => u.title === "Legal update").read_at).toBeNull();
  // WORK and ROOMS.
  await click('[data-qtab="work"]');
  const work = await text("#work");
  expect(work).toContain("BE-1");
  expect(work).not.toContain("LG-1");
  await click('[data-qtab="rooms"]');
  await until(`document.getElementById("rooms").innerText.includes("Backend room")`);
  expect(await text("#rooms")).not.toContain("Legal room");
  expect(await text("#rooms .scopeline")).toContain("+1 ON OTHER FLOORS");
  await click('[data-qtab="questions"]');
  // SENT & ANSWERED.
  await click('#feedTabs [data-tab="log"]');
  const log = await text("#feedBody");
  expect(log).toContain("Backend note");
  expect(log).not.toContain("Legal note");
  await click('#feedTabs [data-tab="updates"]');
});

test.skipIf(!chromeFound)("SHOW ALL: every floor in the lists, each card tagged; again: back to the floor", async () => {
  await click("#hud .scopeline");
  await until(`document.querySelectorAll("#hud .ask").length === 4`);
  expect(await ev(`[...document.querySelectorAll("#hud .ask .floortag")].map((t) => t.textContent).sort()`)).toEqual(["BACKEND", "BACKEND", "HQ", "LEGAL"]);
  expect(await text("#hud .scopeline")).toBe("ALL FLOORS · ONLY BACKEND");
  expect(await ev(`document.querySelector(".stage").dataset.floors`)).toBe("floor");
  await click("#hud .scopeline");
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
});

test.skipIf(!chromeFound)("MARK ALL READ in a floor marks that floor's updates only", async () => {
  await server.post("/api/updates", { lane: "be-db", title: "Second backend update" });
  await server.post("/api/updates", { lane: "lg-contract", title: "Second legal update" });
  await until(`document.querySelector("#feedBody").innerText.includes("Second backend update")`);
  expect(await text("#feedBody")).not.toContain("Second legal update");
  await click("[data-readall]");
  for (let i = 0; i < 40; i++) { const s = await state(); if (s.updates.find((u: any) => u.title === "Second backend update").read_at) break; await Bun.sleep(50); }
  const s = await state();
  expect(s.updates.find((u: any) => u.title === "Second backend update").read_at).toBeTruthy();
  expect(s.updates.find((u: any) => u.title === "Second legal update").read_at).toBeNull();
});

test.skipIf(!chromeFound)("TELL HQ goes to the floor you are in, and the placeholder names its HQ", async () => {
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Backend)…");
  expect(await ev(`!!document.getElementById("tellFloor") && !document.getElementById("tellFloor").hidden`)).toBe(false);
  await tell("Ship the backend");
  for (let i = 0; i < 60 && !typedInto("hq-backend").includes("Ship the backend"); i++) await Bun.sleep(50);
  expect(typedInto("hq-backend")).toContain("Ship the backend");
  expect(typedInto("hq")).not.toContain("Ship the backend");
  expect((await state()).notes.find((n: any) => n.text === "Ship the backend").floor).toBe("backend");
});

test.skipIf(!chromeFound)("Esc steps out to the building; there TELL HQ has a FLOOR select beside SEND", async () => {
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await until(`!!document.getElementById("tellFloor") && !document.getElementById("tellFloor").hidden`);
  // The last floor used is the default.
  expect(await ev(`document.getElementById("tellFloor").value`)).toBe("backend");
  await ev(`(() => { const s = document.getElementById("tellFloor"); s.value = "legal"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Legal)…");
  await tell("Read the contract");
  for (let i = 0; i < 60 && !typedInto("hq-legal").includes("Read the contract"); i++) await Bun.sleep(50);
  expect(typedInto("hq-legal")).toContain("Read the contract");
  expect(typedInto("hq-backend")).not.toContain("Read the contract");
});

test.skipIf(!chromeFound)("the HQ-isn't-receiving strip shows for the floor you are in", async () => {
  await click('.ftile[data-floor="backend"]');
  await until(`!document.querySelector(".hqdown") || document.querySelector(".hqdown").hidden`);
  await key("Escape");
  await click('.ftile[data-floor="sales"]');
  await until(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden`);
  expect(await text(".hqdown")).toContain("hq-sales");
  expect(await ev(`document.getElementById("noteText").placeholder`)).toContain("HQ isn't receiving");
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("SETTINGS adds, renames and removes a floor", async () => {
  await click("#settingsBtn");
  await until(`!!document.querySelector("#settings [data-floors]")`);
  expect(await ev(`document.querySelectorAll("#settings [data-floor-row]").length`)).toBe(4);
  await click("#settings [data-floor-add]");
  await until(`!!document.querySelector("#settings [data-floor-form] [name=name]")`);
  await ev(`document.querySelector("#settings [data-floor-form] [name=name]").value = "Ops"`);
  // herdr's live agents that run no floor are offered; ops-desk is one.
  await until(`!!document.querySelector("#settings [data-floor-form] select[name=hq]")`);
  expect(await ev(`[...document.querySelectorAll("#settings [data-floor-form] select[name=hq] option")].map((o) => o.value)`)).toContain("ops-desk");
  await ev(`document.querySelector("#settings [data-floor-form] select[name=hq]").value = "ops-desk"`);
  await click('#settings [data-floor-form] [data-color="#2f9e57"]');
  await click("#settings [data-floor-form] [data-floor-save]");
  for (let i = 0; i < 60 && !(await state()).floors.some((f: any) => f.id === "ops"); i++) await Bun.sleep(50);
  const ops = (await state()).floors.find((f: any) => f.id === "ops");
  expect(ops).toMatchObject({ name: "Ops", hq: "ops-desk", color: "#2f9e57" });
  await until(`document.querySelectorAll(".building .ftile").length === 5`);
  // Rename it.
  await until(`!!document.querySelector('#settings [data-floor-row="ops"] [data-floor-edit]')`);
  await click('#settings [data-floor-row="ops"] [data-floor-edit]');
  await until(`!!document.querySelector("#settings [data-floor-form] [name=name]")`);
  await ev(`document.querySelector("#settings [data-floor-form] [name=name]").value = "Operations"`);
  await click("#settings [data-floor-form] [data-floor-save]");
  for (let i = 0; i < 60 && (await state()).floors.find((f: any) => f.id === "ops").name !== "Operations"; i++) await Bun.sleep(50);
  expect((await state()).floors.find((f: any) => f.id === "ops").name).toBe("Operations");
  // Remove it: asked in the page first, never a browser dialog.
  await until(`document.querySelector('#settings [data-floor-row="ops"]')?.innerText.includes("OPERATIONS")`);
  await click('#settings [data-floor-row="ops"] [data-floor-edit]');
  await until(`!!document.querySelector("#settings [data-floor-rm]")`);
  await click("#settings [data-floor-rm]");
  await until(`!!document.querySelector("#settings [data-floor-rm-yes]")`);
  expect(await text("#settings [data-floor-confirm]")).toContain("OPERATIONS");
  await click("#settings [data-floor-rm-yes]");
  for (let i = 0; i < 60 && (await state()).floors.some((f: any) => f.id === "ops"); i++) await Bun.sleep(50);
  expect((await state()).floors.map((f: any) => f.id)).toEqual(["hq", "backend", "legal", "sales"]);
  // A floor with lanes cannot go: its REMOVE is not offered.
  await click('#settings [data-floor-row="backend"] [data-floor-edit]');
  await until(`!!document.querySelector("#settings [data-floor-form]")`);
  expect(await ev(`document.querySelector("#settings [data-floor-rm]")?.disabled ?? true`)).toBe(true);
  await click("#settings [data-close]");
});

test.skipIf(!chromeFound)("on a phone: the building is a list of tiles, a floor opens, ◀ BUILDING comes back", async () => {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await until(`document.querySelectorAll(".building .ftile").length === 4`);
  const widths: number[] = await ev(`[...document.querySelectorAll(".ftile")].map((t) => Math.round(t.getBoundingClientRect().width))`);
  expect(new Set(widths).size).toBe(1); // one column
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await click('.ftile[data-floor="legal"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await lanesIn("#hud .ask")).toEqual(["lg-contract"]);
  await click(".floorbar [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  expect(errors).toEqual([]);
});
