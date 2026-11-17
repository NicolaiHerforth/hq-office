// Measures what the server costs this machine: throwaway servers side by side, read from outside every 5 s (own CPU,
// the CPU of what they started, footprint, wakeups, bytes written), with a stub herdr that logs every call.
// docs/footprint.md has the method and the numbers. No load is made: the servers idle, as on a normal day.
//
//   bun scripts/footprint.ts seed DIR
//       a data folder seeded like a busy installation (26 lanes, 100 briefs, 800 events, 1280 answered asks, 26 tracked
//       work items, 10 rooms)
//   bun scripts/footprint.ts servers MINUTES SEED OUT.json LABEL[+stream][:KEY=VALUE,...] ...
//       one server per LABEL from a copy of SEED, each with the given env; +stream holds one page stream open,
//       +allworking has herdr report every lane working (no pane is read)
//   bun scripts/footprint.ts watch MINUTES OUT.json LABEL=PID ...
//       reads processes that already run (a live server), read-only
//   bun scripts/footprint.ts stream BASE MINUTES OUT.jsonl
//       listens to a server's page stream as a page would (a GET) and logs each push: when, bytes, which parts
//   bun scripts/footprint.ts cost RUNS LABEL STDIN -- CMD ARGS...
//       what one run of a command costs (a hook, a sampler script, a herdr call): the median of RUNS; STDIN "-": none
//   bun scripts/footprint.ts floor
//       the runtime's own floor: an idle bun, one that serves, one that also holds a database
import { dlopen, FFIType, ptr } from "bun:ffi";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRATCH = process.env.FOOTPRINT_TMP ?? "/tmp";
const fresh = (name: string) => mkdtempSync(join(SCRATCH, `footprint-${name}-`));

// ---- reading a process from outside ----
const libproc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } }).symbols;
const libsys = dlopen("/usr/lib/libSystem.B.dylib", { mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 } }).symbols;
const tb = new Uint32Array(2);
libsys.mach_timebase_info(ptr(tb));
const toMs = tb[0] / tb[1] / 1e6;
const buf = new Uint8Array(512), view = new DataView(buf.buffer);
const big = (at: number) => Number(view.getBigUint64(at, true));
// rusage_info_v4 (<sys/resource.h>): user 16, system 24, wakeups 32 and 40, footprint 72, children's user 96 and
// system 104, bytes written 152, the footprint's lifetime peak 240.
export function readProcess(pid: number) {
  if (libproc.proc_pid_rusage(pid, 4, ptr(buf)) !== 0) return null;
  return { own: (big(16) + big(24)) * toMs, kids: (big(96) + big(104)) * toMs, wakeups: big(32) + big(40), footprint: big(72) / 1048576, peak: big(240) / 1048576, written: big(152) / 1048576 };
}
type Reading = NonNullable<ReturnType<typeof readProcess>> & { at: number };
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
// What a run of readings says: CPU as a share of one core, memory as it stood.
export function summary(r: Reading[]) {
  const first = r[0], last = r.at(-1)!, min = (last.at - first.at) / 60_000, fp = r.map((x) => x.footprint);
  return {
    minutes: round(min),
    ownCpuPct: round(((last.own - first.own) / (min * 60_000)) * 100, 2),
    kidsCpuPct: round(((last.kids - first.kids) / (min * 60_000)) * 100, 2),
    ownMsPerMin: round((last.own - first.own) / min, 0),
    kidsMsPerMin: round((last.kids - first.kids) / min, 0),
    wakeupsPerSec: round((last.wakeups - first.wakeups) / (min * 60), 1),
    footprintMb: { min: round(Math.min(...fp)), median: round(median(fp)), max: round(Math.max(...fp)), last: round(last.footprint) },
    peakMb: round(last.peak),
    writtenMbPerHour: round(((last.written - first.written) / min) * 60, 2),
  };
}

