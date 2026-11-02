// SUBS on the page: not there with no source; there once a source is; its dropdown opens from the box, closes on Esc
// and on a click elsewhere, and never covers the open question, side by side or stacked. Needs Chrome (CHROME_BIN);
// skipped without it. The server reads a made-up home (test/fake-subs.ts), never the owner's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, seed, startChrome, startServer } from "../../scripts/room-hash.ts";
import { LEAKS, fakeHome } from "../fake-subs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const home = mkdtempSync(join(tmpdir(), "hq-subs-page-"));
const made = fakeHome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];

const until = async (expr: string, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`never true: ${expr}`);
};
const size = async (width: number, height: number) => {
  await page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`dispatchEvent(new Event("resize"))`);
};
const SHOWN = `!!document.querySelector(".subswrap")`;
const OPEN = `!document.getElementById("subsDrop").hidden`;
// The dropdown and the question panel share no pixel.
const APART = `(() => { const d = document.getElementById("subsDrop").getBoundingClientRect(), q = document.querySelector(".qwrap").getBoundingClientRect(); return q.height > 0 && !(d.left < q.right && d.right > q.left && d.top < q.bottom && d.bottom > q.top); })()`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HUD_SUBS_HOME: home, HUD_SUBS_MS: "150" });
  await seed(server.post);
  page = await newSession(chrome.cdp, errors);
  await size(1440, 900);
  await page.s("Page.navigate", { url: server.base });
  await until(`document.querySelectorAll(".q").length > 0 || document.querySelector("#sWait .count")?.textContent === "2"`);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(made, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("with no source anywhere there is no SUBS box in the page", async () => {
  await Bun.sleep(600);
  expect(await page.evaluate(SHOWN)).toBe(false);
  expect(await page.evaluate(`!!document.getElementById("machines")`)).toBe(true);
});

test.skipIf(!chromeFound)("a source shows the box; the dropdown opens, closes on Esc and on a click elsewhere", async () => {
  cpSync(made, home, { recursive: true });
  await until(SHOWN);
  expect(await page.evaluate(`document.getElementById("subsBtn").textContent`)).toContain("SUBS");
  await page.evaluate(`document.getElementById("subsBtn").click()`);
  expect(await page.evaluate(OPEN)).toBe(true);
  const text = await page.evaluate(`document.getElementById("subsDrop").textContent`);
  for (const name of ["team-alpha", "side-bravo", "CODEX", "no 5-hour limit reported", "resets in"]) expect(text).toContain(name);
  expect(await page.evaluate(APART)).toBe(true);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  expect(await page.evaluate(OPEN)).toBe(false);
  expect(await page.evaluate(`document.activeElement?.id`)).toBe("subsBtn");
  await page.evaluate(`document.getElementById("subsBtn").click()`);
  await page.evaluate(`document.querySelector(".qwrap").click()`);
  expect(await page.evaluate(OPEN)).toBe(false);
});

test.skipIf(!chromeFound)("no account id, email, token or transcript text reaches the page", async () => {
  await page.evaluate(`document.getElementById("subsBtn").click()`);
  const html = await page.evaluate(`document.documentElement.outerHTML + JSON.stringify(localStorage) + JSON.stringify(sessionStorage)`);
  for (const leak of LEAKS) expect(html).not.toContain(leak);
  await page.evaluate(`document.getElementById("subsBtn").click()`);
});

test.skipIf(!chromeFound)("stacked on a narrow screen, it opens under the question panel, not over it", async () => {
  await size(800, 900);
  await until(`matchMedia("(max-width: 1150px)").matches`); // the stacked layout applies
  await page.evaluate(`scrollTo(0, 0); document.getElementById("subsBtn").click()`);
  expect(await page.evaluate(OPEN)).toBe(true);
  await until(APART, 3000); // placed once the narrow layout applies
  // a question that arrives while it is open makes the panel taller: the dropdown moves down with it
  const before = await page.evaluate(`document.querySelectorAll("#hud .ask").length`);
  await fetch(`${server.base}/api/asks`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ kind: "decision", title: "A question that arrives while SUBS is open", body: "Long enough to make the question panel taller.\n\nSecond paragraph.", options: ["Yes", "No"] }) });
  await until(`document.querySelectorAll("#hud .ask").length > ${before}`);
  await until(APART, 3000);
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await size(1440, 900);
}, 20_000);

test.skipIf(!chromeFound)("when the sources go away, the box goes too, with no error on the page", async () => {
  rmSync(join(home, ".local"), { recursive: true, force: true });
  rmSync(join(home, ".codex"), { recursive: true, force: true });
  await until(`!document.querySelector(".subswrap")`);
  expect(errors).toEqual([]);
});
