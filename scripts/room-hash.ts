#!/usr/bin/env bun
// Renders the page for fixed states, seasons and times in headless Chrome and hashes what it draws: the room's
// canvas pixels after the first frame and after 3 s of frames, and every element's computed style and box. The
// same tree gives the same hashes, so two trees (before and after a change) can be compared.
//
//   bun scripts/room-hash.ts [DIR] [--ref=GIT_REF] [--timing]
//
// DIR (default: this repo) or a git ref, exported to a temporary folder with git archive. Each tree runs on its
// own temporary server, port and data folder, with a fake herdr, and is stopped afterwards. Time, randomness and
// animation frames are frozen in the page; Google Fonts are blocked so both trees draw with the same fonts.
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DAY = Date.UTC(2026, 3, 20, 14, 0); // 20 April, 14:00 UTC: spring, no event
const NIGHT = Date.UTC(2026, 3, 20, 2, 0);
const SEASONS = ["spring", "summer", "fall", "winter", "christmas", "newyear", "valentine", "stpatrick", "easter", "halloween", "thanksgiving"];
const FRAMES = 30;

export type Capture = { name: string; first: string; later: string };
export type Result = { captures: Capture[]; styles: Record<string, string>; errors: string[]; scroll: Record<string, boolean>; timing?: Record<string, number> };

export function findChrome(): string | null {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (existsSync(p)) return p;
  return null;
}

// The page's clock, randomness and frames, frozen. #t=<epoch ms> turns it on; __hq.advance(n) runs n frames.
export const FREEZE = `(() => {
  const m = location.hash.match(/t=(\\d+)/);
  if (!m) return;
  const EPOCH = Number(m[1]);
  let T = 900;
  const RealDate = Date;
  // The wall clock stands still; only the frames move (the room animates from the frame time it is given).
  const now = () => EPOCH;
  function FakeDate(...a) {
    if (!new.target) return new RealDate(now()).toString();
    return a.length ? new RealDate(...a) : new RealDate(now());
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = now; FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
  window.Date = FakeDate;
  performance.now = () => T;
  let seed = 12345;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const queue = [];
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  // A timer with a delay waits on the frozen clock and runs in advance(), when its time comes: the room's loop waits
  // on one between frames. A zero delay runs at once, as in a browser.
  const realSetTimeout = window.setTimeout.bind(window), realClearTimeout = window.clearTimeout.bind(window);
  const timers = new Map();
  let timerId = 1e9;
  window.setTimeout = (fn, ms, ...a) => {
    if (!(ms > 0)) return realSetTimeout(fn, ms, ...a);
    timers.set(++timerId, { at: T + ms, fn: () => fn(...a) });
    return timerId;
  };
  window.clearTimeout = (id) => { timers.delete(id); realClearTimeout(id); };
  const runTimers = () => {
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= T && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) return;
      timers.delete(next[0]);
      next[1].fn();
    }
  };
  // No live stream: the page renders the state it loads, and nothing a write sends back can race a capture.
  // (It also keeps Chrome's six sockets per host free; lingering stream sockets stall a quick run of page loads.)
  // The real stream's first message is the whole state; this one sends that once and then stays quiet.
  window.EventSource = class {
    constructor() {
      setTimeout(async () => {
        const s = await (await window.fetch("/api/state")).json();
        this.onmessage?.({ data: JSON.stringify(s) });
      }, 0);
    }
    close() {}
  };
  // The server's clock, machine numbers and score are real; pin them.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (!String(url).includes("/api/state")) return res;
    const s = await res.json();
    s.now = now();
    s.machines = [{ machine: "local", sample: { at: now(), machine: "local", ok: 1, cores: 8, load1: 1.5, cpu_busy: 12, mem_used: 40 }, age: 0, ok: true }];
    s.score = { bank: 1000, lost: 0, bonus: 0, fast: 0, burnPerMin: s.open.length };
    s.sync = { at: 0, errors: [] };
    s.events = [];
    // timestamps the server took from its own clock
    s.updates?.forEach((u, i) => { u.at = EPOCH - (i + 1) * 60000; });
    s.notes?.forEach((n, i) => { n.at = EPOCH - (i + 1) * 90000; if (n.acked_at) n.acked_at = n.at; });
    s.answered?.forEach((a, i) => { a.answered_at = EPOCH - (i + 1) * 30000; if (a.acked_at) a.acked_at = a.answered_at; });
    s.lanes?.forEach((l) => { for (const k of ["herdr_since", "herdr_seen", "updated_at"]) if (l[k]) l[k] = EPOCH - 120000; });
    return new Response(JSON.stringify(s), { headers: { "content-type": "application/json" } });
  };
  window.__hq = {
    ready: () => !!document.getElementById("card")?.innerHTML && !!document.getElementById("feed")?.innerHTML,
    advance(n) { for (let i = 0; i < n; i++) { T += 100; runTimers(); for (const cb of queue.splice(0)) cb(T); } return T; },
  };
})();`;

