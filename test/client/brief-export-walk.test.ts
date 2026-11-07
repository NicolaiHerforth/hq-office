// EXPORT walked through as the owner uses it: real mouse and touch input (CDP Input), every way in and out, real
// downloads into a folder, then those files opened by file:// with the server stopped and the network off. Needs
// Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-export-walk-"));
const downloads = join(dir, "downloads");
mkdirSync(downloads);
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SECRET = "PLANTED-SECRET-VALUE-789";

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>, noChrome: Awaited<ReturnType<typeof spawnServer>>, offline: Awaited<ReturnType<typeof spawnServer>>;
// A proxy that refuses everything: it sees every https request the offline server makes, and each of them fails.
const proxyAsked: string[] = [];
let proxy: ReturnType<typeof Bun.listen>;
let heldBack = 0;
let page: Awaited<ReturnType<typeof newSession>>;
let decoy: ReturnType<typeof Bun.serve>;
const decoyHits: string[] = [];
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 15000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}: ${await ev(`document.querySelector(".xpanel")?.innerText ?? "(no panel)"`).catch(() => "")}`);
};
const call = async (base: string, path: string, body: object) => (await (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) })).json()) as any;
const upload = async (slug: string, name: string, bytes: Uint8Array | string) => {
  const r = await fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=hq`, { method: "POST", headers: { "x-hud": "1" }, body: bytes });
  expect(r.status).toBe(200);
};
// Where the owner would press: on screen, and the point hits SEL itself, not a cover over it.
async function point(sel: string) {
  // The panel's buttons wait for its check.
  if (sel.includes("data-export-as")) await until(`document.querySelector(${JSON.stringify(sel)}) && !document.querySelector(${JSON.stringify(sel)}).disabled`);
  const at = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return "missing";
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!r.width || !r.height) return "no size";
    if (r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return "off screen: " + JSON.stringify(r);
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? [x, y] : "covered by " + hit?.outerHTML.slice(0, 80);
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot press ${sel}: ${at}`);
  return at as [number, number];
}
async function click(sel: string) {
  const [x, y] = await point(sel);
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
async function tap(sel: string) {
  const [x, y] = await point(sel);
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function key(k: string) {
  for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 13 });
}
let visits = 0;
// A fresh document each time, then a real move so the page takes input (feature modules load after the built-in areas).
async function open(hash: string, base = server.base, w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${base}/?v=${++visits}#${hash}` });
  await until(`!!document.querySelector("[data-export]")`);
  await until(`getComputedStyle(document.querySelector(".xpanel") ?? document.body).position !== "" && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`);
  if (!mobile) await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  // Late modules still move the bar's buttons for a moment after a load.
  let last = "", same = 0;
  for (const end = Date.now() + 8000; Date.now() < end && same < 6; await Bun.sleep(60)) {
    const now = String(await ev(`JSON.stringify(document.querySelector("[data-export]").getBoundingClientRect())`));
    same = now === last ? same + 1 : 0;
    last = now;
  }
}
const panelOpen = () => ev(`(() => { const p = document.querySelector(".xpanel"); return !!p && !p.hidden; })()`);
async function saved(name: string, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) {
    const f = join(downloads, name);
    if (existsSync(f) && !readdirSync(downloads).some((x) => x.endsWith(".crdownload")) && statSync(f).size > 0) return f;
  }
  throw new Error(`${name} never arrived: ${readdirSync(downloads).join(", ")}`);
}
let brief = 0, older = 0, newer = 0, pageBrief = 0, labBrief = 0, hostile = 0;
const slug = "walk-room";

