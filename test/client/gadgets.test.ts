// The everyday gadgets (room/gadgets.js) in a real browser on the frozen clock: a habit per name that holds within
// a 2-hour block and swaps across blocks; on the desk while a worker sits there and in the hand elsewhere; a sip on
// schedule that lifts it off the desk and puts it back; never over a status bubble, a name label, a monitor, a mask's
// mark or a player's number; held by Arena's guards and players; never by the hero or HQ; and no extra frames.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FREEZE, findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const DAY = Date.UTC(2026, 3, 20, 14, 0); // spring, no event: no seasonal hand item, no weather
const DESK = ["kiwi", "mango", "olive", "pepper", "quinoa", "radish", "sage", "tofu"];
const STAND = ["basil", "fennel", "chive", "dill", "leek"]; // candidates for the one lane waiting on HQ
const ASKER = "yarrow"; // a lane with a question open: the hero does not dance, so the room is idle
const KEY: Record<string, string> = { mug: "#5a3a24", bottle: "#9ad4f8", donut: "#ff9ac4", tumbler: "#7cc4b8" };

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
let stander = "";
const errors: string[] = [];
const DATA = mkdtempSync(join(tmpdir(), "hq-office-gadgets-"));
const HERDR = join(DATA, "herdr");
const COUNT = `(() => { window.__frames = 0; const raf = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => raf((t) => { window.__frames++; cb(t); }); })();`;

