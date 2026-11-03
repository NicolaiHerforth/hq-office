// THE PAGE RUNTIME in Chrome: a page written for a Claude artifact (claude.use("db"), claude.use("user"), localStorage)
// runs unchanged in the brief view and in the room page view: its storage is kept per page across loads, its db writes
// are kept and read back by hud page data, and a write from elsewhere reaches its onSnapshot live. It still cannot read
// the HUD's document or fetch its data. The HUD takes a hello only from a page frame, for the page that frame shows:
// a hello naming another page, or from a frame inside the page, gets no answer. A page is held to 60 calls a second.
// downloads.save asks the owner first.
// Opened on its own (OPEN IN NEW TAB) the page reads its stored keys and use() gives null. Needs Chrome; skipped
// without it. The Mermaid check also needs the network (jsdelivr) and is skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { clickLog, watch } from "../walk-diag.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-page-runtime-view-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let online = false;

// A page as an agent writes it for a Claude artifact. It reports what it found to its parent, and again on every snapshot.
const APP = `<!doctype html><html><head><title>Votes</title></head><body><h1>Votes</h1><pre class="mermaid">graph LR; A-->B</pre><script>
const out = { doc: new URLSearchParams(location.search).get("doc"), hud: typeof window.hud?.use, claude: typeof window.claude?.use, same: window.hud === window.claude };
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
  out.sample = typeof (await claude.use("sample"));
  out.artifact = typeof (await claude.use("artifact"))?.publish;
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
  const out = { doc: new URLSearchParams(location.search).get("doc") };
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
  const out = { doc: new URLSearchParams(location.search).get("doc") };
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
  parent.postMessage({ probe: { doc: new URLSearchParams(location.search).get("doc"), ok: r.length - limited, limited } }, "*");
})();
</script></body></html>`;

// A page that is its own record: at 0 it publishes itself at 1 (a test page may do it on load; a real one waits for
// the viewer), and every view reloads to the new version.
const POLL = `<!doctype html><html><head><title>Poll</title></head><body><p id="n">0</p><script>
const SRC = document.currentScript.textContent;
const n = Number(document.getElementById("n").textContent);
parent.postMessage({ probe: { doc: new URLSearchParams(location.search).get("doc"), n } }, "*");
if (n === 0) claude.use("artifact").then((a) => a.publish('<!doctype html><html><head><title>Poll</title></head><body><p id="n">' + (n + 1) + '</p><script>' + SRC + '<\\/script></body></html>'))
  .then((r) => parent.postMessage({ probe: { doc: new URLSearchParams(location.search).get("doc"), n, published: r.version } }, "*"), (e) => parent.postMessage({ probe: { doc: new URLSearchParams(location.search).get("doc"), n, refused: e.code } }, "*"));
</script></body></html>`;

// A page for everyone who has it open: it says who is there, and pings once when someone else is.
const ROOM = `<!doctype html><html><head></head><body><script>
const out = { doc: new URLSearchParams(location.search).get("doc"), heard: [], others: 0 };
const report = () => parent.postMessage({ probe: JSON.parse(JSON.stringify(out)) }, "*");
(async () => {
  const room = await claude.use("room");
  let pinged = false;
  room.on("ping", (m) => { out.heard.push([m.data, m.kind, m.by, m.sameTab]); report(); });
  room.onPeers((c) => {
    out.others = c.peers.length - 1;
    out.presence = c.peers.map((p) => p.presence.here).filter(Boolean).length;
    report();
    if (out.others > 0 && !pinged) { pinged = true; room.emit("ping", "hello"); }
  });
  await room.presence({ here: true });
  out.connected = room.connected();
  const g = await room.join("game");
  out.game = g.name;
  report();
})();
</script></body></html>`;

