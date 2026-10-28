// HQ's name, given back quietly. herdr drops an agent's name when another session reports itself for its pane (a
// background job started from HQ's pane compacting), though HQ's process is still there. The server remembers HQ's
// pane and gives the name back on the next sync, or at once when a delivery finds it gone; never to a pane whose
// occupant changed. A stub herdr plays HQ: "up" (named), "dropped" (the same claude, unnamed), "replaced" (a codex
// in the pane), "gone" (nothing in the pane).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-heal-test-"));
const herdr = join(data, "herdr");
const mode = join(data, "mode");
const log = join(data, "prompts.log");
const renames = join(data, "renames.log");
writeFileSync(
  herdr,
  `#!/bin/sh
M=$(cat "${mode}")
case "$1 $2" in
  "agent list")
    case "$M" in
      up) echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
      dropped) echo '{"result":{"agents":[{"agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
      replaced) echo '{"result":{"agents":[{"agent_status":"idle","pane_id":"w8:p1","agent":"codex"}]}}' ;;
      *) echo '{"result":{"agents":[]}}' ;;
    esac ;;
  "agent prompt")
    [ "$M" = up ] || { echo '{"error":{"code":"agent_not_found","message":"agent target hq not found"}}' >&2; exit 1; }
    printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
  "agent rename")
    echo "$3 $4" >> "${renames}"
    [ "$3 $4" = "w8:p1 hq" ] && echo up > "${mode}" ;;
esac
exit 0
`,
);
chmodSync(herdr, 0o755);
writeFileSync(mode, "up");

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}) =>
  (await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) })).json();
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
const renamed = () => (existsSync(renames) ? readFileSync(renames, "utf8").trim().split("\n").filter(Boolean) : []);
const until = async (ok: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 80; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
};

test("the name dropped while HQ stays in its pane: the next sync gives it back, and the page never says a thing", async () => {
  await post("/api/sync");
  writeFileSync(mode, "dropped");
  const link = await post("/api/hq/check");
  expect(link).toMatchObject({ ok: true, reason: null, held: [] });
  expect(renamed()).toEqual(["w8:p1 hq"]);
  expect((await state()).events.some((e: any) => e.text === "herdr dropped HQ's name; gave it back to pane w8:p1")).toBe(true);
  expect((await state()).events.some((e: any) => e.text.startsWith("HQ isn't receiving"))).toBe(false);
});

// A plain note waits in HQ's queue and is never typed into its pane; an urgent one types its line there, so it is the
// one a dropped name could hold up.
test("an urgent note sent in the gap before the sync is delivered, without ever showing as held", async () => {
  writeFileSync(mode, "dropped");
  const seen: unknown[] = [];
  await post("/api/notes", { text: "in the gap", urgent: true });
  await until(async () => {
    const s = await state();
    seen.push(s.hq.reason, ...s.hq.held);
    return prompts().some((p) => p.includes("in the gap"));
  });
  expect(seen.filter(Boolean)).toEqual([]);
  expect(renamed()).toEqual(["w8:p1 hq", "w8:p1 hq"]);
});

test("another agent in HQ's pane is never given the name: the page asks the owner instead", async () => {
  writeFileSync(mode, "replaced");
  const link = await post("/api/hq/check");
  expect(link.ok).toBe(false);
  expect(link.reason).toBe('no agent in herdr is named "hq"');
  expect(renamed()).toHaveLength(2);
});

test("once HQ's pane has been empty, an agent back in it is not assumed to be HQ", async () => {
  writeFileSync(mode, "up");
  await post("/api/hq/check");
  writeFileSync(mode, "gone");
  await post("/api/hq/check");
  writeFileSync(mode, "dropped");
  const link = await post("/api/hq/check");
  expect(link.ok).toBe(false);
  expect(link.candidate).toEqual({ pane: "w8:p1", agent: "claude" }); // the NAME button still offers it
  expect(renamed()).toHaveLength(2);
});
