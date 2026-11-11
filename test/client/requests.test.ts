// REQUESTS on the WORK tab, and the age-out of MESSAGES and BRIEFS. First the model with no page (which requests are
// amber, the order, the next moment one turns amber). Then the page as the owner uses it, with real mouse, key and
// touch input (CDP Input) on a throwaway server seeded through the real routes: his notes become rows, HQ's commands
// move them, REOPEN and CLOSE, seen, a day and a week passing (the page's clock is moved, never the machine's), a
// second floor, a phone and both themes. Needs Chrome for the page part; skipped without it.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { AUDIT, MEASURE } from "../mobile-walk.ts";
import { DAY, live, nextStaleAt, oldestFirst, prOf, stale, staleCount } from "../../src/client/requests/model.js";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const HOUR = 3600_000;

// ---- the model ----

const T = Date.UTC(2026, 10, 11, 12);
const r = (o: Record<string, unknown>) => ({ id: 1, at: T - 3 * DAY, status: "assigned", movedAt: T - 2 * HOUR, ...o }) as any;

test("amber is a request on its way that has not moved for more than a day", () => {
  expect(stale(r({ movedAt: T - DAY }), T)).toBe(false);
  expect(stale(r({ movedAt: T - DAY - 1 }), T)).toBe(true);
  for (const status of ["new", "open", "assigned", "waiting"]) expect(stale(r({ status, movedAt: T - 2 * DAY }), T)).toBe(true);
  // One that is over is never late: it waits to be seen, not to be moved.
  for (const status of ["delivered", "withdrawn"]) expect([live(r({ status })), stale(r({ status, movedAt: T - 5 * DAY }), T)]).toEqual([false, false]);
  // One nobody has touched yet counts from when it was sent.
  expect(stale(r({ status: "new", movedAt: null, at: T - 2 * DAY }), T)).toBe(true);
  expect(stale(r({ status: "new", movedAt: null, at: T - HOUR }), T)).toBe(false);
});

test("the badge counts the amber ones; the list reads oldest first", () => {
  const list = [r({ id: 3, at: T - HOUR }), r({ id: 1, at: T - 5 * DAY, movedAt: T - 2 * DAY }), r({ id: 2, at: T - 5 * DAY, status: "delivered", movedAt: T - 3 * DAY }), r({ id: 4, at: T - 4 * DAY, status: "new", movedAt: T - 4 * DAY })];
  expect(staleCount(list, T)).toBe(2);
  expect(oldestFirst(list).map((x) => x.id)).toEqual([1, 2, 4, 3]);
  expect(list.map((x) => x.id)).toEqual([3, 1, 2, 4]); // the state's list is left as it came
});

test("the next moment a row turns amber by itself", () => {
  expect(nextStaleAt([], T)).toBe(null);
  expect(nextStaleAt([r({ movedAt: T - 2 * DAY }), r({ status: "delivered" })], T)).toBe(null);
  expect(nextStaleAt([r({ movedAt: T - HOUR }), r({ movedAt: T - 20 * HOUR }), r({ movedAt: T - 3 * DAY })], T)).toBe(T + 4 * HOUR + 1);
});

test("a PR as HQ gave it: a number, #number or its address", () => {
  expect(prOf(null)).toBe(null);
  expect(prOf("")).toBe(null);
  expect(prOf("45")).toEqual({ number: "45", label: "PR #45" });
  expect(prOf("#45")).toEqual({ number: "45", label: "PR #45" });
  expect(prOf("https://github.com/acme/app/pull/812")).toEqual({ href: "https://github.com/acme/app/pull/812", label: "PR #812" });
  expect(prOf("acme/app#3")).toEqual({ label: "PR acme/app#3" });
});

