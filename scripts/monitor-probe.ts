// THE MONITOR on its own, without the server: `run DIR` samples this machine into DIR/monitor.db until it is
// stopped, `report DIR [minutes]` prints what that database says (who held what, what the monitor cost, how fast
// the database grows, what no owner could be found for), and `export DIR [minutes]` prints the same stretch as
// JSON, one entry per tick with every holder and its largest process groups, for someone who designs with real
// data. DIR is a folder of your own choosing, never the HUD's data folder. Reading herdr's panes is all it does to
// herdr.
//
//   bun scripts/monitor-probe.ts run /path/to/folder
//   bun scripts/monitor-probe.ts report /path/to/folder 60
//   bun scripts/monitor-probe.ts export /path/to/folder 60 > hour.json
import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const [mode, dir, minutes = "60"] = process.argv.slice(2);
if (!dir || !["run", "report", "export"].includes(mode)) {
  console.error("usage: bun scripts/monitor-probe.ts run|report|export DIR [minutes]");
  process.exit(2);
}

if (mode === "run") {
  mkdirSync(dir, { recursive: true });
  const { createMonitor } = await import("../src/server/monitor.ts");
  const monitor = createMonitor({ dir, herdr: process.env.HERDR_BIN ?? "herdr" });
  monitor.start();
  console.log(`sampling into ${join(dir, "monitor.db")} (pid ${process.pid})`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (monitor.stop(), process.exit(0)));
} else if (mode === "export") {
  const db = new Database(join(dir, "monitor.db"), { readonly: true });
  const to = (db.query("SELECT MAX(t) AS t FROM host_raw").get() as { t: number }).t;
  const from = to - Number(minutes) * 60;
  const PRESSURE: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const mb = (kb: number | null) => (kb === null ? null : Math.round(kb / 1024));
  const TOP = 5;
  type Row = { t: number; kind: string; owner: string; name: string; cpu_ms: number; mem_kb: number; n: number; read_kb: number; written_kb: number };
  // The server this probe runs beside is, to the probe, a process in a folder. The monitor inside the server knows
  // it as itself; the export says what the page will say.
  const holderOf = (r: { kind: string; owner: string }) => (r.kind === "other" && /hq-office/.test(r.owner) ? { kind: "hq", name: "HQ Office" } : { kind: r.kind, name: r.owner });
  const holders = (rows: Row[], dtMs: number) => {
    const by = new Map<string, { kind: string; name: string; memMb: number; cpuMs: number; cpuCores: number | null; processes: number; readKb: number; writtenKb: number; top: { name: string; memMb: number; cpuMs: number; processes: number }[] }>();
    for (const r of rows) {
      const who = holderOf(r);
      const key = `${who.kind}\0${who.name}`;
      const h = by.get(key) ?? { ...who, memMb: 0, cpuMs: 0, cpuCores: null, processes: 0, readKb: 0, writtenKb: 0, top: [] };
      h.memMb += r.mem_kb / 1024;
      h.cpuMs += r.cpu_ms;
      h.processes += r.n;
      h.readKb += r.read_kb;
      h.writtenKb += r.written_kb;
      h.top.push({ name: r.name, memMb: Math.round(r.mem_kb / 1024), cpuMs: r.cpu_ms, processes: r.n });
      by.set(key, h);
    }
    return [...by.values()]
      .map((h) => ({ ...h, memMb: Math.round(h.memMb), cpuCores: dtMs ? +(h.cpuMs / dtMs).toFixed(3) : null, top: h.top.sort((a, b) => b.memMb + b.cpuMs - (a.memMb + a.cpuMs)).slice(0, TOP) }))
      .sort((a, b) => b.memMb - a.memMb);
  };
  const rowsAt = new Map<number, Row[]>();
  for (const r of db.query("SELECT r.t, s.kind, s.owner, s.name, r.cpu_ms, r.mem_kb, r.n, r.read_kb, r.written_kb FROM raw r JOIN series s ON s.id = r.sid WHERE r.t > ? ORDER BY r.t").all(from) as Row[]) {
    const list = rowsAt.get(r.t);
    if (list) list.push(r);
    else rowsAt.set(r.t, [r]);
  }
  const hosts = db.query("SELECT * FROM host_raw WHERE t > ? ORDER BY t").all(from) as Record<string, number>[];
  const first = hosts[0];
  console.log(
    JSON.stringify({
      from: iso(first.t),
      to: iso(to),
      tickSeconds: 10,
      machine: { cores: first.cores, memGb: Math.round(first.mem_total_kb / 1048576), swapGb: +(first.swap_total_kb / 1048576).toFixed(1), diskGb: Math.round(first.disk_total_kb / 1048576) },
      samples: hosts.map((h) => ({
        t: iso(h.t),
        dtMs: h.dt_ms,
        host: {
          cpuCores: h.dt_ms ? +(h.busy_ms / h.dt_ms).toFixed(2) : null,
          load1: +h.load1.toFixed(2),
          pressure: PRESSURE[h.pressure] ?? null,
          availablePct: h.available,
          memFreeMb: mb(h.mem_free_kb),
          memWiredMb: mb(h.mem_wired_kb),
          memAppMb: mb(h.mem_app_kb),
          memCachedMb: mb(h.mem_cached_kb),
          memCompressedMb: mb(h.mem_compressed_kb),
          memStoredMb: mb(h.mem_stored_kb),
          swapUsedMb: mb(h.swap_used_kb),
          swapTotalMb: mb(h.swap_total_kb),
          pageins: h.pageins,
          pageouts: h.pageouts,
          swapins: h.swapins,
          swapouts: h.swapouts,
          thermal: h.thermal,
          diskFreeMb: mb(h.disk_free_kb),
          monitorCpuMs: +h.self_cpu_ms.toFixed(1),
          monitorMemMb: mb(h.self_mem_kb),
        },
        holders: holders(rowsAt.get(h.t) ?? [], h.dt_ms),
      })),
    }),
  );
} else {
  const db = new Database(join(dir, "monitor.db"), { readonly: true });
  const to = (db.query("SELECT MAX(t) AS t FROM host_raw").get() as { t: number }).t;
  const from = to - Number(minutes) * 60;
  const host = db
    .query(
      `SELECT COUNT(*) AS ticks, SUM(dt_ms) AS covered, SUM(busy_ms) AS busy, MAX(cores) AS cores, AVG(load1) AS load, MAX(load1) AS load_max,
              AVG(swap_used_kb) AS swap, MAX(swap_used_kb) AS swap_max, AVG(mem_compressed_kb) AS compressed, AVG(mem_stored_kb) AS stored,
              SUM(CASE WHEN pressure = 2 THEN dt_ms ELSE 0 END) AS warn, SUM(CASE WHEN pressure = 4 THEN dt_ms ELSE 0 END) AS critical,
              SUM(self_cpu_ms) AS self_cpu, AVG(self_mem_kb) AS self_mem, MAX(self_mem_kb) AS self_mem_max, MIN(t) AS first
       FROM host_raw WHERE t > ?`,
    )
    .get(from) as Record<string, number>;
  const gb = (kb: number) => (kb / 1048576).toFixed(1).padStart(6);
  const cores = (ms: number) => (ms / host.covered).toFixed(2).padStart(6);
  const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`.padStart(6);
  const table = (title: string, where: string, by: string, limit: number) => {
    const rows = db
      .query(
        `SELECT who, SUM(cpu_ms) AS cpu, SUM(mem_kb) * 1.0 / ${host.ticks} AS mem, MAX(mem_kb) AS mem_max FROM (
           SELECT ${by} AS who, r.t, SUM(r.cpu_ms) AS cpu_ms, SUM(r.mem_kb) AS mem_kb
           FROM raw r JOIN series s ON s.id = r.sid WHERE r.t > ? AND ${where} GROUP BY who, r.t
         ) GROUP BY who ORDER BY SUM(mem_kb) * 1.0 / ${host.ticks} / 1048576 + SUM(cpu_ms) * 4.0 / ${host.covered} DESC LIMIT ${limit}`,
      )
      .all(from) as { who: string; cpu: number; mem: number; mem_max: number }[];
    console.log(`\n${title}\n${"".padEnd(44)}  cores  of busy  mem GB   peak`);
    for (const r of rows) console.log(`${r.who.slice(0, 44).padEnd(44)} ${cores(r.cpu)} ${pct(r.cpu, host.busy)} ${gb(r.mem)} ${gb(r.mem_max)}`);
  };

  console.log(`${new Date(host.first * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}: ${host.ticks} ticks covering ${(host.covered / 60000).toFixed(1)} minutes`);
  console.log(`host: ${cores(host.busy).trim()} of ${host.cores} cores busy on average, load ${host.load.toFixed(1)} (peak ${host.load_max.toFixed(1)}), swap ${gb(host.swap).trim()} GB (peak ${gb(host.swap_max).trim()}), ${gb(host.stored).trim()} GB held in ${gb(host.compressed).trim()} GB of compressor, pressure warn ${(host.warn / 60000).toFixed(1)} min, critical ${(host.critical / 60000).toFixed(1)} min`);
  table("who held what, by owner", "1", "s.kind || ' ' || s.owner", 18);
  table("what landed in other, and what no process accounts for", "s.kind IN ('other', 'lost')", "s.kind || ' ' || s.name", 14);
  table("the system, one level down", "s.kind = 'system'", "s.name", 8);

  const exact = db.query("SELECT s.kind, SUM(r.mem_kb) AS kb FROM raw r JOIN series s ON s.id = r.sid WHERE r.t = ? GROUP BY s.kind").all(to) as { kind: string; kb: number }[];
  console.log(`\nmemory by kind at the last tick: ${exact.map((k) => `${k.kind} ${gb(k.kb).trim()} GB`).join(", ")}`);

  console.log(`\nthe monitor itself: ${((host.self_cpu / host.covered) * 100).toFixed(2)}% of one core (${(host.self_cpu / host.ticks).toFixed(1)} ms a tick), ${(host.self_mem / 1024).toFixed(0)} MB on average, ${(host.self_mem_max / 1024).toFixed(0)} MB at most`);

  const rows = (db.query("SELECT COUNT(*) AS n FROM raw WHERE t > ?").get(from) as { n: number }).n;
  const series = (db.query("SELECT COUNT(*) AS n FROM series").get() as { n: number }).n;
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const size = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  const bytes = (pages - free) * size;
  const all = db.query("SELECT (SELECT COUNT(*) FROM raw) AS raw, (SELECT COUNT(*) FROM host_raw) AS host, (SELECT COUNT(*) FROM roll) AS roll, (SELECT COUNT(*) FROM host_roll) AS host_roll").get() as Record<string, number>;
  const perTick = rows / host.ticks;
  const wal = (() => {
    try {
      return statSync(join(dir, "monitor.db-wal")).size;
    } catch {
      return 0;
    }
  })();
  console.log(`\ndatabase: ${(bytes / 1048576).toFixed(2)} MB in use (plus a ${(wal / 1048576).toFixed(1)} MB write-ahead log), ${all.raw} raw rows, ${all.host} host rows, ${all.roll} rollup rows, ${series} series`);
  console.log(`rows a tick: ${perTick.toFixed(1)}; raw rows a day at this rate: ${Math.round(perTick * 8640)}`);
}
