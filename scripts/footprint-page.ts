// Measures what the page costs in the browser: headless Chrome on a throwaway server, the tab visible and idle under
// each PERFORMANCE setting, hidden, in use, and the monitor's page. Per stretch: frames drawn, the CPU of Chrome's
// processes by kind (renderer, GPU, browser) and of the server, the renderer's footprint and JS heap.
// docs/footprint.md has the method and the numbers. No load is made, and nothing is throttled.
//
//   bun scripts/footprint-page.ts SEED OUT.json [SECONDS]      (SEED from `bun scripts/footprint.ts seed DIR`)
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { readProcess, startServer } from "./footprint.ts";
import { Cdp, findChrome } from "./room-hash.ts";

const [seedDir, out, secondsArg = "60"] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const SCRATCH = process.env.FOOTPRINT_TMP ?? "/tmp";
const fresh = (name: string) => mkdtempSync(join(SCRATCH, `footprint-${name}-`));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// A herdr with HQ and the seed's 26 lanes, 7 of them working; a pane read answers a few lines.
const herdrDir = fresh("page-herdr");
const lanes = Array.from({ length: 26 }, (_, i) => `lane-${String(i + 1).padStart(2, "0")}`);
const agents = [{ name: "hq", agent_status: "idle", pane_id: "w1:p99", agent: "claude" }, ...lanes.map((name, i) => ({ name, agent_status: i < 7 ? "working" : i < 25 ? "done" : "idle", pane_id: `w1:p${i}`, agent: "claude" }))];
writeFileSync(join(herdrDir, "agents.json"), JSON.stringify({ result: { agents } }));
writeFileSync(join(herdrDir, "pane.txt"), Array.from({ length: 30 }, (_, i) => `  line ${i}: the lane printed this while it worked`).join("\n") + "\n");
const herdr = join(herdrDir, "herdr");
writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) cat ${JSON.stringify(join(herdrDir, "agents.json"))} ;;\n  *"pane read"*) cat ${JSON.stringify(join(herdrDir, "pane.txt"))} ;;\n  *"pane list"*) echo '{"result":{"panes":[]}}' ;;\n  *"machine list"*) echo '[]' ;;\n  *"process-info"*) echo '{"result":{"process_info":{"shell_pid":${process.pid}}}}' ;;\n  *) exit 0 ;;\nesac\n`);
chmodSync(herdr, 0o755);

const data = fresh("page-data");
cpSync(seedDir, data, { recursive: true });
const server = await startServer(join(import.meta.dir, ".."), data, herdr, { HUD_MONITOR: "1" });
const post = (p: string, b: object) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());

// Chrome as a person's Chrome behaves when a tab is hidden: no flag that keeps background timers or renderers awake.
const profile = fresh("page-chrome");
const chrome = spawn(findChrome()!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=1440,900", "about:blank"], { detached: true, stdio: "ignore" });
const endChrome = () => { try { process.kill(-chrome.pid!, "SIGKILL"); } catch {} };
process.on("exit", endChrome);
let port = "";
for (let i = 0; i < 100 && !port; i++) {
  try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {}
  if (!port) await Bun.sleep(100);
}
const cdp = await Cdp.open((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);

// Counts the frames the page asks for and the canvas calls it makes, from the page's first script on.
const COUNT = `(() => {
  const c = (window.__fp = { frames: 0, draws: 0 });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => { c.frames++; fn(t); });
  const P = CanvasRenderingContext2D.prototype;
  for (const k of ["fillRect", "drawImage", "clearRect", "fillText", "stroke"]) { const f = P[k]; P[k] = function () { c.draws++; return f.apply(this, arguments); }; }
})();`;
async function tab(url: string) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
  for (const d of ["Page", "Runtime", "Performance"]) await s(`${d}.enable`);
  await s("Page.addScriptToEvaluateOnNewDocument", { source: COUNT });
  await s("Page.navigate", { url });
  const ev = async (expression: string) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { targetId, s, ev, show: () => cdp.send("Target.activateTarget", { targetId }) };
}

// Chrome's processes by kind, with their CPU so far (seconds) and their pids.
const processes = async () => (await cdp.send("SystemInfo.getProcessInfo")).processInfo as { type: string; id: number; cpuTime: number }[];
async function reading(page: Awaited<ReturnType<typeof tab>>) {
  const procs = await processes();
  const metrics = Object.fromEntries(((await page.s("Performance.getMetrics")).metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]));
  const counts = (await page.ev("JSON.stringify(window.__fp)").then((v) => JSON.parse(v ?? "{}"))) as { frames: number; draws: number };
  return { at: Date.now(), procs, metrics, counts, server: readProcess(server.pid)! };
}
async function stretch(name: string, page: Awaited<ReturnType<typeof tab>>, during: () => Promise<void> = () => Bun.sleep(SECONDS * 1000)) {
  const a = await reading(page);
  await during();
  const b = await reading(page);
  const secs = (b.at - a.at) / 1000;
  const cpu = (type: string) => round((b.procs.filter((p) => p.type === type).reduce((n, p) => n + p.cpuTime - (a.procs.find((q) => q.id === p.id)?.cpuTime ?? 0), 0) / secs) * 100, 2);
  const renderer = b.procs.filter((p) => p.type === "renderer").map((p) => readProcess(p.id)?.footprint ?? 0);
  const gpu = b.procs.filter((p) => p.type === "GPU").map((p) => readProcess(p.id)?.footprint ?? 0);
  const d = (k: string) => round(((b.metrics[k] - a.metrics[k]) / secs) * 100, 2);
  const row = {
    name,
    seconds: round(secs),
    visibility: await page.ev("document.visibilityState"),
    framesPerSec: round((b.counts.frames - a.counts.frames) / secs),
    canvasCallsPerSec: Math.round((b.counts.draws - a.counts.draws) / secs),
    cpuPct: { renderers: cpu("renderer"), gpu: cpu("GPU"), browser: cpu("browser"), other: round(cpu("utility") + cpu("network"), 2), server: round(((b.server.own - a.server.own) / (secs * 1000)) * 100, 2), serverKids: round(((b.server.kids - a.server.kids) / (secs * 1000)) * 100, 2) },
    thisTabPct: { tasks: d("TaskDuration"), script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration") },
    jsHeapMb: round(b.metrics.JSHeapUsedSize / 1048576),
    nodes: b.metrics.Nodes,
    footprintMb: { renderers: renderer.map((x) => round(x)), gpu: gpu.map((x) => round(x)), server: round(b.server.footprint) },
    load1: round(loadavg()[0]),
  };
  console.error(JSON.stringify(row));
  return row;
}

const rows: unknown[] = [];
const hud = await tab(`${server.base}/`);
for (let i = 0; i < 100 && !(await hud.ev(`!!document.querySelector("#hud") && !!window.__fp && window.__fp.frames > 0`)); i++) await Bun.sleep(100);
await Bun.sleep(5000); // fonts, the first sync, the workers walking to their desks
for (const performance of ["smooth", "balanced", "saver"]) {
  await post("/api/settings", { settings: { performance } });
  await Bun.sleep(8000);
  rows.push(await stretch(`office, visible, idle, PERFORMANCE ${performance}`, hud));
}
await post("/api/settings", { settings: { performance: "smooth" } });
await Bun.sleep(3000);

// In use: the pointer crosses the room, a worker's card is opened (it reads its lane's pane every 3 s) and closed.
const spot = JSON.parse(await hud.ev(`(async () => {
  const { workers } = await import("/src/client/room/workers.js");
  const { TS, SC, cv } = await import("/src/client/room/canvas.js");
  const r = cv.getBoundingClientRect(), k = r.width / cv.width, w = [...workers.values()].find((w) => !w.path.length) ?? [...workers.values()][0];
  return JSON.stringify({ x: r.left + (w.x * TS + 8) * SC * k, y: r.top + (w.y * TS + 4) * SC * k, left: r.left, top: r.top, width: r.width, height: r.height });
})()`));
const mouse = (type: string, x: number, y: number, extra: object = {}) => hud.s("Input.dispatchMouseEvent", { type, x, y, ...extra });
rows.push(await stretch("office, visible, in use (pointer over the room, a card opened and closed), smooth", hud, async () => {
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    for (let i = 0; i < 40 && Date.now() < until; i++) { await mouse("mouseMoved", spot.left + (spot.width * (i + 1)) / 42, spot.top + spot.height * (0.3 + 0.4 * Math.sin(i / 6))); await Bun.sleep(50); }
    await mouse("mouseMoved", spot.x, spot.y);
    await mouse("mousePressed", spot.x, spot.y, { button: "left", clickCount: 1 });
    await mouse("mouseReleased", spot.x, spot.y, { button: "left", clickCount: 1 });
    await Bun.sleep(Math.max(0, Math.min(7000, until - Date.now())));
    await hud.s("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await hud.s("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await Bun.sleep(Math.max(0, Math.min(1000, until - Date.now())));
  }
}));

// Hidden: another tab is brought to the front, as when the owner works in another tab of the same window.
const other = await tab("about:blank");
await other.show();
await Bun.sleep(3000);
rows.push(await stretch("office, hidden (another tab in front), smooth", hud));

// The monitor's page, visible, with the office tab still open behind it.
const monitor = await tab(`${server.base}/monitor`);
await monitor.show();
await Bun.sleep(15000);
rows.push(await stretch("monitor page, visible, idle (office tab hidden behind it)", monitor));
await hud.show();
await Bun.sleep(3000);
rows.push(await stretch("office visible again, monitor page hidden behind it", hud));

writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, chrome: (await cdp.send("Browser.getVersion")).product, rows }, null, 2));
cdp.ws.close();
endChrome();
await server.stop();
await Bun.sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
