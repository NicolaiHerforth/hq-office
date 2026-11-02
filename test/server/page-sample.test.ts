// THE PAGE RUNTIME's sample (src/server/page-sample.ts) with a stand-in for HUD_SAMPLE_CMD: the prompt goes to the
// command on stdin, masked; the command runs in an empty folder of its own with HUD_SAMPLE_TIER and HUD_SAMPLE_PAGE;
// the answer streams back as it is printed, masked; a failing, silent or too long command, a cancelled call, and the
// limits (prompt size, two at once, ten a minute per page). Off without the setting: tested in page-runtime.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-page-sample-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);
const SECRET = "sample-secret-value-4k8d";
const CMD = join(DATA, "model.sh");
writeFileSync(CMD, `#!/bin/sh
p=$(cat)
case "$p" in
  *FAIL*) echo "boom" >&2; exit 3;;
  *EMPTY*) exit 0;;
  *SLOW*) printf 'one '; sleep 0.3; printf 'two '; sleep 0.3; printf 'three'; exit 0;;
  *LONG*) yes x | head -c 150000; exit 0;;
  *HANG*) sleep 20; echo late; exit 0;;
  *LEAK*) printf 'the key is ${SECRET}'; exit 0;;
esac
printf 'tier=%s page=%s files=%s\\n%s' "$HUD_SAMPLE_TIER" "$HUD_SAMPLE_PAGE" "$(ls -A | wc -l | tr -d ' ')" "$p"
`);
chmodSync(CMD, 0o755);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = (p: string, b: object, signal?: AbortSignal) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b), signal });
// The answer's lines, as the bridge reads them.
async function ask(page: string, input: unknown, tier?: string) {
  const r = await post("/api/page-runtime/sample", { page, input, tier });
  if (!r.ok) return { status: r.status, ...(await r.json()) };
  const lines = (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: 200, lines, last: lines.at(-1) };
}

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_SAMPLE_CMD: `sh ${CMD}` } });
  await post("/api/secrets", { name: "SAMPLE_TEST", value: SECRET, minutes: 60, by: "owner" });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("the prompt reaches the command, masked, in an empty folder, with its tier and page; the answer comes back", async () => {
  expect((await (await fetch(`${server.base}/api/state`)).json()).pageSample).toBe(true);
  const r = await ask("briefs/1", `What is ${SECRET}?`, "quick");
  expect(r.last).toEqual({ text: "tier=quick page=briefs/1 files=0\nWhat is [secret SAMPLE_TEST]?", done: true, truncated: false, tier: "quick" });
  // a conversation, ending with the user
  const c = await ask("briefs/2", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "and?" }], "nonsense");
  expect(c.last.text).toBe("tier=default page=briefs/2 files=0\nUser: hi\n\nAssistant: hello\n\nUser: and?");
  // the answer is masked too
  expect((await ask("briefs/3", "LEAK")).last.text).toBe("the key is [secret SAMPLE_TEST]");
});

test("it streams: the whole answer so far, then done", async () => {
  const r = await ask("briefs/4", "SLOW");
  expect(r.lines.length).toBeGreaterThan(1);
  expect(r.lines.slice(0, -1).every((l: { text: string; done?: boolean }) => !l.done && "one two three".startsWith(l.text))).toBe(true);
  expect(r.last).toMatchObject({ text: "one two three", done: true });
});

test("a command that fails, says nothing or says too much", async () => {
  expect((await ask("briefs/5", "FAIL")).last).toMatchObject({ code: "upstream_error", error: expect.stringContaining("boom") });
  expect((await ask("briefs/5", "EMPTY")).last).toMatchObject({ code: "empty_completion" });
  const long = await ask("briefs/5", "LONG");
  expect(long.last).toMatchObject({ done: true, truncated: true });
  expect(long.last.text.length).toBeLessThanOrEqual(100_000);
});

test("limits: the input, the prompt's size, two at once, and a cancelled call frees its place", async () => {
  expect(await ask("briefs/6", [{ role: "assistant", content: "x" }])).toMatchObject({ status: 400, code: "invalid_request" });
  expect(await ask("briefs/6", "   ")).toMatchObject({ status: 400, code: "invalid_request" });
  expect(await ask("briefs/6", "x".repeat(200_001))).toMatchObject({ status: 400, code: "prompt_too_large" });
  expect(await ask("state", "hi")).toMatchObject({ status: 400 });
  const a = new AbortController(), b = new AbortController();
  const one = post("/api/page-runtime/sample", { page: "briefs/7", input: "HANG" }, a.signal).catch(() => null);
  const two = post("/api/page-runtime/sample", { page: "briefs/8", input: "HANG" }, b.signal).catch(() => null);
  await Bun.sleep(300);
  expect(await ask("briefs/9", "hi")).toMatchObject({ status: 400, code: "rate_limited" });
  a.abort();
  b.abort();
  await Promise.all([one, two]);
  await Bun.sleep(1500); // the next quiet-line write finds the connection closed
  expect((await ask("briefs/9", "hi")).last.done).toBe(true);
}, 30_000);

test("ten a minute for a page", async () => {
  for (let i = 0; i < 10; i++) expect((await ask("briefs/10", "hi")).status).toBe(200);
  expect(await ask("briefs/10", "hi")).toMatchObject({ status: 400, code: "rate_limited" });
  expect((await ask("briefs/11", "hi")).status).toBe(200);
});
