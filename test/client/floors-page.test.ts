// FLOORS on the page (docs/floors.md, "The page"). One floor: the floor bar shows that floor's tab and + FLOOR, and
// nothing else changes (no building, header, frame, chip, tag, scope line or FLOOR select). + FLOOR opens the floor
// panel: USE AN AGENT adds a floor run by a live agent; START A NEW HQ has the server open a herdr tab and start
// hq-<id> (the stub herdr records both, and the guide typed into the new HQ); a failure shows in the panel. A floor
// whose HQ herdr has never shown is STARTING (amber), with no red strip; an HQ seen and then gone is red on its
// floor. THE BUILDING is a grid of tiles, each a still picture of its office; ZOOM IN enters a floor, with its header,
// the page framed in its colour and the scope chip; the tabs switch floors and Esc steps out one level. Every list
// follows the floor you are in. TELL HQ has a FLOOR select beside SEND. EDIT renames a floor and removes an empty one.
// On a phone the bar is a row of tabs under the top bar that scrolls sideways. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
setDefaultTimeout(30_000);
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-floors-page-"));
// hq, hq-backend and hq-legal run; hq-sales does not (its floor is STARTING). ops-desk is an agent with no lane and
// no floor: the panel offers it as an HQ.
const agent = (name: string, status = "idle") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" });
const AGENTS = [agent("hq"), agent("hq-backend"), agent("hq-legal"), agent("ops-desk"), agent("golf", "working"), agent("be-api", "working"), agent("be-db"), agent("lg-contract", "working")];
const herdr = fakeHerdr(dir, AGENTS);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const ev = (expr: string) => page.evaluate(expr);
const click = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const shown = (sel: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; })()`);
const lanesIn = (sel: string) => ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.dataset.lane).sort()`);
const post = (path: string, body: object) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json());
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const stageMode = () => ev(`document.querySelector(".stage").dataset.floors ?? null`);
const key = (k: string) => page.s("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 });
const setValue = (sel: string, v: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
async function tell(words: string) {
  await ev(`document.getElementById("noteText").value = ${JSON.stringify(words)}`);
  await ev(`document.getElementById("compose").requestSubmit()`);
}
const waitTyped = async (name: string, words: string) => {
  for (let i = 0; i < 80 && !herdr.typedInto(name).some((t) => t.includes(words)); i++) await Bun.sleep(50);
  return herdr.typedInto(name).some((t) => t.includes(words));
};

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "golf", machine: "local", title: "On the first floor" });
  await post("/api/asks", { lane: "golf", kind: "decision", title: "First floor question", options: ["Yes", "No"] });
  await post("/api/sync", {});
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

test.skipIf(!chromeFound)("one floor: the bar shows the floor's tab and + FLOOR, and nothing else changes", async () => {
  await until(`!!document.querySelector(".floorbar [data-floor-tab]")`);
  expect(await ev(`[...document.querySelectorAll(".floorbar [data-floor-tab]")].map((t) => t.innerText.trim())`)).toEqual(["HQ"]);
  expect(await text(".floorbar [data-floor-add]")).toBe("+ FLOOR");
  expect(await ev(`!!document.querySelector(".floorbar [data-building]")`)).toBe(false);
  expect(await ev(`document.querySelector(".stage > .floornav") === document.querySelector(".stage").firstElementChild`)).toBe(true);
  expect(await ev(`!!document.querySelector(".building, .floortag, .scopeline, #tellFloor, .floorframe, .scopechip")`)).toBe(false);
  expect(await shown(".floorhead")).toBe(false);
  expect(await ev(`document.querySelector(".stage").hasAttribute("data-floors")`)).toBe(false);
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("An order, a change of plan, a question.");
  expect(await shown(".stage > .room")).toBe(true);
});

