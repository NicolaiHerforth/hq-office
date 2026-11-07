// Everything that can change the height of NEEDS YOU, as scenes any browser can walk: real wheel, real clicks, real
// typing, real pushes from a throwaway server, and a proxy that holds a web font or an image back until it is let go.
// Each frame is sampled in the page, so a jump that is corrected a moment later still counts.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "../fake-herdr.ts";
import { newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

export type Driver = {
  ev: (code: string) => Promise<any>;
  wheel: (x: number, y: number, dy: number) => Promise<void>;
  click: (x: number, y: number) => Promise<void>;
  type: (text: string) => Promise<void>;
  key: (key: string, ctrl?: boolean) => Promise<void>;
  goto: (url: string) => Promise<void>;
  reload: () => Promise<void>;
};
// Real input in headless Chrome, through the DevTools protocol.
export async function chromeDriver(width: number, height: number, opts: { touch?: boolean } = {}) {
  const chrome = await startChrome(), errors: string[] = [];
  const page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: opts.touch ? 3 : 1, mobile: !!opts.touch });
  if (opts.touch) await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const tap = async (x: number, y: number) => { await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
  const driver: Driver = {
    ev: page.evaluate,
    wheel: async (x, y, dy) => {
      if (opts.touch) await page.s("Input.synthesizeScrollGesture", { x, y, yDistance: -dy, gestureSourceType: "touch", speed: 12000, preventFling: true });
      else await page.s("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
    },
    click: async (x, y) => {
      if (opts.touch) return tap(x, y);
      await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    type: async (text) => { await page.s("Input.insertText", { text }); },
    key: async (key, ctrl = false) => {
      const code = { ArrowDown: 40, ArrowUp: 38, Tab: 9, Enter: 13, Escape: 27 }[key] ?? 0, modifiers = ctrl ? 2 : 0;
      await page.s("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, modifiers, windowsVirtualKeyCode: code, text: key === "Enter" ? "\r" : undefined });
      await page.s("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, modifiers, windowsVirtualKeyCode: code });
    },
    goto: async (url) => { await page.s("Page.navigate", { url }); },
    reload: async () => { await page.evaluate(`setTimeout(() => location.reload(), 0), true`); await Bun.sleep(500); },
  };
  return { driver, errors, close: () => chrome.close() };
}
// Playwright's WebKit, when NEEDS_PLAYWRIGHT names an installed playwright: real wheel, no Safari, no window. This build
// anchors by default, unlike the Safari it stands in for, so a walk turns that off.
export async function webkitDriver(width: number, height: number) {
  const { webkit } = await import(process.env.NEEDS_PLAYWRIGHT!);
  const b = await webkit.launch({ headless: true });
  const p = await (await b.newContext({ viewport: { width, height } })).newPage();
  const errors: string[] = [];
  p.on("pageerror", (e: Error) => errors.push(e.message));
  const driver: Driver = {
    ev: (code) => p.evaluate(code),
    wheel: async (x, y, dy) => { await p.mouse.move(x, y); await p.mouse.wheel(0, dy); },
    click: async (x, y) => { await p.mouse.click(x, y); },
    type: async (text) => { await p.keyboard.insertText(text); },
    key: async (key, ctrl = false) => { if (ctrl) await p.keyboard.down("Control"); await p.keyboard.press(key); if (ctrl) await p.keyboard.up("Control"); },
    goto: async (url) => { await p.goto(url, { waitUntil: "commit" }); },
    reload: async () => { await p.reload({ waitUntil: "commit" }); },
  };
  return { driver, errors, close: () => b.close() };
}

export type Shift = { scene: string; settled: number; peak: number; moved: boolean; note?: string; options?: number };

const LONG = "A long question body that takes up room on the screen, as the long ones do. ".repeat(14);
const FONT = readFontOrNull();
function readFontOrNull() { try { return readFileSync("/System/Library/Fonts/Supplemental/Verdana.ttf"); } catch { return null; } }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==", "base64");
// Tall enough to move everything under it when it lands: the thumb's box is set by its own size.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="500"><rect width="600" height="500" fill="#888"/></svg>`;

// In front of the server: the page's web font and any /__late/ file wait until let go.
export function lateProxy(base: string) {
  const held = new Map<string, { go: Promise<void>; let: () => void }>();
  const hold = (name: string) => { let go = () => {}; const p = new Promise<void>((ok) => { go = ok; }); held.set(name, { go: p, let: go }); };
  const proxy = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (/^\/(__late|uploads\/late)/.test(url.pathname)) {
        const name = url.pathname.split("/").pop()!;
        await held.get(name)?.go;
        if (name.endsWith(".ttf")) return new Response(FONT, { headers: { "content-type": "font/ttf", "access-control-allow-origin": "*" } });
        if (name.endsWith(".svg")) return new Response(SVG, { headers: { "content-type": "image/svg+xml" } });
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      const headers = new Headers(req.headers);
      headers.delete("host"); headers.set("origin", base); headers.delete("accept-encoding");
      const res = await fetch(`${base}${url.pathname}${url.search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
      if (url.pathname === "/" && res.headers.get("content-type")?.includes("html")) {
        const face = `<style>@font-face{font-family:"Nunito";src:url(/__late/font.ttf) format("truetype");font-display:swap;font-weight:100 900}</style>`;
        const html = (await res.text()).replace(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/, face);
        const h = new Headers(res.headers); h.delete("content-length"); h.delete("content-encoding");
        return new Response(html, { status: res.status, headers: h });
      }
      return new Response(res.body, { status: res.status, headers: res.headers });
    },
  });
  return { base: `http://127.0.0.1:${proxy.port}`, hold, go: (name: string) => held.get(name)?.let(), stop: () => proxy.stop(true) };
}

// Read after the frame is painted: a layout read inside requestAnimationFrame comes before the ResizeObserver that
// corrects the frame, and would count a position nobody ever saw.
const SAMPLER = `(() => {
  if (window.__sampler) return;
  window.__sampler = { id: null, base: 0, peak: 0, last: 0, frames: 0 };
  const s = window.__sampler, port = new MessageChannel();
  port.port1.onmessage = () => {
    const c = s.id && document.querySelector('#hud [data-ask="' + s.id + '"] h3');
    if (c) { const t = c.getBoundingClientRect().top; s.last = t; s.frames++; s.peak = Math.max(s.peak, Math.abs(t - s.base)); }
    // What you tap, not only what you read: the last option, or the box.
    const o = s.id && document.querySelector('#hud [data-ask="' + s.id + '"] .opt:last-child, #hud [data-ask="' + s.id + '"] textarea');
    if (o && s.optBase != null) s.optPeak = Math.max(s.optPeak, Math.abs(o.getBoundingClientRect().top - s.optBase));
  };
  const frame = () => { port.port2.postMessage(0); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})()`;

export async function startDesk(root: string, drive: () => Promise<Driver>, opts: { width: number; height: number; noAnchor?: boolean; noLedger?: boolean; floors?: boolean; env?: Record<string, string>; seed?: (post: (path: string, body: object) => Promise<any>) => Promise<number[]> }) {
  // A second floor needs a herdr that knows its HQ.
  const dir = opts.floors ? mkdtempSync(join(tmpdir(), "hq-needs-")) : null;
  const agent = (name: string) => ({ name, agent_status: "idle", pane_id: `p-${name}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" });
  const herdr = dir ? fakeHerdr(dir, ["hq", "hq-crm", "golf", "alpha"].map(agent)) : null;
  const server = await startServer(root, { ...(herdr ? { HERDR_BIN: herdr.bin } : {}), ...opts.env });
  const post = server.post;
  if (opts.floors) { await post("/api/sync", {}); await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" }); }
  for (const name of ["golf", "alpha"]) await post("/api/lanes", { name, machine: "local" });
  const ids: number[] = [], late = lateProxy(server.base);
  late.hold("font.ttf"); late.hold("late-above.svg"); late.hold("late-own.svg");
  const MID = 20;
  // A walk that brings its own questions has none of these.
  if (opts.seed) ids.push(...await opts.seed(post));
  for (let i = 1; i <= 40 && !opts.seed; i++) {
    const kind = ["decision", "action", "info"][i % 3];
    const body = i === MID - 3 ? "A late picture above. [image: /x/late-above.svg]" : i === MID ? `${LONG} [image: /x/late-own.svg]` : i % 4 === 0 ? LONG : undefined;
    const a = await post("/api/asks", { title: `Question ${i}: ${i % 5 === 0 ? "a title that goes on and on across a few lines of the list's column, as they do" : "short"}`, kind, lane: i % 2 ? "alpha" : "golf", body, options: kind === "decision" ? ["Yes", "No", "Later"] : undefined });
    ids.push(a.id);
    if (i % 3 === 0 && !opts.noLedger) { await post(`/api/asks/${a.id}/comment`, { text: "HQ's note on this one, with enough words to take up a line or two of the card." }); await post(`/api/asks/${a.id}/items`, { text: "First check" }); }
  }
  const PAGE = `<!doctype html><html><body style="margin:0"><div id="g" style="height:60px">a page</div><script>addEventListener("message",(e)=>{if(e.data&&e.data.tall)parent.postMessage({"hud-ask-height":e.data.tall},"*");});</script></body></html>`;
  const framed = opts.seed ? { id: 0 } : await post("/api/asks", { title: "A question with a page", kind: "decision", options: ["Yes", "No"], body: PAGE, lane: "golf" });
  for (let i = 1; i <= 12 && !opts.seed; i++) await post("/api/asks", { title: `Under the page ${i}`, kind: "decision", options: ["Yes", "No"], lane: "alpha" });
  const d = await drive();
  const ev = d.ev;
  const until = async (expr: string, ms = 15_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(60)) if (await ev(expr).catch(() => false)) return;
    throw new Error(`timed out waiting for ${expr}`);
  };
  await d.goto(`${late.base}/`);
  await until(`document.querySelectorAll("#hud .ask").length >= ${opts.seed ? ids.length : 41}`);
  await ev(SAMPLER);
  if (opts.noAnchor) await ev(`(() => { const s = document.createElement("style"); s.textContent = "* { overflow-anchor: none !important; }"; document.head.append(s); })()`);
  await Bun.sleep(600);

  const target = ids[MID - 1];
  const card = (id: number) => `document.querySelector('#hud [data-ask="${id}"]')`;
  const count = () => ev(`document.querySelectorAll("#hud .ask").length`) as Promise<number>;
  const openIds = async () => (await (await fetch(`${server.base}/api/state`)).json()).open.map((a: { id: number }) => a.id) as number[];
  const hud = () => ev(`(() => { const r = document.getElementById("hud").getBoundingClientRect(), a = Math.max(r.top, 0), b = Math.min(r.bottom, innerHeight); return { x: r.x + r.width / 2, y: b > a + 40 ? (a + b) / 2 : innerHeight / 2 }; })()`);
  // Real wheel steps until the card's title sits this far under the top of the list.
  async function wheelTo(id: number, below = 150, keepFocus = false) {
    if (!keepFocus) await d.ev(`document.activeElement?.blur?.()`);
    for (let i = 0; i < 40; i++) {
      const h = await hud();
      // Under the list's top where it scrolls itself, under the sticky row where the page scrolls.
      const line = await ev(`(() => { const n = document.querySelector(".asknav"), t = document.getElementById("hud").getBoundingClientRect().top; return innerWidth < 1151 && n ? n.getBoundingClientRect().bottom : t; })()`);
      const t = await ev(`${card(id)}.querySelector("h3").getBoundingClientRect().top`);
      const dy = t - (line + below);
      if (Math.abs(dy) < 2) return;
      await d.wheel(h.x, h.y, dy);
      await Bun.sleep(120);
    }
    throw new Error(`the wheel could not bring ${id} to ${below}`);
  }
  async function clickEl(sel: string) {
    const r = await ev(`(() => { const e = ${sel}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await d.click(r.x, r.y);
  }
  const arm = (id: number) => ev(`${SAMPLER}; (() => { const s = window.__sampler, c = document.querySelector('#hud [data-ask="${id}"] h3'); o = document.querySelector('#hud [data-ask="${id}"] .opt:last-child, #hud [data-ask="${id}"] textarea'); s.id = "${id}"; s.base = c.getBoundingClientRect().top; s.peak = 0; s.frames = 0; s.optBase = o ? o.getBoundingClientRect().top : null; s.optPeak = 0; })()`);
  const read = () => ev(`(() => { const s = window.__sampler; return { last: s.last, base: s.base, peak: s.peak, optPeak: s.optPeak, frames: s.frames, height: document.getElementById("hud").scrollHeight }; })()`);
  const results: Shift[] = [];
  // One scene: put the card under the eye, change something, wait, read how far it moved in any frame and at the end.
  async function scene(name: string, change: () => Promise<void>, o: { on?: number; note?: string; keepFocus?: boolean } = {}) {
    const on = o.on ?? target;
    await wheelTo(on, 150, o.keepFocus);
    await Bun.sleep(150);
    await arm(on);
    const before = (await read()).height;
    await change();
    await Bun.sleep(900);
    const r = await read();
    const res = { scene: name, settled: Math.round(Math.abs(r.last - r.base)), peak: Math.round(r.peak), moved: r.height !== before, note: o.note, options: Math.round(r.optPeak) };
    results.push(res);
    return res;
  }
  const hoursAbove = async () => { const all = await openIds(); return all.slice(Math.max(0, all.indexOf(target) - 12), all.indexOf(target) - 2).reverse().find((x) => x !== ids[MID - 4]) as number; };
  const hoursBelow = async () => { const all = await openIds(); return all[all.indexOf(target) + 6]; };
  async function grew(n: number) { await until(`document.querySelectorAll("#hud .ask").length === ${n}`); }

  return {
    server, late, ev, d, ids, target, framed: framed.id, until, card, count, openIds, wheelTo, clickEl, scene, results, arm, read, grew, above: hoursAbove, below: hoursBelow,
    stop: async () => { await d.goto("about:blank").catch(() => {}); late.stop(); await server.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); },
  };
}
type Desk = Awaited<ReturnType<typeof startDesk>>;

// Each entry is one way the list's height changes. Kept in the order that spends the fewest questions.
export const SCENES: [string, (k: Desk) => Promise<unknown>][] = [
  ["a new question at the end", async (k) => k.scene("a new question at the end", async () => { const n = await k.count(); await k.server.post("/api/asks", { title: "Arrived at the end", kind: "decision", options: ["Yes"], lane: "golf" }); await k.grew(n + 1); })],
  ["you pick an option on your card", async (k) => {
    const id = await k.ev(`${JSON.stringify(await k.openIds())}.find((x) => document.querySelector('#hud [data-ask="' + x + '"] .opt'))`) as number;
    return k.scene("you pick an option on your card", async () => { await k.clickEl(`${k.card(id)}.querySelector(".opt")`); await k.until(`${k.card(id)}.dataset.mark === "DRAFT"`); await k.clickEl(`${k.card(id)}.querySelector(".opt")`); }, { on: id });
  }],
  ["a due question sorts to the top", async (k) => k.scene("a due question sorts to the top", async () => { const n = await k.count(); await k.server.post("/api/asks", { title: "Arrived, due soon, sorts first", kind: "decision", options: ["Yes"], lane: "golf", due: Date.now() + 3600_000 }); await k.grew(n + 1); })],
  ["a card above is answered", async (k) => k.scene("a card above is answered", async () => { const n = await k.count(); await k.server.post(`/api/asks/${await k.above()}/answer`, { answer: "Yes" }); await k.grew(n - 1); })],
  ["a card above is withdrawn", async (k) => k.scene("a card above is withdrawn", async () => { const n = await k.count(); await k.server.post(`/api/asks/${await k.above()}/withdraw`, { reason: "no longer needed" }); await k.grew(n - 1); })],
  ["a card below is answered", async (k) => k.scene("a card below is answered", async () => { const n = await k.count(); await k.server.post(`/api/asks/${await k.below()}/answer`, { answer: "Yes" }); await k.grew(n - 1); })],
  ["a card above is edited longer", async (k) => k.scene("a card above is edited longer", async () => { await k.server.post(`/api/asks/${await k.above()}/update`, { body: LONG }); })],
  ["a comment lands on a card above", async (k) => k.scene("a comment lands on a card above", async () => { await k.server.post(`/api/asks/${await k.above()}/comment`, { text: "A new comment from HQ on a card above, long enough to take a line." }); })],
  ["a checklist lands on a card above", async (k) => k.scene("a checklist lands on a card above", async () => { await k.server.post(`/api/asks/${await k.above()}/items`, { text: "A new item on the checklist" }); })],
  ["a comment lands on your card", async (k) => k.scene("a comment lands on your card", async () => { await k.server.post(`/api/asks/${k.target}/comment`, { text: "A new comment from HQ on the card you read, long enough to take a line." }); })],
  ["a checklist lands on your card", async (k) => k.scene("a checklist lands on your card", async () => { await k.server.post(`/api/asks/${k.target}/items`, { text: "A new item on the checklist" }); })],
  ["MORE on your card", async (k) => k.scene("MORE on your card", async () => { await k.clickEl(`${k.card(k.target)}.querySelector(".more")`); await k.until(`${k.card(k.target)}.querySelector(".more")?.textContent === "LESS"`); })],
  ["an image above lands late", async (k) => k.scene("an image above lands late", async () => { k.late.go("late-above.svg"); })],
  ["an image on your card lands late", async (k) => k.scene("an image on your card lands late", async () => { k.late.go("late-own.svg"); })],
  ["the web font lands late", async (k) => k.scene("the web font lands late", async () => { k.late.go("font.ttf"); })],
  ["a draft, then a push rebuilds", async (k) => {
    const on = k.ids[28];
    await k.wheelTo(on);
    await k.clickEl(`${k.card(on)}.querySelector("textarea")`);
    await k.until(`document.activeElement === ${k.card(on)}.querySelector("textarea")`);
    await k.d.type("A draft.");
    return k.scene("a draft, then a push rebuilds", async () => { const n = await k.count(); await k.server.post("/api/asks", { title: "Another arrival", kind: "info", lane: "golf" }); await k.grew(n + 1); }, { on, keepFocus: true });
  }],
  ["the box grows as you type", async (k) => {
    const on = k.ids[28];
    await k.wheelTo(on);
    await k.clickEl(`${k.card(on)}.querySelector("textarea")`);
    await k.until(`document.activeElement === ${k.card(on)}.querySelector("textarea")`);
    return k.scene("the box grows as you type", async () => { await k.d.type(Array.from({ length: 5 }, (_, i) => ` Line ${i} of a draft that wraps a little, as long as a sentence goes, and then wraps again on a narrow column.`).join(" ")); }, { on, keepFocus: true });
  }],
  ["a page's frame above takes its height", async (k) => {
    const all = await k.openIds();
    const framedAt = all.indexOf(k.framed);
    const under = all[framedAt + 3];
    if (!under) throw new Error("no card under the page");
    if (!(await k.ev(`!!${k.card(k.framed)}.querySelector("iframe.askframe")`))) return k.results.push({ scene: "a page's frame above takes its height", settled: -1, peak: -1, moved: false, note: "no frame" });
    await k.until(`${k.card(k.framed)}.querySelector("iframe.askframe").getBoundingClientRect().height > 30`);
    return k.scene("a page's frame above takes its height", async () => {
      const was = await k.ev(`${k.card(k.framed)}.getBoundingClientRect().height`);
      if (!(await k.ev(`${k.card(k.framed)}.getBoundingClientRect().bottom < ${k.card(under)}.getBoundingClientRect().top`))) throw new Error("the page's frame is not above the card");
      await k.ev(`${k.card(k.framed)}.querySelector("iframe.askframe").contentWindow.postMessage({ tall: 200 }, "*")`);
      await k.until(`${k.card(k.framed)}.getBoundingClientRect().height > ${was} + 20`);
    }, { on: under });
  }],
  ["your card leaves (withdrawn)", async (k) => {
    const all = await k.openIds(), id = all[all.indexOf(k.target) + 3];
    const next = all[all.indexOf(id) + 1];
    await k.wheelTo(id);
    await Bun.sleep(150);
    await k.arm(next);
    const n = await k.count();
    const baseBefore = await k.ev(`${k.card(id)}.getBoundingClientRect().top`);
    await k.server.post(`/api/asks/${id}/withdraw`, { reason: "gone" });
    await k.grew(n - 1);
    await Bun.sleep(900);
    const landed = await k.ev(`${k.card(next)}.getBoundingClientRect().top`);
    k.results.push({ scene: "your card leaves (withdrawn)", settled: Math.round(Math.abs(landed - baseBefore)), peak: -1, moved: true, note: "the next card takes its place" });
  }],
  ["you answer your card", async (k) => {
    const all = await k.openIds(), id = all[all.indexOf(k.target) + 2];
    const next = all[all.indexOf(id) + 1];
    await k.wheelTo(id);
    await Bun.sleep(150);
    const n = await k.count();
    const baseBefore = await k.ev(`${k.card(id)}.getBoundingClientRect().top`);
    const opt = await k.ev(`!!${k.card(id)}.querySelector(".opt")`);
    if (opt) await k.clickEl(`${k.card(id)}.querySelector(".opt")`);
    await k.until(`!${k.card(id)}.querySelector(".send").disabled`);
    await k.clickEl(`${k.card(id)}.querySelector(".send")`);
    await k.grew(n - 1);
    await Bun.sleep(900);
    const landed = await k.ev(`${k.card(next)}.getBoundingClientRect().top`);
    k.results.push({ scene: "you answer your card", settled: Math.round(Math.abs(landed - baseBefore)), peak: -1, moved: true, note: "the next card takes its place" });
  }],
];

export const table = (rows: Shift[]) => rows.map((r) => `${String(r.settled).padStart(5)} ${String(r.peak).padStart(5)}  ${r.moved ? "height" : "same  "}  ${r.scene}${r.note ? ` (${r.note})` : ""}`).join("\n");

// When the hold began and ended and when a press landed, by the page's own clock: a walk's own timing is late by however busy
// the machine is, and the hold is short.
export const HOLD_MS = 400;
export const HOLD_CLOCK = `(() => { if ("__heldAt" in window) return; window.__heldAt = 0; window.__freeAt = 0; window.__pressAt = 0; let was = false; new MutationObserver(() => { const on = document.documentElement.classList.contains("unready"), now = performance.now(); if (on && !was) window.__heldAt = now; if (!on && was) window.__freeAt = now; was = on; }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); addEventListener("click", () => { window.__pressAt = performance.now(); }, true); })()`;
// A press this many ms into the hold. Says how far in it landed: from HOLD_MS on, it tells nothing about the hold.
export async function pressIntoHold(k: { ev: (e: string) => Promise<any>; d: Driver }, at: { x: number; y: number }, ms: number) {
  const since = await k.ev(`performance.now() - window.__heldAt`) as number;
  if (since < ms) await Bun.sleep(ms - since);
  await k.d.click(at.x, at.y);
  return await k.ev(`window.__pressAt - window.__heldAt`) as number;
}
