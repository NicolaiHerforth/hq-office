// ASK PAGES in Chrome: a question with an HTML page shows it in its NEEDS YOU card, in a sandboxed frame between the
// title and the answer row, capped in height, so the options and SEND stay in the list's view on a laptop screen.
// OPEN takes the page to the stage with the answer row under it; on a phone the card has a strip instead. The page
// cannot answer: no reach into the HUD, no fetch to it, and a message it posts does nothing. A frame keeps running while
// the list around it changes. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-ask-pages-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);

// A short page that tries everything it must not manage, keeps a pick through the runtime's db, and reports.
const PROBE = `<title>Rows to delete</title><style>body{font:14px sans-serif;margin:8px}</style><h1>Pick rows</h1><p>row 2, row 5</p><script>
const out = { ran: true };
try { out.parentDoc = !!parent.document.body; } catch { out.parentDoc = false; }
try { parent.document.querySelector(".send").click(); out.clicked = true; } catch { out.clicked = false; }
try { top.location.hash = "#hacked"; out.nav = true; } catch { out.nav = false; }
parent.postMessage({ "hud-ask-height": 99999 }, "*");
parent.postMessage({ op: "answer", answer: "from the page" }, "*");
const answer = (path) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ answer: "from the page" }) }).then(() => true, () => false);
Promise.all([answer("/api/asks/ASK/answer"), answer("http://" + "127.0.0.1:PORT/api/asks/ASK/answer"), hud.use("db")]).then(async ([a, b, db]) => {
  out.fetched = a || b;
  if (db) { await db.doc("picks/owner").set({ rows: [2, 5] }); out.saved = true; }
  parent.postMessage({ askprobe: out }, "*");
});
</script>`;
// A tall page: the card's frame stops at the cap.
const TALL = `<!doctype html><html><head><title>Tall chart</title></head><body style="margin:0"><div style="height:2000px;background:linear-gradient(#cde,#edc)">tall</div></body></html>`;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
const state = () => fetch(`${server.base}/api/state`).then((r) => r.json());
async function load(w = 1440, h = 900, mobile = false, hash = "") {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.querySelector("#hud .ask")`);
  // NEEDS YOU, whichever tab an earlier test left open
  await ev(`document.querySelector('[data-qtab="questions"]').click(), true`);
  await until(`!document.getElementById("hud").hidden`);
}
const shot = async (name: string) => {
  if (!process.env.ASK_SHOTS) return;
  const { data } = await page.s("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(process.env.ASK_SHOTS, `${name}.png`), Buffer.from(data, "base64"));
};
// A card scrolled to the top of the list: is its answer row (the options and the send button) in the list's view, and
// on top (nothing covers it)?
const answerInView = (id: number) => ev(`(() => {
  const hud = document.getElementById("hud"), card = hud.querySelector('[data-ask="${id}"]');
  card.scrollIntoView({ block: "start" });
  const view = hud.getBoundingClientRect(), bottom = Math.min(view.bottom, innerHeight);
  const parts = [...card.querySelectorAll(".opt, .send, .notyet")];
  return parts.length > 0 && parts.every((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= view.top - 1 && r.bottom <= bottom + 1 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".opt, .send, .notyet") === el;
  });
})()`);
let A = 0, B = 0, plain = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync");
  plain = (await post("/api/asks", { title: "A plain question first", body: "Some **markdown**.", options: ["Yes", "No"], recommended: "Yes", created_at: Date.now() - 3000 })).id;
  A = (await post("/api/asks", { title: "Which rows go?", options: ["Delete the picked rows", "Keep them all", "Ask me later"], recommended: "Delete the picked rows", file: "<title>x</title>", created_at: Date.now() - 2000 })).id;
  await post(`/api/asks/${A}/update`, { file: PROBE.replaceAll("ASK", String(A)).replace("PORT", new URL(server.base).port) });
  B = (await post("/api/asks", { title: "Record the demo against this chart", kind: "action", body: "Two lines of context for the to-do.", file: TALL, created_at: Date.now() - 1000 })).id;
  for (let i = 1; i <= 5; i++) await post("/api/asks", { title: `Filler question ${i}`, body: "A line of text so the list is long.", options: ["One", "Two"] });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  // heard from the start: a frame may report before the test looks
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("message", (e) => { if (e.data?.askprobe) window.__probe = e.data.askprobe; })` });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

