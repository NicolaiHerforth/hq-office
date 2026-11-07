// <hud-card ref> INSIDE PAGES, walked through as the owner uses them: real mouse, touch and key input (CDP Input) on
// cards drawn in a closed shadow root inside a sandboxed frame (read through CDP's pierced DOM, which a page cannot do),
// every way in and out (BACK, the browser's back, Esc, a reload, full screen, phone width), in a brief's page, an ask's
// page in NEEDS YOU and on the stage, and next to dark mode. A page resolves only what its author wrote: a card its
// script adds is NOT FOUND, and so is one its own publish added. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, did } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-cards-"));
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
  throw new Error(`timed out waiting for ${expr}${await clickLog(ev)}`);
};
const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string | Uint8Array) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=api-auth`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });
async function load(hash: string, w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await page.s("Page.navigate", { url: `${server.base}/?park` });
  await ev(`sessionStorage.clear(); localStorage.clear(); true`).catch(() => {});
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
async function key(k: "Escape") {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: 27 });
}
async function back() {
  await did(ev, "back");
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
}
const shows = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) / 2 + Math.min(r.bottom, innerHeight) / 2); return !!hit && (hit === e || e.contains(hit)); })()`;

// ---- the cards inside a frame, as CDP sees them through closed shadow roots ----
type Node = { nodeId: number; backendNodeId: number; nodeType: number; nodeName: string; nodeValue?: string; attributes?: string[]; children?: Node[]; shadowRoots?: Node[]; contentDocument?: Node };
const attr = (n: Node, name: string) => { const a = n.attributes ?? []; const i = a.indexOf(name); return i >= 0 && i % 2 === 0 ? a[i + 1] : null; };
function* walk(n: Node): Generator<Node> {
  yield n;
  for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) yield* walk(k);
}
const textOf = (n: Node) => [...walk(n)].filter((x) => x.nodeType === 3).map((x) => x.nodeValue ?? "").join(" ").replace(/\s+/g, " ").trim();
// A page's frame runs out of process: its own CDP target, attached once (flattened), with its DOM read there.
const frameSessions = new Map<string, string>();
async function frameTargets(frame: string) {
  const { targetInfos } = await chrome.cdp.send("Target.getTargets");
  const out: { targetId: string; sessionId: string }[] = [];
  const path = (u: string) => { try { return new URL(u).pathname; } catch { return ""; } }; // a frame just made has no address yet
  for (const t of targetInfos.filter((x: any) => x.type === "iframe" && path(x.url) === frame)) {
    if (!frameSessions.has(t.targetId)) {
      const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await chrome.cdp.send("DOM.enable", {}, sessionId);
      frameSessions.set(t.targetId, sessionId);
    }
    out.push({ targetId: t.targetId, sessionId: frameSessions.get(t.targetId)! });
  }
  return out;
}
// Every <hud-card> in the frames showing FRAME (a path): its ref, what it says, its box's class and the box itself.
async function cardsIn(frame: string) {
  const out: { ref: string; text: string; cls: string; box: Node; targetId: string; sessionId: string }[] = [];
  for (const f of await frameTargets(frame)) {
    const res = await chrome.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, f.sessionId).catch(() => null);
    if (!res) continue;
    for (const n of walk(res.root)) {
      if (n.nodeName !== "HUD-CARD") continue;
      const box = (n.shadowRoots?.[0]?.children ?? []).find((c) => c.nodeName === "A" || c.nodeName === "DIV");
      if (box) out.push({ ref: attr(n, "ref") ?? "", text: textOf(box), cls: attr(box, "class") ?? "", box, ...f });
    }
  }
  return out;
}
const cardsReady = async (frame: string, n: number) => {
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(100)) {
    const c = await cardsIn(frame).catch(() => []);
    if (c.length === n && c.every((x) => !/\bwait\b/.test(x.cls))) return c;
  }
  throw new Error(`the cards in ${frame} did not all come: ${JSON.stringify((await cardsIn(frame)).map((c) => [c.ref, c.cls]))}`);
};
// Where a card is on the screen: scrolled into view inside its frame, plus where the frame sits in the HUD. The HUD's
// own hit test at that point must be that frame (nothing of the HUD covers it). The same page can show in two frames
// (an ask's page in its card and on the stage): the one under the point counts.
async function pointAt(frame: string, ref: string) {
  const all = (await cardsIn(frame)).filter((x) => x.ref === ref);
  if (!all.length) throw new Error(`no card ${ref} in ${frame}`);
  for (const c of all) {
    await chrome.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: c.box.backendNodeId }, c.sessionId).catch(() => {});
    const inner = await chrome.cdp.send("DOM.getBoxModel", { backendNodeId: c.box.backendNodeId }, c.sessionId).catch(() => null);
    const owner = await page.s("DOM.getFrameOwner", { frameId: c.targetId }).catch(() => null);
    // An ask's frame takes its page's height a moment after it loads: wait for the frame to hold still.
    let outer: any = null;
    for (let prev = "", end = Date.now() + 3000; owner && Date.now() < end; await Bun.sleep(150)) {
      outer = await page.s("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }).catch(() => null);
      const now = JSON.stringify(outer?.model.content);
      if (now === prev) break;
      prev = now;
    }
    if (!inner || !outer) continue;
    const q = inner.model.border, o = outer.model.content;
    const x = o[0] + (q[0] + q[2]) / 2, y = o[1] + (q[1] + q[5]) / 2;
    const hit = await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e?.tagName === "IFRAME" && new URL(e.src).pathname === ${JSON.stringify(frame)}; })()`);
    if (hit) return [x, y] as const;
  }
  throw new Error(`cannot click ${ref}: no frame ${frame} is under its point`);
}
async function clickCard(frame: string, ref: string) {
  const [x, y] = await pointAt(frame, ref);
  await aimed(ev, `${frame} ${ref}`, x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await aimed(ev, `${frame} ${ref}`, x, y, "pressed");
}
async function tapCard(frame: string, ref: string) {
  const [x, y] = await pointAt(frame, ref);
  await aimed(ev, `${frame} ${ref}`, x, y, "aim");
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await aimed(ev, `${frame} ${ref}`, x, y, "pressed");
}
async function click(sel: string) {
  const [x, y] = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await aimed(ev, sel, x, y, "aim");
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await aimed(ev, sel, x, y, "pressed");
}
async function openedWindow() {
  for (const end = Date.now() + 8000; Date.now() < end && !opened.length; await Bun.sleep(50));
  const t = opened.shift();
  if (!t) throw new Error("no window opened");
  let url = t.url;
  for (const end = Date.now() + 8000; Date.now() < end && (!url || url === "about:blank"); await Bun.sleep(100)) url = (await chrome.cdp.send("Target.getTargetInfo", { targetId: t.targetId })).targetInfo.url;
  return { targetId: t.targetId, url };
}

let brief = 0, open = 0, hidden = 0, ask = 0;
const BRIEF_FRAME = () => `/briefs/${brief}.html`;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "api-auth", title: "Rotate the auth tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  open = (await post("/api/asks", { title: "Ship the pricing page?", body: "It is ready.", lane: "api-auth" })).id;
  hidden = (await post("/api/briefs", { title: "Not for that page", body: "Private plan." }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await upload("ope-12", "chart.png", PNG);
  // The page's own script adds a card its author did not write: it must not resolve.
  const html = `<!doctype html><html><head><title>Status</title></head><body><h1>Status</h1>