beforeAll(async () => {
  if (!chromeFound) return;
  const env = (data: string, more: object = {}) => ({ ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", ...more });
  decoy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(r) { decoyHits.push(new URL(r.url).pathname); return new Response("decoy-answer"); } });
  server = await spawnServer({ cwd: ROOT, env: env(dir) });
  const other = join(dir, "other");
  mkdirSync(other);
  noChrome = await spawnServer({ cwd: ROOT, env: env(other, { HUD_CHROME_PATH: "/nonexistent/chrome" }) });
  proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s, d) { const m = d.toString().match(/^CONNECT (\S+)/); if (m) proxyAsked.push(m[1]); s.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); s.end(); } } });
  const third = join(dir, "third");
  mkdirSync(third);
  offline = await spawnServer({ cwd: ROOT, env: env(third, { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` }) });
  heldBack = (await call(offline.base, "/api/briefs", { title: "Needs a library", body: `<!doctype html><html><head><title>Needs a library</title><script src="https://cdn.example.com/chart-lib.js"></script></head><body><p>needs a library</p></body></html>` })).id;
  await call(server.base, "/api/lanes", { name: "walk-lane", machine: "local" });
  await call(server.base, "/api/secrets", { name: "PLANTED", value: SECRET, minutes: 60, by: "owner" });
  writeFileSync(join(dir, "uploads", "pic.png"), PNG);
  older = (await call(server.base, "/api/briefs", { title: "An older brief", body: "Older words." })).id;
  const body = `## Where we are\n\nThe key is ${SECRET}.\n\n| Lane | State |\n| -- | -- |\n| api | merged |\n\n#brief/${older}\n\n[image: /x/pic.png]\n\n\`\`\`\nconst answer = 42;\n\`\`\``;
  brief = (await call(server.base, "/api/briefs", { title: "Monday plan", body })).id;
  newer = (await call(server.base, "/api/briefs", { title: "A newer brief", body: "Newer words." })).id;
  pageBrief = (await call(server.base, "/api/briefs", { title: "Chart page", body: `<!doctype html><html><head><title>Chart page</title></head><body><h1>A page brief</h1><hud-card ref="brief/${older}"></hud-card><svg width="100" height="50"><rect width="100" height="50" fill="teal"/></svg><script>localStorage.setItem("k", "kept in memory"); window.useAnswer = "waiting"; claude.use("db").then((d) => { window.useAnswer = d; });</script></body></html>` })).id;
  const lab = readFileSync(join(ROOT, "scripts/parity-lab/template.html"), "utf8").replaceAll("__PACE__", `{"days":["2026-11-01"],"counts":[3]}`);
  labBrief = (await call(server.base, "/api/briefs", { title: "Parity Lab", body: lab })).id;
  hostile = (await call(server.base, "/api/briefs", { title: "Calls home", body: `<!doctype html><html><head><title>Calls home</title></head><body><p>calls</p><script>window.tries = {};for (const [k, u] of [["hud", "${server.base}/api/state"], ["decoy", "http://127.0.0.1:${decoy.port}/fetch"]]) { tries[k] = "pending"; fetch(u).then(() => { tries[k] = "reached"; }, () => { tries[k] = "refused"; }); } const i = new Image(); i.src = "http://127.0.0.1:${decoy.port}/img"; document.body.append(i);</script></body></html>` })).id;
  await call(server.base, "/api/rooms", { slug, title: "Walk room", owner: "walk-lane" });
  await call(server.base, `/api/rooms/${slug}/brief`, { body: "# First words\n\nThe first.", by: "walk-lane" });
  await call(server.base, `/api/rooms/${slug}/brief`, { body: "# Later words\n\nThe later.", by: "walk-lane" });
  await upload(slug, "shelf.html", `<!doctype html><html><head><title>Shelf one</title></head><body><p>shelf version one</p></body></html>`);
  await upload(slug, "shelf.html", `<!doctype html><html><head><title>Shelf two</title></head><body><p>shelf version two</p></body></html>`);
  await call(noChrome.base, "/api/briefs", { title: "Here", body: "Words on a machine with no Chrome." });
  chrome = await startChrome();
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  page = await newSession(chrome.cdp, errors);
}, 60_000);
afterAll(async () => {
  await server?.stop();
  await noChrome?.stop();
  await offline?.stop();
  proxy?.stop(true);
  await chrome?.close();
  decoy?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const files: Record<string, string> = {};

describe.skipIf(!chromeFound)("on a wide screen", () => {
  test("EXPORT on a markdown brief opens a panel that says what is shared, on screen and on top", async () => {
    await open(`brief/${brief}`);
    expect(await ev(`document.querySelector("[data-export]").textContent`)).toBe("EXPORT");
    expect(await ev(`document.querySelector("[data-export]").getAttribute("aria-expanded")`)).toBe("false");
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    expect(await ev(`[...document.querySelectorAll(".xpanel [data-export-as]")].map((b) => b.textContent)`)).toEqual(["DOWNLOAD PDF", "DOWNLOAD HTML"]);
    expect(await ev(`document.querySelector(".xpanel").innerText`)).toContain("Only secret values HQ Office holds right now are masked");
    await until(`document.activeElement.dataset.exportAs === "pdf"`);
    expect(await ev(`document.querySelector("[data-export]").getAttribute("aria-expanded")`)).toBe("true");
    await point(`.xpanel [data-export-as="html"]`);
  }, 40_000);
  test("Esc closes the panel, not the brief; a click outside closes it too; EXPORT again closes it", async () => {
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
    expect(await ev(`!document.querySelector(".briefview").hidden`)).toBe(true);
    expect(await ev(`document.activeElement.dataset.export`)).toBe(`briefs/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(".bbody .md pre");
    await until(`document.querySelector(".xpanel").hidden`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click("[data-export]");
    await until(`document.querySelector(".xpanel").hidden`);
  }, 30_000);
  test("NEWER, OLDER and BACK close the panel with the brief it belonged to", async () => {
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-brief-step="-1"]`);
    await until(`location.hash === "#brief/${newer}" && document.querySelector(".bbody h1")?.textContent === "A newer brief"`);
    expect(await panelOpen()).toBe(false);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-brief-back]`);
    await until(`document.querySelector(".briefview").hidden`);
    expect(await panelOpen()).toBe(false);
  }, 30_000);
  test("DOWNLOAD HTML saves the real file, and the panel says what it is", async () => {
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    files.md = await saved("monday-plan.html");
    await until(`!!document.querySelector(".xsave")`);
    expect(await ev(`document.querySelector(".xdone").innerText`)).toContain("monday-plan.html");
    expect(await ev(`[document.querySelector(".xsave").getAttribute("download"), document.querySelector(".xsave").target]`)).toEqual(["monday-plan.html", ""]);
    const text = readFileSync(files.md, "utf8");
    expect(text).toContain("Where we are");
    expect(text).not.toContain(SECRET);
  }, 60_000);
  test("DOWNLOAD PDF says it is working, then saves a real PDF", async () => {
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="pdf"]`);
    await until(`document.querySelector('[data-export-as="pdf"]').textContent === "MAKING PDF…" && document.querySelector('[data-export-as="html"]').disabled`);
    files.mdPdf = await saved("monday-plan.pdf");
    expect(readFileSync(files.mdPdf).subarray(0, 5).toString()).toBe("%PDF-");
    await until(`!!document.querySelector(".xsave")`);
    expect(await ev(`document.querySelector('[data-export-as="pdf"]').disabled`)).toBe(false);
  }, 90_000);
  test("the panel can close while it makes the file, and the file still comes", async () => {
    rmSync(join(downloads, "monday-plan.pdf"), { force: true });
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="pdf"]`);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    await click("[data-export]");
    await until(`document.querySelector('[data-export-as="pdf"]').textContent === "MAKING PDF…"`);
    await key("Escape");
    expect(readFileSync(await saved("monday-plan.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
  }, 120_000);
  test("a page brief: EXPORT in its bar, with COMMENTS, and the file carries the page", async () => {
    await open(`brief/${pageBrief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    files.page = await saved("chart-page.html");
    expect(readFileSync(files.page, "utf8")).toContain("A page brief");
  }, 60_000);
  test("in FULL SCREEN the panel shows, and works", async () => {
    await open(`brief/${brief}`);
    await click("[data-view-full]");
    await until(`document.fullscreenElement === document.querySelector(".briefview")`);
    await Bun.sleep(500); // Chrome drops input for a moment while the screen changes
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    expect(await ev(`document.fullscreenElement.contains(document.querySelector(".xpanel"))`)).toBe(true);
    await point(`.xpanel [data-export-as="html"]`);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    await ev(`document.exitFullscreen()`);
    await until(`!document.fullscreenElement`);
  }, 40_000);
  test("a room's markdown brief: EXPORT in the rail, and an older version exports as itself", async () => {
    await open(`room/${slug}`);
    await until(`!!document.querySelector(".rbrief [data-export]")`);
    await click(".rbrief [data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    files.room = await saved("walk-room.html");
    expect(readFileSync(files.room, "utf8")).toContain("The later.");
    await key("Escape");
    await click("[data-brief-versions]");
    await until(`document.querySelectorAll("[data-brief-version]").length >= 2`);
    await ev(`document.querySelector('[data-brief-version]:not([data-brief-version=""])').click()`);
    await until(`!!document.querySelector(".rbrief [data-export][data-export-v]")`);
    rmSync(files.room);
    await click(".rbrief [data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    expect(readFileSync(await saved("walk-room.html"), "utf8")).toContain("The first.");
  }, 60_000);
  test("a room's page on the stage: the newest, and the version shown", async () => {
    await open(`page/rooms/${slug}/files/shelf.html`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    expect(readFileSync(await saved("shelf-two.html"), "utf8")).toContain("shelf version two");
    const v = (await (await fetch(`${server.base}/api/rooms/${slug}/versions?file=shelf.html`)).json() as any).versions[0].v;
    await open(`page/rooms/${slug}/files/shelf.html?v=${v}`);
    expect(await ev(`document.querySelector("[data-export]").dataset.exportV`)).toBe(String(v));
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="html"]`);
    expect(readFileSync(await saved("shelf-one.html"), "utf8")).toContain("shelf version one");
  }, 60_000);
  test("beside a room in SPLIT, EXPORT exports the brief, and the panel is on screen", async () => {
    await open(`room/${slug}+brief/${brief}`);
    await until(`!!document.querySelector(".briefview [data-export]")`);
    await click(".briefview [data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await point(`.xpanel [data-export-as="pdf"]`);
    await click(".bbody .md pre");
    await until(`document.querySelector(".xpanel").hidden`);
    expect(await ev(`location.hash`)).toContain(`brief/${brief}`);
  }, 30_000);
  test("in dark mode the panel is on the tokens", async () => {
    await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    const [bg, ink] = await ev(`(() => { const c = getComputedStyle(document.querySelector(".xpanel")); return [c.backgroundColor, c.color]; })()`) as string[];
    const lum = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
    expect(lum(ink)).toBeGreaterThan(lum(bg));
    await page.s("Emulation.setEmulatedMedia", { features: [] });
  }, 30_000);
  test("with no Chrome on the machine, the panel says what to do, and HTML still downloads", async () => {
    await open(`brief/1`, noChrome.base);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await click(`[data-export-as="pdf"]`);
    await until(`!!document.querySelector(".xerr")`);
    const said = await ev(`document.querySelector(".xerr").innerText`);
    expect(said).toContain("no Chrome");
    expect(said).toContain("Install Google Chrome");
    expect(await ev(`document.querySelector('[data-export-as="html"]').disabled`)).toBe(false);
    await click(`[data-export-as="html"]`);
    expect(readFileSync(await saved("here.html"), "utf8")).toContain("Words on a machine with no Chrome.");
    await until(`!document.querySelector(".xerr")`);
  }, 40_000);
});

describe.skipIf(!chromeFound)("when what the panel hung from is drawn again", () => {
  test("the new button says it is open and the panel follows it, with no other event", async () => {
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    const before = await ev(`document.querySelector(".xpanel").getBoundingClientRect().top`);
    await ev(`(() => { const b = document.querySelector("[data-export]"), spacer = document.createElement("div"); spacer.style.height = "60px"; b.parentElement.parentElement.prepend(spacer); b.replaceWith(b.cloneNode(true)); })()`);
    await until(`document.querySelector("[data-export]").getAttribute("aria-expanded") === "true"`);
    const after = await ev(`(() => { const p = document.querySelector(".xpanel").getBoundingClientRect(), b = document.querySelector("[data-export]").getBoundingClientRect(); return { top: p.top, bottom: b.bottom }; })()`);
    expect(after.top).not.toBe(before);
    expect(after.top - after.bottom).toBeLessThanOrEqual(8);
    await click("[data-export]");
    await until(`document.querySelector(".xpanel").hidden`);
  }, 30_000);
  test("the panel stays put, and EXPORT still closes it", async () => {
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    const before = await ev(`document.querySelector(".xpanel").getBoundingClientRect().top`);
    await ev(`(() => { const b = document.querySelector("[data-export]"); b.replaceWith(b.cloneNode(true)); })()`);
    await page.s("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`document.querySelector(".xpanel").getBoundingClientRect().top === ${before}`);
    expect(await ev(`document.querySelector("[data-export]").getAttribute("aria-expanded")`)).toBe("true");
    await click("[data-export]");
    await until(`document.querySelector(".xpanel").hidden`);
  }, 30_000);
});

describe.skipIf(!chromeFound)("before any file", () => {
  test("what looks like a key is in the panel before any file is made, shortened, and the buttons waited for it", async () => {
    const whole = "ghp_" + "abcdefghij0123456789";
    const id = (await call(server.base, "/api/briefs", { title: "Has a key", body: `The key is ${whole}.` })).id;
    // A download from the test before may still be finishing, and that changes the count.
    for (let i = 0; i < 100 && readdirSync(downloads).some((f) => f.endsWith(".crdownload")); i++) await Bun.sleep(100);
    const before = readdirSync(downloads).length;
    await open(`brief/${id}`);
    await until(`document.querySelector(".bview [data-export], [data-export]")`);
    await ev(`(() => { const f = window.fetch; window.__asked = []; window.fetch = (u, o) => { window.__asked.push(String(u)); return f(u, o); }; })()`);
    await click(`[data-export]`);
    await until(`document.querySelector(".xpanel .xwarn")?.innerText.includes("ghp_…89")`);
    const said = await ev(`document.querySelector(".xpanel").innerText`);
    expect(said).not.toContain(whole);
    expect(said).toContain("no guarantee");
    expect(await ev(`window.__asked.filter((u) => u.includes("/api/exports"))`)).toEqual(["/api/exports/check"]);
    expect(readdirSync(downloads).length).toBe(before);
    await key("Escape");
  });
  test("a table too wide for the column takes the room beside it on a wide screen", async () => {
    const cells = Array.from({ length: 12 }, (_, i) => `column-number-${i}`);
    const id = (await call(server.base, "/api/briefs", { title: "Wide one", body: `| ${cells.join(" | ")} |\n| ${cells.map(() => "--").join(" | ")} |\n| ${cells.join(" | ")} |` })).id;
    const made = await call(server.base, "/api/exports", { page: id, format: "html" });
    const path = join(dir, "wide-one.html");
    writeFileSync(path, await (await fetch(`${server.base}${made.url}`)).text());
    await page.s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.s("Page.navigate", { url: `file://${path}` });
    await until(`document.readyState === "complete" && !!document.querySelector(".mdtable")`);
    const box = await ev(`(() => { const t = document.querySelector(".mdtable").getBoundingClientRect(), c = document.querySelector(".md").getBoundingClientRect(); return { width: t.width, column: c.width, right: t.right, cut: document.querySelector(".mdtable").scrollWidth > document.querySelector(".mdtable").clientWidth + 1 }; })()`) as any;
    expect(box.width).toBeGreaterThan(box.column);
    expect(box.right).toBeLessThanOrEqual(1280);
    // Still wider than the screen? It scrolls, and says so with a shade at the edge.
    if (box.cut) expect(await ev(`getComputedStyle(document.querySelector(".mdtable")).backgroundImage`)).toContain("linear-gradient");
  }, 30_000);
});

describe.skipIf(!chromeFound)("a file that cannot do what the page does", () => {
  test("opening the panel asks the web for nothing; DOWNLOAD HTML does, starts no download, names what is missing, and SAVE THE FILE ANYWAY saves it", async () => {
    proxyAsked.length = 0;
    // By name, not by count: Chrome keeps its unfinished files under names of their own, which come and go.
    const finished = () => readdirSync(downloads).filter((f) => !f.endsWith(".crdownload") && !f.startsWith("."));
    for (let i = 0; i < 100 && finished().length !== readdirSync(downloads).length; i++) await Bun.sleep(100);
    const before = finished();
    const added = () => finished().filter((f) => !before.includes(f));
    await open(`brief/${heldBack}`, offline.base);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !document.querySelector('[data-export-as="html"]').disabled`);
    await Bun.sleep(300);
    expect(proxyAsked).toEqual([]);
    await click(`[data-export-as="html"]`);
    await until(`!!document.querySelector(".xsave")`, 30_000);
    expect(proxyAsked.join(" ")).toContain("cdn.example.com");
    expect(await ev(`document.querySelector(".xdone").innerText`)).toContain("is missing part of the page");
    expect(await ev(`document.querySelector(".xdone").innerText`)).not.toContain("unfinished");
    expect(await ev(`document.querySelector(".xwarn").innerText`)).toContain("chart-lib.js");
    expect(await ev(`document.querySelector(".xwarn").innerText`)).toContain("PDF");
    expect(await ev(`document.querySelector(".xsave").textContent`)).toBe("SAVE THE FILE ANYWAY");
    await Bun.sleep(800);
    expect(added()).toEqual([]);
    await click(".xsave");
    for (let i = 0; i < 100 && !added().length; i++) await Bun.sleep(100);
    expect(added().length).toBe(1);
  }, 60_000);
});

describe.skipIf(!chromeFound)("a file is never lost to what the panel is showing", () => {
  const toasts = `[...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ")`;
  const answerLate = (ms: number) => ev(`(() => { const f = window.fetch; window.fetch = (u, o) => String(u).endsWith("/api/exports") ? new Promise((r) => setTimeout(r, ${ms})).then(() => f(u, o)) : f(u, o); })()`);
  test("desktop, a held file, panel closed while it is made: a true toast, and EXPORT shows it with its reason", async () => {
    await open(`brief/${heldBack}`, offline.base);
    await answerLate(600);
    await click("[data-export]");
    await click(`[data-export-as="html"]`);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    await until(`(${toasts}).includes("is missing part of the page")`, 30_000);
    expect(await ev(toasts)).toContain("press EXPORT");
    await click("[data-export]");
    await until(`document.querySelector(".xsave")?.textContent === "SAVE THE FILE ANYWAY"`);
    expect(await ev(`document.querySelector(".xwarn").innerText`)).toContain("chart-lib.js");
    await key("Escape");
  }, 60_000);
  test("desktop, a held file on A with B's panel opened: a toast, and A's file is still on A", async () => {
    const b = (await call(offline.base, "/api/briefs", { title: "Another page", body: "Plain words." })).id;
    await open(`brief/${heldBack}`, offline.base);
    await answerLate(800);
    await click("[data-export]");
    await click(`[data-export-as="html"]`);
    await ev(`location.hash = "#brief/${b}"`);
    await until(`document.querySelector(".bbody, .briefview")?.innerText.includes("Plain words.")`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !document.querySelector('[data-export-as="html"]').disabled`);
    await until(`(${toasts}).includes("is missing part of the page")`, 30_000);
    expect(await ev(`document.querySelector(".xsave")`)).toBe(null);
    await key("Escape");
    await ev(`location.hash = "#brief/${heldBack}"`);
    await until(`document.body.innerText.includes("needs a library") || !!document.querySelector("iframe")`);
    await until(`!!document.querySelector("[data-export]")`);
    await click("[data-export]");
    await until(`document.querySelector(".xsave")?.textContent === "SAVE THE FILE ANYWAY"`);
    await key("Escape");
  }, 60_000);
  test("desktop, an ordinary file, panel closed: it downloads, and the toast says where", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Toast file", body: "Plain words." })).id;
    await open(`brief/${id}`);
    await answerLate(500);
    await click("[data-export]");
    await click(`[data-export-as="html"]`);
    await key("Escape");
    await until(`(${toasts}).includes("toast-file.html is in your downloads")`, 30_000);
    for (let i = 0; i < 100 && !existsSync(join(downloads, "toast-file.html")); i++) await Bun.sleep(100);
    expect(existsSync(join(downloads, "toast-file.html"))).toBe(true);
  }, 60_000);
  test("phone: A's PDF lands with B's sheet open: a toast above the sheet, no file lost; after B closes, EXPORT on A has it", async () => {
    const a = (await call(server.base, "/api/briefs", { title: "Walk A", body: "Words of A." })).id;
    const b = (await call(server.base, "/api/briefs", { title: "Walk B", body: "Words of B." })).id;
    await open(`brief/${a}`, server.base, 390, 844, true);
    await ev(`navigator.canShare = undefined`);
    await answerLate(1500);
    await tap("[data-export]");
    await tap(`.xpanel [data-export-as="pdf"]`);
    await ev(`location.hash = "#brief/${b}"`);
    await until(`document.body.innerText.includes("Words of B.") && document.querySelector(".xpanel").hidden`);
    await Bun.sleep(300);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !document.querySelector('[data-export-as="pdf"]').disabled`);
    await until(`(${toasts}).includes("walk-a.pdf is ready")`, 30_000);
    expect(await ev(`(() => { const t = document.querySelector(".toast"), p = document.querySelector(".xpanel"); return Number(getComputedStyle(t).zIndex) > Number(getComputedStyle(p).zIndex); })()`)).toBe(true);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden && !history.state?.hqSheet`);
    await ev(`location.hash = "#brief/${a}"`);
    await until(`document.body.innerText.includes("Words of A.")`);
    await tap("[data-export]");
    await until(`document.querySelector(".xdone")?.innerText.includes("walk-a.pdf")`);
    await key("Escape");
  }, 60_000);
  test("a file the server no longer holds is not offered: EXPORT starts over", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Gone file", body: "Plain words." })).id;
    await open(`brief/${id}`);
    await click("[data-export]");
    await click(`[data-export-as="html"]`);
    await until(`!!document.querySelector(".xsave")`);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    // Eight more files push it out of what the server keeps.
    for (let i = 0; i < 9; i++) await call(server.base, "/api/exports", { page: id, format: "html" });
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !document.querySelector(".xsave") && !document.querySelector('[data-export-as="html"]').disabled`);
    await key("Escape");
  }, 60_000);
  test("turning from a sheet to wide puts the panel back under its button", async () => {
    await open(`brief/${brief}`, server.base, 700, 900, false);
    await click("[data-export]");
    await until(`document.querySelector(".xpanel").classList.contains("sheet")`);
    // Its check done, so nothing but the turn itself places it.
    await until(`!document.querySelector("[data-export-as]").disabled`);
    await page.s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(`!document.querySelector(".xpanel").classList.contains("sheet")`);
    await Bun.sleep(600);
    // Right under its button, not just somewhere below it.
    await until(`(() => { const p = document.querySelector(".xpanel").getBoundingClientRect(), b = document.querySelector("[data-export]").getBoundingClientRect(); return p.top >= b.bottom && p.top - b.bottom <= 8 && Math.abs(p.right - b.right) < 400 && p.left > 100; })()`);
    await key("Escape");
  }, 30_000);
});

describe.skipIf(!chromeFound)("a page with too many links", () => {
  test("the panel says so and offers no file, and asks again when opened again", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Far too many", body: `<!doctype html><html><body>${Array.from({ length: 100_000 }, (_, i) => `<a href="f${i}.html">y</a>`).join("")}</body></html>` })).id;
    await open(`brief/${id}`);
    await click("[data-export]");
    await until(`!!document.querySelector(".xpanel .xerr")`);
    expect(await ev(`document.querySelector(".xpanel .xerr").innerText`)).toContain("too many links");
    expect(await ev(`[...document.querySelectorAll(".xpanel [data-export-as]")].every((b) => b.disabled)`)).toBe(true);
    expect(await ev(`!!document.querySelector(".xpanel .xsave")`)).toBe(false);
    expect(await ev(`document.querySelector(".xpanel").innerText`)).not.toContain("could not be checked");
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    await click("[data-export]");
    await until(`!!document.querySelector(".xpanel .xerr")`);
    await key("Escape");
  }, 40_000);
});

describe.skipIf(!chromeFound)("a file made before the page changed", () => {
  const madeOnce = async (page) => {
    await open(page);
    await click("[data-export]");
    await until(`!document.querySelector("[data-export-as]").disabled`);
    await click(`[data-export-as="html"]`);
    await until(`!!document.querySelector(".xsave")`);
    await click("[data-export]");
    await until(`document.querySelector(".xpanel").hidden`);
  };
  test("a room's brief replaced: EXPORT starts over, and the new key is said", async () => {
    const whole = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB";
    await call(server.base, `/api/rooms/${slug}/brief`, { body: "# Before it moved\n\nThe old words.", by: "walk-lane" });
    await madeOnce(`room/${slug}`);
    await call(server.base, `/api/rooms/${slug}/brief`, { body: `# After it moved\n\nNow with ${whole}.`, by: "walk-lane" });
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !document.querySelector("[data-export-as]").disabled`);
    expect(await ev(`!!document.querySelector(".xsave")`)).toBe(false);
    expect(await ev(`document.querySelector(".xwarn")?.innerText ?? ""`)).toContain("looks like a key");
    await key("Escape");
  }, 40_000);
  test("a page unchanged: the file is offered again", async () => {
    await call(server.base, `/api/rooms/${slug}/brief`, { body: "# Standing still\n\nThe same words.", by: "walk-lane" });
    await madeOnce(`room/${slug}`);
    await click("[data-export]");
    await until(`!!document.querySelector(".xsave")`);
    await key("Escape");
  }, 40_000);
  test("while it asks, no old file is offered", async () => {
    await call(server.base, `/api/rooms/${slug}/brief`, { body: "# Asked about\n\nWords.", by: "walk-lane" });
    await madeOnce(`room/${slug}`);
    await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes("/api/exports/kept") ? new Promise((ok) => setTimeout(() => ok(real(u, o)), 800)) : real(u, o); })()`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    expect(await ev(`!!document.querySelector(".xsave")`)).toBe(false);
    await until(`!!document.querySelector(".xsave")`);
    await key("Escape");
  }, 40_000);
  test("with the server down it says it cannot check, and offers nothing that would not work", async () => {
    await call(server.base, `/api/rooms/${slug}/brief`, { body: "# Server going\n\nWords.", by: "walk-lane" });
    await madeOnce(`room/${slug}`);
    await ev(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes("/api/exports/kept") ? Promise.reject(new TypeError("Load failed")) : real(u, o); })()`);
    await click("[data-export]");
    await until(`!!document.querySelector(".xerr")`);
    expect(await ev(`document.querySelector(".xerr").innerText`)).toContain("cannot be checked");
    expect(await ev(`!!document.querySelector(".xsave")`)).toBe(false);
    await key("Escape");
  }, 40_000);
});

describe.skipIf(!chromeFound)("when the server does not answer", () => {
  test("a check that gets no answer opens the buttons and says it could not check; MAKING does not wait forever either", async () => {
    await open(`brief/${brief}`);
    await ev(`(() => { const later = window.setTimeout; window.setTimeout = (fn, ms, ...rest) => later(fn, ms === 180000 || ms === 10000 ? 50 : ms, ...rest); window.fetch = () => new Promise(() => {}); })()`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await until(`document.querySelector(".xwarn")?.innerText.includes("could not be checked")`);
    await click(`[data-export-as="pdf"]`);
    await until(`!!document.querySelector(".xerr")`);
    expect(await ev(`document.querySelector(".xerr").innerText`)).toContain("close some");
    expect(await ev(`document.querySelector('[data-export-as="pdf"]').disabled`)).toBe(false);
  }, 30_000);
});

describe.skipIf(!chromeFound)("on a phone it is the one sheet", () => {
  const isSheet = `(() => { const p = document.querySelector(".xpanel"); return !p.hidden && p.classList.contains("sheet"); })()`;
  const stillNow = `!document.querySelector(".xpanel").getAnimations().length`;
  const freed = `document.querySelector(".xpanel").hidden && !document.documentElement.classList.contains("sheetopen") && !history.state?.hqSheet`;
  const opened = async (w = 390, h = 844) => {
    await open(`brief/${brief}`, server.base, w, h, true);
    await tap("[data-export]");
    await until(isSheet);
    await until(stillNow);
  };
  test("anchored at the foot, with a scrim behind it and the page locked under it", async () => {
    await opened();
    const at = await ev(`(() => { const r = document.querySelector(".xpanel").getBoundingClientRect(), c = getComputedStyle(document.querySelector(".xpanel")), bg = document.querySelector(".sheetbg"); return { left: r.left, right: innerWidth - r.right, bottom: innerHeight - r.bottom, inlineTop: document.querySelector(".xpanel").style.top, scrim: !bg.hidden && bg.nextElementSibling === document.querySelector(".xpanel"), locked: document.documentElement.classList.contains("sheetopen"), z: Number(c.zIndex) > Number(getComputedStyle(bg).zIndex) }; })()`);
    expect(at).toEqual({ left: 8, right: 8, bottom: 8, inlineTop: "", scrim: true, locked: true, z: true });
  }, 30_000);
  test("an outside tap closes it and hits nothing behind it", async () => {
    await opened();
    const url = await ev(`location.href`);
    await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 3 }] });
    await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(freed);
    expect(await ev(`location.href`)).toBe(url);
    expect(await ev(`!!document.querySelector(".briefview:not([hidden])")`)).toBe(true);
  }, 30_000);
  test("Back closes it and stays on the brief", async () => {
    await opened();
    const url = await ev(`location.href`);
    await ev(`history.back()`);
    await until(freed);
    expect(await ev(`location.href`)).toBe(url);
    expect(await ev(`!!document.querySelector(".briefview:not([hidden])")`)).toBe(true);
    // The next Back is a real one: no entry was left behind by the sheet.
    expect(await ev(`!!history.state?.hqSheet`)).toBe(false);
  }, 30_000);
  test("EXPORT, then a file, from inside the sheet: SHARE and SAVE still work there, and Esc still closes it", async () => {
    await open(`brief/${brief}`, server.base, 390, 844, true);
    await ev(`(() => { window.__shared = []; navigator.canShare = () => true; navigator.share = (d) => { window.__shared.push(d.files[0].name); return Promise.resolve(); }; })()`);
    await tap("[data-export]");
    await until(isSheet);
    await tap(`.xpanel [data-export-as="html"]`);
    await until(`!!document.querySelector(".xpanel .xshare")`);
    expect(await ev(isSheet)).toBe(true);
    await tap(".xpanel .xshare");
    await until(`window.__shared.length === 1`);
    expect(await ev(`window.__shared[0]`)).toBe("monday-plan.html");
    expect(await ev(`document.querySelector(".xpanel .xsave").href`)).toContain("/exports/");
    await point(".xpanel .xsave");
    await key("Escape");
    await until(freed);
  }, 40_000);
  for (const format of ["html", "pdf"]) {
    test(`a real tap on SAVE THE FILE inside the sheet saves the ${format}, and the HUD and its sheet stay where they were`, async () => {
      await open(`brief/${brief}`, server.base, 390, 844, true);
      await ev(`navigator.canShare = undefined`);
      await tap("[data-export]");
      await until(isSheet);
      await until(stillNow);
      await tap(`.xpanel [data-export-as="${format}"]`);
      await until(`!!document.querySelector(".xpanel .xsave")`, 30_000);
      const url = await ev(`location.href`);
      // Chrome overwrites a download of the same name, so this one is proved by its name coming back.
      const saved = join(downloads, `monday-plan.${format}`);
      rmSync(saved, { force: true });
      await tap(".xpanel .xsave");
      // The file appears before its bytes do.
      for (let i = 0; i < 100 && !(existsSync(saved) && statSync(saved).size > 0); i++) await Bun.sleep(100);
      expect(existsSync(saved)).toBe(true);
      expect(statSync(saved).size).toBeGreaterThan(0);
      expect(await ev(`location.href`)).toBe(url);
      expect(await ev(isSheet)).toBe(true);
      await key("Escape");
      await until(freed);
    }, 60_000);
  }
  test("the wide screen stays as it was: under its button, with no sheet", async () => {
    await open(`brief/${brief}`);
    await click("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    const at = await ev(`(() => { const p = document.querySelector(".xpanel"), r = p.getBoundingClientRect(), b = document.querySelector("[data-export]").getBoundingClientRect(); return { sheet: p.classList.contains("sheet"), under: r.top >= b.bottom, open: document.documentElement.classList.contains("sheetopen") }; })()`);
    expect(at).toEqual({ sheet: false, under: true, open: false });
    await key("Escape");
  }, 30_000);
  test("in full screen, turned narrow: the sheet and its scrim are inside the full-screen element, and it works", async () => {
    await open(`brief/${brief}`);
    await click("[data-view-full]");
    await until(`!!document.fullscreenElement`);
    await Bun.sleep(500); // Chrome drops input for a moment while the screen changes
    await click("[data-export]");
    await until(`document.querySelector(".xpanel")?.parentElement === document.fullscreenElement`);
    await page.s("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(isSheet);
    await until(stillNow);
    await until(`document.querySelector(".sheetbg")?.parentElement === document.fullscreenElement`);
    expect(await ev(`document.querySelector(".xpanel").parentElement === document.fullscreenElement`)).toBe(true);
    await click(`.xpanel [data-export-as="html"]`);
    await until(`!!document.querySelector(".xpanel .xsave")`);
    await ev(`document.exitFullscreen()`);
    await until(`!document.fullscreenElement`);
  }, 40_000);
});

describe.skipIf(!chromeFound)("on a phone", () => {
  for (const [w, h] of [[360, 740], [390, 844], [430, 932]]) {
    test(`${w} px: a tap opens it, every target is 44 px, nothing leaves the screen, and it downloads`, async () => {
      for (const hash of [`brief/${brief}`, `brief/${pageBrief}`, `page/rooms/${slug}/files/shelf.html`]) {
        await open(hash, server.base, w, h, true);
        // every button in the bar is whole and on screen, EXPORT among them, and none breaks inside itself
        // The date is whole, and NEWER has OLDER beside it.
        const parts = await ev(`(() => { const when = document.querySelector(".bvmeta .when"), n = document.querySelector("[data-brief-step='-1']"), o = document.querySelector("[data-brief-step='1']"); return { clipped: when ? when.parentElement.clientWidth < when.offsetWidth : false, apart: n && o ? n.getBoundingClientRect().top !== o.getBoundingClientRect().top : false }; })()`);
        expect(parts).toEqual({ clipped: false, apart: false });
        const bar = await ev(`(() => { const b = document.querySelector("[data-export]").parentElement; return { over: b.scrollWidth > b.clientWidth + 1, out: [...b.querySelectorAll(".btn-s")].filter((c) => c.offsetParent && c.getBoundingClientRect().right > innerWidth).map((c) => c.textContent), broken: [...b.querySelectorAll(".btn-s")].filter((c) => c.offsetParent && getComputedStyle(c).whiteSpace !== "nowrap").map((c) => c.textContent) }; })()`);
        expect(bar).toEqual({ over: false, out: [], broken: [] });
        const size = await ev(`(() => { const r = document.querySelector("[data-export]").getBoundingClientRect(); return [r.width, r.height, r.right]; })()`) as number[];
        expect(size[0]).toBeGreaterThanOrEqual(44);
        expect(size[1]).toBeGreaterThanOrEqual(44);
        expect(size[2]).toBeLessThanOrEqual(w);
        await tap("[data-export]");
        await until(`!document.querySelector(".xpanel").hidden`);
        await until(`!document.querySelector(".xpanel").getAnimations().length`);
        const box = await ev(`(() => { const p = document.querySelector(".xpanel").getBoundingClientRect(); return { left: p.left, right: p.right, top: p.top, bottom: p.bottom, targets: [...document.querySelectorAll(".xpanel .btn-s")].map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }), wide: document.documentElement.scrollWidth }; })()`) as any;
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(w);
        expect(box.bottom).toBeLessThanOrEqual(h);
        for (const [tw, th] of box.targets) { expect(tw).toBeGreaterThanOrEqual(44); expect(th).toBeGreaterThanOrEqual(44); }
        expect(box.wide).toBeLessThanOrEqual(w);
        await tap(`.xpanel [data-export-as="html"]`);
        await until(`!!document.querySelector(".xsave")`);
        const save = await ev(`(() => { const r = document.querySelector(".xsave").getBoundingClientRect(); return [r.width, r.height, r.right, r.bottom]; })()`) as number[];
        expect(save[1]).toBeGreaterThanOrEqual(44);
        expect(save[2]).toBeLessThanOrEqual(w);
        expect(save[3]).toBeLessThanOrEqual(h);
      }
    }, 90_000);
  }
  test("nothing starts by itself on a touch screen: SHARE THE FILE opens the system's sheet from the tap, with the file in hand", async () => {
    rmSync(join(downloads, "monday-plan.pdf"), { force: true });
    await open(`brief/${brief}`, server.base, 390, 844, true);
    await ev(`window.__shared = []; navigator.canShare = () => true; navigator.share = (d) => { __shared.push([d.files[0].name, d.files[0].type, d.files[0].size, navigator.userActivation.isActive]); return Promise.resolve(); }; 0`);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await tap(`.xpanel [data-export-as="pdf"]`);
    await until(`!!document.querySelector("[data-export-share]")`, 60_000);
    expect(existsSync(join(downloads, "monday-plan.pdf"))).toBe(false);
    expect(await ev(`location.hash`)).toBe(`#brief/${brief}`);
    // A download attribute makes Mobile Safari take over the HUD's own tab, target or no target (real tap, pagehide fired).
    const target = await ev(`(() => { const a = document.querySelector(".xsave"), r = document.querySelector("[data-export-share]").getBoundingClientRect(); return [a.target, r.height, a.hasAttribute("download")]; })()`) as [string, number, boolean];
    expect(target[0]).toBe("_blank");
    expect(target[2]).toBe(false);
    expect(target[1]).toBeGreaterThanOrEqual(44);
    await tap("[data-export-share]");
    await until(`__shared.length === 1`);
    const [name, type, size, active] = (await ev(`__shared[0]`)) as [string, string, number, boolean];
    expect(name).toBe("monday-plan.pdf");
    expect(type).toBe("application/pdf");
    expect(size).toBeGreaterThan(1000);
    expect(active).toBe(true);
    expect(await panelOpen()).toBe(true);
  }, 90_000);
  test("a file finished while the panel was closed is still there when it opens again", async () => {
    await open(`brief/${brief}`, server.base, 390, 844, true);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await tap(`.xpanel [data-export-as="html"]`);
    await key("Escape");
    await until(`document.querySelector(".xpanel").hidden`);
    await until(`document.querySelector(".toast")?.textContent.includes("monday-plan.html")`);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden && !!document.querySelector(".xsave")`);
    await key("Escape");
  }, 40_000);
  test("cancelling the sheet says nothing; another failure says what happened", async () => {
    await open(`brief/${brief}`, server.base, 390, 844, true);
    await ev(`navigator.canShare = () => true; navigator.share = () => Promise.reject(new DOMException("the owner cancelled", "AbortError")); 0`);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await tap(`.xpanel [data-export-as="pdf"]`);
    await until(`!!document.querySelector("[data-export-share]")`, 60_000);
    await tap("[data-export-share]");
    await Bun.sleep(300);
    expect(await ev(`!!document.querySelector(".toast")`)).toBe(false);
    await ev(`navigator.share = () => Promise.reject(new Error("the sheet would not open")); 0`);
    await tap("[data-export-share]");
    await until(`document.querySelector(".toast")?.textContent.includes("the sheet would not open")`);
  }, 30_000);
  test("where it cannot share, SAVE THE FILE alone is the way, in a tab of its own", async () => {
    await open(`brief/${brief}`, server.base, 390, 844, true);
    await ev(`delete Navigator.prototype.canShare; navigator.canShare = undefined; 0`);
    await tap("[data-export]");
    await until(`!document.querySelector(".xpanel").hidden`);
    await tap(`.xpanel [data-export-as="html"]`);
    await until(`!!document.querySelector(".xsave")`);
    expect(await ev(`!!document.querySelector("[data-export-share]")`)).toBe(false);
    // An HTML file keeps its download attribute on a touch screen: that link is the one tapped on an iPhone, and it gave the prompt.
    expect(await ev(`[document.querySelector(".xsave").getAttribute("download"), document.querySelector(".xsave").target]`)).toEqual(["monday-plan.html", "_blank"]);
    await point(".xsave");
  }, 40_000);
});

describe.skipIf(!chromeFound)("the file, with the server stopped and the network off", () => {
  const requests: string[] = [];
  const openFile = async (path: string, w = 1280, h = 900) => {
    requests.length = 0;
    errors.length = 0;
    await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await page.s("Emulation.setTouchEmulationEnabled", { enabled: false });
    await page.s("Page.navigate", { url: "about:blank" });
    await page.s("Page.navigate", { url: `file://${path}` });
    await until(`document.readyState === "complete"`);
    await Bun.sleep(300);
  };
  beforeAll(async () => {
    if (!chromeFound) return;
    chrome.cdp.listeners.push((m: any) => { if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url); });
    // The file that tries to call home is fetched first, while the server is still up: it must be refused, not just unlucky.
    const r = await call(server.base, "/api/exports", { page: hostile, format: "html" });
    const path = join(downloads, "calls-home.html");
    writeFileSync(path, new Uint8Array(await (await fetch(`${server.base}${r.url}`)).arrayBuffer()));
    await openFile(path);
    await until(`window.tries && tries.hud !== "pending" && tries.decoy !== "pending"`);
    files.home = JSON.stringify(await ev(`tries`));
    // The shapes that once put the file's rules somewhere they did nothing: real Chrome decides, not the text.
    const reach = `<script>new Image().src = "http://127.0.0.1:${decoy.port}/tricky-img"; fetch("http://127.0.0.1:${decoy.port}/tricky-fetch").catch(() => {});</script>`;
    const tricky = [
      `<!doctype html><html><head data-x='a>b'><title>x</title></head><body><p>one</p>${reach}</body></html>`,
      `<!doctype html><html><head><title><head></title></head><body><p>two</p>${reach}</body></html>`,
      `<!doctype html><html><body><script>var s = "<head>";</script><p>three</p>${reach}</body></html>`,
      `<!doctype html><html lang="da"><script>fetch("http://127.0.0.1:${decoy.port}/before-head").catch(() => {});</script><head></head><body><p>four</p>${reach}</body></html>`,
    ];
    for (const [i, body] of tricky.entries()) {
      const id = (await call(server.base, "/api/briefs", { title: `Tricky ${i}`, body })).id;
      const made = await call(server.base, "/api/exports", { page: id, format: "html" });
      const path = join(downloads, `tricky-${i}.html`);
      writeFileSync(path, new Uint8Array(await (await fetch(`${server.base}${made.url}`)).arrayBuffer()));
      await openFile(path);
      await Bun.sleep(200);
      files[`tricky${i}`] = String(await ev(`document.body.innerText.trim()`));
    }
    files.lang = String(await ev(`document.documentElement.lang`));
    const lab = await call(server.base, "/api/exports", { page: labBrief, format: "html" });
    files.lab = join(downloads, "lab.html");
    writeFileSync(files.lab, new Uint8Array(await (await fetch(`${server.base}${lab.url}`)).arrayBuffer()));
    await server.stop();
    await page.s("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  }, 60_000);

  test("while the HUD is running, a file that tries to call it or anything else on this machine is refused", () => {
    expect(JSON.parse(files.home)).toEqual({ hud: "refused", decoy: "refused" });
    expect(decoyHits).toEqual([]);
  });
  test("however a page spells its head, the file's rules hold in a real browser, and the page still draws", () => {
    expect(decoyHits).toEqual([]);
    expect(["tricky0", "tricky1", "tricky2", "tricky3"].map((k) => files[k])).toEqual(["one", "two", "three", "four"]);
    expect(files.lang).toBe("da");
  });
  test("a markdown brief draws with its own font, its table and its picture, and nothing of what a reference names", async () => {
    await openFile(files.md);
    expect(requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:"))).toEqual([]);
    expect(await ev(`document.querySelector("h1").textContent`)).toBe("Monday plan");
    expect(await ev(`getComputedStyle(document.querySelector("h1")).fontFamily`)).toContain("Nunito");
    await until(`[...document.fonts].some((f) => f.family.includes("Nunito") && f.status === "loaded")`);
    expect(await ev(`document.querySelectorAll("table td").length`)).toBeGreaterThan(0);
    expect(await ev(`document.querySelector("pre").textContent`)).toBe("const answer = 42;");
    const img = await ev(`(() => { const i = document.querySelector("img.thumb"); return [i.complete, i.naturalWidth, i.src.slice(0, 15)]; })()`);
    expect(img).toEqual([true, 1, "data:image/png;"]);
    expect(await ev(`document.body.innerText`)).not.toContain("An older brief");
    expect(await ev(`document.querySelector("body").innerText`)).toContain("[secret PLANTED]");
    expect(errors).toEqual([]);
  }, 30_000);
  test("it reads on a phone too, and follows a dark screen", async () => {
    await openFile(files.md, 360, 740);
    expect(await ev(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(360);
    await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    const lum = (await ev(`getComputedStyle(document.body).backgroundColor`) as string).match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
    expect(lum).toBeLessThan(300);
    await page.s("Emulation.setEmulatedMedia", { features: [] });
  }, 30_000);
  test("a page: its script runs, storage lasts while it is open, capabilities say no and a note says why", async () => {
    await openFile(files.page);
    expect(await ev(`document.querySelector("h1").textContent`)).toBe("A page brief");
    expect(await ev(`document.body.innerText`)).not.toContain("An older brief");
    await openFile(files.page, 360, 740);
    expect(await ev(`document.documentElement.clientWidth`)).toBe(360);
    expect(await ev(`localStorage.getItem("k")`)).toBe("kept in memory");
    expect(await ev(`window.useAnswer`)).toBe(null);
    expect(await ev(`!!document.querySelector("saved-note")`)).toBe(true);
    await ev(`localStorage.setItem("other", "gone after a reload")`);
    await page.s("Page.reload");
    await until(`document.readyState === "complete" && !!document.querySelector("h1")`);
    expect(await ev(`localStorage.getItem("other")`)).toBe(null);
    expect(requests.filter((u) => /^https?:/.test(u))).toEqual([]);
  }, 30_000);
  test("Parity Lab: its diagram and its CDN chart draw from the file, with the network off", async () => {
    await openFile(files.lab);
    await until(`!!document.querySelector(".mermaid-box svg")`, 20_000);
    expect(await ev(`document.querySelector(".mermaid-box svg text, .mermaid-box svg .nodeLabel") !== null`)).toBe(true);
    expect(requests.filter((u) => u.includes("127.0.0.1"))).toEqual([]);
    expect(requests.filter((u) => /^https?:/.test(u)).every((u) => /fonts\.(?:googleapis|gstatic)\.com|cdnjs\.cloudflare/.test(u))).toBe(true);
    await until(`typeof Chart === "function"`);
  }, 40_000);
});
