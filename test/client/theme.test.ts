// MENU › THEME in a real browser against a temporary server: SYSTEM (the default) follows the browser's light or dark
// scheme as it changes, DARK and LIGHT picked in MENU win over it and survive a reload, and in dark no panel, card,
// dropdown or dialog is left light while an open question stays in view and readable. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, seed, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const scheme = (value: "light" | "dark") => page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
const load = async () => {
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML && !!document.querySelector(".ask")`);
};
const theme = () => ev(`document.documentElement.dataset.theme ?? "system"`);
const bg = (sel: string) => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`);
const pick = async (t: string) => {
  if (await ev(`document.getElementById("menuDrop").hidden`)) await ev(`document.getElementById("menuBtn").click()`);
  await ev(`document.querySelector('#menuDrop [data-set-theme="${t}"]').click()`);
};
const picked = () => ev(`[...document.querySelectorAll("#menuDrop [data-set-theme]")].filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.setTheme)`);
const CREAM = "rgb(248, 248, 240)", DARK_BOX = "rgb(34, 37, 58)";

// Every element that shows a light background (relative luminance over 0.4), leaving out what keeps its colours in
// both themes on purpose: a colour set inline (a floor's or a status's), the legend's keys, images and the canvas;
// and an ink fill (a picked tab, a lane's tag), which turns light in dark with dark text on it.
const LIGHT_BACKGROUNDS = `(() => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); if (m.length > 3 && m[3] < 0.5) return 0; return m.slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); };
  const out = [], ink = getComputedStyle(document.body).color;
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest(".legend, canvas, img, [style*=background]") || !el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === ink) continue;
    if (lum(cs.backgroundColor) > 0.4) out.push((el.id ? "#" + el.id : el.tagName.toLowerCase()) + "." + [...el.classList].join(".") + " " + cs.backgroundColor);
  }
  return out;
})()`;

// The contrast of a question's title, timer and options against the card behind them, and whether the card is in view.
const QUESTION = `(() => {
  const lum = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const ask = document.querySelector(".ask:has(.opt)"), r = ask.getBoundingClientRect(), back = getComputedStyle(ask).backgroundColor;
  return { inView: r.top >= 0 && r.top < innerHeight && r.width > 0, title: ratio(getComputedStyle(ask.querySelector("h3")).color, back), timer: ratio(getComputedStyle(ask.querySelector(".timer")).color, back), option: ratio(getComputedStyle(ask.querySelector(".opt")).color, back) };
})()`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  await seed(server.post);
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await scheme("light");
  await load();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("SYSTEM is the default and follows the browser's scheme as it changes, without a reload", async () => {
  expect(await theme()).toBe("system");
  expect(await picked()).toEqual(["system"]);
  expect(await bg(".ask")).toBe(CREAM);
  await scheme("dark");
  await until(`getComputedStyle(document.querySelector(".ask")).backgroundColor === ${JSON.stringify(DARK_BOX)}`);
  expect(await ev(`getComputedStyle(document.documentElement).colorScheme`)).toBe("dark");
  await scheme("light");
  await until(`getComputedStyle(document.querySelector(".ask")).backgroundColor === ${JSON.stringify(CREAM)}`);
});

test.skipIf(!chromeFound)("DARK picked in MENU wins over a light browser, keeps MENU open, and survives a reload", async () => {
  await pick("dark");
  expect(await ev(`document.getElementById("menuDrop").hidden`)).toBe(false);
  expect(await theme()).toBe("dark");
  expect(await picked()).toEqual(["dark"]);
  expect(await bg(".ask")).toBe(DARK_BOX);
  await load();
  expect(await theme()).toBe("dark");
  expect(await bg(".ask")).toBe(DARK_BOX);
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("in dark, no panel, card, dropdown or dialog is left light", async () => {
  expect(await theme()).toBe("dark");
  expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  // MENU's dropdown
  await ev(`document.getElementById("menuBtn").click()`);
  expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  // the secrets panel over the stage
  await ev(`document.getElementById("secretsBtn").click()`);
  await until(`!document.getElementById("secretsPanel").hidden`);
  expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  await ev(`document.querySelector("[data-secrets-close]").click()`);
  // the settings dialog
  await ev(`document.getElementById("menuBtn").click()`);
  await ev(`document.getElementById("settingsBtn").click()`);
  await until(`!document.getElementById("settings").hidden`);
  expect(await bg("#settings")).toBe(DARK_BOX);
  expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  // the worker card
  await ev(`document.querySelector('[data-select="bravo"]').click()`);
  await until(`!document.getElementById("card").hidden`);
  expect(await bg("#card")).toBe(DARK_BOX);
  expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  // the floor list
  await ev(`document.querySelector(".fswitch [data-pill]")?.click()`);
  if (await ev(`!!document.querySelector(".fmenu:not([hidden])")`)) {
    expect(await bg(".fmenu")).toBe(DARK_BOX);
    expect(await ev(LIGHT_BACKGROUNDS)).toEqual([]);
  }
  // the other lists over the question column
  for (const tab of ["messages", "work", "rooms", "briefs"]) {
    await ev(`document.querySelector('[data-qtab="${tab}"]').click()`);
    expect({ tab, light: await ev(LIGHT_BACKGROUNDS) }).toEqual({ tab, light: [] });
  }
  await ev(`document.querySelector('[data-qtab="questions"]').click()`);
});

test.skipIf(!chromeFound)("in dark, an open question stays in view and reads (4.5:1 or more)", async () => {
  const q = await ev(QUESTION);
  expect(q.inView).toBe(true);
  for (const k of ["title", "timer", "option"]) expect({ k, ok: q[k] >= 4.5 }).toEqual({ k, ok: true });
});

test.skipIf(!chromeFound)("LIGHT picked in MENU wins over a dark browser; SYSTEM gives the choice back to it", async () => {
  await scheme("dark");
  await pick("light");
  expect(await theme()).toBe("light");
  expect(await bg(".ask")).toBe(CREAM);
  await load();
  expect(await bg(".ask")).toBe(CREAM);
  await pick("system");
  expect(await theme()).toBe("system");
  expect(await ev(`localStorage.getItem("hq-theme")`)).toBe(null);
  expect(await bg(".ask")).toBe(DARK_BOX);
  await scheme("light");
  expect(await bg(".ask")).toBe(CREAM);
});