// The dancing hero's box (with his notes, sparkles and shadow), in canvas pixels. The dance steps on the room's
// beat, two beats a move, so its frames differ from a tree with another tempo; idle captures leave this box out.
const DANCE_BOX = [888, 0, 180, 138];
// The coffee machines' lights (both) and the kitchen steam, in canvas pixels. From 0.6 the lights blink once a second
// (they blinked every 500 ms) and the steam rises only while someone takes a coffee, so every capture leaves them out.
const COFFEE_BOXES = [[1137, 306, 6, 6], [1140, 699, 6, 6], [1118, 638, 27, 33]];
// The page's clock starts at 900; captures are taken on whole beats of the room's coming ambient beat (multiples of
// 500 ms), where an animation that steps on the beat draws exactly what it drew before.
const canvasHash = (masks: number[][]) => `(async () => {
  const c = document.getElementById("room");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  for (const m of ${JSON.stringify(masks)}) for (let y = m[1]; y < m[1] + m[3]; y++) d.fill(0, (y * c.width + m[0]) * 4, (y * c.width + m[0] + m[2]) * 4);
  const h = await crypto.subtle.digest("SHA-256", d);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
})()`;

const STYLE_HASH = `(async (raw) => {
  const out = [];
  // Every element the page shows (not the script, style and link tags, which the restructure changes by design),
  // its box, every computed property in name order, and its text when it is a leaf.
  for (const el of [document.documentElement, ...document.body.querySelectorAll("*")]) {
    if (["SCRIPT", "STYLE", "LINK", "META"].includes(el.tagName)) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const props = [];
    for (let i = 0; i < cs.length; i++) props.push(cs[i] + ":" + cs.getPropertyValue(cs[i]));
    props.sort();
    out.push(el.tagName + "#" + el.id + "." + el.className + "|" + [r.x, r.y, r.width, r.height].map(Math.round).join(",") + "|" + props.join(";") + "|" + (el.children.length ? "" : el.textContent.replace(/\\s+/g, " ")));
  }
  if (raw) return out.join("\\n");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(out.join("\\n")));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
})(${process.env.STYLE_RAW ? "true" : "false"})`;

export class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, (v: any) => void>();
  listeners: ((m: any) => void)[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); }
      else for (const l of this.listeners) l(m);
    };
  }
  static async open(url: string) {
    const ws = new WebSocket(url);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((ok, no) => this.pending.set(id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result))));
  }
}

export async function startChrome() {
  const bin = findChrome();
  if (!bin) throw new Error("no Chrome found; set CHROME_BIN");
  const profile = mkdtempSync(join(tmpdir(), "hq-office-chrome-"));
  const proc = Bun.spawn([bin, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--mute-audio", "--hide-scrollbars", "--force-device-scale-factor=1", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {}
    if (!port) await Bun.sleep(100);
  }
  if (!port) throw new Error("Chrome did not start");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await Cdp.open(version.webSocketDebuggerUrl);
  // The profile is removed once Chrome has exited: removed while it still runs, Chrome writes parts of it back.
  return { cdp, close: async () => { cdp.ws.close(); proc.kill(); await proc.exited; rmSync(profile, { recursive: true, force: true }); } };
}

// A port nothing is listening on right now.
export function freePort() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
}

