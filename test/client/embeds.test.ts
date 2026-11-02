// RICH CARDS on the page (src/client/embeds/): a line that is only a reference shows as a card of that thing in a
// brief, a room's thread and MESSAGES; a card for every kind; a status change shows on the card without opening it
// again; a thing that is gone is a muted NOT FOUND card; a reference inside a sentence stays a link; a click opens
// the thing (a lane's drawer, leaving the brief open); at phone width a card fits; an open question stays visible.
// Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-embeds-page-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "api-auth", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string | Uint8Array) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=api-auth`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });
async function load(hash = "", w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}
// What each card on a view says: its kind, title, chips, and whether it is gone.
const cardsIn = (sel: string) => ev(`[...document.querySelectorAll("${sel} .hudcard")].map((c) => ({ ref: c.dataset.ref, word: c.querySelector(".hcword")?.textContent, title: c.querySelector(".hctitle")?.textContent, chips: [...c.querySelectorAll(".hchip")].map((x) => x.textContent), gone: c.classList.contains("gone"), link: c.tagName === "A" }))`) as Promise<any[]>;
let brief = 0, crmBrief = 0, open = 0, answered = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "api-auth", title: "Rotate the auth tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  open = (await post("/api/asks", { title: "Ship the pricing page?", body: "It is ready.", lane: "api-auth" })).id;
  answered = (await post("/api/asks", { title: "Which plan name?" })).id;
  await post(`/api/asks/${answered}/answer`, { answer: "Pro" });
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await upload("ope-12", "chart.png", PNG);
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v1</p>");
  crmBrief = (await post("/api/briefs", { title: "CRM import plan", body: "Import in two steps." }, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" })).id;
  const body = [
    "## Everything in one place", "",
    `#brief/${crmBrief}`, "",
    "[The auth room](#room/ope-12)", "",
    "#lane/api-auth", "",
    `#ask/${open}`, "",
    `#ask/${answered}`, "",
    "#floor/crm", "",
    "#page/rooms/ope-12/files/chart.png", "",
    "[The plan](#page/rooms/ope-12/files/plan.html)", "",
    "#brief/99999", "",
    "Inside a sentence #room/ope-12 stays a link.",
  ].join("\n");
  brief = (await post("/api/briefs", { title: "Weekly: where things are", body }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await post("/api/rooms/ope-12/say", { text: `The plan is up:\n\n#page/rooms/ope-12/files/plan.html\n\nAnd the question:\n\n#ask/${open}`, as: "api-auth" });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a brief: a card for every kind, a muted card for one that is gone, and a link inside a sentence", async () => {
  await load(`#brief/${brief}`);
  await until(`document.querySelectorAll(".briefview .hudcard:not(.loading)").length === 9`);
  const cards = await cardsIn(".briefview");
  expect(cards).toEqual([
    { ref: `brief/${crmBrief}`, word: "BRIEF", title: "CRM import plan", chips: ["NEW"], gone: false, link: true },
    { ref: "room/ope-12", word: "ROOM", title: "Auth rotation", chips: ["1 NEW", "api-auth"], gone: false, link: true },
    { ref: "lane/api-auth", word: "LANE", title: "api-auth", chips: ["WORKING", "MANAGER"], gone: false, link: true },
    { ref: `ask/${open}`, word: "QUESTION", title: "Ship the pricing page?", chips: ["OPEN", "api-auth"], gone: false, link: true },
    { ref: `ask/${answered}`, word: "QUESTION", title: "Which plan name?", chips: ["ANSWERED"], gone: false, link: true },
    { ref: "floor/crm", word: "FLOOR", title: "CRM", chips: ["0 OF 0 WORKING"], gone: false, link: true },
    { ref: "page/rooms/ope-12/files/chart.png", word: "IMAGE", title: "chart.png", chips: [], gone: false, link: true },
    { ref: "page/rooms/ope-12/files/plan.html", word: "PAGE", title: "plan.html", chips: [], gone: false, link: true },
    { ref: "brief/99999", word: "BRIEF", title: "#brief/99999", chips: ["NOT FOUND"], gone: true, link: false },
  ]);
  // The CRM brief is on another floor: its colour down the card's edge. The image has its picture.
  const crm = `.briefview .hudcard[data-ref="brief/${crmBrief}"]`;
  expect(await ev(`getComputedStyle(document.querySelector('${crm}')).borderLeftWidth`)).toBe("6px");
  expect(await ev(`document.querySelector('${crm} .hcfloor').textContent`)).toBe("CRM");
  expect(await ev(`document.querySelector('.briefview .hudcard[data-ref="page/rooms/ope-12/files/chart.png"] img').getAttribute("src")`)).toBe("/rooms/ope-12/files/chart.png");
  expect(await ev(`document.querySelector('.briefview .hudcard[data-ref="page/rooms/ope-12/files/chart.png"]').target`)).toBe("_blank");
  // Inside a sentence: a plain link, no card.
  expect(await ev(`[...document.querySelectorAll(".briefview .md p a")].map((a) => [a.getAttribute("href"), a.textContent])`)).toEqual([["#room/ope-12", "#room/ope-12"]]);
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("a status change shows on the card while the brief stays open", async () => {
  const sel = `.briefview .hudcard[data-ref="ask/${open}"]`;
  expect(await ev(`document.querySelector('${sel} .hchip').textContent`)).toBe("OPEN");
  await post(`/api/asks/${open}/answer`, { answer: "yes, ship it" });
  await until(`document.querySelector('${sel} .hchip')?.textContent === "ANSWERED" && document.querySelector('${sel} .hcprev').textContent === "You: yes, ship it"`);
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
}, 20_000);

test.skipIf(!chromeFound)("a click opens the thing: a lane's drawer over the office with the brief left open, a room beside the brief", async () => {
  await ev(`document.querySelector('.briefview .hudcard[data-ref="lane/api-auth"]').click()`);
  await until(`!document.getElementById("card").hidden && document.querySelector("#card h3")?.textContent === "api-auth"`);
  expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
  expect(await ev(`(() => { const r = document.getElementById("card").getBoundingClientRect(); return r.width > 100 && r.height > 100 && document.elementFromPoint(r.left + r.width / 2, r.top + 20)?.closest("#card") != null; })()`)).toBe(true);
  await ev(`document.querySelector("[data-card-close]").click()`);
  await ev(`document.querySelector('.briefview .hudcard[data-ref="room/ope-12"]').click()`);
  await until(`location.hash === "#room/ope-12+brief/${brief}" && !document.getElementById("roomView").hidden`);
}, 20_000);

test.skipIf(!chromeFound)("a room's thread shows cards too, and a page card opens the page", async () => {
  await until(`document.querySelectorAll("#roomView .rthread .hudcard:not(.loading)").length === 2`);
  expect((await cardsIn("#roomView .rthread")).map((c) => [c.word, c.title, c.chips[0]])).toEqual([["PAGE", "plan.html", undefined], ["QUESTION", "Ship the pricing page?", "ANSWERED"]]);
  await ev(`document.querySelector('#roomView .rthread .hudcard[data-ref="page/rooms/ope-12/files/plan.html"]').click()`);
  await until(`location.hash === "#room/ope-12+page/rooms/ope-12/files/plan.html" && !!document.querySelector(".pageview iframe")`);
}, 20_000);

test.skipIf(!chromeFound)("inside a floor only another floor's things have its colour; a floor card goes into that floor", async () => {
  await ev(`sessionStorage.setItem("hq-scope", JSON.stringify({ floor: "hq", all: false }))`);
  await load(`?in=hq#brief/${brief}`); // a new document, which reads the floor you are in
  await until(`document.querySelectorAll(".briefview .hudcard:not(.loading)").length === 9 && document.querySelector(".stage").dataset.floors === "floor"`);
  expect(await ev(`document.querySelector('.briefview .hudcard[data-ref="brief/${crmBrief}"]').classList.contains("other")`)).toBe(true);
  expect(await ev(`[...document.querySelectorAll('.briefview .hudcard.other')].map((c) => c.dataset.ref)`)).toEqual([`brief/${crmBrief}`, "floor/crm"]);
  // Going into another floor leaves a brief that is not on it (briefs/index.js).
  await ev(`document.querySelector('.briefview .hudcard[data-ref="floor/crm"]').click()`);
  await until(`JSON.parse(sessionStorage.getItem("hq-scope") || "null")?.floor === "crm" && location.hash === ""`);
}, 20_000);

test.skipIf(!chromeFound)("MESSAGES: a new brief's line is a card of it; an open question stays in view beside it", async () => {
  const q = (await post("/api/asks", { title: "Merge the CRM import?", lane: "api-auth" })).id;
  await ev(`sessionStorage.clear()`); // out of the CRM floor entered above
  await load();
  await ev(`document.querySelector('[data-qtab="messages"]').click()`);
  await until(`!!document.querySelector('#msgs .hudcard[data-ref="brief/${brief}"]')`);
  expect(await ev(`document.querySelector('#msgs .hudcard[data-ref="brief/${brief}"] .hctitle').textContent`)).toBe("Weekly: where things are");
  await ev(`document.querySelector('[data-qtab="questions"]').click()`);
  await until(`!!document.querySelector('.ask[data-ask="${q}"]')`);
  expect(await ev(`(() => { const r = document.querySelector('.ask[data-ask="${q}"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 40; })()`)).toBe(true);
}, 20_000);

test.skipIf(!chromeFound)("at phone width a card fits the screen and the page does not scroll sideways", async () => {
  await load(`#brief/${brief}`, 390, 844, true);
  await until(`document.querySelectorAll(".briefview .hudcard:not(.loading)").length === 9`);
  expect(await ev(`[...document.querySelectorAll(".briefview .hudcard")].every((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })`)).toBe(true);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
}, 20_000);
