// ASK ROUTING on the page, walked as the owner does it with real input (CDP mouse, keys, text): a PM's question says
// who it is for and whose pick it is, and every way to answer it (the card, Cmd/Ctrl+Enter, the stage, NOT YET,
// secrets, while the PM is away) reaches the PM's pane, never HQ's, and says so. HQ's own question is unchanged. A
// lane waiting on its PM says so (drawer, LANES BOARD, a lane card in MESSAGES), stands by the PM's desk, and is not
// counted ON HQ. Floors, dark and light, a phone. A stub herdr records what is typed. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled } from "../walk-diag.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-askroute-walk-"));
const agent = (name: string, pane: string, agent_status = "idle"): FakeAgent => ({ name, agent_status, pane_id: pane, agent: "claude" });
const HQ = agent("hq", "w1:p1"), CRM = agent("hq-crm", "w1:p2"), PM = agent("pm", "w1:p3"), CHILD = agent("child", "w1:p4"), KID = agent("kid", "w1:p5"), PMX = agent("pm-x", "w1:p6");
const ALL = [HQ, CRM, PM, CHILD, KID, PMX];
const herdr = fakeHerdr(dir, ALL);
const PAGE = `<title>Rows</title><style>:root{color-scheme:light dark}body{font:14px sans-serif;margin:8px}</style><h1>Rows</h1><p>A table would be here.</p>`;
const SECRET = "walk-routing-SECRET-4410";

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000, show?: string) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}${show ? `; the page shows ${JSON.stringify(await ev(show).catch((e: Error) => e.message))}` : ""}${await clickLog(ev)}`);
};
const as = (pane: string) => ({ "x-hud-pane": pane, "x-hud-machine": "local" });
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const sync = () => post("/api/sync");
const world = async (list: FakeAgent[]) => { herdr.world(list); await sync(); };
const shot = async (name: string) => {
  if (!process.env.ASK_SHOTS) return;
  const { data } = await page.s("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(process.env.ASK_SHOTS, `routing-${name}.png`), Buffer.from(data, "base64"));
};
async function typedInto(name: string, part: string, ms = 12_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (herdr.typedInto(name).some((t) => t.includes(part))) break;
  await Bun.sleep(250);
  return herdr.typedInto(name).filter((t) => t.includes(part));
}
const whoGot = (part: string) => herdr.typed().filter(([, t]) => t.includes(part)).map(([who]) => who);

// ---- real input ----
async function centre(sel: string) {
  await settled(ev, sel);
  const r = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getClientRects().length); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); return { x, y, ok: !!hit && (el === hit || el.contains(hit)), hit: hit?.outerHTML.slice(0, 120) }; })()`);
  if (!r) throw new Error(`nothing to click: ${sel}`);
  if (!r.ok) throw new Error(`${sel} is covered by ${r.hit}`);
  return r;
}
async function click(sel: string) {
  const { x, y } = await centre(sel);
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await aimed(ev, sel, x, y, "pressed");
}
async function tap(sel: string) {
  const { x, y } = await centre(sel);
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await aimed(ev, sel, x, y, "pressed");
}
async function key(k: string, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 27, modifiers });
}
const type = (text: string) => page.s("Input.insertText", { text });
const CTRL = 2;

async function load(w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`sessionStorage.clear(), true`);
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`(() => { window.__toasts = []; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("toast")) window.__toasts.push(n.textContent); }).observe(document.body, { childList: true, subtree: true }); return true; })()`);
  await click(`[data-qtab="questions"]`);
  await until(`!document.getElementById("hud").hidden`);
}
const card = (id: number) => `#hud [data-ask="${id}"]`;
const toasted = (text: string) => until(`window.__toasts.some((t) => t.includes(${JSON.stringify(text)}))`);
const text = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
async function messages() {
  await click(`[data-qtab="messages"]`);
  await until(`!!document.querySelector("[data-msg]")`);
}
const seen = (id: number) => text(`[data-msg="a${id}"] .seen`);
const pmAsk = (b: object) => post("/api/asks", { lane: "child", ...b }, as("w1:p3")).then((r) => r.id as number);

