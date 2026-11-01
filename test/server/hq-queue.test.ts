// THE HQ QUEUE, against a server with a stub herdr in which HQ runs session "sess-hq" in pane w1:p1 and two lanes run.
// Off (the default) changes nothing. On: HQ's hook holds a typed message only once it is stored, lets the HUD's own
// lines, commands and URGENT through, adds the count line, keeps HQ from stopping while something is unread; HQ reads
// with hud req next and answers into the lane's pane; the owner's notes queue too; an idle HQ is prompted; the input
// box is cleared only when it holds that message. The hook fails open: a HUD that is down, slow or erring holds nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-queue-"));
const HQ = { name: "hq", agent_status: "working", pane_id: "w1:p1", agent: "claude", agent_session: { value: "sess-hq" } };
const herdr = fakeHerdr(DATA, [HQ, { name: "api", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "docs", agent_status: "idle", pane_id: "w1:p3", agent: "codex" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}, h: Record<string, string> = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string, h: Record<string, string> = {}) => (await fetch(`${server.base}${p}`, { headers: h })).json();
const hook = (event: string, extra: object = {}, session = "sess-hq") => post("/api/queue/hook", { event, session_id: session, ...extra });
const asHq = { "x-hud-pane": "w1:p1", "x-hud-machine": "local" };
const hud = (args: string[], pane = "w1:p1") => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const until = async (ok: () => boolean | Promise<boolean>, what: string) => { for (let i = 0; i < 200; i++) { if (await ok()) return; await Bun.sleep(25); } throw new Error(`timed out waiting for ${what}`); };
const sendKeys = () => herdr.calls().filter((c) => c[0] === "agent" && c[1] === "send-keys");
const setHq = (status: string) => herdr.world(herdr.agents().map((a) => (a.name === "hq" ? { ...a, agent_status: status } : a)));

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HOME: DATA, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_QUEUE_CLEAR_MS: "50", HUD_QUEUE_KICK_MS: "600000" } });
  for (const name of ["api", "docs"]) await post("/api/lanes", { name, machine: "local" });
  await post("/api/sync");
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("off, the default: the hook does nothing, a note is typed into HQ, hud request types into HQ's pane", async () => {
  expect((await get("/api/state")).queue).toEqual({ on: false, hook: false, floors: {} });
  expect(await hook("UserPromptSubmit", { prompt: "api: can I go ahead?" })).toEqual({ status: 200 });
  expect(await hook("Stop")).toEqual({ status: 200 });
  await post("/api/notes", { text: "Ship it today." });
  await until(() => herdr.typedInto("hq").some((t) => t.includes("HUD note from") && t.includes("Ship it today.")), "the note typed in");
  const r = hud(["request", "build is green, merging"], "w1:p2");
  expect(r.stdout.toString()).toContain("sent to HQ");
  expect(herdr.typedInto("hq").some((t) => t === "From api: build is green, merging")).toBe(true);
  expect(sendKeys()).toEqual([]);
});

