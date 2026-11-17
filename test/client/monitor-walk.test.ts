// THE MONITOR's page, driven in Chrome with real clicks and keys on a replayed hour (scripts/monitor-fixture.ts): which
// moment it shows as the range changes. Now is the newest sample in every range, another range keeps the moment, and
// only picking a day changes it. Then the keys: what an arrow steps by, what Space does where, and where the focus is
// after Back to now. On a phone, a day that is picked comes into view. Last, a server whose monitor could not open
// its database: the page says the server's own sentence for it. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { writeFixture } from "../../scripts/monitor-fixture.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const errors: string[] = [];
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
let data = "";

const ev = (expression: string) => page.evaluate(expression);
async function until(expression: string) {
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(40)) if (await ev(expression).catch(() => false)) return;
  throw new Error(`timed out waiting for ${expression}`);
}
async function click(selector: string) {
  const at = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.hidden) return null; e.scrollIntoView({ block: "center", behavior: "instant" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (!at) throw new Error(`nothing to click at ${selector}`);
  const [x, y] = at;
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await Bun.sleep(60);
}
async function press(key: string, code: number) {
  for (const type of ["rawKeyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key, code: key === " " ? "Space" : key, windowsVirtualKeyCode: code });
  await Bun.sleep(60);
}
const shown = () => ev(`document.querySelector("#when").textContent`) as Promise<string>;
const focused = () => ev(`document.activeElement.id`) as Promise<string>;
const playing = () => ev(`document.querySelector("#play").getAttribute("aria-pressed")`) as Promise<string>;
const SPACE = [" ", 32] as const;
const range = (key: string) => click(`#ranges [data-range="${key}"]`);
const today = ".cd.today";
// A moment of the past as the page names it, in whatever zone the browser is in.
const A_TIME = /^\w{3} \d{1,2} \w{3}, (\d\d):(\d\d)$/;

beforeAll(async () => {
  if (!chromeFound) return;
  data = mkdtempSync(join(tmpdir(), "hq-monitor-walk-"));
  // The calm hour: its worst moment is not its newest, so a picked day and now are two moments.
  writeFixture(join(data, "replay"), "calm");
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: join(data, "data"), HERDR_BIN: fakeHerdr(join(data, "herdr"), []).bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_SUBS_HOME: join(data, "subs"), HUD_MONITOR_REPLAY: join(data, "replay"), HUD_MONITOR_DISK: "0" },
  });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/monitor` });
  await until(`!!document.querySelector("#app.ready .tile:not(.nil)")`);
}, 120_000);

afterAll(async () => {
  await page?.s("Page.navigate", { url: "about:blank" });
  await server?.stop();
  await chrome?.close();
  if (data) rmSync(data, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("choosing 90 days at now stays at now", async () => {
  expect(await shown()).toBe("Now");
  await range("quarter");
  expect(await shown()).toBe("Now");
  expect(await ev(`document.querySelector("#nowbtn").hidden && document.querySelector("#backnow").hidden`)).toBe(true);
});

test.skipIf(!chromeFound)("picking a day shows its worst moment, and Now, Back to now and End each lead back to the newest sample", async () => {
  for (const back of [() => click("#nowbtn"), () => click("#backnow"), () => click("#live"), () => press("End", 35)]) {
    await click(today);
    expect(await shown()).not.toBe("Now");
    await back();
    expect(await shown()).toBe("Now");
  }
});

test.skipIf(!chromeFound)("another range keeps the moment: now stays now, and a picked day's moment stays that moment", async () => {
  for (const key of ["hour", "day", "week", "quarter"]) {
    await range(key);
    expect(await shown()).toBe("Now");
  }
  await click(today);
  const picked = await shown();
  expect(picked).toMatch(A_TIME);
  await range("hour");
  expect(await shown()).toBe(picked);
  await range("quarter");
  expect(await shown()).toBe(picked);
  await click("#nowbtn");
  await range("hour");
  expect(await shown()).toBe("Now");
});

test.skipIf(!chromeFound)("a moment scrubbed to in one range is the moment in the next, and Now leaves it in every one", async () => {
  await ev(`document.querySelector("#plot").focus()`);
  for (let i = 0; i < 7; i++) await press("ArrowLeft", 37);
  const scrubbed = await shown();
  const [, hour, minute] = scrubbed.match(A_TIME)!;
  // A step is named by when it ends. One of 24 hours is five minutes: the one that holds the moment ends on the
  // next five minutes.
  await range("day");
  expect(await shown()).toBe(scrubbed.replace(`${hour}:${minute}`, `${hour}:${String(Math.ceil(Number(minute) / 5) * 5).padStart(2, "0")}`));
  await range("quarter");
  expect(await shown()).not.toBe("Now");
  await click("#nowbtn");
  expect(await shown()).toBe("Now");
  await range("hour");
  expect(await shown()).toBe("Now");
});

// The minutes of a time the page shows, counted from midnight.
const minutesOf = (said: string) => { const [, hour, minute] = said.match(/(\d\d):(\d\d)/)!; return Number(hour) * 60 + Number(minute); };

test.skipIf(!chromeFound)("an arrow key steps one minute in 1 hour: the minute before now, the one before that, and back to now", async () => {
  await range("hour");
  await ev(`document.querySelector("#plot").focus()`);
  const now = minutesOf((await ev(`document.querySelector("#whenago").textContent`)) as string);
  const back = (n: number) => (now - n + 1440) % 1440;
  await press("ArrowLeft", 37);
  expect(minutesOf(await shown())).toBe(back(1));
  await press("ArrowLeft", 37);
  expect(minutesOf(await shown())).toBe(back(2));
  await press("ArrowRight", 39);
  expect(minutesOf(await shown())).toBe(back(1));
  await press("ArrowRight", 39);
  expect(await shown()).toBe("Now");
});

test.skipIf(!chromeFound)("the help says what an arrow key steps by in each range", async () => {
  const hint = () => ev(`document.querySelector("#hint").textContent`) as Promise<string>;
  for (const [key, step] of [["hour", "one minute"], ["day", "5 minutes"], ["week", "30 minutes"], ["quarter", "one day"]]) {
    await range(key);
    expect(await hint()).toContain(`step ${step},`);
    expect(await ev(`document.querySelector("#prev").getAttribute("aria-label")`)).toBe(`${step[0].toUpperCase()}${step.slice(1)} back`);
  }
  await range("hour");
});

test.skipIf(!chromeFound)("Space on a focused tile opens it, as Enter does, and it stays open", async () => {
  for (const key of [SPACE, ["Enter", 13]] as const) {
    await ev(`document.querySelector("#stage > .tile:not(.nil)").focus()`);
    await press(...key);
    await until(`!document.querySelector("#dive").hidden && document.activeElement.textContent.startsWith("Back to")`);
    await Bun.sleep(300);
    expect(await ev(`document.querySelector("#dive").hidden`)).toBe(false);
    expect(await playing()).toBe("false");
    await press("Escape", 27);
    await until(`document.querySelector("#dive").hidden`);
  }
});

test.skipIf(!chromeFound)("Space plays from the strip and from Play, and nowhere else", async () => {
  await ev(`document.querySelector("#g-swap").focus()`);
  await press(...SPACE);
  expect(await playing()).toBe("false");
  for (const id of ["plot", "play"]) {
    await ev(`document.querySelector("#${id}").focus()`);
    await press(...SPACE);
    expect(await playing()).toBe("true");
    await press(...SPACE);
    expect(await playing()).toBe("false");
  }
  await press("End", 35);
});

test.skipIf(!chromeFound)("Back to now leaves the focus on the playhead, and on Play where there is no strip", async () => {
  for (const back of ["#nowbtn", "#backnow", "#live"]) {
    await ev(`document.querySelector("#plot").focus()`);
    await press("ArrowLeft", 37);
    expect(await shown()).not.toBe("Now");
    await click(back);
    expect(await shown()).toBe("Now");
    expect(await focused()).toBe("plot");
  }
  await range("quarter");
  await click(today);
  await click("#nowbtn");
  expect([await shown(), await focused()]).toEqual(["Now", "play"]);
  await range("hour");
});

test.skipIf(!chromeFound)("on a phone, a day that is tapped brings its moment on the map into view", async () => {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.s("Page.navigate", { url: `${server.base}/monitor` });
  await until(`!!document.querySelector("#app.ready .tile:not(.nil)")`);
  const tap = async (selector: string) => {
    const [x, y] = (await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", behavior: "instant" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)) as number[];
    await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(120);
  };
  const map = `document.querySelector("#mapwrap").getBoundingClientRect()`;
  await tap(`#ranges [data-range="quarter"]`);
  await until(`!document.querySelector("#quarter").hidden`);
  // With the calendar's last row in the middle of the screen, the map is above it and out of sight.
  await ev(`document.querySelector("${today}").scrollIntoView({ block: "center", behavior: "instant" })`);
  expect(await ev(`${map}.bottom < 0`)).toBe(true);
  await tap(today);
  await until(`${map}.top >= 0 && ${map}.top < innerHeight / 2`);
  expect(await shown()).toMatch(A_TIME);
});

