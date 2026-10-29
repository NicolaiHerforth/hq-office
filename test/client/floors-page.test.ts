// FLOORS on the page (docs/floors.md, "The page" and "The floor UI rules"). One switcher row over the office: the
// pill (slot A, the name, slot B, ▾), ◀ BUILDING and EDIT inside a floor, and the readings in words; it never wraps.
// The pill opens the floor list (BUILDING, a row per floor with its readings, + ADD A FLOOR; arrows, Enter, Esc). The
// three readings (waiting on you, working, nothing moving) agree between the top bar, the switcher, the list, the tiles
// and the office. USE AN AGENT offers only live agents here; a floor whose HQ is not running carries START ITS HQ and
// PICK ANOTHER wherever it shows, and never the red strip. THE BUILDING fits the stage. Cards in the ALL view carry a
// floor stripe; TELL HQ has "to:" with two or more floors. On a phone the row sits under the top bar and the list is a
// bottom sheet. A stub herdr (test/fake-herdr.ts) records every call. Needs Chrome; skipped without it.
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
// hq, hq-backend and hq-legal run here; ops-desk is an agent with no lane and no floor; far-away runs on another
// machine (no floor's HQ: the HUD types into HQ here). be-api is working with phase "waiting": still at its desk.
const agent = (name: string, status = "idle") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" });
const MORE = ["design", "support", "finance", "people"].map((id) => agent(`hq-${id}`));
const AGENTS = [agent("hq"), agent("hq-backend"), agent("hq-legal"), agent("ops-desk"), agent("golf", "working"), agent("be-api", "working"), agent("be-db"), agent("ops-idle"), ...MORE];
const herdr = fakeHerdr(dir, AGENTS);
herdr.elsewhere("laptop", [{ name: "far-away", agent_status: "idle", pane_id: "l1", agent: "claude" }]);

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
const KEYS: Record<string, number> = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13 };
const key = async (k: string) => {
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: KEYS[k] ?? 0, ...(k === "Enter" ? { text: "\r" } : {}) });
  await page.s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: KEYS[k] ?? 0 });
};
const setValue = (sel: string, v: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
const size = (w: number, h: number, mobile = false) => page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 3 : 1, mobile });
async function tell(words: string) {
  await ev(`document.getElementById("noteText").value = ${JSON.stringify(words)}`);
  await ev(`document.getElementById("compose").requestSubmit()`);
}
const waitTyped = async (name: string, words: string) => {
  for (let i = 0; i < 80 && !herdr.typedInto(name).some((t) => t.includes(words)); i++) await Bun.sleep(50);
  return herdr.typedInto(name).some((t) => t.includes(words));
};
const openList = async () => {
  if (!(await ev(`!!document.querySelector(".fmenu") && !document.querySelector(".fmenu").hidden`))) await click(".fswitch [data-pill]");
  await until(`!!document.querySelector(".fmenu") && !document.querySelector(".fmenu").hidden`);
};
const addFrom = async () => { await openList(); await click('.fmenu [data-floor-add]'); await until(`!!document.querySelector(".fpanel") && !document.querySelector(".fpanel").hidden`); };
// The switcher is one row: one line high, every child on it, nothing past its edge.
const ONE_ROW = `(() => {
  const r = document.querySelector(".fswitch"), b = r.getBoundingClientRect();
  const kids = [...r.querySelectorAll(":scope > *")].filter((e) => getComputedStyle(e).display !== "none");
  const mids = new Set(kids.map((e) => { const k = e.getBoundingClientRect(); return Math.round((k.top + k.bottom) / 2); }));
  const inside = kids.every((e) => { const k = e.getBoundingClientRect(); return k.right <= b.right + 1 && k.left >= b.left - 1; });
  const chips = [...r.querySelectorAll(".fread, .fbtn, .slot, .ffix .btn-s")].every((e) => e.getBoundingClientRect().height <= 48 && e.scrollWidth <= e.clientWidth + 1);
  return { height: Math.round(b.height), rows: [...mids].every((m) => Math.abs(m - [...mids][0]) <= 2), inside, chips };
})()`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local,laptop", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "golf", machine: "local", title: "On the first floor" });
  await post("/api/asks", { lane: "golf", kind: "decision", title: "First floor question", options: ["Yes", "No"] });
  await post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await size(1440, 900);
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector(".ask")`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("one floor: the switcher shows HQ ▾ and its readings, and nothing else changes", async () => {
  await until(`!!document.querySelector(".fswitch [data-pill]")`);
  expect(await text(".fswitch .fpname")).toBe("HQ");
  expect(await text(".fswitch .fcaret")).toBe("▾");
  expect(await ev(`document.querySelector(".stage > .floornav") === document.querySelector(".stage").firstElementChild`)).toBe(true);
  // Golf works and its question waits: slot A says 1, slot B one bar, the chips say it in words.
  expect(await text(".fswitch .slot.sa.block")).toContain("1");
  expect(await ev(`document.querySelectorAll(".fswitch .slot.sb i").length`)).toBe(1);
  expect(await text(".fswitch .rblock")).toContain("1");
  expect(await ev(`!!document.querySelector(".fswitch [data-building]")`)).toBe(false);
  expect(await ev(`!!document.querySelector(".building, .fstripe, .scoperow, .ffloors, .tto, .floorframe")`)).toBe(false);
  expect(await ev(`document.querySelector(".stage").hasAttribute("data-floors")`)).toBe(false);
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("An order, a change of plan, a question.");
  expect(await shown(".stage > .room")).toBe(true);
  expect(await ev(ONE_ROW)).toMatchObject({ rows: true, inside: true });
  // The list: the floor and + ADD A FLOOR; no BUILDING with one floor.
  await openList();
  expect(await ev(`[...document.querySelectorAll(".fmenu [data-floor-tab]")].map((e) => e.dataset.floorTab)`)).toEqual(["hq"]);
  expect(await ev(`!!document.querySelector(".fmenu [data-building]")`)).toBe(false);
  expect(await ev(`!!document.querySelector(".fmenu [data-floor-add]")`)).toBe(true);
  await key("Escape");
  await until(`document.querySelector(".fmenu").hidden`);
  expect(await ev(`document.activeElement?.matches("[data-pill]")`)).toBe(true);
});

test.skipIf(!chromeFound)("+ ADD A FLOOR, USE AN AGENT: only live agents here, a taken one disabled with its floor, no typed names; red, amber and green are no floor's colour", async () => {
  await addFrom();
  await until(`!!document.querySelector(".fpanel select[name=hq]")`);
  const offered: { v: string; off: boolean; t: string }[] = await ev(`[...document.querySelectorAll(".fpanel select[name=hq] option")].map((o) => ({ v: o.value, off: o.disabled, t: o.textContent }))`);
  const by = (v: string) => offered.find((o) => o.v === v);
  expect(by("ops-desk")?.off).toBe(false);
  expect(by("golf")?.off).toBe(false); // a lane, promoted to run a domain
  expect(by("hq")).toMatchObject({ off: true, t: "hq (HQ of HQ)" });
  expect(by("far-away")).toBeUndefined(); // runs on another machine
  expect(await ev(`!!document.querySelector(".fpanel [name=hqText]")`)).toBe(false);
  expect(await ev(`[...document.querySelectorAll(".fpanel .fphow .seg")].map((b) => b.textContent)`)).toEqual(["USE AN AGENT", "START A NEW HQ"]);
  const colors: string[] = await ev(`[...document.querySelectorAll(".fpanel [data-color]")].map((b) => b.dataset.color)`);
  for (const c of ["#2f9e57", "#e0901e", "#d63c3c"]) expect(colors).not.toContain(c);
  // The save button is a real target: 32 px and 9 px text.
  expect(await ev(`(() => { const b = document.querySelector(".fpanel [data-fp-save]"); return b.getBoundingClientRect().height >= 32 && parseFloat(getComputedStyle(b).fontSize) >= 9; })()`)).toBe(true);
  await setValue(".fpanel [name=name]", "Backend");
  await setValue(".fpanel select[name=hq]", "hq-backend");
  // Blue is the first floor's: the panel offers it disabled; purple is free.
  expect(await ev(`document.querySelector('.fpanel [data-color="#3c6fd6"]').disabled`)).toBe(true);
  await click('.fpanel [data-color="#7a4fc9"]');
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".fpanel")?.hidden === true`);
  expect((await state()).floors.find((f: any) => f.id === "backend")).toMatchObject({ name: "Backend", hq: "hq-backend", color: "#7a4fc9" });
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  expect(await text(".fswitch .fpname")).toBe("BUILDING");
  expect(await waitTyped("hq-backend", "You are the HQ of the Backend floor")).toBe(true);
  // The top bar's FLOORS box: a pip per floor.
  await until(`document.querySelectorAll(".ffloors .pip").length === 2`);
});