<hud-card ref="room/ope-12"></hud-card><hud-card ref="lane/api-auth"></hud-card><hud-card ref="ask/${open}"></hud-card>
<hud-card ref="page/rooms/ope-12/files/chart.png"></hud-card><hud-card ref="floor/crm"></hud-card><hud-card ref="brief/99999"></hud-card>
<div id="late"></div><script>const c = document.createElement("hud-card"); c.setAttribute("ref", "brief/${hidden}"); document.getElementById("late").append(c);</script></body></html>`;
  brief = (await post("/api/briefs", { title: "Status page", body: html }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  ask = (await post("/api/asks", { title: "Approve the rollout?", lane: "api-auth", body: `<!doctype html><title>Rollout</title><p>Where it runs:</p><hud-card ref="room/ope-12"></hud-card><hud-card ref="lane/api-auth"></hud-card>` })).id;
  chrome = await startChrome();
  await chrome.cdp.send("Target.setDiscoverTargets", { discover: true });
  chrome.cdp.listeners.push((m: any) => { if (m.method === "Target.targetCreated" && m.params.targetInfo.type === "page" && m.params.targetInfo.openerId) opened.push(m.params.targetInfo); });
  page = await newSession(chrome.cdp, errors);
  // Web fonts come over the network at their own time and widen the text they replace: a click aimed just before
  // lands beside its target (the tabs move 96 px when Press Start 2P arrives). The walks run without them.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("DOM.enable");
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a brief's page: a card for each reference its author wrote; one gone and one its script added are NOT FOUND", async () => {
  await load(`#brief/${brief}`);
  const cards = await cardsReady(BRIEF_FRAME(), 7);
  expect(cards.map((c) => [c.ref, c.text])).toEqual([
    ["room/ope-12", "ROOM HQ api-auth Auth rotation No messages yet"],
    ["lane/api-auth", "LANE HQ WORKING MANAGER api-auth Rotate the auth tokens"],
    [`ask/${open}`, "QUESTION HQ OPEN api-auth Ship the pricing page? It is ready."],
    ["page/rooms/ope-12/files/chart.png", "IMAGE HQ chart.png On the shelf of Auth rotation"],
    ["floor/crm", "FLOOR 0 OF 0 WORKING CRM HQ: hq-crm"],
    ["brief/99999", "NOT FOUND brief/99999 Gone, or not in this page as its author wrote it."],
    [`brief/${hidden}`, `NOT FOUND brief/${hidden} Gone, or not in this page as its author wrote it.`],
  ]);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a room card in the page › the room beside it › the browser's back › the brief's page with its cards", async () => {
  await clickCard(BRIEF_FRAME(), "room/ope-12");
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")} && ${shows(".briefview .pageframe")}`);
  await back();
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview .pageframe")}`);
  await cardsReady(BRIEF_FRAME(), 7);
}, 30_000);

