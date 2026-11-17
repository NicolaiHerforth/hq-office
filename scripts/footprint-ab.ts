// Two or more trees' office page in one headless Chrome, visited in turn, so that the machine's load and Chrome's own
// state fall on every tree alike: per stretch, the frames presented and the CPU of Chrome's renderers and GPU process
// (from Chrome's process table), and the page's own main-thread time. docs/footprint.md has the method.
//
//   bun scripts/footprint-ab.ts SEED SECONDS ROUNDS LABEL=TREE ...      (SEED from `bun scripts/footprint.ts seed DIR`)
//
// Each tree gets a server of its own on a copy of SEED, PERFORMANCE SMOOTH, and the same stub herdr. No load is made.
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "./footprint.ts";
import { Cdp, findChrome } from "./room-hash.ts";

const [seed, secondsArg, roundsArg, ...trees] = process.argv.slice(2);
if (!trees.length) { console.error("bun scripts/footprint-ab.ts SEED SECONDS ROUNDS LABEL=TREE ..."); process.exit(2); }
const SECONDS = Number(secondsArg), ROUNDS = Number(roundsArg);
const SCRATCH = process.env.FOOTPRINT_TMP ?? "/tmp";
const fresh = (name: string) => mkdtempSync(join(SCRATCH, `footprint-ab-${name}-`));

const herdrDir = fresh("herdr");
const lanes = Array.from({ length: 26 }, (_, i) => `lane-${String(i + 1).padStart(2, "0")}`);
writeFileSync(join(herdrDir, "agents.json"), JSON.stringify({ result: { agents: [{ name: "hq", agent_status: "idle", pane_id: "w1:p99", agent: "claude" }, ...lanes.map((name, i) => ({ name, agent_status: i < 7 ? "working" : i < 25 ? "done" : "idle", pane_id: `w1:p${i}`, agent: "claude" }))] } }));
const herdr = join(herdrDir, "herdr");
writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) cat ${JSON.stringify(join(herdrDir, "agents.json"))} ;;\n  *"pane list"*) echo '{"result":{"panes":[]}}' ;;\n  *"machine list"*) echo '[]' ;;\n  *) exit 0 ;;\nesac\n`);
chmodSync(herdr, 0o755);

const servers: { label: string; base: string; stop: () => Promise<void> }[] = [];
for (const t of trees) {
  const [label, tree] = t.split("=");
  const data = fresh(`data-${label}`);
  cpSync(seed, data, { recursive: true });
  const s = await startServer(resolve(tree), data, herdr);
  await fetch(`${s.base}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ settings: { performance: "smooth" } }) });
  servers.push({ label, base: s.base, stop: s.stop });
}

const profile = fresh("chrome");
const chrome = spawn(findChrome()!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--window-size=1440,900", "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-sync", "--disable-extensions", "about:blank"], { detached: true, stdio: "ignore" });
const end = () => { try { process.kill(-chrome.pid!, "SIGKILL"); } catch {} };
process.on("exit", end);
let port = "";
for (let i = 0; i < 100 && !port; i++) { try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {} if (!port) await Bun.sleep(100); }
const cdp = await Cdp.open((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
for (const d of ["Page", "Runtime", "Performance"]) await s(`${d}.enable`);
await s("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { window.__frames = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (fn) => raf((t) => { window.__frames++; fn(t); }); })();` });
const ev = async (e: string) => (await s("Runtime.evaluate", { expression: e, returnByValue: true })).result?.value;
const procs = async () => (await cdp.send("SystemInfo.getProcessInfo")).processInfo as { type: string; id: number; cpuTime: number }[];
const metrics = async () => Object.fromEntries(((await s("Performance.getMetrics")).metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]));

// Chrome's own start-up work is over before the first stretch.
await Bun.sleep(15_000);
const rows: Record<string, { rg: number[]; tasks: number[]; fps: number[] }> = Object.fromEntries(servers.map((x) => [x.label, { rg: [], tasks: [], fps: [] }]));
const loads: number[] = [];
for (let r = 0; r < ROUNDS; r++) {
  // Each round in another order, so no tree always follows the same one.
  const order = r % 2 ? [...servers].reverse() : servers;
  for (const srv of order) {
    await s("Page.navigate", { url: `${srv.base}/` });
    for (let i = 0; i < 100 && !(await ev(`!!document.querySelector("#hud") && window.__frames > 5`)); i++) await Bun.sleep(100);
    await Bun.sleep(6000); // fonts, the first sync, the workers reaching their desks
    const a = { p: await procs(), m: await metrics(), f: await ev("window.__frames"), at: Date.now() };
    await Bun.sleep(SECONDS * 1000);
    const b = { p: await procs(), m: await metrics(), f: await ev("window.__frames"), at: Date.now() };
    const secs = (b.at - a.at) / 1000;
    const cpu = (type: string) => (b.p.filter((p) => p.type === type).reduce((n, p) => n + p.cpuTime - (a.p.find((q) => q.id === p.id)?.cpuTime ?? 0), 0) / secs) * 100;
    rows[srv.label].rg.push(cpu("renderer") + cpu("GPU"));
    rows[srv.label].tasks.push(((b.m.TaskDuration - a.m.TaskDuration) / secs) * 100);
    rows[srv.label].fps.push((b.f - a.f) / secs);
    loads.push(loadavg()[0]);
    console.error(`round ${r + 1} ${srv.label}: ${(cpu("renderer") + cpu("GPU")).toFixed(2)}% (renderer ${cpu("renderer").toFixed(2)}, GPU ${cpu("GPU").toFixed(2)}), tasks ${(((b.m.TaskDuration - a.m.TaskDuration) / secs) * 100).toFixed(2)}%, ${((b.f - a.f) / secs).toFixed(1)} fps, load ${loadavg()[0].toFixed(1)}`);
  }
}
const median = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
const out = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { rendererAndGpuPct: { median: +median(v.rg).toFixed(2), all: v.rg.map((x) => +x.toFixed(2)) }, mainThreadPct: +median(v.tasks).toFixed(2), fps: +median(v.fps).toFixed(1) }]));
console.log(JSON.stringify({ seconds: SECONDS, rounds: ROUNDS, load: { min: Math.min(...loads).toFixed(1), max: Math.max(...loads).toFixed(1) }, ...out }, null, 1));
cdp.ws.close();
end();
for (const srv of servers) await srv.stop();
process.exit(0);
