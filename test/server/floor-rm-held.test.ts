// Removing a floor whose HQ never took its messages: the floor goes, and what was held for its HQ moves to the first
// floor's HQ, marked as meant for the removed floor (or, if already read, is dropped), with an event line saying so.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-floor-rm-"));
const log = join(DATA, "prompts.log");
let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  const herdr = join(DATA, "herdr");
  // only HQ runs; "ghost" (the test floor's HQ) never starts
  writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w1:p1","agent":"claude","workspace_id":"w1","cwd":"/tmp"},{"name":"ghost","agent_status":"idle","pane_id":"w1:p2","agent":"claude"}]}}' ;;
  "agent prompt") [ "$3" = hq ] || { echo '{"error":{"code":"agent_not_found","message":"agent target $3 not found"}}' >&2; exit 1; }; printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
  chmodSync(herdr, 0o755);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0" } });
  await post("/api/sync");
  expect((await post("/api/floors", { id: "test", name: "Test", hq: "ghost" })).status).toBe(200);
  // the test floor's HQ then goes away before taking anything
  writeFileSync(herdr, readFileSync(herdr, "utf8").replace(',{"name":"ghost","agent_status":"idle","pane_id":"w1:p2","agent":"claude"}', ""));
  await post("/api/sync");
});
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});
const post = (path: string, body: unknown = {}) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);

test("a floor with no lanes goes even with a held note; the note goes to the first floor's HQ, marked", async () => {
  await post("/api/notes", { text: "hey", floor: "test" });
  await post("/api/notes", { text: "already read", floor: "test" });
  const notes = (await state()).notes;
  // acked the way `hud ack n:ID --all` does: the note is on another floor than the caller's
  expect((await post(`/api/notes/${notes.find((n: any) => n.text === "already read").id}/ack`, { floor: "all" })).status).toBe(200);
  const res = await post("/api/floors/test", { rm: true });
  expect(res.status).toBe(200);
  const s = await state();
  expect(s.floors.map((f: any) => f.id)).toEqual(["hq"]);
  expect(s.events.some((e: any) => /floor test removed: 1 held message moved to hq, 2 dropped \(already read, or only for its HQ\)/.test(e.text))).toBe(true);
  await post("/api/hq/check");
  for (let i = 0; i < 80 && !prompts().some((p) => p.includes("hey")); i++) await Bun.sleep(25);
  const got = prompts().find((p) => p.includes("hey"));
  expect(got).toContain("meant for floor Test, whose HQ never got it");
  expect(prompts().some((p) => p.includes("already read"))).toBe(false);
});