// ---- the page ----

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const data = mkdtempSync(join(tmpdir(), "hq-requests-"));
const herdr = fakeHerdr(join(data, "herdr-fake"), [
  { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" },
  { name: "alpha", agent_status: "working", pane_id: "w1:p2", agent: "claude" },
  { name: "hq-pay", agent_status: "idle", pane_id: "w2:p1", agent: "claude" },
]);
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ tab: document.querySelector("#qtabs .tab.on")?.dataset.qtab, work: document.getElementById("work")?.innerText.replace(/\\s+/g, " ").slice(0, 600) })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}${await clickLog(ev)}`);
};
// The owner's page sends no pane; HQ's hud says which pane it runs in.
const post = async (p: string, b: unknown = {}, pane?: string) => {
  const res = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane } : {}) }, body: JSON.stringify(b) });
  const d = await res.json();
  if (!res.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const HQ = "w1:p1";
const state = async () => (await (await fetch(`${server.base}/api/state`)).json()) as any;
const requestOf = async (words: string) => (await state()).requests.find((x: any) => x.words.startsWith(words));
// A note from the owner, and the request it filed.
async function tell(text: string, floor?: string) {
  await post("/api/notes", { text, ...(floor ? { floor } : {}) });
  return (await requestOf(text))?.id as number;
}

type Load = { tab?: string; w?: number; h?: number; mobile?: boolean; theme?: "light" | "dark"; floor?: string; shift?: number; frozen?: number };
// A new document, with this browser's choices and, when asked, its clock moved or stopped: the page's, never the machine's.
async function load(o: Load = {}) {
  const { tab = "work", w = 1440, h = 900, mobile = false } = o;
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await page.s("Page.navigate", { url: "about:blank" });
  const clock = o.frozen != null ? `Date.now = () => ${o.frozen};` : o.shift ? `{ const real = Date.now.bind(Date); Date.now = () => real() + ${o.shift}; }` : "";
  const seed = await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === top && location.protocol === "http:") {
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem("hq-qtab", ${JSON.stringify(tab)});
    ${o.theme ? `localStorage.setItem("hq-theme", ${JSON.stringify(o.theme)});` : ""}
    ${o.floor ? `sessionStorage.setItem("hq-scope", ${JSON.stringify(JSON.stringify({ floor: o.floor, all: false }))});` : ""}
    ${clock}
  }` });
  await page.s("Page.navigate", { url: `${server.base}/` });
  // Every feature is a module script in the shell, so "complete" means they have all run; lastNote that a state came.
  await until(`document.readyState === "complete" && !!document.getElementById("lastNote")?.innerHTML`);
  await page.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: seed.identifier });
  if (mobile) return;
  // A real click right after a load can be dropped: move the mouse until the page has seen it.
  await ev(`window.__moved = false; addEventListener("mousemove", () => { window.__moved = true; }, { once: true }); true`);
  for (let i = 0; i < 40 && !(await ev("window.__moved")); i++) { await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5 + i, y: 5 }); await Bun.sleep(25); }
}
// Where to press sel: in view, and nothing over it.
async function spot(sel: string) {
  await settled(ev, sel);
  const at = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return "missing";
    e.scrollIntoView({ block: "nearest" });
    const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40), y = r.top + Math.min(r.height / 2, 22);
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot press ${sel}: ${at}`);
  return at as [number, number];
}
async function click(sel: string) {
  const [x, y] = await spot(sel);
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await aimed(ev, sel, x, y, "pressed");
}
async function tap(sel: string) {
  const [x, y] = await spot(sel);
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const key = async (k: "Enter" | "Escape") => {
  const o = k === "Enter" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" } : { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 };
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", ...o });
  await page.s("Input.dispatchKeyEvent", { type: "keyUp", key: o.key, code: o.code, windowsVirtualKeyCode: o.windowsVirtualKeyCode });
};
const type = (text: string) => page.s("Input.insertText", { text });
const row = (id: number) => `#work [data-rq="${id}"]`;
const say = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, " ").trim() ?? null`);
const count = (sel: string) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const rows = () => ev(`[...document.querySelectorAll("#work [data-rq]")].map((e) => Number(e.dataset.rq))`);
const badge = () => ev(`(() => { const t = document.getElementById("qtStalled"); return t.hidden ? null : t.textContent; })()`);
const toasted = (t: string) => `[...document.querySelectorAll(".toast")].some((e) => e.textContent === ${JSON.stringify(t)})`;
const fill = (sel: string) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);
// Text under #work that reads at less than 4.5 to 1 on what is behind it.
const LOW = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const v = [c.r, c.g, c.b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ground = (e) => { const st = []; for (let a = e; a; a = a.parentElement) { const c = parse(getComputedStyle(a).backgroundColor); if (c.a > 0) { st.push(c); if (c.a === 1) break; } } let g = { r: 255, g: 255, b: 255, a: 1 }; for (const c of st.reverse()) g = over(c, g); return g; };
  const low = [];
  for (const e of document.querySelectorAll("#work *")) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || e.disabled || !e.getBoundingClientRect().width) continue;
    const g = ground(e), fg = over(parse(getComputedStyle(e).color), g), a = lum(fg), b = lum(g), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5) low.push(e.className + " " + ratio.toFixed(1) + " " + e.textContent.trim().slice(0, 20));
  }
  return low;
})()`;

