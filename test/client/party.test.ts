// PARTY, in Chrome, at 1440 and 390: the WORKING cell in the top bar opens a panel over the room that lists every lane by
// floor with its status, scoped like everything else; it stays closed until opened; a row chooses its agent; it takes turns
// with the other panels, Escape closes it before the scope, and it never covers an open question. The WORKING cell keeps its
// place in the strip. Needs Chrome (CHROME_BIN); skipped without it. Written for the other machine's Chrome run.
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
const press = (key: string) => ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }))`);
const click = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const scopeOf = () => ev(`JSON.parse(sessionStorage.getItem("hq-scope") ?? "null")`);
const closed = `document.getElementById("partyPanel").innerHTML === ""`;
const groups = () => ev(`[...document.querySelectorAll("#partyPanel .pygrp")].map((g) => ({ floor: g.querySelector(".floortag")?.textContent ?? "", lanes: [...g.querySelectorAll(".lrow")].map((r) => r.dataset.select) }))`) as Promise<{ floor: string; lanes: string[] }[]>;
const status = (lane: string) => ev(`document.querySelector('#partyPanel [data-select="${lane}"] .tag:last-child').textContent`);

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
  await until(`!!document.getElementById("partyPanel")`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  general = await startFloors();
  single = await startFloors({ general: false });
  page = await newSession(chrome.cdp, errors);
}, 60_000);
afterAll(async () => {
  await general?.stop();
  await single?.stop();
  await chrome?.close();
});

for (const [width, height] of SIZES) {
  const at = `${width}`;

  test.skipIf(!chromeFound)(`${at}: PARTY is closed until WORKING is pressed, then lists every lane by floor with its status`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    expect(await ev(closed)).toBe(true);
    // the cell keeps its place in the strip, first of three
    expect(await ev(`[...document.querySelectorAll(".strip > div .k")].map((k) => k.textContent)`)).toEqual(["WORKING", "ON HQ", "₽ BANK"]);
    await click("#sMove");
    await until(`document.querySelectorAll("#partyPanel .lrow").length === 12`);
    const g = await groups();
    expect(g.map((x) => x.floor)).toEqual(FACTS.labels);
    expect(g[0].lanes).toEqual(["hq-api", "hq-ops", "hq-pm", "hq-web"]);
    expect(g[1].lanes[0]).toBe("fin"); // a floor's general first
    expect(g[1].lanes).toEqual(["fin", "fin-audit", "fin-books", "fin-recon"]);
    expect(await status(FACTS.blocked)).toBe("BLOCKED ON A PROMPT");
    expect(await status(FACTS.stalled)).toBe("WAITING ON HQ 15+ MIN");
    // its count is the strip's
    const strip = await ev(`document.getElementById("sMove").textContent`);
    expect(await ev(`document.querySelector("#partyPanel .pyhdr .tag").textContent`)).toBe(`${strip} WORKING`);
    expect(await ev(`document.getElementById("sMove").parentElement.getAttribute("aria-expanded")`)).toBe("true");
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: scoped to a floor PARTY lists that floor's lanes, and to an agent that lane`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await click("#sMove");
    await until(`document.querySelectorAll("#partyPanel .pygrp").length === 3`);
    // a row chooses its agent and PARTY gets out of the way
    await click(`#partyPanel [data-select="sales-lead"]`);
    await until(closed);
    expect(await scopeOf()).toMatchObject({ floor: "sales", agent: "sales-lead" });
    await click("#sMove");
    await until(`document.querySelectorAll("#partyPanel .lrow").length === 1`);
    expect((await groups())[0].lanes).toEqual(["sales-lead"]);
    // the strip's WORKING follows the same scope as the panel
    const strip = await ev(`document.getElementById("sMove").textContent`);
    expect(await ev(`document.querySelector("#partyPanel .pyhdr .tag").textContent`)).toBe(`${strip} WORKING`);
    await click(".scopechip");
    await until(`document.querySelectorAll("#partyPanel .lrow").length === 4`);
    expect((await groups())[0].lanes).toEqual(["sales", "sales-lead", "sales-outb", "sales-pm"]);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: it takes turns with RUNDOWN and ACCOUNTS, and the cell toggles it`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await click("#sMove");
    await until(`document.getElementById("partyPanel").innerHTML !== ""`);
    await click("#rundownBtn");
    await until(`${closed} && document.getElementById("rundownPanel").innerHTML !== ""`);
    await click("#sMove");
    await until(`document.getElementById("rundownPanel").innerHTML === "" && document.getElementById("partyPanel").innerHTML !== ""`);
    await click("#accounts");
    await until(closed);
    await click("#sMove");
    await until(`document.getElementById("partyPanel").innerHTML !== ""`);
    await click("#sMove");
    await until(closed);
    expect(await ev(`document.querySelectorAll(".room.party-open").length`)).toBe(0);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: the keyboard opens it from the cell, and Escape closes it before the scope`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await ev(`(() => { const b = document.createElement("button"); b.dataset.select = "fin-audit"; document.body.append(b); b.click(); b.remove(); })()`);
    await until(`document.querySelector(".scopechip")?.textContent === "FIN FLOOR › fin-audit ✕"`);
    await ev(`document.getElementById("sMove").parentElement.focus()`);
    await ev(`document.getElementById("sMove").parentElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    await until(`document.getElementById("partyPanel").innerHTML !== ""`);
    await press("Escape");
    await until(closed);
    expect(await scopeOf()).toMatchObject({ floor: "fin", agent: "fin-audit" });
    await press("Escape");
    await until(`document.querySelector(".scopechip")?.textContent === "FIN FLOOR ✕"`);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: an open question stays in view with PARTY open`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    const before = await ev(`document.querySelectorAll("#hud .ask").length`);
    await click("#sMove");
    await until(`document.querySelectorAll("#partyPanel .lrow").length === 12`);
    expect(await ev(`document.querySelectorAll("#hud .ask").length`)).toBe(before);
    expect(
      await ev(`(() => { const a = document.getElementById("partyPanel").getBoundingClientRect(), b = document.getElementById("hud").getBoundingClientRect(); return a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1; })()`),
    ).toBe(true);
  }, 30_000);
}

test.skipIf(!chromeFound)("one floor: PARTY lists the lanes of the one floor with no floor tag", async () => {
  for (const [width, height] of SIZES) {
    await open(single.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length === 3`);
    await click("#sMove");
    await until(`document.querySelectorAll("#partyPanel .lrow").length === 4`);
    expect(await groups()).toEqual([{ floor: "", lanes: ["hq-api", "hq-ops", "hq-pm", "hq-web"] }]);
    await press("Escape");
    await until(closed);
  }
  expect(errors).toEqual([]);
}, 60_000);