// A page that asks a model twice: the owner is asked once, and the answers stream back.
const ASK = `<!doctype html><html><head></head><body><script>
const out = { doc: new URLSearchParams(location.search).get("doc"), texts: [] };
const report = () => parent.postMessage({ probe: JSON.parse(JSON.stringify(out)) }, "*");
(async () => {
  const sample = await claude.use("sample");
  try { out.first = (await sample("hello", { onText: ({ text }) => out.texts.push(text) })).text; } catch (e) { out.first = e.code; }
  try { out.json = await sample.json("JSON please"); } catch (e) { out.json = e.code; }
  report();
})();
</script></body></html>`;
// A page that quotes itself into the HUD's comment thread: an element on load; a range, or a selection, when asked.
const QUOTE = `<!doctype html><html><head></head><body><h1 id="t">Pricing</h1><p id="p">Tier two costs forty a month.</p><script>
const step = (step) => parent.postMessage({ step }, "*");
const out = { doc: new URLSearchParams(location.search).get("doc") };
const report = () => parent.postMessage({ probe: JSON.parse(JSON.stringify(out)) }, "*");
(async () => {
  step("started");
  const comments = await claude.use("comments");
  step(comments ? "comments" : "no comments");
  out.anchor = await comments.anchorFor(document.getElementById("p"));
  step("anchored");
  out.element = await comments.openComposer({ element: document.getElementById("p") });
  step("composer opened");
  try { await comments.create({ anchor: out.anchor, text: "x" }); } catch (e) { out.create = e.code; }
  out.canSend = await comments.canSendToClaude();
  report();
  addEventListener("message", async (e) => {
    if (e.data === "range") { const r = document.createRange(); r.selectNodeContents(document.getElementById("t")); out.range = await comments.openComposer({ range: r }); report(); }
    if (e.data === "select") { getSelection().selectAllChildren(document.getElementById("p")); setTimeout(() => { const h = document.querySelector("hud-comment-pick"); out.pick = !!h && h.style.display !== "none"; report(); }, 400); }
  });
})();
</script></body></html>`;
// A page that asks for its db once: it says whether it got one.
const LATE = `<!doctype html><html><head></head><body><script>
claude.use("db").then((db) => parent.postMessage({ probe: { doc: new URLSearchParams(location.search).get("doc"), db: !!db } }, "*"));
</script></body></html>`;
// A stand-in for HUD_SAMPLE_CMD: it answers slowly, and in JSON when asked.
const MODEL = join(dir, "model.sh");
writeFileSync(MODEL, `#!/bin/sh
p=$(cat)
case "$p" in *JSON*) printf '\\x60\\x60\\x60json\\n{"ok":true}\\n\\x60\\x60\\x60'; exit 0;; esac
printf 'answer '; sleep 0.3; printf 'to: %s' "$p"
`);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}; the frame shows ${await ev(`${frame}?.getAttribute("src") ?? "no frame"`).catch(() => "?")}${await clickLog(ev)}`);
};
const post = (p: string, b: object = {}, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
const upload = (name: string, body: string) => fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name, title: name, as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body }).then((r) => r.json());
const hud = (args: string[]) => JSON.parse(Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "w1:p1", HUD_LOCAL_MACHINE: "local" }, stdout: "pipe" }).stdout.toString());
async function load(hash: string) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  await watch(ev);
}
// The HUD listens for its frames' reports from its first moment (LISTEN, in every HUD document), so a page that reports
// before the HUD has drawn is heard. After a reload only the document it loaded counts: a late report from the one
// before is not the page being tested. Every hello, report and step goes in the log a timeout prints.
const LISTEN = `if (window.top === window) {
  window.__probe = null; window.__doc = null; window.__walk ??= [];
  addEventListener("message", (e) => {
    const d = e.data || {};
    if (d["hud-page"] || d.probe || d.step) window.__walk.push({ t: Math.round(performance.now()), k: d.probe ? "probe" : d.step ? "step " + d.step : "hello", page: d.page, keys: d.probe && Object.keys(d.probe).join(",") });
    if (d.probe && (window.__doc === null || d.probe.doc === window.__doc)) window.__probe = d.probe;
  });
  document.addEventListener("load", (e) => { if (e.target.tagName === "IFRAME") e.target.dataset.loaded = e.target.getAttribute("src"); }, true);
}`;
const frame = `document.querySelector(".pageview:not([hidden]) iframe, .briefview:not([hidden]) iframe")`;
// The frame loads again, as a document the test names (?doc=), so its report is told from a late one of the last.
const fresh = `(() => { window.__probe = null; window.__doc = Math.random().toString(36).slice(2); const f = ${frame}; const u = new URL(f.getAttribute("src"), location.href); u.searchParams.set("doc", window.__doc); f.src = u.pathname + u.search; return true; })()`;
// Only once it has loaded what it was asked for: a navigation asked for while the frame's first is still on its way
// can be dropped (Chrome moves the frame into a process of its own just then), and the old document stays.
async function freshFrame() {
  await until(`${frame}?.dataset.loaded === ${frame}?.getAttribute("src")`, 25_000);
  await ev(fresh);
}
async function reloadFrame(ready = "window.__probe?.sizes?.length") {
  await freshFrame();
  await until(`!!(${ready})`, 25_000); // a page in a cold browser on a loaded machine can take a while
  return ev(`window.__probe`);
}
let brief = 0, pollBrief = 0;

beforeAll(async () => {
  if (!chromeFound) return;
  online = await fetch("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/package.json", { signal: AbortSignal.timeout(4000) }).then((r) => r.ok, () => false);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "Tester", HUD_SAMPLE_CMD: `sh ${MODEL}` } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await upload("app.html", APP);
  await upload("forge.html", FORGE);
  await upload("save.html", SAVE);
  await upload("flood.html", FLOOD);
  await upload("poll.html", POLL);
  await upload("room.html", ROOM);
  await upload("ask.html", ASK);
  await upload("quote.html", QUOTE);
  await upload("late.html", LATE);
  brief = (await post("/api/briefs", { title: "Votes", body: APP }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  pollBrief = (await post("/api/briefs", { title: "Poll", body: POLL }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: LISTEN });
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
    memo: true, sample: "function", artifact: "function", frozen: true,
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
  expect(p).toEqual({ doc: p.doc, otherPage: "silent", ownPage: "answered", nested: "silent" });
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

test.skipIf(!chromeFound)("artifact.publish: the page saves itself as a new version and the view reloads to it, as a room's page and as a brief", async () => {
  for (const [hash, src, file] of [["#page/rooms/pricing/files/poll.html", "/rooms/pricing/files/poll.html", join(dir, "rooms", "pricing", "files", "poll.html")], [`#brief/${pollBrief}`, `/briefs/${pollBrief}.html`, null]]) {
    await load(hash!);
    await until(`${frame}?.getAttribute("src")?.split("?")[0] === "${src}"`);
    await until(`window.__probe?.n === 1`, 15_000);
    expect(await ev(`window.__probe`)).toMatchObject({ n: 1 });
    if (file) expect(readFileSync(file, "utf8")).toContain('<p id="n">1</p>');
    else expect(await (await fetch(`${server.base}${src}`)).text()).toContain('<p id="n">1</p>');
  }
}, 60_000);