test.skipIf(!chromeFound)("+ FLOOR, USE AN AGENT: a floor run by a live agent; it shows in the bar and the building", async () => {
  await click(".floorbar [data-floor-add]");
  await until(`!!document.querySelector(".fpanel select[name=hq]")`);
  expect(await shown(".fpanel")).toBe(true);
  // herdr's live agents that run no floor are offered, lanes too; the first floor's HQ is not.
  const offered: string[] = await ev(`[...document.querySelectorAll(".fpanel select[name=hq] option")].map((o) => o.value)`);
  expect(offered).toContain("ops-desk");
  expect(offered).toContain("golf");
  expect(offered).not.toContain("hq");
  await setValue(".fpanel [name=name]", "Backend");
  await setValue(".fpanel select[name=hq]", "hq-backend");
  await click('.fpanel [data-color="#3c6fd6"]');
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".fpanel")?.hidden === true`);
  expect((await state()).floors.find((f: any) => f.id === "backend")).toMatchObject({ name: "Backend", hq: "hq-backend", color: "#3c6fd6" });
  await until(`document.querySelectorAll(".floorbar [data-floor-tab]").length === 2`);
  expect(await ev(`!!document.querySelector(".floorbar [data-building]")`)).toBe(true);
  expect(await stageMode()).toBe("building");
  // hq-backend runs: it got the HQ guide for its floor.
  expect(await waitTyped("hq-backend", "You are the HQ of the Backend floor")).toBe(true);
});

test.skipIf(!chromeFound)("+ FLOOR, START A NEW HQ: the server opens a herdr tab and starts hq-<id>; the new HQ gets its guide", async () => {
  await click(".floorbar [data-floor-add]");
  await until(`!!document.querySelector(".fpanel [data-fp-how=start]")`);
  await click(".fpanel [data-fp-how=start]");
  await setValue(".fpanel [name=name]", "Legal");
  expect(await text(".fpanel .fpid")).toBe("hq-legal");
  // hq-legal already runs in herdr: the server refuses, the panel says why, and nothing is added.
  await click(".fpanel [data-fp-save]");
  await until(`!!document.querySelector(".fpanel .fperr")`);
  expect(await text(".fpanel .fperr")).toContain("hq-legal already runs in herdr");
  expect((await state()).floors.some((f: any) => f.id === "legal")).toBe(false);
  // Another name: a tab in the first HQ's workspace, hq-ops started in its pane.
  await setValue(".fpanel [name=name]", "Ops");
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".fpanel")?.hidden === true`, 15000);
  const calls = herdr.calls();
  expect(calls.find((c) => c[0] === "tab" && c[1] === "create")).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/the-project", "--label", "Ops HQ", "--no-focus"]);
  expect(calls.find((c) => c[0] === "agent" && c[1] === "start")?.slice(0, 7)).toEqual(["agent", "start", "hq-ops", "--kind", "claude", "--pane", "w1:p91"]);
  expect(await waitTyped("hq-ops", "You are the HQ of the Ops floor")).toBe(true);
  await until(`document.querySelectorAll(".bgrid [data-floor-go]").length === 3`);
});

test.skipIf(!chromeFound)("START A NEW HQ that herdr cannot start: the error in the panel, and no floor", async () => {
  herdr.failStart(true);
  await click(".floorbar [data-floor-add]");
  await until(`!!document.querySelector(".fpanel [data-fp-how]")`);
  await click(".fpanel [data-fp-how=start]");
  await setValue(".fpanel [name=name]", "Research");
  await click(".fpanel [data-fp-save]");
  await until(`!!document.querySelector(".fpanel .fperr")`, 15000);
  herdr.failStart(false);
  expect(await text(".fpanel .fperr")).toContain("herdr could not start hq-research");
  expect((await state()).floors.some((f: any) => f.id === "research")).toBe(false);
  await key("Escape");
  await until(`document.querySelector(".fpanel").hidden`);
  expect(await stageMode()).toBe("building");
});

