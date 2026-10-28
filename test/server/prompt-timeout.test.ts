// promptAgent with a timeout kills a herdr that is still running, so a queue answer recorded as not delivered never
// lands in the lane's pane later (a retry would then type it twice). Own process, own data dir, a fake herdr that
// sleeps before it "types".
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-office-prompt-timeout-"));
const TYPED = join(DATA, "typed");
const HERDR = join(DATA, "herdr");
writeFileSync(HERDR, `#!/bin/sh\nsleep 1\necho "$@" > "${TYPED}"\n`);
chmodSync(HERDR, 0o755);
afterAll(() => rmSync(DATA, { recursive: true, force: true }));

const run = async (code: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn([process.execPath, "-e", `${code} process.exit(0);`], { cwd: ROOT, env: { ...process.env, HUD_DATA_DIR: DATA, HERDR_BIN: HERDR, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out.trim().split("\n").pop()!);
};
const src = (file: string) => JSON.stringify(join(ROOT, "src/server", file));
const prompt = (timeoutMs: string) =>
  run(`const { promptAgent } = await import(${src("herdr.ts")});
    console.log(JSON.stringify(await promptAgent("some-lane", "the answer", null, { timeoutMs: ${timeoutMs} })));`);

test("a herdr still running at the timeout is killed and reported, and types nothing later", async () => {
  expect(await prompt("200")).toEqual({ ok: false, error: "herdr did not answer in time" });
  await Bun.sleep(1500);
  expect(existsSync(TYPED)).toBe(false);
});

test("without a timeout the same herdr finishes and types", async () => {
  expect(await prompt("undefined")).toEqual({ ok: true });
  expect(existsSync(TYPED)).toBe(true);
});

// The queue's delivery passes its timeout on: without it, the same slow herdr would type the answer.
test("the queue's delivery to a lane stops at its timeout, and types nothing later", async () => {
  rmSync(TYPED, { force: true });
  const result = await run(
    `await import(${src("herdr.ts")});
    const { db } = await import(${src("db.ts")});
    db.query("INSERT INTO agents (name, machine, pane, status, since, seen) VALUES ('some-lane', 'here', 'w1:p1', 'idle', 0, 0)").run();
    const { herdrDeliver } = await import(${src("queue.ts")});
    console.log(JSON.stringify(await herdrDeliver("some-lane", "the answer")));`,
    { HUD_DELIVER_TIMEOUT_MS: "200" },
  );
  expect(result).toEqual({ ok: false, error: "herdr did not answer in time" });
  await Bun.sleep(1500);
  expect(existsSync(TYPED)).toBe(false);
});
