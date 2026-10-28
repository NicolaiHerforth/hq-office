// RUNDOWN, in Chrome, at 1440 and 390: the button in the stage bar opens a panel over the room that lists each floor's
// projects with their state, owner, open calls and brief; a scope lists one floor; it takes turns with the other panels;
// Escape closes it before the scope; it never covers or pushes away an open question. On an office with one floor the
// bar holds RUNDOWN alone. Needs Chrome (CHROME_BIN); skipped without it. Written for the other machine's Chrome run.
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
const choose = (lane: string) => ev(`(() => { const b = document.createElement("button"); b.dataset.select = ${JSON.stringify(lane)}; document.body.append(b); b.click(); b.remove(); })()`);
const scopeOf = () => ev(`JSON.parse(sessionStorage.getItem("hq-scope") ?? "null")`);
const panelOpen = () => ev(`document.getElementById("rundownPanel").innerHTML !== ""`);
const floorsListed = () => ev(`[...document.querySelectorAll("#rundownPanel .rdfloor")].map((f) => f.querySelector(".floortag")?.textContent ?? "")`) as Promise<string[]>;
const projects = () => ev(`[...document.querySelectorAll("#rundownPanel .rproj")].map((p) => ({ title: p.querySelector("b").textContent, state: p.querySelector(".tag.st").textContent, brief: p.querySelector(".rbrief")?.textContent ?? null, owner: p.querySelector(".tag.lane").textContent, calls: p.querySelector(".tag.count")?.textContent ?? null, room: p.querySelector("a.go").getAttribute("href") }))`) as Promise<{ title: string; state: string; brief: string | null; owner: string; calls: string | null; room: string }[]>;
const STATE_NAMES = { waiting: "WAITING ON YOU", blocked: "BLOCKED AT A PROMPT", stalled: "STALLED", moving: "MOVING" } as Record<string, string>;

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
  await until(`!!document.getElementById("rundownBtn")`);
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

  test.skipIf(!chromeFound)(`${at}: RUNDOWN is closed until opened, then lists every floor's projects with state, owner, open calls and brief`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length === ${Object.values(FACTS.waiting).reduce((a, b) => a + b, 0)}`);
    expect(await panelOpen()).toBe(false);
    expect(await ev(`document.querySelector("#rundownBtn").getAttribute("aria-pressed")`)).toBe("false");
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rproj").length === 5`);
    expect(await floorsListed()).toEqual(FACTS.labels);
    const list = await projects();
    expect(list.map((p) => p.title)).toEqual(["Ship the release", "Fix the web build", "Reconcile March", "Pipeline review", "Outbound calls"]);
    expect(list.map((p) => p.state)).toEqual(FACTS.rooms.hq.concat(FACTS.rooms.fin, FACTS.rooms.sales).map((s) => STATE_NAMES[FACTS.roomStates[s]]));
    expect(list.map((p) => p.owner)).toEqual(["hq-pm", "hq-web", "fin-recon", "sales-lead", "sales-outb"]);
    // a project with no brief shows none: no placeholder line
    await until(`document.querySelectorAll("#rundownPanel .rbrief").length === 3`);
    expect((await projects()).map((p) => p.brief)).toEqual([FACTS.briefs.release, null, FACTS.briefs.recon, FACTS.briefs.pipeline, null]);
    // only the questions that name a project count: release and outbound have one each; "The pipeline moved" is asked by a member of outbound and names no room
    const slugs = FACTS.rooms.hq.concat(FACTS.rooms.fin, FACTS.rooms.sales);
    expect(list.map((p) => p.calls)).toEqual(slugs.map((s) => (FACTS.roomCalls[s] ? `${FACTS.roomCalls[s]} OPEN CALL${FACTS.roomCalls[s] === 1 ? "" : "S"}` : null)));
    expect(list.map((p) => p.room)).toEqual(["#room/release", "#room/web-fix", "#room/recon", "#room/pipeline", "#room/outbound"]);
    expect(await ev(`document.querySelector("#rundownBtn").getAttribute("aria-pressed")`)).toBe("true");
    // the explanatory words stay out of it
    expect(await ev(`document.getElementById("rundownPanel").textContent.includes("Each general")`)).toBe(false);
    // help dots on the floors that have someone needing help
    expect(await ev(`document.querySelectorAll("#rundownPanel .rdfloor h3 .dot").length`)).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: scoped to a floor RUNDOWN lists that floor alone, and widens with it`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rdfloor").length === 3`);
    await choose("fin-audit"); // scopes to the FIN floor and its agent
    await until(`document.querySelectorAll("#rundownPanel .rdfloor").length === 1`);
    expect(await floorsListed()).toEqual(["FIN"]);
    expect((await projects()).map((p) => p.title)).toEqual(["Reconcile March"]);
    expect(await panelOpen()).toBe(true); // choosing an agent does not close it
    // ✕ on the chip steps out, and the panel follows
    await click(".scopechip"); // the agent first: its floor is still the scope
    await until(`document.querySelector(".scopechip")?.textContent === "FIN FLOOR ✕"`);
    expect(await floorsListed()).toEqual(["FIN"]);
    await click(".scopechip");
    await until(`document.querySelectorAll("#rundownPanel .rdfloor").length === 3`);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: it takes turns with the project panel and ACCOUNTS, and a PROJECT button opens that project`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rproj").length === 5`);
    await click(`#rundownPanel [data-project="release"]`);
    await until(`document.getElementById("projectPanel").innerHTML !== ""`);
    expect(await panelOpen()).toBe(false);
    await click("#rundownBtn");
    await until(`document.getElementById("projectPanel").innerHTML === "" && document.getElementById("rundownPanel").innerHTML !== ""`);
    await click("#accounts");
    await until(`document.getElementById("rundownPanel").innerHTML === ""`);
    expect(await ev(`document.querySelectorAll(".room.rundown-open").length`)).toBe(0);
    // the button toggles
    await click("#accounts");
    await click("#rundownBtn");
    await until(`document.getElementById("rundownPanel").innerHTML !== ""`);
    await click("#rundownBtn");
    await until(`document.getElementById("rundownPanel").innerHTML === ""`);
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: Escape closes RUNDOWN before it touches the scope, then steps the scope out`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    await choose("sales-outb");
    await until(`document.querySelector(".scopechip")?.textContent === "SALES FLOOR › sales-outb ✕"`);
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rproj").length === 2`);
    await press("Escape");
    await until(`document.getElementById("rundownPanel").innerHTML === ""`);
    expect(await scopeOf()).toMatchObject({ floor: "sales", agent: "sales-outb" });
    await press("Escape");
    await until(`document.querySelector(".scopechip")?.textContent === "SALES FLOOR ✕"`);
    expect(await scopeOf()).toMatchObject({ floor: "sales", agent: null });
  }, 30_000);

  test.skipIf(!chromeFound)(`${at}: an open question stays in view and answerable with RUNDOWN open`, async () => {
    await open(general.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length > 0`);
    const before = await ev(`document.querySelectorAll("#hud .ask").length`);
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rproj").length === 5`);
    expect(await ev(`document.querySelectorAll("#hud .ask").length`)).toBe(before);
    // the panel sits over the room only: it does not overlap the question column
    expect(
      await ev(`(() => { const a = document.getElementById("rundownPanel").getBoundingClientRect(), b = document.getElementById("hud").getBoundingClientRect(); return a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1; })()`),
    ).toBe(true);
    // the first question still opens its reply
    expect(await ev(`(() => { const e = document.querySelector("#hud .ask"); const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })()`)).toBe(true);
  }, 30_000);
}

test.skipIf(!chromeFound)("one floor: the bar holds RUNDOWN alone, and it lists HQ's projects with no floor tag", async () => {
  for (const [width, height] of SIZES) {
    await open(single.base, width, height);
    await until(`document.querySelectorAll("#hud .ask").length === 3`);
    expect(await ev(`[...document.querySelectorAll(".stagebar button")].filter((b) => !b.hidden).map((b) => b.id)`)).toEqual(["rundownBtn"]);
    await click("#rundownBtn");
    await until(`document.querySelectorAll("#rundownPanel .rproj").length === ${FACTS.rooms.hq.length}`);
    expect(await floorsListed()).toEqual([""]);
    expect(await ev(`document.querySelectorAll("#rundownPanel .floortag").length`)).toBe(0);
    await press("Escape");
    await until(`document.getElementById("rundownPanel").innerHTML === ""`);
  }
  expect(errors).toEqual([]);
}, 60_000);
