// The building, in Chrome, on an office with a general (test/floors-fixture.ts: three floors, HQ, FIN and SALES) at 1440
// and at 390: zoomed out every floor is a live tile; a click zooms into a floor and scopes the queue and messages to it;
// ◀ ALL FLOORS and BUILDING go all the way out, ✕ and Escape one level; floor tags show on questions and messages; each
// terminal reads its floor's general; a floor out of sight draws nothing. And on an office with one floor (this
// installation's shape) none of it is on the page. Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { findChrome, newSession, startChrome } from "../../scripts/room-hash.ts";
import { FACTS, startFloors } from "../floors-fixture.ts";

const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let general: Awaited<ReturnType<typeof startFloors>>;
let single: Awaited<ReturnType<typeof startFloors>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const ev = (expr: string) => page.evaluate(expr);
const SIZES: [number, number][] = [[1440, 900], [390, 844]];
const COLORS = { hq: "rgb(60, 111, 214)", fin: "rgb(47, 158, 87)", sales: "rgb(192, 122, 18)" } as Record<string, string>;
const CANVAS = { hq: "room", fin: "room-fin", sales: "room-sales" } as Record<string, string>;

// Every canvas's text, by canvas id: the terminal's label, and "YOU" once per frame, which counts a floor's frames.
const SPY = `(() => {
  window.__texts = {};
  const fill = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (t, ...a) {
    const id = this.canvas.id;
    if (id) { const o = (window.__texts[id] ??= {}); o[t] = (o[t] ?? 0) + 1; }
    return fill.call(this, t, ...a);
  };
})()`;
// Each floor's frames so far. A floor that has not drawn yet has 0: a test that zooms in and out quickly can sample
// before a floor's first frame.
const frames = () => ev(`Object.fromEntries(${JSON.stringify(Object.values(CANVAS))}.map((id) => [id, window.__texts[id]?.YOU ?? 0]))`) as Promise<Record<string, number>>;
const press = (key: string) => ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }))`);
const click = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const choose = (lane: string) => ev(`(() => { const b = document.createElement("button"); b.dataset.select = ${JSON.stringify(lane)}; document.body.append(b); b.click(); b.remove(); })()`);
// A floor grows from its tile for a moment; its size is the settled one.
const settled = () => ev(`Promise.all(document.getAnimations().map((a) => a.finished)).then(() => true)`);
const stageOf = () => ev(`document.querySelector(".room").dataset.stage ?? null`);
const scopeOf = () => ev(`JSON.parse(sessionStorage.getItem("hq-scope") ?? "null")`);
const chip = () => ev(`(() => { const c = document.querySelector(".scopechip"); return c && !c.hidden ? c.textContent : ""; })()`);
const shown = (sel: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; })()`);
const asks = () => ev(`[...document.querySelectorAll("#hud .ask")].map((a) => ({ lane: a.dataset.lane, tag: a.querySelector(".floortag")?.textContent ?? null }))`) as Promise<{ lane: string; tag: string | null }[]>;

// A fresh tab at a size: no scope kept from before, so the page opens as a new tab would.
async function open(base: string, width: number, height: number) {
  const phone = width < 600;
  await page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: phone });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: phone, maxTouchPoints: 5 });
  for (let i = 0; i < 2; i++) {
    await page.s("Page.navigate", { url: "about:blank" });
    await page.s("Page.navigate", { url: `${base}/` });
    await until(`!!document.getElementById("card")?.innerHTML`);
    if (!i) await ev(`sessionStorage.clear()`);
  }
}

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  general = await startFloors();
  single = await startFloors({ general: false });
  page = await newSession(chrome.cdp, errors);
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: SPY });
}, 60_000);

afterAll(async () => {
  await general?.stop();
  await single?.stop();
  await chrome?.close();
});

