// ROOMS in Chrome against a temporary server: the tab's count of rooms with new lane messages and its list; a room
// as a place you go to (its address #room/SLUG, BACK TO OFFICE, Esc, the browser's back button, a reload, the strip
// of rooms), with the question column untouched; an open room's lanes, brief, shelf and thread; the thread keeping
// its height beside a long brief and many artifacts, with no scroll area inside another; line breaks in messages;
// the rail's fold, remembered; writing to the owner and to a member; the pixel strip; and the phone: a full-screen
// view with CHAT, BRIEF and SHELF (no zoom, no sideways page, the newest message in view, no jump when a message
// lands while you read older ones). Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const click = (sel: string) => page.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const size = (width: number, height: number, mobile: boolean) => Promise.all([
  page.s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile }),
  page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 }),
]);
const load = async (hash = "") => {
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML && !!window.__roomsReady`);
};
const press = (key: string) => page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }))`);
const inRoom = (slug: string) => `location.hash === "#room/${slug}" && !document.getElementById("roomView").hidden && getComputedStyle(document.querySelector(".stage > .room")).display === "none" && !!document.querySelector("#roomView .rthread [data-rmsg], #roomView .rthread .empty:not(:empty)")`;
const inOffice = `location.hash === "" && document.getElementById("roomView").hidden && getComputedStyle(document.querySelector(".stage > .room")).display !== "none"`;
const qcol = `JSON.stringify((({ x, y, width, height }) => [x, y, width, height])(document.querySelector(".desk").getBoundingClientRect()))`;

const LONG_BRIEF = Array.from({ length: 12 }, (_, i) => `### Part ${i + 1}\nA paragraph that goes on for a while about part ${i + 1}, so that the brief is far longer than the screen.\n- a point\n- another point`).join("\n\n");

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  // The stub herdr knows golf (working) and alpha (idle); bravo is away.
  for (const name of ["alpha", "golf", "bravo"]) await server.post("/api/lanes", { name, machine: "local" });
  await server.post("/api/sync", {});
  await server.post("/api/rooms", { slug: "ope-7", title: "Search relevance", owner: "alpha", members: ["golf", "bravo"], issues: ["OPE-7"] });
  await server.post("/api/rooms/ope-7/brief", { body: "## Plan\n- [x] baseline\n- [ ] rerank\n\nSee [the doc](https://example.com/doc) <script>window.pwned = 1</script> [bad](javascript:alert(1))\n\n```\nbun test\n```" });
  await server.post("/api/rooms/ope-7/artifacts", { title: "Eval report", url: "https://claude.ai/artifact/abc" });
  await server.post("/api/rooms/ope-7/artifacts", { title: "Dashboard", url: "https://example.com/dash" });
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  await fetch(`${server.base}/api/rooms/ope-7/files?name=shot.png&title=Screenshot`, { method: "POST", headers: { "content-type": "image/png", "x-hud": "1" }, body: png });
  for (let i = 1; i <= 14; i++) await server.post("/api/rooms/ope-7/say", { text: `Finding ${i}: the reranker moves item ${i} up.\nA second line.` });
  // A second room, with a brief far longer than the screen, six artifacts and a long thread.
  await server.post("/api/rooms", { slug: "ope-9", title: "Billing export", owner: "golf", members: ["alpha"] });
  await server.post("/api/rooms/ope-9/brief", { body: LONG_BRIEF });
  for (let i = 1; i <= 6; i++) await server.post("/api/rooms/ope-9/artifacts", { title: `Artifact number ${i} with a longer title`, url: `https://example.com/a/${i}` });
  for (let i = 1; i <= 20; i++) await server.post("/api/rooms/ope-9/say", { text: `Step ${i} of the export is done.` });
  await server.post("/api/rooms/ope-9/say", { text: "First line\nsecond line\n\nA new paragraph\n- one\n- two" });
  page = await newSession(chrome.cdp, errors);
  // A flag the test waits on: the rooms module has run.
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `new MutationObserver((_, o) => { if (document.querySelector("#rooms .rlist") && document.getElementById("roomView")) { window.__roomsReady = true; o.disconnect(); } }).observe(document, { subtree: true, childList: true });` });
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await size(1440, 900, false);
  await load();
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("the ROOMS tab counts rooms with new lane messages, and lists the rooms", async () => {
  await until(`document.getElementById("qtRooms").textContent === "2" && !document.getElementById("qtRooms").hidden`);
  await click('[data-qtab="rooms"]');
  await until(`!!document.querySelector('#rooms [data-room="ope-7"]')`);
  const row = await page.evaluate(`document.querySelector('[data-room="ope-7"]').innerText`);
  expect(row).toContain("Search relevance");
  expect(row).toContain("alpha");
  expect(row).toContain("14 NEW");
  expect(row).toContain("+2 LANES");
});