const ids: Record<string, number> = {};
let ask = 0, tMid = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HERDR_PANE_ID: undefined, HUD_URL: undefined, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_QUEUE: "0" } });
  await post("/api/sync");
  await post("/api/lanes", { name: "alpha", title: "The deploy window", phase: "running", machine: "local" });
  await post("/api/sync");
  ask = (await post("/api/asks", { lane: "alpha", kind: "decision", title: "Which sections of the report go?", options: ["The charts", "The appendix"] })).id;
  // What the owner told HQ, oldest first; "thanks!" is only an acknowledgement.
  ids.deploy = await tell("Deploys must never go out before office hours. **Guarantee** it.");
  ids.report = await tell("Make the weekly report shorter.");
  ids.tab = await tell("Remove the work tab: it was supposed to solve this.");
  ids.vendor = await tell("Try the other vendor for the SMS codes");
  expect(await tell("thanks!")).toBeUndefined();
  ids.invoices = await tell("Can we get the invoices as PDF?");
  // HQ sorts and moves them.
  await post(`/api/requests/${ids.deploy}/assign`, { lane: "alpha", issue: "OPE-12", pr: "45" }, HQ);
  await post(`/api/requests/${ids.deploy}/move`, { text: "PR #45 is in review" }, HQ);
  await post(`/api/requests/${ids.report}/assign`, { lane: "hq" }, HQ);
  await post(`/api/requests/${ids.report}/wait`, { ask }, HQ);
  await post(`/api/requests/${ids.tab}/deliver`, { link: "https://example.com/pull/7", text: "The WORK tab lists your requests now." }, HQ);
  await post(`/api/requests/${ids.vendor}/withdraw`, { why: "the vendor has no EU region" }, HQ);
  // MESSAGES and BRIEFS from before tMid; what the tests send later is newer.
  await post("/api/updates", { lane: "alpha", title: "Halfway there", body: "The first part is merged." });
  ids.briefRead = (await post("/api/briefs", { title: "Last month: the migration", body: "It went well." }, HQ)).id;
  ids.briefNew = (await post("/api/briefs", { title: "Last month: what we skipped", body: "Three things." }, HQ)).id;
  await post(`/api/briefs/${ids.briefRead}/read`);
  await Bun.sleep(30);
  tMid = Date.now();
  await Bun.sleep(30);
  page = await newSession(chrome.cdp, errors);
}, 60_000);

afterAll(async () => {
  await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
  await server?.stop();
  await chrome?.close();
  rmSync(data, { recursive: true, force: true });
});

const walk = test.skipIf(!chromeFound);

walk("a delivered row is not seen while another tab is open", async () => {
  await load({ tab: "questions" });
  expect(await ev(`document.getElementById("work").hidden && document.getElementById("work").children.length === 0`)).toBe(true);
  await Bun.sleep(400);
  expect((await requestOf("Remove the work tab")).seenAt).toBe(null);
}, 30_000);