// macOS only: elsewhere the monitor is off before it looks for its database.
test.skipIf(!chromeFound || process.platform !== "darwin")("a monitor that could not open its database: the page says it is off, and why in the server's words", async () => {
  // A folder where the file should be, so only the monitor's own file is in the way.
  mkdirSync(join(data, "blocked", "monitor.db"), { recursive: true });
  const { HUD_MONITOR_REPLAY: _, ...env } = process.env;
  const blocked = await spawnServer({
    cwd: ROOT,
    env: { ...env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: join(data, "blocked"), HERDR_BIN: fakeHerdr(join(data, "herdr-blocked"), []).bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_SUBS_HOME: join(data, "subs"), HUD_MONITOR: "1", HUD_MONITOR_DISK: "0" },
  });
  try {
    const { failed } = (await (await fetch(`${blocked.base}/api/monitor/now`)).json()) as { failed: string };
    expect(failed).toStartWith("The monitor's database, monitor.db in the data folder, could not be opened (");
    await page.s("Page.navigate", { url: `${blocked.base}/monitor` });
    await until(`document.querySelector("#gate-p").textContent.includes("could not be opened")`);
    expect(await ev(`[document.querySelector("#gate-h").textContent, document.querySelector("#gate-p").textContent, document.querySelector("#app").classList.contains("ready")]`)).toEqual([
      "The monitor is off on this server.",
      `${failed} The page asks again every 10 seconds.`,
      false,
    ]);
    await page.s("Page.navigate", { url: "about:blank" });
  } finally {
    await blocked.stop();
  }
});

