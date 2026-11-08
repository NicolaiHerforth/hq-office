// Times one answer from the press to every sign of it on the page (toast, card gone, count), on a throwaway server
// seeded like a busy installation, for a desktop at 1280, a phone at 390 over 120 ms, and a slow phone (4x CPU, 300 ms,
// 1.6 Mbps), taken in turn. Latency is a delay proxy (both ways, every chunk of the stream); no load is made.
// bun scripts/answer-speed.ts TREE LABEL TRIALS [SEED_DIR]: TREE is the checkout to run (this one, or an export of
// another commit); without SEED_DIR it seeds one and prints where it kept it, for the next run to start from.
// Writes result-LABEL.json in the current folder. Needs Chrome. One run at a time, under load 30.
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const [repo, label = "run", trialsArg = "7"] = process.argv.slice(2);
const TRIALS = Number(trialsArg);
const { spawnServer, startChrome } = await import(join(repo, "scripts/room-hash.ts"));
const { fakeHerdr } = await import(join(repo, "test/fake-herdr.ts"));

const load = () => execSync("uptime").toString().trim().replace(/.*load averages?: /, "");
const log: any = { label, repo, loadStart: load(), started: new Date().toISOString() };
console.error(`[${label}] load at start ${log.loadStart}`);

const data = mkdtempSync(join(tmpdir(), "answer-speed-data-"));
const subs = mkdtempSync(join(tmpdir(), "answer-speed-subs-"));
const herdrDir = mkdtempSync(join(tmpdir(), "answer-speed-herdr-"));
const LANES = Array.from({ length: 25 }, (_, i) => `lane-${String(i + 1).padStart(2, "0")}`);
let server: any;
const env = (herdr: string) => ({
  ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HUD_SUBS_HOME: subs, HERDR_BIN: herdr, HUD_OWNER: "Tester",
  HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_GH_BIN: join(data, "no-gh"),
});

const post = (base: string, p: string, b: object) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
const para = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: the lane checked the branch, ran the suite and found the cause in the outbox. See WRK-${4000 + i}.`).join("\n\n");
const seedDir = process.argv[5];
if (seedDir) execSync(`cp -R ${JSON.stringify(seedDir)}/. ${JSON.stringify(data)}/`);
else {
// Seed through the API with no herdr, so nothing is typed anywhere; then mark the outboxes sent.
server = await spawnServer({ cwd: repo, env: env(join(data, "no-herdr")) });
const P = (p: string, b: object) => post(server.base, p, b);
for (const [i, name] of LANES.entries()) await P("/api/lanes", { name, phase: ["running", "waiting", "parked", "done"][i % 4], title: `Work item ${i}`, machine: "local" });
for (let i = 0; i < 30; i++) await P("/api/board/track", { issue: `WRK-${4000 + i}`, lane: LANES[i % 25] });
for (let i = 0; i < 100; i++) await P("/api/briefs", { title: `Brief ${i}: findings on WRK-${4000 + (i % 30)}`, body: `# Brief ${i}\n\n${para(12)}` });
for (let i = 0; i < 800; i++) await P("/api/events", { who: "hq", text: `event ${i}: lane moved on WRK-${4000 + (i % 30)}`, lane: LANES[i % 25] });
for (let i = 0; i < 40; i++) await P("/api/updates", { title: `Update ${i}`, body: para(2), lane: LANES[i % 25] });
for (let i = 0; i < 20; i++) await P("/api/notes", { text: `note ${i} to HQ` });
for (let i = 0; i < 480; i++) {
  const { id } = await P("/api/asks", { lane: LANES[i % 25], kind: ["decision", "action", "info"][i % 3], title: `Old question ${i} about WRK-${4000 + (i % 30)} and #${100 + i}`, body: para(2), options: i % 3 === 0 ? ["Yes", "No"] : undefined });
  await P(`/api/asks/${id}/answer`, { answer: i % 2 ? "Yes" : "done" });
}
await server.stop();
const db = new Database(join(data, "hud.db"));
db.run("UPDATE hq_outbox SET sent_at = ?, confirmed_at = ? WHERE sent_at IS NULL", [Date.now(), Date.now()]);
db.close();
const keep = mkdtempSync(join(tmpdir(), "answer-speed-seed-"));
execSync(`cp -R ${JSON.stringify(data)}/. ${JSON.stringify(keep)}/`);
console.error(`[${label}] seed kept in ${keep}`);
log.seed = keep;
}
fakeHerdr(herdrDir, [{ name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" }, ...LANES.map((name, i) => ({ name, agent_status: i % 3 ? "idle" : "working", pane_id: `p-${i}`, agent: "claude" }))]);
server = await spawnServer({ cwd: repo, env: env(join(herdrDir, "herdr")) });
const base = server.base;
const openAsk = (n: number) => post(base, "/api/asks", { lane: LANES[n % 25], kind: "action", title: `Restart the runner for WRK-${4000 + (n % 30)}`, body: para(2) });
for (let i = 0; i < 6; i++) await openAsk(i);

// The state the page holds, and how long the server takes to build it.
const sizes: number[] = [], builds: number[] = [];
for (let i = 0; i < 5; i++) { const t = performance.now(); const s = await (await fetch(`${base}/api/state`)).text(); builds.push(performance.now() - t); sizes.push(s.length); }
log.stateBytes = sizes[0];
log.stateMs = builds;
const st = await (await fetch(`${base}/api/state`)).json();
log.partBytes = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, JSON.stringify(v).length]).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8));