function writeHerdr(standing: string) {
  const agents = [...DESK.map((name) => ({ name, agent_status: "working" })), { name: standing, agent_status: "idle" }, { name: ASKER, agent_status: "idle" }]
    .map((a, i) => ({ ...a, pane_id: `p${i}`, agent: "claude" }));
  writeFileSync(HERDR, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '${JSON.stringify({ result: { agents } })}' ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(HERDR, 0o755);
}
let loads = 0; // a new query each time: the same URL with a hash would not load the page again
const open = async () => {
  await page.s("Page.navigate", { url: `${server.base}/?season=spring&load=${++loads}#t=${DAY}` });
  for (let i = 0; i < 300 && !(await page.evaluate("!!window.__hq && window.__hq.ready()").catch(() => false)); i++) await Bun.sleep(50);
  await page.evaluate("document.fonts.ready.then(() => true)");
  await page.evaluate("__hq.advance(20)");
};

// In the page: the room's pixels by art pixel, and where each worker and its desk are.
// A floor other than HQ's is the room's modules loaded again from /floor/<id>/..., drawing on its own canvas room-<id>.
const helpers = (prefix: string, canvas: string) => `
  const G = await import("${prefix}/src/client/room/gadgets.js");
  const { workers } = await import("${prefix}/src/client/room/workers.js");
  const { TS, SC } = await import("${prefix}/src/client/room/canvas.js");
  const KEY = ${JSON.stringify(KEY)};
  const room = document.getElementById("${canvas}"), data = room.getContext("2d").getImageData(0, 0, room.width, room.height).data;
  const hex = (i) => "#" + [data[i], data[i + 1], data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  // the colours in an art-pixel box, sampled at each art pixel's centre
  const colours = (x0, y0, x1, y1) => { const out = new Set(); for (let y = Math.max(0, y0); y < y1; y++) for (let x = Math.max(0, x0); x < x1; x++) out.add(hex(((Math.floor(y * SC + 1)) * room.width + Math.floor(x * SC + 1)) * 4)); return out; };
  const signature = (x0, y0, x1, y1) => { let s = ""; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += hex(((Math.floor(y * SC + 1)) * room.width + Math.floor(x * SC + 1)) * 4); return s; };
  // the sprite from the head down (a desk gadget ends above it), and the desk top left of the monitor
  const spriteBox = (w) => { const sx = Math.round(w.x * TS), sy = Math.round(w.y * TS) - 6; return [sx - 3, sy, sx + 19, sy + 16]; };
  const deskBox = (w) => [w.seat.x * TS - 8, (w.seat.y - 1) * TS - 4, w.seat.x * TS + 3, (w.seat.y - 1) * TS + 11];
  const sipNow = (name) => G.sipping(name, Math.floor(performance.now() / 1000) * 1000);
  const keys = (box) => Object.entries(KEY).filter(([, c]) => colours(...box).has(c)).map(([id]) => id);
`;
const HELPERS = helpers("", "room");

beforeAll(async () => {
  if (!chromeFound) return;
  writeHerdr(STAND[0]);
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: HERDR });
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: FREEZE });
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: COUNT });
  await open();
  // the lane waiting on HQ: one that holds something today
  stander = await page.evaluate(`import("/src/client/room/gadgets.js").then((G) => ${JSON.stringify(STAND)}.find((n) => G.gadgetFor(n)))`);
  writeHerdr(stander);
  for (const name of [...DESK, stander, ASKER]) await server.post("/api/lanes", { name, phase: "running", title: name, machine: "local" });
  await server.post("/api/asks", { lane: ASKER, kind: "decision", title: "Ship it?", options: ["Yes", "No"], recommended: "Yes" });
  await server.post("/api/settings", { settings: { performance: "balanced", theme: "office" } });
  await server.post("/api/sync", {});
  await open();
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(DATA, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("each name has a habit that holds within a 2-hour block and swaps across blocks", async () => {
  const out = await page.evaluate(`(async () => {
    const G = await import("/src/client/room/gadgets.js");
    const names = Array.from({ length: 60 }, (_, i) => "lane-" + i);
    const id = (g) => g?.id ?? null;
    const block = (k) => ${DAY} + k * G.BLOCK_MS;
    let steady = true, swapped = 0, empty = 0, habitMost = true;
    for (const n of names) {
      for (let k = 0; k < 12; k++) for (const dt of [0, 3_600_000, G.BLOCK_MS - 1]) if (id(G.gadgetFor(n, block(k) + dt)) !== id(G.gadgetFor(n, block(k)))) steady = false;
      const seen = Array.from({ length: 48 }, (_, k) => id(G.gadgetFor(n, block(k))));
      if (seen.some((s) => s && s !== G.habitOf(n).id)) swapped++;
      if (seen.includes(null)) empty++;
      const counts = {}; for (const s of seen) if (s) counts[s] = (counts[s] ?? 0) + 1;
      if (Math.max(...Object.values(counts)) !== counts[G.habitOf(n).id]) habitMost = false;
    }
    return { steady, swapped, empty, habitMost, kinds: [...new Set(names.map((n) => G.habitOf(n).id))].sort(), same: names.every((n) => G.habitOf(n) === G.habitOf(n)) };
  })()`);
  expect(out.steady).toBe(true);
  expect(out.same).toBe(true);
  expect(out.habitMost).toBe(true);
  expect(out.kinds).toEqual(["bottle", "donut", "mug", "tumbler"]);
  expect(out.swapped).toBeGreaterThan(50); // nearly every name swaps on some days
  expect(out.empty).toBeGreaterThan(30);
});

test.skipIf(!chromeFound)("on the desk while working, in the hand standing; never on the hero or HQ", async () => {
  const out = await page.evaluate(`(async () => {${HELPERS}
    const res = { desk: [], standing: null, hero: keys([20 * TS - 12, 2 * TS - 8, 20 * TS + 12, 2 * TS + 12]), hq: keys([16 * TS - 4, 5 * TS - 8, 16 * TS + 20, 5 * TS + 10]) };
    for (const w of workers.values()) {
      const g = G.gadgetFor(w.lane.name);
      if (w.lane.status === "moving") res.desk.push({ name: w.lane.name, g: g?.id ?? null, sip: sipNow(w.lane.name), onDesk: keys(deskBox(w)), inHand: keys(spriteBox(w)) });
      if (w.lane.name === ${JSON.stringify(stander)}) res.standing = { g: g.id, inHand: keys(spriteBox(w)), status: w.lane.status };
    }
    return res;
  })()`);
  expect(out.desk.length).toBe(DESK.length);
  for (const d of out.desk) {
    // on the desk, or in the hand while it sips
    const there = d.g ? [d.g] : [];
    expect({ name: d.name, onDesk: d.onDesk, inHand: d.inHand }).toEqual({ name: d.name, onDesk: d.sip ? [] : there, inHand: d.sip ? there : [] });
  }
  expect(out.desk.filter((d) => d.g).length).toBeGreaterThan(4);
  expect(out.standing.status).toBe("hq_turn");
  expect(out.standing.inHand).toEqual([out.standing.g]);
  expect(out.hero).toEqual([]);
  expect(out.hq).toEqual([]);
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("a sip comes on schedule, once a minute: off the desk into the hand, then back", async () => {
  const seconds = [];
  for (let s = 0; s < 65; s++) {
    const T = await page.evaluate("__hq.advance(10)");
    seconds.push(await page.evaluate(`(async () => {${HELPERS}
      const t = Math.floor(${T} / 1000) * 1000, out = {};
      for (const w of workers.values()) {
        const name = w.lane.name, g = G.gadgetFor(name);
        if (!g || w.path.length) continue;
        const sip = G.sipping(name, t);
        if (w.lane.status === "moving") out[name] = { sip, onDesk: keys(deskBox(w)).includes(g.id), inHand: keys(spriteBox(w)).includes(g.id) };
        else if (name === ${JSON.stringify(stander)}) out[name] = { sip, sig: signature(...spriteBox(w)) };
      }
      return out;
    })()`));
  }
  const names = Object.keys(seconds[0]);
  expect(names.length).toBeGreaterThan(4);
  for (const name of names) {
    const runs = seconds.map((s) => s[name]);
    expect(runs.filter((r) => r.sip).length).toBeGreaterThan(0); // every worker sips within the minute
    if (name === stander) {
      // standing: the picture changes exactly on the sip beats
      const rest = runs.find((r) => !r.sip)!.sig;
      expect(runs.map((r) => r.sig !== rest)).toEqual(runs.map((r) => r.sip));
    } else {
      expect(runs.map((r) => r.onDesk)).toEqual(runs.map((r) => !r.sip));
      expect(runs.map((r) => r.inHand)).toEqual(runs.map((r) => r.sip));
    }
  }
}, 60_000);

test.skipIf(!chromeFound)("never over a bubble, a label or a monitor; masks' marks and players' numbers stay whole", async () => {
  const out = await page.evaluate(`(async () => {
    const G = await import("/src/client/room/gadgets.js");
    const { setCtx, ctx: live, SC, TS } = await import("/src/client/room/canvas.js");
    const { drawSprite } = await import("/src/client/room/sprites.js");
    const { drawBubble } = await import("/src/client/room/scene.js");
    const { dressed } = await import("/src/client/room/looks.js");
    const { THEMES } = await import("/src/client/room/themes.js");
    // a ctx that records the boxes drawn, in art pixels
    const probe = (fn) => { const boxes = []; setCtx({ globalAlpha: 1, fillStyle: "", font: "", textAlign: "", textBaseline: "", fillText() {}, measureText: () => ({ width: 10 }),
      fillRect(x, y, w, h) { boxes.push([x / SC, y / SC, (x + w) / SC, (y + h) / SC]); }, drawImage(c, x, y) { boxes.push([x / SC, y / SC, (x + c.width) / SC, (y + c.height) / SC]); } });
      try { fn(); } finally { setCtx(live); } return boxes; };
    const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    const pal = dressed("kiwi", null);
    const bubble = [0, 1, 2.5].flatMap((bounce) => probe(() => drawBubble(0, 0, "!", "#000", bounce)));
    const label = [-40, 16, 56, 22]; // a name label is drawn from 16 art pixels under the sprite's top, as wide as it needs
    const bad = [];
    for (const g of G.GADGETS) for (const pose of ["hand", "sip"]) for (const other of [false, true]) for (const dir of ["down", "up", "left", "right"]) for (const step of [0, 1, 2]) {
      for (const b of probe(() => G.drawGadget(pal, { g, pose, other }, 0, 0, dir, step))) {
        if (bubble.some((x) => hit(b, x)) || hit(b, label)) bad.push([g.id, pose, other, dir, step, "bubble or label"].join(" "));
      }
    }
    // on a desk: the seat's monitor, its worker's bubble and label, and the next desk to the left
    const seat = { x: 5, y: 7 }, dx = seat.x * TS, dy = (seat.y - 1) * TS, sy = seat.y * TS - 6;
    const keepOut = [[dx + 3, dy - 1, dx + 13, dy + 7], ...probe(() => drawBubble(dx, sy, "!", "#000", 0)), [dx - 40, sy + 16, dx + 56, sy + 22], [dx - 40, dy, dx - 14, dy + 16], [dx, sy + 1, dx + 16, sy + 16]];
    for (const g of G.GADGETS) for (const b of probe(() => G.drawDeskGadget(pal, g, seat))) if (keepOut.some((k) => hit(b, k))) bad.push(g.id + " desk");
    // pixels: a mask's white mark (head rows) and a player's white number (chest) look the same with any gadget
    const paint = (fn) => { const c = document.createElement("canvas"); c.width = 72; c.height = 48; setCtx(c.getContext("2d")); try { fn(); } finally { setCtx(live); } return c.getContext("2d").getImageData(0, 0, 72, 48).data; };
    const whites = (d, rows, cols) => { const out = []; for (let y = rows[0] * 3; y < rows[1] * 3; y++) for (let x = (cols[0] + 4) * 3; x < (cols[1] + 4) * 3; x++) { const i = (y * 72 + x) * 4; if (d[i] === 0xf8 && d[i + 1] === 0xf8 && d[i + 2] === 0xf8 && d[i + 3]) out.push(i); } return out; };
    const looks = [...THEMES.arena.depths.slice(0, 4).map((l) => [dressed("kiwi", l, 1), [0, 10], [0, 16]]), [dressed("kiwi", THEMES.arena.depths[4], 88), [10, 14], [5, 11]]];
    let checked = 0;
    for (const [p, rows, cols] of looks) for (const g of G.GADGETS) for (const pose of ["hand", "sip"]) for (const other of [false, true]) for (const [dir, step] of [["down", 0], ["down", 2], ["up", 0], ["left", 0], ["right", 0]]) {
      const alone = paint(() => drawSprite(p, 4, 0, dir, step)), held = paint(() => { drawSprite(p, 4, 0, dir, step); G.drawGadget(p, { g, pose, other }, 4, 0, dir, step); });
      const marks = whites(alone, rows, cols);
      checked += marks.length;
      if (marks.some((i) => alone[i] !== held[i] || alone[i + 1] !== held[i + 1] || alone[i + 2] !== held[i + 2])) bad.push([p.look.id, g.id, pose, other, dir, step, "mark"].join(" "));
    }
    return { bad, checked };
  })()`);
  expect(out.bad).toEqual([]);
  expect(out.checked).toBeGreaterThan(1000);
});

test.skipIf(!chromeFound)("sips add no frames: one a second in BALANCED, none in POWER SAVER", async () => {
  const framesOver = async (seconds: number) => {
    const a = await page.evaluate("window.__frames");
    await page.evaluate(`__hq.advance(${seconds * 10})`);
    return (await page.evaluate("window.__frames")) - a;
  };
  expect(await framesOver(70)).toBe(70);
  await server.post("/api/settings", { settings: { performance: "saver" } });
  await open();
  // under a minute: the room's own wall-clock minute (night, the season) wakes it once a minute in any mode
  expect(await framesOver(50)).toBe(0);
  await server.post("/api/settings", { settings: { performance: "balanced" } });
}, 60_000);

test.skipIf(!chromeFound)("ARENA: guards and numbered players hold their gadgets, on the desk and in the hand", async () => {
  // a tree five deep, so the room has every guard and players under them
  const parents: Record<string, string> = { mango: "kiwi", olive: "mango", pepper: "olive", quinoa: "pepper", radish: "quinoa", sage: "quinoa" };
  for (const [name, parent] of Object.entries(parents)) await server.post("/api/lanes", { name, parent });
  await server.post("/api/settings", { settings: { theme: "arena" } });
  await open();
  // kiwi directs a lead with reports below it, so the tree is kiwi's floor: its workers, looks and pixels are in that
  // floor's copy of the room. Zoom in so the floor draws, as the page does.
  await page.evaluate(`import("/src/client/core/scope.js").then((m) => m.setFloor("kiwi"))`);
  for (let i = 0; i < 200 && !(await page.evaluate(`import("/floor/kiwi/src/client/room/workers.js").then((m) => m.workers.size >= 6, () => false)`).catch(() => false)); i++) await Bun.sleep(50);
  await page.evaluate("__hq.advance(20)");
  const out = await page.evaluate(`(async () => {${helpers("/floor/kiwi", "room-kiwi")}
    const rows = [];
    for (const w of workers.values()) {
      const g = G.gadgetFor(w.lane.name);
      const box = w.lane.status === "moving" && !sipNow(w.lane.name) ? deskBox(w) : spriteBox(w);
      rows.push({ name: w.lane.name, look: w.pal.look?.id ?? null, g: g?.id ?? null, seen: keys(box) });
    }
    return { rows, hero: keys([20 * TS - 12, 2 * TS - 8, 20 * TS + 12, 2 * TS + 12]), hq: keys([16 * TS - 4, 5 * TS - 8, 16 * TS + 20, 5 * TS + 10]) };
  })()`);
  const looks = new Set(out.rows.map((r: any) => r.look));
  // kiwi, the guard-star, heads the floor: it stands at the terminal (the box checked as "hq" below), not at a desk.
  for (const l of ["guard-square", "guard-triangle", "guard-circle", "player"]) expect(looks.has(l)).toBe(true);
  for (const r of out.rows) if (r.g) expect({ name: r.name, seen: r.seen.includes(r.g) }).toEqual({ name: r.name, seen: true });
  expect(out.rows.filter((r: any) => r.g && r.look?.startsWith("guard")).length).toBeGreaterThan(1);
  expect(out.rows.filter((r: any) => r.g && r.look === "player").length).toBeGreaterThan(0);
  expect(out.hero).toEqual([]);
  expect(out.hq).toEqual([]);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("with a seasonal item in the hand, the gadget is in the other hand, and hidden side-on", async () => {
  const out = await page.evaluate(`(async () => {
    const G = await import("/src/client/room/gadgets.js");
    const { ACCESSORIES } = await import("/src/client/room/accessory-table.js");
    const { setCtx, ctx: live, SC } = await import("/src/client/room/canvas.js");
    const { dressed } = await import("/src/client/room/looks.js");
    const name = ${JSON.stringify(stander)}, seasonal = [ACCESSORIES.find((a) => a.id === "latte")];
    const w = (dir) => ({ lane: { name, status: "hq_turn" }, dir, seat: null, target: {} });
    const res = {};
    for (const dir of ["down", "up", "left", "right"]) res[dir] = G.heldBy(w(dir), seasonal, 0, false, false);
    // where it is drawn: right of the body with a free hand, left of it with the other
    const span = (h) => { const xs = []; setCtx({ globalAlpha: 1, drawImage(c, x) { xs.push(x / SC, (x + c.width) / SC); }, fillRect() {} }); try { G.drawGadget(dressed(name, null), h, 0, 0, "down", 0); } finally { setCtx(live); } return [Math.min(...xs), Math.max(...xs)]; };
    const free = G.heldBy(w("down"), [], 0, false, false);
    return { down: res.down?.other, up: res.up?.other, left: res.left, right: res.right, free: span(free), other: span(res.down) };
  })()`);
  expect(out.down).toBe(true);
  expect(out.up).toBe(true);
  expect(out.left).toBe(null);
  expect(out.right).toBe(null);
  expect(out.free[0]).toBeGreaterThanOrEqual(10);
  expect(out.other[1]).toBeLessThanOrEqual(6);
});