// The ways in open the monitor in this same tab: a tab a script opens is out of sight, or never opens, in an app window
// or a phone's home-screen app. ← HQ comes back, and an unsent note is still there. ⌘-click still gives a tab of its own.
test.skipIf(!chromeFound)("MACHINES and MENU › MONITOR open the monitor in this tab, and ← HQ comes back", async () => {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const hud = async () => {
    await until(`location.pathname === "/" && document.readyState === "complete" && document.getElementById("machines").getAttribute("role") === "link" && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`);
  };
  const tabs = async () => (await chrome.cdp.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "page").length;
  const before = await tabs();
  await page.s("Page.navigate", { url: `${server.base}/` });
  await hud();
  await ev(`(document.getElementById("noteText").value = "a note not sent yet", true)`);
  await click("#machines");
  await until(`location.pathname === "/monitor" && !!document.querySelector("#app.ready .tile:not(.nil)")`);
  expect(await tabs()).toBe(before);
  await click("a.home");
  await hud();
  expect(await ev(`document.getElementById("noteText").value`)).toBe("a note not sent yet");
  await click("#menuBtn");
  await click("#monitorBtn");
  await until(`location.pathname === "/monitor" && !!document.querySelector("#app.ready .tile:not(.nil)")`);
  expect(await tabs()).toBe(before);
  await click("a.home");
  await hud();
  const at = await ev(`(() => { const r = document.getElementById("machines").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1, modifiers: 4 });
  for (const end = Date.now() + 10_000; Date.now() < end && (await tabs()) === before; ) await Bun.sleep(50);
  expect(await tabs()).toBe(before + 1);
  expect(await ev(`location.pathname`)).toBe("/");
  for (const t of (await chrome.cdp.send("Target.getTargets")).targetInfos) if (t.type === "page" && t.url.endsWith("/monitor")) await chrome.cdp.send("Target.closeTarget", { targetId: t.targetId });
}, 120_000);

test.skipIf(!chromeFound)("the page raised no error", () => {
  expect(errors).toEqual([]);
});