// A phone over the internet: every chunk waits oneWay ms in each direction. Timers only, no CPU.
function delayProxy(oneWay: number) {
  return Bun.listen<{ up?: any; q: Buffer[] }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(client) {
        client.data = { q: [] };
        Bun.connect({ hostname: "127.0.0.1", port: server.port, socket: {
          open(up) { client.data.up = up; for (const b of client.data.q) setTimeout(() => up.write(b), oneWay); client.data.q = []; },
          data(_up, chunk) { const b = Buffer.from(chunk); setTimeout(() => client.write(b), oneWay); },
          close() { setTimeout(() => client.end(), oneWay); },
        } });
      },
      data(client, chunk) { const b = Buffer.from(chunk); if (client.data.up) setTimeout(() => client.data.up.write(b), oneWay); else client.data.q.push(b); },
      close(client) { setTimeout(() => client.data.up?.end(), oneWay); },
    },
  });
}
const proxy = delayProxy(60), slowProxy = delayProxy(150);

const INSTRUMENT = `(() => {
  const M = (window.__m = { marks: [], msgs: [], watch: null });
  const mark = (k) => M.marks.push({ k, t: performance.now() });
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = String(input && input.url ? input.url : input);
    const ans = /\\/api\\/asks\\/\\d+\\/answer/.test(url), st = url.includes("/api/state");
    if (ans) mark("postSent"); if (st) mark("stateStart");
    return of.apply(this, arguments).then((r) => { if (ans) mark("postAnswered"); if (st) mark("stateEnd"); return r; });
  };
  const OES = window.EventSource;
  window.EventSource = class extends OES {
    set onmessage(fn) { super.onmessage = (e) => { const t = performance.now(); fn.call(this, e); M.msgs.push({ t, end: performance.now(), len: e.data.length, data: e.data }); }; }
    get onmessage() { return super.onmessage; }
  };
  document.addEventListener("click", () => mark("press"), true);
  new MutationObserver((list) => {
    for (const r of list) {
      if (M.watch == null) continue;
      if (r.type === "attributes" && r.target.matches?.(".send") && r.target.closest("[data-ask='" + M.watch + "']") && r.target.disabled) mark("disabled");
      for (const n of r.removedNodes) if (n.nodeType === 1 && n.dataset?.ask === String(M.watch)) { mark("gone"); requestAnimationFrame(() => mark("goneFrame")); }
      for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList?.contains("toast")) M.marks.push({ k: "toast", t: performance.now(), text: n.textContent });
      if (r.target.closest?.("#sWait") || r.target.parentElement?.closest?.("#sWait")) { const c = document.querySelector("#sWait .count")?.textContent; if (c !== M.lastCount) { M.lastCount = c; mark("count"); } }
      if (r.type === "attributes" && r.attributeName === "hidden" && r.target.dataset?.ask === String(M.watch) && r.target.hidden) mark("hidden");
      if (r.type === "attributes" && r.attributeName === "class" && r.target.dataset?.ask === String(M.watch) && r.target.classList.contains("leaving")) mark("leaving");
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "class", "hidden"], characterData: true });
})();`;

