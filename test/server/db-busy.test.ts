// The server waits out another writer's lock on hud.db (a fixture's setup, a second process) instead of failing the
// request or a background write with "database is locked".
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { office } from "./office.ts";

const o = await office();
afterAll(async () => {
  await o.stop();
  o.remove();
});

test("a write that meets another connection's short lock waits for it and goes through", async () => {
  const other = new Database(join(o.data, "hud.db"));
  other.exec("BEGIN IMMEDIATE");
  const asked = o.send("/api/asks", { title: "Asked while locked", kind: "info" });
  await Bun.sleep(300);
  other.exec("COMMIT");
  other.close();
  const res = await asked;
  expect(await res.text()).not.toContain("locked");
  expect(res.status).toBe(200);
  expect((await o.state()).open.map((a: any) => a.title)).toContain("Asked while locked");
});