test("on: a lane's typed message is stored, then held back; who sent it is read from 'name:'", async () => {
  expect((await post("/api/settings", { settings: { hqQueue: true } })).status).toBe(200);
  writeFileSync(join(DATA, "block-start"), "────\n❯ api: can I go ahead with A4?\n────\n");
  const r = await hook("UserPromptSubmit", { prompt: "api: can I go ahead with A4?" });
  expect(r.output.decision).toBe("block");
  expect(r.output.reason).toMatch(/^Queued for HQ as #\d+/);
  const { items } = await get("/api/queue", asHq);
  expect(items[0]).toMatchObject({ from_name: "api", text: "api: can I go ahead with A4?", via: "hook", read_at: null });
  // Claude puts a held prompt back in the input box: cleared, since the box holds exactly that message
  await until(() => sendKeys().length === 1, "ctrl+u");
  expect(sendKeys()[0]).toEqual(["agent", "send-keys", "hq", "ctrl+u"]);
  // a message from someone herdr does not know is from "unknown"; the box holds other text: not cleared
  writeFileSync(join(DATA, "block-start"), "────\n❯ something the owner is typing\n────\n");
  await hook("UserPromptSubmit", { prompt: "the build is red on main, see CI" });
  await Bun.sleep(300);
  expect(sendKeys().length).toBe(1);
  expect((await get("/api/queue", asHq)).items[0]).toMatchObject({ from_name: "unknown" });
});

test("the HUD's own lines, slash commands and URGENT go straight through, with the count line; other sessions get nothing", async () => {
  for (const prompt of ["HUD note from Robin: hi", "HUD sweep: idle lanes 2", "/compact", "URGENT from api: main is red"]) {
    const r = await hook("UserPromptSubmit", { prompt });
    expect(r.output).toBeUndefined();
    expect(r.text).toMatch(/^HQ QUEUE: 2 unread \(oldest (now|\dm), from api\)/);
  }
  expect(await hook("UserPromptSubmit", { prompt: "api: hello" }, "sess-a-lane")).toEqual({ status: 200 });
  expect(await hook("UserPromptSubmit", { prompt: "api: hello" }, "")).toEqual({ status: 200 });
  expect((await get("/api/queue", asHq)).items.length).toBe(2);
});

test("every tool call carries the line; HQ may not stop while something is unread", async () => {
  const t = await hook("PostToolUse");
  expect(t.output.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse" });
  expect(t.output.hookSpecificOutput.additionalContext).toContain("2 unread");
  const s = await hook("Stop", { stop_hook_active: true });
  expect(s.output.decision).toBe("block");
  expect(s.output.reason).toContain("hud req next");
});

test("hud req next reads the oldest; a lane's item stays open until answered, named in the line with its age", async () => {
  const n = hud(["req", "next"]);
  expect(n.stderr.toString()).toBe("");
  expect(n.stdout.toString()).toMatch(/^#\d+ from api, (now|\dm ago):\napi: can I go ahead with A4\?/);
  expect(n.stdout.toString()).toContain("hud req answer");
  expect(n.stdout.toString()).toContain("1 more unread");
  const line = (await get("/api/queue/line", asHq)).line;
  expect(line).toMatch(/1 unread .* · waiting for your answer: #\d+ api, (now|\dm) \("api: can I go ahead with A4\?"\)/);
  // the unknown one: read, then closed
  const second = hud(["req", "next"]).stdout.toString();
  const id2 = second.match(/^#(\d+)/)![1];
  expect(hud(["req", "close", id2, "dup of the CI alert"]).stdout.toString()).toContain(`closed #${id2}`);
  expect((await hook("Stop")).output).toBeUndefined(); // nothing unread: HQ may stop
});

test("hud req answer types the answer into the lane's pane and closes the item", async () => {
  const id = (await get("/api/queue", asHq)).items.find((i: any) => i.from_name === "api").id;
  const a = hud(["req", "answer", String(id), "Yes, A4 first."]);
  expect(a.stdout.toString()).toContain(`answered #${id}: sent to api`);
  await until(() => herdr.typedInto("api").some((t) => t.startsWith(`HQ answered your message #${id} (`) && t.endsWith("Yes, A4 first.")), "the answer typed into api");
  expect((await get("/api/queue/line", asHq)).line).toBeNull();
  expect(hud(["req", "answer", String(id), "again"]).exitCode).not.toBe(0);
});

test("the owner's Tell HQ waits in the queue (its mark says so); URGENT types it in; HQ's answer is an update", async () => {
  const before = herdr.typedInto("hq").length;
  await post("/api/notes", { text: "Please look at the pricing copy." });
  await until(async () => Object.values((await get("/api/state")).hq.deliveries).includes("queued"), "the note queued");
  expect(herdr.typedInto("hq").length).toBe(before);
  const n = hud(["req", "next"]).stdout.toString();
  expect(n).toContain("from the owner");
  expect(n).toContain("Please look at the pricing copy.");
  const id = n.match(/^#(\d+)/)![1];
  await until(async () => Object.values((await get("/api/state")).hq.deliveries).includes("delivered"), "the note read");
  hud(["req", "answer", id, "Done, see the room."]);
  const s = await get("/api/state");
  expect(s.updates.some((u: any) => u.title === "Re: Please look at the pricing copy." && u.body === "Done, see the room.")).toBe(true);
  expect(s.notes.find((x: any) => x.text === "Please look at the pricing copy.")?.acked_at).toBeGreaterThan(0); // HQ answered it: acked
  await post("/api/notes", { text: "Stop the deploy.", urgent: true });
  await until(() => herdr.typedInto("hq").some((t) => t.startsWith("HUD note from") && t.includes("(URGENT): Stop the deploy.")), "the urgent note typed in");
});

test("an idle HQ with something unread is prompted once per new item", async () => {
  setHq("idle");
  await post("/api/sync");
  await hook("UserPromptSubmit", { prompt: "docs: the docs build is done" });
  const prompted = () => herdr.typedInto("hq").filter((t) => t.startsWith("HUD queue: HQ QUEUE: 1 unread")).length;
  await post("/api/sync");
  await until(() => prompted() === 1, "the kick");
  await post("/api/sync");
  await Bun.sleep(200);
  expect(prompted()).toBe(1);
  setHq("working");
  await post("/api/sync");
});

test("off again removes the effect: nothing held, no line, no Stop block, no clearing", async () => {
  await post("/api/settings", { settings: { hqQueue: false } });
  const keys = sendKeys().length;
  writeFileSync(join(DATA, "block-start"), "────\n❯ api: one more\n────\n");
  expect(await hook("UserPromptSubmit", { prompt: "api: one more" })).toEqual({ status: 200 });
  expect(await hook("PostToolUse")).toEqual({ status: 200 });
  expect(await hook("Stop")).toEqual({ status: 200 });
  await Bun.sleep(300);
  expect(sendKeys().length).toBe(keys);
  expect((await get("/api/state")).queue.on).toBe(false);
});

// The hook script itself, as Claude Code runs it: event JSON on stdin, decision on stdout, always exit 0.
const runHook = (input: object, url: string, ms?: string) => Bun.spawnSync([process.execPath, join(ROOT, "bin", "hq-queue-hook.ts")], { env: { ...process.env, HUD_URL: url, HERDR_PANE_ID: "w1:p1", ...(ms ? { HUD_QUEUE_HOOK_MS: ms } : {}) }, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });

test("the hook script holds a prompt only when the HUD answers that it stored it", async () => {
  await post("/api/settings", { settings: { hqQueue: true } });
  const r = runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-hq", prompt: "api: ready for review" }, server.base);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout.toString())).toMatchObject({ decision: "block" });
  expect((await get("/api/queue", asHq)).items.some((i: any) => i.text === "api: ready for review")).toBe(true);
});

test("fail open: a HUD that is down, slow or erring holds nothing, and the hook exits 0 quickly", async () => {
  const input = { hook_event_name: "UserPromptSubmit", session_id: "sess-hq", prompt: "api: please merge" };
  // down
  const down = runHook(input, "http://127.0.0.1:9");
  expect([down.exitCode, down.stdout.toString()]).toEqual([0, ""]);
  // slow: answers after 3 s
  const slow = Bun.serve({ port: 0, fetch: async () => { await Bun.sleep(3000); return Response.json({ output: { decision: "block", reason: "late" } }); } });
  const t0 = Date.now();
  const s = runHook(input, `http://127.0.0.1:${slow.port}`, "500");
  expect([s.exitCode, s.stdout.toString()]).toEqual([0, ""]);
  expect(Date.now() - t0).toBeLessThan(2500);
  slow.stop(true);
  // erring: a 500, and a 200 that is not JSON
  const bad = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).search ? new Response("oops", { status: 200 }) : Response.json({ error: "boom" }, { status: 500 })) });
  const e = runHook(input, `http://127.0.0.1:${bad.port}`);
  expect([e.exitCode, e.stdout.toString()]).toEqual([0, ""]);
  const g = runHook(input, `http://127.0.0.1:${bad.port}/?x`.replace("/?x", "") + "/?x");
  expect([g.exitCode, g.stdout.toString()]).toEqual([0, ""]);
  bad.stop(true);
  // a store that fails on the HUD (an empty prompt has nothing to queue) is not a hold either
  const empty = runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-hq", prompt: "   " }, server.base);
  expect(empty.stdout.toString()).not.toContain("block");
});
