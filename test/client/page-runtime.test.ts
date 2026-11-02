// THE PAGE RUNTIME in Chrome: a page written for a Claude artifact (claude.use("db"), claude.use("user"), localStorage)
// runs unchanged in the brief view and in the room page view: its storage is kept per page across loads, its db writes
// are kept and read back by hud page data, and a write from elsewhere reaches its onSnapshot live. It still cannot read
// the HUD's document or fetch its data. The HUD takes a hello only from a page frame, for the page that frame shows:
// a hello naming another page, or from a frame inside the page, gets no answer. A page is held to 60 calls a second.
// downloads.save asks the owner first.
// Opened on its own (OPEN IN NEW TAB) the page reads its stored keys and use() gives null. Needs Chrome; skipped
// without it. The Mermaid check also needs the network (jsdelivr) and is skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-runtime-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let online = false;

// A page as an agent writes it for a Claude artifact. It reports what it found to its parent, and again on every snapshot.
const APP = `<!doctype html><html><head><title>Votes</title></head><body><h1>Votes</h1><pre class="mermaid">graph LR; A-->B</pre><script>
const out = { t0: performance.timeOrigin, hud: typeof window.hud?.use, claude: typeof window.claude?.use, same: window.hud === window.claude };
out.before = localStorage.getItem("visits");
localStorage.setItem("visits", String(Number(out.before || 0) + 1));
localStorage.note = "kept";
sessionStorage.setItem("s", "1");
out.session = sessionStorage.getItem("s");
try { out.parentDoc = !!parent.document.body; } catch { out.parentDoc = false; }
const report = () => parent.postMessage({ probe: JSON.parse(JSON.stringify(out)) }, "*");
addEventListener("load", () => { const t = setInterval(() => { if (document.querySelector(".mermaid svg")) { clearInterval(t); out.mermaid = true; report(); } }, 200); });
(async () => {
  const tryFetch = (u, o) => fetch(u, o).then(() => true, () => false);
  out.fetchState = (await tryFetch("/api/state")) || (await tryFetch(location.origin + "/api/state"));
  out.postData = await tryFetch(location.origin + "/api/page-runtime/db", { method: "POST", headers: { "x-hud": "1", "content-type": "application/json" }, body: "{}" });
  const db = await claude.use("db"), user = await claude.use("user");
  if (!db || !user) return; // opened outside the HUD
  out.memo = claude.use("db") === claude.use("db");
  out.sample = await claude.use("sample");
  out.artifact = await claude.use("artifact");
  out.frozen = Object.isFrozen(db);
  const id = await user.id();
  out.me = await user.me();
  out.owner = await user.isOwner();
  await db.doc("votes/" + id).set({ picks: ["db"], at: 1 });
  out.got = (await db.doc("votes/" + id).get()).data();
  try { db.doc("votes"); } catch (e) { out.badPath = e.name; }
  try { await db.doc("votes/none").update({ x: 1 }); } catch (e) { out.updateMissing = e.code; }
  out.sizes = [];
  db.collection("votes").orderBy("at").onSnapshot((s) => { out.sizes.push(s.size); out.changes = s.docChanges().map((c) => c.type + ":" + c.doc.id); report(); });
})();
</script></body></html>`;

// A page that says hello for another page, and holds a frame of its own that says hello for this one.
const FORGE = `<!doctype html><html><head></head><body><script>
const hello = (target, page) => new Promise((ok) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => ok(e.data && e.data.hello ? "answered" : "other");
  target.postMessage({ "hud-page": "hello", page, nonce: "forged" + Math.random() }, "*", [ch.port2]);
  setTimeout(() => ok("silent"), 1500);
});
(async () => {
  const out = { t0: performance.timeOrigin };
  out.otherPage = await hello(parent, "briefs/1");
  out.ownPage = await hello(parent, "rooms/pricing/files/forge.html");
  const f = document.createElement("iframe");
  f.srcdoc = '<script>const ch = new MessageChannel(); ch.port1.onmessage = () => parent.postMessage({ nested: "answered" }, "*"); top.postMessage({ "hud-page": "hello", page: "rooms/pricing/files/forge.html", nonce: "n" }, "*", [ch.port2]); setTimeout(() => parent.postMessage({ nested: "silent" }, "*"), 1500);<\\/script>';
  out.nested = await new Promise((ok) => { addEventListener("message", (e) => { if (e.data && e.data.nested) ok(e.data.nested); }); document.body.append(f); });
  parent.postMessage({ probe: out }, "*");
})();
</script></body></html>`;

