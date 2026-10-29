// A theme dresses every sprite in the room: in ARENA a flat team (every lane straight under HQ) is all PMs in the
// top rank's star mask, with no seasonal hat or item over the costume, the hero is the game master standing, dancing and asleep, and HQ is the
// senior guard. Compared pixel by pixel with each costume painted alone. Changing the theme repaints without a
// reload, and the theme survives a server restart. Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, freePort, newSession, startChrome } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-office-arena-"));
const PORT = freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const chromeFound = !!findChrome();
// Enough names that some of them wear a seasonal hat at Halloween, where a hat would cover a costume.
const TEAM = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
let server: ReturnType<typeof Bun.spawn> | null = null;
let chrome: Awaited<ReturnType<typeof startChrome>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];

// A herdr that knows every lane as a working agent, so none of them turns into a see-through "gone" worker.
const HERDR = join(DATA, "herdr");
const agents = JSON.stringify({ result: { agents: TEAM.map((name, i) => ({ name, agent_status: "working", pane_id: `p${i}`, agent: "claude" })) } });
writeFileSync(HERDR, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '${agents}' ;;\n  *) exit 0 ;;\nesac\n`);
chmodSync(HERDR, 0o755);

async function start() {
  server = Bun.spawn([process.execPath, "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, HUD_PORT: String(PORT), HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: HERDR, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_OWNER: "Tester" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await Bun.sleep(100)) {
    try { if ((await fetch(`${BASE}/api/state`)).ok) return; } catch {}
  }
  throw new Error(`server did not come up on port ${PORT}`);
}
async function stop() {
  server?.kill();
  await server?.exited;
  server = null;
}
const post = (path: string, body: object) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json());
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const open = async () => {
  await page.s("Page.navigate", { url: `${BASE}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
};
const looks = () => page.evaluate(`import("/src/client/room/workers.js").then(({ workers }) => [...workers.values()].map((w) => w.pal.look?.id ?? null))`);

beforeAll(async () => {
  if (!chromeFound) return;
  await start();
  for (const name of TEAM) await post("/api/lanes", { name, machine: "local" });
  // The settings as the page sends them: { settings: { ... } }
  const reply = await post("/api/settings", { settings: { theme: "arena", season: "halloween", hat: "pumpkin" } });
  expect(reply.settings.theme).toBe("arena");
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await open();
});

afterAll(async () => {
  await stop();
  chrome?.close();
  rmSync(DATA, { recursive: true, force: true });
});

// The page's own painters, into a small canvas: what the room draws for a figure, and what a costume looks like alone.
const HELPERS = `
  const { drawSprite } = await import("/src/client/room/sprites.js");
  const { setCtx, ctx: live, SC, TS } = await import("/src/client/room/canvas.js");
  const looksMod = await import("/src/client/room/looks.js");
  const { drawAccessories, wornBy } = await import("/src/client/room/accessories.js");
  const { workers } = await import("/src/client/room/workers.js");
  const { palette, HQBOT } = await import("/src/client/room/palette.js");
  const { hero } = await import("/src/client/settings/prefs.js");
  const { THEMES } = await import("/src/client/room/themes.js");
  const paintWith = (w, h, fn) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); setCtx(g);
    try { fn(); } finally { setCtx(live); }
    return g.getImageData(0, 0, w, h).data;
  };
  const paint = (pal, dir, step, items = []) => Array.from(paintWith(48, 48, () => { drawSprite(pal, 0, 0, dir, step); if (items.length) drawAccessories(pal, items, 0, 0, dir, step); })).join(",");
  const hex = (d, i) => "#" + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  const colours = (d) => { const out = new Set(); for (let i = 0; i < d.length; i += 4) if (d[i + 3]) out.add(hex(d, i)); return out; };
  const DIRS = [["down", 0], ["down", 1], ["up", 0], ["left", 1], ["right", 0]];
`;