test.skipIf(!chromeFound)("a click held down while the page's cards are read again still opens the room", async () => {
  const [x, y] = await pointAt(BRIEF_FRAME(), "room/ope-12");
  await ev(`performance.clearResourceTimings(), true`);
  await aimed(ev, "room/ope-12 held", x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await post("/api/updates", { title: "Tokens rotated on staging" });
  await until(`performance.getEntriesByType("resource").some((e) => e.name.includes("/api/refs"))`);
  await Bun.sleep(200);
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await aimed(ev, "room/ope-12 held", x, y, "pressed");
  await until(`location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")}`);
  await back();
  await until(`location.hash === "#brief/${brief}" && ${shows(".briefview .pageframe")}`);
  await cardsReady(BRIEF_FRAME(), 7);
}, 30_000);

test.skipIf(!chromeFound)("a lane card in the page opens the drawer beside it; Esc closes the drawer and the page stays", async () => {
  await clickCard(BRIEF_FRAME(), "lane/api-auth");
  await until(`${shows("#card")} && ${shows(".briefview .pageframe")} && document.querySelector("#card h3").textContent === "api-auth"`);
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
  await key("Escape");
  await until(`document.getElementById("card").hidden && ${shows(".briefview .pageframe")}`);
}, 30_000);

test.skipIf(!chromeFound)("a question answered elsewhere shows ANSWERED on the page's card while it is open", async () => {
  await post(`/api/asks/${open}/answer`, { answer: "yes" });
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(150)) {
    if ((await cardsIn(BRIEF_FRAME())).find((c) => c.ref === `ask/${open}`)?.text.startsWith("QUESTION HQ ANSWERED")) break;
  }
  expect((await cardsIn(BRIEF_FRAME())).find((c) => c.ref === `ask/${open}`)?.text).toBe("QUESTION HQ ANSWERED api-auth Ship the pricing page? You: yes");
}, 30_000);

test.skipIf(!chromeFound)("an image card opens the file in a tab of its own; the HUD stays on the page", async () => {
  opened.length = 0;
  await clickCard(BRIEF_FRAME(), "page/rooms/ope-12/files/chart.png");
  const w = await openedWindow();
  expect(w.url).toBe(`${server.base}/rooms/ope-12/files/chart.png`);
  await chrome.cdp.send("Target.closeTarget", { targetId: w.targetId });
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
}, 30_000);