walk("WORK lists what he asked for, oldest first, in his words, with where each stands", async () => {
  await click('[data-qtab="work"]');
  await until(`document.querySelectorAll("#work [data-rq]").length === 5`);
  expect(await rows()).toEqual([ids.deploy, ids.report, ids.tab, ids.vendor, ids.invoices]);
  expect(await say("#work .rsum")).toBe("5 REQUESTS");
  // Assigned: the lane (its drawer), the issue, the PR, the last movement and how long ago.
  expect(await say(`${row(ids.deploy)} .tag.rs`)).toBe("ASSIGNED");
  expect(await say(`${row(ids.deploy)} button.tag.lane[data-select="alpha"]`)).toBe("alpha");
  expect(await say(`${row(ids.deploy)} .meta`)).toContain("OPE-12");
  expect(await say(`${row(ids.deploy)} .meta`)).toContain("PR #45");
  expect(await say(`${row(ids.deploy)} .meta .sent`)).toContain(`#${ids.deploy} ·`);
  expect(await say(`${row(ids.deploy)} .moved`)).toMatch(/^PR #45 is in review \d+ min ago$/);
  // His words, as markdown, through the one renderer.
  expect(await ev(`document.querySelector(${JSON.stringify(`${row(ids.deploy)} .words b`)}).textContent`)).toBe("Guarantee");
  // Waiting on him: the question it waits on, one click away.
  expect(await say(`${row(ids.report)} .tag.rs`)).toBe("WAITING ON YOU");
  expect(await say(`${row(ids.report)} a.tag[href="#ask/${ask}"]`)).toBe(`QUESTION #${ask}`);
  // Delivered: the link and the line, and REOPEN. Withdrawn: the reason, and REOPEN.
  expect(await say(`${row(ids.tab)} .tag.rs`)).toBe("DELIVERED");
  expect(await ev(`document.querySelector(${JSON.stringify(`${row(ids.tab)} .out a`)}).href`)).toBe("https://example.com/pull/7");
  expect(await say(`${row(ids.tab)} .out`)).toMatch(/^https:\/\/example\.com\/pull\/7 · The WORK tab lists your requests now\. delivered \d+ min ago REOPEN$/);
  expect(await say(`${row(ids.vendor)} .tag.rs`)).toBe("WITHDRAWN");
  expect(await say(`${row(ids.vendor)} .out`)).toMatch(/^HQ gave it up: the vendor has no EU region \d+ min ago REOPEN$/);
  // New: HQ has not sorted it yet.
  expect(await say(`${row(ids.invoices)} .tag.rs`)).toBe("NEW");
  expect(await say(`${row(ids.invoices)} .moved`)).toMatch(/^HQ has not sorted it yet \d+ min ago$/);
  // Nothing to fill in, nothing amber, no strip over the questions.
  expect(await count("#work input, #work textarea, #work select")).toBe(0);
  expect(await count("#work .rq.stale")).toBe(0);
  expect(await badge()).toBe(null);
  expect(await ev(`document.getElementById("stall").hidden`)).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

walk("on screen with the tab open, a delivered and a withdrawn row are reported seen, once", async () => {
  await until(`fetch("/api/state").then((r) => r.json()).then((s) => s.requests.filter((x) => x.seenAt).length === 2)`);
  const s = await state();
  expect(s.requests.filter((x: any) => x.seenAt).map((x: any) => x.id).sort()).toEqual([ids.tab, ids.vendor].sort());
  const moves = (await (await fetch(`${server.base}/api/requests/${ids.tab}`)).json()).moves.filter((m: any) => m.kind === "seen");
  expect(moves.length).toBe(1);
}, 30_000);

walk("a click on a row opens its history, every move oldest first; the mark closes it", async () => {
  await click(`${row(ids.deploy)} .words`);
  await until(`document.querySelectorAll(${JSON.stringify(`${row(ids.deploy)} .rqmoves li`)}).length >= 2`);
  const history = await say(`${row(ids.deploy)} .rqmoves`);
  expect(history).toContain("PR #45 is in review");
  expect(history.indexOf("alpha")).toBeLessThan(history.indexOf("PR #45 is in review"));
  expect(await ev(`document.querySelector(${JSON.stringify(`${row(ids.deploy)} [data-rq-toggle]`)}).getAttribute("aria-expanded")`)).toBe("true");
  expect(await say(`${row(ids.deploy)} .rqacts`)).toContain("CLOSE");
  // One history at a time.
  await click(`${row(ids.invoices)} .moved`);
  await until(`!!document.querySelector(${JSON.stringify(`${row(ids.invoices)} .rqhist`)}) && !document.querySelector(${JSON.stringify(`${row(ids.deploy)} .rqhist`)})`);
  await click(`${row(ids.invoices)} [data-rq-toggle]`);
  await until(`!document.querySelector("#work .rqhist")`);
  // A click on the lane opens its drawer, not the history.
  await click(`${row(ids.deploy)} button.tag.lane`);
  await until(`!document.getElementById("card").hidden`);
  expect(await count("#work .rqhist")).toBe(0);
  await key("Escape");
  await until(`document.getElementById("card").hidden`);
}, 30_000);

walk("the question a request waits on is one click away, and NEEDS YOU shows it", async () => {
  await click(`${row(ids.report)} a.tag[href="#ask/${ask}"]`);
  await until(`document.querySelector('[data-qtab="questions"]').classList.contains("on") && !!document.querySelector('.ask[data-ask="${ask}"]')`);
  expect(await count("#work [data-rq]")).toBe(0); // off the tab the list is empty
  await click('[data-qtab="work"]');
  await until(`document.querySelectorAll("#work [data-rq]").length === 5`);
}, 30_000);

walk("REOPEN takes his words in the row; Esc and CANCEL leave it as it was", async () => {
  await click(`${row(ids.vendor)} [data-rq-reopen]`);
  await until(`document.activeElement?.matches?.(${JSON.stringify(`${row(ids.vendor)} [data-rq-re] input`)})`);
  expect(await ev(`document.querySelector(${JSON.stringify(`${row(ids.vendor)} [data-rq-re] .send`)}).disabled`)).toBe(true);
  await type("half a thought");
  await key("Escape");
  await until(`!document.querySelector("#work [data-rq-re]")`);
  await click(`${row(ids.vendor)} [data-rq-reopen]`);
  await until(`!!document.querySelector(${JSON.stringify(`${row(ids.vendor)} [data-rq-re] input`)})`);
  expect(await ev(`document.querySelector("#work [data-rq-re] input").value`)).toBe("");
  await click(`${row(ids.vendor)} [data-rq-cancel]`);
  await until(`!document.querySelector("#work [data-rq-re]")`);
  expect((await requestOf("Try the other vendor")).status).toBe("withdrawn");
}, 30_000);

walk("REOPEN with his words: the row is on its way again, the words are in its history and HQ is told", async () => {
  await click(`${row(ids.tab)} [data-rq-reopen]`);
  await until(`document.activeElement?.matches?.("#work [data-rq-re] input")`);
  await type("The badge still counts the old board");
  // A state from the server while he types keeps the words and the caret.
  await post("/api/updates", { title: "A later update", body: "Sent while the owner types." });
  await until(`document.querySelectorAll("#qtUnread:not([hidden])").length === 1`);
  expect(await ev(`document.activeElement?.value`)).toBe("The badge still counts the old board");
  await type(".");
  await key("Enter");
  await until(`document.querySelector(${JSON.stringify(`${row(ids.tab)} .tag.rs`)})?.textContent === "OPEN"`);
  await until(toasted(`REQUEST #${ids.tab} IS OPEN AGAIN. HQ IS TOLD.`));
  expect(await count("#work [data-rq-re]")).toBe(0);
  expect(await say(`${row(ids.tab)} .moved`)).toContain("reopened: The badge still counts the old board.");
  expect(herdr.typed().some(([to, text]) => to === "hq" && text.includes(`reopened request #${ids.tab}: The badge still counts the old board.`))).toBe(true);
  // Delivered again, it is news again: seen once more.
  await post(`/api/requests/${ids.tab}/deliver`, { link: "#brief/" + ids.briefNew, text: "The badge counts your requests." }, HQ);
  await until(`document.querySelector(${JSON.stringify(`${row(ids.tab)} .tag.rs`)})?.textContent === "DELIVERED"`);
  expect(await ev(`document.querySelector(${JSON.stringify(`${row(ids.tab)} .out a`)}).getAttribute("href")`)).toBe(`#brief/${ids.briefNew}`);
  await until(`fetch("/api/requests/${ids.tab}").then((r) => r.json()).then((d) => !!d.request.seenAt && d.moves.filter((m) => m.kind === "seen").length === 2)`);
  expect(errors).toEqual([]);
}, 30_000);

walk("CLOSE on one that is over takes it off at once; on one still on its way it asks first", async () => {
  await click(`${row(ids.vendor)} [data-rq-toggle]`);
  await click(`${row(ids.vendor)} [data-rq-close]`);
  await until(`!document.querySelector(${JSON.stringify(row(ids.vendor))})`);
  expect(await count(".confirm")).toBe(0);
  expect(await requestOf("Try the other vendor")).toBeUndefined();
  await click(`${row(ids.invoices)} [data-rq-toggle]`);
  await click(`${row(ids.invoices)} [data-rq-close]`);
  await until(`!!document.querySelector(".confirm")`);
  expect(await say(".confirm p")).toBe(`Close request #${ids.invoices}? It leaves this list and HQ stops tracking it.`);
  await click(".confirm .confirmno");
  await until(`!document.querySelector(".confirm")`);
  expect((await requestOf("Can we get the invoices")).status).toBe("new");
  await click(`${row(ids.invoices)} [data-rq-close]`);
  await click(".confirm .confirmyes");
  await until(`!document.querySelector(${JSON.stringify(row(ids.invoices))})`);
  expect(await rows()).toEqual([ids.deploy, ids.report, ids.tab]);
  // Nothing is deleted: it is closed, with who closed it.
  expect((await (await fetch(`${server.base}/api/requests/${ids.invoices}`)).json()).request).toMatchObject({ status: "closed", closedWhy: "closed by the owner" });
}, 30_000);

walk("seen, then a day passes: the delivered row leaves by itself", async () => {
  expect((await requestOf("Remove the work tab")).seenAt).toBeGreaterThan(0);
  // The day passes in the throwaway database: the server's own clock is the machine's.
  const db = new Database(join(data, "hud.db"));
  db.query("UPDATE requests SET seen_at = seen_at - ? WHERE id = ?").run(DAY + 60_000, ids.tab);
  db.close();
  await post("/api/sync");
  await until(`!document.querySelector(${JSON.stringify(row(ids.tab))})`);
  expect(await rows()).toEqual([ids.deploy, ids.report]);
  expect(await say("#work .rsum")).toBe("2 REQUESTS");
}, 30_000);

walk("unmoved for more than a day: the row turns amber by itself and the badge counts it, on every tab", async () => {
  // Two seconds short of a day after the last movement of the newest row.
  const last = Math.max(...(await state()).requests.map((x: any) => x.movedAt));
  await load({ shift: last + DAY - 2000 - Date.now() });
  await until(`document.querySelectorAll("#work [data-rq]").length === 2`);
  expect(await count("#work .rq.stale")).toBeLessThan(2);
  await until(`document.querySelectorAll("#work .rq.stale").length === 2`, 15_000);
  expect(await badge()).toBe("2");
  expect(await say(`${row(ids.deploy)} .moved .when`)).toMatch(/^no movement for (23|24)h$/);
  expect(await say("#work .rsum")).toBe("2 REQUESTS · 2 UNMOVED FOR OVER A DAY");
  // Amber, not red: the tab's badge is the colour of the amber rows' edge family, never the question count's.
  expect(await fill("#qtStalled")).not.toBe(await fill("#qtCount"));
  expect(await fill("#qtStalled")).toBe(await fill("#qtUnread"));
  // NEEDS YOU is as it was: the badge stays, no strip takes room over the questions.
  await click('[data-qtab="questions"]');
  await until(`!document.getElementById("hud").hidden`);
  expect(await badge()).toBe("2");
  expect(await ev(`document.getElementById("stall").hidden`)).toBe(true);
  // HQ moves one: it is amber no more, at once.
  await post(`/api/requests/${ids.deploy}/move`, { text: "merged, deploying tonight" }, HQ);
  await until(`document.getElementById("qtStalled").textContent === "1"`);
  expect(errors).toEqual([]);
}, 40_000);

walk("inside a floor, that floor's requests and count; in the building, every floor's, each marked", async () => {
  await post("/api/floors", { id: "pay", name: "Payments", hq: "hq-pay" });
  ids.refunds = await tell("Refunds over the limit need my yes.", "pay");
  await load({ shift: 2 * DAY });
  await until(`document.querySelectorAll("#work [data-rq]").length === 3`);
  expect(await rows()).toEqual([ids.deploy, ids.report, ids.refunds]);
  expect(await count("#work [data-rq] .meta .fstripe")).toBe(3);
  expect(await badge()).toBe("3");
  await load({ shift: 2 * DAY, floor: "pay" });
  await until(`document.querySelectorAll("#work [data-rq]").length === 1`);
  expect(await rows()).toEqual([ids.refunds]);
  expect(await count("#work [data-rq] .meta .fstripe")).toBe(0);
  expect(await badge()).toBe("1");
}, 40_000);

for (const theme of ["light", "dark"] as const) {
  walk(`a phone, ${theme}: rows fit, every control is a 44 px target, a tap opens the history, text reads`, async () => {
    await post(`/api/requests/${ids.refunds}/assign`, { lane: "hq-pay", issue: "PAY-7", pr: "https://example.com/acme/pay/pull/31" }, "w2:p1").catch(() => {});
    await post(`/api/requests/${ids.refunds}/deliver`, { link: "https://example.com/a/very/long/path/that/never/breaks/because/it/has/no/spaces/at/all/report.html", text: "Refunds over the limit wait for your yes." }, "w2:p1").catch(() => {});
    await load({ w: 390, h: 844, mobile: true, theme, shift: 2 * DAY });
    await until(`document.querySelectorAll("#work [data-rq]").length === 3`);
    await ev(`document.fonts.ready.then(() => true)`);
    await tap(`${row(ids.deploy)} .words`);
    await until(`!!document.querySelector(${JSON.stringify(`${row(ids.deploy)} .rqmoves li`)})`);
    await tap(`${row(ids.refunds)} [data-rq-reopen]`);
    await until(`!!document.querySelector("#work [data-rq-re] input")`);
    const m = await ev(MEASURE);
    expect(m.spills).toEqual([]);
    expect(m.scrollers).toEqual([]);
    expect(m.clipped).toEqual([]);
    expect(m.scrollW).toBeLessThanOrEqual(m.vw);
    expect((await ev(AUDIT)).taps).toEqual([]);
    expect(await ev(LOW)).toEqual([]);
    expect(await ev(`document.documentElement.dataset.theme`)).toBe(theme);
    await tap("#work [data-rq-cancel]");
    await until(`!document.querySelector("#work [data-rq-re]")`);
    expect(errors).toEqual([]);
  }, 40_000);
}

walk("desktop, both themes: every text on the tab reads on its row", async () => {
  for (const theme of ["light", "dark"] as const) {
    await load({ theme, shift: 2 * DAY });
    await until(`document.querySelectorAll("#work [data-rq]").length === 3`);
    await click(`${row(ids.deploy)} [data-rq-toggle]`);
    await until(`!!document.querySelector("#work .rqmoves li")`);
    expect(await ev(LOW)).toEqual([]);
  }
}, 40_000);

walk("HQ's long movement is clipped with MORE; an imported row can wait on him with no question yet", async () => {
  const long = `Tried three ways. ${"The second one held under the nightly run and the third did not. ".repeat(6)}The end of it.`;
  await post(`/api/requests/${ids.deploy}/move`, { text: long }, HQ);
  expect((await requestOf("Deploys must never")).moved).toBe(long); // whole from the server: the page clips it
  const table = "| # | Date | Request | Owner | Status | Next step | Last moved |\n|---|---|---|---|---|---|---|\n| R1 | 4 Nov | Pick the name for the plan | hq | WAITING-OWNER | he picks one | 5 Nov |";
  await post("/api/requests/import", { text: table }, HQ);
  const waits = await requestOf("Pick the name for the plan");
  expect(waits).toMatchObject({ status: "waiting", ask: null });
  await load();
  await until(`!!document.querySelector(${JSON.stringify(row(waits.id))})`);
  expect(await say(`${row(waits.id)} .tag.rs`)).toBe("WAITING ON YOU");
  expect(await count(`${row(waits.id)} a[href^="#ask/"]`)).toBe(0);
  expect((await rows())[0]).toBe(waits.id); // sent on 4 Nov: the oldest, so first
  const moved = `${row(ids.deploy)} .moved .what`;
  expect(await say(moved)).toMatch(/^Tried three ways\. .*… MORE$/);
  expect((await say(moved)).length).toBeLessThan(260);
  await click(`${moved} .more`);
  await until(`document.querySelector(${JSON.stringify(moved)}).textContent.includes("The end of it.")`);
  expect(await say(`${moved} .more`)).toBe("LESS");
  expect(await count("#work .rqhist")).toBe(0); // MORE is not a tap on the row
  await click(`${moved} .more`);
  await until(`!document.querySelector(${JSON.stringify(moved)}).textContent.includes("The end of it.")`);
  expect(errors).toEqual([]);
}, 30_000);

walk("nothing open: one quiet line", async () => {
  for (const x of (await state()).requests) await post(`/api/requests/${x.id}/close`);
  await load();
  await until(`!!document.querySelector("#work .empty")`);
  expect(await say("#work")).toBe("Nothing open. What you ask HQ for shows here until it is delivered.");
  expect(await badge()).toBe(null);
}, 30_000);

// ---- age-out: display only ----

walk("MESSAGES: threads older than 7 days wait behind OLDER (N) at the top; one still new from HQ stays", async () => {
  await post("/api/notes", { text: "A note from today." });
  const s = await state();
  const old = s.notes.filter((n: any) => n.at < tMid).length + s.updates.filter((u: any) => u.at < tMid && u.read_at).length + s.answered.filter((a: any) => a.answered_at && a.answered_at < tMid).length;
  const unread = s.updates.filter((u: any) => u.at < tMid && !u.read_at).length; // "Halfway there" and a line per brief
  expect([old > 4, unread]).toEqual([true, 3]);
  await load({ tab: "messages", frozen: tMid + 7 * DAY });
  await until(`!!document.querySelector("#msgs [data-older]")`);
  // The updates from before were never opened: they stay, marked NEW, whatever their age.
  expect(await say("#msgs [data-older]")).toBe(`OLDER (${old})`);
  expect(await ev(`document.querySelector("#msgs").firstElementChild.matches("[data-older]")`)).toBe(true);
  const shown = await ev(`[...document.querySelectorAll("#msgs [data-msg] h3, #msgs [data-msg] .text")].map((e) => e.textContent.trim())`);
  expect(shown).toContain("A note from today.");
  expect(shown).toContain("Halfway there");
  expect(shown).not.toContain("Make the weekly report shorter.");
  await click("#msgs [data-older]");
  await until(`document.querySelector("#msgs [data-older]").textContent === "HIDE OLDER"`);
  expect(await ev(`[...document.querySelectorAll("#msgs [data-msg] .text")].map((e) => e.textContent.trim())`)).toContain("Make the weekly report shorter.");
  expect(await count("#msgs [data-msg]")).toBe(await ev(`fetch("/api/state").then((r) => r.json()).then((s) => s.notes.length + s.updates.length + s.answered.filter((a) => a.answered_at && a.status !== "withdrawn").length)`));
  await click("#msgs [data-older]");
  await until(`document.querySelector("#msgs [data-older]").textContent.startsWith("OLDER (")`);
  // Read now, the old updates fold with the rest the next time the tab opens.
  await click('[data-qtab="questions"]');
  await click('[data-qtab="messages"]');
  await until(`document.querySelector("#msgs [data-older]")?.textContent === "OLDER (${old + unread})"`);
  expect(errors).toEqual([]);
}, 40_000);

walk("MESSAGES with nothing old has no toggle", async () => {
  await load({ tab: "messages" });
  await until(`document.querySelectorAll("#msgs [data-msg]").length > 4`);
  expect(await count("#msgs [data-older]")).toBe(0);
}, 30_000);

walk("BRIEFS: the last 14 days; the older wait behind OLDER (N) at the end, an unopened one stays", async () => {
  const fresh = (await post("/api/briefs", { title: "This week", body: "News." }, HQ)).id;
  await load({ tab: "briefs", frozen: tMid + 14 * DAY });
  await until(`!!document.querySelector("#briefs [data-older]")`);
  const hrefs = () => ev(`[...document.querySelectorAll("#briefs .brow")].map((a) => a.getAttribute("href"))`);
  expect(await hrefs()).toEqual([`#brief/${fresh}`, `#brief/${ids.briefNew}`]);
  expect(await say("#briefs [data-older]")).toBe("OLDER (1)");
  expect(await ev(`document.querySelector("#briefs").lastElementChild.matches("[data-older]")`)).toBe(true);
  expect(await say("#briefs .bsum")).toBe("2 BRIEFS · 2 NEW · LAST 14 DAYS");
  await click("#briefs [data-older]");
  await until(`document.querySelectorAll("#briefs .brow").length === 3`);
  expect(await hrefs()).toEqual([`#brief/${fresh}`, `#brief/${ids.briefNew}`, `#brief/${ids.briefRead}`]);
  expect(await say("#briefs [data-older]")).toBe("HIDE OLDER");
  await click("#briefs [data-older]");
  await until(`document.querySelectorAll("#briefs .brow").length === 2`);
  // With the clock as it is, nothing is old.
  await load({ tab: "briefs" });
  await until(`document.querySelectorAll("#briefs .brow").length === 3`);
  expect(await count("#briefs [data-older]")).toBe(0);
  expect(errors).toEqual([]);
}, 40_000);