test.skipIf(!chromeFound)("ARENA with a flat team: every lane straight under HQ is a PM in the star mask, nothing seasonal over it", async () => {
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === ${TEAM.length})`);
  expect(await looks()).toEqual(TEAM.map(() => "guard-star"));
  const out = await page.evaluate(`(async () => {${HELPERS}
    const seats = [...workers.keys()].sort();
    const rows = [];
    for (const [name, w] of workers) {
      const costume = looksMod.dressed(name, THEMES.arena.depths[0], seats.indexOf(name) + 1);
      const everyday = palette(name);
      // what the room draws for this worker (room/loop.js): its palette, then the accessories its look leaves
      const items = wornBy(name, false, w.pal.look?.hides);
      const seasonal = wornBy(name, false);
      for (const [dir, step] of DIRS) {
        const hands = seasonal.filter((a) => a.slot === "hand" && !costume.look.hides.includes("hand"));
        rows.push({ name, dir, drawn: paint(w.pal, dir, step, items) === paint(costume, dir, step, hands), costume: paint(costume, dir, step) !== paint(everyday, dir, step) });
      }
    }
    // some of the team would wear a hat today: that is what the costume must not show
    const hatted = [...workers.keys()].filter((n) => wornBy(n, false).some((a) => a.slot === "head")).length;
    return { rows, hatted };
  })()`);
  expect(out.hatted).toBeGreaterThan(0);
  expect(out.rows.filter((r) => !r.drawn).map((r) => `${r.name} ${r.dir}`)).toEqual([]);
  expect(out.rows.filter((r) => !r.costume).map((r) => `${r.name} ${r.dir}`)).toEqual([]);
  // and in the room itself: the guard suit's colour is on the canvas
  expect(await page.evaluate(`(async () => {${HELPERS}
    const c = document.getElementById("room"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (hex(d, i) === "#e0287a") n++;
    return n;
  })()`)).toBeGreaterThan(TEAM.length * 20);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("ARENA: the hero is the game master standing, dancing and asleep, keeping its own hair; HQ is the senior guard", async () => {
  const out = await page.evaluate(`(async () => {${HELPERS}
    const me = looksMod.heroPal("arena"), own = hero().pal;
    const res = { look: me.look?.id ?? null, items: wornBy(hero().name, true, me.look?.hides).length, frames: [], sleep: null, hq: null };
    for (const [dir, step] of [...DIRS, ["left", 0], ["right", 1], ["up", 1]]) {
      const d = paintWith(48, 48, () => drawSprite(me, 0, 0, dir, step)), cs = colours(d);
      // no skin shows (mask and gloves), the hair does where the mask leaves it, and the coat is not the shirt
      res.frames.push({ dir, step, skin: cs.has(own.s.toLowerCase()), hair: cs.has(own.h.toLowerCase()), shirt: cs.has(own.c.toLowerCase()), differs: paint(me, dir, step) !== paint(own, dir, step) });
    }
    const { drawSleep } = await import("/src/client/room/hero.js");
    const sleep = paintWith(24 * TS * SC, 16 * TS * SC, () => drawSleep(1000)), scs = colours(sleep);
    res.sleep = { skin: scs.has(own.s.toLowerCase()), hair: scs.has(own.h.toLowerCase()), mask: scs.has(me.m), gold: scs.has(me.x) };
    const hq = looksMod.hqPal("arena"), hd = paintWith(48, 48, () => drawSprite(hq, 0, 0, "up", 0)), hcs = colours(hd);
    res.hq = { look: hq.look?.id ?? null, crown: hcs.has("#f0c040"), suit: hcs.has("#e0287a"), differs: paint(hq, "up", 0) !== paint(HQBOT, "up", 0) };
    // OFFICE: the hero and HQ exactly as they always were
    res.office = { hero: looksMod.heroPal("office") === own, hq: looksMod.hqPal("office") === HQBOT };
    return res;
  })()`);
  expect(out.look).toBe("game-master");
  expect(out.items).toBe(0); // no seasonal hat or item on the mask
  for (const f of out.frames) expect(f).toEqual({ dir: f.dir, step: f.step, skin: false, hair: true, shirt: false, differs: true });
  expect(out.sleep).toEqual({ skin: false, hair: true, mask: true, gold: true });
  expect(out.hq).toEqual({ look: "guard-crown", crown: true, suit: true, differs: true });
  expect(out.office).toEqual({ hero: true, hq: true });
}, 30_000);

test.skipIf(!chromeFound)("changing the theme repaints the room without a reload", async () => {
  const suit = `(async () => {${HELPERS}
    const c = document.getElementById("room"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (hex(d, i) === "#e0287a") n++;
    return n;
  })()`;
  await page.evaluate(`window.__sameDocument = true`);
  await page.evaluate(`document.getElementById("settingsBtn").click()`);
  await until(`!!document.querySelector('[data-set="theme"][data-val="office"]')`);
  await page.evaluate(`document.querySelector('[data-set="theme"][data-val="office"]').click()`);
  await until(`import("/src/client/room/workers.js").then(({ workers }) => [...workers.values()].every((w) => !w.pal.look))`);
  await until(`${suit}.then((n) => n === 0)`);
  // the page's own change has reached the server before the next one is made elsewhere
  for (let i = 0; i < 100 && (await (await fetch(`${BASE}/api/settings`)).json()).settings.theme !== "office"; i++) await Bun.sleep(50);
  await Bun.sleep(300);
  // from another page or HQ: the server's change arrives on the stream
  await post("/api/settings", { settings: { theme: "arena" } });
  await until(`${suit}.then((n) => n > 0)`);
  expect(await looks()).toEqual(TEAM.map(() => "guard-star"));
  expect(await page.evaluate(`window.__sameDocument === true`)).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("the theme survives a server restart, and the reloaded room is in costume", async () => {
  await stop();
  await start();
  expect((await (await fetch(`${BASE}/api/settings`)).json()).settings.theme).toBe("arena");
  await open();
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === ${TEAM.length} && [...workers.values()].every((w) => w.pal.look?.id === "guard-star"))`);
  expect(errors.filter((e) => !/EventSource|stream|Failed to load resource/i.test(e))).toEqual([]);
}, 30_000);