test.skipIf(!chromeFound)("a new floor whose HQ has never run shows STARTING, and no red strip", async () => {
  await post("/api/floors", { id: "sales", name: "Sales", hq: "hq-sales", color: "#e0901e" });
  await post("/api/sync", {});
  await until(`!!document.querySelector('.ftab[data-floor="sales"] .fmark.starting')`);
  expect(await text('.ftab[data-floor="sales"] .fmark')).toBe("STARTING");
  await until(`!!document.querySelector('.ftile[data-floor="sales"] .fmark.starting')`);
  expect(await text('.ftile[data-floor="sales"]')).toContain("waiting for hq-sales in herdr");
  expect(await ev(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden ? document.querySelector(".hqdown").innerText : ""`)).toBe("");
  expect(await ev(`[...document.querySelectorAll(".ftab .fmark.down, .ftile .fmark.down")].map((m) => m.closest("[data-floor]")?.dataset.floor)`)).toEqual([]);
});

test.skipIf(!chromeFound)("the building: a tile per floor with a still picture of its office, + ADD A FLOOR and the legend", async () => {
  await post("/api/lanes", { name: "be-api", machine: "local", title: "The API", floor: "backend" });
  await post("/api/lanes", { name: "be-db", machine: "local", title: "The database", floor: "backend" });
  await post("/api/asks", { lane: "be-api", kind: "decision", title: "Backend question", options: ["A", "B"] });
  await post("/api/asks", { lane: "be-db", kind: "action", title: "Backend to do" });
  await post("/api/updates", { lane: "be-api", title: "Backend update" });
  await post("/api/notes", { text: "Backend note", floor: "backend" });
  await post("/api/sync", {});
  await until(`document.querySelectorAll(".bgrid [data-floor-go]").length === 4`);
  expect(await ev(`[...document.querySelectorAll(".bgrid [data-floor-go]")].map((t) => t.dataset.floorGo)`)).toEqual(["hq", "backend", "ops", "sales"]);
  await until(`document.querySelector('.ftile[data-floor="backend"] .tag.count')?.textContent === "2"`);
  const backend = await text('.ftile[data-floor="backend"]');
  expect(backend).toContain("BACKEND");
  expect(backend).toContain("ZOOM IN ›");
  expect(backend).toContain("HQ: hq-backend");
  expect(await ev(`document.querySelectorAll('.ftile[data-floor="backend"] .tlabel .fneed i').length`)).toBe(2);
  // Each tile's picture is drawn (not blank) by the room's own code, at half the room's size; the floors differ.
  const pic = (id: string) => ev(`(() => { const c = document.querySelector('.ftile[data-floor="${id}"] canvas'); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 0, lit = 0; for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) lit++; h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) >>> 0; } return { w: c.width, h: c.height, lit, hash: h }; })()`);
  const b = await pic("backend"), s = await pic("sales");
  expect([b.w, b.h]).toEqual([576, 384]);
  expect(b.lit).toBe(576 * 384);
  expect(b.hash).not.toBe(s.hash);
  // A tile is drawn again only when what it shows changes: the same state leaves its pixels alone.
  await ev(`document.querySelector('.ftile[data-floor="backend"] canvas').getContext("2d").fillRect(0, 0, 1, 1)`);
  await post("/api/sync", {});
  await Bun.sleep(300);
  expect((await pic("backend")).hash).not.toBe(b.hash);
  // The office's own frame loop rests while the building shows: no live canvas per tile.
  expect(await ev(`document.querySelectorAll(".building canvas").length`)).toBe(4);
  expect(await shown(".bgrid .fslot")).toBe(true);
  expect(await text(".bgrid .flegend")).toContain("CLICK A FLOOR TO ZOOM IN");
  // The lists show every floor, each card tagged.
  expect(await ev(`[...document.querySelectorAll("#hud .ask")].every((a) => a.querySelector(".floortag"))`)).toBe(true);
});

test.skipIf(!chromeFound)("ZOOM IN: the floor's office, its header, the page framed in its colour and the scope chip; lists follow it", async () => {
  await click('.ftile[data-floor="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await shown(".stage > .room")).toBe(true);
  expect(await shown(".building")).toBe(false);
  const head = await text(".floorhead");
  for (const part of ["◀ ALL FLOORS", "BACKEND FLOOR", "HQ: hq-backend", "2 NEED YOU"]) expect(head).toContain(part);
  expect(await shown(".floorframe")).toBe(true);
  expect(await ev(`getComputedStyle(document.querySelector(".floorframe")).borderTopColor`)).toBe("rgb(60, 111, 214)");
  expect(await shown(".scopechip")).toBe(true);
  expect(await text(".scopechip")).toBe("BACKEND FLOOR ×");
  expect(await ev(`document.querySelector(".scopechip").previousElementSibling.id`)).toBe("qtabs");
  expect(await ev(`document.querySelector('.ftab[data-floor="backend"]').classList.contains("on")`)).toBe(true);
  const { workers } = await ev(`import("/src/client/room/workers.js").then((m) => ({ workers: [...m.workers.keys()].sort() }))`);
  expect(workers).toEqual(["be-api", "be-db"]);
  expect(await lanesIn("#hud .ask")).toEqual(["be-api", "be-db"]);
  expect(await text("#hud .scopeline")).toBe("+1 ON OTHER FLOORS · SHOW ALL");
  expect(await ev(`document.querySelector("#sWait .count").textContent`)).toBe("3");
});

test.skipIf(!chromeFound)("the tabs switch floors; Esc and the chip's × step out one level", async () => {
  await click('.floorbar [data-floor-tab="hq"]');
  await until(`document.querySelector(".floorhead")?.innerText.includes("HQ FLOOR")`);
  expect(await lanesIn("#hud .ask")).toEqual(["golf"]);
  await click('.floorbar [data-floor-tab="backend"]');
  await until(`document.querySelector(".floorhead")?.innerText.includes("BACKEND FLOOR")`);
  // SHOW ALL, then Esc: SHOW ALL off first, then out to the building.
  await click("#hud .scopeline");
  await until(`document.querySelectorAll("#hud .ask").length === 3`);
  await key("Escape");
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
  expect(await stageMode()).toBe("floor");
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  expect(await shown(".floorframe")).toBe(false);
  expect(await shown(".scopechip")).toBe(false);
  // The chip's ×.
  await click('.ftile[data-floor="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await click(".scopechip");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  // ◀ ALL FLOORS.
  await click('.floorbar [data-floor-tab="ops"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await click(".floorhead [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("TELL HQ: a FLOOR select beside SEND, on the floor you are in; another floor for one note", async () => {
  await click('.ftile[data-floor="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await shown("#tellFloor")).toBe(true);
  expect(await ev(`document.getElementById("tellFloor").nextElementSibling.classList.contains("send")`)).toBe(true);
  expect(await ev(`document.getElementById("tellFloor").value`)).toBe("backend");
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Backend)…");
  await tell("Ship the backend");
  expect(await waitTyped("hq-backend", "Ship the backend")).toBe(true);
  expect(herdr.typedInto("hq").some((t) => t.includes("Ship the backend"))).toBe(false);
  await setValue("#tellFloor", "ops");
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Ops)…");
  await tell("Ops, a word");
  expect(await waitTyped("hq-ops", "Ops, a word")).toBe(true);
  // A STARTING floor keeps it until its HQ runs.
  await setValue("#tellFloor", "sales");
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Sales): kept until hq-sales starts in herdr.");
  // Out and back in: the select is on the floor you are in again.
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await click('.ftile[data-floor="backend"]');
  await until(`document.getElementById("tellFloor").value === "backend"`);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("an HQ that was receiving and stopped is red on its floor: tab, tile and the strip", async () => {
  const ops = herdr.agents().filter((a) => a.name === "hq-ops");
  herdr.world([...AGENTS.filter((a) => a.name !== "hq-backend"), ...ops]);
  await post("/api/sync", {});
  await until(`!!document.querySelector('.ftab[data-floor="backend"] .fmark.down')`);
  await until(`document.querySelector('.ftile[data-floor="backend"]')?.classList.contains("mood-down")`);
  await until(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden`);
  const strip = await text(".hqdown");
  expect(strip).toContain("BACKEND");
  expect(strip).not.toContain("SALES");
  herdr.world([...AGENTS, ...ops]);
  await post("/api/sync", {});
  await until(`!document.querySelector('.ftab[data-floor="backend"] .fmark.down')`);
});

