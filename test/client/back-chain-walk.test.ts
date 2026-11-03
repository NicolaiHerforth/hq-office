// BACK from a brief opened in a brief, walked through as the owner uses it: real mouse, touch and key input (CDP Input).
// A brief or a page opened from a brief (a card or a link in it) adds a history step, so BACK (the brief's button, Esc,
// the browser's back) returns to the brief it came from, then to where the owner started; NEWER and OLDER step through
// the list and leave in one BACK. Beside a room, with FULL SCREEN, a page from the second brief, and at phone width.
// A click lands only where the owner could click: the point must hit the element, not something covering it. Needs
// Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-back-chain-walk-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "api-auth", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ hash: location.hash, title: document.querySelector(".briefview:not([hidden]) .bbody h1")?.textContent, stage: document.querySelector(".stage").className, full: !!document.fullscreenElement, btn: document.querySelector(".briefview [data-view-full]")?.textContent, history: history.length, state: history.state })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}${await clickLog(ev)}`);
};
const post = async (p: string, b: unknown) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", "x-hud-pane": "w1:p1", "x-hud-machine": "local" }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=api-auth`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });

// A fresh document at an address, with nothing kept from the walk before.
async function load(hash: string, w = 1512, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: `${server.base}/?park` });
  await ev(`sessionStorage.clear(); localStorage.clear(); true`).catch(() => {});
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
// Where the owner would click on SEL: scrolled into view, and the point must hit SEL itself, not a cover over it.
async function point(sel: string) {
  await settled(ev, sel);
  const at = await ev(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length);
    if (!e) return "missing";
    e.scrollIntoView({ block: "nearest" });
    const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot click ${sel}: ${at}`);
  return at as [number, number];
}
let mobile = false;
async function click(sel: string) {
  const [x, y] = await point(sel);
  await aimed(ev, sel, x, y, "aim");
  if (mobile) {
    await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await aimed(ev, sel, x, y, "pressed");
}
async function esc() {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
// The browser's back button.
async function browserBack() {
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
}
const WAYS = { "BACK": () => click("[data-brief-back]"), "Esc": esc, "the browser's back": browserBack } as const;
type Way = keyof typeof WAYS;

const shows = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) / 2 + Math.min(r.bottom, innerHeight) / 2); return !!hit && (hit === e || e.contains(hit)); })()`;
const split = `document.querySelector(".stage").classList.contains("split")`;
const roomLeft = `${split} && ${shows("#roomView .rthread")} && document.querySelector("#roomView").getBoundingClientRect().right <= document.querySelector(".stage > .splitbar").getBoundingClientRect().left + 1`;
const roomAlone = `location.hash === "#room/ope-12" && !(${split}) && ${shows("#roomView")} && document.querySelector(".briefview").hidden && document.querySelector(".pageview").hidden`;
const office = `location.hash === "" && document.querySelector(".briefview").hidden && document.getElementById("roomView").hidden && document.querySelector(".pageview").hidden && ${shows(".stage > .room")}`;

const ids: Record<"A" | "B" | "C" | "D", number> = { A: 0, B: 0, C: 0, D: 0 };
type Name = keyof typeof ids;
const TITLE = { A: "Brief A: the week", B: "Brief B: auth rotation", C: "Brief C: token audit", D: "Brief D: newest" };
// Brief NAME on the stage (beside room ROOM when given), its cards loaded.
const at = (name: Name, room?: string) => `location.hash === "${room ? `#room/${room}+` : "#"}brief/${ids[name]}" && ${shows(".briefview .bbody")} && document.querySelector(".briefview .bbody h1")?.textContent === ${JSON.stringify(TITLE[name])} && ![...document.querySelectorAll(".briefview .bbody .hudcard")].some((c) => c.classList.contains("loading"))`;
const cardTo = (ref: string) => `.briefview .bbody .hudcard[data-ref="${ref}"]`;

// The office, then BRIEFS › brief A.
async function openA(w = 1512, h = 900, phone = false) {
  mobile = phone;
  await load("", w, h, phone);
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${ids.A}"]`);
  await until(at("A"));
}

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/lanes", { name: "api-auth", title: "Rotate the auth tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>The plan</p>");
  ids.C = (await post("/api/briefs", { title: TITLE.C, body: "Every token checked." })).id;
  ids.B = (await post("/api/briefs", { title: TITLE.B, body: ["Where the rotation is.", "", `#brief/${ids.C}`, "", "#page/rooms/ope-12/files/plan.html"].join("\n") })).id;
  ids.A = (await post("/api/briefs", { title: TITLE.A, body: ["The week in one place.", "", `#brief/${ids.B}`, "", `More in [the rotation brief](#brief/${ids.B}).`].join("\n") })).id;
  ids.D = (await post("/api/briefs", { title: TITLE.D, body: "The latest." })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  // Web fonts come over the network at their own time and widen the text they replace: a click aimed just before
  // lands beside its target. The walks run without them.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const way of Object.keys(WAYS) as Way[]) {
  test.skipIf(!chromeFound)(`A › B's card › ${way} › A › ${way} › the office`, async () => {
    await openA();
    await click(cardTo(`brief/${ids.B}`));
    await until(at("B"));
    await WAYS[way]();
    await until(at("A"));
    await WAYS[way]();
    await until(office);
    expect(errors).toEqual([]);
  }, 30_000);
}

test.skipIf(!chromeFound)("a chain: A › a link to B › C's card › Esc › B › the browser's back › A › BACK › the office", async () => {
  await openA();
  await click(`.briefview .bbody a[href="#brief/${ids.B}"]`);
  await until(at("B"));
  await click(cardTo(`brief/${ids.C}`));
  await until(at("C"));
  await esc();
  await until(at("B"));
  await browserBack();
  await until(at("A"));
  await click("[data-brief-back]");
  await until(office);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("NEWER and OLDER step through the list: A › NEWER › BACK › the office; A › OLDER › OLDER › Esc › the office", async () => {
  await openA();
  await click(`.briefview [data-brief-step="-1"]`);
  await until(at("D"));
  await click("[data-brief-back]");
  await until(office);
  await click(`#briefs .brow[href="#brief/${ids.A}"]`);
  await until(at("A"));
  await click(`.briefview [data-brief-step="1"]`);
  await until(at("B"));
  await click(`.briefview [data-brief-step="1"]`);
  await until(at("C"));
  await esc();
  await until(office);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a brief opened in a brief, then OLDER: BACK returns to the brief it was opened from", async () => {
  await openA();
  await click(cardTo(`brief/${ids.B}`));
  await until(at("B"));
  await click(`.briefview [data-brief-step="1"]`);
  await until(at("C"));
  await click("[data-brief-back]");
  await until(at("A"));
  await click("[data-brief-back]");
  await until(office);
}, 30_000);

test.skipIf(!chromeFound)("beside a room: A › B › C keep the room on the left; BACK › B, Esc › A, the browser's back › the room alone", async () => {
  mobile = false;
  await load("");
  await click('[data-qtab="rooms"]');
  await click('#rooms [data-room="ope-12"] .rt');
  await until(`location.hash === "#room/ope-12" && ${shows("#roomView")}`);
  await click('[data-qtab="briefs"]');
  await click(`#briefs .brow[href="#brief/${ids.A}"]`);
  await until(`${at("A", "ope-12")} && ${roomLeft}`);
  await click(cardTo(`brief/${ids.B}`));
  await until(`${at("B", "ope-12")} && ${roomLeft}`);
  await click(cardTo(`brief/${ids.C}`));
  await until(`${at("C", "ope-12")} && ${roomLeft}`);
  await click("[data-brief-back]");
  await until(`${at("B", "ope-12")} && ${roomLeft}`);
  await esc();
  await until(`${at("A", "ope-12")} && ${roomLeft}`);
  await browserBack();
  await until(roomAlone);
  expect(errors).toEqual([]);
}, 40_000);

test.skipIf(!chromeFound)("FULL SCREEN on B: BACK › A, its button saying what a press does; BACK › the office, out of full screen", async () => {
  await openA();
  await click(cardTo(`brief/${ids.B}`));
  await until(at("B"));
  await click(".briefview [data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await click("[data-brief-back]");
  await until(`${at("A")} && document.querySelector(".briefview [data-view-full]").textContent === (document.fullscreenElement === document.querySelector(".briefview") ? "EXIT FULL SCREEN" : "FULL SCREEN")`);
  await click("[data-brief-back]");
  await until(`${office} && !document.fullscreenElement`);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a page from B: A › B › the page › BACK › B › Esc › A › the browser's back › the office", async () => {
  await openA();
  await click(cardTo(`brief/${ids.B}`));
  await until(at("B"));
  await click(cardTo("page/rooms/ope-12/files/plan.html"));
  await until(`location.hash === "#page/rooms/ope-12/files/plan.html" && ${shows(".pageview .pageframe")}`);
  await click("[data-page-back]");
  await until(at("B"));
  await esc();
  await until(at("A"));
  await browserBack();
  await until(office);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("phone: A › tap B's card › BACK › A › BACK › the office; no sideways scroll", async () => {
  await openA(390, 844, true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await click(cardTo(`brief/${ids.B}`));
  await until(at("B"));
  await click("[data-brief-back]");
  await until(at("A"));
  await click("[data-brief-back]");
  await until(`location.hash === "" && document.querySelector(".briefview").hidden`);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  mobile = false;
  expect(errors).toEqual([]);
}, 30_000);
