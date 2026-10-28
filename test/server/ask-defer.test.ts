// Defer: the owner puts an open question off until a time. It leaves the open list, HQ is told until when, and at its time it
// is back at the top, by itself and after a restart.
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { office, ROOT } from "./office.ts";

const offices: Awaited<ReturnType<typeof office>>[] = [];
afterAll(async () => {
  for (const o of offices) {
    await o.stop();
    o.remove();
  }
});
const start = async (opts: Parameters<typeof office>[0] = {}) => {
  const o = await office(opts);
  offices.push(o);
  return o;
};
const ids = (list: any[]) => list.map((a) => a.title);
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (ok(v)) return v;
    await Bun.sleep(50);
  }
  throw new Error("never became true");
}

// An open page: the /api/stream messages, each holding the parts of the state that changed.
async function pageOpen(base: string) {
  const res = await fetch(`${base}/api/stream`);
  const reader = res.body!.getReader();
  let buf = "";
  const seen: any[] = [];
  return {
    async until(ok: (m: any) => boolean) {
      const stop = Date.now() + 5000;
      for (;;) {
        const hit = seen.find(ok);
        if (hit) return hit;
        if (Date.now() > stop) throw new Error("the page was never pushed it");
        const chunk = await Promise.race([reader.read(), Bun.sleep(5000).then(() => null)]);
        if (!chunk || chunk.done) continue;
        buf += new TextDecoder().decode(chunk.value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (line.startsWith("data: ")) seen.push(JSON.parse(line.slice(6)));
        }
      }
    },
    close: () => reader.cancel(),
  };
}