// server.ts on a port of its own. A port that was free when freePort probed it can be taken before the server binds
// it (by another test run on this machine); the server then exits, and a readiness check on that port would reach
// the other run's server. So the server's own word is the signal: it prints its address only once it listens, and a
// server that exits first is started again on another port.
export async function spawnServer(opts: { cwd: string; env: Record<string, string | undefined>; out?: (chunk: Uint8Array) => void }) {
  for (let attempt = 1; ; attempt++) {
    const port = freePort();
    const proc = Bun.spawn([process.execPath, "server.ts"], { cwd: opts.cwd, env: { ...opts.env, HUD_PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    let said = "";
    let listening!: (ok: boolean) => void;
    const up = new Promise<boolean>((ok) => (listening = ok));
    const pump = async (s: ReadableStream<Uint8Array>, watch: boolean) => {
      for await (const chunk of s) {
        opts.out?.(chunk);
        if (watch && !said.includes("HQ command centre on")) {
          said += new TextDecoder().decode(chunk);
          if (said.includes("HQ command centre on")) listening(true);
        }
      }
    };
    const drained = Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]).then(() => {});
    proc.exited.then(() => listening(false));
    const timer = setTimeout(() => listening(false), 15_000);
    const ok = await up;
    clearTimeout(timer);
    const stop = async () => { proc.kill(); await proc.exited; await drained; };
    if (ok) return { proc, port, base: `http://127.0.0.1:${port}`, stop };
    await stop();
    if (attempt === 5) throw new Error(`server.ts did not start (last port ${port}): ${said.trim() || "no output"}`);
  }
}

export async function startServer(dir: string, extraEnv: Record<string, string> = {}) {
  const data = mkdtempSync(join(tmpdir(), "hq-office-pixels-"));
  const herdr = join(data, "herdr");
  // A herdr that knows HQ and two agents: one working, one idle. Everything else it is asked succeeds quietly.
  writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"p0","agent":"claude"},{"name":"golf","agent_status":"working","pane_id":"p1","agent":"claude"},{"name":"alpha","agent_status":"idle","pane_id":"p2","agent":"claude"}]}}' ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(herdr, 0o755);
  // PIXEL_OWNER names the owner on both sides, for a base whose default hero carried a fixed name instead of HUD_OWNER.
  const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_OWNER: process.env.PIXEL_OWNER || "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", ...extraEnv };
  const server = await spawnServer({ cwd: dir, env });
  const { base } = server;
  const post = (path: string, body: object) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json());
  return { base, post, stop: async () => { await server.stop(); rmSync(data, { recursive: true, force: true }); } };
}

export async function seed(post: (p: string, b: object) => Promise<any>) {
  const lanes = [
    { name: "alpha", phase: "running", title: "Idle at HQ" },
    { name: "bravo", phase: "running", title: "Has a question" },
    { name: "charlie", phase: "waiting", title: "Waits on CI" },
    { name: "delta", phase: "parked", title: "Parked" },
    { name: "echo", phase: "done", title: "Done one" },
    { name: "foxtrot", phase: "done", title: "Done two" },
    { name: "golf", phase: "running", title: "At the desk" },
    { name: "hotel-with-a-long-name", phase: "done", title: "Done three" },
  ];
  for (const l of lanes) await post("/api/lanes", { ...l, machine: "local" });
  // BALANCED steps the room's motions on the same beats as the trees from before the PERFORMANCE setting (0.6), so
  // the two draw the same; a tree from before keeps the unknown setting and ignores it.
  await post("/api/settings", { settings: { performance: "balanced" } });
  const ask = await post("/api/asks", { lane: "bravo", kind: "decision", title: "Ship the thing?", body: "Two ways to go.\n```\nbun test\n```", options: ["Yes", "No"], recommended: "Yes", created_at: DAY - 7 * 60_000 });
  await post("/api/asks", { lane: "charlie", kind: "action", title: "Approve the deploy", created_at: DAY - 40 * 60_000 });
  await post("/api/updates", { lane: "golf", title: "Halfway there", body: "The first part is merged." });
  await post("/api/notes", { text: "Keep going." });
  await post("/api/sync", {});
  return ask.id as number;
}

