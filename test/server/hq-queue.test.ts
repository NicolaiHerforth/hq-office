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
import { install } from "../../bin/queue-hook.ts";

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
// HQ's pane as `herdr pane read --format ansi` gives it: what is above, Claude Code's input box between two rules, the
// footer. Text in the box starts after "❯" and a no-break space and wraps two spaces in; the startup placeholder is dim;
// a long message is collapsed to a token in the box and reaches the hook wrapped as a paste.
const RULE = `\x1b[0m\x1b[38;2;136;136;136m${"─".repeat(60)}\x1b[0m`;
const paneShows = (box: string[], above: string[] = []) => writeFileSync(join(DATA, "block-start"), [...above, RULE, ...box, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)"].map((l) => `${l}\r`).join("\n"));
const boxWith = (text: string) => {
  const lines: string[] = [];
  for (const w of text.split(/\s+/)) lines.length && lines[lines.length - 1].length + w.length < 60 ? (lines[lines.length - 1] += ` ${w}`) : lines.push(w);
  return lines.map((l, i) => (i ? `  ${l}` : `❯\u00a0${l}`));
};
const EMPTY = ["❯\u00a0"];
const PLACEHOLDER = ['❯\u00a0\x1b[0m\x1b[2mTry "edit <filepath> to..."\x1b[0m'];
const PASTED = ["❯\u00a0[Pasted text #1]"];
const pasted = (t: string) => `\n\n<pasted_content id="ca69">\n${t}\n</pasted_content id="ca69">\n`;
const words = (from: string, n: number) => `${from}: ${Array.from({ length: n }, (_, i) => `w${i}`).join(" ")}`;
const itemsLike = async (start: string) => (await get("/api/queue?all=1", asHq)).items.filter((i: any) => i.text.startsWith(start));
const kicks = () => herdr.typedInto("hq").filter((t) => t.startsWith("HUD queue:"));

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HOME: DATA, HUD_QUEUE_HOOK_CHECK_MS: "0", HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_QUEUE_CLEAR_MS: "50", HUD_QUEUE_KICK_MS: "600000" } });
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

test("on, per floor: whether lane messages are held, and why not", async () => {
  expect((await post("/api/settings", { settings: { hqQueue: true } })).status).toBe(200);
  const held = async () => (await get("/api/state")).queue.floors.hq;
  expect(await held()).toMatchObject({ held: false, why: expect.stringContaining("HQ's hook is not installed") });
  install(DATA, "HUD_URL=x bun /p/bin/hq-queue-hook.ts");
  await hook("PostToolUse"); // the hook runs in HQ's session
  expect(await held()).toMatchObject({ held: true, why: "the hook last ran just now" });
  // a Claude HQ whose session the hook has not run in yet, a Codex HQ, and a Claude HQ herdr reports no session for
  herdr.world([...herdr.agents(), { name: "hq-fresh", agent_status: "idle", pane_id: "w1:p8", agent: "claude", agent_session: { value: "sess-fresh" } }, { name: "hq-plain", agent_status: "idle", pane_id: "w1:p9", agent: "claude" }]);
  await post("/api/sync");
  await post("/api/floors", { id: "fr", name: "FR", hq: "hq-fresh" });
  await post("/api/floors", { id: "cx", name: "CX", hq: "docs" });
  await post("/api/floors", { id: "ns", name: "NS", hq: "hq-plain" });
  const fl = (await get("/api/state")).queue.floors;
  expect(fl.fr).toMatchObject({ held: false, why: expect.stringContaining("has not run in HQ's session yet: restart HQ's session") });
  expect(fl.cx).toMatchObject({ held: false, why: expect.stringContaining("HQ runs codex, which has no prompt hook") });
  expect(fl.ns).toMatchObject({ held: false, why: expect.stringContaining("herdr does not report HQ's session") });
  for (const id of ["fr", "cx", "ns"]) await post(`/api/floors/${id}`, { rm: true });
});