let Q1 = 0, Q2 = 0, Q3 = 0, Q4 = 0, Q5 = 0, Q6 = 0, Q7 = 0;
beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Sam" } });
  await sync();
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  for (const name of ["child", "kid"]) await post("/api/lanes", { name, parent: "pm", machine: "local" });
  await sync();
  Q1 = await pmAsk({ title: "Which cache?", options: ["Redis", "Memory"], recommended: "Redis" });
  Q2 = await pmAsk({ title: "Sign in to the store", kind: "action" });
  Q3 = await pmAsk({ title: "Which rows go?", options: ["Keep", "Drop"], recommended: "Keep", file: PAGE });
  Q4 = (await post("/api/asks", { lane: "child", title: "HQ's own: ship it?", options: ["Yes", "No"], recommended: "Yes" }, as("w1:p1"))).id;
  Q5 = await pmAsk({ title: "The store token", kind: "action", secrets: ["STORE_TOKEN"] });
  Q6 = await pmAsk({ title: "Rename the table?", options: ["Yes", "No"] });
  Q7 = await pmAsk({ title: "Keyboard answer", options: ["Left", "Right"] });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  // Web fonts come over the network at their own time and widen the text they replace: a click aimed just before
  // lands beside its target (the tabs move 96 px when Press Start 2P arrives). The walks run without them.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("P1: a PM's card says FOR PM · Manager (a click opens the PM), and the pick is the PM's, also in the drawer", async () => {
  await load();
  expect(await text(`${card(Q1)} .tag.for`)).toBe("FOR PM · Manager");
  expect(await text(`${card(Q1)} .opt[data-opt="Redis"] .pick`)).toBe("PM PICK");
  await click(`${card(Q1)} .tag.for`);
  await until(`!document.getElementById("card").hidden && document.querySelector("#card h3").textContent === "pm"`);
  await click(`${card(Q1)} .tag.lane`);
  await until(`document.querySelector("#card h3").textContent === "child"`);
  expect(await ev(`[...document.querySelectorAll("#card .agopts i")].map((i) => i.textContent)`)).toContain("PM PICK");
  await shot("p1-card");
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("P2: answered from the card with a click, and with Ctrl+Enter: the PM's pane gets it, the toast and MESSAGES name the PM", async () => {
  await load();
  await click(`${card(Q1)} .opt[data-opt="Memory"]`);
  await click(`${card(Q1)} textarea`);
  await type("keep it small");
  await click(`${card(Q1)} .send`);
  await toasted("SENT. PM HAS IT.");
  expect(await typedInto("pm", `HUD answer #${Q1} (child): "Which cache?" -> Memory. keep it small`)).toHaveLength(1);
  expect(whoGot(`HUD answer #${Q1}`)).toEqual(["pm"]);
  // Q1 has just closed on screen: a card takes no press for a moment (needs-gate.test.ts).
  await until(`!document.documentElement.classList.contains("unready")`);
  await click(`${card(Q7)} .opt[data-opt="Right"]`);
  await click(`${card(Q7)} textarea`);
  await key("Enter", CTRL);
  await toasted("SENT. PM HAS IT.");
  expect(await typedInto("pm", `HUD answer #${Q7} (child): "Keyboard answer" -> Right`)).toHaveLength(1);
  expect(whoGot(`HUD answer #${Q7}`)).toEqual(["pm"]);
  await messages();
  await until(`document.querySelector('[data-msg="a${Q1}"] .seen')?.textContent === "PM TO ACT"`);
  await post(`/api/asks/${Q1}/ack`, {}, as("w1:p3"));
  await until(`document.querySelector('[data-msg="a${Q1}"] .seen')?.textContent === "PM ACTED"`);
  await shot("p2-messages");
}, 30_000);

test.skipIf(!chromeFound)("P3: answered from the stage, under its page: the dock names the PM's pick and the answer reaches the PM", async () => {
  await load();
  await click(`${card(Q3)} .tag.pageopen`);
  await until(`location.hash === "#page/asks/${Q3}" && !!document.querySelector('.askdock [data-ask="${Q3}"] .send')`);
  expect(await text(`.askdock [data-ask="${Q3}"] .opt[data-opt="Keep"] .pick`)).toBe("PM PICK");
  expect(await text(`.askdock [data-ask="${Q3}"] .tag.for`)).toBe("FOR PM · Manager");
  await click(`.askdock [data-ask="${Q3}"] .opt[data-opt="Drop"]`);
  await click(`.askdock [data-ask="${Q3}"] .send`);
  await toasted("SENT. PM HAS IT.");
  await until(`!!document.querySelector(".askdock .dockdone")`);
  expect(await typedInto("pm", `HUD answer #${Q3}`)).toHaveLength(1);
  expect(whoGot(`HUD answer #${Q3}`)).toEqual(["pm"]);
  await click("[data-page-back]");
  await until(`location.hash === "" && !document.querySelector('${card(Q3)}')`);
}, 30_000);

test.skipIf(!chromeFound)("P4: NOT YET on a PM's TO DO: the note box is for the PM, the PM hears it, the card stays", async () => {
  await load();
  expect(await ev(`document.querySelector('${card(Q2)} textarea').placeholder`)).toBe("Optional note for pm");
  await click(`${card(Q2)} textarea`);
  await type("after lunch");
  await click(`${card(Q2)} .notyet`);
  await toasted("PM KNOWS: NOT YET.");
  expect(await typedInto("pm", `HUD not yet #${Q2} (child): "Sign in to the store" -> after lunch`)).toHaveLength(1);
  expect(whoGot(`HUD not yet #${Q2}`)).toEqual(["pm"]);
  await until(`!!document.querySelector('${card(Q2)} .send')`);
}, 30_000);

