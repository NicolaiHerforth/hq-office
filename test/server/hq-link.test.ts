// HQ's link: the server checks on every sync that an agent named hq can take input, says so on the page at once when
// it cannot, holds what is meant for HQ, and sends it in order once HQ is back. A stub herdr plays HQ: its mode file
// says whether HQ is there ("up"), lost its name ("unnamed"), is stopped at a prompt ("blocked") or herdr fails ("down").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-link-test-"));
const herdr = join(data, "herdr");
const mode = join(data, "mode");
const log = join(data, "prompts.log");
writeFileSync(
  herdr,
  `#!/bin/sh
M=$(cat "${mode}")
case "$1 $2" in
  "agent list")
    [ "$M" = down ] && { echo '{"error":{"code":"server_unavailable","message":"no herdr server"}}' >&2; exit 1; }
    case "$M" in
      up) echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
      blocked) echo '{"result":{"agents":[{"name":"hq","agent_status":"blocked","pane_id":"w8:p1","agent":"claude"}]}}' ;;
      *) echo '{"result":{"agents":[{"agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
    esac ;;
  "agent prompt")
    [ "$M" = up ] || { echo '{"error":{"code":"agent_not_found","message":"agent target hq not found"}}' >&2; exit 1; }
    printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
  "agent rename")
    [ "$3 $4" = "w8:p1 hq" ] && echo up > "${mode}" ;;
esac
exit 0
`,
);
chmodSync(herdr, 0o755);
writeFileSync(mode, "up");

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return res.json();
};
const hq = async () => (await (await fetch(`${server.base}/api/state`)).json()).hq;
const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
const until = async (ok: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 80; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
};
// Tell HQ goes to HQ's queue; only an URGENT one types a line into HQ's pane, so these tests send urgent notes.
const urgent = (text: string) => post("/api/notes", { text, urgent: true });
const askRef = async (text: string) => `ask:${(await (await fetch(`${server.base}/api/requests`)).json()).find((r: any) => r.text === text).id}`;

test("with HQ there, the page says nothing, a plain note waits in the queue and an urgent one is typed in", async () => {
  await post("/api/sync");
  expect(await hq()).toMatchObject({ ok: true, reason: null, held: [] });
  await post("/api/notes", { text: "plain" });
  await urgent("first");
  await until(() => prompts().some((p) => p.includes("first")));
  expect(prompts().some((p) => p.includes("plain"))).toBe(false);
});

test("herdr dropped HQ's name: the sync says so before anything is sent, and offers HQ's last pane", async () => {
  writeFileSync(mode, "unnamed");
  await post("/api/sync");
  const link = await hq();
  expect(link.ok).toBe(false);
  expect(link.reason).toBe('no agent in herdr is named "hq"');
  expect(link.since).toBeGreaterThan(0);
  expect(link.candidate).toEqual({ pane: "w8:p1", agent: "claude" });
});

test("what the owner sends meanwhile is held, in order, and marked held", async () => {
  await urgent("hello?");
  await urgent("anyone there?");
  const refs = [await askRef("hello?"), await askRef("anyone there?")];
  await until(async () => (await hq()).held.length === 2);
  expect((await hq()).held.map((h: any) => h.ref)).toEqual(refs);
  expect(prompts().some((p) => p.includes("hello?"))).toBe(false);
});

test("naming HQ's pane again sends what was held, oldest first", async () => {
  const link = await post("/api/hq/name");
  expect(link.ok).toBe(true);
  await until(async () => (await hq()).held.length === 0);
  const sent = prompts();
  const a = sent.findIndex((p) => p.includes("hello?"));
  const b = sent.findIndex((p) => p.includes("anyone there?"));
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
});

test("a note HQ already read from its inbox while held is not typed in again", async () => {
  writeFileSync(mode, "unnamed");
  await post("/api/sync");
  await urgent("read it in the inbox");
  const ref = await askRef("read it in the inbox");
  await until(async () => (await hq()).held.some((h: any) => h.ref === ref));
  await post("/api/hq/check"); // waits out the attempt to type it in, which fails while HQ has no name
  await post(`/api/requests/${ref.split(":")[1]}/answer`, { text: "got it" }); // HQ read it from its queue
  writeFileSync(mode, "up");
  await post("/api/hq/check");
  await until(async () => (await hq()).held.length === 0);
  expect(prompts().some((p) => p.includes("read it in the inbox"))).toBe(false);
});

test("HQ stopped at a prompt is not receiving", async () => {
  writeFileSync(mode, "blocked");
  const link = await post("/api/hq/check");
  expect(link.ok).toBe(false);
  expect(link.reason).toContain("stopped at a prompt");
});

test("herdr not answering is not receiving, with herdr's reason", async () => {
  writeFileSync(mode, "down");
  const link = await post("/api/hq/check");
  expect(link.ok).toBe(false);
  expect(link.reason).toContain("herdr did not answer");
  writeFileSync(mode, "up");
  expect((await post("/api/hq/check")).ok).toBe(true);
});