test.skipIf(!chromeFound)("START A NEW HQ: the server opens a herdr tab and starts hq-<id>; a refusal or a failure says what to do", async () => {
  await addFrom();
  await click(".fpanel [data-fp-how=start]");
  await setValue(".fpanel [name=name]", "Legal");
  expect(await text(".fpanel .fpid")).toBe("hq-legal");
  await click(".fpanel [data-fp-save]");
  await until(`!!document.querySelector(".fpanel .fperr")`);
  expect(await text(".fpanel .fperr")).toContain("hq-legal already runs in herdr: pick it under USE AN AGENT");
  await setValue(".fpanel [name=name]", "Ops");
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".fpanel")?.hidden === true`, 15000);
  const calls = herdr.calls();
  expect(calls.find((c) => c[0] === "tab" && c[1] === "create")).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/the-project", "--label", "Ops HQ", "--no-focus"]);
  expect(calls.find((c) => c[0] === "agent" && c[1] === "start" && c[2] !== "--help")?.slice(0, 7)).toEqual(["agent", "start", "hq-ops", "--kind", "claude", "--pane", "w1:p91"]);
  expect(await waitTyped("hq-ops", "You are the HQ of the Ops floor")).toBe(true);
  // herdr cannot start it: the panel says why and what next; no floor.
  herdr.failStart(true);
  await addFrom();
  await click(".fpanel [data-fp-how=start]");
  await setValue(".fpanel [name=name]", "Research");
  await click(".fpanel [data-fp-save]");
  await until(`!!document.querySelector(".fpanel .fperr")`, 15000);
  herdr.failStart(false);
  expect(await text(".fpanel .fperr")).toContain("herdr could not start hq-research");
  expect(await text(".fpanel .fperr")).toContain("USE AN AGENT");
  expect((await state()).floors.some((f: any) => f.id === "research")).toBe(false);
  await key("Escape");
  await until(`document.querySelector(".fpanel").hidden`);
});

test.skipIf(!chromeFound)("a floor whose HQ is not running: START ITS HQ and PICK ANOTHER on its tile, its list row and inside it; no red strip", async () => {
  herdr.hideStart(true);
  expect((await post("/api/floors", { id: "sales", name: "Sales", start: true })).id).toBe("sales");
  herdr.hideStart(false);
  await post("/api/sync", {});
  await until(`!!document.querySelector('.ftile[data-floor="sales"] [data-floor-start]')`);
  expect(await text('.ftile[data-floor="sales"] .ffix')).toContain("hq-sales is not running in herdr");
  expect(await ev(`!!document.querySelector('.ftile[data-floor="sales"] [data-floor-pick]')`)).toBe(true);
  expect(await ev(`document.querySelector('.ftile[data-floor="sales"]').classList.contains("mood-starting")`)).toBe(true);
  await openList();
  expect(await ev(`!!document.querySelector('.fmenu .flrow[data-floor="sales"] [data-floor-start]') && !!document.querySelector('.fmenu .flrow[data-floor="sales"] [data-floor-pick]')`)).toBe(true);
  await click('.fmenu [data-floor-tab="sales"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await ev(`!!document.querySelector(".fswitch [data-floor-start]") && !!document.querySelector(".fswitch [data-floor-pick]")`)).toBe(true);
  // Never the page-wide alarm for a floor that has not started.
  expect(await ev(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden`)).toBe(false);
  // PICK ANOTHER: the edit panel, at its HQ, live agents only.
  await click(".fswitch [data-floor-pick]");
  await until(`document.activeElement?.name === "hq"`);
  await key("Escape");
  await until(`document.querySelector(".fpanel").hidden`);
  // START ITS HQ: a tab and hq-sales started; once herdr shows it, it receives and the fix goes.
  const from = herdr.calls().length;
  await click(".fswitch [data-floor-start]");
  for (let i = 0; i < 100 && !herdr.calls().slice(from).some((c) => c[0] === "agent" && c[1] === "start"); i++) await Bun.sleep(50);
  const calls = herdr.calls().slice(from);
  expect(calls.some((c) => c[0] === "tab" && c[1] === "create" && c.includes("Sales HQ"))).toBe(true);
  expect(calls.find((c) => c[0] === "agent" && c[1] === "start")?.[2]).toBe("hq-sales");
  await post("/api/sync", {});
  await until(`!document.querySelector(".fswitch [data-floor-start]")`);
  expect((await state()).floors.find((f: any) => f.id === "sales")).toMatchObject({ starting: false, receiving: true });
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("the readings agree: the top bar, the switcher, the list, the tile and the office (N working = N at desks)", async () => {
  // be-api works with phase "waiting": working is working, at its desk. be-db is idle.
  await post("/api/lanes", { name: "be-api", machine: "local", title: "The API", floor: "backend", phase: "waiting" });
  await post("/api/lanes", { name: "be-db", machine: "local", title: "The database", floor: "backend" });
  await post("/api/asks", { lane: "be-db", kind: "decision", title: "Backend question", options: ["A", "B"] });
  await post("/api/asks", { lane: "be-db", kind: "action", title: "Backend to do" });
  await post("/api/sync", {});
  const s = await state();
  const be = s.floors.find((f: any) => f.id === "backend").counts;
  expect(be).toMatchObject({ blocking: 2, working: 1, active: 2 });
  expect(s.lanes.find((l: any) => l.name === "be-api").status).toBe("moving");
  // The top bar.
  await until(`document.getElementById("sMove").textContent === "${s.office.working}/${s.office.active}"`);
  expect(Number(await text("#sWait .count"))).toBe(s.office.blocking);
  // The tile.
  await until(`document.querySelector('.ftile[data-floor="backend"] .tblock b')?.textContent === "2"`);
  expect(await text('.ftile[data-floor="backend"] .twork b')).toBe("1/2");
  expect(await ev(`document.querySelectorAll('.ftile[data-floor="backend"] .slot.sb i').length`)).toBe(1);
  expect(await ev(`document.querySelector('.ftile[data-floor="backend"]').classList.contains("w-block")`)).toBe(true);
  // The list row.
  await openList();
  expect(await text('.fmenu .flrow[data-floor="backend"] .flreads')).toContain("2 wait on you");
  expect(await text('.fmenu .flrow[data-floor="backend"] .flreads')).toContain("1 of 2 working");
  await click('.fmenu [data-floor-tab="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  // The switcher.
  expect(await text(".fswitch .slot.sa")).toContain("2");
  expect(await text(".fswitch .rwork b")).toBe("1");
  // The office: one worker at work, at its desk.
  await until(`import("/src/client/room/workers.js").then((m) => m.workers.size === 2)`);
  const atDesks = await ev(`import("/src/client/room/workers.js").then((m) => [...m.workers.values()].filter((w) => w.lane.status === "moving" && w.target === w.seat && w.seat).length)`);
  expect(atDesks).toBe(be.working);
});

test.skipIf(!chromeFound)("inside a floor: the office's border in its colour, one scope row ([Backend ×] +N ON OTHER FLOORS · SHOW ALL), lists follow it; Esc and × step out", async () => {
  expect(await ev(`getComputedStyle(document.querySelector(".stage > .room")).borderTopColor`)).toBe("rgb(122, 79, 201)");
  expect(await ev(`!!document.querySelector(".floorframe")`)).toBe(false);
  expect(await shown(".scoperow")).toBe(true);
  expect(await ev(`document.querySelector(".scoperow").previousElementSibling.id`)).toBe("qtabs");
  expect(await text(".scoperow .fname")).toBe("Backend");
  expect(await text(".scoperow .sall")).toContain("+1 ON OTHER FLOORS");
  expect(await ev(`document.querySelector(".scoperow").classList.contains("hot")`)).toBe(true);
  expect(await ev(`Math.round(document.querySelector(".scoperow").getBoundingClientRect().height)`)).toBe(28);
  expect(await lanesIn("#hud .ask")).toEqual(["be-db", "be-db"]);
  // No floor stripes inside a floor; SHOW ALL lists every floor, each card striped in its floor's colour.
  expect(await ev(`document.querySelectorAll("#hud .fstripe").length`)).toBe(0);
  await click(".scoperow [data-scope-all]");
  await until(`document.querySelectorAll("#hud .ask").length === 3`);
  // With SHOW ALL the chip says "· ALL" whole: only the name may shorten.
  expect(await text(".scoperow .schip .fall")).toBe("· ALL");
  expect(await ev(`(() => { const a = document.querySelector(".scoperow .schip .fall"); return a.scrollWidth <= a.clientWidth && getComputedStyle(a).flexShrink === "0"; })()`)).toBe(true);
  expect(await ev(`[...document.querySelectorAll("#hud .ask")].every((a) => a.querySelector(".fstripe") && getComputedStyle(a.querySelector(".fstripe")).width === "4px")`)).toBe(true);
  expect(await ev(`!!document.querySelector("#hud .ask .meta > .fswatch + .tag.lane")`)).toBe(true);
  expect(await ev(`!!document.querySelector("#hud .ask .tag.kind")`)).toBe(true); // QUESTION / TO DO stay
  await key("Escape");
  await until(`document.querySelectorAll("#hud .ask").length === 2`);
  expect(await stageMode()).toBe("floor");
  // The question list scrolled down; out to the building, it starts at its top.
  await ev(`(() => { const h = document.getElementById("hud"); h.insertAdjacentHTML("beforeend", '<div id="tall" style="height:3000px"></div>'); h.scrollTop = 900; })()`);
  expect(await ev(`document.getElementById("hud").scrollTop > 0`)).toBe(true);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  expect(await ev(`document.getElementById("hud").scrollTop`)).toBe(0);
  expect(await shown(".scoperow")).toBe(false);
  // The building view tags every card.
  expect(await ev(`[...document.querySelectorAll("#hud .ask")].every((a) => a.querySelector(".fstripe"))`)).toBe(true);
  // The ×, and ◀ BUILDING.
  await click('.ftile[data-floor="backend"] .tgo');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await click(".scoperow [data-scope-out]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await click('.ffloors .pip[data-floor-tab="backend"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await click(".fswitch [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("TELL HQ: to: the floor you are in, left of SEND; another floor for one note; the toast names it", async () => {
  await click('.ftile[data-floor="backend"] .tgo');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await shown("#compose .tto")).toBe(true);
  expect(await ev(`document.querySelector("#compose .tto").nextElementSibling.classList.contains("send")`)).toBe(true);
  expect(await text("#compose .tto")).toContain("to:");
  expect(await text("#compose .tto .ttn")).toBe("Backend");
  expect(await ev(`document.querySelector("#compose .tto").title`)).toContain("Backend");
  // SEND (and the to: beside it) are 32 px targets, as are every question's SEND.
  expect(await ev(`[...document.querySelectorAll("#compose .send, #compose .tto, #hud .ask .send")].every((b) => b.getBoundingClientRect().height >= 32)`)).toBe(true);
  expect(await ev(`document.getElementById("noteText").placeholder`)).toBe("Tell HQ (Backend)…");
  await tell("Ship the backend");
  expect(await waitTyped("hq-backend", "Ship the backend")).toBe(true);
  await until(`[...document.querySelectorAll(".toast, #toast")].some((t) => t.textContent.includes("SENT TO BACKEND HQ."))`);
  expect(herdr.typedInto("hq").some((t) => t.includes("Ship the backend"))).toBe(false);
  await setValue("#tellFloor", "ops");
  expect(await text("#compose .tto .ttn")).toBe("Ops");
  await tell("Ops, a word");
  expect(await waitTyped("hq-ops", "Ops, a word")).toBe(true);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("NOTHING MOVING: amber after 3 minutes, red after 20, on the pill, the tile and the top bar; inside, it says whose it is and offers TELL", async () => {
  await post("/api/lanes", { name: "ops-idle", machine: "local", title: "Waits for orders", floor: "ops" });
  await post("/api/sync", {});
  await until(`document.querySelector('.ftile[data-floor="ops"] .twork b')?.textContent === "0/1"`);
  // Just stopped: no alarm yet (it would flicker).
  expect(await ev(`document.querySelector('.ftile[data-floor="ops"]').classList.contains("w-idle")`)).toBe(false);
  // The page clock moves 5 minutes on: amber. Then 25: red.
  await ev(`(() => { const real = Date.now.bind(Date); window.__shift = 0; Date.now = () => real() + window.__shift; })()`);
  await ev(`window.__shift = 5 * 60000; import("/src/client/core/bus.js").then((m) => m.emit("tick"))`);
  await until(`document.querySelector('.ftile[data-floor="ops"]').classList.contains("w-idle")`);
  expect(await text('.ftile[data-floor="ops"] .slot.sa')).toContain("Zz");
  expect(await text('.ftile[data-floor="ops"] .tstall')).toContain("NOTHING MOVING");
  expect(await ev(`document.querySelector('.ffloors .pip[data-floor-tab="ops"]').classList.contains("is-idle")`)).toBe(true);
  await ev(`window.__shift = 25 * 60000; import("/src/client/core/bus.js").then((m) => m.emit("tick"))`);
  await until(`document.querySelector('.ftile[data-floor="ops"]').classList.contains("w-late")`);
  expect(await ev(`document.querySelector('.ftile[data-floor="ops"] .slot.sa').classList.contains("late")`)).toBe(true);
  // Inside: not "all good". It says so, names its HQ, and TELL HQ-OPS points the box at that floor.
  await click('.ftile[data-floor="ops"] .tgo');
  await until(`!!document.querySelector("#hud .stallnote")`);
  expect(await text("#hud .stallnote")).toContain("Nothing waits on you here, but nothing is moving: 1 lane idle for");
  expect(await text("#hud .stallnote")).toContain("That's on hq-ops.");
  expect(await text(".fswitch .rstall")).toContain("NOTHING MOVING");
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await click('.ftile[data-floor="ops"] .tgo');
  await until(`!!document.querySelector("#hud [data-tell-floor]")`);
  await click("#hud [data-tell-floor]");
  expect(await ev(`document.activeElement === document.getElementById("noteText")`)).toBe(true);
  expect(await ev(`document.getElementById("tellFloor").value`)).toBe("ops");
  await ev(`window.__shift = 0`);
  await key("Escape");
  await ev(`document.activeElement.blur()`);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("an HQ that was receiving and stopped: red on its floor, the strip, and START ITS HQ wherever it shows", async () => {
  herdr.world(herdr.agents().filter((a) => a.name !== "hq-backend"));
  await post("/api/sync", {});
  await until(`document.querySelector('.ftile[data-floor="backend"]')?.classList.contains("mood-down")`);
  await until(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden`);
  expect(await text(".hqdown")).toContain("BACKEND");
  expect(await text(".hqdown")).not.toContain("SALES");
  // It stopped and its name cannot be given back: START ITS HQ and PICK ANOTHER beside CHECK NOW, on its tile, its
  // list row and inside it; its state says "stopped" plainly.
  expect(await ev(`!!document.querySelector('.hqdown [data-floor-start="backend"]') && !!document.querySelector('.hqdown [data-floor-pick="backend"]') && !!document.querySelector('.hqdown [data-hq="check"]')`)).toBe(true);
  expect(await ev(`!!document.querySelector('.ftile[data-floor="backend"] [data-floor-start]')`)).toBe(true);
  expect(await text('.ftile[data-floor="backend"] .ffix')).toContain("hq-backend stopped");
  expect(await text('.ftile[data-floor="backend"] .hqword')).toBe("stopped");
  expect(await ev(`parseFloat(getComputedStyle(document.querySelector('.ftile[data-floor="backend"] .hqword')).fontSize) >= 13`)).toBe(true);
  await openList();
  expect(await ev(`!!document.querySelector('.fmenu .flrow[data-floor="backend"] [data-floor-start]')`)).toBe(true);
  await click('.fmenu [data-floor-tab="backend"]');
  await until(`!!document.querySelector(".fswitch [data-floor-start]")`);
  // START ITS HQ: a new tab and hq-backend started there, never typed into the old pane.
  const from = herdr.calls().length;
  await click(".fswitch [data-floor-start]");
  for (let i = 0; i < 100 && !herdr.calls().slice(from).some((c) => c[0] === "agent" && c[1] === "start"); i++) await Bun.sleep(50);
  expect(herdr.calls().slice(from).some((c) => c[0] === "tab" && c[1] === "create")).toBe(true);
  expect(herdr.calls().slice(from).find((c) => c[0] === "agent" && c[1] === "start")?.[2]).toBe("hq-backend");
  await post("/api/sync", {});
  await until(`!document.querySelector(".fswitch [data-floor-start]")`);
  await click(".fswitch [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("seven floors and more: the switcher is one row at 1440, 1280 and 1180; the list takes the keyboard; eight floors fit the building at 1440×900", async () => {
  for (const [id, name] of [["design", "Design"], ["support", "Support and customer success operations"], ["finance", "Finance"], ["people", "People"]]) {
    expect((await post("/api/floors", { id, name, hq: `hq-${id}` })).id).toBe(id);
  }
  await post("/api/sync", {});
  await until(`document.querySelectorAll(".bgrid .ftile").length === 8`);
  // Building, 1440×900: every tile on screen, the stage does not scroll.
  expect(await ev(`(() => { const b = document.querySelector(".building"); return b.scrollHeight <= b.clientHeight + 1 && [...document.querySelectorAll(".bgrid > *")].every((t) => t.getBoundingClientRect().bottom <= b.getBoundingClientRect().bottom); })()`)).toBe(true);
  // 1280×800 with the "HQ isn't receiving" strip up: every tile's content still shows whole.
  herdr.world(herdr.agents().filter((a) => a.name !== "hq-design"));
  await post("/api/sync", {});
  await size(1280, 800);
  await until(`!!document.querySelector(".hqdown") && !document.querySelector(".hqdown").hidden`);
  await Bun.sleep(150);
  expect(await ev(`({ tiles: [...document.querySelectorAll(".bgrid .ftile")].filter((t) => t.scrollHeight > t.clientHeight + 1).map((t) => t.dataset.floor + " " + t.scrollHeight + ">" + t.clientHeight), building: (() => { const b = document.querySelector(".building"); return b.scrollHeight <= b.clientHeight + 1 ? "fits" : b.scrollHeight + ">" + b.clientHeight; })() })`)).toEqual({ tiles: [], building: "fits" });
  herdr.world([...herdr.agents(), agent("hq-design")]);
  await post("/api/sync", {});
  await until(`!document.querySelector(".hqdown") || document.querySelector(".hqdown").hidden`);
  // With five floors or more a tile keeps its picture, smaller, and no half of it is empty.
  await size(1440, 900);
  await Bun.sleep(150);
  expect(await ev(`[...document.querySelectorAll(".bgrid .ftile")].every((t) => { const p = t.querySelector(".tscene"); const r = p.getBoundingClientRect(); return getComputedStyle(p).display !== "none" && r.width >= 60; })`)).toBe(true);
  for (const w of [1440, 1280, 1180]) {
    await size(w, w === 1440 ? 900 : 820);
    await Bun.sleep(150);
    expect({ w, building: await ev(ONE_ROW) }).toMatchObject({ w, building: { rows: true, inside: true, chips: true } });
    await click('.ftile[data-floor="support"] .tgo');
    await until(`document.querySelector(".stage").dataset.floors === "floor"`);
    expect({ w, floor: await ev(ONE_ROW) }).toMatchObject({ w, floor: { rows: true, inside: true, chips: true } });
    expect(await ev(`document.querySelector(".fswitch").getBoundingClientRect().height <= 40`)).toBe(true);
    // Long names: the name shortens, the × and the counts never do.
    expect(await ev(`(() => { const p = document.querySelector(".fswitch [data-pill]"), n = p.querySelector(".fpname"); return p.getBoundingClientRect().width <= document.querySelector(".fswitch").clientWidth * 0.32 + 1 && getComputedStyle(n).textOverflow === "ellipsis"; })()`)).toBe(true);
    expect(await ev(`document.querySelector(".scoperow .sx").getBoundingClientRect().width`)).toBe(28);
    // The pill keeps its width from floor to floor, so ◀ BUILDING and EDIT never move.
    const at = () => ev(`[".fswitch [data-pill]", ".fswitch [data-building]", ".fswitch .fedit"].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().left) + ":" + Math.round(document.querySelector(q).getBoundingClientRect().width)).join(" ")`);
    const here = await at();
    for (const id of ["hq", "design", "backend"]) {
      await openList();
      await click(`.fmenu [data-floor-tab="${id}"]`);
      await until(`document.querySelector(".fswitch .fpname")?.title === "" || true`);
      await Bun.sleep(100);
      expect({ w, id, at: await at() }).toEqual({ w, id, at: here });
    }
    await click(".fswitch [data-building]");
    await until(`document.querySelector(".stage").dataset.floors === "building"`);
  }
  await size(1440, 900);
  // The list: BUILDING, every floor with its readings, + ADD A FLOOR; arrows move, Enter goes, Esc closes.
  await ev(`document.querySelector(".fswitch [data-pill]").focus()`);
  await key("ArrowDown");
  await until(`!!document.querySelector(".fmenu") && !document.querySelector(".fmenu").hidden`);
  const rows: string[] = await ev(`[...document.querySelectorAll(".fmenu [role=menuitem]")].map((e) => e.dataset.floorTab ?? (e.matches("[data-building]") ? "BUILDING" : "ADD"))`);
  expect(rows).toEqual(["BUILDING", "hq", "backend", "ops", "sales", "design", "support", "finance", "people", "ADD"]);
  expect(await ev(`[...document.querySelectorAll(".fmenu .flrow[data-floor] .flreads")].every((r) => /wait on you/.test(r.textContent) && /working|nothing moving/.test(r.textContent))`)).toBe(true);
  expect(await ev(`document.activeElement.matches("[data-building]")`)).toBe(true);
  await key("ArrowDown");
  await key("ArrowDown");
  expect(await ev(`document.activeElement.dataset.floorTab`)).toBe("backend");
  await key("ArrowUp");
  expect(await ev(`document.activeElement.dataset.floorTab`)).toBe("hq");
  await key("Escape");
  await until(`document.querySelector(".fmenu").hidden`);
  expect(await ev(`document.activeElement?.matches("[data-pill]")`)).toBe(true);
  await key("ArrowDown");
  await until(`!document.querySelector(".fmenu").hidden`);
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Enter");
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await text(".fswitch .fpname")).toBe("Backend");
  expect(await ev(`document.querySelector(".fmenu").hidden`)).toBe(true);
  await click(".fswitch [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
});

test.skipIf(!chromeFound)("EDIT renames a floor; REMOVE says why it cannot; SETTINGS puts FLOORS first and Esc closes it", async () => {
  await openList();
  await click('.fmenu .flrow[data-floor="ops"] [data-floor-edit]');
  await until(`!!document.querySelector(".fpanel [name=name]") && !document.querySelector(".fpanel").hidden`);
  expect(await text(".fpanel .fphead")).toContain("EDIT Ops");
  expect(await ev(`document.querySelector(".fpanel [data-fp-rm]").disabled`)).toBe(true);
  expect(await text(".fpanel .fprmwhy")).toContain("Not empty: 1 lane");
  await setValue(".fpanel [name=name]", "Operations");
  await click(".fpanel [data-fp-save]");
  await until(`document.querySelector(".fpanel").hidden`);
  expect((await state()).floors.find((f: any) => f.id === "ops").name).toBe("Operations");
  // An empty floor goes, after a confirm in the page.
  await click("#settingsBtn");
  await until(`!document.getElementById("settings").hidden`);
  expect(await ev(`document.querySelector("#settings .shead").nextElementSibling.matches("[data-floors]")`)).toBe(true);
  await click('#settings [data-floor-row="finance"] [data-floor-edit]');
  await until(`document.getElementById("settings").hidden && !document.querySelector(".fpanel").hidden`);
  await click(".fpanel [data-fp-rm]");
  await until(`!!document.querySelector(".fpanel [data-fp-rm-yes]")`);
  await click(".fpanel [data-fp-rm-yes]");
  await until(`!document.querySelector('.ftile[data-floor="finance"]')`);
  await click("#settingsBtn");
  await until(`!document.getElementById("settings").hidden`);
  await key("Escape");
  await until(`document.getElementById("settings").hidden`);
  expect(await stageMode()).toBe("building");
});

test.skipIf(!chromeFound)("on a phone: one switcher row under the top bar, the FLOORS pips in the first screen, the list a bottom sheet, the building rows; no sideways scroll", async () => {
  await size(390, 844, true);
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await until(`document.querySelector(".top").nextElementSibling?.classList.contains("floornav")`);
  expect(await ev(ONE_ROW)).toMatchObject({ rows: true, inside: true });
  expect(await ev(`document.querySelector(".ffloors").getBoundingClientRect().bottom < innerHeight && document.querySelector(".fswitch").getBoundingClientRect().bottom < innerHeight`)).toBe(true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  // The questions come right after the row.
  expect(await ev(`document.querySelector(".floornav").getBoundingClientRect().bottom <= document.querySelector("#qtabs").getBoundingClientRect().top`)).toBe(true);
  await openList();
  expect(await ev(`(() => { const m = document.querySelector(".fmenu"), b = m.getBoundingClientRect(); return getComputedStyle(m).position === "fixed" && Math.abs(b.bottom - innerHeight) <= 1 && b.left === 0; })()`)).toBe(true);
  await click('.fmenu [data-floor-tab="support"]');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await ev(ONE_ROW)).toMatchObject({ rows: true, inside: true });
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await click(".fswitch [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  // Each floor a 44 px row; a tap on the row opens its picture (and ENTER); no PICTURE button.
  const heights: number[] = await ev(`[...document.querySelectorAll(".bgrid .ftile")].map((t) => Math.round(t.getBoundingClientRect().height))`);
  expect(new Set(heights)).toEqual(new Set([44]));
  // The building holds its rows: the panel after it starts below its last row.
  expect(await ev(`document.querySelector(".building").getBoundingClientRect().bottom >= document.querySelector(".bgrid > :last-child").getBoundingClientRect().bottom && document.querySelector(".under").getBoundingClientRect().top >= document.querySelector(".building").getBoundingClientRect().bottom`)).toBe(true);
  const lefts: number[] = await ev(`[...document.querySelectorAll(".bgrid .ftile")].map((t) => Math.round(t.getBoundingClientRect().left))`);
  expect(new Set(lefts).size).toBe(1);
  expect(await ev(`!!document.querySelector(".ftile .tpic")`)).toBe(false);
  expect(await shown('.ftile[data-floor="backend"] .tscene')).toBe(false);
  await click('.ftile[data-floor="backend"] .tgo');
  expect(await stageMode()).toBe("building");
  expect(await shown('.ftile[data-floor="backend"] .tscene')).toBe(true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  // ENTER in the open row goes in; the page brings the switcher into view, never off screen.
  await ev(`document.querySelector('.ftile[data-floor="backend"]').scrollIntoView({ block: "end" })`);
  const y0 = await ev(`scrollY`);
  await click('.ftile[data-floor="backend"] .tenterb');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await Bun.sleep(100);
  expect(await ev(`(() => { const r = document.querySelector(".fswitch").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  // The back button says where it goes; back in the building the switcher stays on screen, with no big jump.
  expect(await text(".fswitch [data-building]")).toContain("BUILDING");
  const y1 = await ev(`scrollY`);
  await click(".fswitch [data-building]");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await Bun.sleep(100);
  expect(await ev(`(() => { const r = document.querySelector(".fswitch").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  expect(Math.abs((await ev(`scrollY`)) - y1)).toBeLessThan(400);
  void y0;
  // The same words as on the desktop: NOTHING MOVING, never IDLE.
  expect(await ev(`document.body.innerText.includes("IDLE")`)).toBe(false);
  // The refused starts above answered 400, as they should; nothing else went wrong on the page.
  expect(errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
});
