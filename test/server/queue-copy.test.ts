// The move from the installed branch's requests table to asks, and the rule that makes it the only reader:
// the copy is safe to run twice, does nothing when the table is absent, and no other code reads requests.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

// Starting the database module is the migration: it runs on import, as it does at every server start.
async function start(dir: string) {
  const proc = Bun.spawn([process.execPath, "-e", `await import("./src/server/db.ts"); process.exit(0)`], { cwd: ROOT, env: { ...process.env, HUD_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
}
const asks = (dir: string) => {
  const d = new Database(join(dir, "hud.db"), { readonly: true });
  const rows = d.query("SELECT * FROM asks ORDER BY id").all() as any[];
  d.close();
  return rows;
};

test("requests rows are copied into asks once, keyed by request id, with the fields mapped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-copy-"));
  try {
    const old = new Database(join(dir, "hud.db"), { create: true });
    // The tables as the installed branch has them: asks without the queue's columns, and requests.
    old.exec(readFileSync(join(ROOT, "src/server/schema/asks.sql"), "utf8"));
    old.exec(`CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, lane TEXT NOT NULL, pr TEXT, text TEXT NOT NULL, default_action TEXT, default_by INTEGER, created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', defaulted_at INTEGER, answer TEXT, answered_at INTEGER, last_error TEXT, lead TEXT)`);
    old.query("INSERT INTO asks (title, created_at) VALUES ('a question for the owner', 1000)").run();
    const add = old.query("INSERT INTO requests (id, kind, lane, pr, text, default_action, default_by, created_at, status, defaulted_at, answer, answered_at, last_error, lead) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    add.run(7, "READY", "lane-a", "3417", "READY: PR is green\nsecond line", null, null, 2000, "open", null, null, null, "sandbox refused", null);
    add.run(8, "BLOCK", "lane-b", null, "may I use the hub?", "use the hub", 9000, 3000, "defaulted", 9000, null, null, null, "HQ2");
    add.run(9, "QUESTION", "lane-c", null, "which seed?", null, null, 4000, "closed", null, "seed B", 5000, null, "HQ");
    old.close();

    await start(dir);
    await start(dir); // a second start copies nothing more
    const rows = asks(dir);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ title: "a question for the owner", recipient: "owner", urgent_at: null, request_id: null });
    expect(rows[1]).toMatchObject({ request_id: 7, lane: "lane-a", kind: "READY", title: "READY: PR is green", body: "READY: PR is green\nsecond line", link: "3417", created_at: 2000, status: "open", recipient: "HQ", last_error: "sandbox refused", acked_at: null, urgent_at: null });
    expect(rows[2]).toMatchObject({ request_id: 8, status: "defaulted", recommended: "use the hub", due: 9000, answered_at: 9000, acked_at: 9000, recipient: "HQ2" });
    expect(rows[3]).toMatchObject({ request_id: 9, status: "answered", answer: "seed B", answered_at: 5000, acked_at: 5000, recipient: "HQ" });
    // The old table is left in place, with its rows.
    const d = new Database(join(dir, "hud.db"), { readonly: true });
    expect((d.query("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n).toBe(3);
    d.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a requests table (upstream) the copy does nothing and the columns exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-copy-"));
  try {
    await start(dir);
    const d = new Database(join(dir, "hud.db"), { readonly: true });
    expect(d.query("SELECT 1 FROM sqlite_master WHERE name = 'requests'").get()).toBeNull();
    expect((d.query("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name)).toEqual(expect.arrayContaining(["recipient", "urgent_at", "last_error", "request_id"]));
    d.close();
    expect(asks(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no code reads the requests table except the one-time copy in db.ts", () => {
  const files: string[] = [join(ROOT, "hud.ts")];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|sql)$/.test(e)) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  const reads = /\b(FROM|JOIN|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+requests\b/i;
  const hits = files.filter((f) => reads.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1));
  expect(hits).toEqual(["src/server/db.ts"]);
});