for (const [width, height] of SIZES) {
  const at = `${width}`;

  test.skipIf(!chromeFound)(`${at}: the page opens on the building, every floor a live tile with its tag, count and help dots`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll(".building .tile").length === 3`);
    expect(await stageOf()).toBe("out");
    expect(await ev(`[...document.querySelectorAll(".building .tile")].map((t) => t.dataset.floor)`)).toEqual(FACTS.floors);
    // the bar: BUILDING marked, no way back, the legend gone, nothing scoped
    expect(await shown(".stagebar [data-zoomout]")).toBe(false);
    expect(await ev(`document.querySelector(".stagebar [data-building]").classList.contains("on")`)).toBe(true);
    expect(await shown(".room .legend")).toBe(false);
    expect(await chip()).toBe("");
    expect(await shown(".scopeborder")).toBe(false);
    // each label: the floor's tag in its colour, what waits on you there, one dot per agent that needs help
    const labels = await ev(`[...document.querySelectorAll(".tile")].map((t) => ({ id: t.dataset.floor, tag: t.querySelector(".floortag").textContent, color: getComputedStyle(t.querySelector(".floortag")).backgroundColor, waiting: t.querySelector(".tlabel .count")?.textContent ?? "0", dots: t.querySelectorAll(".tlabel .dot").length }))`);
    expect(labels).toEqual([
      { id: "hq", tag: "HQ", color: COLORS.hq, waiting: String(FACTS.waiting.hq), dots: 2 },
      { id: "fin", tag: "FIN", color: COLORS.fin, waiting: String(FACTS.waiting.fin), dots: 1 },
      { id: "sales", tag: "SALES", color: COLORS.sales, waiting: String(FACTS.waiting.sales), dots: 1 },
    ]);
    // every tile is a room with a size, in a row of two (one on a phone), and on a laptop the page does not scroll
    const rects = await ev(`[...document.querySelectorAll(".tile .scene > canvas")].map((c) => { const r = c.getBoundingClientRect(); return { id: c.id, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; })`);
    expect(rects.map((r: any) => r.id)).toEqual(Object.values(CANVAS));
    for (const r of rects) expect(r.w).toBeGreaterThan(80);
    expect(Math.abs(rects[0].w / rects[0].h - 1.5)).toBeLessThan(0.03);
    if (width > 600) {
      expect(rects[1].y).toBe(rects[0].y); // two a row
      expect(rects[2].y).toBeGreaterThan(rects[0].y);
      expect(await ev(`document.documentElement.scrollHeight <= innerHeight`)).toBe(true);
    } else {
      expect(rects[1].y).toBeGreaterThan(rects[0].y);
      expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    }
    // all of them draw, and keep drawing
    await until(`Object.values(window.__texts).length >= 3`);
    const before = await frames();
    await Bun.sleep(1500);
    const after = await frames();
    for (const id of Object.values(CANVAS)) expect(after[id]).toBeGreaterThan(before[id]);
    expect(errors).toEqual([]);
  }, 40_000);

  test.skipIf(!chromeFound)(`${at}: each terminal reads its floor's general`, async () => {
    await open(general.base, width, height);
    await until(`window.__texts?.["room-sales"]?.SALES > 0 && window.__texts?.["room-fin"]?.FIN > 0 && window.__texts?.room?.HQ > 0`);
    expect(await ev(`Object.keys(window.__texts["room-fin"]).includes("HQ")`)).toBe(false);
    expect(await ev(`Object.keys(window.__texts["room-sales"]).includes("HQ")`)).toBe(false);
    expect(await ev(`Object.keys(window.__texts.room).some((t) => t === "FIN" || t === "SALES")`)).toBe(false);
    // the general is the figure at the terminal, not a worker on its floor
    expect(await ev(`Object.keys(window.__texts["room-fin"]).includes("fin")`)).toBe(false);
    expect(await ev(`Object.keys(window.__texts["room-fin"]).includes("fin-books")`)).toBe(true);
    expect(FACTS.generals).toEqual({ fin: "fin", sales: "sales" });
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: a click on a floor zooms in and scopes to it: border, chip, queue and messages narrow, other floors rest`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll(".building .tile").length === 3 && window.__texts?.["room-fin"]?.YOU > 0`);
    await click(`.tile[data-floor="fin"] canvas`);
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    expect(await scopeOf()).toEqual({ floor: "fin", agent: null, all: false });
    expect(await chip()).toBe("FIN FLOOR ✕");
    expect(await ev(`getComputedStyle(document.querySelector(".scopeborder")).borderTopColor`)).toBe(COLORS.fin);
    expect(await shown(".scopeborder")).toBe(true);
    // one floor in view, at the room's size, with today's legend under it and the way back above it
    expect(await ev(`[...document.querySelectorAll(".tile")].filter((t) => getComputedStyle(t).display !== "none").map((t) => t.dataset.floor)`)).toEqual(["fin"]);
    expect(await shown(".stagebar [data-zoomout]")).toBe(true);
    expect(await shown(".room .legend")).toBe(true);
    await settled();
    const r = await ev(`(() => { const c = document.getElementById("room-fin").getBoundingClientRect(), room = document.querySelector(".room").getBoundingClientRect(); return { w: c.width, h: c.height, roomW: room.width, roomBottom: room.bottom, bottom: c.bottom }; })()`);
    expect(Math.abs(r.w / r.h - 1.5)).toBeLessThan(0.03);
    expect(r.w).toBeGreaterThan(width > 600 ? 500 : 300);
    expect(r.bottom).toBeLessThanOrEqual(r.roomBottom);
    // the queue: only that floor's question, with the line that says what is left out
    await until(`document.querySelectorAll("#hud .ask").length === ${FACTS.waiting.fin}`);
    expect((await asks()).map((a) => a.lane)).toEqual([FACTS.asks.fin[0]]);
    const total = Object.values(FACTS.waiting).reduce((a, b) => a + b, 0);
    expect(await ev(`document.querySelector("#hud .scopeline").textContent`)).toBe(`+${total - FACTS.waiting.fin} ON OTHER FLOORS · SHOW ALL`);
    expect(await ev(`document.getElementById("qtCount").textContent`)).toBe(String(FACTS.waiting.fin));
    // the messages: only that floor's updates, your notes are HQ's
    await click(`[data-qtab="messages"]`);
    await until(`!document.getElementById("msgs").hidden`);
    expect(await ev(`[...document.querySelectorAll("#msgs [data-msg]")].map((m) => m.dataset.msg.startsWith("n") ? "note" : m.querySelector(".lane")?.textContent)`)).toEqual(["fin-books"]);
    expect(await ev(`document.querySelector("#msgs .scopeline").textContent`)).toMatch(/^\+\d+ ON OTHER FLOORS/);
    await click(`[data-qtab="questions"]`);
    // only the floor in view draws
    await Bun.sleep(300);
    const before = await frames();
    await Bun.sleep(1500);
    const after = await frames();
    expect(after["room-fin"]).toBeGreaterThan(before["room-fin"]);
    expect(after.room).toBe(before.room);
    expect(after["room-sales"]).toBe(before["room-sales"]);
  }, 40_000);

  test.skipIf(!chromeFound)(`${at}: a click on a worker in a floor chooses it; ✕ and Escape step out one level; ◀ ALL FLOORS and BUILDING go all the way`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll(".building .tile").length === 3`);
    await click(`.tile[data-floor="fin"] .tlabel`); // the label zooms in too
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    await choose("fin-audit");
    await until(`document.querySelector("#card h3")?.textContent === "fin-audit"`);
    expect(await chip()).toBe("FIN FLOOR › fin-audit ✕");
    expect(await stageOf()).toBe("in");
    // Escape: the agent first (its floor stays), then the floor (the building)
    await press("Escape");
    await until(`document.querySelector(".scopechip").textContent === "FIN FLOOR ✕"`);
    expect(await stageOf()).toBe("in");
    await press("Escape");
    await until(`document.querySelector(".room").dataset.stage === "out"`);
    expect(await chip()).toBe("");
    await until(`document.querySelectorAll("#hud .ask").length === ${Object.values(FACTS.waiting).reduce((a, b) => a + b, 0)}`);
    // the chip's ✕ does the same, one level at a time
    await click(`.tile[data-floor="sales"] .tlabel`);
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    await choose("sales-outb");
    await until(`document.querySelector(".scopechip")?.textContent === "SALES FLOOR › sales-outb ✕"`);
    await click(".scopechip");
    await until(`document.querySelector(".scopechip").textContent === "SALES FLOOR ✕"`);
    await click(".scopechip");
    await until(`document.querySelector(".room").dataset.stage === "out"`);
    // ◀ ALL FLOORS from an agent: all the way, in one press
    await click(`.tile[data-floor="hq"] .tlabel`);
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    await choose("hq-pm");
    await until(`document.querySelector(".scopechip")?.textContent === "HQ FLOOR › hq-pm ✕"`);
    await click(".stagebar [data-zoomout]");
    await until(`document.querySelector(".room").dataset.stage === "out"`);
    expect(await scopeOf()).toEqual({ floor: null, agent: null, all: false });
    // BUILDING from a floor with SHOW ALL lifted
    await click(`.tile[data-floor="fin"] .tlabel`);
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    await click("#hud [data-showall]");
    await until(`document.querySelectorAll("#hud .ask").length === ${Object.values(FACTS.waiting).reduce((a, b) => a + b, 0)}`);
    await click(".stagebar [data-building]");
    await until(`document.querySelector(".room").dataset.stage === "out"`);
    expect(await scopeOf()).toEqual({ floor: null, agent: null, all: false });
    // after the way out, every floor draws again
    const before = await frames();
    await Bun.sleep(1500);
    const after = await frames();
    for (const id of Object.values(CANVAS)) expect(after[id]).toBeGreaterThan(before[id]);
    expect(errors).toEqual([]);
  }, 60_000);

  test.skipIf(!chromeFound)(`${at}: a reload keeps the floor zoomed into`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll(".building .tile").length === 3`);
    await click(`.tile[data-floor="sales"] .tlabel`);
    await until(`document.querySelector(".room").dataset.stage === "in"`);
    await page.s("Page.reload");
    await until(`document.querySelector(".room")?.dataset.stage === "in" && !!document.getElementById("card")?.innerHTML`);
    expect(await chip()).toBe("SALES FLOOR ✕");
    expect(await ev(`[...document.querySelectorAll(".tile")].filter((t) => getComputedStyle(t).display !== "none").map((t) => t.dataset.floor)`)).toEqual(["sales"]);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: floor tags show on questions and on messages, in the floor's colour, and notes carry none`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length === ${Object.values(FACTS.waiting).reduce((a, b) => a + b, 0)}`);
    const floorOf = (lane: string) => (lane.startsWith("fin") ? "FIN" : lane.startsWith("sales") ? "SALES" : "HQ");
    for (const a of await asks()) expect(a.tag).toBe(floorOf(a.lane)); // "" (no lane) is HQ's
    expect(await ev(`getComputedStyle(document.querySelector('#hud .ask[data-lane="fin-audit"] .floortag')).backgroundColor`)).toBe(COLORS.fin);
    expect(await ev(`document.querySelector("#hud .ask .meta").firstElementChild.classList.contains("floortag")`)).toBe(true);
    await click(`[data-qtab="messages"]`);
    await until(`document.querySelectorAll("#msgs [data-msg]").length >= 5`);
    expect(await ev(`[...document.querySelectorAll("#msgs .msg.hq")].map((m) => (m.querySelector(".lane")?.textContent ?? "") + ":" + m.querySelector(".floortag")?.textContent)`)).toEqual(
      expect.arrayContaining(["hq-pm:HQ", "fin-books:FIN", "sales-pm:SALES", ":HQ"]),
    );
    expect(await ev(`document.querySelectorAll("#msgs .msg.you .floortag").length`)).toBe(0);
    // FROM HQ, under the room
    expect(await ev(`[...document.querySelectorAll("#feedBody .upd")].every((u) => !!u.querySelector(".floortag"))`)).toBe(true);
    expect(await ev(`document.querySelectorAll("#feedBody .upd").length`)).toBe(4);
  }, 30_000);
}