describe("defer", () => {
  test("a deferred question is out of open and its lane's count, in deferred, and HQ is told until when", async () => {
    const o = await start({ agents: ["hq"] });
    await o.post("/api/lanes", { name: "app" });
    const a = (await o.post("/api/asks", { title: "Later?", lane: "app" })).id;
    await o.post("/api/asks", { title: "Now?" });
    const t = Date.now() + 3_600_000;
    await o.post(`/api/asks/${a}/defer`, { until: t });
    const s = await o.state();
    expect(ids(s.open)).toEqual(["Now?"]);
    expect(s.lanes.find((l: any) => l.name === "app").asks).toBe(0);
    expect(s.deferred.map((x: any) => [x.title, x.defer_until])).toEqual([["Later?", t]]);
    const told = await o.prompted("Later?");
    expect(told).toContain("deferred it until");
    expect(told).toContain("comes back to the top then");
  });

  test("it comes back at its time, first, and an open page is pushed it without anyone asking", async () => {
    const o = await start();
    await Bun.sleep(2500); // the server's start-up pushes (first sync, machine sample) are over, so only the timer is left to push
    await o.post("/api/asks", { title: "Plain" });
    const a = (await o.post("/api/asks", { title: "Brief nap" })).id;
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 1200 });
    expect(ids((await o.state()).open)).toEqual(["Plain"]);
    const page = await pageOpen(o.base);
    await page.until((m) => m.deferred?.length === 1 && m.open?.length === 1);
    // The page holds the stream; only a bump of the server's own makes it send the question's return.
    const pushed = await page.until((m) => m.open?.length === 2);
    expect(ids(pushed.open)).toEqual(["Brief nap", "Plain"]);
    expect(pushed.deferred).toEqual([]);
    page.close();
  });

  test("a restart does not lose it: before its time it is still deferred, then it comes back", async () => {
    const first = await start();
    const a = (await first.post("/api/asks", { title: "Survives" })).id;
    await first.post(`/api/asks/${a}/defer`, { until: Date.now() + 4500 });
    await first.stop();
    const second = await start({ data: first.data });
    const s = await second.state();
    expect(ids(s.open)).toEqual([]);
    expect(ids(s.deferred)).toEqual(["Survives"]);
    // The restarted server arms its own timer from ask_defers: an open page is pushed the question's return.
    await Bun.sleep(2500);
    const page = await pageOpen(second.base);
    await page.until((m) => m.deferred?.length === 0 && m.open?.length === 1);
    page.close();
  });

  test("null brings it back now; a time in the past, or an answered question, is refused", async () => {
    const o = await start();
    const a = (await o.post("/api/asks", { title: "Q" })).id;
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 3_600_000 });
    await o.post(`/api/asks/${a}/defer`, { until: null });
    expect(ids((await o.state()).open)).toEqual(["Q"]);
    expect((await o.send(`/api/asks/${a}/defer`, { until: Date.now() - 1000 })).status).not.toBe(200);
    expect((await o.send(`/api/asks/${a}/defer`, {})).status).not.toBe(200);
    await o.post(`/api/asks/${a}/answer`, { answer: "yes" });
    expect((await o.send(`/api/asks/${a}/defer`, { until: Date.now() + 5000 })).status).not.toBe(200);
  });

  test("a deferred question can still be answered", async () => {
    const o = await start();
    const a = (await o.post("/api/asks", { title: "Q" })).id;
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 3_600_000 });
    await o.post(`/api/asks/${a}/answer`, { answer: "yes" });
    const s = await o.state();
    expect(s.deferred).toEqual([]);
    expect(s.answered.map((x: any) => x.answer)).toEqual(["yes"]);
  });

  test("bringing back a question that is not deferred is refused, and so is bringing back one whose deferral is over", async () => {
    const o = await start();
    const a = (await o.post("/api/asks", { title: "Never deferred" })).id;
    const res = await o.send(`/api/asks/${a}/defer`, { until: null });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`ask ${a} is not deferred`);
    expect((await o.state()).open[0].defer_until).toBeNull(); // the refusal did not float it to the top as "back"
    await o.post(`/api/asks/${a}/defer`, { until: Date.now() + 3_600_000 });
    await o.post(`/api/asks/${a}/defer`, { until: null });
    expect((await o.send(`/api/asks/${a}/defer`, { until: null })).status).toBe(400); // already brought back
  });

  test("a database the earlier build made, with an asks.defer_until column, reports and sorts by defer_until from ask_defers", async () => {
    const data = mkdtempSync(join(tmpdir(), "hq-oldcol-test-"));
    const old = new Database(join(data, "hud.db"), { create: true });
    old.exec(readFileSync(join(ROOT, "src/server/schema/asks.sql"), "utf8"));
    old.exec("ALTER TABLE asks ADD COLUMN defer_until INTEGER");
    old.exec(readFileSync(join(ROOT, "src/server/schema/ask_defers.sql"), "utf8"));
    const t = Date.now() + 3_600_000, back = Date.now() - 60_000;
    // The stale column says one thing for each question; the rows say another. Back came back from a deferral under this
    // build (its column is empty), Stale has only an old column value, and both were asked after Plain.
    old.query("INSERT INTO asks (title, created_at, defer_until) VALUES ('Deferred', 1000, 5), ('Plain', 1000, NULL), ('Stale', 2000, 5), ('Back', 3000, NULL)").run();
    old.query("INSERT INTO ask_defers (ask_id, from_at, to_at) VALUES (1, 1000, ?), (4, 500, ?)").run(t, back);
    old.close();
    try {
      const o = await start({ data });
      const s = await o.state();
      expect(s.deferred.map((x: any) => [x.title, x.defer_until])).toEqual([["Deferred", t]]);
      // the question that is back sorts first; the stale column floats nothing
      expect(s.open.map((x: any) => [x.title, x.defer_until])).toEqual([["Back", back], ["Plain", null], ["Stale", null]]);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });

  test("the cut and the new row are one step: a failing insert leaves the running deferral as it was", async () => {
    const data = mkdtempSync(join(tmpdir(), "hq-defer-tx-"));
    const script = `
      await import(${JSON.stringify(join(ROOT, "src/server/herdr.ts"))}); // first, as main.ts does: state.ts and herdr.ts import each other
      const { db } = await import(${JSON.stringify(join(ROOT, "src/server/db.ts"))});
      const { deferAsk } = await import(${JSON.stringify(join(ROOT, "src/server/asks.ts"))});
      const id = Number(db.query("INSERT INTO asks (title, created_at) VALUES ('q', 1000)").run().lastInsertRowid);
      const to = Date.now() + 3600000;
      db.query("INSERT INTO ask_defers (ask_id, from_at, to_at) VALUES (?, ?, ?)").run(id, Date.now() - 1000, to);
      db.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON ask_defers BEGIN SELECT RAISE(ABORT, 'no room'); END");
      let failed = false;
      try { deferAsk(id, Date.now() + 7200000); } catch { failed = true; }
      console.log(JSON.stringify({ failed, rows: db.query("SELECT to_at FROM ask_defers").all().map((r) => r.to_at === to) }));
      process.exit(0);`;
    try {
      const proc = Bun.spawn([process.execPath, "-e", script], { cwd: data, env: { ...process.env, HUD_DATA_DIR: data }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
      if ((await proc.exited) !== 0) throw new Error(err);
      expect(JSON.parse(out.trim().split("\n").pop()!)).toEqual({ failed: true, rows: [true] });
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});