test.skipIf(!chromeFound)("room: two HUD tabs on one page see each other, hear each other's moments, and hear a lane", async () => {
  const other = await newSession(chrome.cdp, errors);
  const listen = `window.__probe = null; addEventListener("message", (e) => { if (e.data?.probe) window.__probe = e.data.probe; }), true`;
  await load("#page/rooms/pricing/files/room.html");
  await other.s("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await other.s("Page.navigate", { url: `${server.base}/` });
  for (let i = 0; i < 100 && !(await other.evaluate(`!!document.getElementById("lastNote")?.innerHTML`).catch(() => false)); i++) await Bun.sleep(50);
  await other.evaluate(listen);
  await other.evaluate(`location.hash = "#page/rooms/pricing/files/room.html"; true`);
  const both = async (expr: string) => {
    await until(expr, 10_000);
    for (let i = 0; i < 200 && !(await other.evaluate(expr).catch(() => false)); i++) await Bun.sleep(50);
    expect(await other.evaluate(expr)).toBe(true);
  };
  await both(`window.__probe?.others === 1 && window.__probe?.presence === 2 && window.__probe?.game === "game"`);
  await both(`window.__probe?.heard.some((h) => h[0] === "hello" && h[1] === "viewer" && h[3] === false)`);
  expect(await ev(`window.__probe.connected`)).toBe(true);
  const said = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "page", "room", "rooms/pricing/files/room.html", "emit", "ping", '"from pm"'], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "w1:p2", HUD_LOCAL_MACHINE: "local" }, stdout: "pipe" });
  expect(said.stdout.toString()).toContain("heard by 2");
  await both(`window.__probe?.heard.some((h) => h[0] === "from pm" && h[1] === "agent" && h[2] === "pm")`);
  // the other tab leaves: this one sees it go
  await other.s("Page.navigate", { url: "about:blank" });
  await until(`window.__probe?.others === 0`, 10_000);
}, 60_000);

