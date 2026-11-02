// RICH CARDS walked through as the owner uses them: real mouse, touch and key input (CDP Input), every way in and out
// (BACK, the browser's back, Esc, a reload, an address typed in, full screen, phone width), and next to the features
// beside them (the brief view's COMMENTS, FULL SCREEN and NEW WINDOW, dark mode, floors). A click lands only where the
// owner could click: the point must hit the element, not something covering it. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-embeds-walk-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "api-auth", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const opened: { targetId: string; url: string }[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ hash: location.hash, full: !!document.fullscreenElement, stage: document.querySelector(".stage").className, toast: [...document.querySelectorAll(".toast")].map((t) => t.textContent), focus: document.activeElement?.tagName + "." + document.activeElement?.className, btn: document.querySelector("[data-view-full]")?.textContent })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}`);
};
const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string | Uint8Array) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=api-auth`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });
// A fresh document at an address, with nothing kept from the walk before (the floor you were in, the theme).
async function load(hash: string, w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: `${server.base}/?park` });
  await ev(`sessionStorage.clear(); localStorage.clear(); true`).catch(() => {});
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
// Where the owner would click on SEL: scrolled into view, and the point must hit SEL itself, not a cover over it.
async function point(sel: string) {
  const at = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return "missing";
    e.scrollIntoView({ block: "nearest" });
    const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot click ${sel}: ${at}`);
  return at as [number, number];
}
async function click(sel: string) {
  const [x, y] = await point(sel);
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function tap(sel: string) {
  const [x, y] = await point(sel);
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function key(k: "Escape") {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: 27 });
}
// The browser's back button.
async function back() {
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
}
// On screen and not covered: the middle of SEL hits SEL.
const shows = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) / 2 + Math.min(r.bottom, innerHeight) / 2); return !!hit && (hit === e || e.contains(hit)); })()`;
const card = (ref: string) => `.briefview .bbody .hudcard[data-ref="${ref}"]`;
const BRIEF_CARDS = 8;
const briefReady = () => until(`document.querySelectorAll(".briefview .bbody .hudcard:not(.loading)").length === ${BRIEF_CARDS}`);
// Back where the owner started: no brief, room or page on the stage, and the building (two floors) in view.
const office = `location.hash === "" && document.querySelector(".briefview").hidden && document.getElementById("roomView").hidden && document.querySelector(".pageview").hidden && (${shows(".stage > .building")})`;
let brief = 0, crmBrief = 0, open = 0, crmAsk = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "api-auth", title: "Rotate the auth tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  open = (await post("/api/asks", { title: "Ship the pricing page?", body: "It is ready.", lane: "api-auth" })).id;
  crmAsk = (await post("/api/asks", { title: "Import the CRM contacts?" }, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" })).id;
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await upload("ope-12", "chart.png", PNG);
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v1</p>");
  crmBrief = (await post("/api/briefs", { title: "CRM import plan", body: "Import in two steps." }, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" })).id;
  const body = ["## Everything in one place", "", `#brief/${crmBrief}`, "", "#room/ope-12", "", "#lane/api-auth", "", `#ask/${open}`, "", `#ask/${crmAsk}`, "", "#floor/crm", "", "#page/rooms/ope-12/files/chart.png", "", "#page/rooms/ope-12/files/plan.html"].join("\n");
  brief = (await post("/api/briefs", { title: "Weekly: where things are", body }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  await chrome.cdp.send("Target.setDiscoverTargets", { discover: true });
  chrome.cdp.listeners.push((m: any) => { if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.openerId) opened.push(m.params.targetInfo); });
  page = await newSession(chrome.cdp, errors);
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});
// A window the HUD opened: its address once it has one, then closed.
async function openedWindow() {
  for (const end = Date.now() + 8000; Date.now() < end && !opened.length; await Bun.sleep(50));
  const t = opened.shift();
  if (!t) throw new Error("no window opened");
  let url = t.url;
  for (const end = Date.now() + 8000; Date.now() < end && (!url || url === "about:blank"); await Bun.sleep(100)) url = (await chrome.cdp.send("Target.getTargetInfo", { targetId: t.targetId })).targetInfo.url;
  return { targetId: t.targetId, url };
}

