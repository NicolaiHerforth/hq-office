// THE PAGE RUNTIME walked like a user: real mouse and keyboard input through CDP (Input.dispatch*), every way into
// and out of a page, and the features beside it. Each check reads the real value inside the page's frame (an
// isolated world, or the frame's own target) or the HUD, never what the page says about itself. The walks:
//   brief view: BRIEFS row in, a vote (db, onSnapshot), storage across loads; COMMENTS and a drag-selection's COMMENT
//   in the frame; FULL SCREEN then BACK, Esc or the browser's back; the browser's back and forward; reload; NEW WINDOW (a
//   second view of the page, live); dark mode from MENU; a brief on another floor, and lanes reading it back.
//   room page on the stage: Esc and BACK; publish with a second tab open; at phone width, SAVE and ALLOW bars and
//   COMMENT in the sheet. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, type newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, did, settled as stillAt } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-walk-"));
const DOWNLOADS = join(dir, "downloads");
mkdirSync(DOWNLOADS, { recursive: true });
const herdr = fakeHerdr(dir, [
  { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" },
  { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" },
  { name: "ops-hq", agent_status: "idle", pane_id: "w1:p3", agent: "claude" },
]);
const MODEL = join(dir, "model.sh");
writeFileSync(MODEL, `#!/bin/sh\np=$(cat)\nprintf 'answer to %s' "$p"\n`);

// An artifact-style page: votes in db (live), visits in localStorage, a file to save, a model to ask.
const WALK = `<!doctype html><html><head><title>Walk</title></head><body>
<h1>Walk</h1><p id="quote">Tier two costs forty a month.</p>
<p><button id="vote">Vote</button> <span id="votes">no votes</span> <span id="visits"></span></p>
<p><button id="save">Save</button> <span id="saved"></span> <button id="ask">Ask</button> <span id="answer"></span></p>
<script>
const visits = Number(localStorage.getItem("visits") || 0) + 1;
localStorage.setItem("visits", String(visits));
document.getElementById("visits").textContent = "visit " + visits;
(async () => {
  const db = await claude.use("db"), dl = await claude.use("downloads"), sample = await claude.use("sample");
  document.body.dataset.runtime = db ? "on" : "off";
  if (!db) return;
  db.collection("votes").onSnapshot((s) => { document.getElementById("votes").textContent = s.size + " votes"; });
  document.getElementById("vote").onclick = () => { document.body.dataset.vote = "pending"; db.collection("votes").add({ at: Date.now() }).then(() => { document.body.dataset.vote = "ok"; }, (e) => { document.body.dataset.vote = "refused " + e.code; }); };
  document.getElementById("save").onclick = () => dl.save({ filename: "walk.txt", data: "walked" }).then((r) => r.status, (e) => e.code).then((t) => { document.getElementById("saved").textContent = t; });
  document.getElementById("ask").onclick = () => sample("hi").then((r) => r.text, (e) => e.code).then((t) => { document.getElementById("answer").textContent = t; });
})();
</script></body></html>`;
// A page that is its own record: its button publishes it with the count one higher.
const POLL = `<!doctype html><html><head><title>Poll</title></head><body><p id="n">0</p><button id="more">More</button><script>
const SRC = document.currentScript.textContent;
document.getElementById("more").onclick = async () => {
  const a = await claude.use("artifact"), n = Number(document.getElementById("n").textContent) + 1;
  a.publish('<!doctype html><html><head><title>Poll</title></head><body><p id="n">' + n + '</p><button id="more">More</button><script>' + SRC + '<\\/script></body></html>').catch((e) => { document.body.dataset.refused = e.code; });
};
</script></body></html>`;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
const server_ = () => server;
let page: Session;
const errors: string[] = [];
const frames = new Map<string, { session: string; tab: string }>(); // an attached frame target: its session, and its tab's
const frameTab = new Map<string, string>(); // an attached frame's session: its tab's
const frameEvents: { tab: string; text: string }[] = []; // what the frames' targets printed
let brief = 0, opsBrief = 0;
const ev = (e: string, p = page) => p.evaluate(e);
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const upload = (name: string, body: string) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name, title: name, as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body }).then((r) => r.json());
const hud = (args: string[], pane: string) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdout: "pipe", stderr: "pipe" });
async function until(what: () => Promise<unknown>, label: string, ms = 10_000, p?: Session) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(60)) if (await what().catch(() => false)) return;
  throw new Error(`timed out: ${label}${p ? await clickLog((e) => ev(e, p)) + await frameLog(p) : ""}`);
}
const untilHud = (expr: string, ms?: number, p = page) => until(() => ev(expr, p), expr, ms, p);

