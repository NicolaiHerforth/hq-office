// THE MONITOR's reader (src/server/monitor-reader.ts): the page's parts are made off the server's thread. A replay
// server on a database as large as a busy machine's (scripts/monitor-big.ts: about 2 million raw rows and 2.6
// million rolled up) is asked for every part at once, as the page asks when it opens, while a second client asks a
// route that reads nothing, again and again. That route must keep answering at once: before the reader, each part
// held the server's thread for up to half a second here, one after the other, and on a busy machine whose file cache
// was gone, for 30 s and more, until the stall watch ended the server (25 Nov). Throwaway folders, a spare port and
// a stub herdr; no load is made beyond the server's own reads.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIG_END, writeBig } from "../../scripts/monitor-big.ts";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
const scratch = () => (dirs.push(mkdtempSync(join(tmpdir(), "hq-monitor-reader-"))), dirs[dirs.length - 1]);
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// What the page asks for when it opens (public/monitor.html, PARTS): the newest sample, then the rest at once.
const PARTS = ["range?key=hour", "range?key=day", "range?key=week", "range?key=quarter", "days", "incidents", "patterns", "events?hours=168", "growers", `moment?key=day&t=${BIG_END - 6 * 3_600_000}`];
// The longest the server's thread may be away from a request that asks it for nothing.
const MOST_MS = 300;

test(
  "while the page's parts are read from 2 million rows, the server's thread keeps answering",
  async () => {
    const [folder, data, herdr] = [scratch(), scratch(), scratch()];
    const { rows } = writeBig(folder);
    expect(rows.raw).toBeGreaterThan(1_900_000);
    const bin = join(herdr, "herdr");
    writeFileSync(bin, "#!/bin/sh\nexit 2\n");
    chmodSync(bin, 0o755);
    const { HUD_MONITOR: _, ...env } = process.env;
    const server = await spawnServer({ cwd: ROOT, env: { ...env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_MONITOR_DISK: "0", HUD_MONITOR_REPLAY: folder } });
    try {
      const part = async (path: string) => {
        const res = await fetch(`${server.base}/api/monitor/page/${path}`);
        expect(res.status).toBe(200);
        return res.json() as Promise<any>;
      };
      const first = await part("now");
      expect(first.asOf).toBe(BIG_END);
      // A route that reads nothing (a replay has no sampler of its own), asked again and again while the parts are
      // made: how long each answer took is how long the server's thread was away.
      let reading = true;
      const waits: number[] = [];
      const probe = (async () => {
        while (reading) {
          const at = performance.now();
          await (await fetch(`${server.base}/api/monitor/now`)).json();
          waits.push(performance.now() - at);
          await Bun.sleep(10);
        }
      })();
      const made = performance.now();
      const answers = await Promise.all(PARTS.map(part));
      const took = performance.now() - made;
      reading = false;
      await probe;
      // The server answered throughout.
      const worst = Math.max(...waits);
      if (worst >= MOST_MS) console.error(`the server's thread was away for ${Math.round(worst)} ms while the parts took ${Math.round(took)} ms`);
      expect(worst).toBeLessThan(MOST_MS);
      expect(waits.length).toBeGreaterThan(3);
      // The parts are real ones, read from the whole file.
      const [hour, day, , quarter] = answers;
      expect(hour.host.held.some((v: number | null) => v !== null)).toBe(true);
      expect(day.host.held.filter((v: number | null) => v !== null).length).toBeGreaterThan(100);
      expect(quarter.host.held.some((v: number | null) => v !== null)).toBe(true);
      expect(answers[5].incidents.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  },
  120_000,
);
