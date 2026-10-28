// The queue hook for HQ's Claude Code session: its output for each event against a stub server, and that it
// always ends fast and quietly, with the server down or answering slowly.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MIN = 60_000;
let items: unknown = [];
let delay = 0;
let seenUrl = "";
let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    seenUrl = new URL(req.url).pathname + new URL(req.url).search;
    if (delay) await Bun.sleep(delay);
    return Response.json(items);
  } });
});
afterAll(() => stub.stop(true));

const item = (minutesAgo: number, urgent = false) => ({ created_at: Date.now() - minutesAgo * MIN, urgent_at: urgent ? Date.now() : null });

async function run(event: Record<string, unknown>, url = `http://127.0.0.1:${stub.port}`, env: Record<string, string> = {}) {
  const t0 = performance.now();
  const proc = Bun.spawn([process.execPath, "bin/hq-queue-hook.ts"], { cwd: ROOT, env: { ...process.env, HUD_URL: url, HUD_LEAD: "HQ", ...env }, stdin: new Blob([JSON.stringify(event)]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err, code, ms: performance.now() - t0 };
}
const prompt = { hook_event_name: "UserPromptSubmit", prompt: "go on" };

test("an empty queue prints nothing on every event", async () => {
  items = [];
  for (const hook_event_name of ["UserPromptSubmit", "PostToolUse", "Stop"]) expect(await run({ hook_event_name, stop_hook_active: false })).toMatchObject({ out: "", code: 0 });
});

test("three items: one line with the count and the age of the oldest; HQ's queue is asked for", async () => {
  items = [item(3), item(12), item(7)];
  const r = await run(prompt);
  expect(r).toMatchObject({ out: "HQ QUEUE 3 · oldest 12m", code: 0 });
  expect(seenUrl).toBe("/api/requests?lead=HQ");
});

test("an urgent item is counted on the line", async () => {
  items = [item(3), item(75, true), item(7)];
  expect((await run(prompt)).out).toBe("HQ QUEUE 3 · oldest 1h15m · 1 URGENT");
});

test("PostToolUse gives the line as additional context, in the documented JSON shape", async () => {
  items = [item(2), item(5, true)];
  const r = await run({ hook_event_name: "PostToolUse", tool_name: "Bash" });
  expect(JSON.parse(r.out)).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "HQ QUEUE 2 · oldest 5m · 1 URGENT" } });
});

test("Stop blocks once with the count, and lets HQ stop when it is already continuing because of the hook", async () => {
  items = [item(4), item(9)];
  const first = await run({ hook_event_name: "Stop", stop_hook_active: false });
  expect(JSON.parse(first.out)).toEqual({ decision: "block", reason: "HQ QUEUE 2 · oldest 9m. `hud req next` to read." });
  const again = await run({ hook_event_name: "Stop", stop_hook_active: true });
  expect(again).toMatchObject({ out: "", code: 0 });
});

test("without HUD_LEAD the hook is silent on every event and never asks the server", async () => {
  items = [item(3, true)];
  seenUrl = "";
  for (const hook_event_name of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    expect(await run({ hook_event_name, stop_hook_active: false }, undefined, { HUD_LEAD: "" })).toMatchObject({ out: "", err: "", code: 0 });
  }
  const unset = { ...process.env } as Record<string, string | undefined>;
  delete unset.HUD_LEAD;
  const proc = Bun.spawn([process.execPath, "bin/hq-queue-hook.ts"], { cwd: ROOT, env: { ...unset, HUD_URL: `http://127.0.0.1:${stub.port}` }, stdin: new Blob([JSON.stringify(prompt)]), stdout: "pipe", stderr: "pipe" });
  expect((await new Response(proc.stdout).text()).trim()).toBe("");
  expect(await proc.exited).toBe(0);
  expect(seenUrl).toBe("");
});

test("an orchestrator's queue is read with HUD_LEAD", async () => {
  items = [item(1)];
  const r = await run(prompt, undefined, { HUD_LEAD: "HQ2" });
  expect(r.out).toBe("HQ2 QUEUE 1 · oldest 1m");
  expect(seenUrl).toBe("/api/requests?lead=HQ2");
});

test("a server that is down prints nothing, exits 0 and finishes in under 300 ms", async () => {
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const url = `http://127.0.0.1:${dead.port}`;
  dead.stop(true);
  for (const event of [prompt, { hook_event_name: "Stop" }]) {
    const r = await run(event, url);
    expect(r).toMatchObject({ out: "", err: "", code: 0 });
    expect(r.ms).toBeLessThan(300);
  }
});

test("a server that hangs is given up on at about 150 ms", async () => {
  items = [item(5)];
  delay = 3000;
  try {
    const r = await run(prompt);
    expect(r).toMatchObject({ out: "", code: 0 });
    expect(r.ms).toBeLessThan(300);
  } finally {
    delay = 0;
  }
});

test("a bad answer or no input is never an error", async () => {
  items = { error: "not a list" };
  expect(await run(prompt)).toMatchObject({ out: "", code: 0 });
  items = [item(5)];
  const proc = Bun.spawn([process.execPath, "bin/hq-queue-hook.ts"], { cwd: ROOT, env: { ...process.env, HUD_URL: `http://127.0.0.1:${stub.port}` }, stdin: new Blob(["not json"]), stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
});