// ---- input, as a person gives it ----
type Session = Awaited<ReturnType<typeof newSession>> & { id: string };
// Input goes to the tab in front, as a person's does: the tab that gets it is brought there first.
let front: Session | null = null;
async function toFront(p: Session) {
  if (front === p) return;
  await p.s("Page.bringToFront");
  front = p;
}
async function clickAt([x, y]: number[], p: Session = page, what = "a point") {
  await toFront(p);
  await aimed((e) => ev(e, p), what, x, y, "aim");
  await p.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await p.s("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await aimed((e) => ev(e, p), what, x, y, "pressed");
}
async function click(selector: string, p: Session = page) {
  await untilHud(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`, 10_000, p);
  await stillAt((e) => ev(e, p), selector);
  const xy = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`, p);
  await clickAt(xy, p, selector);
}
async function key(k: string, p: Session = page) {
  await toFront(p);
  const code = k === "Escape" ? { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } : { key: k };
  await p.s("Input.dispatchKeyEvent", { type: "keyDown", ...code });
  await p.s("Input.dispatchKeyEvent", { type: "keyUp", ...code });
}
async function browserBack(dir = -1, p: Session = page) {
  await did((e) => ev(e, p), dir < 0 ? "back" : "forward");
  const h = await p.s("Page.getNavigationHistory");
  await p.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex + dir].id });
}

