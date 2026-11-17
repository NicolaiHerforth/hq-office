// SMOOTH's floor: the office page in headless Chrome on a throwaway server, PERFORMANCE SMOOTH, with the room's
// drawing switched from outside, one stretch each: the room as it is, nothing painted, one 3 by 3 square changed
// each frame on today's canvas, on the canvas at 1x, and on a 3x overlay over a still 1x canvas. Renderer and GPU
// CPU from Chrome's own process table. docs/footprint.md, "SMOOTH", has what it found.
//   bun scripts/footprint-floor.ts REPO SEED SECONDS [NAME-PREFIX ...]      (FOOTPRINT_TMP: where its folders go)
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [repo, seed, secondsArg, ...only] = process.argv.slice(2);
const SECONDS = Number(secondsArg);
const { startServer } = await import(join(repo, "scripts/footprint.ts"));
const { Cdp, findChrome } = await import(join(repo, "scripts/room-hash.ts"));
const T = process.env.FOOTPRINT_TMP!;
const data = mkdtempSync(join(T, "lab-data-"));
cpSync(seed, data, { recursive: true });
const server = await startServer(repo, data, join(data, "no-herdr"));
await fetch(`${server.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ settings: { performance: "smooth" } }) });
const profile = mkdtempSync(join(T, "lab-chrome-"));
const chrome = spawn(findChrome()!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=1440,900", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--disable-extensions", "about:blank"], { detached: true, stdio: "ignore" });
process.on("exit", () => { try { process.kill(-chrome.pid!, "SIGKILL"); } catch {} });
let port = "";
for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {} if (!port) await Bun.sleep(100); }
const cdp = await Cdp.open((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
for (const d of ["Page", "Runtime", "Performance"]) await s(`${d}.enable`);
// The lab's switch, there from the page's first script: what the room's painting calls do.
await s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const L = (window.__lab = { mode: "full", frames: 0, calls: 0, flip: 0 });
  const P = CanvasRenderingContext2D.prototype, real = {};
  for (const k of ["fillRect", "drawImage", "clearRect", "fillText", "strokeText", "stroke", "fill"]) {
    real[k] = P[k];
    P[k] = function () {
      if (this.canvas.id !== "room") return real[k].apply(this, arguments);
      L.calls++;
      if (L.mode === "none" || L.mode === "one") return;
      // Only what a frame that moves nothing but the weather would paint: the small squares.
      if (L.mode === "small" && !(k === "fillRect" && arguments[2] <= 6 && arguments[3] <= 6)) return;
      return real[k].apply(this, arguments);
    };
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => {
    L.frames++;
    fn(t);
    if (L.mode === "one") { const c = L.target || document.getElementById("room"); if (c) { const g = c.getContext("2d"); g.fillStyle = (L.flip ^= 1) ? "#000" : "#111"; real.fillRect.call(g, 0, 0, 3, 3); } }
  });
})();` });
// How many frames paint exactly what the frame before painted, and what differs when they differ: each painting call
// of a frame as text (its name, its numbers, the fill colour, the alpha, the image's size), compared with the frame before.
await s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
  const S = (window.__sig = { on: false, frames: 0, same: 0, cur: [], last: null, diffs: {}, ops: 0, sizes: {} });
  const P = CanvasRenderingContext2D.prototype;
  const ids = new WeakMap(); let next = 0;
  const idOf = (o) => { let i = ids.get(o); if (i === undefined) ids.set(o, (i = next++)); return i; };
  for (const k of ["fillRect", "drawImage", "clearRect", "fillText", "strokeText", "stroke", "fill", "ellipse", "beginPath"]) {
    const f = P[k];
    P[k] = function (...a) {
      if (S.on && this.canvas.id === "room") S.cur.push(k + ":" + a.map((x) => (typeof x === "object" && x ? "img" + idOf(x) + "/" + x.width + "x" + x.height : x)).join(",") + ":" + (k === "drawImage" ? this.globalAlpha : this.fillStyle + "/" + this.globalAlpha + "/" + this.font));
      return f.apply(this, a);
    };
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => {
    fn(t);
    if (!S.on || !S.cur.length) return;
    S.frames++; S.ops += S.cur.length;
    if (S.last && S.last.length === S.cur.length && S.last.every((x, i) => x === S.cur[i])) S.same++;
    else if (S.last) { const was = new Set(S.last); let n = 0; for (const x of S.cur) if (!was.has(x)) { n++; const kind = x.split(":")[0] + (x.includes("img") ? " " + x.split("/")[1].split(":")[0].split(",")[0] : ""); S.diffs[kind] = (S.diffs[kind] || 0) + 1; } S.sizes[Math.min(n, 20)] = (S.sizes[Math.min(n, 20)] || 0) + 1; }
    S.last = S.cur; S.cur = [];
  });
})();` });
await s("Page.navigate", { url: `${server.base}/` });
const ev = async (expression: string) => (await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
for (let i = 0; i < 100 && !(await ev(`!!document.querySelector("#hud") && window.__lab.frames > 5`)); i++) await Bun.sleep(100);
await Bun.sleep(20000);
const procs = async () => (await cdp.send("SystemInfo.getProcessInfo")).processInfo as { type: string; id: number; cpuTime: number }[];
const metrics = async () => Object.fromEntries(((await s("Performance.getMetrics")).metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]));
async function stretch(name: string) {
  await Bun.sleep(2500);
  const a = { p: await procs(), m: await metrics(), c: JSON.parse(await ev("JSON.stringify(window.__lab)")), at: Date.now() };
  await Bun.sleep(SECONDS * 1000);
  const b = { p: await procs(), m: await metrics(), c: JSON.parse(await ev("JSON.stringify(window.__lab)")), at: Date.now() };
  const secs = (b.at - a.at) / 1000;
  const cpu = (type: string) => (b.p.filter((p) => p.type === type).reduce((n, p) => n + p.cpuTime - (a.p.find((q) => q.id === p.id)?.cpuTime ?? 0), 0) / secs) * 100;
  const d = (k: string) => ((b.m[k] - a.m[k]) / secs) * 100;
  console.log(`${name.padEnd(46)} ${((b.c.frames - a.c.frames) / secs).toFixed(1).padStart(5)} fps ${String(Math.round((b.c.calls - a.c.calls) / secs)).padStart(6)} calls/s | renderer ${cpu("renderer").toFixed(2).padStart(5)}%  gpu ${cpu("GPU").toFixed(2).padStart(5)}%  = ${(cpu("renderer") + cpu("GPU")).toFixed(2).padStart(5)}% | tab tasks ${d("TaskDuration").toFixed(2)}% script ${d("ScriptDuration").toFixed(2)}% | browser ${cpu("browser").toFixed(2)}%`);
}
if (only[0] === "sig") {
  await ev(`(window.__sig.on = true)`);
  await Bun.sleep(SECONDS * 1000);
  const r = JSON.parse(await ev(`JSON.stringify({ frames: __sig.frames, same: __sig.same, ops: __sig.ops, diffs: __sig.diffs, sizes: __sig.sizes })`));
  console.log(`frames ${r.frames}, the same as the one before: ${r.same} (${((r.same / r.frames) * 100).toFixed(1)}%), painting calls a frame ${(r.ops / r.frames).toFixed(0)}`);
  console.log("calls that differ from the frame before, by kind:", JSON.stringify(r.diffs));
  console.log("how many calls differ in a frame that differs (20 = 20 or more):", JSON.stringify(r.sizes));
  cdp.ws.close(); try { process.kill(-chrome.pid!, "SIGKILL"); } catch {} await server.stop(); process.exit(0);
}
const style = (css: string) => ev(`(window.__lab.mode = "one", document.getElementById("room").style.cssText = ${JSON.stringify(css)}, true)`);
// The 1x design's floor: the room's canvas at 384 x 256 (its art painted once, then still), and over it a 1152 x 768
// canvas shown at the same size, where one square changes each frame.
const ONE_X = `(() => { const c = document.getElementById("room"); const g = c.getContext("2d"); const keep = document.createElement("canvas"); keep.width = c.width; keep.height = c.height; keep.getContext("2d").drawImage(c, 0, 0); c.width = 384; c.height = 256; const g2 = c.getContext("2d"); g2.imageSmoothingEnabled = false; g2.drawImage(keep, 0, 0, 384, 256); return true; })()`;
const OVERLAY = `(() => { const c = document.getElementById("room"); const o = document.createElement("canvas"); o.id = "lab-overlay"; o.width = 1152; o.height = 768; const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect(); o.style.cssText = "position:absolute; image-rendering: pixelated; pointer-events: none; left:" + (r.left - p.left) + "px; top:" + (r.top - p.top) + "px; width:" + r.width + "px; height:" + r.height + "px"; c.parentElement.style.position = "relative"; c.parentElement.append(o); window.__lab.target = o; return true; })()`;
const MODES: Record<string, () => Promise<unknown>> = {
  "F1 one square, 3x canvas (today's size)": () => ev(`window.__lab.mode = "one"`),
  "F2 nothing painted": () => ev(`window.__lab.mode = "none"`),
  "F3 one square, the canvas at 1x": async () => { await ev(`window.__lab.mode = "none"`); await ev(ONE_X); await ev(`window.__lab.mode = "one"`); },
  "F4 static 1x canvas, one square on a 3x overlay": async () => { await ev(`window.__lab.mode = "none"`); await ev(OVERLAY); await ev(`window.__lab.mode = "one"`); },
  "F5 static 1x canvas and the overlay, nothing changes": () => ev(`window.__lab.mode = "none"`),
  "s0 one square, as styled": () => style(""),
  "s1 one square, a layer of its own": () => style("will-change: transform"),
  "s2 one square, square corners": () => style("border-radius: 0"),
  "s3 one square, smooth scaling": () => style("image-rendering: auto"),
  "s4 one square, contain: strict": () => style("contain: strict; aspect-ratio: 3 / 2"),
  "s5 one square, square corners and own layer": () => style("border-radius: 0; will-change: transform"),
  "s6 one square, as styled again": () => style(""),
  "s7 one square, the questions column hidden": async () => { await style(""); await ev(`(document.querySelector(".qwrap").style.display = "none", true)`); },
  "s8 one square, only the room on the page": async () => { await ev(`(document.querySelectorAll("body > *").forEach((e) => { if (!e.contains(document.getElementById("room"))) e.style.display = "none"; }), document.querySelector(".qwrap").style.display = "", true)`); },
  "A full": () => ev(`window.__lab.mode = "full"`),
  "B small squares only": () => ev(`window.__lab.mode = "small"`),
  "C one square": () => ev(`window.__lab.mode = "one"`),
  "D nothing painted": () => ev(`window.__lab.mode = "none"`),
  "E full": () => ev(`window.__lab.mode = "full"`),
  "F small squares only": () => ev(`window.__lab.mode = "small"`),
  "G one square": () => ev(`window.__lab.mode = "one"`),
  "H nothing painted": () => ev(`window.__lab.mode = "none"`),
  "full: SMOOTH as it is": () => ev(`window.__lab.mode = "full"`),
  "none: the loop runs, nothing is painted": () => ev(`window.__lab.mode = "none"`),
  "one: one 3x3 square changes each frame": () => ev(`window.__lab.mode = "one"`),
  "full, canvas at its own size (no scaling)": () => ev(`(window.__lab.mode = "full", document.getElementById("room").style.cssText = "width: 1152px; max-width: none; height: 768px", true)`),
  "full, scaled, no rounded corners": () => ev(`(document.getElementById("room").style.cssText = "border-radius: 0", true)`),
  "full, scaled, a layer of its own": () => ev(`(document.getElementById("room").style.cssText = "will-change: transform", true)`),
  "full, back as it is": () => ev(`(document.getElementById("room").style.cssText = "", true)`),
  "saver: no frames": async () => { await fetch(`${server.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ settings: { performance: "saver" } }) }); },
};
for (const [name, set] of Object.entries(MODES)) {
  if (only.length && !only.some((o) => name.startsWith(o))) continue;
  await set();
  await stretch(name);
}
cdp.ws.close();
try { process.kill(-chrome.pid!, "SIGKILL"); } catch {}
await server.stop();
process.exit(0);