// ---- the stub herdr: answers like a busy herdr, logs every call, starts no bun ----
const LANES = Array.from({ length: 26 }, (_, i) => `lane-${String(i + 1).padStart(2, "0")}`);
function stubHerdr(dir: string, allWorking = false) {
  // The live mix when this was written: 7 working, 18 done, 1 idle, and HQ idle. A lane that is not working and whose
  // phase is running has its pane read at every sync.
  const status = (i: number) => (allWorking || i < 7 ? "working" : i < 25 ? "done" : "idle");
  const agent = (name: string, i: number, s: string) => ({ agent: "claude", agent_status: s, completion_seq: 40 + i, cwd: `/Users/tester/programming/project/trees/${name}`, focused: false, foreground_cwd: `/Users/tester/programming/project/trees/${name}`, name, pane_id: `w1:p${i}`, revision: 900 + i, state_change_seq: 300 + i, tab_id: `w1:t${i}`, terminal_id: `term-${i}`, terminal_title: `✳ ${name}: working on the thing it was asked to do`, terminal_title_stripped: `${name}: working on the thing it was asked to do`, tokens: 123456, workspace_id: "w1", agent_session: { value: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}` } });
  const agents = [agent("hq", 99, "idle"), ...LANES.map((n, i) => agent(n, i, status(i)))];
  writeFileSync(join(dir, "agents.json"), JSON.stringify({ result: { agents } }));
  writeFileSync(join(dir, "panes.json"), JSON.stringify({ result: { panes: agents.map((a) => ({ pane_id: a.pane_id, cwd: a.cwd, tab_id: a.tab_id, workspace_id: "w1", agent: a.agent, agent_status: a.agent_status, terminal_title: a.terminal_title })) } }));
  writeFileSync(join(dir, "pane.txt"), Array.from({ length: 30 }, (_, i) => `  line ${i}: the lane printed this while it worked, and it is about eighty characters wide`).join("\n") + "\n");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(dir, "calls.log"))}\ncase "$*" in\n  *"agent list"*) cat ${JSON.stringify(join(dir, "agents.json"))} ;;\n  *"pane list"*) cat ${JSON.stringify(join(dir, "panes.json"))} ;;\n  *"pane read"*) cat ${JSON.stringify(join(dir, "pane.txt"))} ;;\n  *"machine list"*) echo '[]' ;;\n  *"process-info"*) echo '{"result":{"process_info":{"shell_pid":${process.pid}}}}' ;;\n  *) exit 0 ;;\nesac\n`);
  chmodSync(bin, 0o755);
  return bin;
}
// What the stub was asked, by kind.
function calls(dir: string) {
  const out: Record<string, number> = {};
  if (!existsSync(join(dir, "calls.log"))) return out;
  for (const line of readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean)) {
    const kind = line.replace(/^--machine \S+ /, "").split(" ").slice(0, 2).join(" ");
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

// ---- a server of our own ----
function freePort() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
}
const started: ReturnType<typeof Bun.spawn>[] = [];
process.on("exit", () => { for (const p of started) try { p.kill("SIGKILL"); } catch {} });
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(s, () => process.exit(1));
export async function startServer(repo: string, data: string, herdr: string, env: Record<string, string> = {}) {
  const port = freePort();
  const subs = fresh("subs-home");
  // Everything HUD_ of the caller's is left out: a lane's own settings must not reach the server that is measured.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HUD_") && !k.startsWith("HERDR_")));
  const proc = Bun.spawn([process.execPath, "server.ts"], {
    cwd: repo,
    env: { ...base, HUD_HOST: "127.0.0.1", HUD_PORT: String(port), HUD_DATA_DIR: data, HUD_SUBS_HOME: subs, HERDR_BIN: herdr, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_GH_BIN: join(data, "no-gh"), HUD_MONITOR_DISK: "0", ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  started.push(proc);
  let said = "";
  for await (const chunk of proc.stdout) {
    said += new TextDecoder().decode(chunk);
    if (said.includes("HQ command centre on")) break;
  }
  if (!said.includes("HQ command centre on")) throw new Error(`server.ts did not start: ${said}`);
  return { pid: proc.pid, port, base: `http://127.0.0.1:${port}`, stop: async () => { proc.kill("SIGTERM"); await proc.exited; } };
}

// ---- the seed: through the API with no herdr, so nothing is typed anywhere ----
async function seed(dir: string) {
  mkdirSync(dir, { recursive: true });
  const server = await startServer(REPO, dir, join(dir, "no-herdr"));
  const P = (p: string, b: object) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json() as any);
  const para = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: the lane checked the branch, ran the suite and found the cause in the outbox. See WRK-${4000 + i}.`).join("\n\n");
  for (const [i, name] of LANES.entries()) await P("/api/lanes", { name, phase: "running", title: `Work item ${i}`, machine: "local" });
  for (let i = 0; i < 100; i++) await P("/api/briefs", { title: `Brief ${i}: findings on WRK-${4000 + (i % 30)}`, body: `# Brief ${i}\n\n${para(12)}` });
  for (let i = 0; i < 800; i++) await P("/api/events", { who: "hq", text: `event ${i}: lane moved on WRK-${4000 + (i % 30)}`, lane: LANES[i % 26] });
  for (let i = 0; i < 40; i++) await P("/api/updates", { title: `Update ${i}`, body: para(2), lane: LANES[i % 26] });
  for (let i = 0; i < 60; i++) await P("/api/notes", { text: `note ${i} to HQ: please look at WRK-${4000 + i} and tell me what it would take. ${para(1)}` });
  // As many asks as the installation this was measured on had after four weeks (1280), their bodies about as long
  // (a median of 850 characters), and its 26 tracked work items, four of them with a PR.
  for (let i = 0; i < 1280; i++) {
    const { id } = await P("/api/asks", { lane: LANES[i % 26], kind: ["decision", "action", "info"][i % 3], title: `Old question ${i} about WRK-${4000 + (i % 30)} and #${100 + i}`, body: para(7), options: i % 3 === 0 ? ["Yes", "No"] : undefined });
    await P(`/api/asks/${id}/answer`, { answer: i % 2 ? "Yes" : "done" });
  }
  for (let i = 0; i < 26; i++) await P("/api/board/track", { issue: `WRK-${4000 + i}`, lane: LANES[i], prs: i % 7 === 0 ? [`#${100 + i}`] : [] });
  for (let i = 0; i < 13; i++) await P("/api/board/pause", { issue: `WRK-${4000 + i * 2}`, reason: "waits on the owner's answer" });
  for (let i = 0; i < 10; i++) await P("/api/rooms", { title: `Room ${i}`, slug: `room-${i}`, brief: `# Room ${i}\n\n${para(4)}` });
  for (let i = 0; i < 4; i++) await P("/api/asks", { lane: LANES[i], kind: "action", title: `Restart the runner for WRK-${4000 + i}`, body: para(2) });
  const state = await (await fetch(`${server.base}/api/state`)).text();
  await server.stop();
  // What was held for an HQ that was not there counts as sent, so no server started from the seed types it.
  const db = new Database(join(dir, "hud.db"));
  db.run("UPDATE hq_outbox SET sent_at = ?, confirmed_at = ? WHERE sent_at IS NULL", [Date.now(), Date.now()]);
  db.close();
  const parts = Object.fromEntries(Object.entries(JSON.parse(state)).map(([k, v]) => [k, JSON.stringify(v).length] as const).sort((a, b) => b[1] - a[1]).slice(0, 10));
  console.log(JSON.stringify({ seed: dir, stateBytes: state.length, parts, hudDbBytes: statSync(join(dir, "hud.db")).size }, null, 2));
}

// ---- the watch: every 5 s, for so many minutes ----
const EVERY_MS = 5000;
async function watch(minutes: number, who: { label: string; pid: number }[], each?: () => void) {
  const readings = new Map<string, Reading[]>(who.map((w) => [w.label, []]));
  const loads: number[] = [];
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    for (const w of who) {
      const r = readProcess(w.pid);
      if (r) readings.get(w.label)!.push({ ...r, at: Date.now() });
    }
    loads.push(loadavg()[0]);
    each?.();
    if (Date.now() >= until) break;
    await Bun.sleep(Math.min(EVERY_MS, until - Date.now()));
  }
  return { readings, load: { start: round(loads[0]), max: round(Math.max(...loads)), end: round(loads.at(-1)!) } };
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "seed") await seed(resolve(args[0]));
  else if (cmd === "watch") {
    const [minutes, out, ...who] = args;
    const pids = who.map((w) => w.split("=")).map(([label, pid]) => ({ label, pid: Number(pid) }));
    const { readings, load } = await watch(Number(minutes), pids);
    const result = { load, at: new Date().toISOString(), processes: Object.fromEntries([...readings].map(([label, r]) => [label, { ...summary(r), readings: r.map((x) => [x.at, Math.round(x.own), Math.round(x.kids), round(x.footprint)]) }])) };
    writeFileSync(out, JSON.stringify(result));
    console.log(JSON.stringify({ load, ...Object.fromEntries([...readings].map(([label, r]) => [label, summary(r)])) }, null, 2));
  } else if (cmd === "servers") {
    const [minutes, seedDir, out, ...specs] = args;
    const repo = process.env.FOOTPRINT_REPO ? resolve(process.env.FOOTPRINT_REPO) : REPO;
    const servers: { label: string; pid: number; base: string; herdrDir: string; stop: () => Promise<void>; stream?: AbortController }[] = [];
    for (const spec of specs) {
      const [head, envText = ""] = spec.split(":");
      const [, ...flags] = head.split("+");
      const label = head;
      const env = Object.fromEntries(envText.split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
      const data = fresh(`data-${label}`), herdrDir = fresh(`herdr-${label}`);
      cpSync(seedDir, data, { recursive: true });
      const server = await startServer(env.FOOTPRINT_REPO ?? repo, data, stubHerdr(herdrDir, flags.includes("allworking")), env);
      let stream: AbortController | undefined;
      if (flags.includes("stream")) {
        // One open page, as far as the server can tell: it builds and sends every push.
        stream = new AbortController();
        fetch(`${server.base}/api/stream`, { signal: stream.signal }).then(async (r) => { for await (const _ of r.body!) ; }).catch(() => {});
      }
      servers.push({ label, pid: server.pid, base: server.base, herdrDir, stop: server.stop, stream });
      console.error(`${label}: pid ${server.pid} on ${server.base}`);
    }
    // The first minute is the start (modules load, the first sync, the first samples): not part of the idle figure.
    await Bun.sleep(60_000);
    const before = new Map(servers.map((s) => [s.label, calls(s.herdrDir)]));
    const { readings, load } = await watch(Number(minutes), servers);
    const result: Record<string, unknown> = { load, minutes: Number(minutes), at: new Date().toISOString(), repo };
    for (const s of servers) {
      const after = calls(s.herdrDir), was = before.get(s.label)!;
      const perMin = Object.fromEntries(Object.entries(after).map(([k, n]) => [k, round((n - (was[k] ?? 0)) / Number(minutes), 1)]));
      // Who bumped, how often the stream looked and what it sent (GET /api/push; a tree from before it has none).
      const push = await fetch(`${s.base}/api/push`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      result[s.label] = { ...summary(readings.get(s.label)!), herdrCallsPerMin: perMin, ...(push ? { push } : {}) };
      s.stream?.abort();
      await s.stop();
    }
    writeFileSync(out, JSON.stringify({ ...result, readings: Object.fromEntries([...readings].map(([label, r]) => [label, r.map((x) => [x.at, Math.round(x.own), Math.round(x.kids), round(x.footprint)])])) }));
    console.log(JSON.stringify(result, null, 2));
  } else if (cmd === "stream") {
    // Contents are not kept: only each part's name and size, and the state's version.
    const [base, minutes, out] = args;
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), Number(minutes) * 60_000);
    const res = await fetch(`${base}/api/stream`, { signal: ctl.signal });
    const dec = new TextDecoder();
    let text = "";
    try {
      for await (const chunk of res.body!) {
        text += dec.decode(chunk, { stream: true });
        for (let i; (i = text.indexOf("\n\n")) >= 0; ) {
          const msg = text.slice(0, i);
          text = text.slice(i + 2);
          if (!msg.startsWith("data: ")) continue;
          const data = JSON.parse(msg.slice(6));
          appendFileSync(out, JSON.stringify({ at: Date.now(), bytes: msg.length, version: data.version ?? null, parts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v).length])) }) + "\n");
        }
      }
    } catch {}
    const rows = existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    if (rows.length > 1) {
      const rest = rows.slice(1), min = (rows.at(-1).at - rows[0].at) / 60_000;
      const quiet = (keys: string[]) => rest.filter((r) => Object.keys(r.parts).every((k) => keys.includes(k))).length;
      console.log(JSON.stringify({ minutes: round(min), firstBytes: rows[0].bytes, pushes: rest.length, pushesPerMin: round(rest.length / min), bumpsPerMin: round((rows.at(-1).version - rows[0].version) / min), bytesPerMin: Math.round(rest.reduce((n, r) => n + r.bytes, 0) / min), onlyVersion: quiet(["version"]), onlyVersionScore: quiet(["version", "score"]), onlyVersionScoreBoard: quiet(["version", "score", "board"]) }, null, 2));
    }
  } else if (cmd === "cost") {
    const [runs, label, stdin, , ...command] = args;
    const rows: { wall: number; cpu: number; rss: number }[] = [];
    for (let i = 0; i < Number(runs); i++) {
      const t = performance.now();
      const p = Bun.spawn(command, { stdin: stdin === "-" ? "ignore" : new Blob([stdin]), stdout: "ignore", stderr: "ignore" });
      await p.exited;
      const u = p.resourceUsage()!;
      rows.push({ wall: performance.now() - t, cpu: Number(u.cpuTime.total) / 1000, rss: u.maxRSS / 1048576 });
    }
    const mid = (k: "wall" | "cpu" | "rss") => median(rows.map((r) => r[k]));
    console.log(`${label.padEnd(52)} wall ${mid("wall").toFixed(0).padStart(5)} ms   cpu ${mid("cpu").toFixed(1).padStart(6)} ms   max rss ${mid("rss").toFixed(1).padStart(5)} MB`);
  } else if (cmd === "floor") {
    const kinds: Record<string, string> = {
      "bun, idle (a timer)": "setInterval(() => {}, 1e9)",
      "bun + Bun.serve": "Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1e9)",
      "bun + Bun.serve + bun:sqlite": "const { Database } = require('bun:sqlite'); const db = new Database(':memory:'); db.exec('CREATE TABLE t (a)'); Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') }); setInterval(() => {}, 1e9)",
    };
    for (const [name, code] of Object.entries(kinds)) {
      const p = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" });
      await Bun.sleep(4000);
      const a = readProcess(p.pid)!;
      await Bun.sleep(10_000);
      const b = readProcess(p.pid)!;
      console.log(`${name.padEnd(32)} footprint ${b.footprint.toFixed(1)} MB (peak ${b.peak.toFixed(1)}), idle CPU ${(((b.own - a.own) / 10_000) * 100).toFixed(3)}% of a core, ${((b.wakeups - a.wakeups) / 10).toFixed(1)} wakeups/s`);
      p.kill();
    }
  } else {
    console.error("bun scripts/footprint.ts seed DIR | servers MINUTES SEED OUT.json LABEL[+stream][:K=V,...] ... | watch MINUTES OUT.json LABEL=PID ... | stream BASE MINUTES OUT.jsonl | cost RUNS LABEL STDIN -- CMD ... | floor");
    process.exit(2);
  }
}