test.skipIf(!chromeFound)("P5: the PM away: the toast and MESSAGES say kept; back, it is typed in and MESSAGES says TO ACT", async () => {
  await world(ALL.filter((a) => a !== PM));
  await load();
  await click(`${card(Q6)} .opt[data-opt="Yes"]`);
  await click(`${card(Q6)} .send`);
  await toasted("SENT. PM IS AWAY: KEPT FOR IT.");
  await messages();
  await until(`document.querySelector('[data-msg="a${Q6}"] .seen')?.textContent === "PM AWAY · KEPT"`);
  await shot("p5-kept");
  expect(whoGot(`HUD answer #${Q6}`)).toEqual([]);
  await world(ALL);
  expect((await typedInto("pm", `HUD answer #${Q6}`))[0]).toMatch(/^\(kept while you were away; written at/);
  await until(`document.querySelector('[data-msg="a${Q6}"] .seen')?.textContent === "PM TO ACT"`);
}, 30_000);

test.skipIf(!chromeFound)("P6: a PM's secrets ask: the toast says the PM has the names; the value is in no markup, no storage, no typed text", async () => {
  await load();
  await click(`${card(Q5)} input[data-secret="STORE_TOKEN"]`);
  await type(SECRET);
  await click(`${card(Q5)} .send`);
  await toasted("SECRETS SAVED. PM HAS THE NAMES.");
  expect((await typedInto("pm", `HUD answer #${Q5}`))[0]).toContain("secrets set: STORE_TOKEN");
  expect(herdr.typed().some(([, t]) => t.includes(SECRET))).toBe(false);
  expect(await ev(`[document.documentElement.outerHTML, JSON.stringify(localStorage), JSON.stringify(sessionStorage), JSON.stringify(window.__toasts)].some((s) => s.includes(${JSON.stringify(SECRET)}))`)).toBe(false);
}, 30_000);

test.skipIf(!chromeFound)("P7: HQ's own question is as before: HQ PICK, no FOR tag, and HQ gets the answer", async () => {
  await load();
  expect(await text(`${card(Q4)} .opt[data-opt="Yes"] .pick`)).toBe("HQ PICK");
  expect(await ev(`!!document.querySelector('${card(Q4)} .tag.for')`)).toBe(false);
  await click(`${card(Q4)} .opt[data-opt="No"]`);
  await click(`${card(Q4)} .send`);
  await toasted("SENT. HQ HAS IT.");
  expect(await typedInto("hq", `HUD answer #${Q4}`)).toHaveLength(1);
  expect(whoGot(`HUD answer #${Q4}`)).toEqual(["hq"]);
}, 30_000);

const spot = (name: string) => ev(`import("/src/client/room/workers.js").then(({ workers }) => { const w = workers.get(${JSON.stringify(name)}); return w ? { x: w.target.x, y: w.target.y, seat: w.seat } : null; })`);
test.skipIf(!chromeFound)("P8: a lane waiting on its PM says so everywhere, stands by the PM's desk (HQ's spot while the PM has none), and is not ON HQ", async () => {
  // the PM idle from the start: it never sat down, so kid has no desk to go to and waits at HQ's spot
  await load();
  const hq = await ev(`import("/src/client/room/spots.js").then(({ HQ_SPOT }) => HQ_SPOT.map((s) => s.x + "," + s.y))`);
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.has("kid"))`);
  expect(hq).toContain(`${(await spot("kid")).x},${(await spot("kid")).y}`);
  // the PM at work at its desk: kid walks to the free row behind the PM's seat
  await world(ALL.map((a) => (a === PM ? { ...PM, agent_status: "working" } : a)));
  await until(`import("/src/client/room/workers.js").then(({ workers }) => !!workers.get("pm")?.seat)`);
  const seat = (await spot("pm")).seat;
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.get("kid").target.y === ${seat.y + 1})`);
  const k = await spot("kid");
  expect(k.x).toBe(seat.x + 1);
  await until(`import("/src/client/room/workers.js").then(({ workers }) => ["kid", "pm"].every((n) => { const w = workers.get(n); return Math.abs(w.x - w.target.x) < 0.05 && Math.abs(w.y - w.target.y) < 0.05; }))`, 15000);
  await shot("p8-by-the-pm");
  // the PM idle again: it keeps its desk, so kid stays by it
  await world(ALL);
  await Bun.sleep(400);
  expect((await spot("kid")).y).toBe(seat.y + 1);
  // the words: drawer, top bar ON HQ (kid and child are the PM's), LANES BOARD, a lane card in MESSAGES
  const st = await fetch(`${server.base}/api/state`).then((r) => r.json());
  expect(st.lanes.find((l: any) => l.name === "kid").status).toBe("hq_turn");
  const onHq = st.lanes.filter((l: any) => ["hq_turn", "stale", "gone"].includes(l.status) && !l.parent).length;
  expect(await text("#sHq")).toBe(String(onHq));
  await post("/api/updates", { title: "Look at kid", body: "#lane/kid" }, as("w1:p1"));
  await messages();
  await until(`[...document.querySelectorAll(".hudcard .hchip.st")].some((c) => c.textContent === "WAITING ON PM")`, 8000, `[...document.querySelectorAll('[data-msg^="u"]')].map((m) => m.innerHTML.slice(0, 600))`);
  await click("#menuBtn");
  await click(`#menuDrop [data-layout="board"]`);
  await until(`[...document.querySelectorAll(".lbrow")].some((r) => r.querySelector(".lbn")?.textContent === "kid" && r.querySelector(".lbx")?.textContent === "Waiting on pm")`);
  await shot("p8-board");
  await click(`.lbrow[data-lane-pick="kid"]`);
  await until(`document.querySelector("#card h3")?.textContent === "kid"`);
  expect(await text("#card .status")).toBe("WAITING ON PM");
  await click("#menuBtn");
  await click(`#menuDrop [data-layout="office"]`);
  await key("Escape");
}, 40_000);