test.skipIf(!chromeFound)("BRIEFS › a brief › its room card puts the room beside it › the browser's back › the brief again › Esc › the office", async () => {
  await load("");
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${brief}"]`);
  await briefReady();
  await click(card("room/ope-12"));
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")} && ${shows(".briefview")}`);
  await back();
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview")}`);
  await briefReady();
  await key("Escape");
  await until(office);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a lane card opens its drawer beside the brief; Esc closes the drawer, the brief stays; Esc again leaves it", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click(card("lane/api-auth"));
  await until(`${shows("#card")} && ${shows(".briefview")} && document.querySelector("#card h3").textContent === "api-auth"`);
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
  await key("Escape");
  await until(`document.getElementById("card").hidden && ${shows(".briefview")}`);
  await key("Escape");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("a question card shows the question in NEEDS YOU, with the brief still open beside it", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click('[data-qtab="messages"]');
  await click(card(`ask/${open}`));
  await until(`${shows(`.ask[data-ask="${open}"]`)} && document.querySelector('[data-qtab="questions"]').classList.contains("on")`);
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
  expect(await ev(shows(".briefview"))).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("a page card › the page › BACK › the brief; again › the browser's back › the brief", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click(card("page/rooms/ope-12/files/plan.html"));
  await until(`location.hash === "#page/rooms/ope-12/files/plan.html" && ${shows(".pageview .pageframe")}`);
  await click("[data-page-back]");
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview")}`);
  await briefReady();
  await click(card("page/rooms/ope-12/files/plan.html"));
  await until(`${shows(".pageview .pageframe")}`);
  await back();
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview")} && document.querySelector(".pageview").hidden`);
}, 30_000);

test.skipIf(!chromeFound)("an image card opens the file in a new tab; the HUD stays on the brief", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  opened.length = 0;
  await click(card("page/rooms/ope-12/files/chart.png"));
  const w = await openedWindow();
  expect(w.url).toBe(`${server.base}/rooms/ope-12/files/chart.png`);
  await chrome.cdp.send("Target.closeTarget", { targetId: w.targetId });
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
}, 30_000);

test.skipIf(!chromeFound)("a reload on the brief brings every card back, the shelf ones from the server", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await briefReady();
  expect(await ev(`[...document.querySelectorAll(".briefview .bbody .hudcard")].map((c) => c.querySelector(".hcword").textContent)`)).toEqual(["BRIEF", "ROOM", "LANE", "QUESTION", "QUESTION", "FLOOR", "IMAGE", "PAGE"]);
}, 30_000);

test.skipIf(!chromeFound)("FULL SCREEN › a lane card leaves full screen and shows the drawer; FULL SCREEN › a room card shows the room", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click("[data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await click(card("lane/api-auth"));
  await until(`!document.fullscreenElement && ${shows("#card")}`);
  await key("Escape");
  // the label says FULL SCREEN again once the browser has left it; until then the bar is laid out for EXIT FULL SCREEN
  await until(`document.getElementById("card").hidden && document.querySelector("[data-view-full]").textContent === "FULL SCREEN"`);
  await click("[data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await click(card("room/ope-12"));
  await until(`!document.fullscreenElement && location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")}`);
  await click("[data-room-back]");
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview")}`);
  await key("Escape");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("COMMENTS: a comment that is only a reference shows as a card in the thread, and opens the room", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click("[data-comments-toggle]");
  await until(shows(".briefview .cmount textarea"));
  await click(".briefview .cmount textarea");
  await page.s("Input.insertText", { text: "#room/ope-12" });
  await click(".briefview .cmount [data-csend]");
  await until(`!!document.querySelector('.briefview .cmount .hudcard[data-ref="room/ope-12"]:not(.loading)')`);
  await click('.briefview .cmount .hudcard[data-ref="room/ope-12"]');
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")}`);
}, 30_000);

test.skipIf(!chromeFound)("NEW WINDOW: the brief in a window of its own has its cards", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  opened.length = 0;
  await click(".bvbar a[target=_blank]");
  const w = await openedWindow();
  expect(w.url).toBe(`${server.base}/#brief/${brief}`);
  const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId: w.targetId, flatten: true });
  const there = async (expr: string) => (await chrome.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)).result.value;
  for (const end = Date.now() + 10_000; Date.now() < end && (await there(`document.querySelectorAll(".briefview .bbody .hudcard:not(.loading)").length`)) !== BRIEF_CARDS; await Bun.sleep(100));
  expect(await there(`document.querySelectorAll(".briefview .bbody .hudcard:not(.loading)").length`)).toBe(BRIEF_CARDS);
  await chrome.cdp.send("Target.closeTarget", { targetId: w.targetId });
}, 30_000);

