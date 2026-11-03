// The top bar from 1151 px up is one calm row, however busy: no box wraps its text, nothing passes the bar's edge, it
// is as tall as a calm bar, every count and alarm stays in view, WAITING ON YOU keeps its size, and BANK is in MENU
// once the bar lets it go (topbar/fit.js). Walked with real input at 1151, 1280, 1440 and 1920, calm, busy and
// stalled, light and dark, and on a phone, where nothing changes. Needs Chrome (CHROME_BIN); skipped without it.
// TOPBAR_SHOTS=DIR saves a picture of the bar for every walk.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, seed, spawnServer, startChrome, startServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { EMAIL, fakeHome } from "../fake-subs.ts";

const ROOT = join(import.meta.dir, "..", "..");
setDefaultTimeout(60_000);
const chromeFound = !!findChrome();
const WIDTHS = [1151, 1280, 1440, 1920];
const THEMES = ["light", "dark"] as const;
const SHOTS = process.env.TOPBAR_SHOTS;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (expr: string) => page.evaluate(expr);
const J = JSON.stringify;
const until = async (expr: string, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`never true: ${expr}`);
};
const frames = () => ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
async function size(width: number, height = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  await frames();
  await frames();
}
async function press(sel: string) {
  const at = await ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!at) throw new Error(`nothing to press: ${sel}`);
  const [x, y] = at;
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await frames();
}
async function escape() {
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.s("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await frames();
}
// THEME the way the owner picks it: MENU, then LIGHT or DARK, then Esc.
async function theme(t: (typeof THEMES)[number]) {
  await press("#menuBtn");
  await press(`#menuDrop [data-set-theme="${t}"]`);
  await escape();
  expect(await ev(`document.documentElement.dataset.theme`)).toBe(t);
}
async function shot(name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const h = await ev(`Math.ceil(document.querySelector(".top").getBoundingClientRect().bottom + 12)`);
  const w = await ev(`innerWidth`);
  const { data } = await page.s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

// The bar as the owner sees it. "lines" is the most lines any label, number or the title takes (1 is no wrap).
const BAR = `(() => {
  const top = document.querySelector(".top"), row = top.querySelector(".right"), b = row.getBoundingClientRect();
  const seen = (e) => !!e && e.checkVisibility() && e.getBoundingClientRect().width > 0;
  const kids = [...row.children].filter((e) => seen(e) && !e.classList.contains("spacer"));
  const mids = new Set(kids.map((e) => { const k = e.getBoundingClientRect(); return Math.round((k.top + k.bottom) / 2); }));
  const inside = kids.every((e) => { const k = e.getBoundingClientRect(); return k.left >= b.left - 0.5 && k.right <= b.right + 0.5; });
  const texts = [...row.querySelectorAll(".k, .v, .title b")].filter(seen);
  const lines = Math.max(...texts.map((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).fontSize))));
  const w = document.getElementById("sWait").getBoundingClientRect();
  const count = (id) => { const e = document.getElementById(id); return seen(e) ? e.textContent : null; };
  return {
    fit: top.dataset.fit ?? null, height: Math.round(top.getBoundingClientRect().height), oneRow: mids.size === 1, inside, lines,
    wait: [Math.round(w.width), Math.round(w.height)], scrolls: document.documentElement.scrollWidth > innerWidth,
    title: [...row.querySelectorAll(".title b")].filter(seen).map((e) => e.textContent).join(""),
    working: count("sMove"), onHq: count("sHq"), queue: count("sQueue"), bank: count("sBank"),
    blocked: seen(document.getElementById("sBlocked")) ? document.querySelector("#sBlocked .v").textContent : null,
    machines: seen(document.getElementById("machines")) ? document.querySelector("#machines .v").innerText : null,
    machinesAlarm: document.getElementById("machines").classList.contains("off") || document.getElementById("machines").classList.contains("bad"),
    subs: seen(document.getElementById("subsBtn")) ? document.querySelector("#subsBtn .v").innerText : null,
    stall: document.querySelector(".strip").classList.contains("nomove") ? document.querySelector(".strip > div:first-child .k").innerText : null,
  };
})()`;
type Bar = { fit: string | null; height: number; oneRow: boolean; inside: boolean; lines: number; wait: number[]; scrolls: boolean; title: string; working: string | null; onHq: string | null; queue: string | null; bank: string | null; blocked: string | null; machines: string | null; machinesAlarm: boolean; subs: string | null; stall: string | null };
const bar = async (): Promise<Bar> => ev(BAR);

// BANK, wherever the bar keeps it: in the bar, or (step 6) at the top of MENU, opened with a real click.
async function bankShown(): Promise<string | null> {
  const inBar = (await bar()).bank;
  if (inBar !== null) {
    expect(await ev(`document.querySelector("#menuDrop .mbank").checkVisibility()`)).toBe(false);
    return inBar;
  }
  await press("#menuBtn");
  const inMenu = await ev(`(() => { const e = document.getElementById("mBank"); return e.checkVisibility() ? e.textContent : null; })()`);
  await escape();
  expect(await ev(`document.getElementById("menuDrop").hidden`)).toBe(true);
  return inMenu;
}

// The checks every desktop walk shares: one row, no wrap, inside its edge, the calm height, WAITING ON YOU as calm.
function oneCalmRow(b: Bar, calm: Bar) {
  expect(b.oneRow).toBe(true);
  expect(b.inside).toBe(true);
  expect(b.lines).toBe(1);
  expect(b.scrolls).toBe(false);
  expect(b.height).toBe(calm.height);
  expect(b.wait).toEqual(calm.wait);
}

// Every module has run: MENU has marked the current theme, and on a desktop the ladder has fitted the bar once.
const ready = () => until(`document.readyState === "complete" && !!document.querySelector("#menuDrop .seg.on[data-set-theme]") && (innerWidth < 1151 || document.querySelector(".top").hasAttribute("data-fit"))`);

// A walk starts with no errors, and leaves its page before its server stops (a cut stream is not the page's error).
const fresh = () => errors.splice(0);
const leave = () => page.s("Page.navigate", { url: "about:blank" });

const calm: Record<string, Bar> = {};
const fontLoaded = () => ev(`document.fonts.ready.then(() => document.fonts.check("12px 'Press Start 2P'"))`);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await chrome?.close();
});