test.skipIf(!chromeFound)("P10: the FOR tag reads in light and in dark", async () => {
  const contrast = `(() => { const el = document.querySelector('${card(Q2)} .tag.for'); const cs = getComputedStyle(el); const rgb = (s) => s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number); const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }; const a = lum(rgb(cs.color)), b = lum(rgb(cs.backgroundColor)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); })()`;
  for (const theme of ["light", "dark"]) {
    await load();
    await click("#menuBtn");
    await click(`#menuDrop [data-set-theme="${theme}"]`);
    await until(`document.documentElement.dataset.theme === "${theme}"`);
    await key("Escape");
    expect(await ev(contrast)).toBeGreaterThanOrEqual(4.5);
    await shot(`p10-${theme}`);
  }
  await click("#menuBtn");
  await click(`#menuDrop [data-set-theme="system"]`);
  await key("Escape");
}, 30_000);

test.skipIf(!chromeFound)("P11: on a phone the PM's card wraps its tags, its answer row stays in reach, and nothing scrolls sideways", async () => {
  await load(390, 844, true);
  const r = await ev(`(() => { const c = document.querySelector('${card(Q2)}'), f = c.querySelector(".tag.for").getBoundingClientRect(), s = c.querySelector(".send").getBoundingClientRect(), b = c.getBoundingClientRect(); return { inCard: f.left >= b.left && f.right <= b.right, send: s.right <= innerWidth && s.width > 0, wide: document.scrollingElement.scrollWidth }; })()`);
  expect(r).toEqual({ inCard: true, send: true, wide: 390 });
  await tap(`${card(Q2)} .tag.for`);
  await until(`document.querySelector("#card h3")?.textContent === "pm"`);
  await shot("p11-phone");
}, 30_000);

test.skipIf(!chromeFound)("P9: floors: a PM on another floor; its card in the building and inside its floor says FOR it; the answer is its; tiles draw", async () => {
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await sync();
  await post("/api/lanes", { name: "pm-x", machine: "local" }, as("w1:p2"));
  await sync();
  const id = (await post("/api/asks", { lane: "pm-x", title: "CRM fields?", options: ["Few", "Many"], recommended: "Few" }, as("w1:p6"))).id;
  await load();
  await until(`!!document.querySelector('${card(id)} .tag.for')`);
  expect(await text(`${card(id)} .tag.for`)).toBe("FOR PM-X · Manager");
  expect(await text(`${card(id)} .opt[data-opt="Few"] .pick`)).toBe("PM-X PICK");
  await until(`document.querySelectorAll("[data-floor-go]").length >= 2`);
  await click(`.tgo[data-floor-go="crm"]`);
  await until(`!!document.querySelector('${card(id)} .tag.for') && !document.querySelector('${card(Q2)}')`);
  await click(`${card(id)} .opt[data-opt="Many"]`);
  await click(`${card(id)} .send`);
  await toasted("SENT. PM-X HAS IT.");
  expect(await typedInto("pm-x", `HUD answer #${id}`)).toHaveLength(1);
  expect(whoGot(`HUD answer #${id}`)).toEqual(["pm-x"]);
  await shot("p9-floor");
  expect(errors).toEqual([]);
}, 30_000);
