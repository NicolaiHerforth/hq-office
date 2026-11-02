// HTML PAGES on the page: a room's .html file opens from the shelf as a page on the stage, in a sandboxed frame. The
// page's own scripts, styles and pictures (inline, and from the room's files/) work; the HUD does not: it cannot read
// the HUD's document, fetch its data or use its storage. A room brief that is a page and a floor brief that is one
// open the same way; BACK returns to the room; on a phone it fills the screen. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-pages-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
// A 1x1 PNG, for a picture the page loads from the room's files/.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
// The page reports what it could and could not do, to its parent.
const PROBE = (pic = "dot.png") => `<!doctype html><html><head><style>h1{color:rgb(1,2,3)}</style></head><body><h1>Probe</h1><img id=pic src="${pic}"><script>
const out = { ran: true, color: getComputedStyle(document.querySelector("h1")).color };
try { out.parentDoc = !!parent.document.body; } catch { out.parentDoc = false; }
try { localStorage.setItem("x", "1"); out.storage = true; } catch { out.storage = false; }
try { out.cookie = document.cookie; out.cookieOk = true; } catch { out.cookieOk = false; }
const pic = document.getElementById("pic");
const picDone = new Promise((ok) => { if (pic.complete) ok(); pic.onload = pic.onerror = ok; });
Promise.all([fetch("/api/state").then(() => true, () => false), fetch(location.origin + "/api/state").then(() => true, () => false), picDone]).then(([a, b]) => {
  out.fetchState = a || b; out.pic = pic.naturalWidth;
  parent.postMessage({ probe: out }, "*");
});
</script></body></html>`;

// The probe as a fragment, the way a Claude artifact may be: no doctype, <html> or <body>.
const FRAGMENT = PROBE().replace("<!doctype html><html><head>", "<title>Probe</title>").replace("</head><body>", "").replace("</body></html>", "");
// What Babel standalone needs to run JSX in the page (an artifact's way to use React): eval, and a script it adds inline.
const MECH = `<!doctype html><html><body><script>
const out = {};
try { out.eval = eval("1 + 1") === 2; } catch { out.eval = false; }
try { out.fn = new Function("return 3")() === 3; } catch { out.fn = false; }
const s = document.createElement("script"); s.textContent = "window.__added = 1"; document.head.append(s);
out.added = window.__added === 1;
parent.postMessage({ mech: out }, "*");
</script></body></html>`;
// React with JSX from a CDN, as the README shows it. The counter clicks itself once and reports what it shows.
const CDN = "https://cdnjs.cloudflare.com/ajax/libs";
const REACT = `<!doctype html><html><head><title>Counter</title>
<script src="${CDN}/react/18.3.1/umd/react.production.min.js"></script>
<script src="${CDN}/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script src="${CDN}/babel-standalone/7.26.4/babel.min.js"></script>
</head><body><div id="root"></div><script type="text/babel">
function Counter() {
  const [n, setN] = React.useState(0);
  const ref = React.useRef(null);
  React.useEffect(() => { if (n === 0) ref.current.click(); else parent.postMessage({ react: ref.current.textContent }, "*"); }, [n]);
  return <button ref={ref} onClick={() => setN(n + 1)}>Clicked {n} times</button>;
}
ReactDOM.createRoot(document.getElementById("root")).render(<Counter />);
</script></body></html>`;
// Two halves to click: the top copies to the clipboard, the bottom goes full screen. Each says how it went.
const ASKS = `<!doctype html><html><head><style>html,body{margin:0;height:100%}button{display:block;width:100%;height:50%;border:0;font:20px sans-serif}</style></head><body>
<button id=copy>COPY</button><button id=full>FULL SCREEN</button><script>
const say = (m) => parent.postMessage({ asks: m }, "*");
copy.onclick = () => navigator.clipboard.writeText("copied from a page").then(() => say({ copy: "ok" }), (e) => say({ copy: String(e) }));
full.onclick = () => document.documentElement.requestFullscreen().then(() => say({ full: !!document.fullscreenElement }), (e) => say({ full: String(e) }));
</script></body></html>`;
// The React test needs the CDN; without a network it is skipped (the eval test above still runs).
const online = chromeFound && (await fetch(`${CDN}/react/18.3.1/umd/react.production.min.js`, { method: "HEAD", signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false));

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const upload = (name: string, body: string | Uint8Array, type: string) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name, title: name, as: "pm" })}`, { method: "POST", headers: { "content-type": type, "x-hud": "1" }, body }).then((r) => r.json());
async function load(hash = "", w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  // a fresh load each time (from one hash to another would only change the hash)
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await ev(`window.__probe = null; addEventListener("message", (e) => { if (e.data?.probe) window.__probe = e.data.probe; if (e.data?.mech) window.__mech = e.data.mech; if (e.data?.react) window.__react = e.data.react; if (e.data?.asks) Object.assign(window.__asks ??= {}, e.data.asks); }), true`);
}
let brief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await upload("dot.png", PNG, "image/png");
  await upload("probe.html", PROBE(), "text/html");
  await upload("mech.html", MECH, "text/html");
  await upload("react.html", REACT, "text/html");
  await upload("asks.html", ASKS, "text/html");
  await upload("frag.html", FRAGMENT, "text/html");
  // the brief sits at the room folder's top, its files in files/ (as on disk); a floor brief carries its pictures inline
  await post("/api/rooms/pricing/brief", { body: PROBE("files/dot.png"), as: "pm" });
  brief = (await post("/api/briefs", { title: "Pricing as a page", body: PROBE(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`) }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

