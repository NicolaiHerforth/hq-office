// COMMENTS on the page: a brief's thread sits beside it on a wide screen and under it on a phone. Selecting text in a
// markdown brief and pressing COMMENT quotes it; SEND types the comment into the author (HQ here, through its outbox;
// the lane that posted an HTML brief; a room page's owner); an answer from the CLI shows in the open thread, and on a
// closed brief marks its row REPLY. An open question stays in view throughout. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-comments-page-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "writer", agent_status: "idle", pane_id: "w1:p3", agent: "claude" }]);
const BODY = "## Where we are\n\nThe pricing page is live since Monday.\n\n- one\n- two\n\n" + Array.from({ length: 12 }, (_, i) => `### Part ${i + 1}\n\nMore about the pricing work, step ${i + 1}.`).join("\n\n");

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}, pane?: string) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}) }, body: JSON.stringify(b) }).then((r) => r.json());
async function load(hash = "", w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  // These tests read the thread: this viewer keeps it open (COMMENTS; brief-view-controls tests the closed default).
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `try { if (location.origin !== "null") localStorage.setItem("hq-comments-open", "1"); } catch {}` });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
const rect = (sel: string) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; })()`) as Promise<{ l: number; r: number; t: number; b: number; w: number; h: number }>;
// The open question's card is on screen and not covered (on the questions tab: the tab picked last is remembered).
const askInView = () => ev(`(() => { document.querySelector('[data-qtab="questions"]')?.click(); const a = document.querySelector("[data-ask]"); if (!a) return false; const r = a.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= innerHeight || r.width < 100) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) + 10); return !!hit && a.contains(hit); })()`);
async function typeAndSend(text: string) {
  await ev(`(() => { const ta = document.querySelector(".cmount textarea"); ta.focus(); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await until(`!document.querySelector("[data-csend]").disabled`);
  await ev(`document.querySelector("[data-csend]").click()`);
}
let md = 0, html = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "writer", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/asks", { lane: "writer", kind: "decision", title: "Ship the pricing copy?", options: ["Yes", "No"] });
  md = (await post("/api/briefs", { title: "Weekly: pricing", body: BODY }, "w1:p1")).id;
  html = (await post("/api/briefs", { title: "Copy plan", body: "<!doctype html><html><body><h1>Copy plan</h1><p>Two sections.</p></body></html>" }, "w1:p3")).id;
  await post("/api/rooms", { slug: "copy", title: "Copy", owner: "writer" });
  await fetch(`${server.base}/api/rooms/copy/files?name=plan.html&title=plan.html&as=writer`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body: "<!doctype html><html><body><h1>Plan</h1></body></html>" });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a markdown brief: the thread beside it; select, COMMENT, SEND quotes the passage to HQ", async () => {
  await load(`#brief/${md}`);
  await until(`!!document.querySelector(".briefview .cmount .chead") && !document.querySelector(".cmount").hidden && !!document.querySelector(".cthread .empty:not(:empty)")`);
  const body = await rect(".briefview .bbody"), side = await rect(".briefview .cmount");
  expect(side.l).toBeGreaterThanOrEqual(body.r - 1); // beside, not under
  expect(side.w).toBeGreaterThanOrEqual(280);
  expect(Math.abs(side.t - body.t)).toBeLessThan(2);
  expect(await askInView()).toBe(true);
  // select a passage of the brief
  await ev(`(() => { const p = [...document.querySelectorAll(".briefview .md p")].find((x) => x.textContent.includes("live since")); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await until(`!document.querySelector(".cpick").hidden`);
  const pick = await rect(".cpick"), para = await ev(`(() => { const r = [...document.querySelectorAll(".briefview .md p")].find((x) => x.textContent.includes("live since")).getBoundingClientRect(); return { t: r.top, b: r.bottom }; })()`) as { t: number; b: number };
  expect(pick.b <= para.t + 1 || pick.t >= para.b - 1).toBe(true); // next to the selection, not over it
  await ev(`document.querySelector(".cpick").click()`);
  await until(`document.querySelector(".cquote")?.textContent.includes("The pricing page is live since Monday.")`);
  expect(await ev(`document.activeElement === document.querySelector(".cmount textarea")`)).toBe(true);
  await typeAndSend("Why already live?");
  await until(`document.querySelector(".cthread .msg.you .seen.ok")?.textContent === "DELIVERED"`);
  expect(await ev(`document.querySelector(".cthread .msg.you .cq").textContent.trim()`)).toBe("The pricing page is live since Monday.");
  expect(await ev(`document.querySelector(".cquote").textContent`)).toBe(""); // the quote went with it
  const got = herdr.typedInto("hq").filter((t) => t.includes("Why already live?"));
  expect(got.length).toBe(1);
  expect(got[0]).toContain("> The pricing page is live since Monday.\nWhy already live?");
  expect(await askInView()).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("an answer from the CLI appears in the open thread; on a closed brief its row says REPLY", async () => {
  await post("/api/comments/reply", { page: `briefs/${md}`, text: "Because the **launch** moved up." }, "w1:p1");
  await until(`[...document.querySelectorAll(".cthread .msg.lane")].some((m) => m.querySelector(".who").textContent === "hq" && m.querySelector(".text b")?.textContent === "launch")`);
  // REPLY quotes it in the send box
  await ev(`document.querySelector("[data-creply]").click()`);
  await until(`document.querySelector(".creply")?.textContent.includes("Because the")`);
  await ev(`document.querySelector("[data-cunreply]").click()`);
  // closed: a new answer marks the brief's row
  await ev(`document.querySelector("[data-brief-back]").click()`);
  await until(`document.querySelector(".briefview").hidden`);
  await post("/api/comments/reply", { page: `briefs/${md}`, text: "And the docs are ready." }, "w1:p1");
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`[...document.querySelectorAll('#briefs .brow[href="#brief/${md}"] .tag')].some((t) => t.textContent === "REPLY")`);
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`document.getElementById("msgs").textContent.includes("hq answered on brief: Weekly: pricing")`);
  // opening it reads the answer: the mark goes
  await ev(`location.hash = "#brief/${md}"`);
  await until(`[...document.querySelectorAll(".cthread .msg.lane .text")].some((t) => t.textContent.includes("docs are ready"))`);
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`![...document.querySelectorAll('#briefs .brow[href="#brief/${md}"] .tag')].some((t) => t.textContent === "REPLY")`);
}, 30_000);

test.skipIf(!chromeFound)("an HTML brief and a room's page: the thread beside the frame, comments go to the lane", async () => {
  await load(`#brief/${html}`);
  await until(`!!document.querySelector(".briefview .pageframe") && !!document.querySelector(".briefview .cmount .chead")`);
  await until(`document.querySelector(".cmount .cto").textContent === "to writer"`);
  const frame = await rect(".briefview .pageframe"), side = await rect(".briefview .cmount");
  expect(side.l).toBeGreaterThanOrEqual(frame.r - 1);
  expect(frame.h).toBeGreaterThan(400);
  await typeAndSend("Shorter headline?");
  await until(`document.querySelector(".cthread .msg.you .seen.ok")?.textContent === "DELIVERED"`);
  expect(herdr.typedInto("writer").some((t) => t.includes("Shorter headline?") && t.includes(`hud brief reply ${html}`))).toBe(true);

  await load("#page/rooms/copy/files/plan.html");
  await until(`!!document.querySelector(".pageview .pageframe") && !!document.querySelector(".pageview .cmount .chead")`);
  const pf = await rect(".pageview .pageframe"), ps = await rect(".pageview .cmount");
  expect(ps.l).toBeGreaterThanOrEqual(pf.r - 1);
  await typeAndSend("Swap the sections.");
  await until(`document.querySelector(".pageview .cthread .msg.you .seen.ok")?.textContent === "DELIVERED"`);
  expect(herdr.typedInto("writer").some((t) => t.includes("Swap the sections.") && t.includes("hud page reply rooms/copy/files/plan.html"))).toBe(true);
  expect(await askInView()).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("on a phone one COMMENTS: the bar's opens the thread as a sheet over a brief, BACK stays, nothing scrolls sideways", async () => {
  await load(`#brief/${md}`, 390, 844, true);
  await until(`!!document.querySelector(".briefview .cmount .cthread .msg")`);
  const v = await rect(".briefview");
  expect([v.l, v.t, Math.round(v.w), Math.round(v.h)]).toEqual([0, 0, 390, 844]);
  expect(await ev(`getComputedStyle(document.querySelector(".briefview .cmount")).display`)).toBe("none");
  expect(await ev(`getComputedStyle(document.querySelector("[data-cjump]")).display`)).toBe("none"); // no second, floating one
  await ev(`document.querySelector(".bvbar [data-comments-toggle]").click()`);
  await until(`document.querySelector(".cmount").classList.contains("sheet")`);
  await Bun.sleep(260);
  const sheet = await rect(".briefview .cmount");
  expect(Math.round(sheet.b)).toBe(836);
  expect(await ev(`(() => { const r = document.querySelector(".cmount textarea").getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  await ev(`document.querySelector("[data-cclose]").click()`);
  await until(`!document.querySelector(".cmount").classList.contains("open")`);
  expect(await ev(`(() => { const b = document.querySelector("[data-brief-back]").getBoundingClientRect(); return b.top >= 0 && b.top < 80; })()`)).toBe(true); // BACK stays in reach
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth && document.querySelector(".briefview").scrollWidth <= innerWidth`)).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("on a phone a page brief keeps the whole view; COMMENTS opens the thread as a sheet over it, its close closes it", async () => {
  await load(`#brief/${html}`, 390, 844, true);
  await until(`!!document.querySelector(".briefview .pageframe") && !!document.querySelector(".briefview .cmount .cthread .msg")`);
  const v = await rect(".briefview"), f = await rect(".briefview .pageframe");
  expect(Math.round(v.b - f.b)).toBeLessThanOrEqual(6); // the page to the foot of the screen
  expect(await ev(`(() => { const v = document.querySelector(".briefview"); return v.scrollHeight <= v.clientHeight + 1; })()`)).toBe(true);
  // the compact bar (date, by writer) fits the 390px screen: OLDER is on it, whole
  expect(await ev(`(() => { const b = document.querySelector(".bvbar"), o = [...b.querySelectorAll(".btn-s")].find((x) => x.textContent === "OLDER").getBoundingClientRect(); return o.left >= 0 && o.right <= innerWidth && b.scrollWidth <= b.clientWidth + 1; })()`)).toBe(true);
  expect(await ev(`getComputedStyle(document.querySelector("[data-cjump]")).display`)).toBe("none");
  await ev(`document.querySelector(".bvbar [data-comments-toggle]").click()`);
  await until(`document.querySelector(".cmount").classList.contains("open") && getComputedStyle(document.querySelector(".cmount")).position === "fixed"`);
  await Bun.sleep(260);
  const sheet = await rect(".briefview .cmount");
  expect(Math.round(sheet.b)).toBe(836); // 8 px up, as every sheet on a phone
  expect(sheet.t).toBeGreaterThan(100);
  expect(await ev(`(() => { const r = document.querySelector(".cmount textarea").getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  await ev(`document.querySelector("[data-cclose]").click()`);
  await until(`!document.querySelector(".cmount").classList.contains("open")`);
  expect(errors).toEqual([]);
}, 30_000);

// A send held at the door until let go, so what happens during it is what the test says, not a race.
for (const [name, w, h, mobile] of [["wide", 1440, 900, false], ["phone", 390, 844, true]] as const) {
  const holdSend = () => ev(`(() => { const real = window.fetch; window.__sent = null; window.fetch = (u, o) => String(u).includes("/api/comments/post") ? new Promise((ok, no) => { window.__sent = () => ok(real(u, o)); window.__refuse = () => no(new TypeError("Failed to fetch")); }) : real(u, o); })()`);
  const toast = () => ev(`[...document.querySelectorAll(".toast")].at(-1)?.textContent ?? ""`);
  const toastSays = (words: string) => until(`([...document.querySelectorAll(".toast")].at(-1)?.textContent ?? "").includes(${JSON.stringify(words)})`);
  const box = () => ev(`document.querySelector(".cmount textarea").value`);
  const press = () => ev(`document.querySelector("[data-csend]").click()`);
  const letGo = () => ev(`window.__sent(); undefined`);
  const openBox = async () => {
    await ev(`window.__before = true`).catch(() => {});
    await load(`#brief/${md}`, w, h, mobile);
    await until(`!window.__before && !!document.querySelector(".briefview .cmount .cthread .msg")`);
    if (mobile) {
      await ev(`document.querySelector(".bvbar [data-comments-toggle]").click()`);
      await until(`!!document.querySelector(".cmount.sheet")`);
    }
  };
  const type = async (text: string) => {
    await ev(`(() => { const t = document.querySelector(".cmount textarea"); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
    await page.s("Input.insertText", { text });
  };
  const setBox = (text: string) => ev(`(() => { const t = document.querySelector(".cmount textarea"); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const typed = async (words: string) => {
    for (const end = Date.now() + 5000; Date.now() < end && !herdr.typedInto("hq").some((t) => t.includes(words)); await Bun.sleep(50));
    await Bun.sleep(100);
    return herdr.typedInto("hq").filter((t) => t.includes(words)).length;
  };

  test.skipIf(!chromeFound)(`${name}: words typed while a comment sends stay, and a second SEND says it is still sending`, async () => {
    await openBox();
    const said = `Held comment, ${name}`, more = `what I added, ${name}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await type(` ${more}`);
    await press();
    await toastSays("STILL SENDING THE LAST ONE");
    await letGo();
    await toastSays("STILL HERE");
    expect(await box()).toBe(more);
    expect(await typed(said)).toBe(1);
    expect(herdr.typedInto("hq").some((t) => t.includes(more))).toBe(false);
    expect(await ev(`document.querySelector("[data-csend]").disabled`)).toBe(false);
    // What stayed goes with the next SEND, by itself.
    await letGoNext();
    await until(`document.querySelector(".cmount textarea").value === ""`);
    expect(await typed(more)).toBe(1);
    expect(herdr.typedInto("hq").filter((t) => t.includes(said)).length).toBe(1);
  }, 30_000);
  const letGoNext = async () => {
    await ev(`window.__sent = null; undefined`);
    await press();
    await until(`!!window.__sent`);
    await letGo();
  };

  test.skipIf(!chromeFound)(`${name}: a double tap on a comment's SEND sends once and says so`, async () => {
    await openBox();
    const said = `Tapped twice, ${name}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await press();
    await until(`[...document.querySelectorAll(".toast")].at(-1)?.textContent === "STILL SENDING."`);
    await letGo();
    await toastSays("SENT TO");
    await until(`document.querySelector(".cmount textarea").value === ""`);
    expect(await toast()).not.toMatch(/STILL HERE/);
    expect(await typed(said)).toBe(1);
  }, 30_000);

  test.skipIf(!chromeFound)(`${name}: a box emptied while a comment sends: SEND still answers, and it goes once`, async () => {
    await openBox();
    const said = `Emptied after, ${name}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await setBox("");
    expect(await ev(`document.querySelector("[data-csend]").disabled`)).toBe(false);
    await press();
    await toastSays("STILL SENDING");
    await letGo();
    await toastSays("SENT TO");
    expect(await box()).toBe("");
    expect(await ev(`document.querySelector("[data-csend]").disabled`)).toBe(true);
    expect(await typed(said)).toBe(1);
  }, 30_000);

  test.skipIf(!chromeFound)(`${name}: an edit of the words being sent is not cut`, async () => {
    await openBox();
    const said = `Edited while it went, ${name}`, now = `I changed my mind: ${said}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await setBox(now);
    await letGo();
    await toastSays("STILL HERE");
    expect(await box()).toBe(now);
    expect(await typed(said)).toBe(1);
    await setBox("");
  }, 30_000);

  test.skipIf(!chromeFound)(`${name}: what went is cleared; a quote and a picture added while it sends stay`, async () => {
    await openBox();
    const key = `briefs/${md}`, box_ = `comment:${key}`, chips = `[data-chips="${box_}"] .chip`;
    const add = (file: string) => ev(`(import("/src/client/images/images.js").then((m) => m.addFiles([new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], ${JSON.stringify(file)}, { type: "image/png" })], ${JSON.stringify(box_)})), undefined)`);
    const ready = () => until(`(async () => (await import("/src/client/images/images.js")).notReady(${JSON.stringify(box_)}) === "")()`);
    const quote = (text: string) => ev(`(import("/src/client/core/bus.js").then((m) => m.emit("comments:quote", { key: ${JSON.stringify(key)}, text: ${JSON.stringify(text)} })), undefined)`);
    const said = `With a picture and a quote, ${name}`;
    await type(said);
    await quote("The first passage");
    await until(`document.querySelector(".cquote").textContent.includes("The first passage")`);
    await add(`first-${name}.png`);
    await until(`document.querySelectorAll(${JSON.stringify(chips)}).length === 1`);
    await ready();
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await add(`second-${name}.png`);
    await until(`document.querySelectorAll(${JSON.stringify(chips)}).length === 2`);
    await ready();
    await quote("A later passage");
    await letGo();
    await toastSays("STILL HERE");
    expect(await ev(`document.querySelectorAll(${JSON.stringify(chips)}).length`)).toBe(1);
    expect(await ev(`document.querySelector(".cquote").textContent`)).toContain("A later passage");
    expect(await box()).toBe("");
    expect(await typed(said)).toBe(1);
    const went = herdr.typedInto("hq").find((t) => t.includes(said))!;
    expect(went).toContain("The first passage");
    expect(went).toContain(`first-${name}.png`);
    expect(went).not.toContain(`second-${name}.png`);
    expect(went).not.toContain("A later passage");
    await ev(`(import("/src/client/images/images.js").then((m) => m.clearImages(${JSON.stringify(box_)})), undefined)`);
    await ev(`document.querySelector("[data-cunquote]").click()`);
  }, 30_000);

  test.skipIf(!chromeFound)(`${name}: a comment that fails keeps the words, and SEND works again`, async () => {
    await openBox();
    const said = `Failed first, ${name}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await ev(`window.__refuse(); undefined`);
    await until(`!![...document.querySelectorAll(".toast")].at(-1)`);
    await until(`!document.querySelector("[data-csend]").disabled`);
    expect(await box()).toBe(said);
    await letGoNext();
    await toastSays("SENT TO");
    await until(`document.querySelector(".cmount textarea").value === ""`);
    expect(await typed(said)).toBe(1);
  }, 30_000);

  test.skipIf(!chromeFound)(`${name}: the brief left and opened again during a send: the box there shows only what stayed`, async () => {
    await openBox();
    const said = `Left while it went, ${name}`, more = `added before leaving, ${name}`;
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await type(` ${more}`);
    await ev(`document.querySelector("[data-brief-back]").click()`);
    await until(`document.querySelector(".briefview").hidden`);
    await ev(`location.hash = "#brief/${md}"`);
    await until(`!document.querySelector(".briefview").hidden && !!document.querySelector(".briefview .cmount textarea")`);
    await letGo();
    await toastSays("SENT TO");
    await until(`document.querySelector(".briefview .cmount textarea").value === ${JSON.stringify(more)}`);
    expect(await typed(said)).toBe(1);
    await setBox("");
  }, 30_000);

  if (mobile) test.skipIf(!chromeFound)("phone: the sheet closed during a comment's send: the toast says COMMENTS has the words, and they are there", async () => {
    await openBox();
    const said = "Closed while it went", more = "added before closing";
    await type(said);
    await holdSend();
    await press();
    await until(`!!window.__sent`);
    await type(` ${more}`);
    await ev(`document.querySelector("[data-cclose]").click()`);
    await until(`!document.querySelector(".cmount.sheet")`);
    await letGo();
    await toastSays("COMMENTS HAS WHAT YOU ADDED SINCE");
    await ev(`document.querySelector(".bvbar [data-comments-toggle]").click()`);
    await until(`!!document.querySelector(".cmount.sheet")`);
    expect(await box()).toBe(more);
    await setBox("");
    await ev(`document.querySelector("[data-cclose]").click()`);
  }, 30_000);
}

test.skipIf(!chromeFound)("no page errors while comments were sent", () => expect(errors.filter((e) => !/Failed to fetch/.test(e))).toEqual([]));
