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

test.skipIf(!chromeFound)("on a phone the thread is under the brief, COMMENTS jumps to it, nothing scrolls sideways", async () => {
  await load(`#brief/${md}`, 390, 844, true);
  await until(`!!document.querySelector(".briefview .cmount .cthread .msg")`);
  const v = await rect(".briefview"), body = await rect(".briefview .bbody"), c = await rect(".briefview .cmount");
  expect([v.l, v.t, Math.round(v.w), Math.round(v.h)]).toEqual([0, 0, 390, 844]);
  expect(c.t).toBeGreaterThanOrEqual(body.b - 1); // under the brief
  expect(c.w).toBeGreaterThan(300);
  expect(await ev(`getComputedStyle(document.querySelector("[data-cjump]")).display`)).toBe("block");
  await ev(`document.querySelector("[data-cjump]").click()`);
  await until(`(() => { const r = document.querySelector(".cmount .chead").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`, 4000);
  await until(`getComputedStyle(document.querySelector("[data-cjump]")).display === "none"`);
  expect(await ev(`(() => { const b = document.querySelector("[data-brief-back]").getBoundingClientRect(); return b.top >= 0 && b.top < 80; })()`)).toBe(true); // BACK stays in reach
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth && document.querySelector(".briefview").scrollWidth <= innerWidth`)).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("on a phone a page brief keeps the whole view; COMMENTS opens the thread as a sheet over it, × closes it", async () => {
  await load(`#brief/${html}`, 390, 844, true);
  await until(`!!document.querySelector(".briefview .pageframe") && !!document.querySelector(".briefview .cmount .cthread .msg")`);
  const v = await rect(".briefview"), f = await rect(".briefview .pageframe");
  expect(Math.round(v.b - f.b)).toBeLessThanOrEqual(6); // the page to the foot of the screen
  expect(await ev(`(() => { const v = document.querySelector(".briefview"); return v.scrollHeight <= v.clientHeight + 1; })()`)).toBe(true);
  // the compact bar (date, by writer) fits the 390px screen: OLDER is on it, whole
  expect(await ev(`(() => { const b = document.querySelector(".bvbar"), o = [...b.querySelectorAll(".btn-s")].find((x) => x.textContent === "OLDER").getBoundingClientRect(); return o.left >= 0 && o.right <= innerWidth && b.scrollWidth <= b.clientWidth + 1; })()`)).toBe(true);
  expect(await ev(`getComputedStyle(document.querySelector("[data-cjump]")).display`)).toBe("block");
  await ev(`document.querySelector("[data-cjump]").click()`);
  await until(`document.querySelector(".cmount").classList.contains("open") && getComputedStyle(document.querySelector(".cmount")).position === "fixed"`);
  const sheet = await rect(".briefview .cmount");
  expect(Math.round(sheet.b)).toBe(844);
  expect(sheet.t).toBeGreaterThan(100);
  expect(await ev(`(() => { const r = document.querySelector(".cmount textarea").getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  await until(`getComputedStyle(document.querySelector("[data-cjump]")).display === "none"`);
  await ev(`document.querySelector("[data-cclose]").click()`);
  await until(`!document.querySelector(".cmount").classList.contains("open") && getComputedStyle(document.querySelector("[data-cjump]")).display === "block"`);
  expect(errors).toEqual([]);
}, 30_000);