test.skipIf(!chromeFound)("calm: at 1440 and 1920 the bar is as it was (no step on); at every width one row", async () => {
  fresh();
  const server = await startServer(ROOT);
  try {
    await seed(server.post);
    await size(1920);
    await page.s("Page.navigate", { url: server.base });
    await until(`document.querySelector("#sWait .count")?.textContent === "2"`);
    await ready();
    expect(await fontLoaded()).toBe(true);
    for (const t of THEMES) {
      await theme(t);
      for (const w of WIDTHS) {
        await size(w);
        const b = await bar();
        calm[`${w}-${t}`] = b;
        await shot(`calm-${w}-${t}`);
        expect(b.oneRow).toBe(true);
        expect(b.inside).toBe(true);
        expect(b.lines).toBe(1);
        if (w >= 1440) expect({ w, fit: b.fit, title: b.title }).toEqual({ w, fit: "", title: "HQ OFFICE" });
        expect(await bankShown()).toBe(await ev(`document.getElementById("sBank").textContent`));
      }
    }
    // the height of one row is the same at every width and in both themes
    expect(new Set(Object.values(calm).map((b) => b.height)).size).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await leave();
    await server.stop();
  }
});

// Every box busy: SUBS with seven subscriptions, MACHINES naming a machine that is away, HQ QUEUE on, a lane blocked
// at a prompt, a question waiting on you, two floors. The away machine's long name is the worst MACHINES can say.
const AWAY = "machine-far-away-two";
function busyHome() {
  const home = fakeHome();
  const dir = join(home, ".local", "state", "herdr", "plugins", "wazum.grazr", "accounts");
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  for (const [i, name] of ["team-charlie", "team-delta", "team-echo"].entries())
    writeFileSync(join(dir, `dddddddd-${i}${i}${i}${i}-4${i}${i}${i}-8${i}${i}${i}-${String(i).repeat(12)}.json`), J({ name, email: EMAIL, organization: "Made Up Ltd", snapshot: [{ kind: "session", scope: null, group: "session", remaining: 30 + i * 20, resets_at: at(2) }, { kind: "weekly_all", scope: null, group: "weekly", remaining: 70, resets_at: at(48) }] }));
  return home;
}

