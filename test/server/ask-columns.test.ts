// Floors v4 adds columns to asks and ask_comments (handed_by, room, author, to_lane, delivery, error). A database made before them keeps
// every row, and the old rows read as they did: never deferred, handed in by nobody, naming no room, written by HQ.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { office, ROOT } from "./office.ts";

const data = mkdtempSync(join(tmpdir(), "hq-columns-test-"));
afterAll(() => Bun.spawnSync(["rm", "-rf", data]));

test("the migration keeps an old database's rows and adds the columns", async () => {
  const old = new Database(join(data, "hud.db"), { create: true });
  // The tables as they were: the schema files, none of the later ALTERs.
  for (const f of ["asks", "ask_comments"]) old.exec(readFileSync(join(ROOT, "src/server/schema", `${f}.sql`), "utf8"));
  old.query("INSERT INTO asks (lane, title, created_at) VALUES ('app', 'Old question', 1000)").run();
  old.query("INSERT INTO ask_comments (ask_id, at, text) VALUES (1, 2000, 'old comment')").run();
  old.close();

  for (let round = 0; round < 2; round++) {
    // The second round is a restart on the migrated file: the migration is idempotent.
    const o = await office({ data });
    const s = await o.state();
    expect(s.open.map((a: any) => [a.title, a.defer_until, a.handed_by, a.room])).toEqual([["Old question", null, null, null]]);
    await o.stop();
    const db = new Database(join(data, "hud.db"), { readonly: true });
    expect(db.query("SELECT text, author, to_lane, delivery, error FROM ask_comments").all()).toEqual([{ text: "old comment", author: null, to_lane: null, delivery: null, error: null }]);
    db.close();
  }
});