export async function capture(dir: string, opts: { timing?: boolean } = {}): Promise<Result> {
  const t0 = Date.now();
  const log = (what: string) => process.env.HASH_LOG && console.error(`${((Date.now() - t0) / 1000).toFixed(1)}s ${what}`);
  const chrome = await startChrome();
  const server = await startServer(dir);
  const { cdp } = chrome;
  const errors: string[] = [];
  try {
    const { s, evaluate } = await newSession(cdp, errors);
    await s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    await s("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await s("Page.addScriptToEvaluateOnNewDocument", { source: FREEZE });
    const size = (width: number, height: number) => s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const open = async (query: string, t: number) => {
      // Through a blank page: a URL that differs only in its hash would not load again, and keep the old clock.
      await s("Page.navigate", { url: "about:blank" });
      await s("Page.navigate", { url: `${server.base}/${query}#t=${t}` });
      // Up to 15 s: two headless Chromes and two servers can share the machine during a full test run.
      for (let i = 0; i < 300; i++) {
        if (await evaluate("!!window.__hq && window.__hq.ready()").catch(() => false)) {
          // CSS animations (the blinking count, the flash on a selected question) held at their start
          await s("Animation.setPlaybackRate", { playbackRate: 0 });
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error(`page did not render ${query}`);
    };
    const shot = async (name: string): Promise<Capture> => {
      const hash = canvasHash(name.startsWith("day, idle") ? [DANCE_BOX, ...COFFEE_BOXES] : COFFEE_BOXES);
      // The first frame on the next whole beat (500 ms), the later one 3 s after it
      const t = await evaluate("__hq.advance(0)");
      await evaluate(`__hq.advance(${(500 - (t % 500)) / 100})`);
      const first = await evaluate(hash);
      await evaluate(`__hq.advance(${FRAMES})`);
      return { name, first, later: await evaluate(hash) };
    };
    const noScroll = () => evaluate("document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth");

    await size(1440, 900);
    log("chrome and server up");
    const askId = await seed(server.post);
    log("seeded");
    const captures: Capture[] = [];
    const styles: Record<string, string> = {};
    const scroll: Record<string, boolean> = {};
    await open("", DAY);
    captures.push(await shot("day, asks open"));
    styles["1440x900"] = await evaluate(STYLE_HASH);
    scroll["1440x900"] = await noScroll();
    await evaluate(`document.getElementById("settingsBtn").click()`);
    // The PERFORMANCE row is new in 0.6; leave it out so the rest of the panel compares with a tree from before.
    await evaluate(`document.querySelector('[data-set="performance"]')?.closest(".srow").remove()`);
    // The LEVEL NAMES and LEVEL THEME rows are new in the lane tree's release; left out the same way.
    await evaluate(`document.querySelector("[data-levels]")?.remove(); document.querySelector('[data-set="theme"]')?.closest(".srow").remove()`);
    // The FLOORS section is new with floors' page (where a second floor is added); left out the same way.
    await evaluate(`document.querySelector("#settings [data-floors]")?.remove()`);
    styles["1440x900 settings open"] = await evaluate(STYLE_HASH);
    await evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
    styles["1440x900 messages tab"] = await evaluate(STYLE_HASH);
    await evaluate(`document.querySelector('[data-qtab="questions"]').click()`);
    await evaluate(`document.querySelector('[data-select="bravo"]').click()`);
    styles["1440x900 worker selected"] = await evaluate(STYLE_HASH);
    await size(800, 900);
    styles["800x900"] = await evaluate(STYLE_HASH);
    await size(1440, 900);
    // The room with a worker selected, on a fresh page: the same first seconds after load as every other capture,
    // not the seconds after those, when the idle workers' later errands start
    await open("", DAY);
    await evaluate(`document.querySelector('[data-select="bravo"]').click()`);
    captures.push(await shot("day, worker selected"));
    for (const season of SEASONS) {
      await open(`?season=${season}`, DAY);
      captures.push(await shot(`day, asks open, ${season}`));
      log(season);
    }
    // nothing waiting: the hero dances by day and sleeps at night
    await server.post(`/api/asks/${askId}/answer`, { answer: "Yes" });
    const open2 = (await (await fetch(`${server.base}/api/state`)).json()).open;
    for (const a of open2) await server.post(`/api/asks/${a.id}/withdraw`, { reason: "test" });
    for (const season of ["spring", "christmas", "halloween"]) {
      await open(`?season=${season}`, DAY);
      captures.push(await shot(`day, idle, ${season}`));
      await open(`?season=${season}`, NIGHT);
      captures.push(await shot(`night, idle, ${season}`));
    }
    styles["1440x900 idle"] = await evaluate(STYLE_HASH);
    let timing: Record<string, number> | undefined;
    if (opts.timing) {
      timing = {};
      const runs: number[][] = [];
      for (let i = 0; i < 5; i++) {
        await s("Network.setCacheDisabled", { cacheDisabled: i === 0 });
        await s("Page.navigate", { url: `${server.base}/` });
        for (let j = 0; j < 100; j++) { if (await evaluate("!!document.getElementById('card')?.innerHTML").catch(() => false)) break; await Bun.sleep(20); }
        runs.push(await evaluate(`(() => { const n = performance.getEntriesByType("navigation")[0]; const r = performance.getEntriesByType("resource").filter((e) => !/fonts/.test(e.name)); return [n.domContentLoadedEventEnd, n.loadEventEnd, r.length + 1, n.transferSize + r.reduce((a, e) => a + e.transferSize, 0), n.encodedBodySize + r.reduce((a, e) => a + e.encodedBodySize, 0)]; })()`));
      }
      const median = (k: number) => runs.slice(1).map((r) => r[k]).sort((x, y) => x - y)[2];
      timing = { coldRequests: runs[0][2], coldBytes: runs[0][3], bodyBytes: runs[0][4], coldDomContentLoadedMs: Math.round(runs[0][0]), warmDomContentLoadedMs: Math.round(median(0)), warmLoadMs: Math.round(median(1)), warmBytes: median(3) };
    }
    return { captures, styles, errors, scroll, timing };
  } finally {
    log("captured");
    await server.stop();
    log("server stopped");
    await chrome.close();
    log("chrome closed");
  }
}

// A tab with focus emulated (the room only draws in a focused window) and errors collected.
export async function newSession(cdp: Cdp, errors: string[]) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m: string, p: object = {}) => cdp.send(m, p, sessionId);
  cdp.listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/fonts\.(googleapis|gstatic)|ERR_BLOCKED/.test(m.params.entry.text + (m.params.entry.url ?? ""))) errors.push(m.params.entry.text);
  });
  for (const d of ["Page", "Runtime", "Log", "Network", "Animation"]) await s(`${d}.enable`);
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  // CPU_THROTTLE=N slows the page N times, to reproduce a load-only flake without loading the machine.
  if (Number(process.env.CPU_THROTTLE) > 1) await s("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU_THROTTLE) });
  const evaluate = async (expression: string) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { s, evaluate };
}

export async function treeOf(ref: string, repo: string) {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-ref-"));
  const archive = Bun.spawnSync(["git", "-C", repo, "archive", ref], { stdout: "pipe", timeout: 60_000 });
  if (archive.exitCode !== 0) throw new Error(`git archive ${ref} failed`);
  Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

if (import.meta.main) {
  const ref = process.argv.find((a) => a.startsWith("--ref="))?.slice(6);
  const repo = resolve(import.meta.dir, "..");
  const tree = ref ? await treeOf(ref, repo) : { dir: resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? repo), done: () => {} };
  try {
    console.log(JSON.stringify(await capture(tree.dir, { timing: process.argv.includes("--timing") }), null, 2));
  } finally {
    tree.done();
  }
}
void readdirSync;
