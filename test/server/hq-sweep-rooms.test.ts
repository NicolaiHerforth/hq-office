// The HQ sweep and rooms: a room with a message its lane has not had yet (the lane is away) is listed, and an
// archived room is not, whatever it still holds. A stub herdr as in hq-sweep.test.ts; one minute is 40 ms here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-sweep-rooms-"));
const herdr = join(data, "herdr");
const agents = join(data, "agents.json");
const log = join(data, "prompts.log");
const MINUTE = 40;
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "${agents}")" ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
// Only HQ is in herdr: the rooms' lanes are away, so what is written to them waits.
const world = (hqStatus: string) => writeFileSync(agents, JSON.stringify([{ name: "hq", agent_status: hqStatus, pane_id: "w8:p1", agent: "claude" }]));

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  world("idle");
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_SWEEP_MINUTE_MS: String(MINUTE), TZ: "UTC" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error);
  return out;
}
async function hud(args: string[]) {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base }, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(await new Response(p.stderr).text());
}
const nudges = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter((p) => p.startsWith("HUD sweep:")) : []);
const sync = () => post("/api/sync");
const wait = (minutes: number) => Bun.sleep(minutes * MINUTE);
async function settle(n: number) {
  for (let i = 0; i < 100 && nudges().length < n; i++) await Bun.sleep(20);
  await Bun.sleep(80);
  expect(nudges()).toHaveLength(n);
}

test("two rooms with a message their lane has not had: both are listed", async () => {
  for (const name of ["pm", "far"]) await post("/api/lanes", { name, machine: "local" });
  await sync(); // herdr does not list them: they are away, so what is written to them waits
  for (const slug of ["live", "shut"]) {
    await hud(["room", "create", slug, "--title", slug, "--owner", "pm", "--member", "far"]);
    await post(`/api/rooms/${slug}/post`, { text: `Are you there, ${slug}?`, to: "far" });
  }
  await post("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
  await sync();
  await settle(1);
  expect(nudges()[0]).toContain("rooms with undelivered messages 2: live, shut");
});

test("an archived room is not listed, though its message is still undelivered", async () => {
  await hud(["room", "archive", "shut"]);
  world("working");
  await sync();
  world("idle");
  await wait(21);
  await sync();
  await settle(2);
  expect(nudges()[1]).toContain("rooms with undelivered messages 1: live");
  expect(nudges()[1]).not.toContain("shut");
});
