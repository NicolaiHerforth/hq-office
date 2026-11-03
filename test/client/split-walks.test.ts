// SPLIT walked through as the owner uses it: a brief or a page beside a room, or beside the office with a lane's
// drawer open, with real mouse, touch and key input (CDP Input). Every way in and out: BACK, the browser's back, Esc,
// a reload, SPLIT and SINGLE, the divider, FULL SCREEN, NEW WINDOW, COMMENTS, a floor switch, dark mode, a narrower
// screen and a phone. A click lands only where the owner could click: the point must hit the element, not something
// covering it. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled, did } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-split-walk-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "api-auth", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const opened: { targetId: string; url: string }[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ hash: location.hash, stage: document.querySelector(".stage").className, card: !document.getElementById("card").hidden, room: document.querySelector("#roomView .rvhead h2")?.textContent, scope: sessionStorage.getItem("hq-scope"), tab: document.querySelector("[data-qtab].on")?.dataset.qtab, briefs: document.getElementById("briefs")?.hidden, rows: document.querySelectorAll("#briefs .brow").length, focus: document.activeElement?.tagName })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}${await clickLog(ev)}`);
};
const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=api-auth`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });
const HQ = { "x-hud-pane": "w1:p1", "x-hud-machine": "local" }, CRM = { "x-hud-pane": "w1:p2", "x-hud-machine": "local" };

// A fresh document at an address, inside the HQ floor, with nothing else kept from the walk before.
async function load(hash: string, w = 1512, h = 900, mobile = false, stored: Record<string, string> = {}) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: `${server.base}/?park` });
  await ev(`localStorage.clear(); Object.entries(${JSON.stringify(stored)}).forEach(([k, v]) => localStorage.setItem(k, v)); sessionStorage.setItem("hq-scope", JSON.stringify({ floor: "hq", all: false })); true`).catch(() => {});
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
async function point(sel: string) {
  await settled(ev, sel);
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
async function click(sel: string, clickCount = 1) {
  const [x, y] = await point(sel);
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let n = 1; n <= clickCount; n++) for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: n });
  await aimed(ev, sel, x, y, "pressed");
}
async function tap(sel: string) {
  const [x, y] = await point(sel);
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await aimed(ev, sel, x, y, "pressed");
}
const CODES = { Escape: 27, ArrowLeft: 37, ArrowRight: 39 } as const;
async function key(k: keyof typeof CODES) {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: CODES[k] });
}
// The divider, held and moved by DX pixels.
async function drag(dx: number) {
  const [x, y] = await point(".stage > .splitbar");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * i) / 8, y, button: "left", buttons: 1 });
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y, button: "left", buttons: 0, clickCount: 1 });
}
// The browser's back button.
async function back() {
  await did(ev, "back");
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
}
const shows = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) / 2 + Math.min(r.bottom, innerHeight) / 2); return !!hit && (hit === e || e.contains(hit)); })()`;
const box = (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })()`);
const hash = () => ev(`location.hash`);
const split = `document.querySelector(".stage").classList.contains("split")`;
// The room on the left and the brief on the right, both in view, neither over the other.
const side = (what: string) => `${split} && ${shows("#roomView .rthread")} && ${shows(what)} && document.querySelector("#roomView").getBoundingClientRect().right <= document.querySelector(".stage > .splitbar").getBoundingClientRect().left + 1`;
const roomAlone = `!(${split}) && ${shows("#roomView")} && document.querySelector(".briefview").hidden && document.querySelector(".pageview").hidden`;
const office = `location.hash === "" && document.querySelector(".briefview").hidden && document.getElementById("roomView").hidden && document.querySelector(".pageview").hidden && ${shows(".stage > .room")}`;
let brief = 0, older = 0, pageBrief = 0, crmBrief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "api-auth", title: "Rotate the auth tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await post("/api/rooms", { slug: "ope-13", title: "Token audit", owner: "api-auth" });
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v1</p>");
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v2</p>");
  crmBrief = (await post("/api/briefs", { title: "CRM import plan", body: "Import in two steps." }, CRM)).id;
  older = (await post("/api/briefs", { title: "placeholder", body: "The week before." }, HQ)).id;
  brief = (await post("/api/briefs", { title: "placeholder", body: ["## Where we are", "", "#lane/api-auth", "", "#room/ope-13", "", "#page/rooms/ope-12/files/plan.html", "", `#brief/${crmBrief}`].join("\n") }, HQ)).id;
  pageBrief = (await post("/api/briefs", { title: "A brief that is a page", body: "<!doctype html><html><body><h1>Page brief</h1></body></html>" }, HQ)).id;
  chrome = await startChrome();
  await chrome.cdp.send("Target.setDiscoverTargets", { discover: true });
  chrome.cdp.listeners.push((m: any) => { if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.openerId) opened.push(m.params.targetInfo); });
  page = await newSession(chrome.cdp, errors);
  // Web fonts come over the network at their own time and widen the text they replace: a click aimed just before
  // lands beside its target (the tabs move 96 px when Press Start 2P arrives). The walks run without them.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});
