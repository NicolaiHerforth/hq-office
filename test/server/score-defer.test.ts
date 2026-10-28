// The bank and defer: a deferred question does not drain the bank while it is put off, and stops burning; the time it
// waited before and after still counts. score() opens the database, so it runs in a child process on a throwaway data dir.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { waitedMinutes } from "../../src/server/waited.ts";
import { office, ROOT } from "./office.ts";

const MIN = 60_000;

describe("waitedMinutes", () => {
  test("leaves out the deferred spans, cut to the waiting window", () => {
    expect(waitedMinutes(0, 60 * MIN, [])).toBe(60);
    expect(waitedMinutes(0, 60 * MIN, [{ from_at: 10 * MIN, to_at: 40 * MIN }])).toBe(30);
    // a deferral reaching past the end, and one before the start (yesterday's, say), count only inside the window
    expect(waitedMinutes(20 * MIN, 60 * MIN, [{ from_at: 0, to_at: 30 * MIN }, { from_at: 50 * MIN, to_at: 90 * MIN }])).toBe(20);
    expect(waitedMinutes(0, 60 * MIN, [{ from_at: 0, to_at: 5 * MIN }, { from_at: 30 * MIN, to_at: 35 * MIN }])).toBe(50);
  });
});

// score(now) at a fixed noon, in a child process whose HUD_DATA_DIR is a throwaway dir: `rows` are asks (times in minutes
// before noon) and their deferrals.
async function scoreAtNoon(rows: { ask: [number, string]; defers?: [number, number][] }[]) {
  const dir = mkdtempSync(join(tmpdir(), "hud-score-"));
  const script = `
    const { db } = await import(${JSON.stringify(join(ROOT, "src/server/db.ts"))});
    const { score } = await import(${JSON.stringify(join(ROOT, "src/server/score.ts"))});
    const noon = new Date(); noon.setHours(12, 0, 0, 0);
    const at = (min) => noon.getTime() - min * 60000;
    for (const r of ${JSON.stringify(rows)}) {
      const id = Number(db.query("INSERT INTO asks (kind, title, created_at, status) VALUES ('decision', 'q', ?, ?)").run(at(r.ask[0]), r.ask[1]).lastInsertRowid);
      for (const [f, t] of r.defers ?? []) db.query("INSERT INTO ask_defers (ask_id, from_at, to_at) VALUES (?, ?, ?)").run(id, at(f), at(t));
    }
    console.log(JSON.stringify(score(noon.getTime())));`;
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, env: { ...process.env, HUD_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
    if ((await proc.exited) !== 0) throw new Error(err);
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("score(now)", () => {
  test("an hour open with 30 minutes of it deferred loses 25 (30 waited, less the 5-minute grace)", async () => {
    expect((await scoreAtNoon([{ ask: [60, "open"], defers: [[50, 20]] }])).lost).toBe(25);
  });
  test("two deferrals one after the other both come off; a deferral still running stops the burn", async () => {
    const s = await scoreAtNoon([
      { ask: [90, "open"], defers: [[80, 60], [60, 30]] }, // 90 open, 50 deferred: 40 waited
      { ask: [20, "open"], defers: [[10, -60]] }, // deferred until an hour from now
    ]);
    expect(s.lost).toBe(35 + 5); // 40 - 5, and 10 - 5
    expect(s.burnPerMin).toBe(1);
  });
});

describe("the bank while a question is deferred", () => {
  let o: Awaited<ReturnType<typeof office>>;
  afterAll(async () => {
    await o?.stop();
    o?.remove();
  });

  test("a deferred question stops burning, its deferral is recorded, and bringing it back ends the record", async () => {
    o = await office();
    const a = (await o.post("/api/asks", { title: "Later?" })).id;
    await o.post("/api/asks", { title: "Now?" });
    expect((await o.state()).score.burnPerMin).toBe(2);
    const until = Date.now() + 3_600_000;
    await o.post(`/api/asks/${a}/defer`, { until });
    expect((await o.state()).score.burnPerMin).toBe(1);
    const db = new Database(join(o.data, "hud.db"), { readonly: true });
    const rows = () => db.query("SELECT from_at, to_at FROM ask_defers WHERE ask_id = ?").all(a) as { from_at: number; to_at: number }[];
    expect(rows().map((r) => r.to_at)).toEqual([until]);
    await o.post(`/api/asks/${a}/defer`, { until: null });
    const [r] = rows();
    expect(r.to_at).toBeLessThan(until);
    expect(r.to_at).toBeGreaterThanOrEqual(r.from_at);
    db.close();
    expect((await o.state()).score.burnPerMin).toBe(2);
  });

  test("deferring again while deferred ends the first deferral where the second starts: the spans never overlap", async () => {
    const a = (await o.post("/api/asks", { title: "Twice" })).id;
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 3_600_000 });
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 7_200_000 });
    const db = new Database(join(o.data, "hud.db"), { readonly: true });
    const [first, second] = db.query("SELECT from_at, to_at FROM ask_defers WHERE ask_id = ? ORDER BY from_at, rowid").all(a) as { from_at: number; to_at: number }[];
    db.close();
    expect(first.to_at).toBeLessThanOrEqual(second.from_at);
  });
});
