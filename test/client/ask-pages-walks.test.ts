// ASK PAGES, walked through as the owner does it, with real input (CDP mouse, keys and touch): every way onto the
// stage and off it (OPEN PAGE, BACK, the browser's back, Esc, reload, FULL SCREEN, a phone's strip), and next to the
// features around it (a brief page with COMMENTS, MESSAGES, dark mode, floors). After each way out the card must be
// whole again (its frame and its answer row) and must answer a real click. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-ask-walks-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
const PAGE = (h1: string) => `<title>${h1}</title><style>:root{color-scheme:light dark}body{font:14px sans-serif;margin:8px}</style><h1>${h1}</h1><p>A table would be here.</p>`;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const state = () => fetch(`${server.base}/api/state`).then((r) => r.json());
const shot = async (name: string) => {
  if (!process.env.ASK_SHOTS) return;
  const { data } = await page.s("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(process.env.ASK_SHOTS, `walk-${name}.png`), Buffer.from(data, "base64"));
};

// ---- real input ----
async function centre(sel: string) {
  // in the middle of its list, and only if it is what the pointer would hit (not under the MORE OUT OF VIEW pill)
  const r = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (el === hit || el.contains(hit)), hit: hit?.outerHTML.slice(0, 120) }; })()`);
  if (!r) throw new Error(`nothing to click: ${sel}`);
  if (!r.ok) throw new Error(`${sel} is covered by ${r.hit}`);
  return r;
}
async function click(sel: string) {
  const { x, y } = await centre(sel);
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function tap(sel: string) {
  const { x, y } = await centre(sel);
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const KEYS: Record<string, number> = { Escape: 27, Enter: 13 };
async function key(k: string, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: KEYS[k], modifiers });
}
const type = (text: string) => page.s("Input.insertText", { text });
async function browserBack() {
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
}

async function load(w = 1440, h = 900, mobile = false, hash = "") {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/` });
  // a walk starts in the building with NEEDS YOU open, whatever floor or tab the one before left
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`sessionStorage.clear(), true`);
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.querySelector("#hud .ask") && !!document.getElementById("lastNote")?.innerHTML`);
  if (!hash) {
    await click(`[data-qtab="questions"]`);
    await until(`!document.getElementById("hud").hidden`);
  }
}
const card = (id: number) => `#hud [data-ask="${id}"]`;
// The card is whole: its page in a frame (or the strip on a phone), its answer row, nothing about the stage; and a
// real click on an option picks it, so the page is not frozen under anything.
async function cardWhole(id: number, opt: string | null, strip = false) {
  await until(`(() => { const c = document.querySelector('${card(id)}'); return !!c && !c.querySelector(".onstage") && !!c.querySelector(".send") && !!c.querySelector(${JSON.stringify(strip ? ".askstrip" : "iframe.askframe")}); })()`);
  expect(await ev(`document.querySelector(".pageview").hidden && !document.fullscreenElement`)).toBe(true);
  // a new frame starts at the cap and takes the page's height once the page says it: click after that, as the owner would
  if (!strip) await until(`!!document.querySelector('${card(id)} iframe.askframe').style.getPropertyValue("--fh")`);
  if (!opt) return;
  const sel = `${card(id)} .opt[data-opt="${opt}"]`;
  const was = await ev(`document.querySelector('${sel}').classList.contains("sel")`);
  await click(sel);
  await until(`document.querySelector('${sel}').classList.contains("sel") === ${!was}`);
  await click(sel);
  await until(`document.querySelector('${sel}').classList.contains("sel") === ${was}`);
}
// On the stage: the page's frame, the answer row docked under it, no COMMENTS for an ask.
async function onStage(id: number) {
  await until(`location.hash === "#page/asks/${id}" && !document.querySelector(".pageview").hidden && !!document.querySelector('.askdock [data-ask="${id}"] .send')`);
  expect(await ev(`(() => { const v = document.querySelector(".pageview"); return { frame: v.querySelector("iframe.pageframe")?.getAttribute("src")?.split("?")[0], comments: !!v.querySelector("[data-comments-toggle], .cmount"), staged: !!document.querySelector('${card(id)} .onstage') }; })()`)).toEqual({ frame: `/asks/${id}.html`, comments: false, staged: true });
}
let A = 0, B = 0, D = 0, brief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  await post("/api/asks", { title: "A plain question", options: ["Yes", "No"], created_at: Date.now() - 4000 });
  A = (await post("/api/asks", { title: "Which rows go?", options: ["Delete them", "Keep them"], recommended: "Delete them", file: PAGE("Rows"), created_at: Date.now() - 3000 })).id;
  B = (await post("/api/asks", { title: "Record the demo", kind: "action", file: PAGE("Demo chart"), created_at: Date.now() - 2000 })).id;
  brief = (await post("/api/briefs", { title: "A brief page", body: "<!doctype html><html><body><h1>Brief page</h1></body></html>" }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/sync");
  D = (await post("/api/asks", { title: "CRM: which stage?", options: ["Lead", "Won"], file: PAGE("Pipeline") }, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a card's frame takes its page's height in one step, so nothing moves twice under the pointer", async () => {
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `window.__fh = {}; new MutationObserver((ms) => { for (const m of ms) if (m.target.matches?.("iframe.askframe")) (window.__fh[m.target.dataset.src.split("?")[0]] ??= []).push(m.target.style.getPropertyValue("--fh")); }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] })` });
  await load();
  // a frame out of view is not laid out until it scrolls in (the browser's own throttling), as the owner scrolls to it
  for (const id of [A, B, D]) {
    await ev(`document.querySelector('${card(id)}').scrollIntoView({ block: "center" }), true`);
    await until(`!!document.querySelector('${card(id)} iframe.askframe').style.getPropertyValue("--fh")`);
  }
  await Bun.sleep(500);
  const steps = await ev(`Object.fromEntries(Object.entries(window.__fh).map(([src, hs]) => [src, [...new Set(hs)]]))`);
  // every page frame on the list (A, B and the CRM floor's D) took one height, a real one
  expect(Object.keys(steps).sort()).toEqual([`/asks/${A}.html`, `/asks/${B}.html`, `/asks/${D}.html`].sort());
  for (const hs of Object.values(steps) as string[][]) {
    expect(hs).toHaveLength(1);
    expect(parseInt(hs[0])).toBeGreaterThanOrEqual(60);
  }
}, 30_000);