async function openedWindow() {
  for (const end = Date.now() + 8000; Date.now() < end && !opened.length; await Bun.sleep(50));
  const t = opened.shift();
  if (!t) throw new Error("no window opened");
  let url = t.url;
  for (const end = Date.now() + 8000; Date.now() < end && (!url || url === "about:blank"); await Bun.sleep(100)) url = (await chrome.cdp.send("Target.getTargetInfo", { targetId: t.targetId })).targetInfo.url;
  return { targetId: t.targetId, url };
}
// A room, then a brief from the BRIEFS tab: they sit side by side.
async function roomThenBrief(id = brief, what = ".briefview .bbody", w = 1512) {
  await load("", w);
  await click('[data-qtab="rooms"]');
  await click('#rooms [data-room="ope-12"] .rt');
  await until(`location.hash === "#room/ope-12" && ${shows("#roomView")}`);
  await click('[data-qtab="briefs"]');
  await until(shows(`#briefs .brow[href="#brief/${id}"]`));
  await click(`#briefs .brow[href="#brief/${id}"]`);
  await until(side(what));
}

test.skipIf(!chromeFound)("a room › BRIEFS › a brief sits beside the room; the address holds both; BACK closes the brief and the room stays", async () => {
  await roomThenBrief();
  expect(await hash()).toBe(`#room/ope-12+brief/${brief}`);
  const [l, r] = [await box("#roomView"), await box(".briefview")];
  expect(l.width).toBeGreaterThanOrEqual(400);
  expect(r.width).toBeGreaterThanOrEqual(400);
  expect(await ev(shows("#briefs"))).toBe(true);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a reload holds both; the browser's back closes the brief, then leaves the room", async () => {
  await roomThenBrief();
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await until(side(".briefview .bbody"));
  await back();
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  await back();
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("Esc in the room's send box leaves the box, the draft kept; then Esc closes the brief, then leaves the room", async () => {
  await roomThenBrief();
  await click("#roomView .rsend textarea");
  await page.s("Input.insertText", { text: "half a thought" });
  await key("Escape");
  await until(`document.activeElement === document.body && ${side(".briefview .bbody")}`);
  expect(await ev(`document.querySelector("#roomView .rsend textarea").value`)).toBe("half a thought");
  expect(await hash()).toBe(`#room/ope-12+brief/${brief}`);
  await key("Escape");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  expect(await ev(`document.querySelector("#roomView .rsend textarea").value`)).toBe("half a thought");
  await key("Escape");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("SINGLE: the brief alone, the same address; BACK returns to the room; SPLIT again; the choice survives a reload", async () => {
  await roomThenBrief();
  await click(".briefview [data-split-toggle]");
  await until(`!(${split}) && ${shows(".briefview .bbody")} && !(${shows("#roomView")})`);
  expect(await hash()).toBe(`#room/ope-12+brief/${brief}`);
  expect(await ev(`document.querySelector(".briefview [data-split-toggle]").innerText.trim()`)).toBe("SPLIT");
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML && ${shows(".briefview .bbody")}`);
  expect(await ev(split)).toBe(false);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${brief}"]`);
  await until(`${shows(".briefview .bbody")} && !(${split})`);
  await click(".briefview [data-split-toggle]");
  await until(side(".briefview .bbody"));
  expect(await ev(`document.querySelector(".briefview [data-split-toggle]").innerText.trim()`)).toBe("SINGLE");
}, 30_000);

test.skipIf(!chromeFound)("the divider drags, keeps both panes at least 400 wide, survives a reload, moves with the arrow keys, and a double-click halves it", async () => {
  await roomThenBrief(brief, ".briefview .bbody", 1680);
  const before = await box("#roomView");
  await drag(-120);
  await until(`Math.abs(document.querySelector("#roomView").getBoundingClientRect().width - ${before.width - 120}) < 6`);
  await drag(-2000);
  expect((await box("#roomView")).width).toBeGreaterThanOrEqual(398);
  const narrowest = (await box("#roomView")).width;
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await until(side(".briefview .bbody"));
  expect(Math.abs((await box("#roomView")).width - narrowest)).toBeLessThan(3);
  await drag(4000);
  expect((await box(".briefview")).width).toBeGreaterThanOrEqual(398);
  await click(".stage > .splitbar", 2);
  await until(`Math.abs(document.querySelector("#roomView").getBoundingClientRect().width - document.querySelector(".briefview").getBoundingClientRect().width) < 4`);
  const half = (await box("#roomView")).width;
  await key("ArrowRight");
  expect((await box("#roomView")).width).toBeGreaterThan(half + 20);
  expect(await ev(`localStorage.getItem("hq-split-ratio")`)).not.toBe(null);
}, 30_000);

test.skipIf(!chromeFound)("room to room with the brief kept: ROOMS › another room changes the left pane only; BACK TO OFFICE keeps the brief beside the office", async () => {
  await roomThenBrief();
  await click('[data-qtab="rooms"]');
  await click('#rooms [data-room="ope-13"] .rt');
  await until(`location.hash === "#room/ope-13+brief/${brief}" && ${side(".briefview .bbody")} && document.querySelector("#roomView .rvhead h2").textContent === "Token audit"`);
  await click('#roomView .rvtab[data-room-go="ope-12"]');
  await until(`location.hash === "#room/ope-12+brief/${brief}" && document.querySelector("#roomView .rvhead h2").textContent === "Auth rotation"`);
  await click("[data-room-back]");
  await until(`location.hash === "#brief/${brief}" && ${split} && ${shows(".stage > .room")} && ${shows(".briefview .bbody")}`);
}, 30_000);

test.skipIf(!chromeFound)("a brief over the office alone takes the column, with no SPLIT; a room card in it puts the room beside it; back leaves the room, the split stays", async () => {
  await load(`#brief/${brief}`);
  await until(shows(".briefview .bbody"));
  expect(await ev(split)).toBe(false);
  expect(await ev(`getComputedStyle(document.querySelector(".briefview [data-split-toggle]")).display`)).toBe("none");
  await until(`!!document.querySelector('.briefview .hudcard[data-ref="room/ope-13"]:not(.loading)')`);
  await click('.briefview .hudcard[data-ref="room/ope-13"]');
  await until(`location.hash === "#room/ope-13+brief/${brief}" && ${side(".briefview .bbody")}`);
  await back();
  await until(`location.hash === "#brief/${brief}" && ${split} && ${shows(".stage > .room")} && ${shows(".briefview .bbody")}`);
}, 30_000);

test.skipIf(!chromeFound)("a lane's drawer: a lane card in the brief opens it over the left pane, beside the brief; Esc closes the drawer (it opened last), then the brief", async () => {
  await load(`#brief/${brief}`);
  await until(`!!document.querySelector('.briefview .hudcard[data-ref="lane/api-auth"]:not(.loading)')`);
  await click('.briefview .hudcard[data-ref="lane/api-auth"]');
  await until(`${split} && ${shows("#card")} && ${shows(".briefview .bbody")} && document.querySelector("#card h3").textContent === "api-auth"`);
  await until(`document.querySelector("#card").getBoundingClientRect().right <= document.querySelector(".stage > .splitbar").getBoundingClientRect().left`);
  expect((await box("#card")).width).toBeGreaterThan(300);
  await drag(-40);
  await until(`document.querySelector("#card").getBoundingClientRect().right <= document.querySelector(".stage > .splitbar").getBoundingClientRect().left`);
  await key("Escape");
  await until(`document.getElementById("card").hidden && ${split} && ${shows(".briefview .bbody")} && location.hash === "#brief/${brief}"`);
  await key("Escape");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("the drawer open, then BRIEFS › a brief: split; closing the drawer keeps it split until the brief closes", async () => {
  await load("#lane/api-auth");
  await until(shows("#card"));
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${older}"]`);
  await until(`${split} && ${shows("#card")} && ${shows(".briefview .bbody")}`);
  await click("[data-card-close]");
  await until(`document.getElementById("card").hidden && ${split} && ${shows(".stage > .room")} && ${shows(".briefview .bbody")}`);
  await click("[data-brief-back]");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("the drawer open, then a brief: Esc closes the brief first (it opened last), then the drawer", async () => {
  await load("#lane/api-auth");
  await until(shows("#card"));
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${older}"]`);
  await until(`${split} && ${shows("#card")} && ${shows(".briefview .bbody")}`);
  await key("Escape");
  await until(`document.querySelector(".briefview").hidden && location.hash === "" && ${shows("#card")}`);
  await key("Escape");
  await until(`document.getElementById("card").hidden`);
}, 30_000);

test.skipIf(!chromeFound)("SINGLE with the drawer open: the drawer floats over the brief, and Esc closes the drawer first", async () => {
  await load("#lane/api-auth", 1512, 900, false, { "hq-split": "single" });
  await until(shows("#card"));
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${older}"]`);
  await until(`!(${split}) && ${shows("#card")} && !document.querySelector(".briefview").hidden`);
  await key("Escape");
  await until(`document.getElementById("card").hidden && ${shows(".briefview .bbody")}`);
  await key("Escape");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("FULL SCREEN in split takes the brief alone; leaving it, the split is back", async () => {
  await roomThenBrief();
  await click(".briefview [data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  expect(await ev(`getComputedStyle(document.querySelector(".briefview [data-split-toggle]")).display`)).toBe("none");
  await click(".briefview [data-view-full]");
  await until(`!document.fullscreenElement && ${side(".briefview .bbody")}`);
}, 30_000);

test.skipIf(!chromeFound)("NEW WINDOW from the split opens the brief alone in a window of its own", async () => {
  await roomThenBrief();
  opened.length = 0;
  await click(".bvbar a[target=_blank]");
  const w = await openedWindow();
  expect(w.url).toBe(`${server.base}/#brief/${brief}`);
  await chrome.cdp.send("Target.closeTarget", { targetId: w.targetId });
  expect(await ev(side(".briefview .bbody"))).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("COMMENTS in split: the thread sits under the brief, the room still beside it; Esc in the comment box leaves the box, the draft kept, and the next closes the brief", async () => {
  await roomThenBrief();
  await click(".briefview [data-comments-toggle]");
  await until(`${shows(".briefview .cmount textarea")} && ${side(".briefview .bbody")}`);
  const [body, thread] = [await ev(`document.querySelector(".briefview .bbody").getBoundingClientRect().bottom`), await ev(`document.querySelector(".briefview .cmount").getBoundingClientRect().top`)];
  expect(thread).toBeGreaterThanOrEqual(body);
  await click(".briefview .cmount textarea");
  await page.s("Input.insertText", { text: "a comment half written" });
  await key("Escape");
  await until(`document.activeElement === document.body && ${side(".briefview .bbody")} && ${shows(".briefview .cmount textarea")}`);
  expect(await ev(`document.querySelector(".briefview .cmount textarea").value`)).toBe("a comment half written");
  await key("Escape");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
}, 30_000);

test.skipIf(!chromeFound)("a page beside the room: the shelf's OPEN; VERSIONS keep the room; BACK returns to the room", async () => {
  await load("#room/ope-12");
  await until(`${shows("#roomView")} && !!document.querySelector('#roomView .rshelf a.open[href^="#page/"]')`);
  await click('#roomView .rshelf a.open[href^="#page/"]');
  await until(`location.hash === "#room/ope-12+page/rooms/ope-12/files/plan.html" && ${side(".pageview .pageframe")}`);
  await until(`!!document.querySelector(".pageview [data-page-versions]")`);
  await click(".pageview [data-page-versions]");
  await click(".pageview .pvvers a.pvv:not(.here)");
  await until(`/^#room\\/ope-12\\+page\\/rooms\\/ope-12\\/files\\/plan\\.html\\?v=\\d+$/.test(location.hash) && ${side(".pageview .pageframe")} && !document.querySelector(".pageview .pvold").hidden`);
  await click("[data-page-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
}, 30_000);

test.skipIf(!chromeFound)("a page from a brief beside the room: BACK returns to the brief, then to the room; the browser's back does the same", async () => {
  await roomThenBrief();
  await until(`!!document.querySelector('.briefview .hudcard[data-ref="page/rooms/ope-12/files/plan.html"]:not(.loading)')`);
  await click('.briefview .hudcard[data-ref="page/rooms/ope-12/files/plan.html"]');
  await until(`location.hash === "#room/ope-12+page/rooms/ope-12/files/plan.html" && ${side(".pageview .pageframe")}`);
  await click("[data-page-back]");
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${side(".briefview .bbody")}`);
  await until(`!!document.querySelector('.briefview .hudcard[data-ref="page/rooms/ope-12/files/plan.html"]:not(.loading)')`);
  await click('.briefview .hudcard[data-ref="page/rooms/ope-12/files/plan.html"]');
  await until(side(".pageview .pageframe"));
  await back();
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${side(".briefview .bbody")} && document.querySelector(".pageview").hidden`);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
}, 30_000);

test.skipIf(!chromeFound)("a brief that is a page sits beside the room too, and NEWER and OLDER keep the room", async () => {
  await roomThenBrief(pageBrief, ".briefview .pageframe");
  await click('.briefview [data-brief-step="1"]');
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${side(".briefview .bbody")}`);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
}, 30_000);

test.skipIf(!chromeFound)("floors: a brief from another floor, opened from a card in a brief, opens alone in its floor; BACK returns to the brief it came from, then to the room; from the building's list, BACK returns to the room", async () => {
  await roomThenBrief();
  await until(`!!document.querySelector('.briefview .hudcard[data-ref="brief/${crmBrief}"]:not(.loading)')`);
  await click(`.briefview .hudcard[data-ref="brief/${crmBrief}"]`);
  await until(`location.hash === "#room/ope-12+brief/${crmBrief}" && JSON.parse(sessionStorage.getItem("hq-scope")).floor === "crm" && ${shows(".briefview .bbody")} && !(${split})`);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12+brief/${brief}" && JSON.parse(sessionStorage.getItem("hq-scope")).floor === "hq" && ${side(".briefview .bbody")}`);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  await click("[data-scope-out]");
  await until(`!JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor`);
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${brief}"]`);
  await until(side(".briefview .bbody"));
  await click(`#briefs .brow[href="#brief/${crmBrief}"]`);
  await until(`location.hash === "#room/ope-12+brief/${crmBrief}" && ${shows(".briefview .bbody")} && !(${split})`);
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
  expect(errors).toEqual([]);
}, 40_000);

test.skipIf(!chromeFound)("dark mode: the split and its divider follow the theme", async () => {
  await roomThenBrief();
  await click("#menuBtn");
  await click('.mseg [data-set-theme="dark"]');
  await until(`document.documentElement.dataset.theme === "dark"`);
  await click("#menuBtn");
  const c = await ev(`(() => { const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).slice(0, 3).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; return { bar: lum(getComputedStyle(document.querySelector(".stage > .splitbar"), "::before").backgroundColor), page: lum(getComputedStyle(document.body).backgroundColor), brief: lum(getComputedStyle(document.querySelector(".briefview")).backgroundColor) }; })()`);
  expect(c.page).toBeLessThan(80);
  expect(c.brief).toBeLessThan(80);
  expect(Math.abs(c.bar - c.page)).toBeGreaterThan(15);
  expect(await ev(side(".briefview .bbody"))).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("the stage's width decides: a 1440 window splits, a 1280 window shows the brief alone with no SPLIT and BACK returns to the room", async () => {
  await load(`#room/ope-12+brief/${brief}`, 1440);
  await until(side(".briefview .bbody"));
  await load(`#room/ope-12+brief/${brief}`, 1280);
  await until(`${shows(".briefview .bbody")} && !(${split})`);
  expect(await ev(`getComputedStyle(document.querySelector(".briefview [data-split-toggle]")).display`)).toBe("none");
  await click("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${roomAlone}`);
}, 30_000);

test.skipIf(!chromeFound)("phone: the address with both shows the brief over the whole screen; BACK shows the room; BACK TO OFFICE", async () => {
  await load(`#room/ope-12+brief/${brief}`, 390, 844, true);
  await until(`${shows(".briefview .bbody")} && !(${split})`);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await ev(`getComputedStyle(document.querySelector(".stage > .splitbar")).display`)).toBe("none");
  await tap("[data-brief-back]");
  await until(`location.hash === "#room/ope-12" && ${shows("#roomView")}`);
  await tap("[data-room-back]");
  await until(`location.hash === ""`);
  expect(errors).toEqual([]);
}, 30_000);
