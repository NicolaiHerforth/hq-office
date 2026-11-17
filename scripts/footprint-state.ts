// Where the time of one state build goes, on a throwaway data folder: every SQL statement's total time, one push as
// the page stream does it, and the work board's view alone. docs/footprint.md has the method and the numbers.
// It loads the server in this process, so it must never be given a data folder that holds real answers:
//
//   bun scripts/footprint-state.ts SEED [RUNS]        (SEED from `bun scripts/footprint.ts seed DIR`; it is copied)
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

const [seedDir, runsArg = "20"] = process.argv.slice(2);
if (!seedDir) { console.error("bun scripts/footprint-state.ts SEED [RUNS]"); process.exit(2); }
const RUNS = Number(runsArg);
const data = mkdtempSync(join(process.env.FOOTPRINT_TMP ?? "/tmp", "footprint-state-"));
cpSync(resolve(seedDir), data, { recursive: true });
// Set before the server's modules load: a copy of the seed, a port of its own, no herdr, no gh, nobody's usage.
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
for (const k of Object.keys(process.env)) if (k.startsWith("HUD_") || k.startsWith("HERDR_")) delete process.env[k];
Object.assign(process.env, { HUD_DATA_DIR: data, HUD_PORT: String(port), HUD_HOST: "127.0.0.1", HERDR_BIN: "/usr/bin/false", HUD_GH_BIN: join(data, "no-gh"), HUD_SUBS_HOME: join(data, "no-home"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_STATS_MS: "86400000", HUD_SUBS_MS: "86400000" });

const sql = new Map<string, { ms: number; n: number }>();
let timing = false;
const query = Database.prototype.query;
Database.prototype.query = function (text: string) {
  const st = query.call(this, text) as any;
  if (st.__timed) return st;
  st.__timed = true;
  for (const k of ["all", "get", "run", "values"]) {
    const f = st[k];
    st[k] = function (...a: unknown[]) {
      if (!timing) return f.apply(this, a);
      const t = performance.now();
      const r = f.apply(this, a);
      const e = sql.get(text) ?? { ms: 0, n: 0 };
      e.ms += performance.now() - t;
      e.n++;
      sql.set(text, e);
      return r;
    };
  }
  return st;
};

const SERVER = resolve(import.meta.dir, "..", "src", "server");
await import(join(SERVER, "main.ts"));
const { state } = await import(join(SERVER, "state.ts"));
const { refreshParts } = await import(join(SERVER, "the-page-stream.ts"));
const { board } = await import(join(SERVER, "work-board.ts"));
await Bun.sleep(1500);
state();
timing = true;
let t = performance.now(), bytes = 0;
for (let i = 0; i < RUNS; i++) bytes = JSON.stringify(state()).length;
const build = (performance.now() - t) / RUNS;
timing = false;
const each = (n: number) => n / RUNS;
console.log(`state(): ${build.toFixed(1)} ms a build with its JSON (${bytes} bytes); SQL ${each([...sql.values()].reduce((n, e) => n + e.ms, 0)).toFixed(1)} ms in ${Math.round(each([...sql.values()].reduce((n, e) => n + e.n, 0)))} statements`);
for (const [text, e] of [...sql].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)) console.log(`  ${each(e.ms).toFixed(2).padStart(7)} ms  x${each(e.n).toFixed(0).padStart(4)}  ${text.replace(/\s+/g, " ").slice(0, 140)}`);
t = performance.now();
for (let i = 0; i < RUNS; i++) refreshParts();
console.log(`one push (refreshParts): ${((performance.now() - t) / RUNS).toFixed(1)} ms`);
t = performance.now();
for (let i = 0; i < RUNS; i++) board.view();
console.log(`the work board's view alone: ${((performance.now() - t) / RUNS).toFixed(1)} ms`);
process.exit(0);