test.skipIf(!chromeFound)("OPEN PAGE then BACK: the card is whole again and answers a click", async () => {
  await load();
  await cardWhole(A, "Keep them");
  await click(`${card(A)} .tag.pageopen`);
  await onStage(A);
  await click("[data-page-back]");
  await cardWhole(A, "Keep them");
  expect(await ev(`location.hash`)).toBe("");
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("OPEN PAGE then the browser's back, and forward again", async () => {
  await load();
  await click(`${card(A)} .tag.pageopen`);
  await onStage(A);
  await browserBack();
  await cardWhole(A, "Keep them");
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex + 1].id });
  await onStage(A);
  await click("[data-page-back]");
  await cardWhole(A, null);
}, 30_000);

test.skipIf(!chromeFound)("OPEN PAGE then Esc", async () => {
  await load();
  await click(`${card(A)} .tag.pageopen`);
  await onStage(A);
  await key("Escape");
  await cardWhole(A, "Keep them");
}, 30_000);

test.skipIf(!chromeFound)("on the stage, reload: still there with its answer row, which works; then BACK", async () => {
  await load(1440, 900, false, `#page/asks/${A}`);
  await onStage(A);
  await click(`.askdock .opt[data-opt="Keep them"]`);
  await until(`document.querySelector('.askdock .opt[data-opt="Keep them"]').classList.contains("sel")`);
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await onStage(A);
  // the pick is a draft: it survives the reload as a typed answer does
  expect(await ev(`document.querySelector('.askdock .opt[data-opt="Keep them"]').classList.contains("sel")`)).toBe(true);
  await click("[data-page-back]");
  await cardWhole(A, null);
  expect(await ev(`document.querySelector('${card(A)} .opt[data-opt="Keep them"]').classList.contains("sel")`)).toBe(true);
  await click(`${card(A)} .opt[data-opt="Keep them"]`);
}, 30_000);

test.skipIf(!chromeFound)("FULL SCREEN keeps the answer row on screen; BACK and Esc both leave full screen and the page", async () => {
  for (const out of ["back", "esc"]) {
    await load();
    await click(`${card(A)} .tag.pageopen`);
    await onStage(A);
    await click("[data-view-full]");
    await until(`document.fullscreenElement === document.querySelector(".pageview")`);
    const sendIn = await ev(`(() => { const r = document.querySelector(".askdock .send").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".send") !== null; })()`);
    expect(sendIn).toBe(true);
    await shot(`fullscreen-${out}`);
    if (out === "back") await click("[data-page-back]");
    else await key("Escape");
    await until(`!document.fullscreenElement`);
    // Esc in full screen may only leave full screen (as a browser does); a second Esc leaves the page
    if (out === "esc" && !(await ev(`document.querySelector(".pageview").hidden`))) await key("Escape");
    await cardWhole(A, "Keep them");
  }
}, 40_000);