// ---- the page's frame ----
const FRAME = `[...document.querySelectorAll("iframe.pageframe")].find((f) => f.getBoundingClientRect().width > 0)`;
async function inFrame(expression: string, p: Session = page) {
  const src = await ev(`${FRAME}?.src ?? ""`, p);
  if (!src) throw new Error("no page frame on screen");
  const path = new URL(src).pathname;
  // the frame of this tab: two tabs showing one page have frames at the same address
  const t = (await chrome.cdp.send("Target.getTargets")).targetInfos.find((t: any) => t.type === "iframe" && t.url.includes(path) && frames.get(t.targetId)?.tab === p.id);
  let r: any;
  if (t) r = await chrome.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, frames.get(t.targetId)!.session);
  else {
    const find = (n: any): any => (n.frame.url.includes(path) ? n.frame : (n.childFrames ?? []).map(find).find(Boolean));
    const f = find((await p.s("Page.getFrameTree")).frameTree);
    if (!f) throw new Error(`the frame of ${path} is not loaded`);
    const { executionContextId } = await p.s("Page.createIsolatedWorld", { frameId: f.id, worldName: "walk" });
    r = await p.s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId: executionContextId });
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const untilFrame = (expr: string, ms?: number, p: Session = page) => until(() => inFrame(expr, p), `in the frame: ${expr}`, ms, p);
const text = (id: string, p: Session = page) => inFrame(`document.getElementById(${JSON.stringify(id)})?.textContent ?? ""`, p);
// The frame has stopped moving: the same place for 4 checks 50 ms apart. Input sent while it is still being laid
// out can reach the HUD instead of the frame, which no hand is quick enough to do.
// The same log inside the page's frame (its clicks, its messages, its errors), and what its target printed.
const inFrameOf = (p: Session) => (e: string) => inFrame(e, p);
async function frameLog(p: Session) {
  const own = await clickLog(inFrameOf(p), "in the page's frame").catch(() => "");
  const said = frameEvents.filter((x) => x.tab === p.id).slice(-12);
  return own + (said.length ? `\nthe page's frame printed:\n${said.map((x) => `  ${x.text}`).join("\n")}` : "");
}
async function settled(p: Session) {
  let last = "", same = 0;
  for (const end = Date.now() + 5000; Date.now() < end && same < 4; await Bun.sleep(50)) {
    const now = JSON.stringify(await ev(`(() => { const r = (${FRAME})?.getBoundingClientRect(); return r && [r.left, r.top, r.width, r.height]; })()`, p));
    same = now === last ? same + 1 : 0;
    last = now;
  }
}
// A point inside the frame, on the HUD's page.
async function framePoint([x, y]: number[], p: Session = page) {
  await settled(p);
  const [fx, fy] = await ev(`(() => { const f = ${FRAME}; const r = f.getBoundingClientRect(); return [r.left + f.clientLeft, r.top + f.clientTop]; })()`, p);
  return [fx + x, fy + y];
}
// What a failed step saw: the frame's document (its start time) then and now, and its address.
async function diagnose(p: Session, t0: number, e: Error) {
  const now = await inFrame(`[performance.timeOrigin, location.pathname + location.search, document.readyState, "clicks " + document.documentElement.dataset.walkClicks + " on " + document.documentElement.dataset.walkLast, "focus " + document.hasFocus(), "vote " + document.body.dataset.vote]`, p).catch((x) => String(x));
  const key = await ev(`new URL((${FRAME}).src).pathname.replace(/^\\//, "").replace(/\\.html$/, "")`, p).catch(() => "");
  const server = await fetch(`${server_().base}/api/page-runtime/data?page=${encodeURIComponent(key)}&path=votes`).then((r) => r.json()).then((d) => d.docs?.length, () => "?");
  return new Error(`${e.message}; last click ${JSON.stringify(lastClick)}; votes on the server ${server}; frame then ${t0}, now ${JSON.stringify(now)}; frames on screen ${await ev(`[...document.querySelectorAll("iframe.pageframe")].map((f) => f.getAttribute("src") + ":" + Math.round(f.getBoundingClientRect().width)).join(" ")`, p)}`);
}
let lastClick: unknown = null;
async function clickInFrame(id: string, p: Session = page) {
  const xy = await inFrame(`(() => { const b = document.getElementById(${JSON.stringify(id)}); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`, p);
  const at = await framePoint(xy, p);
  await aimed(inFrameOf(p), `#${id}`, xy[0], xy[1], "aim");
  await inFrame(`(() => { const d = document.documentElement; if (!d.dataset.walkClicks) { d.dataset.walkClicks = "0"; document.addEventListener("click", (e) => { d.dataset.walkClicks = String(Number(d.dataset.walkClicks) + 1); d.dataset.walkLast = e.target.id || e.target.tagName; }, true); } })()`, p);
  lastClick = { id, inFrame: xy, onHud: at, hudHit: await ev(`(() => { const e = document.elementFromPoint(${at[0]}, ${at[1]}); return e ? e.tagName + "." + e.className : null; })()`, p), frameHit: await inFrame(`document.elementFromPoint(${xy[0]}, ${xy[1]})?.id ?? null`, p) };
  // Headless Chrome now and then drops synthetic input to a page's frame just after a layout or a tab switch: the
  // page's own count shows no click arrived at all. Only then the click is given again, and counted.
  // (a click that made the page load anew, as publish does, arrived)
  const clicks = () => inFrame(`[performance.timeOrigin, Number(document.documentElement.dataset.walkClicks || 0)]`, p);
  const [t0, was] = await clicks();
  for (let tries = 0; ; tries++) {
    await clickAt(at, p, `#${id} in the frame`);
    await aimed(inFrameOf(p), `#${id}`, xy[0], xy[1], "pressed");
    const got = await until(async () => { const [t, n] = await clicks(); return t !== t0 || n > was; }, "a click", 1000).then(() => true, () => false);
    if (got) return;
    if (tries === 2) throw new Error(`three clicks on ${id} never reached the page`);
    dropped++;
    await Bun.sleep(300);
  }
}
let dropped = 0;
// Selects an element's text with the mouse, then presses the COMMENT that shows above the selection.
async function selectAndComment(id: string, p: Session = page) {
  const [a, b] = await inFrame(`(() => { const t = document.getElementById(${JSON.stringify(id)}).firstChild, r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1); const s = r.getBoundingClientRect(); r.setStart(t, t.length - 1); r.setEnd(t, t.length); const e = r.getBoundingClientRect(); return [[s.left + 1, s.top + s.height / 2], [e.right - 1, e.top + e.height / 2]]; })()`, p);
  const [sx, sy] = await framePoint(a, p), [ex, ey] = await framePoint(b, p);
  await toFront(p);
  await p.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy });
  await p.s("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await p.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + ((ex - sx) * i) / 5, y: sy + ((ey - sy) * i) / 5, button: "left", buttons: 1 });
  await p.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: ey, button: "left", buttons: 0, clickCount: 1 });
  await untilFrame(`getSelection().toString().trim().length > 0 && document.querySelector("hud-comment-pick")?.style.display === ""`);
  // COMMENT sits centred 8 px above the selection (runtime.js pickShow)
  const r = await inFrame(`(() => { const r = getSelection().getRangeAt(0).getBoundingClientRect(); return [r.left + r.width / 2, r.top - 24]; })()`, p);
  await aimed(inFrameOf(p), "COMMENT", r[0], r[1], "aim");
  await clickAt(await framePoint(r, p), p, "COMMENT in the frame");
  await aimed(inFrameOf(p), "COMMENT", r[0], r[1], "pressed");
}
// On, and its first snapshot shown: the count, not the page's starting "no votes".
const runtimeOn = (p: Session = page) => untilFrame(`document.body.dataset.runtime === "on" && /^\\d+ votes$/.test(document.getElementById("votes").textContent)`, 15_000, p);
async function vote(p: Session = page) {
  const before = parseInt(await text("votes", p)) || 0;
  const t0 = await inFrame(`performance.timeOrigin`, p);
  await clickInFrame("vote", p);
  await untilFrame(`parseInt(document.getElementById("votes").textContent) === ${before + 1}`, 10_000, p).catch(async (e) => { throw await diagnose(p, t0, e); });
  return before + 1;
}