test.skipIf(!chromeFound)("FULL SCREEN › a lane card leaves full screen and shows the drawer; FULL SCREEN › a room card shows the room", async () => {
  await load(`#brief/${brief}`);
  await cardsReady(BRIEF_FRAME(), 7);
  await click("[data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await clickCard(BRIEF_FRAME(), "lane/api-auth");
  await until(`!document.fullscreenElement && ${shows("#card")}`);
  await key("Escape");
  // the label says FULL SCREEN again once the browser has left it; until then the bar is laid out for EXIT FULL SCREEN
  await until(`document.getElementById("card").hidden && document.querySelector("[data-view-full]").textContent === "FULL SCREEN"`);
  await click("[data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".briefview")`);
  await clickCard(BRIEF_FRAME(), "room/ope-12");
  await until(`!document.fullscreenElement && location.hash === "#room/ope-12+brief/${brief}" && ${shows("#roomView")}`);
}, 30_000);

test.skipIf(!chromeFound)("a reload keeps the cards; dark mode from MENU turns them dark inside the page", async () => {
  await load(`#brief/${brief}`);
  await cardsReady(BRIEF_FRAME(), 7);
  await page.s("Page.reload");
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await cardsReady(BRIEF_FRAME(), 7);
  expect((await cardsIn(BRIEF_FRAME())).some((c) => /\bdark\b/.test(c.cls))).toBe(false);
  await click("#menuBtn");
  await click('.mseg [data-set-theme="dark"]');
  for (const end = Date.now() + 8000; Date.now() < end && !(await cardsIn(BRIEF_FRAME())).every((c) => /\bdark\b/.test(c.cls)); await Bun.sleep(100));
  expect((await cardsIn(BRIEF_FRAME())).every((c) => /\bdark\b/.test(c.cls))).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("an ask's page in NEEDS YOU has its cards; its room card opens the room; on the stage in full screen a lane card shows the drawer", async () => {
  await load("");
  const frame = `/asks/${ask}.html`;
  await cardsReady(frame, 2);
  await clickCard(frame, "room/ope-12");
  await until(`location.hash === "#room/ope-12" && ${shows("#roomView")}`);
  await load(`#page/asks/${ask}`);
  await until(shows(".pageview .pageframe"));
  await click(".pvbar [data-view-full]");
  await until(`document.fullscreenElement === document.querySelector(".pageview")`);
  for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(100)) {
    const c = await cardsIn(frame).catch(() => []);
    if (c.length >= 2 && c.every((x) => !/\bwait\b/.test(x.cls))) break;
  }
  await clickCard(frame, "lane/api-auth");
  await until(`!document.fullscreenElement && ${shows("#card")}`);
}, 40_000);

test.skipIf(!chromeFound)("phone: a lane card in the page gives the drawer's sheet; ✕ closes it; the page is still there", async () => {
  await load(`#brief/${brief}`, 390, 844, true);
  await cardsReady(BRIEF_FRAME(), 7);
  await tapCard(BRIEF_FRAME(), "lane/api-auth");
  await until(`${shows("#card")} && document.querySelector("#card h3").textContent === "api-auth"`);
  // The sheet slides up: tap its ✕ once it holds still.
  let at = null as { x: number; y: number } | null;
  for (let prev = "", end = Date.now() + 3000; Date.now() < end; await Bun.sleep(120)) {
    at = await ev(`(() => { const r = document.querySelector("[data-card-close]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (JSON.stringify(at) === prev) break;
    prev = JSON.stringify(at);
  }
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until(`document.getElementById("card").hidden && ${shows(".briefview .pageframe")}`);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await until(`!history.state?.hqSheet`); // the closed sheet's Back entry has gone, so the next test's navigation lands
}, 30_000);

test.skipIf(!chromeFound)("the page opened on its own, outside the HUD: each card says to open it in the HUD, and nothing fails", async () => {
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  errors.length = 0;
  await page.s("Page.navigate", { url: `${server.base}/briefs/${brief}.html` });
  for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(100)) {
    const { root } = await page.s("DOM.getDocument", { depth: -1, pierce: true });
    if ([...walk(root)].filter((n) => n.nodeName === "HUD-CARD").length === 7) break;
  }
  const { root } = await page.s("DOM.getDocument", { depth: -1, pierce: true });
  const texts = [...walk(root)].filter((n) => n.nodeName === "HUD-CARD").map((n) => textOf(n.shadowRoots![0].children!.find((c) => c.nodeName === "DIV")!));
  expect(texts[0]).toBe("HQ room/ope-12 Open this page in the HUD to see this card.");
  expect(texts.length).toBe(7);
  expect(errors).toEqual([]);
}, 30_000);