test.skipIf(!chromeFound)("answering on the stage with clicks and keys: typed detail, Cmd+Enter, ANSWERED, then BACK; MESSAGES opens it again", async () => {
  await load();
  await click(`${card(B)} .tag.pageopen`);
  await onStage(B);
  await click(".askdock textarea");
  await type("recorded, link in the room");
  // a new ask arriving while typing: the text and the focus stay
  const extra = (await post("/api/asks", { title: "Arrived while typing", options: ["Ok"] })).id;
  await until(`!!document.querySelector('${card(extra)}')`);
  expect(await ev(`document.activeElement === document.querySelector(".askdock textarea") && document.activeElement.value`)).toBe("recorded, link in the room");
  await key("Enter", 4); // Cmd+Enter (meta)
  await until(`!!document.querySelector(".askdock .dockdone")`);
  expect(await ev(`document.querySelector(".askdock .dockdone").textContent`)).toContain("recorded, link in the room");
  expect((await state()).answered.find((a: any) => a.id === B).answer).toBe("recorded, link in the room");
  await click("[data-page-back]");
  await until(`document.querySelector(".pageview").hidden && !document.querySelector('${card(B)}')`);
  await click(`[data-qtab="messages"]`);
  await click(`#msgs [data-msg="a${B}"] a[href="#page/asks/${B}"]`);
  await until(`location.hash === "#page/asks/${B}" && !!document.querySelector(".askdock .dockdone")`);
  await click("[data-page-back]");
  await until(`document.querySelector(".pageview").hidden`);
  await click(`[data-qtab="questions"]`);
  await post(`/api/asks/${extra}/answer`, { answer: "Ok" });
}, 30_000);

test.skipIf(!chromeFound)("next to a brief page with COMMENTS open: an ask's page replaces it with its answer row, BACK leaves", async () => {
  await load(1440, 900, false, `#page/briefs/${brief}`);
  await until(`!document.querySelector(".pageview").hidden && !!document.querySelector("[data-comments-toggle]")`);
  await click("[data-comments-toggle]");
  await click(`${card(A)} .tag.pageopen`);
  await onStage(A);
  await click("[data-page-back]");
  // BACK leaves to where the pages were entered from: the office
  await cardWhole(A, "Keep them");
  // OPEN IN NEW TAB serves the same page on its own
  const r = await fetch(`${server.base}/asks/${A}.html`);
  expect(r.status).toBe(200);
  expect(await r.text()).toContain("<h1>Rows</h1>");
}, 30_000);

test.skipIf(!chromeFound)("dark mode: the frame asks for the dark theme, the strip and the dock are dark, and both follow a switch", async () => {
  await load();
  await click("#menuBtn");
  await click(`#menuDrop [data-set-theme="dark"]`);
  await until(`document.documentElement.dataset.theme === "dark"`);
  await key("Escape");
  await until(`document.querySelector('${card(A)} iframe.askframe').getAttribute("src").endsWith("theme=dark")`);
  const lum = (sel: string) => ev(`(() => { const m = getComputedStyle(document.querySelector('${sel}')).backgroundColor.match(/[\\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; })()`);
  expect(await lum(card(A))).toBeLessThan(0.3);
  await click(`${card(A)} .tag.pageopen`);
  await onStage(A);
  expect(await lum(".askdock")).toBeLessThan(0.3);
  expect(await ev(`document.querySelector(".pageview iframe.pageframe").getAttribute("src")`)).toContain("theme=dark");
  expect(await lum(`${card(A)} .askstrip`)).toBeLessThan(0.3);
  await shot("dark-stage");
  await click("[data-page-back]");
  await cardWhole(A, "Keep them");
  await click("#menuBtn");
  await click(`#menuDrop [data-set-theme="system"]`);
  await key("Escape");
}, 30_000);

test.skipIf(!chromeFound)("floors: inside the CRM floor its page ask opens and answers there; BACK keeps the floor", async () => {
  await load();
  await click(`[data-floor-go="crm"], [data-floor-tab="crm"]`);
  await until(`!!document.querySelector('${card(D)}') && !document.querySelector('${card(A)}')`);
  const floor = `JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor`;
  expect(await ev(floor)).toBe("crm");
  await cardWhole(D, "Won");
  await click(`${card(D)} .tag.pageopen`);
  await onStage(D);
  await click("[data-page-back]");
  await cardWhole(D, "Won");
  expect(await ev(floor)).toBe("crm");
}, 30_000);

test.skipIf(!chromeFound)("a phone: tap the strip, the page fills the screen with DONE and NOT YET in reach, BACK returns to the card", async () => {
  await load(390, 844, true);
  await click(`[data-qtab="questions"]`);
  await cardWhole(A, null, true);
  await tap(`${card(A)} .askstrip`);
  await onStage(A);
  const v = await ev(`(() => { const s = document.querySelector(".askdock .send").getBoundingClientRect(), f = document.querySelector(".pageview iframe").getBoundingClientRect(); return { sendIn: s.top >= 0 && s.bottom <= innerHeight, frame: f.height > 150, wide: f.width > 340 }; })()`);
  expect(v).toEqual({ sendIn: true, frame: true, wide: true });
  await shot("phone-stage");
  await tap("[data-page-back]");
  await cardWhole(A, null, true);
  const was = await ev(`document.querySelector('${card(A)} .opt[data-opt="Keep them"]').classList.contains("sel")`);
  await tap(`${card(A)} .opt[data-opt="Keep them"]`);
  await until(`document.querySelector('${card(A)} .opt[data-opt="Keep them"]').classList.contains("sel") === ${!was}`);
  expect(errors).toEqual([]);
}, 30_000);