async function open(hash: string, w = 1440, h = 900, mobile = false, p: Session = page) {
  await p.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await p.s("Page.navigate", { url: "about:blank" });
  await p.s("Page.navigate", { url: `${server.base}/${hash}` });
  await untilHud(`!!document.getElementById("lastNote")?.innerHTML`, 15_000, p);
}
// A tab of its own, as newSession makes one, that also knows its session id (its frames are found by it).
async function session(targetId?: string): Promise<Session> {
  targetId ??= (await chrome.cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => chrome.cdp.send(m, p, sessionId);
  chrome.cdp.listeners.push((m: any) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
  });
  for (const d of ["Page", "Runtime", "Network"]) await s(`${d}.enable`);
  // Web fonts come over the network at their own time and widen the text they replace: a click aimed just before
  // lands beside its target. The walks run without them.
  await s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  await s("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const evaluate = async (expression: string) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { s, evaluate, id: sessionId };
}

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Tester", HUD_SAMPLE_CMD: `sh ${MODEL}` } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await upload("walk.html", WALK);
  await upload("poll.html", POLL);
  brief = (await post("/api/briefs", { title: "Walk", body: WALK }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  expect(hud(["floor", "add", "ops", "--hq", "ops-hq", "--name", "Ops"], "w1:p1").exitCode).toBe(0);
  await post("/api/sync");
  opsBrief = (await post("/api/briefs", { title: "Ops walk", body: WALK }, { "x-hud-pane": "w1:p3", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  chrome.cdp.listeners.push((m: any) => {
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
      frames.set(m.params.targetInfo.targetId, { session: m.params.sessionId, tab: m.sessionId });
      frameTab.set(m.params.sessionId, m.sessionId);
      chrome.cdp.send("Runtime.enable", {}, m.params.sessionId).catch(() => {});
    }
    const tab = frameTab.get(m.sessionId);
    if (!tab) return;
    const at = new Date().toISOString().slice(11, 23);
    if (m.method === "Runtime.exceptionThrown") frameEvents.push({ tab, text: `${at} exception ${String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200)}` });
    if (m.method === "Runtime.consoleAPICalled") frameEvents.push({ tab, text: `${at} console.${m.params.type} ${m.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 200)}` });
    if (frameEvents.length > 200) frameEvents.shift();
  });
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });
  page = await session();
}, 60_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("brief view: in from BRIEFS, a vote, COMMENTS and COMMENT on a dragged selection", async () => {
  await open("");
  await click('[data-qtab="briefs"]');
  await click(`#briefs a.brow[href="#brief/${brief}"]`);
  await untilHud(`location.hash === "#brief/${brief}"`);
  await runtimeOn();
  expect(await text("visits")).toBe("visit 1");
  expect(await vote()).toBe(1);
  await click(`[data-comments-toggle="briefs/${brief}"]`);
  await selectAndComment("quote");
  await untilHud(`document.querySelector('aside.cmount[data-comments="briefs/${brief}"]')?.textContent.includes("Tier two costs forty a month.")`);
}, 90_000);

// The page says it is on before its first snapshot arrives: a walk that reads the count then counts from "no votes".
test.skipIf(!chromeFound)("a slow first snapshot: the walk reads the count only once the page shows it", async () => {
  const held = (m: any) => {
    if (m.sessionId !== page.id || m.method !== "Fetch.requestPaused") return;
    const go = () => page.s("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => {});
    if (String(m.params.request.postData).includes('"op":"query"')) setTimeout(go, 1500);
    else go();
  };
  chrome.cdp.listeners.push(held);
  await page.s("Fetch.enable", { patterns: [{ urlPattern: "*/api/page-runtime/db*" }] });
  try {
    await open(`#brief/${brief}`);
    await runtimeOn();
    expect(await text("votes")).toBe("1 votes");
  } finally {
    await page.s("Fetch.disable");
    chrome.cdp.listeners.splice(chrome.cdp.listeners.indexOf(held), 1);
  }
}, 60_000);

test.skipIf(!chromeFound)("brief view: FULL SCREEN then BACK, then Esc, then the browser's back; the HUD answers and the page works after each", async () => {
  await open(`#brief/${brief}`);
  await runtimeOn();
  await click(".briefview [data-view-full]");
  await untilHud(`document.fullscreenElement === document.querySelector(".briefview")`);
  await click(".briefview [data-brief-back]");
  await untilHud(`!document.fullscreenElement && location.hash === ""`).catch(async (e) => { throw new Error(`${e.message}; now: ${JSON.stringify(await ev(`({ full: document.fullscreenElement?.className ?? null, hidden: document.querySelector(".briefview").hidden, hash: location.hash })`))}`); });
  await click('[data-qtab="briefs"]');
  await click(`#briefs a.brow[href="#brief/${brief}"]`);
  await runtimeOn();
  await vote();
  // Esc leaves full screen and the brief together (a browser that keeps Esc for itself only leaves full screen)
  await click(".briefview [data-view-full]");
  await untilHud(`!!document.fullscreenElement`);
  await key("Escape");
  await untilHud(`!document.fullscreenElement && document.querySelector(".briefview").hidden`);
  await click(`#briefs a.brow[href="#brief/${brief}"]`);
  await runtimeOn();
  await vote();
  // the browser's back, full screen
  await click(".briefview [data-view-full]");
  await untilHud(`!!document.fullscreenElement`);
  await browserBack();
  await untilHud(`!document.fullscreenElement && document.querySelector(".briefview").hidden`);
  await click(`#briefs a.brow[href="#brief/${brief}"]`);
  await runtimeOn();
  await vote();
}, 90_000);

test.skipIf(!chromeFound)("brief view: the browser's back and forward, and a reload; storage and votes are kept", async () => {
  await open("");
  await click('[data-qtab="briefs"]');
  await click(`#briefs a.brow[href="#brief/${brief}"]`);
  await runtimeOn();
  const votes = parseInt(await text("votes"));
  await browserBack();
  await untilHud(`location.hash === "" && !document.querySelector(".briefview:not([hidden])")`);
  await browserBack(1);
  await untilHud(`location.hash === "#brief/${brief}"`);
  await runtimeOn();
  expect(parseInt(await text("votes"))).toBe(votes);
  const visits = parseInt((await text("visits")).replace("visit ", ""));
  await page.s("Page.reload");
  await untilHud(`!!document.getElementById("lastNote")?.innerHTML && location.hash === "#brief/${brief}"`, 15_000);
  await runtimeOn();
  expect(await text("visits")).toBe(`visit ${visits + 1}`);
  await vote();
}, 90_000);

test.skipIf(!chromeFound)("brief view: NEW WINDOW is a second view of the page, live both ways", async () => {
  await open(`#brief/${brief}`);
  await runtimeOn();
  const before = new Set((await chrome.cdp.send("Target.getTargets")).targetInfos.map((t: any) => t.targetId));
  await click(".briefview a.btn-s[target=_blank]");
  let targetId = "";
  await until(async () => (targetId = (await chrome.cdp.send("Target.getTargets")).targetInfos.find((t: any) => t.type === "page" && !before.has(t.targetId) && t.url.includes(`#brief/${brief}`))?.targetId ?? ""), "NEW WINDOW opens a tab at the brief");
  expect(targetId).not.toBe("");
  const other = await session(targetId);
  const s = other.s;
  await s("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await untilHud(`location.hash === "#brief/${brief}" && !!document.querySelector(".briefview .pageframe")`, 15_000, other);
  await runtimeOn(other);
  const n = await vote(other);
  await untilFrame(`parseInt(document.getElementById("votes").textContent) === ${n}`);
  const m = await vote();
  await untilFrame(`parseInt(document.getElementById("votes").textContent) === ${m}`, 10_000, other);
  await chrome.cdp.send("Target.closeTarget", { targetId });
  front = null;
}, 90_000);

test.skipIf(!chromeFound)("dark mode from MENU: the page gets the dark theme and keeps working", async () => {
  await open(`#brief/${brief}`);
  await runtimeOn();
  await click("#menuBtn");
  await click('#menuDrop [data-set-theme="dark"]');
  await untilHud(`(${FRAME})?.src.includes("theme=dark")`);
  await untilFrame(`document.documentElement.dataset.theme === "dark"`);
  await runtimeOn();
  await vote();
  await click('#menuDrop [data-set-theme="system"]').catch(async () => { await click("#menuBtn"); await click('#menuDrop [data-set-theme="system"]'); });
}, 90_000);

test.skipIf(!chromeFound)("a brief on another floor: the page works in the HUD; lanes on the other floor read it back only with --all", async () => {
  await open(`#brief/${opsBrief}`);
  await runtimeOn();
  await vote();
  const mine = hud(["page", "data", `briefs/${opsBrief}`, "votes"], "w1:p3");
  expect(mine.exitCode).toBe(0);
  expect(JSON.parse(mine.stdout.toString()).docs.length).toBe(1);
  expect(hud(["page", "data", `briefs/${opsBrief}`], "w1:p1").exitCode).toBe(1);
  expect(hud(["page", "data", `briefs/${opsBrief}`, "--all"], "w1:p1").exitCode).toBe(0);
  expect(hud(["page", "room", `briefs/${opsBrief}`, "peers"], "w1:p1").exitCode).toBe(1);
  expect(hud(["page", "room", `briefs/${opsBrief}`, "peers", "--all"], "w1:p1").exitCode).toBe(0);
}, 90_000);

test.skipIf(!chromeFound)("a room's page on the stage: Esc and BACK return to the room; publish with a second tab open reloads both", async () => {
  await open("#room/pricing");
  await click('.art.page .open[href="#page/rooms/pricing/files/walk.html"]');
  await runtimeOn();
  await click(".pvbar .pvtitle");
  await key("Escape");
  await untilHud(`location.hash === "#room/pricing"`);
  await click('.art.page .open[href="#page/rooms/pricing/files/walk.html"]');
  await runtimeOn();
  await click("[data-page-back]");
  await untilHud(`location.hash === "#room/pricing"`);
  // publish: this tab clicks More, a second tab showing the page follows
  const other = await session();
  await open("#page/rooms/pricing/files/poll.html", 1200, 900, false, other);
  await open("#page/rooms/pricing/files/poll.html");
  await untilFrame(`document.getElementById("n")?.textContent === "0"`);
  await untilFrame(`document.getElementById("n")?.textContent === "0"`, 10_000, other);
  await clickInFrame("more");
  await untilFrame(`document.getElementById("n")?.textContent === "1"`, 15_000);
  await untilFrame(`document.getElementById("n")?.textContent === "1"`, 15_000, other);
  expect(readFileSync(join(dir, "rooms", "pricing", "files", "poll.html"), "utf8")).toContain('<p id="n">1</p>');
  await Bun.sleep(2100); // one publish every 2 s for a page
  await untilFrame(`document.getElementById("n")?.textContent === "1" && !document.body.dataset.refused`, 10_000, other);
  await clickInFrame("more", other);
  await untilFrame(`document.getElementById("n")?.textContent === "2"`, 15_000);
  await other.s("Page.navigate", { url: "about:blank" });
}, 90_000);

test.skipIf(!chromeFound)("phone width: SAVE and ALLOW bars fit and answer a tap; COMMENT reaches the thread's sheet", async () => {
  await open("#page/rooms/pricing/files/walk.html", 390, 844, true);
  await runtimeOn();
  const t0 = await inFrame(`performance.timeOrigin`);
  await clickInFrame("save");
  await untilHud(`!!document.querySelector(".pr-save .pr-yes")`).catch(async (e) => { throw await diagnose(page, t0, e); });
  expect(await ev(`(() => { const r = document.querySelector(".pr-save").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`)).toBe(true);
  await click(".pr-save .pr-yes");
  await untilFrame(`document.getElementById("saved").textContent === "saved"`);
  await until(async () => existsSync(join(DOWNLOADS, "walk.txt")) && readFileSync(join(DOWNLOADS, "walk.txt"), "utf8") === "walked", "walk.txt saved");
  await clickInFrame("ask");
  await untilHud(`document.querySelector(".pr-save")?.textContent.includes("ask a model")`);
  await click(".pr-save .pr-yes");
  await untilFrame(`document.getElementById("answer").textContent === "answer to hi"`);
  await selectAndComment("quote");
  await untilHud(`document.querySelector('aside.cmount[data-comments="rooms/pricing/files/walk.html"]')?.textContent.includes("Tier two costs forty a month.")`);
}, 90_000);

test.skipIf(!chromeFound)("no page errors on the way", () => {
  console.log(`clicks given again after headless Chrome dropped them: ${dropped}`);
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
