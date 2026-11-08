// The owner's answer is answered without waiting on herdr: with a herdr whose `agent prompt` never returns, the POST still
// comes back. And a write that touches neither the board nor the machines pushes neither: the page counts their ages
// from their times, so a push carries what changed, not the clock.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-answer-path-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = (path: string, body: object, signal?: AbortSignal) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body), signal }).then((r) => r.json());
const state = () => fetch(`${server.base}/api/state`).then((r) => r.json());
const until = async (check: () => Promise<boolean> | boolean, what: string) => { for (let i = 0; i < 100; i++) { if (await check()) return; await Bun.sleep(100); } throw new Error(`never: ${what}`); };

beforeAll(async () => {
  fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "p-hq", agent: "claude" }]);
  // The fake herdr, except that typing into a pane never finishes.
  const hanging = join(dir, "herdr-hanging");
  writeFileSync(hanging, `#!/bin/sh\nif [ "$1 $2" = "agent prompt" ]; then echo "$4" >> "${dir}/prompted.log"; while :; do sleep 1; done; fi\nexec "${join(dir, "herdr")}" "$@"\n`);
  chmodSync(hanging, 0o755);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: join(dir, "subs"), HERDR_BIN: hanging, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_STATS_MS: "3600000" } });
  await until(async () => (await state()).hq?.ok === true, "herdr shows HQ");
});
afterAll(async () => {
  await server?.stop();
  Bun.spawnSync(["pkill", "-KILL", "-f", dir]);
  rmSync(dir, { recursive: true, force: true });
});

test("an answer comes back while herdr is still typing it into HQ", async () => {
  const { id } = await post("/api/asks", { title: "Ship it?", kind: "action" });
  expect(await post(`/api/asks/${id}/answer`, { answer: "done" }, AbortSignal.timeout(3_000))).toEqual({ ok: true });
  await until(() => existsSync(join(dir, "prompted.log")) && readFileSync(join(dir, "prompted.log"), "utf8").includes(`#${id}`), "herdr was asked to type the answer");
  expect((await state()).open.map((a: { id: number }) => a.id)).not.toContain(id);
});

test("a write that touches neither the board nor the machines pushes neither", async () => {
  await until(async () => !!(await state()).machines?.[0]?.sample, "the machine sample");
  const res = await fetch(`${server.base}/api/stream`);
  const reader = res.body!.getReader(), parts: string[][] = [];
  let buf = "";
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith("data: ")) parts.push(Object.keys(JSON.parse(buf.slice(6, i))));
    }
  })();
  await until(() => parts.length === 1, "the whole state");
  expect(parts[0]).toEqual(expect.arrayContaining(["board", "machines"]));
  for (let i = 0; i < 3; i++) {
    await post("/api/events", { who: "hq", text: `unrelated ${i}` });
    await until(() => parts.length === i + 2, `push ${i + 1}`);
  }
  await reader.cancel();
  await reading.catch(() => {});
  for (const keys of parts.slice(1)) expect(keys).not.toEqual(expect.arrayContaining(["board"])), expect(keys).not.toEqual(expect.arrayContaining(["machines"]));
});