test("on: a lane's typed message is stored, then held back; who sent it is read from 'name:'", async () => {
  setHq("idle");
  paneShows(boxWith("api: can I go ahead with A4?"));
  const r = await hook("UserPromptSubmit", { prompt: "api: can I go ahead with A4?" });
  expect(r.output.decision).toBe("block");
  expect(r.output.reason).toMatch(/^Queued for HQ as #\d+/);
  const { items } = await get("/api/queue", asHq);
  expect(items[0]).toMatchObject({ from_name: "api", text: "api: can I go ahead with A4?", via: "hook", read_at: null });
  // Claude puts a held prompt back in the input box: cleared, since the box holds exactly that message
  await until(() => sendKeys().length === 1, "ctrl+c");
  expect(sendKeys()[0]).toEqual(["agent", "send-keys", "hq", "ctrl+c"]);
  // a message from someone herdr does not know is from "unknown"; the box holds other text: not cleared
  paneShows(boxWith("something the owner is typing"));
  await hook("UserPromptSubmit", { prompt: "the build is red on main, see CI" });
  await Bun.sleep(300);
  expect(sendKeys().length).toBe(1);
  expect((await get("/api/queue", asHq)).items[0]).toMatchObject({ from_name: "unknown" });
  setHq("working");
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
  paneShows(EMPTY);
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
  paneShows(boxWith("api: one more"));
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

test("the whole box is cleared, a long one too, but only when it holds the held message and HQ is idle", async () => {
  setHq("idle");
  // a message that wraps over 8 lines, also shown above the box as Claude's "Original prompt"
  const long = words("api", 70);
  paneShows(boxWith(long), ["  Original prompt: ", ...boxWith(long).map((l) => `  ${l.slice(2)}`)]);
  let keys = sendKeys().length;
  expect((await hook("UserPromptSubmit", { prompt: long })).output.decision).toBe("block");
  await until(() => sendKeys().length === keys + 1, "ctrl+c on the 8-line box");
  expect(sendKeys().at(-1)).toEqual(["agent", "send-keys", "hq", "ctrl+c"]);
  // a message Claude collapsed: the box shows its token, the hook gets it as a paste, stored as the lane wrote it
  const huge = words("api", 300);
  paneShows(PASTED);
  keys = sendKeys().length;
  expect((await hook("UserPromptSubmit", { prompt: pasted(huge) })).output.decision).toBe("block");
  await until(() => sendKeys().length === keys + 1, "ctrl+c on the collapsed box");
  expect((await itemsLike("api: w0 w1"))[0]).toMatchObject({ from_name: "api", text: huge });
  // HQ working: ctrl+c would interrupt its turn; an empty box: ctrl+c is a step toward exiting
  keys = sendKeys().length;
  setHq("working");
  paneShows(boxWith("api: hold this one"));
  await hook("UserPromptSubmit", { prompt: "api: hold this one" });
  setHq("idle");
  paneShows(EMPTY);
  await hook("UserPromptSubmit", { prompt: "api: and this one" });
  await Bun.sleep(300);
  expect(sendKeys().length).toBe(keys);
  setHq("working");
}, 15_000);

test("Claude Code's own notifications go straight in; a later hold does not keep an earlier held message in the box", async () => {
  setHq("working");
  const msg = "api: held while HQ works";
  paneShows(boxWith(msg));
  await hook("UserPromptSubmit", { prompt: msg });
  const note = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
  expect((await hook("UserPromptSubmit", { prompt: note })).output).toBeUndefined();
  expect((await get("/api/queue?all=1", asHq)).items.some((i: any) => i.text.includes("task-notification"))).toBe(false);
  // another message held while the box still shows the first: once HQ is idle, the first is cleared
  await hook("UserPromptSubmit", { prompt: "api: a second one" });
  await Bun.sleep(200);
  setHq("idle");
  const keys = sendKeys().length, before = kicks().length;
  await post("/api/sync");
  await until(() => sendKeys().length > keys, "ctrl+c on the first held message");
  expect(sendKeys().slice(keys)).toEqual([["agent", "send-keys", "hq", "ctrl+c"]]);
  expect(kicks().length).toBe(before);
  setHq("working");
}, 15_000);

test("a held message is cleared once HQ is idle even when nothing is unread any more", async () => {
  setHq("working");
  const msg = "api: read before HQ went idle";
  paneShows(boxWith(msg));
  const id = Number((await hook("UserPromptSubmit", { prompt: msg })).output.reason.match(/#(\d+)/)[1]);
  while ((await post("/api/queue/next", {}, asHq)).item);
  expect((await get("/api/queue/line", asHq)).line).not.toContain("unread");
  await Bun.sleep(200);
  setHq("idle");
  const keys = sendKeys().length;
  await post("/api/sync");
  await until(() => sendKeys().length > keys, `ctrl+c on #${id}'s text`);
  expect(sendKeys().slice(keys)).toEqual([["agent", "send-keys", "hq", "ctrl+c"]]);
  setHq("working");
}, 15_000);

test("the kick is typed only into an empty box (the placeholder counts as empty)", async () => {
  setHq("idle");
  paneShows(boxWith("half a sentence the owner typed"));
  await hook("UserPromptSubmit", { prompt: "api: the kick waits for this" });
  const before = kicks().length;
  await post("/api/sync");
  await post("/api/sync");
  expect(kicks().length).toBe(before);
  paneShows(PLACEHOLDER);
  await post("/api/sync");
  expect(kicks().length).toBe(before + 1);
  expect(kicks().at(-1)).toMatch(/^HUD queue: HQ QUEUE: \d+ unread/);
  setHq("working");
}, 15_000);

test("a prompt that starts with an open item's text is not filed again", async () => {
  const msg = "api: is the schema change fine?";
  const first = await hook("UserPromptSubmit", { prompt: msg });
  const id = Number(first.output.reason.match(/#(\d+)/)[1]);
  // a kick typed onto the held message: the HUD part goes through, the message is not filed twice
  const kicked = await hook("UserPromptSubmit", { prompt: `${msg}HUD queue: HQ QUEUE: 3 unread (oldest now, from api). Read the next: hud req next.` });
  expect(kicked.output).toBeUndefined();
  expect(kicked.text).toContain(`#${id}`);
  // the same message again: held, as already queued
  const again = await hook("UserPromptSubmit", { prompt: msg });
  expect(again.output).toEqual({ decision: "block", reason: `Already queued as #${id}; HQ reads it with hud req next.` });
  expect((await itemsLike(msg)).map((i: any) => i.text)).toEqual([msg]);
  // the collapsed one, with a kick after it
  const huge = (await itemsLike(words("api", 300))).find((i: any) => i.text === words("api", 300));
  const k2 = await hook("UserPromptSubmit", { prompt: `${pasted(huge.text)}\nHUD queue: HQ QUEUE: 3 unread.` });
  expect(k2.output).toBeUndefined();
  expect(k2.text).toContain(`#${huge.id}`);
  expect((await itemsLike(words("api", 300))).length).toBe(1);
  // the HUD's own long lines arrive as pastes too: straight in, not filed
  const note = await hook("UserPromptSubmit", { prompt: pasted(`HUD note from the owner: ${words("x", 300)}`) });
  expect(note.output).toBeUndefined();
  expect((await get("/api/queue?all=1", asHq)).items.some((i: any) => i.text.includes("HUD note from"))).toBe(false);
}, 15_000);

// The loop the owner saw: a held message stays in HQ's box (HQ was working, so it was not cleared), HQ goes idle, and
// each sync's kick was typed onto it and submitted, which filed the whole box again, a little longer every time.
test("the loop, replayed: a held message left in the box, then kicks over several ticks, is one item", async () => {
  for (const it of (await get("/api/queue", asHq)).items) await post(`/api/queue/${it.id}/close`, { why: "test reset" }, asHq);
  const msg = words("docs", 250);
  setHq("working");
  let box = { shown: "[Pasted text #1]", prompt: pasted(msg) };
  expect((await hook("UserPromptSubmit", { prompt: box.prompt })).output.decision).toBe("block");
  setHq("idle");
  let typed = herdr.typedInto("hq").length, keys = sendKeys().length;
  for (let tick = 0; tick < 6; tick++) {
    paneShows(box.shown ? [`❯\u00a0${box.shown}`] : EMPTY);
    await post("/api/sync");
    if (sendKeys().length > keys) box = { shown: "", prompt: "" };
    keys = sendKeys().length;
    for (const t of herdr.typedInto("hq").slice(typed)) {
      const prompt = box.prompt + t;
      const r = await hook("UserPromptSubmit", { prompt });
      box = r.output?.decision === "block" ? { shown: box.shown + t, prompt } : { shown: "", prompt: "" };
    }
    typed = herdr.typedInto("hq").length;
  }
  const filed = (await get("/api/queue?all=1", asHq)).items.filter((i: any) => i.text.includes("docs: w0 w1"));
  expect(filed.map((i: any) => [i.from_name, i.text.length])).toEqual([["docs", msg.length]]);
  expect(kicks().filter((t) => t.includes("1 unread")).length).toBeGreaterThanOrEqual(1);
  setHq("working");
}, 15_000);

// HQ that cannot clear its queue (hud blocked, a broken item) must still be able to end its turn: with
// stop_hook_active set, the Stop hook holds it at most 3 times in a row without progress, then lets it stop.
test("the Stop hook holds HQ at most 3 times in a row while nothing is read, then lets it stop", async () => {
  await hook("UserPromptSubmit", { prompt: "api: one for the Stop cap" });
  await hook("UserPromptSubmit", { prompt: "api: another for the Stop cap" });
  const stop = async (active: boolean) => ((await hook("Stop", { stop_hook_active: active })).output?.decision ?? "stop");
  expect([await stop(false), await stop(true), await stop(true), await stop(true)]).toEqual(["block", "block", "block", "stop"]);
  // a new turn starts the count again
  expect([await stop(false), await stop(true)]).toEqual(["block", "block"]);
  // HQ reads an item: progress, so the count starts again
  expect((await post("/api/queue/next", {}, asHq)).item).toBeTruthy();
  expect([await stop(true), await stop(true), await stop(true), await stop(true)]).toEqual(["block", "block", "block", "stop"]);
});