test.skipIf(!chromeFound)("EDIT renames a floor (from its tab); an empty floor is removed after a confirm in the page", async () => {
  await click('.floorbar [data-floor-tab="ops"]');
  await until(`!!document.querySelector('.ftab[data-floor="ops"] [data-floor-edit]')`);
  await click('.ftab[data-floor="ops"] [data-floor-edit]');
  await until(`!!document.querySelector(".fpanel [name=name]") && !document.querySelector(".fpanel").hidden`);
  expect(await text(".fpanel .fphead")).toContain("EDIT THE OPS FLOOR");
  await until(`!!document.querySelector(".fpanel select[name=hq]")`);
  expect(await ev(`document.querySelector(".fpanel select[name=hq]")?.value`)).toBe("hq-ops");
  await setValue(".fpanel [name=name]", "Operations");
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".floorhead")?.innerText.includes("OPERATIONS FLOOR")`);
  expect((await state()).floors.find((f: any) => f.id === "ops").name).toBe("Operations");
  // Remove it, from SETTINGS this time: asked in the page first, never a browser dialog.
  await click("#settingsBtn");
  await until(`!!document.querySelector('#settings [data-floor-row="ops"] [data-floor-edit]')`);
  await click('#settings [data-floor-row="ops"] [data-floor-edit]');
  await until(`document.getElementById("settings").hidden && !document.querySelector(".fpanel").hidden`);
  await click(".fpanel [data-fp-rm]");
  await until(`!!document.querySelector(".fpanel [data-fp-rm-yes]")`);
  expect(await text(".fpanel [data-floor-confirm]")).toContain("OPERATIONS");
  await click(".fpanel [data-fp-rm-yes]");
  await until(`!document.querySelector('.ftab[data-floor="ops"]')`);
  expect((await state()).floors.map((f: any) => f.id)).toEqual(["hq", "backend", "sales"]);
  expect(await stageMode()).toBe("building");
  // A floor with lanes cannot go: its REMOVE is not offered.
  await click('.ftile[data-floor="backend"]');
  await until(`!!document.querySelector('.ftab[data-floor="backend"] [data-floor-edit]')`);
  await click('.ftab[data-floor="backend"] [data-floor-edit]');
  await until(`!!document.querySelector(".fpanel [data-fp-rm]")`);
  expect(await ev(`document.querySelector(".fpanel [data-fp-rm]").disabled`)).toBe(true);
  await key("Escape");
  await until(`document.querySelector(".fpanel").hidden`);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("on a phone: the floor bar is a row of tabs under the top bar that scrolls sideways; the building a list", async () => {
  for (const [id, name] of [["design", "Design"], ["support", "Support"], ["finance", "Finance"]]) await post("/api/floors", { id, name, hq: `hq-${id}` });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await until(`document.querySelectorAll(".floorbar [data-floor-tab]").length === 6`);
  await until(`document.querySelector(".top").nextElementSibling?.classList.contains("floornav")`);
  expect(await ev(`(() => { const b = document.querySelector(".floorbar"); return getComputedStyle(b).overflowX === "auto" && b.scrollWidth > b.clientWidth; })()`)).toBe(true);
  const heights: number[] = await ev(`[...document.querySelectorAll(".floorbar .fbtn, .floorbar .ftgo")].map((e) => e.getBoundingClientRect().height)`);
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await until(`document.querySelectorAll(".bgrid [data-floor-go]").length === 6`);
  const lefts: number[] = await ev(`[...document.querySelectorAll(".bgrid [data-floor-go]")].map((t) => Math.round(t.getBoundingClientRect().left))`);
  expect(new Set(lefts).size).toBe(1); // one column
  // The questions come before the building.
  expect(await ev(`document.querySelector("#hud").getBoundingClientRect().top < document.querySelector(".building").getBoundingClientRect().top`)).toBe(true);
  await click('.ftile[data-floor="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await shown(".floorhead")).toBe(true);
  expect(await shown(".floorframe")).toBe(true);
  expect(await ev(`document.querySelector(".floorhead").getBoundingClientRect().top < document.querySelector("#hud").getBoundingClientRect().top`)).toBe(true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await lanesIn("#hud .ask")).toEqual(["be-api", "be-db"]);
  await click(".floorhead [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  // The two refused starts above answered 400, as they should; nothing else went wrong on the page.
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
});