test.skipIf(!chromeFound)("dark mode from MENU: the cards follow it, and their text reads on them", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click("#menuBtn");
  await click('.mseg [data-set-theme="dark"]');
  await until(`document.documentElement.dataset.theme === "dark"`);
  const contrast = await ev(`(() => {
    const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => { const [r, g, b] = rgb(c).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return +((x + 0.05) / (y + 0.05)).toFixed(1); };
    const c = document.querySelector('${card(`ask/${open}`)}'), bg = getComputedStyle(c).backgroundColor, chip = c.querySelector(".hchip");
    return { panel: lum(bg) < 0.2, title: ratio(getComputedStyle(c.querySelector(".hctitle")).color, bg), line: ratio(getComputedStyle(c.querySelector(".hcprev")).color, bg), chip: ratio(getComputedStyle(chip).color, getComputedStyle(chip).backgroundColor) };
  })()`);
  expect(contrast.panel).toBe(true);
  expect(contrast.title).toBeGreaterThanOrEqual(7);
  expect(contrast.line).toBeGreaterThanOrEqual(4.5);
  expect(contrast.chip).toBeGreaterThanOrEqual(3);
}, 30_000);

test.skipIf(!chromeFound)("floors: a floor card goes into the floor, Esc steps back out; inside a floor, a card of another floor's question goes there", async () => {
  await load(`#brief/${brief}`);
  await briefReady();
  await click(card("floor/crm"));
  await until(`document.querySelector(".stage").dataset.floors === "floor" && JSON.parse(sessionStorage.getItem("hq-scope")).floor === "crm" && location.hash === ""`);
  await key("Escape");
  await until(`document.querySelector(".stage").dataset.floors === "building"`);
  await click('.building .tgo[data-floor-go="hq"]');
  await until(`JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor === "hq"`);
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${brief}"]`);
  await briefReady();
  expect(await ev(`document.querySelector('.ask[data-ask="${crmAsk}"]')`)).toBe(null); // the HQ floor's list leaves it out
  await click(card(`ask/${crmAsk}`));
  await until(`JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor === "crm" && ${shows(`.ask[data-ask="${crmAsk}"]`)}`);
}, 30_000);

test.skipIf(!chromeFound)("an address typed in: #lane/NAME opens the drawer and is cleared; #ask/ID shows the question", async () => {
  await load("#lane/api-auth");
  await until(`${shows("#card")} && location.hash === ""`);
  await load(`#ask/${open}`);
  await until(`${shows(`.ask[data-ask="${open}"]`)} && location.hash === ""`);
}, 30_000);

test.skipIf(!chromeFound)("phone: a lane card's drawer is a sheet over the brief; ✕; a room card fills the screen; BACK TO OFFICE", async () => {
  await load(`#brief/${brief}`, 390, 844, true);
  await briefReady();
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await tap(card("lane/api-auth"));
  await until(`${shows("#card")} && document.querySelector("#card h3").textContent === "api-auth"`);
  await tap("[data-card-close]");
  await until(`document.getElementById("card").hidden && ${shows(".briefview")}`);
  await tap(card("room/ope-12"));
  await until(`location.hash === "#room/ope-12" && ${shows("#roomView")}`);
  await tap("[data-room-back]");
  await until(`location.hash === ""`);
  expect(errors).toEqual([]);
}, 30_000);