// The frame loads again once the test listens, so its report is not missed.
const sandboxedProbe = async () => {
  await ev(`(() => { window.__probe = null; const f = document.querySelector(".pageview:not([hidden]) iframe, .briefview:not([hidden]) iframe"); f.src = f.getAttribute("src"); return true; })()`);
  await until(`!!window.__probe`, 10_000);
  const p = await ev(`window.__probe`);
  // storage: the page's own localStorage, from the page runtime (test/client/page-runtime.test.ts), never the HUD's
  expect(p).toMatchObject({ ran: true, color: "rgb(1, 2, 3)", parentDoc: false, storage: true, cookieOk: false, fetchState: false, pic: 1 });
};

test.skipIf(!chromeFound)("the shelf's OPEN on a .html file: the page on the stage, sandboxed: its scripts, styles and pictures work, the HUD is out of reach", async () => {
  await load("#room/pricing");
  await until(`[...document.querySelectorAll(".art.page .open")].some((a) => a.getAttribute("href") === "#page/rooms/pricing/files/probe.html")`);
  // a picture on the shelf is still a picture
  expect(await ev(`!!document.querySelector('.art.image img[src="/rooms/pricing/files/dot.png"]')`)).toBe(true);
  await ev(`[...document.querySelectorAll(".art.page .open")].find((a) => a.getAttribute("href").endsWith("probe.html")).click()`);
  await until(`!document.querySelector(".pageview").hidden`);
  const f = await ev(`(() => { const f = document.querySelector(".pageview iframe"); return { src: f.dataset.src, sandbox: f.getAttribute("sandbox") }; })()`);
  expect(f.src).toBe("/rooms/pricing/files/probe.html");
  expect(f.sandbox).toContain("allow-scripts");
  expect(f.sandbox).not.toContain("allow-same-origin");
  expect(await ev(`document.querySelector(".pvtitle").textContent`)).toBe("probe.html");
  // a wide stage: the room stays beside the page (split/)
  expect(await ev(`getComputedStyle(document.querySelector(".roomview")).display`)).toBe("flex");
  await sandboxedProbe();
  // BACK: to the room
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "#room/pricing" && document.querySelector(".pageview").hidden`);
  expect(await ev(`getComputedStyle(document.querySelector(".roomview")).display`)).not.toBe("none");
}, 30_000);

test.skipIf(!chromeFound)("a room brief that is a page: OPEN THE BRIEF, the same sandbox", async () => {
  await load("#room/pricing");
  await until(`!!document.querySelector('a[href="#page/rooms/pricing/brief"]')`);
  await ev(`document.querySelector('a[href="#page/rooms/pricing/brief"]').click()`);
  await until(`document.querySelector(".pageview iframe")?.dataset.src === "/rooms/pricing/brief.html"`);
  await sandboxedProbe();
  await ev(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  await until(`location.hash === "#room/pricing"`);
}, 30_000);

// The frame fills the view under its bar: its bottom is the view's, and the bar is all there is above it.
const fills = () => ev(`(() => { const v = document.querySelector(".briefview"), f = v.querySelector(".pageframe"), b = v.querySelector(".bvbar"); const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect(), br = b.getBoundingClientRect(); return { below: Math.round(vr.bottom - fr.bottom), gap: Math.round(fr.top - br.bottom), scrolls: v.scrollHeight > v.clientHeight + 1 }; })()`);

test.skipIf(!chromeFound)("a floor brief that is a page: the brief view shows it in the sandboxed frame", async () => {
  await load(`#brief/${brief}`);
  await until(`document.querySelector(".briefview .pageframe")?.dataset.src === "/briefs/${brief}.html"`);
  expect(await ev(`document.querySelector(".briefview .pageframe").getAttribute("sandbox").includes("allow-same-origin")`)).toBe(false);
  expect(await ev(`document.querySelector(".briefview .pageframe").getBoundingClientRect().height > 300`)).toBe(true);
  // the page has its own title: the HUD's is not drawn over it, only a compact line in the bar (date, who)
  expect(await ev(`!!document.querySelector(".briefview h1")`)).toBe(false);
  expect(await ev(`document.querySelector(".briefview .bvbar .bvmeta").textContent`)).toContain("by hq");
  const f = await fills();
  expect(f.below).toBeLessThanOrEqual(16);
  expect(f.gap).toBeLessThanOrEqual(12);
  expect(f.scrolls).toBe(false);
  await sandboxedProbe();
  // its lead in the list is its text, not its markup
  await ev(`document.querySelector('[data-qtab="briefs"]').click()`);
  await until(`document.querySelectorAll("#briefs .brow").length === 1`);
  expect(await ev(`document.querySelector("#briefs .blead").textContent`)).toContain("Probe");
}, 30_000);