// A page that offers files: two refused outright, then one the owner declines and one the owner saves.
const SAVE = `<!doctype html><html><head></head><body><script>
(async () => {
  const dl = await claude.use("downloads");
  const out = { t0: performance.timeOrigin };
  try { await dl.save({ filename: "run.exe", data: "x" }); } catch (e) { out.exe = e.code; }
  try { await dl.save({ filename: "../a.txt", data: "x" }); } catch (e) { out.path = e.code; }
  out.first = await dl.save({ filename: "results.json", data: '{"ok":true}' }).then((r) => r.status, (e) => e.code);
  parent.postMessage({ probe: { ...out } }, "*");
  out.second = await dl.save({ filename: "results.csv", data: new TextEncoder().encode("a,b\\n1,2\\n") }).then((r) => r.status, (e) => e.code);
  parent.postMessage({ probe: out }, "*");
})();
</script></body></html>`;

// A page that calls far more than a page may in one second.
const FLOOD = `<!doctype html><html><head></head><body><script>
(async () => {
  const db = await claude.use("db");
  const r = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => db.doc("flood/" + i).get()));
  const limited = r.filter((x) => x.status === "rejected" && x.reason.code === "resource_exhausted").length;
  parent.postMessage({ probe: { t0: performance.timeOrigin, ok: r.length - limited, limited } }, "*");
})();
</script></body></html>`;

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
const upload = (name: string, body: string) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name, title: name, as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body }).then((r) => r.json());
const hud = (args: string[]) => JSON.parse(Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "w1:p1", HUD_LOCAL_MACHINE: "local" }, stdout: "pipe" }).stdout.toString());
async function load(hash: string) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  // a report from a document that started before the last reload is late: it is not the page being tested
  await ev(`window.__probe = null; window.__since = 0; addEventListener("message", (e) => { if (e.data?.probe && !(e.data.probe.t0 < window.__since)) window.__probe = e.data.probe; }), true`);
}
const frame = `document.querySelector(".pageview:not([hidden]) iframe, .briefview:not([hidden]) iframe")`;
// The frame loads again once the test listens, so its report is not missed.
async function reloadFrame(ready = "window.__probe?.sizes?.length") {
  await ev(`(() => { window.__probe = null; window.__since = Date.now(); const f = ${frame}; f.src = f.getAttribute("src"); return true; })()`);
  await until(`!!(${ready})`, 10_000);
  return ev(`window.__probe`);
}
let brief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  online = await fetch("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/package.json", { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Tester" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await upload("app.html", APP);
  await upload("forge.html", FORGE);
  await upload("save.html", SAVE);
  await upload("flood.html", FLOOD);
  brief = (await post("/api/briefs", { title: "Votes", body: APP }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

const artifactPage = async (key: string) => {
  // (the frame's first load counted a visit too, maybe after this load read its storage: count from here)
  const p = await reloadFrame();
  const visits = Number(p.before ?? 0);
  expect(p).toMatchObject({
    hud: "function", claude: "function", same: true, session: "1",
    parentDoc: false, fetchState: false, postData: false,
    memo: true, sample: null, artifact: null, frozen: true,
    me: { id: "owner", name: "Tester", avatarUrl: "", color: "#4a7bd0", email: null, isOwner: true, canEdit: true }, owner: true,
    got: { picks: ["db"], at: 1 }, badPath: "TypeError", updateMissing: "invalid_argument",
    sizes: [1], changes: ["added:owner"],
  });
  // a write from elsewhere (another view, the same as the bridge sends it) reaches the open page live
  await post("/api/page-runtime/db", { page: key, op: "set", path: "votes/hq", data: { picks: ["mermaid"], at: 2 } });
  await until(`window.__probe?.sizes?.at(-1) === 2`);
  expect(await ev(`window.__probe.changes`)).toEqual(["added:hq"]);
  // its storage is kept: the next load reads it synchronously
  expect((await reloadFrame()).before).toBe(String(visits + 1));
  // and HQ reads back what the page keeps
  const data = hud(["page", "data", key]);
  expect(data.storage).toEqual({ visits: String(visits + 2), note: "kept" });
  expect(Object.keys(data.docs)).toEqual(["votes/hq", "votes/owner"]);
  if (online) await until(`window.__probe?.mermaid === true`, 15_000);
};

test.skipIf(!chromeFound)("an artifact-style page in the brief view: storage, db, user and live snapshots; the HUD out of reach", async () => {
  await load(`#brief/${brief}`);
  await until(`${frame}?.getAttribute("src")?.split("?")[0] === "/briefs/${brief}.html"`);
  await artifactPage(`briefs/${brief}`);
}, 60_000);

test.skipIf(!chromeFound)("the same page as a room's page on the stage: its own storage and data", async () => {
  await load("#page/rooms/pricing/files/app.html");
  await until(`${frame}?.getAttribute("src")?.split("?")[0] === "/rooms/pricing/files/app.html"`);
  await artifactPage("rooms/pricing/files/app.html");
}, 60_000);

test.skipIf(!chromeFound)("the HUD answers a hello only for the page the frame shows, and only from the page's own frame", async () => {
  await load("#page/rooms/pricing/files/forge.html");
  await until(`${frame}?.getAttribute("src")?.split("?")[0] === "/rooms/pricing/files/forge.html"`);
  const p = await reloadFrame(`window.__probe?.nested`);
  expect(p).toEqual({ t0: p.t0, otherPage: "silent", ownPage: "answered", nested: "silent" });
}, 30_000);

test.skipIf(!chromeFound)("downloads.save: refused names, then the owner says NO, then SAVE, and the HUD saves the file", async () => {
  await load("#page/rooms/pricing/files/save.html");
  await until(`!!document.querySelector(".pr-save")`, 10_000);
  expect(await ev(`document.querySelector(".pr-save").textContent`)).toContain("results.json");
  await ev(`document.querySelector(".pr-save .pr-no").click()`);
  await until(`window.__probe?.first`);
  expect(await ev(`window.__probe`)).toMatchObject({ exe: "rejected_extension", path: "bad_request", first: "declined" });
  await until(`document.querySelector(".pr-save")?.textContent.includes("results.csv")`);
  await ev(`document.querySelector(".pr-save .pr-yes").click()`);
  await until(`window.__probe?.second`);
  expect(await ev(`window.__probe.second`)).toBe("saved");
  expect(await ev(`!!document.querySelector(".pr-save")`)).toBe(false);
  const file = join(dir, "results.csv");
  // Chrome creates the file before it has written it: wait for the whole of it
  for (let i = 0; i < 50 && !(existsSync(file) && readFileSync(file, "utf8") === "a,b\n1,2\n"); i++) await Bun.sleep(100);
  expect(readFileSync(file, "utf8")).toBe("a,b\n1,2\n");
}, 30_000);

test.skipIf(!chromeFound)("a page that floods the HUD with calls is held to 60 a second (resource_exhausted)", async () => {
  await load("#page/rooms/pricing/files/flood.html");
  await until(`${frame}?.getAttribute("src")?.split("?")[0] === "/rooms/pricing/files/flood.html"`);
  expect(await reloadFrame(`window.__probe?.limited !== undefined`)).toMatchObject({ ok: 60, limited: 40 });
}, 30_000);

test.skipIf(!chromeFound)("opened on its own (OPEN IN NEW TAB): its stored keys are there, use() gives null", async () => {
  await page.s("Page.navigate", { url: `${server.base}/briefs/${brief}.html` });
  await until(`document.readyState === "complete"`);
  const r = await ev(`(async () => ({ db: await claude.use("db"), user: await hud.use("user"), note: localStorage.getItem("note") }))()`);
  expect(r).toEqual({ db: null, user: null, note: "kept" });
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox/i.test(e))).toEqual([]);
});