test.skipIf(!chromeFound)("a room is a place: the list goes there, the address names it, BACK, Esc and the browser's back return, the questions never move", async () => {
  const before = await page.evaluate(qcol);
  await click('[data-room="ope-7"]');
  await until(inRoom("ope-7"));
  // The question column and Tell HQ are where they were; the office is gone from the stage.
  expect(await page.evaluate(qcol)).toBe(before);
  expect(await page.evaluate(`getComputedStyle(document.querySelector(".tell")).display !== "none" && getComputedStyle(document.querySelector(".stage > .under")).display === "none"`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-room="ope-7"]').classList.contains("here")`)).toBe(true);
  // BACK TO OFFICE
  await click("[data-room-back]");
  await until(inOffice);
  expect(await page.evaluate(qcol)).toBe(before);
  // Esc
  await click('[data-room="ope-7"]');
  await until(inRoom("ope-7"));
  await press("Escape");
  await until(inOffice);
  // The browser's back button, then forward
  await click('[data-room="ope-7"]');
  await until(inRoom("ope-7"));
  await page.evaluate("history.back()");
  await until(inOffice);
  await page.evaluate("history.forward()");
  await until(inRoom("ope-7"));
  // The strip of rooms moves straight to another one, with its new messages marked; one back is the office.
  const chip = await page.evaluate(`document.querySelector('#roomView [data-room-go="ope-9"]').innerText`);
  expect(chip).toContain("Billing export");
  expect(chip).toContain("21");
  await click('#roomView [data-room-go="ope-9"]');
  await until(inRoom("ope-9"));
  await page.evaluate("history.back()");
  await until(inOffice);
  // A reload at a room's address opens it; BACK then leaves it.
  await load("#room/ope-7");
  await until(inRoom("ope-7"));
  await click("[data-room-back]");
  await until(inOffice);
  // An address with no such room: back to the office, and a word why.
  await load("#room/nope");
  await until(`location.hash === "" && document.getElementById("roomView").hidden && [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("NO ROOM NOPE"))`);
});

test.skipIf(!chromeFound)("an open room: lanes with level and away, brief as markdown and inert, three cards, the thread at its newest", async () => {
  await load("#room/ope-7");
  await until(`document.querySelectorAll("#roomView .rthread [data-rmsg]").length === 14 && !!document.querySelector("#roomView .rbrief .md")`);
  const v = await page.evaluate(`(() => {
    const r = document.getElementById("roomView"), md = r.querySelector(".rbrief .md");
    const last = [...r.querySelectorAll(".rthread [data-rmsg]")].pop().getBoundingClientRect(), t = r.querySelector(".rthread").getBoundingClientRect();
    return {
      lanes: [...r.querySelectorAll(".rtop .rlane")].map((b) => b.innerText.replace(/\\s+/g, " ").trim()),
      h: md.querySelector("h4")?.textContent, ticks: md.querySelectorAll(".tick.on").length, links: [...md.querySelectorAll("a")].map((a) => a.getAttribute("href")),
      scripts: md.querySelectorAll("script").length, text: md.textContent,
      font: (() => { const f = (e) => { const c = getComputedStyle(e); return [c.fontFamily, c.fontSize, c.lineHeight]; }; return { body: f(md.querySelector("p")), item: f(md.querySelector("li")), message: f(r.querySelector(".rthread .msg .text p")), label: getComputedStyle(r.querySelector(".rbrief .k")).fontFamily }; })(),
      code: md.querySelector(".codebox pre")?.textContent, copy: !!md.querySelector(".codebox .copy"),
      cards: [...r.querySelectorAll(".art")].map((a) => a.className.replace("art ", "")),
      lastInView: last.bottom <= t.bottom + 1 && last.top >= t.top - 1 && t.bottom <= innerHeight,
      sendInView: r.querySelector("[data-room-send]").getBoundingClientRect().bottom <= innerHeight,
      pageScroll: document.documentElement.scrollHeight > innerHeight,
    };
  })()`);
  // The owner first, then the members (added together: by name).
  expect(v.lanes).toEqual(["alpha MANAGER OWNER", "bravo MANAGER AWAY", "golf MANAGER"]);
  expect(v.h).toBe("Plan");
  expect(v.ticks).toBe(1);
  expect(v.links).toEqual(["https://example.com/doc"]);
  expect(v.scripts).toBe(0);
  // The brief reads like a message: the text font and size, the pixel font for its label only; code in a code box.
  expect(v.font.body).toEqual(v.font.message);
  expect(v.font.item).toEqual(v.font.message);
  expect(v.font.body[0]).not.toContain("Press Start");
  expect(v.font.label).toContain("Press Start");
  expect(v.code).toBe("bun test");
  expect(v.copy).toBe(true);
  expect(v.text).toContain("<script>");
  expect(await page.evaluate("window.pwned")).toBeUndefined();
  expect(v.cards).toEqual(["image", "link", "claude-artifact"]);
  expect(v).toMatchObject({ lastInView: true, sendInView: true, pageScroll: false });
  // Opening it marked the lanes' messages seen.
  await until(`!document.querySelector('#roomView [data-room-go="ope-7"] .tag')`);
  await click(".art.image [data-art-preview]");
  await until(`document.getElementById("imgPreview")?.open && document.querySelector("#imgPreview figcaption").textContent === "Screenshot"`);
  // Esc closes the preview, not the room.
  await press("Escape");
  await page.evaluate(`document.getElementById("imgPreview").close()`);
  expect(await page.evaluate(inRoom("ope-7"))).toBe(true);
});

test.skipIf(!chromeFound)("the thread keeps its height beside a long brief and six artifacts; each pane scrolls on its own", async () => {
  await load("#room/ope-9");
  await until(`document.querySelectorAll("#roomView .rshelf .art").length === 6 && document.querySelectorAll("#roomView .rthread [data-rmsg]").length === 21`);
  const v = await page.evaluate(`(() => {
    const r = document.getElementById("roomView"), t = r.querySelector(".rthread"), rail = r.querySelector(".rvrail"), send = r.querySelector(".rsend");
    const tr = t.getBoundingClientRect(), rr = rail.getBoundingClientRect(), sr = send.getBoundingClientRect(), vr = r.getBoundingClientRect();
    const scrolls = (e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1;
    const ancestors = (e) => { const a = []; for (let p = e.parentElement; p; p = p.parentElement) a.push(p); return a; };
    const last = [...t.querySelectorAll("[data-rmsg]")].pop().getBoundingClientRect();
    return {
      threadH: tr.height, viewH: vr.height,
      overlap: !(rr.right <= tr.left || rr.left >= tr.right || rr.bottom <= tr.top || rr.top >= tr.bottom),
      sendBelow: sr.top >= tr.bottom - 1 && sr.bottom <= innerHeight,
      threadScrolls: scrolls(t), railScrolls: scrolls(rail),
      nested: [t, rail].some((e) => ancestors(e).some((a) => /auto|scroll/.test(getComputedStyle(a).overflowY) && a !== document.documentElement && a !== document.body))
        || [...t.querySelectorAll("*"), ...rail.querySelectorAll("*")].some((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)),
      newest: last.bottom <= tr.bottom + 1,
      pageScroll: document.documentElement.scrollHeight > innerHeight,
    };
  })()`);
  expect(v.threadH).toBeGreaterThan(v.viewH * 0.5);
  expect(v).toMatchObject({ overlap: false, sendBelow: true, threadScrolls: true, railScrolls: true, nested: false, newest: true, pageScroll: false });
});

test.skipIf(!chromeFound)("a message's line breaks show: a break for a new line, a paragraph for a blank one, lists and code as markdown", async () => {
  const html = await page.evaluate(`[...document.querySelectorAll("#roomView .rthread .msg")].find((m) => m.innerText.includes("First line")).querySelector(".text").innerHTML`);
  expect(html).toContain("<p>First line<br>second line</p><p>A new paragraph</p><ul><li>one</li><li>two</li></ul>");
  // The owner's own message, sent from the box, keeps its breaks too.
  await page.evaluate(`(() => { const ta = document.querySelector("#roomView .rsend textarea"); ta.value = "one\\ntwo\\n\\nthree"; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await click("[data-room-send]");
  await until(`[...document.querySelectorAll("#roomView .msg.you")].some((m) => m.querySelector(".text").innerHTML === "<p>one<br>two</p><p>three</p>")`);
});

test.skipIf(!chromeFound)("the rail folds and opens, and this browser remembers it", async () => {
  const width = () => page.evaluate(`document.querySelector("#roomView .rthread").getBoundingClientRect().width`);
  const open = await width();
  await click("[data-rail-toggle]");
  await until(`getComputedStyle(document.querySelector("#roomView .rvrail")).display === "none"`);
  expect(await width()).toBeGreaterThan(open + 200);
  expect(await page.evaluate(`localStorage.getItem("hq-room-rail")`)).toBe("folded");
  expect(await page.evaluate(`document.querySelector("[data-rail-toggle]").getAttribute("aria-expanded")`)).toBe("false");
  await load("#room/ope-9");
  await until(inRoom("ope-9"));
  expect(await page.evaluate(`getComputedStyle(document.querySelector("#roomView .rvrail")).display`)).toBe("none");
  await click("[data-rail-toggle]");
  await until(`getComputedStyle(document.querySelector("#roomView .rvrail")).display !== "none"`);
  expect(await page.evaluate(`localStorage.getItem("hq-room-rail")`)).toBeNull();
});

test.skipIf(!chromeFound)("the strip draws the room's lanes at a table, and the office rests while a room covers it", async () => {
  await load("#room/ope-7");
  await until(inRoom("ope-7"));
  const v = await page.evaluate(`(() => {
    const c = document.querySelector("#roomView .rvpix"), g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data;
    let colours = new Set(); for (let i = 0; i < d.length; i += 4 * 97) colours.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]);
    return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, colours: colours.size };
  })()`);
  expect(v.h).toBe(48 * 3);
  expect(Math.abs(v.w / 3 * 2 - v.cssW)).toBeLessThan(4); // two screen pixels per art pixel
  expect(v.colours).toBeGreaterThan(8);
});

test.skipIf(!chromeFound)("writing: to the owner by default, to a member with To:, kept for a lane that is away", async () => {
  await load("#room/ope-7");
  await until(`!!document.querySelector("#roomView [data-room-send]")`);
  const write = async (text: string) => {
    await page.evaluate(`(() => { const ta = document.querySelector("#roomView .rsend textarea"); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await click("[data-room-send]");
    await until(`[...document.querySelectorAll("#roomView .msg.you")].some((m) => m.innerText.includes(${JSON.stringify(text)}) && !m.innerText.includes("SENDING"))`);
    return page.evaluate(`[...document.querySelectorAll("#roomView .msg.you")].pop().innerText`);
  };
  expect(await write("How far is the rerank?")).toMatch(/→ alpha[\s\S]*DELIVERED/);
  await page.evaluate(`(() => { const s = document.querySelector("[data-room-to]"); s.value = "golf"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  expect(await page.evaluate(`document.querySelector(".rsend .tostate").textContent`)).toBe("typed into golf");
  expect(await write("Golf, the numbers?")).toMatch(/→ golf[\s\S]*DELIVERED/);
  await page.evaluate(`(() => { const s = document.querySelector("[data-room-to]"); s.value = "bravo"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  expect(await page.evaluate(`document.querySelector(".rsend .tostate").textContent`)).toContain("AWAY");
  expect(await write("Bravo, when you are back.")).toMatch(/→ bravo[\s\S]*AWAY · KEPT/);
  const thread = await (await fetch(`${server.base}/api/rooms/ope-7`)).json();
  expect(thread.messages.slice(-3).map((m: any) => [m.to, m.delivery])).toEqual([["alpha", "sent"], ["golf", "sent"], ["bravo", "away"]]);
});

test.skipIf(!chromeFound)("phone: a full-screen room with CHAT, BRIEF and SHELF; no zoom, no sideways page; the thread opens at its newest and keeps your place", async () => {
  await size(390, 664, true);
  await load("#room/ope-7");
  await until(`!!document.querySelector("#roomView .rthread [data-rmsg]") && !!document.querySelector("#roomView .rbrief .md")`);
  // The thread settles at its newest message once the view has its size (a frame after the room is drawn).
  await until(`(() => { const t = document.querySelector("#roomView .rthread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 2; })()`, 3000);
  const shown = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== "none" && r.width > 0 && r.height > 0; })()`;
  const v = await page.evaluate(`(() => {
    const view = document.getElementById("roomView").getBoundingClientRect();
    const t = document.querySelector("#roomView .rthread"), s = getComputedStyle(t), last = [...t.querySelectorAll("[data-rmsg]")].pop().getBoundingClientRect(), tr = t.getBoundingClientRect();
    return {
      full: Math.round(view.left) === 0 && Math.round(view.top) === 0 && Math.round(view.width) === innerWidth && Math.round(view.height) === innerHeight,
      tabs: [...document.querySelectorAll("#roomView [data-ptab]")].map((b) => b.textContent),
      select: parseFloat(getComputedStyle(document.querySelector("[data-room-to]")).fontSize),
      textarea: parseFloat(getComputedStyle(document.querySelector("#roomView .rsend textarea")).fontSize),
      sendInView: document.querySelector("[data-room-send]").getBoundingClientRect().bottom <= innerHeight,
      wide: document.documentElement.scrollWidth > innerWidth,
      overflowY: s.overflowY, bounded: t.scrollHeight > t.clientHeight,
      newest: last.bottom <= tr.bottom + 1 && last.top >= tr.top - 1,
    };
  })()`);
  expect(v).toEqual({ full: true, tabs: ["CHAT", "BRIEF", "SHELF (3)"], select: 16, textarea: 16, sendInView: true, wide: false, overflowY: "auto", bounded: true, newest: true });
  expect(await page.evaluate(shown("#roomView .rvrail"))).toBe(false);
  // BRIEF: the lanes, the work and the brief; SHELF: the shelf alone; CHAT again: the thread and the send box.
  await click('[data-ptab="brief"]');
  expect(await page.evaluate(`[${shown("#roomView .rbrief")}, ${shown("#roomView .rtop")}, ${shown("#roomView .rshelf")}, ${shown("#roomView .rthread")}]`)).toEqual([true, true, false, false]);
  await click('[data-ptab="shelf"]');
  expect(await page.evaluate(`[${shown("#roomView .rshelf")}, ${shown("#roomView .rbrief")}, ${shown("#roomView .rthread")}, document.querySelectorAll("#roomView .art").length]`)).toEqual([true, false, false, 3]);
  await click('[data-ptab="chat"]');
  expect(await page.evaluate(`[${shown("#roomView .rthread")}, ${shown("#roomView .rsend")}, ${shown("#roomView .rvrail")}]`)).toEqual([true, true, false]);
  // Reading older messages: a new one lands below, and what you read stays where it was.
  await page.evaluate(`(() => { const t = document.querySelector("#roomView .rthread"); t.scrollTop = 0; t.dispatchEvent(new Event("scroll")); })()`);
  const first = `document.querySelector('#roomView .rthread [data-rmsg]')`;
  const before = await page.evaluate(`[${first}.dataset.rmsg, ${first}.getBoundingClientRect().top]`);
  await server.post("/api/rooms/ope-7/say", { text: "One more finding, while you read." });
  await until(`[...document.querySelectorAll("#roomView .rthread [data-rmsg]")].some((m) => m.innerText.includes("while you read"))`);
  const after = await page.evaluate(`[${first}.dataset.rmsg, ${first}.getBoundingClientRect().top]`);
  expect(after[0]).toBe(before[0]);
  expect(Math.abs(after[1] - before[1])).toBeLessThan(2);
  // The back button returns to the page as it was, with the questions.
  await click("[data-room-back]");
  await until(inOffice);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).overflowY !== "hidden" && document.querySelector(".qwrap").getBoundingClientRect().height > 0`)).toBe(true);
  expect(errors).toEqual([]);
});