test.skipIf(!chromeFound)("opened by its link: a page fills a phone's screen; BACK goes to the office", async () => {
  await load("#page/rooms/pricing/files/probe.html", 390, 844, true);
  await until(`!document.querySelector(".pageview").hidden`);
  const r = await ev(`(() => { const b = document.querySelector(".pageview").getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
  expect(r).toEqual([0, 0, 390, 844]);
  expect(await ev(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  await sandboxedProbe();
  await ev(`document.querySelector("[data-page-back]").click()`);
  await until(`location.hash === "" && document.querySelector(".pageview").hidden`);
}, 30_000);

test.skipIf(!chromeFound)("a markdown brief keeps its title block", async () => {
  const id = (await post("/api/briefs", { title: "Plain words", body: "# Heading\n\nText." }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  await load(`#brief/${id}`);
  await until(`document.querySelector(".briefview h1")?.textContent === "Plain words"`);
  expect(await ev(`!!document.querySelector(".briefview .bvmeta")`)).toBe(false);
}, 30_000);

test.skipIf(!chromeFound)("a page brief on a phone: the bar, then the page to the foot of the screen", async () => {
  await load(`#brief/${brief}`, 390, 844, true);
  await until(`!!document.querySelector(".briefview .pageframe")`);
  expect(await ev(`document.documentElement.scrollWidth <= 390`)).toBe(true);
  const f = await fills();
  expect(f.below).toBeLessThanOrEqual(6);
  expect(f.scrolls).toBe(false);
  // the bar fits the screen: BACK, the date and who, the reading theme, NEWER and OLDER
  expect(await ev(`(() => { const b = document.querySelector(".briefview .bvbar"); return b.scrollWidth <= b.clientWidth && [...b.children].every((c) => c.getBoundingClientRect().right <= 390); })()`)).toBe(true);
  expect(await ev(`document.querySelector(".briefview .pageframe").getBoundingClientRect().height`)).toBeGreaterThan(700);
}, 30_000);

test.skipIf(!chromeFound)("what JSX needs runs in the sandbox: eval, new Function, a script added inline", async () => {
  await load("#page/rooms/pricing/files/mech.html");
  await until(`!!document.querySelector(".pageview iframe")`);
  await ev(`(() => { const f = document.querySelector(".pageview iframe"); f.src = f.getAttribute("src"); return true; })()`);
  await until(`!!window.__mech`);
  expect(await ev(`window.__mech`)).toEqual({ eval: true, fn: true, added: true });
}, 30_000);

test.skipIf(!online)("React with JSX from a CDN renders and handles a click in the sandboxed frame", async () => {
  await load("#page/rooms/pricing/files/react.html");
  await until(`!!document.querySelector(".pageview iframe")`);
  await ev(`(() => { const f = document.querySelector(".pageview iframe"); f.src = f.getAttribute("src"); return true; })()`);
  await until(`!!window.__react`, 20_000);
  expect(await ev(`window.__react`)).toBe("Clicked 1 times");
}, 40_000);

test.skipIf(!chromeFound)("a fragment runs as a page: its styles, scripts and pictures, the same sandbox", async () => {
  await load("#page/rooms/pricing/files/frag.html");
  await until(`!!document.querySelector(".pageview iframe")`);
  await sandboxedProbe();
}, 30_000);

// A real click (CDP input, so the page has a user's gesture) at a point of the frame, given as a share of its size.
async function clickFrame(fx: number, fy: number) {
  const [x, y] = await ev(`(() => { const r = document.querySelector(".pageview iframe").getBoundingClientRect(); return [r.left + r.width * ${fx}, r.top + r.height * ${fy}]; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}
test.skipIf(!chromeFound)("a page may copy to the clipboard and go full screen from a click, as an artifact may", async () => {
  await load("#page/rooms/pricing/files/asks.html");
  await until(`!!document.querySelector(".pageview iframe")`);
  expect(await ev(`document.querySelector(".pageview iframe").getAttribute("allow")`)).toBe("clipboard-write; fullscreen");
  await ev(`(() => { const f = document.querySelector(".pageview iframe"); f.src = f.getAttribute("src"); return true; })()`);
  await Bun.sleep(500); // the frame has loaded its page again
  await clickFrame(0.5, 0.25);
  await until(`!!window.__asks?.copy`);
  expect(await ev(`window.__asks.copy`)).toBe("ok");
  await clickFrame(0.5, 0.75);
  await until(`window.__asks?.full !== undefined`);
  expect(await ev(`window.__asks.full`)).toBe(true);
  expect(await ev(`document.fullscreenElement?.tagName`)).toBe("IFRAME");
  await ev(`document.exitFullscreen().then(() => true)`);
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
