// SHIP's sorter (src/server/ship-sort.ts) running a real command: a command that hangs is stopped at its time, with
// everything it started, and every item falls back to its repo's name.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSort } from "../../src/server/ship-sort.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a sorter that leaves a child holding its output is stopped at its time, with its children: every item falls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-ship-sort-"));
  const pids = join(dir, "pids");
  try {
    const started = Date.now();
    const r = await runSort([{ id: 1, repo: "acme/web", number: 1, title: "t", branch: "b", body: "", paths: [] }], {
      cmd: `echo $$ > ${pids}; sleep 8 & echo $! >> ${pids}; sleep 30 & echo $! >> ${pids}; wait`,
      domains: [],
      mask: (s) => s,
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.answers).toEqual([{ id: 1, domain: "web", urgency: "NORMAL", why: null }]);
    expect(r.error).toContain("longer than");
    const left = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(left).toHaveLength(3);
    expect(left.filter(alive)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