const chrome = await startChrome();
async function page(url: string, phone: boolean, slow = false) {
  const { targetId } = await chrome.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => chrome.cdp.send(m, p, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Network.enable");
  if (phone) {
    await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await s("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    // Bandwidth of a phone on 4G; the latency is the proxy's, in both directions and on every chunk of the stream.
    await s("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: (slow ? 1.6e6 : 9e6) / 8, uploadThroughput: (slow ? 0.75e6 : 3e6) / 8 });
    if (slow) await s("Emulation.setCPUThrottlingRate", { rate: 4 });
  } else await s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await s("Page.navigate", { url });
  const ev = async (expr: string) => (await s("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  for (let i = 0; i < 200 && !(await ev(`!!document.querySelector("#hud [data-ask] .send")`)); i++) await Bun.sleep(100);
  return { s, ev, phone };
}
const desk = await page(`${base}/`, false);
const phone = await page(`http://127.0.0.1:${proxy.port}/`, true);
const slowPhone = await page(`http://127.0.0.1:${slowProxy.port}/`, true, true);
await Bun.sleep(3000);

async function trial(p: Awaited<ReturnType<typeof page>>) {
  await p.s("Page.bringToFront");
  await Bun.sleep(300);
  const target = await p.ev(`(() => { const c = document.querySelector("#hud [data-ask]"); const b = c.querySelector(".send"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); __m.marks = []; __m.msgs = []; __m.watch = c.dataset.ask; __m.lastCount = document.querySelector("#sWait .count")?.textContent; return { id: c.dataset.ask, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await Bun.sleep(600);
  await p.ev(`__m.marks = []; __m.msgs = []; 0`);
  if (p.phone) {
    await p.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: target.x, y: target.y }] });
    await Bun.sleep(60);
    await p.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await p.s("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await p.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
  }
  await Bun.sleep(4000);
  const r = await p.ev(`JSON.stringify(__m)`);
  const m = JSON.parse(r);
  const press = m.marks.find((x: any) => x.k === "press")?.t;
  const first = (k: string, f = (x: any) => true) => { const x = m.marks.find((y: any) => y.k === k && f(y)); return x ? Math.round(x.t - press) : null; };
  const msgs = m.msgs.filter((x: any) => x.t > press).map((x: any) => ({ at: Math.round(x.t - press), applyMs: Math.round(x.end - x.t), bytes: x.len, keys: Object.keys(JSON.parse(x.data)) }));
  const openMsg = msgs.find((x: any) => x.keys.includes("open"));
  return {
    id: target.id, press: press != null,
    disabled: first("disabled"), postSent: first("postSent"), postAnswered: first("postAnswered"),
    streamOpen: openMsg?.at ?? null, streamOpenBytes: openMsg?.bytes ?? null, streamOpenApplyMs: openMsg?.applyMs ?? null,
    hidden: first("hidden"), leaving: first("leaving"),
    gone: first("gone"), goneFrame: first("goneFrame"), count: first("count"), toast: first("toast", (x) => /HAS IT|KEPT/.test(x.text)),
    stateFetch: first("stateStart"), visible: await p.ev("document.visibilityState"), msgs,
  };
}

const rows: any[] = [];
for (let i = 0; i < TRIALS; i++) {
  for (const [name, p] of [["desktop", desk], ["phone", phone], ["slowphone", slowPhone]] as const) {
    const r = await trial(p);
    rows.push({ device: name, ...r });
    console.error(`[${label}] ${name} #${i}: press→disabled ${r.disabled} post ${r.postSent}→${r.postAnswered} stream(open) ${r.streamOpen} gone ${r.gone} frame ${r.goneFrame} count ${r.count} toast ${r.toast} ${r.visible}`);
    await openAsk(100 + rows.length);
    await Bun.sleep(1500);
  }
}
const typed = await post(base, "/api/asks", { title: "x" }); // a write after the runs: checks the server still answers
log.trials = rows;
log.serverAlive = !!typed.id;
log.loadEnd = load();
console.error(`[${label}] load at end ${log.loadEnd}`);
const out = join(process.cwd(), `result-${label}.json`);
writeFileSync(out, JSON.stringify(log, null, 1));
console.error(`[${label}] wrote ${out}`);
proxy.stop(true); slowProxy.stop(true);
await chrome.close();
await server.stop();
process.exit(0);