// The signed design's office: five floors, so the building is three rows of tiles and the stage scrolls for it.
test.skipIf(!chromeFound)("five floors at 1440: a label stays inside its tile, and a click on it zooms into that floor", async () => {
  const office = await startFloors({ frame: true });
  try {
    await open(office.base, 1440, 900);
    await until(`document.querySelectorAll(".building .tile").length === 5`);
    const ids = (await ev(`[...document.querySelectorAll(".tile")].map((t) => t.dataset.floor)`)) as string[];
    expect(ids).toEqual(ids.map((id) => id.toLowerCase()));
    for (const id of ids) {
      await ev(`document.querySelector('.tile[data-floor="${id}"] .tlabel').scrollIntoView({ block: "center" })`);
      await ev(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`); // the layout has settled
      const at = (await ev(`(() => { const t = document.querySelector('.tile[data-floor="${id}"]').getBoundingClientRect(), l = document.querySelector('.tile[data-floor="${id}"] .tlabel').getBoundingClientRect(); return { inside: l.left >= t.left - 0.5 && l.right <= t.right + 0.5, x: l.left + 10, y: l.top + l.height / 2, tile: t.width }; })()`)) as { inside: boolean; x: number; y: number; tile: number };
      expect(at.inside).toBe(true);
      expect(at.tile).toBeGreaterThan(300); // not the 80 px minimum
      for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
      await until(`document.querySelector(".room").dataset.stage === "in"`);
      expect(await scopeOf()).toEqual({ floor: id, agent: null, all: false });
      await press("Escape");
      await until(`document.querySelector(".room").dataset.stage === "out"`);
    }
  } finally {
    await page.s("Page.navigate", { url: "about:blank" }); // off the stream before its server goes, or the cut is the next test's console error
    await office.stop();
  }
}, 90_000);

// The scope chip is what tells the owner the page is scoped, so it must read whole and take a click on its ✕: on one
// line, inside the question column, at the widest and the narrowest two-column width.
test.skipIf(!chromeFound)("the scope chip reads on one line inside its column and its ✕ takes a click, at 1440 and 1151", async () => {
  const geometry = () => ev(`(() => {
    const c = document.querySelector(".scopechip"), r = c.getBoundingClientRect(), col = document.querySelector(".qwrap").getBoundingClientRect();
    const x = r.right - 12, y = r.top + r.height / 2;
    const rg = document.createRange(); rg.selectNodeContents(c);
    return { lines: new Set([...rg.getClientRects()].map((q) => Math.round(q.top))).size, left: r.left - col.left, right: col.right - r.right, clipped: c.scrollWidth > c.clientWidth, opacity: getComputedStyle(c).opacity, hit: document.elementFromPoint(x, y) === c || c.contains(document.elementFromPoint(x, y)), x, y };
  })()`) as Promise<{ lines: number; left: number; right: number; clipped: boolean; opacity: string; hit: boolean; x: number; y: number }>;
  const clickAt = async (x: number, y: number) => {
    for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  try {
    for (const [width, height] of [[1440, 900], [1151, 900]] as [number, number][]) {
      await open(general.base, width, height);
      await until(`document.querySelectorAll(".building .tile").length === 3`);
      await ev(`(() => { const h = document.getElementById("hud"); h.style.height = "200px"; h.scrollTop = 120; })()`); // a list read part way down
      await click(`.tile[data-floor="sales"] .tlabel`);
      await until(`document.querySelector(".scopechip")?.textContent === "SALES FLOOR ✕"`);
      expect(await ev(`document.getElementById("hud").scrollTop`)).toBe(0); // the line is on screen, not scrolled past
      await ev(`document.getElementById("hud").style.height = ""`);
      await choose("sales-outb");
      await until(`document.querySelector(".scopechip")?.textContent === "SALES FLOOR › sales-outb ✕"`);
      // the "+N ON OTHER FLOORS" line is a light card with dark text, first in the list, as the frame draws it
      expect(await ev(`(() => { const l = document.querySelector("#hud .scopeline"), s = getComputedStyle(l); return { first: l === document.getElementById("hud").firstElementChild, bg: s.backgroundColor, color: s.color }; })()`)).toEqual({ first: true, bg: "rgb(255, 255, 255)", color: "rgb(35, 35, 58)" });
      for (const text of ["SALES FLOOR › sales-outb ✕", "SALES FLOOR ✕"]) {
        await until(`document.querySelector(".scopechip")?.textContent === ${JSON.stringify(text)}`);
        await settled();
        const g = await geometry();
        expect({ width, text, lines: g.lines, inside: g.left >= 0 && g.right >= 0, clipped: g.clipped, opacity: g.opacity, hit: g.hit }).toEqual({ width, text, lines: 1, inside: true, clipped: false, opacity: "1", hit: true });
        await clickAt(g.x, g.y); // on its ✕
      }
      await until(`document.querySelector(".room").dataset.stage === "out"`);
      expect(await scopeOf()).toEqual({ floor: null, agent: null, all: false });
    }
  } finally {
    await page.s("Page.navigate", { url: "about:blank" });
  }
}, 60_000);

test.skipIf(!chromeFound)("one floor: today's page under a stage bar that holds RUNDOWN alone: no building, no way back, no floor tags and no floor border", async () => {
  for (const [width, height] of SIZES) {
    await open(single.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length === 3 && !!document.getElementById("room")`);
    await Bun.sleep(500);
    for (const sel of [".building", ".tile", ".tlabel", ".floortag", "canvas#room-fin", ".scopeborder", ".scopechip"]) {
      expect({ width, sel, found: await ev(`!!document.querySelector(${JSON.stringify(sel)})`) }).toEqual({ width, sel, found: false });
    }
    // the bar is there for RUNDOWN; ◀ ALL FLOORS and BUILDING are not shown
    expect(await shown(".stagebar #rundownBtn")).toBe(true);
    expect(await shown(".stagebar [data-zoomout]")).toBe(false);
    expect(await shown(".stagebar [data-building]")).toBe(false);
    expect(await ev(`document.querySelector(".room").hasAttribute("data-stage")`)).toBe(false);
    // the layer (U10) wraps the canvas in a scene of its own, in the room where the canvas always sat
    expect(await ev(`document.getElementById("room").parentElement === document.querySelector(".room > .scene")`)).toBe(true);
    expect(await ev(`document.querySelectorAll(".scene").length`)).toBe(1);
    expect(await shown(".room .legend")).toBe(true);
    expect(await ev(`document.querySelectorAll("#hud .ask .meta .floortag").length`)).toBe(0);
    await click(`[data-qtab="messages"]`);
    await until(`document.querySelectorAll("#msgs [data-msg]").length >= 2`);
    expect(await ev(`document.querySelectorAll("#msgs .floortag").length + document.querySelectorAll("#feedBody .floortag").length`)).toBe(0);
    await click(`[data-qtab="questions"]`);
    // a worker chosen scopes to the lane alone: its chip names no floor, and there is still no building
    await choose("hq-pm");
    await until(`document.querySelector(".scopechip")?.textContent === "hq-pm ✕"`);
    expect(await ev(`!!document.querySelector(".building")`)).toBe(false);
    await press("Escape");
    await until(`document.querySelector(".scopechip").hidden`);
  }
  expect(errors).toEqual([]);
}, 60_000);