test.skipIf(!chromeFound)("sample: the owner allows the page once, and the answers stream back; a view the owner refuses gets not_granted", async () => {
  await load("#page/rooms/pricing/files/ask.html");
  await until(`document.querySelector(".pr-save")?.textContent.includes("ask a model")`, 10_000);
  await ev(`document.querySelector(".pr-save .pr-yes").click()`);
  await until(`!!window.__probe?.json`, 15_000);
  const p = await ev(`window.__probe`);
  expect(p).toMatchObject({ first: "answer to: hello", json: { ok: true } });
  expect(p.texts.at(-1)).toBe("answer to: hello");
  expect(p.texts.length).toBeGreaterThan(0);
  expect(await ev(`!!document.querySelector(".pr-save")`)).toBe(false); // asked once for the view
  // a new view of the page asks again; NO holds for both calls
  await freshFrame();
  await until(`!!document.querySelector(".pr-save")`, 10_000);
  await ev(`document.querySelector(".pr-save .pr-no").click()`);
  await until(`!!window.__probe?.json`, 10_000);
  expect(await ev(`window.__probe`)).toMatchObject({ first: "not_granted", json: "not_granted" });
}, 60_000);

test.skipIf(!chromeFound)("comments: the page opens its thread in the HUD with a quote (an element, a range); a selection shows COMMENT", async () => {
  const key = "rooms/pricing/files/quote.html";
  const thread = `document.querySelector('aside.cmount[data-comments="${key}"]')`;
  await load(`#page/${key}`);
  await until(`!!window.__probe?.element`, 10_000);
  expect(await ev(`window.__probe`)).toMatchObject({ element: { opened: true }, anchor: { path: "#p", x: 0, y: 0 }, create: "not_granted", canSend: "off" });
  await until(`${thread}?.textContent.includes("Tier two costs forty a month.")`);
  await ev(`${frame}.contentWindow.postMessage("range", "*"), true`);
  await until(`window.__probe?.range?.opened === true`);
  await until(`${thread}?.textContent.includes("Pricing")`);
  await ev(`${frame}.contentWindow.postMessage("select", "*"), true`);
  await until(`window.__probe?.pick !== undefined`);
  expect(await ev(`window.__probe.pick`)).toBe(true);
}, 30_000);

test.skipIf(!chromeFound)("a page the HUD answers late keeps asking: it gets its runtime when the answer comes, however late", async () => {
  // a busy HUD: while __hold is set, no hello reaches its page runtime (this listener comes before the HUD's)
  const { identifier } = await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("message", (e) => { if (window.__hold && e.data?.["hud-page"] === "hello") e.stopImmediatePropagation(); })` });
  try {
    await load("#page/rooms/pricing/files/late.html");
    await until(`${frame}?.getAttribute("src")?.split("?")[0] === "/rooms/pricing/files/late.html"`);
    await ev(`window.__hold = true`);
    await freshFrame();
    await Bun.sleep(11_000); // longer than a page once waited before it gave up
    expect(await ev(`window.__probe`)).toBe(null);
    await ev(`window.__hold = false`);
    await until(`!!window.__probe`, 5000);
    expect(await ev(`window.__probe.db`)).toBe(true);
  } finally {
    await page.s("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }
}, 30_000);

test.skipIf(!chromeFound)("opened on its own (OPEN IN NEW TAB): its stored keys are there, use() gives null", async () => {
  await page.s("Page.navigate", { url: `${server.base}/briefs/${brief}.html` });
  await until(`document.readyState === "complete"`);
  const r = await ev(`(async () => ({ db: await claude.use("db"), user: await hud.use("user"), note: localStorage.getItem("note") }))()`);
  expect(r).toEqual({ db: null, user: null, note: "kept" });
}, 30_000);

test.skipIf(!chromeFound)("no page errors", () => {
  expect(errors.filter((e) => !/Blocked script execution|Content Security Policy|Failed to load resource|SecurityError|sandbox|has not answered this page yet/i.test(e))).toEqual([]);
});