test.skipIf(!chromeFound)("busy and stalled: one calm row at every width and theme; every count and alarm in view, BANK in the bar or in MENU", async () => {
  fresh();
  const dir = mkdtempSync(join(tmpdir(), "hq-topbar-busy-"));
  const subsHome = mkdtempSync(join(tmpdir(), "hq-topbar-subs-"));
  const made = busyHome();
  cpSync(made, subsHome, { recursive: true });
  const agent = (name: string, status = "idle") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" });
  const herdr = fakeHerdr(dir, [agent("hq"), agent("hq-two"), agent("golf", "working"), agent("alpha", "blocked"), agent("bravo")]);
  const server = await spawnServer({ cwd: ROOT, env: { ...process.env, HOME: dir, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: `local,${AWAY}`, HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_SUBS_HOME: subsHome, HUD_SUBS_MS: "150" } });
  const post = (path: string, body: object) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: J(body) }).then((r) => r.json());
  try {
    for (const name of ["golf", "alpha", "bravo"]) await post("/api/lanes", { name, machine: "local", title: `Lane ${name}` });
    await post("/api/floors", { id: "two", name: "TWO", hq: "hq-two" });
    await post("/api/settings", { settings: { hqQueue: true } });
    const ask = await post("/api/asks", { lane: "bravo", kind: "decision", title: "Ship the thing?", options: ["Yes", "No"] });
    await post("/api/sync", {});
    await size(1920);
    await page.s("Page.navigate", { url: server.base });
    await until(`document.querySelector("#sWait .count")?.textContent === "1"`);
    await until(`!!document.getElementById("subsBtn") && /^7 OK|\\d OK/.test(document.querySelector("#subsBtn .v").innerText) && document.querySelectorAll("#subsBtn .v i").length === 7`);
    await until(`document.getElementById("machines").classList.contains("off")`);
    await until(`document.getElementById("sBlocked")?.checkVisibility() && !document.getElementById("sQueueCell").hidden`);
    await ready();
    expect(await fontLoaded()).toBe(true);

    const walk = async (mode: string) => {
      const fits: Record<string, string | null> = {};
      for (const t of THEMES) {
        await theme(t);
        for (const w of WIDTHS) {
          await size(w);
          const b = await bar();
          await shot(`${mode}-${w}-${t}`);
          oneCalmRow(b, calm[`${w}-${t}`]);
          expect({ w, t, working: b.working !== null, onHq: b.onHq !== null, queue: b.queue !== null, blocked: b.blocked, subs: /\d OK$/.test(b.subs ?? ""), alarm: b.machinesAlarm, machines: /(OFF|\d+%)$/.test(b.machines ?? "") })
            .toEqual({ w, t, working: true, onHq: true, queue: true, blocked: "1", subs: true, alarm: true, machines: true });
          expect(await bankShown()).toBe(await ev(`document.getElementById("sBank").textContent`));
          // a real click opens SUBS over the office; the bar stays as it was
          await press("#subsBtn");
          expect(await ev(`!document.getElementById("subsDrop").hidden`)).toBe(true);
          expect((await bar()).height).toBe(b.height);
          await escape();
          fits[`${w}-${t}`] = b.fit;
        }
      }
      // the narrowest bar needs steps, and the steps are the same in both themes
      expect(fits["1151-light"]).not.toBe("");
      for (const w of WIDTHS) expect(fits[`${w}-dark`]).toBe(fits[`${w}-light`]);
      return fits;
    };

    const busy = await walk("busy");
    // the same width gives the same steps however the window got there
    for (const w of [1920, 1151, 1440, 1280, 1920, 1440]) {
      await size(w);
      expect({ w, fit: (await bar()).fit }).toEqual({ w, fit: busy[`${w}-dark`] });
    }

    // stalled: nothing moving and nothing waiting on you, on the page clock 5 minutes on
    await post(`/api/asks/${ask.id}/answer`, { answer: "Yes" });
    herdr.world(herdr.agents().map((a) => (a.name === "golf" ? { ...a, agent_status: "idle" } : a)));
    await post("/api/sync", {});
    await until(`document.querySelector("#sWait .count")?.textContent === "0"`);
    await ev(`(() => { const real = Date.now.bind(Date); Date.now = () => real() + 5 * 60000; })()`);
    await ev(`import("/src/client/core/bus.js").then((m) => m.emit("tick"))`);
    await until(`document.querySelector(".strip").classList.contains("nomove")`);
    const stalled = await walk("stalled");
    for (const w of WIDTHS) {
      await size(w);
      expect(["NOTHING MOVING", "STALLED"]).toContain((await bar()).stall);
    }
    expect(stalled["1151-light"]).not.toBe("");
    expect(errors).toEqual([]);
  } finally {
    await leave();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(subsHome, { recursive: true, force: true });
    rmSync(made, { recursive: true, force: true });
  }
});

test.skipIf(!chromeFound)("a phone keeps its stacked bar: no step, the full title and MENU, no sideways scroll", async () => {
  fresh();
  const server = await startServer(ROOT);
  try {
    await seed(server.post);
    await size(390, 844, true);
    await page.s("Page.navigate", { url: server.base });
    await until(`document.querySelector("#sWait .count")?.textContent === "2"`);
    await ready();
    for (const t of THEMES) {
      await theme(t);
      const b = await bar();
      await shot(`phone-${t}`);
      expect({ fit: b.fit, title: b.title, menu: await ev(`document.querySelector("#menuBtn .long").checkVisibility()`), scrolls: b.scrolls })
        .toEqual({ fit: null, title: "HQ OFFICE", menu: true, scrolls: false });
    }
    expect(errors).toEqual([]);
  } finally {
    await leave();
    await server.stop();
  }
});