test.skipIf(!chromeFound)("a decision with a page: the frame between the title and the options, no taller than the page", async () => {
  await load();
  await until(`!!window.__probe`, 10_000);
  const card = await ev(`(() => {
    const c = document.querySelector('#hud [data-ask="${A}"]'), kids = [...c.children].map((k) => k.className || k.tagName);
    const f = c.querySelector("iframe.askframe");
    return { kids, src: f.getAttribute("src"), sandbox: f.getAttribute("sandbox"), h: f.getBoundingClientRect().height, opts: c.querySelectorAll(".opt").length, pick: !!c.querySelector(".opt .pick"), open: c.querySelector(".tag.pageopen")?.getAttribute("href") };
  })()`);
  expect(card.kids.indexOf("askpage")).toBeGreaterThan(card.kids.indexOf("H3"));
  expect(card.kids.indexOf("askpage")).toBeLessThan(card.kids.indexOf("menu"));
  expect(card.src).toMatch(new RegExp(`^/asks/${A}\\.html\\?at=\\d+&theme=(light|dark)$`));
  expect(card.sandbox).not.toContain("allow-same-origin");
  expect(card.sandbox).not.toContain("allow-modals");
  expect(card).toMatchObject({ opts: 3, pick: true, open: `#page/asks/${A}` });
  // the short page's own height (its 99999 was not the frame's to take: the frame follows what its document measures)
  await until(`document.querySelector('#hud [data-ask="${A}"] iframe').getBoundingClientRect().height < 200`);
  // the tall one stops at the cap
  const tall = await ev(`document.querySelector('#hud [data-ask="${B}"] iframe').getBoundingClientRect().height`);
  expect(tall).toBeLessThanOrEqual(284);
  expect(tall).toBeGreaterThan(150);
  await shot("1440-list");
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!chromeFound)("the page cannot answer, click the HUD or navigate it; what it keeps is page data under asks/ID", async () => {
  await load();
  await until(`!!window.__probe`, 10_000);
  const p = await ev(`window.__probe`);
  expect(p).toMatchObject({ ran: true, parentDoc: false, clicked: false, fetched: false, saved: true });
  expect(await ev(`location.hash`)).toBe("");
  const s = await state();
  expect(s.open.map((a: any) => a.id)).toContain(A);
  const data = await fetch(`${server.base}/api/page-runtime/data?page=asks/${A}&path=picks/owner`).then((r) => r.json());
  expect(JSON.stringify(data)).toContain("[2,5]");
}, 30_000);

for (const [w, h] of [[1440, 900], [1152, 800]]) {
  test.skipIf(!chromeFound)(`at ${w}x${h} the options and SEND of every card stay in view, page or not`, async () => {
    await load(w, h);
    await until(`[...document.querySelectorAll("#hud iframe.askframe")].length === 2`);
    for (const id of [plain, A, B]) expect(await answerInView(id)).toBe(true);
    await ev(`document.querySelector('#hud [data-ask="${B}"]').scrollIntoView({ block: "start" }), true`);
    await shot(`${w}-tall`);
  }, 30_000);
}

test.skipIf(!chromeFound)("a frame keeps running while the list changes around it", async () => {
  await load();
  await until(`!!document.querySelector('#hud [data-ask="${A}"] iframe')?.contentWindow`);
  await ev(`window.__fw = document.querySelector('#hud [data-ask="${A}"] iframe').contentWindow, true`);
  const extra = (await post("/api/asks", { title: "Arrived while the page was open", options: ["Fine"], created_at: Date.now() - 2500 })).id;
  await until(`!!document.querySelector('#hud [data-ask="${extra}"]')`);
  expect(await ev(`document.querySelector('#hud [data-ask="${A}"] iframe').contentWindow === window.__fw`)).toBe(true);
  await post(`/api/asks/${extra}/answer`, { answer: "Fine" });
  await until(`!document.querySelector('#hud [data-ask="${extra}"]')`);
  expect(await ev(`document.querySelector('#hud [data-ask="${A}"] iframe').contentWindow === window.__fw`)).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("OPEN takes the page to the stage with the answer row under it; answering there answers the ask", async () => {
  await load();
  await ev(`document.querySelector('#hud [data-ask="${A}"] .tag.pageopen').click(), true`);
  await until(`location.hash === "#page/asks/${A}" && !document.querySelector(".pageview").hidden`);
  await until(`!!document.querySelector(".askdock .opt")`);
  const v = await ev(`(() => {
    const view = document.querySelector(".pageview"), f = view.querySelector("iframe.pageframe"), dock = view.querySelector(".askdock");
    const card = document.querySelector('#hud [data-ask="${A}"]');
    const send = dock.querySelector(".send").getBoundingClientRect();
    return { src: f.getAttribute("src"), frameW: f.getBoundingClientRect().width, viewW: view.getBoundingClientRect().width, opts: dock.querySelectorAll(".opt").length, sendIn: send.bottom <= innerHeight && send.top >= 0,
      cardFrame: !!card.querySelector("iframe"), cardStrip: !!card.querySelector(".askstrip"), cardMenu: !!card.querySelector(".menu"), onstage: !!card.querySelector(".onstage"), comments: !!view.querySelector(".cmount") };
  })()`);
  expect(v.src).toMatch(new RegExp(`^/asks/${A}\\.html\\?theme=`));
  expect(v.frameW).toBeGreaterThan(v.viewW - 40);
  expect(v).toMatchObject({ opts: 3, sendIn: true, cardFrame: false, cardStrip: true, cardMenu: false, onstage: true, comments: false });
  await shot("1440-stage");
  await ev(`[...document.querySelectorAll(".askdock .opt")].find((b) => b.dataset.opt === "Delete the picked rows").click(), true`);
  await ev(`document.querySelector(".askdock .send").click(), true`);
  await until(`!!document.querySelector(".askdock .dockdone")`);
  expect(await ev(`document.querySelector(".askdock").textContent`)).toContain("Delete the picked rows");
  const s = await state();
  expect(s.answered.find((a: any) => a.id === A)?.answer).toBe("Delete the picked rows");
  // BACK: the office again, and MESSAGES says the answer has a page
  await ev(`document.querySelector("[data-page-back]").click(), true`);
  await until(`document.querySelector(".pageview").hidden`);
  await ev(`document.querySelector('[data-qtab="messages"]').click(), true`);
  await until(`!!document.querySelector('#msgs [data-msg="a${A}"] a[href="#page/asks/${A}"]')`);
}, 30_000);

test.skipIf(!chromeFound)("on a phone the card shows a strip and OPEN; the stage has the page and the answer row", async () => {
  await load(390, 844, true);
  const c = await ev(`(() => { const c = document.querySelector('#hud [data-ask="${B}"]'); return { frame: !!c.querySelector("iframe"), strip: c.querySelector(".askstrip")?.getAttribute("href"), text: c.querySelector(".askstrip")?.textContent, done: !!c.querySelector(".send") }; })()`);
  expect(c).toMatchObject({ frame: false, strip: `#page/asks/${B}`, done: true });
  expect(c.text).toContain("Tall chart");
  const strip = await ev(`(() => { const s = document.querySelector('#hud [data-ask="${B}"] .askstrip'); s.scrollIntoView({ block: "center" }); const r = s.getBoundingClientRect(); return r.height > 20 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; })()`);
  expect(strip).toBe(true);
  await shot("phone-card");
  await ev(`document.querySelector('#hud [data-ask="${B}"] .askstrip').click(), true`);
  await until(`!!document.querySelector(".askdock .send")`);
  const v = await ev(`(() => { const f = document.querySelector(".pageview iframe").getBoundingClientRect(), s = document.querySelector(".askdock .send").getBoundingClientRect(), n = document.querySelector(".askdock .notyet").getBoundingClientRect(); return { fh: f.height, sendIn: s.bottom <= innerHeight && s.top >= 0, notyetIn: n.bottom <= innerHeight, label: document.querySelector(".askdock .send").textContent }; })()`);
  expect(v.fh).toBeGreaterThan(200);
  expect(v).toMatchObject({ sendIn: true, notyetIn: true, label: "DONE" });
  await shot("phone-stage");
}, 30_000);
