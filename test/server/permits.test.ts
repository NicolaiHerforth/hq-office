// PERMITS: a lane's hook asks the HUD about every permission prompt and is refused, unless the owner allowed that
// exact request once on the HUD. Three layers:
//   1. permits.ts on an in-memory database with a clock the test moves: the key, one row per exact request, once-only,
//      one door per allow, expiry, masking, what can never be allowed, the question's body.
//   2. bin/lane-hook.ts against a stub server: its exact output for allow and deny, and a deny whenever the HUD is
//      down, slow, wrong or silent.
//   3. server.ts, hud.ts and the hook end to end, on a spare port with a throwaway data dir and a stub herdr: refused,
//      asked, allowed on "the page" (a POST with the HUD's own Origin), used once; an answer from a pane is refused; a
//      held secret in a command never reaches hud.db.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, spawnServer } from "../../scripts/room-hash.ts";
import { ALLOW, ALLOW_MS, MAX_INPUT, NO, TITLE, askBody, cannotAllow, createPermits, identityOf, keyOf, whatOf } from "../../src/server/permits.ts";
import { laneSettings } from "../../src/server/lane-settings.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const HOOK = join(ROOT, "bin", "lane-hook.ts");
const REFUSED = "nobody answers prompts in this pane; do it another way, or tell HQ what you need";
const UNASKED = `the HUD could not be asked; ${REFUSED}`;
setDefaultTimeout(30_000);

// ---- 1. the book, in memory ----

function setup(mask?: (s: string) => string) {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(ROOT, "src", "server", "schema", "permits.sql"), "utf8"));
  const clock = { t: Date.parse("2026-03-10T09:00:00Z") };
  const permits = createPermits({ db, now: () => clock.t, mask });
  const bash = (command: string, more: object = {}) => ({ floor: "main", lane: "builder", kind: "prompt" as const, tool: "Bash", input: { command, description: "whatever the model wrote" }, mode: "auto", cwd: "/work/repo", ...more });
  return { db, clock, permits, bash };
}

describe("the key: this exact request", () => {
  const key = (tool: string, input: object, lane = "builder", cwd = "/work/repo") => keyOf(lane, tool, input, cwd);
  test("a Bash call is its command: a new description keeps the key, a changed command breaks it", () => {
    const a = key("Bash", { command: 'rm -rf "$(echo victim1)"', description: "Run d1: delete the victim1 fixture folder" });
    expect(key("Bash", { command: 'rm -rf "$(echo victim1)"', description: "Delete the victim1 fixture folder" })).toBe(a);
    expect(key("Bash", { description: "Delete the victim1 fixture folder", command: 'rm -rf "$(echo victim1)"', timeout: 5000 })).toBe(a);
    expect(key("Bash", { command: 'rm -rf "$(echo victim2)"', description: "Run d1: delete the victim1 fixture folder" })).not.toBe(a);
    expect(key("Bash", { command: 'rm -rf "$(echo victim1)" ', description: "x" })).not.toBe(a);
  });
  test("how a command is run is part of it: outside the sandbox or in the background is another request; a flag that is off is no flag", () => {
    const a = key("Bash", { command: "npm publish" });
    expect(key("Bash", { command: "npm publish", dangerouslyDisableSandbox: false, run_in_background: false })).toBe(a);
    expect(key("Bash", { command: "npm publish", dangerouslyDisableSandbox: true })).not.toBe(a);
    expect(key("Bash", { command: "npm publish", run_in_background: true })).not.toBe(a);
    expect(key("Bash", { command: "npm publish", some_new_field: "x" })).not.toBe(a);
  });
  test("another lane, another folder or another tool is another request", () => {
    const input = { command: "rm -rf build/*/*" };
    const a = key("Bash", input);
    expect(key("Bash", input, "other")).not.toBe(a);
    expect(key("Bash", input, "builder", "/work/elsewhere")).not.toBe(a);
    expect(key("PowerShell", input)).not.toBe(a);
  });
  test("a fetch and an artifact are where they go: a new prompt keeps the key", () => {
    expect(key("WebFetch", { url: "https://example.com/a", prompt: "the title" })).toBe(key("WebFetch", { url: "https://example.com/a", prompt: "everything" }));
    expect(key("WebFetch", { url: "https://example.com/b", prompt: "the title" })).not.toBe(key("WebFetch", { url: "https://example.com/a", prompt: "the title" }));
    expect(key("Artifact", { action: "read", url: "https://claude.ai/artifact/x" })).toBe(key("Artifact", { action: "read", url: "https://claude.ai/artifact/x", prompt: "The page title only." }));
    expect(key("Artifact", { action: "publish", url: "https://claude.ai/artifact/x" })).not.toBe(key("Artifact", { action: "read", url: "https://claude.ai/artifact/x" }));
    // what an artifact publishes is part of it
    expect(key("Artifact", { file_path: "/w/report.html" })).not.toBe(key("Artifact", { file_path: "/w/.env.html" }));
    expect(key("Artifact", { file_path: "/w/report.html" })).not.toBe(key("Artifact", { file_path: "/w/report.html", files: { "k.txt": "/w/.env" } }));
  });
  test("any other tool keeps what it does: an Agent's prompt is in the key, its description is not; an MCP tool's whole input is", () => {
    expect(key("Agent", { description: "look", prompt: "delete the cache", subagent_type: "x" })).toBe(key("Agent", { description: "tidy", prompt: "delete the cache", subagent_type: "x" }));
    expect(key("Agent", { description: "look", prompt: "delete the repo", subagent_type: "x" })).not.toBe(key("Agent", { description: "look", prompt: "delete the cache", subagent_type: "x" }));
    expect(key("mcp__tracker__create", { title: "a", description: "one" })).not.toBe(key("mcp__tracker__create", { title: "a", description: "two" }));
    expect(identityOf("Write", { file_path: "/x", content: "y" })).toEqual({ file_path: "/x", content: "y" });
  });
  test("the same input in another key order is the same request", () => {
    expect(key("mcp__x__y", { a: 1, b: { d: [1, { f: 2, e: 1 }], c: 2 } })).toBe(key("mcp__x__y", { b: { c: 2, d: [1, { e: 1, f: 2 }] }, a: 1 }));
  });
});

describe("one row per exact request", () => {
  test("a refused request is a row; the same one again is the same row with one more try; a changed one is new", () => {
    const s = setup();
    const a = s.permits.seen(s.bash("rm -rf build/*/*"));
    expect(a).toMatchObject({ id: 1, floor: "main", lane: "builder", kind: "prompt", tool: "Bash", mode: "auto", cwd: "/work/repo", status: "refused", tries: 1, ask: null });
    expect(JSON.parse(a.input!)).toEqual({ command: "rm -rf build/*/*", description: "whatever the model wrote" });
    s.clock.t += 60_000;
    const again = s.permits.seen(s.bash("rm -rf build/*/*", { input: { command: "rm -rf build/*/*", description: "another label" } }));
    expect(again).toMatchObject({ id: 1, tries: 2, at: s.clock.t });
    expect(s.permits.seen(s.bash("rm -rf build/*")).id).toBe(2);
    expect(s.permits.seen(s.bash("rm -rf build/*/*", { lane: "other" })).id).toBe(3);
  });
  test("a classifier block and the prompt it turns into are one request; the row says how it was last stopped", () => {
    const s = setup();
    const a = s.permits.seen(s.bash("python3 x.py", { kind: "classifier", reason: "judged dangerous" }));
    const b = s.permits.seen(s.bash("python3 x.py"));
    expect(b).toMatchObject({ id: a.id, kind: "prompt", reason: null, tries: 2 });
  });
  test("after the hour, the same request is a new row", () => {
    const s = setup();
    s.permits.seen(s.bash("ls"));
    s.clock.t += ALLOW_MS;
    expect(s.permits.seen(s.bash("ls")).id).toBe(2);
  });
  test("a stuck prompt is always its own row, with what it said", () => {
    const s = setup();
    const a = s.permits.seen({ floor: "main", lane: "builder", kind: "stuck", reason: "Claude needs your permission" });
    const b = s.permits.seen({ floor: "main", lane: "builder", kind: "stuck", reason: "Claude needs your permission" });
    expect([a.id, b.id, a.tool, a.input, a.key]).toEqual([1, 2, null, null, null]);
  });
  test("an input too long to keep is not kept, and can never be allowed", () => {
    const s = setup();
    const p = s.permits.seen(s.bash("x".repeat(MAX_INPUT)));
    expect(p.input).toBeNull();
    expect(p.key).toBeNull();
    expect(p.reason).toContain("too long to keep");
    expect(cannotAllow(p)).toContain("was not kept");
  });
});

describe("allowed once", () => {
  test("nothing is allowed until the owner allows it; then one call uses it and the next is refused", () => {
    const s = setup();
    const req = s.bash("rm -rf build/*/*");
    expect(s.permits.take(req, "prompt")).toBeNull();
    const p = s.permits.seen(req);
    expect(s.permits.open()).toBe(false);
    s.permits.allow(p.id);
    expect(s.permits.open()).toBe(true);
    expect(s.permits.row(p.id)).toMatchObject({ status: "allowed", allowed_at: s.clock.t });
    // a new description on the retry is the same request
    const hit = s.permits.take(s.bash("rm -rf build/*/*", { input: { command: "rm -rf build/*/*", description: "retry" } }), "prompt");
    expect(hit).toMatchObject({ id: p.id, status: "used", used_at: s.clock.t });
    expect(s.permits.take(req, "prompt")).toBeNull();
    expect(s.permits.open()).toBe(false);
    // and the refused retry is a new permit, not the used one
    expect(s.permits.seen(req).id).toBe(p.id + 1);
  });
  test("an allow is for its lane, its folder and its command only", () => {
    const s = setup();
    s.permits.allow(s.permits.seen(s.bash("rm -rf build/*/*")).id);
    expect(s.permits.take(s.bash("rm -rf build/*/*", { lane: "other" }), "prompt")).toBeNull();
    expect(s.permits.take(s.bash("rm -rf build/*/*", { cwd: "/work/elsewhere" }), "prompt")).toBeNull();
    expect(s.permits.take(s.bash("rm -rf build/*"), "prompt")).toBeNull();
    expect(s.permits.take(s.bash("rm -rf build/*/*", { lane: null }), "prompt")).toBeNull();
    expect(s.permits.take(s.bash("rm -rf build/*/*"), "prompt")).not.toBeNull();
  });
  test("an allowed or used permit cannot be allowed again; an expired one can", () => {
    const s = setup();
    const p = s.permits.seen(s.bash("ls"));
    s.permits.allow(p.id);
    expect(() => s.permits.allow(p.id)).toThrow("already allowed");
    s.permits.take(s.bash("ls"), "prompt");
    expect(() => s.permits.allow(p.id)).toThrow("already used");
    expect(() => s.permits.allow(99)).toThrow("no permit 99");
  });
  test("an allow nobody used within the hour is gone", () => {
    const s = setup();
    const req = s.bash("ls");
    const p = s.permits.seen(req);
    s.permits.allow(p.id);
    s.clock.t += ALLOW_MS - 1;
    expect(s.permits.open()).toBe(true);
    s.clock.t += 1;
    expect(s.permits.open()).toBe(false);
    expect(s.permits.take(req, "prompt")).toBeNull();
    expect(s.permits.take(req, "pre")).toBeNull();
    expect(s.permits.expire()).toBe(1);
    expect(s.permits.row(p.id)!.status).toBe("expired");
    expect(s.permits.expire()).toBe(0);
    s.permits.allow(p.id);
    expect(s.permits.take(req, "prompt")!.id).toBe(p.id);
  });
});

describe("one door per allow", () => {
  test("a request a prompt stopped is let through where the prompt comes again, never at PreToolUse", () => {
    const s = setup();
    const req = s.bash('rm -rf "$(echo victim1)"');
    const p = s.permits.seen(req);
    s.permits.allow(p.id);
    expect(s.permits.take(req, "pre")).toBeNull();
    expect(s.permits.row(p.id)!.status).toBe("allowed");
    expect(s.permits.take(req, "prompt")).toMatchObject({ id: p.id, status: "used" });
    expect(s.permits.take(req, "prompt")).toBeNull();
    expect(s.permits.take(req, "pre")).toBeNull();
  });
  test("a request the classifier blocked is let through before the classifier, and that is the whole allow", () => {
    const s = setup();
    const req = s.bash("python3 make.py", { kind: "classifier", reason: "judged dangerous" });
    const p = s.permits.seen(req);
    s.permits.allow(p.id);
    expect(s.permits.take(req, "pre")).toMatchObject({ id: p.id, status: "used", used_at: s.clock.t });
    expect(s.permits.open()).toBe(false);
    // the same command again, at once, at either door: nothing
    expect(s.permits.take(req, "prompt")).toBeNull();
    expect(s.permits.take(req, "pre")).toBeNull();
  });
  test("an allowed request the classifier blocks on its retry turns 'classifier': the lane may retry, and that try passes once", () => {
    const s = setup();
    const req = s.bash("python3 make.py");
    const p = s.permits.seen(req); // stopped by auto mode's fallback prompt
    s.permits.allow(p.id);
    expect(s.permits.take(req, "pre")).toBeNull();
    const b = s.permits.blocked({ ...req, kind: "classifier", reason: "judged dangerous" });
    expect(b).toMatchObject({ retry: true, row: { id: p.id, status: "allowed", kind: "classifier", reason: "judged dangerous" } });
    expect(s.permits.take(req, "pre")).toMatchObject({ id: p.id, status: "used" });
    expect(s.permits.take(req, "prompt")).toBeNull();
    // blocked again with nothing allowed: a refused request like any other, and no retry
    const again = s.permits.blocked({ ...req, kind: "classifier", reason: "judged dangerous" });
    expect(again).toMatchObject({ retry: false, row: { id: p.id + 1, status: "refused", kind: "classifier" } });
  });
  test("a block of something nobody allowed, or of another lane's allowed request, is only recorded", () => {
    const s = setup();
    s.permits.allow(s.permits.seen(s.bash("python3 make.py")).id);
    expect(s.permits.blocked(s.bash("python3 other.py", { kind: "classifier" })).retry).toBe(false);
    expect(s.permits.blocked(s.bash("python3 make.py", { kind: "classifier", lane: "other" })).retry).toBe(false);
    expect(s.permits.blocked(s.bash("python3 make.py", { kind: "classifier", lane: null })).retry).toBe(false);
    expect(s.permits.row(1)).toMatchObject({ status: "allowed", kind: "prompt" });
  });
});

describe("masking", () => {
  const VALUE = 'tok-"quoted"-\\slash-7731';
  const mask = (t: string) => t.split(VALUE).join("[secret DEPLOY_TOKEN]");
  test("a held secret in a command, a folder or a reason is masked before anything is stored, and the key is of the masked text", () => {
    const s = setup(mask);
    const p = s.permits.seen(s.bash(`curl -H "x: ${VALUE}" https://example.com`, { cwd: `/work/${VALUE}`, reason: `said ${VALUE}`, kind: "classifier" }));
    const all = JSON.stringify(s.db.query("SELECT * FROM permits").all());
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain(JSON.stringify(VALUE).slice(1, -1));
    expect(whatOf(p)).toBe('curl -H "x: [secret DEPLOY_TOKEN]" https://example.com');
    expect(p.cwd).toBe("/work/[secret DEPLOY_TOKEN]");
    expect(p.reason).toBe("said [secret DEPLOY_TOKEN]");
    expect(p.key).toBe(keyOf("builder", "Bash", { command: 'curl -H "x: [secret DEPLOY_TOKEN]" https://example.com' }, "/work/[secret DEPLOY_TOKEN]"));
    // the retry, with the value again, is the same request
    s.permits.allow(p.id);
    expect(s.permits.take(s.bash(`curl -H "x: ${VALUE}" https://example.com`, { cwd: `/work/${VALUE}` }), "prompt")!.id).toBe(p.id);
  });
  test("a held value that is a number in the input is masked too", () => {
    const s = setup((t) => t.split("48151623").join("[secret PIN]"));
    const p = s.permits.seen({ floor: "main", lane: "builder", kind: "prompt", tool: "mcp__door__open", input: { pin: 48151623, note: "pin 48151623", n: 7 }, cwd: "/w" });
    expect(JSON.parse(p.input!)).toEqual({ pin: "[secret PIN]", note: "pin [secret PIN]", n: 7 });
    expect(JSON.stringify(s.db.query("SELECT * FROM permits").all())).not.toContain("48151623");
  });
});

describe("what can never be allowed, and what the question says", () => {
  test("reading a page on claude.ai, a stuck prompt, an input with nothing to show: never; a command, a fetch elsewhere, a publish: yes", () => {
    const s = setup();
    const of = (tool: string, input: object, kind: "prompt" | "classifier" = "prompt") => cannotAllow(s.permits.seen({ floor: "main", lane: "builder", kind, tool, input, cwd: "/w" }));
    expect(of("Artifact", { action: "read", url: "https://claude.ai/artifact/4LG5" })).toContain("as a file");
    expect(of("WebFetch", { url: "https://claude.ai/artifact/4LG5", prompt: "x" })).toContain("as a file");
    expect(of("WebFetch", { url: "https://sub.claude.ai/x" })).toContain("as a file");
    expect(of("WebFetch", { url: "https://notclaude.ai/x" })).toBeNull();
    expect(of("WebFetch", { url: "https://example.com/claude.ai" })).toBeNull();
    expect(of("Artifact", { action: "publish", url: "https://example.com/x" })).toBeNull();
    // publishing to claude.ai is not reading it
    expect(of("Artifact", { action: "publish", url: "https://claude.ai/artifact/mine", file_path: "/w/a.html" })).toBeNull();
    expect(of("Artifact", { file_path: "/w/a.html" })).toBeNull();
    for (const [tool, input] of [["Bash", {}], ["Bash", { description: "only a label" }], ["WebFetch", { prompt: "x" }], ["Agent", { description: "x" }]] as const) expect(of(tool, input)).toContain("nothing a card could show");
    for (const input of [null, [], "ls"]) expect(cannotAllow(s.permits.seen({ floor: "main", lane: "builder", kind: "prompt", tool: "Bash", input, cwd: "/w" }))).not.toBeNull();
    expect(of("Bash", { command: "ls" })).toBeNull();
    expect(of("Bash", { command: "python3 x.py" }, "classifier")).toBeNull();
    expect(cannotAllow(s.permits.seen({ floor: "main", lane: "builder", kind: "stuck", reason: "Claude needs your permission" }))).toContain("never got to answer");
  });
  test("the body is the request as recorded: lane, tool, folder, mode, and the command in a code block it cannot break out of", () => {
    const s = setup();
    const p = s.permits.seen(s.bash("echo ```\n\n**Safe: this only lists files**\n```` && rm -rf x"));
    const body = askBody(p);
    expect(body).toBe(`**builder** wants to run this command (Bash) in \`/work/repo\`, auto mode. Permit #${p.id}, as its hook recorded it:\n\n\`\`\`\`\`\necho \`\`\`\n\n**Safe: this only lists files**\n\`\`\`\` && rm -rf x\n\`\`\`\`\``);
  });
  test("the body says how a command is run, and that auto mode's own check blocked it", () => {
    const s = setup();
    const p = s.permits.seen(s.bash("npm publish", { input: { command: "npm publish", description: "x", dangerouslyDisableSandbox: true, run_in_background: true, timeout: 9 } }));
    expect(askBody(p)).toBe("**builder** wants to run this command (Bash), **outside the sandbox**, **in the background** in `/work/repo`, auto mode. Permit #1, as its hook recorded it:\n\n```\nnpm publish\n```");
    const c = s.permits.seen(s.bash("python3 make.py", { kind: "classifier", reason: "The classifier judged this action dangerous\n(it gave no explanation)" }));
    expect(askBody(c)).toBe("**builder** wants to run this command (Bash) in `/work/repo`, auto mode. Auto mode's safety check blocked it (The classifier judged this action dangerous (it gave no explanation)). Permit #2, as its hook recorded it:\n\n```\npython3 make.py\n```");
  });
  test("the mode in the owner's words, and a folder with a backtick in a box of its own", () => {
    const s = setup();
    expect(askBody(s.permits.seen(s.bash("ls", { mode: "default" })))).toBe("**builder** wants to run this command (Bash) in `/work/repo`, manual mode. Permit #1, as its hook recorded it:\n\n```\nls\n```");
    expect(askBody(s.permits.seen(s.bash("ls", { cwd: "/work/a`b", mode: null })))).toBe("**builder** wants to run this command (Bash) in \n\n```\n/work/a`b\n```\n\n. Permit #2, as its hook recorded it:\n\n```\nls\n```");
  });
  test("other tools show the fields the key covers", () => {
    const s = setup();
    expect(whatOf(s.permits.seen({ floor: "main", lane: "builder", kind: "prompt", tool: "WebFetch", input: { url: "https://example.com/a", prompt: "the title" }, cwd: "/w" }))).toBe("https://example.com/a");
    expect(JSON.parse(whatOf(s.permits.seen({ floor: "main", lane: "builder", kind: "prompt", tool: "Artifact", input: { action: "publish", url: "https://example.com/a", file_path: "/w/a.html", prompt: "x" }, cwd: "/w" })))).toEqual({ action: "publish", url: "https://example.com/a", file_path: "/w/a.html" });
    const agent = s.permits.seen({ floor: "main", lane: "builder", kind: "prompt", tool: "Agent", input: { description: "tidy", prompt: "delete the cache" }, cwd: "/w" });
    expect(JSON.parse(whatOf(agent))).toEqual({ prompt: "delete the cache" });
    expect(askBody(agent)).toStartWith("**builder** wants to use this tool with this input (Agent) in `/w`. Permit #3, as its hook recorded it:");
  });
  test("the words of the question", () => {
    expect([TITLE, ALLOW, NO]).toEqual(["Allow this once?", "Allow this once", "No"]);
  });
});

// ---- the hook, run as Claude Code runs it ----

type Ran = { out: string; json: any; code: number; ms: number };
async function runHook(event: string, input: unknown, env: Record<string, string>): Promise<Ran> {
  const t = Date.now();
  const p = Bun.spawn([process.execPath, HOOK, event], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HUD_LANE_HOOK: "1", ...env }, stdin: Buffer.from(typeof input === "string" ? input : JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  let json: any = null;
  try { json = out ? JSON.parse(out) : null; } catch {}
  return { out, json, code, ms: Date.now() - t };
}
// A PermissionRequest as Claude Code 2.1.322 sends it (the trial's sample, its paths shortened).
const sample = (command: string, more: object = {}) => ({
  session_id: "08ae8379-e814-4416-ba2c-cb45a94ba9d5", transcript_path: "/x/08ae8379.jsonl", cwd: "/work/repo", prompt_id: "1a5283e1", permission_mode: "auto", effort: { level: "high" },
  hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, description: "Delete the contents of victim2's subfolders" }, permission_suggestions: [], ...more,
});
const DENY = (message: string) => `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":${JSON.stringify(message)}}}}`;
const ALLOWED = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`;

// ---- 2. the hook against a stub server ----

describe("the hook against a stub HUD", () => {
  let say: (req: Request, body: any) => Response | Promise<Response> = () => Response.json({});
  const got: { headers: Headers; body: any; path: string }[] = [];
  const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = await req.json().catch(() => null);
    got.push({ headers: req.headers, body, path: new URL(req.url).pathname });
    return say(req, body);
  } });
  const env = (more: Record<string, string> = {}) => ({ HUD_URL: `http://127.0.0.1:${stub.port}`, HERDR_PANE_ID: "w9:p3", HUD_LOCAL_MACHINE: "local", ...more });
  afterAll(() => stub.stop(true));

  test("deny: the HUD's message, in exactly the shape Claude Code takes; the HUD gets the request and who asks", async () => {
    got.length = 0;
    say = () => Response.json({ decision: "deny", message: `${REFUSED}. This exact request is permit #7 (HQ: hud permit ask 7)`, permit: 7 });
    const r = await runHook("PermissionRequest", sample("rm -rf victim2/*/*"), env());
    expect(r.out).toBe(DENY(`${REFUSED}. This exact request is permit #7 (HQ: hud permit ask 7)`));
    expect(r.code).toBe(0);
    expect(got).toHaveLength(1);
    expect(got[0].path).toBe("/api/permits/hook");
    expect(got[0].body).toEqual({ event: "PermissionRequest", tool: "Bash", input: { command: "rm -rf victim2/*/*", description: "Delete the contents of victim2's subfolders" }, mode: "auto", cwd: "/work/repo" });
    expect([got[0].headers.get("x-hud"), got[0].headers.get("x-hud-pane"), got[0].headers.get("x-hud-machine"), got[0].headers.get("x-hud-session")]).toEqual(["1", "w9:p3", "local", "08ae8379-e814-4416-ba2c-cb45a94ba9d5"]);
    expect(decodeURIComponent(got[0].headers.get("x-hud-cwd")!)).toBe(process.cwd());
  });
  test("allow once, then deny: what the HUD decides is what the hook prints", async () => {
    let left = 1;
    say = () => (left-- > 0 ? Response.json({ decision: "allow", permit: 7 }) : Response.json({ decision: "deny", message: REFUSED }));
    expect((await runHook("PermissionRequest", sample("rm -rf victim2/*/*"), env())).out).toBe(ALLOWED);
    expect((await runHook("PermissionRequest", sample("rm -rf victim2/*/*"), env())).out).toBe(DENY(REFUSED));
  });
  test("the HUD unreachable: deny, saying it could not be asked", async () => {
    const r = await runHook("PermissionRequest", sample("ls"), env({ HUD_URL: `http://127.0.0.1:${freePort()}` }));
    expect(r.out).toBe(DENY(UNASKED));
    expect(r.code).toBe(0);
  });
  test("the HUD slow: deny after the wait, not after the HUD", async () => {
    say = async () => { await Bun.sleep(4000); return Response.json({ decision: "allow" }); };
    const r = await runHook("PermissionRequest", sample("ls"), env({ HUD_LANE_HOOK_MS: "300" }));
    expect(r.out).toBe(DENY(UNASKED));
    expect(r.ms).toBeLessThan(3000);
  });
  test("an error, an answer that is no decision, a deny with no message, no JSON at all: deny", async () => {
    const answers: (() => Response)[] = [
      () => Response.json({ error: "boom" }, { status: 500 }),
      () => Response.json({ error: "forbidden" }, { status: 403 }),
      () => Response.json({}),
      () => Response.json({ decision: "maybe" }),
      () => Response.json({ decision: "deny" }),
      () => Response.json(null),
      () => new Response("<html>not the HUD</html>"),
    ];
    for (const a of answers) {
      say = a;
      expect((await runHook("PermissionRequest", sample("ls"), env())).out).toBe(DENY(UNASKED));
    }
  });
  test("input that is not JSON, or none: still a decision, and it is deny", async () => {
    say = () => Response.json({ decision: "allow" });
    expect((await runHook("PermissionRequest", "not json", env())).out).toBe(DENY(UNASKED));
    expect((await runHook("PermissionRequest", "", env())).out).toBe(DENY(UNASKED));
  });
  test("outside a lane (no HUD_LANE_HOOK) it says nothing and asks nobody", async () => {
    got.length = 0;
    say = () => Response.json({ decision: "allow" });
    for (const event of ["PermissionRequest", "PreToolUse", "PermissionDenied", "Notification"]) {
      const r = await runHook(event, sample("ls", { hook_event_name: event }), env({ HUD_LANE_HOOK: "" }));
      expect([r.out, r.code]).toEqual(["", 0]);
    }
    expect(got).toHaveLength(0);
  });
  test("PreToolUse: allow in PreToolUse's own shape when the HUD says so; otherwise nothing, also with the HUD down", async () => {
    say = () => Response.json({ decision: "allow", permit: 9 });
    const pre = sample("ls", { hook_event_name: "PreToolUse", tool_use_id: "toolu_01", permission_suggestions: undefined });
    expect((await runHook("PreToolUse", pre, env())).json).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "the owner allowed this exact call once on the HUD (permit #9)" } });
    say = () => Response.json({});
    expect((await runHook("PreToolUse", pre, env())).out).toBe("");
    say = () => Response.json({ decision: "deny", message: "no" });
    expect((await runHook("PreToolUse", pre, env())).out).toBe("");
    expect((await runHook("PreToolUse", pre, env({ HUD_URL: `http://127.0.0.1:${freePort()}` }))).out).toBe("");
  });
  test("PermissionDenied and a permission_prompt notification are told to the HUD and print nothing; other notifications are not sent", async () => {
    got.length = 0;
    say = () => Response.json({ decision: "allow", permit: 1 });
    const denied = { ...sample("python3 x.py", { hook_event_name: "PermissionDenied", tool_use_id: "toolu_01", reason: "The server-side auto mode classifier judged this action dangerous (it gave no explanation)" }), permission_suggestions: undefined };
    expect((await runHook("PermissionDenied", denied, env())).out).toBe("");
    expect(got[0].body).toMatchObject({ event: "PermissionDenied", tool: "Bash", reason: "The server-side auto mode classifier judged this action dangerous (it gave no explanation)" });
    const note = { session_id: "08ae8379-e814-4416-ba2c-cb45a94ba9d5", cwd: "/work/repo", hook_event_name: "Notification", message: "Claude needs your permission", notification_type: "permission_prompt" };
    expect((await runHook("Notification", note, env())).out).toBe("");
    expect(got[1].body).toEqual({ event: "Notification", cwd: "/work/repo", message: "Claude needs your permission", type: "permission_prompt" });
    expect((await runHook("Notification", { ...note, notification_type: "idle_prompt" }, env())).out).toBe("");
    expect(got).toHaveLength(2);
  });
  test("PermissionDenied of a call the owner has allowed: the hook says the lane may retry, in PermissionDenied's own shape", async () => {
    say = () => Response.json({ retry: true, permit: 4 });
    const denied = { ...sample("python3 x.py", { hook_event_name: "PermissionDenied", tool_use_id: "toolu_01", reason: "judged dangerous" }), permission_suggestions: undefined };
    expect((await runHook("PermissionDenied", denied, env())).out).toBe(`{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}`);
    say = () => Response.json({ retry: "yes" });
    expect((await runHook("PermissionDenied", denied, env())).out).toBe("");
  });
  test("a wait set too long is cut to 3 s, so the hook always ends inside the 10 s the settings file gives it", async () => {
    say = async () => { await Bun.sleep(9000); return Response.json({ decision: "allow" }); };
    const r = await runHook("PermissionRequest", sample("ls"), env({ HUD_LANE_HOOK_MS: "60000" }));
    expect(r.out).toBe(DENY(UNASKED));
    expect(r.ms).toBeLessThan(6000);
  });
});

// ---- 3. end to end: server.ts, hud.ts and the hook on a spare port, a throwaway data dir and a stub herdr ----

describe("end to end", () => {
  const DATA = mkdtempSync(join(tmpdir(), "hq-permits-"));
  const agent = (name: string, pane: string): FakeAgent => ({ name, agent_status: "idle", pane_id: pane, agent: "claude" });
  const herdr = fakeHerdr(DATA, [agent("hq", "w1:p1"), agent("hq-crm", "w1:p2"), agent("builder", "w1:p3"), agent("other", "w1:p4"), agent("loose", "w1:p5")]);
  const SECRET = 'tok-"q"-7731-permits-GREP';
  let server: Awaited<ReturnType<typeof spawnServer>>;
  const headers = (pane?: string) => ({ "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}) });
  const req = async (p: string, b?: object, pane?: string, more: Record<string, string> = {}) => {
    const r = await fetch(`${server.base}${p}`, b ? { method: "POST", headers: { ...headers(pane), ...more }, body: JSON.stringify(b) } : { headers: headers(pane) });
    return { status: r.status, ...(await r.json()) };
  };
  const hud = (args: string[], pane = "w1:p1") => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
  };
  const hook = (event: string, input: object, pane = "w1:p3") => runHook(event, input, { HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" });
  const prompt = (command: string, pane?: string, more: object = {}) => hook("PermissionRequest", sample(command, more), pane);
  const pre = (command: string, pane?: string) => hook("PreToolUse", sample(command, { hook_event_name: "PreToolUse", tool_use_id: "toolu_01" }), pane);
  const permitOf = (r: Ran) => Number(r.json.hookSpecificOutput.decision.message.match(/permit #(\d+)/)![1]);
  const row = async (id: number) => (await req(`/api/permits/${id}`)).permit;
  // The owner's answer as the page sends it: a browser's POST carries the HUD's own Origin and no pane.
  const onPage = (ask: number, answer: string) => req(`/api/asks/${ask}/answer`, { answer }, undefined, { origin: server.base });
  const askFor = (id: number, why?: string) => {
    const r = hud(["permit", "ask", String(id), ...(why ? ["--why", why] : [])]);
    expect(r.err).toBe("");
    return Number(r.out.match(/^ask #(\d+)/)![1]);
  };
  const events = async () => ((await req("/api/state")).events as { who: string; text: string; lane: string | null }[]).map((e) => `${e.who}: ${e.text}`);
  async function typed(name: string, part: string, ms = 15_000) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (herdr.typedInto(name).some((t) => t.includes(part))) break;
    return herdr.typedInto(name).filter((t) => t.includes(part));
  }
  const marker = () => existsSync(join(DATA, "lane-permits-open"));

  beforeAll(async () => {
    server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_OWNER: "Sam" } });
    await req("/api/sync", {});
    await req("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
    for (const name of ["builder", "other"]) await req("/api/lanes", { name, machine: "local" });
    await req("/api/sync", {});
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });

  test("the lane settings file: where hud says, with this server's address and the hook's copy in the data folder", () => {
    const path = join(DATA, "lane-settings.json"), copy = join(DATA, "lane-hook.ts");
    expect(existsSync(path)).toBe(true); // written at start
    expect(hud(["lane-settings"])).toEqual({ out: path, err: "", code: 0 });
    const s = JSON.parse(readFileSync(path, "utf8"));
    expect(s).toEqual(JSON.parse(JSON.stringify(laneSettings({ bun: process.execPath, hook: copy, url: server.base, marker: join(DATA, "lane-permits-open") }))));
    // the hook it runs is a copy of the script, in the data folder: a plugin update moves nothing a running lane uses
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(HOOK, "utf8"));
    expect(readFileSync(HOOK, "utf8")).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
    expect(s.env).toEqual({ HUD_LANE_HOOK: "1" });
    expect(s.permissions).toEqual({ deny: ["WebFetch(domain:claude.ai)"] });
    expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "PermissionDenied", "PermissionRequest", "PreToolUse"]);
    for (const event of Object.keys(s.hooks)) {
      const [group] = s.hooks[event];
      expect(group.hooks).toHaveLength(1);
      expect(group.hooks[0]).toMatchObject({ type: "command", timeout: 10 });
      expect(group.hooks[0].command).toEndWith(`B='${process.execPath}'; [ -x "$B" ] || B=bun; HUD_URL='${server.base}' "$B" '${copy}' ${event}${event === "PreToolUse" ? "; }" : ""}`);
    }
    expect(s.hooks.Notification[0].matcher).toBe("permission_prompt");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toStartWith(`[ ! -e '${join(DATA, "lane-permits-open")}' ] || { B=`);
    // missing or stale, the file or the copy: written again
    rmSync(path);
    rmSync(copy);
    expect(hud(["lane-settings"]).out).toBe(path);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(HOOK, "utf8"));
    writeFileSync(path, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "bun /old/place/bin/lane-hook.ts" }] }] } }));
    writeFileSync(copy, "// an older hook\n");
    expect(hud(["lane-settings"]).out).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(s);
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(HOOK, "utf8"));
    // and the copy is what answers: run as the settings file runs it
    const cmd = s.hooks.PermissionRequest[0].hooks[0].command;
    const p = Bun.spawnSync(["sh", "-c", cmd], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HUD_LANE_HOOK: "1", HERDR_PANE_ID: "w1:p4", HUD_LOCAL_MACHINE: "local" }, stdin: Buffer.from(JSON.stringify(sample("touch from-the-copy.txt"))), stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(p.stdout.toString()).hookSpecificOutput.decision).toMatchObject({ behavior: "deny", message: expect.stringContaining(`${REFUSED}. This exact request is permit #`) });
  });

  test("the PreToolUse command costs one file test while nothing is allowed, and runs the hook while something is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hq-permits-cmd-"));
    const s = laneSettings({ url: "http://127.0.0.1:9", marker: join(dir, "it's open"), bun: "/bin/echo", hook: "/some where/lane-hook.ts" });
    const run = () => Bun.spawnSync(["sh", "-c", s.hooks.PreToolUse[0].hooks[0].command], { stdout: "pipe", stderr: "pipe" });
    expect([run().stdout.toString(), run().exitCode]).toEqual(["", 0]);
    writeFileSync(join(dir, "it's open"), "");
    expect([run().stdout.toString(), run().exitCode]).toEqual(["/some where/lane-hook.ts PreToolUse\n", 0]);
    // a Bun that is gone when the hook runs: the one on PATH runs it
    writeFileSync(join(dir, "bun"), "#!/bin/sh\necho from PATH \"$@\"\n", { mode: 0o755 });
    const gone = laneSettings({ url: "http://127.0.0.1:9", marker: join(dir, "it's open"), bun: join(dir, "bun-1.0", "bun"), hook: "/some where/lane-hook.ts" });
    for (const event of ["PreToolUse", "PermissionRequest"] as const) {
      const r = Bun.spawnSync(["sh", "-c", gone.hooks[event][0].hooks[0].command], { env: { PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
      expect([r.stdout.toString(), r.exitCode]).toEqual([`from PATH /some where/lane-hook.ts ${event}\n`, 0]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  let P1 = 0, A1 = 0;
  test("a lane's prompt is refused on the spot, with its permit number; the same request again keeps the number", async () => {
    const r = await prompt('rm -rf "$(echo victim1)"');
    P1 = permitOf(r);
    expect(r.out).toBe(DENY(`${REFUSED}. This exact request is permit #${P1} (HQ: hud permit ask ${P1})`));
    const again = await prompt('rm -rf "$(echo victim1)"', "w1:p3", { tool_input: { command: 'rm -rf "$(echo victim1)"', description: "Delete the victim1 fixture folder" } });
    expect(permitOf(again)).toBe(P1);
    expect(permitOf(await prompt('rm -rf "$(echo victim2)"'))).toBe(P1 + 1);
    expect(await row(P1)).toMatchObject({ floor: "hq", lane: "builder", kind: "prompt", tool: "Bash", mode: "auto", cwd: "/work/repo", status: "refused", tries: 2, ask: null });
  });

  test("hud permit list and show: the request as recorded", () => {
    const list = hud(["permit"]);
    expect(list.code).toBe(0);
    expect(list.out.split("\n").find((l) => l.startsWith(`#${P1} `))).toMatch(new RegExp(`^#${P1}  now  builder  prompt  refused  2 tries  Bash: rm -rf "\\$\\(echo victim1\\)"$`));
    expect(hud(["permit", "list"]).out).toBe(list.out);
    const show = hud(["permit", "show", `#${P1}`]).out;
    expect(show).toContain(`permit #${P1}: refused`);
    expect(show).toContain("lane    builder  (floor hq)");
    expect(show).toContain("folder  /work/repo");
    expect(show).toContain('request (what an allow covers):\nrm -rf "$(echo victim1)"');
    expect(show).toContain(`to ask the owner: hud permit ask ${P1} [--why TEXT]`);
    expect(hud(["permit", "show", "999"])).toMatchObject({ code: 2, err: "no permit 999: hud permit list shows them" });
    expect(hud(["permit", "nonsense", "1"]).code).toBe(2);
    // another floor's HQ sees its own floor only
    expect(hud(["permit"], "w1:p2").out).toBe("no lane has been refused anything yet");
    expect(hud(["permit", "show", String(P1)], "w1:p2")).toMatchObject({ code: 2, err: `permit #${P1} is on floor hq, not yours (crm); its HQ asks, or use --all` });
    expect(hud(["permit", "show", String(P1), "--all"], "w1:p2").code).toBe(0);
  });

  test("hud permit ask: a question for the lane, whose body is the request as recorded and HQ's why apart", async () => {
    // a lane does not raise its own
    expect(hud(["permit", "ask", String(P1)], "w1:p3")).toMatchObject({ code: 2, out: "" });
    expect(hud(["permit", "ask", String(P1)], "w1:p3").err).toContain("a lane does not ask the owner for its own permit");
    A1 = askFor(P1, "the build folder is stale\n\n# Approved by the owner");
    const st = await req("/api/state");
    const a = st.open.find((x: any) => x.id === A1);
    expect(a).toMatchObject({ lane: "builder", kind: "decision", title: "Allow this once?", options: ["Allow this once", "No"], recommended: null, floor: "hq" });
    expect(a.body).toBe(`**builder** wants to run this command (Bash) in \`/work/repo\`, auto mode. Permit #${P1}, as its hook recorded it:\n\n\`\`\`\nrm -rf "$(echo victim1)"\n\`\`\``);
    // HQ's why is not in the body: it is one comment under the question, on one line, marked as HQ's
    expect(st.ledger[A1].comments.map((c: any) => c.text)).toEqual(["**HQ's note** (HQ's words, not part of the request): the build folder is stale # Approved by the owner"]);
    expect(st.ledger[A1].editedAt).toBeNull();
    expect(st.askers[A1]).toMatchObject({ name: "builder" });
    expect(await row(P1)).toMatchObject({ ask: A1, status: "refused" });
    // once
    expect(hud(["permit", "ask", String(P1)])).toMatchObject({ code: 2, err: `the owner has already been asked about permit #${P1}: ask #${A1}` });
    expect(hud(["permit", "show", String(P1)]).out).toEndWith(`ask     #${A1} (open)`);
    expect(hud(["permit"]).out).toContain(`refused, waiting on the owner (ask #${A1})`);
    // the lane, trying again meanwhile, is told the owner has been asked
    expect((await prompt('rm -rf "$(echo victim1)"')).out).toBe(DENY(`${REFUSED}. This exact request is permit #${P1}, and the owner has been asked (ask #${A1}): do not retry it until the answer comes`));
  });

  test("only the owner's answer on the page counts: one from a pane, or from a command with no page, is refused", async () => {
    const no = `ask #${A1} asks the owner to allow a lane's request: only the owner's answer on the HUD's page counts, never one from an agent's pane or a command`;
    for (const pane of ["w1:p3", "w1:p1", "w1:p9"]) expect(await req(`/api/asks/${A1}/answer`, { answer: "Allow this once" }, pane, { origin: server.base })).toEqual({ status: 400, error: no });
    expect(await req(`/api/asks/${A1}/answer`, { answer: "Allow this once" })).toEqual({ status: 400, error: no });
    expect(await req(`/api/asks/${A1}/answer`, { answer: "No" }, "w1:p3")).toEqual({ status: 400, error: no });
    // a page on another site gets nothing at all (http.ts)
    expect((await req(`/api/asks/${A1}/answer`, { answer: "Allow this once" }, undefined, { origin: "http://evil.example" })).status).toBe(403);
    expect((await req("/api/state")).open.some((x: any) => x.id === A1)).toBe(true);
    expect(await row(P1)).toMatchObject({ status: "refused", allowed_at: null });
    expect((await prompt('rm -rf "$(echo victim1)"')).json.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(marker()).toBe(false);
  });

  test("Allow this once on the page: the lane is told to retry, the call passes once where its prompt comes, and the next is refused", async () => {
    expect(await onPage(A1, "Allow this once")).toEqual({ status: 200, ok: true });
    expect(await row(P1)).toMatchObject({ status: "allowed" });
    expect(marker()).toBe(true);
    expect(await typed("builder", `HUD permit #${P1}`)).toEqual([expect.stringContaining(`HUD permit #${P1}: allowed once by Sam. Retry the exact same call now (Bash: rm -rf "$(echo victim1)"), from /work/repo. It is good for one use within the hour; a changed call is a new request.`)]);
    expect(herdr.typedInto("hq").some((t) => t.includes(`permit #${P1}`))).toBe(false);
    expect(await events()).toContain(`Sam: allowed once: permit #${P1} for builder: Bash: rm -rf "$(echo victim1)"`);
    // another lane's same command, and this lane's other command, are not covered
    expect((await pre('rm -rf "$(echo victim1)"', "w1:p4")).out).toBe("");
    expect((await prompt('rm -rf "$(echo victim1)"', "w1:p4")).json.hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await pre('rm -rf "$(echo victim2)"')).out).toBe("");
    expect(await row(P1)).toMatchObject({ status: "allowed" });
    // the retry: PreToolUse says nothing for a request a prompt stopped; the prompt comes again, and there it passes
    expect((await pre('rm -rf "$(echo victim1)"')).out).toBe("");
    expect(await row(P1)).toMatchObject({ status: "allowed" });
    expect(marker()).toBe(true);
    expect((await prompt('rm -rf "$(echo victim1)"')).out).toBe(ALLOWED);
    expect(marker()).toBe(false);
    expect(await row(P1)).toMatchObject({ status: "used" });
    expect((await events()).filter((e) => e === `hud: permit #${P1} used by builder: Bash: rm -rf "$(echo victim1)"`)).toHaveLength(1);
    // once: the next identical call is a new request
    expect((await pre('rm -rf "$(echo victim1)"')).out).toBe("");
    const next = await prompt('rm -rf "$(echo victim1)"');
    expect(next.json.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(permitOf(next)).toBeGreaterThan(P1);
    expect(hud(["permit", "ask", String(P1)])).toMatchObject({ code: 2, err: `permit #${P1} was allowed and used; a new try is a new permit` });
  });

  test("with no PreToolUse door (a plain prompt), two retries at once: one is allowed", async () => {
    const p = permitOf(await prompt("touch probe.txt", "w1:p3", { permission_mode: "default" }));
    const a = askFor(p);
    expect(hud(["permit", "ask", String(p)]).code).toBe(2);
    await onPage(a, "Allow this once. go ahead");
    // his words with the yes reach the lane
    expect(await typed("builder", `HUD permit #${p}`)).toEqual([expect.stringContaining(`HUD permit #${p}: allowed once by Sam ("go ahead"). Retry the exact same call now (Bash: touch probe.txt)`)]);
    expect(hud(["permit", "ask", String(p)]).err).toMatch(new RegExp(`^permit #${p} is already allowed, until \\d\\d:\\d\\d: tell builder to retry the exact same call$`));
    const both = await Promise.all([prompt("touch probe.txt", "w1:p3", { permission_mode: "default" }), prompt("touch probe.txt", "w1:p3", { permission_mode: "default" })]);
    expect(both.map((r) => r.json.hookSpecificOutput.decision.behavior).sort()).toEqual(["allow", "deny"]);
    expect(marker()).toBe(false);
  });

  test("No, with or without words: the lane hears it, and the request stays refused", async () => {
    const p = permitOf(await prompt("git push --force"));
    const a = askFor(p);
    await onPage(a, "No. rebase instead");
    expect(await typed("builder", `HUD permit #${p}`)).toEqual([expect.stringContaining(`HUD permit #${p}: refused by Sam ("rebase instead"). Do it another way (Bash: git push --force).`)]);
    expect(await row(p)).toMatchObject({ status: "refused" });
    expect(marker()).toBe(false);
    expect((await prompt("git push --force")).json.hookSpecificOutput.decision.behavior).toBe("deny");
    // words that are not the option are not a yes
    const a2 = askFor(p);
    await onPage(a2, "yes");
    expect((await typed("builder", `refused by Sam ("yes")`)).length).toBe(1);
    expect(await row(p)).toMatchObject({ status: "refused" });
    expect(await events()).toContain(`Sam: refused permit #${p} for builder: Bash: git push --force`);
  });

  test("a question edited after it was raised cannot allow anything", async () => {
    const p = permitOf(await prompt("rm -rf dist/*/*"));
    const a = askFor(p);
    expect(hud(["update", String(a), "--body", "**builder** wants to list a folder:\n\n```\nls dist\n```"]).code).toBe(0);
    const r = await onPage(a, "Allow this once");
    expect(r).toEqual({ status: 400, error: `this question was changed after it was raised, so it no longer shows the request as recorded and cannot allow it. HQ: hud withdraw ${a}, then hud permit ask ${p}` });
    expect(await row(p)).toMatchObject({ status: "refused" });
    expect((await req("/api/state")).open.some((x: any) => x.id === a)).toBe(true);
    // withdrawn and raised again, it shows the request again and works
    expect(hud(["withdraw", String(a)]).code).toBe(0);
    const a2 = askFor(p);
    expect(hud(["update", String(a2), "--opt", "Allow this once", "--opt", "No", "--opt", "Always"]).code).toBe(0);
    expect((await onPage(a2, "Allow this once")).status).toBe(400);
    expect(hud(["withdraw", String(a2)]).code).toBe(0);
    const a3 = askFor(p);
    expect((await onPage(a3, "Allow this once")).status).toBe(200);
    expect((await prompt("rm -rf dist/*/*")).out).toBe(ALLOWED);
  });

  test("a classifier block: recorded, asked, allowed, and let through at PreToolUse; nothing is recorded for a call nobody refused", async () => {
    const before = (await req("/api/permits")).permits.length;
    expect((await pre("python3 make.py")).out).toBe("");
    expect((await req("/api/permits")).permits.length).toBe(before);
    const denied = sample("python3 make.py", { hook_event_name: "PermissionDenied", tool_use_id: "toolu_01", reason: "The server-side auto mode classifier judged this action dangerous (it gave no explanation)" });
    expect((await hook("PermissionDenied", denied)).out).toBe("");
    const p = (await req("/api/permits")).permits[0];
    expect(p).toMatchObject({ lane: "builder", kind: "classifier", status: "refused", reason: "The server-side auto mode classifier judged this action dangerous (it gave no explanation)" });
    expect(hud(["permit"]).out).toContain(`#${p.id}  now  builder  classifier  refused  Bash: python3 make.py`);
    const a = askFor(p.id);
    // the card says it was auto mode's own check
    expect((await req("/api/state")).open.find((x: any) => x.id === a).body).toContain("auto mode. Auto mode's safety check blocked it (The server-side auto mode classifier judged this action dangerous (it gave no explanation)). Permit #");
    await onPage(a, "Allow this once");
    expect((await pre("python3 make.py")).json).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `the owner allowed this exact call once on the HUD (permit #${p.id})` } });
    expect(await row(p.id)).toMatchObject({ status: "used" });
    expect(marker()).toBe(false);
    // once, at either door, however fast the next identical call comes
    expect((await pre("python3 make.py")).out).toBe("");
    expect((await prompt("python3 make.py")).json.hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await events()).filter((e) => e === `hud: permit #${p.id} used by builder: Bash: python3 make.py`)).toHaveLength(1);
  });

  test("an allowed request the classifier blocks on its retry: the lane is told it may retry, and that try passes at PreToolUse, once", async () => {
    // stopped by auto mode's fallback prompt, so recorded as a prompt
    const p = permitOf(await prompt("python3 seed.py"));
    await onPage(askFor(p), "Allow this once");
    expect((await pre("python3 seed.py")).out).toBe("");
    // the retry meets the classifier, not a prompt
    const denied = sample("python3 seed.py", { hook_event_name: "PermissionDenied", tool_use_id: "toolu_02", reason: "judged dangerous" });
    expect((await hook("PermissionDenied", denied)).out).toBe(`{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}`);
    expect(await row(p)).toMatchObject({ status: "allowed", kind: "classifier" });
    expect((await pre("python3 seed.py")).json.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(await row(p)).toMatchObject({ status: "used" });
    // and that was it: blocked again, it is a new refused request with no retry
    expect((await hook("PermissionDenied", denied)).out).toBe("");
    expect((await pre("python3 seed.py")).out).toBe("");
    // another lane's block of the same command gets no retry out of someone else's allow
    const p2 = permitOf(await prompt("python3 seed.py"));
    await onPage(askFor(p2), "Allow this once");
    expect((await hook("PermissionDenied", denied, "w1:p4")).out).toBe("");
    expect((await hook("PermissionDenied", denied, "w1:p1")).out).toBe("");
    expect(await row(p2)).toMatchObject({ status: "allowed", kind: "prompt" });
    expect((await prompt("python3 seed.py")).out).toBe(ALLOWED);
  });

  test("a call that leaves the sandbox is its own request, and the card says so", async () => {
    const plain = permitOf(await prompt("npm publish"));
    const out = permitOf(await prompt("npm publish", "w1:p3", { tool_input: { command: "npm publish", description: "x", dangerouslyDisableSandbox: true } }));
    expect(out).not.toBe(plain);
    await onPage(askFor(plain), "Allow this once");
    expect((await prompt("npm publish", "w1:p3", { tool_input: { command: "npm publish", description: "x", dangerouslyDisableSandbox: true } })).json.hookSpecificOutput.decision.behavior).toBe("deny");
    expect((await prompt("npm publish")).out).toBe(ALLOWED);
    const a = askFor(out);
    expect((await req("/api/state")).open.find((x: any) => x.id === a).body).toStartWith("**builder** wants to run this command (Bash), **outside the sandbox** in `/work/repo`, auto mode.");
    expect(hud(["permit"]).out).toContain(`#${out}  now  builder  prompt  refused, waiting on the owner (ask #${a})  2 tries  Bash (outside the sandbox): npm publish`);
  });

  test("a page on claude.ai and a stuck prompt cannot be asked for; the lane is told to get the page as a file", async () => {
    const r = await hook("PermissionRequest", { ...sample("x"), tool_name: "Artifact", tool_input: { action: "read", url: "https://claude.ai/artifact/4LG5nmviwY6V7BBwVHPin1" }, permission_suggestions: undefined });
    const p = permitOf(r);
    expect(r.json.hookSpecificOutput.decision.message).toBe(`${REFUSED}. This request cannot be allowed from the HUD: Claude Code throws away a hook's allow for reading a page on claude.ai made outside the organization; send the lane the page as a file (permit #${p})`);
    expect(hud(["permit", "ask", String(p)])).toMatchObject({ code: 2, out: "" });
    expect(hud(["permit", "ask", String(p)]).err).toStartWith(`permit #${p} cannot be allowed: Claude Code throws away a hook's allow`);
    expect(hud(["permit", "show", String(p)]).out).toContain("cannot be allowed: Claude Code throws away");
    // a prompt the hook did not answer: an event on the lane, and nothing to allow
    await hook("Notification", { session_id: "08ae8379-e814-4416-ba2c-cb45a94ba9d5", cwd: "/work/repo", hook_event_name: "Notification", message: "Claude needs your permission", notification_type: "permission_prompt" });
    const stuck = (await req("/api/permits")).permits[0];
    expect(stuck).toMatchObject({ lane: "builder", kind: "stuck", reason: "Claude needs your permission", tool: null, input: null });
    const ev = (await req("/api/state")).events.find((e: any) => e.text.includes(`(permit #${stuck.id})`));
    expect(ev).toMatchObject({ who: "hook", lane: "builder", text: `is showing a prompt its hook did not answer: Claude needs your permission (permit #${stuck.id})` });
    expect(hud(["permit", "ask", String(stuck.id)]).err).toStartWith(`permit #${stuck.id} cannot be allowed: it is a prompt the hook never got to answer`);
  });

  test("the file is for lanes only: an HQ, an agent that is no lane and an unknown pane are refused, told why, and cannot be asked for", async () => {
    for (const [pane, who] of [["w1:p1", "hq"], ["w1:p5", "loose"], ["w9:p9", null]] as const) {
      const r = await prompt("touch not-a-lane.txt", pane);
      const p = permitOf(r);
      expect(r.out).toBe(DENY(`${REFUSED}. Nothing can be allowed here: this pane is not a registered lane (permit #${p})`));
      expect((await req(`/api/permits/${p}`)).permit).toMatchObject({ lane: who, status: "refused" });
      expect(hud(["permit", "ask", String(p)])).toMatchObject({ code: 2, err: `permit #${p} is not from a registered lane (${who ?? "a pane herdr has no agent in"}): the lane settings file is for lanes only` });
    }
  });

  test("a held secret in a command never reaches hud.db, the question, the log or what is typed", async () => {
    expect((await req("/api/secrets", { name: "DEPLOY_TOKEN", value: SECRET, minutes: 5, by: "owner" })).status).toBe(200);
    const command = `curl -H "authorization: ${SECRET}" https://example.com/deploy`;
    const p = permitOf(await prompt(command, "w1:p3", { cwd: `/work/${SECRET}` }));
    const a = askFor(p, `it holds ${SECRET}`);
    const st = await req("/api/state");
    expect(st.open.find((x: any) => x.id === a).body).toContain('curl -H "authorization: [secret DEPLOY_TOKEN]" https://example.com/deploy');
    expect(JSON.stringify(st)).not.toContain(SECRET);
    await onPage(a, "Allow this once");
    await typed("builder", `HUD permit #${p}`);
    // the retry, value and all, is the same request
    expect((await prompt(command, "w1:p3", { cwd: `/work/${SECRET}` })).out).toBe(ALLOWED);
    expect(hud(["permit", "show", String(p)]).out).not.toContain(SECRET);
    expect(hud(["permit"]).out).not.toContain(SECRET);
    expect(herdr.typed().some(([, t]) => t.includes(SECRET))).toBe(false);
    const files = readdirSync(DATA).filter((f) => f.startsWith("hud.db"));
    expect(files).toContain("hud.db");
    for (const f of files) {
      const bytes = readFileSync(join(DATA, f)).toString("latin1");
      expect(bytes.includes(SECRET)).toBe(false);
      expect(bytes.includes(JSON.stringify(SECRET).slice(1, -1))).toBe(false);
      expect(bytes.includes("7731-permits-GREP")).toBe(false);
    }
    expect(readFileSync(join(DATA, "hud.db")).toString("latin1") + (existsSync(join(DATA, "hud.db-wal")) ? readFileSync(join(DATA, "hud.db-wal")).toString("latin1") : "")).toContain("[secret DEPLOY_TOKEN]");
  });

  test("a lane that moves to another floor takes its permits along; one that is no longer a lane cannot be allowed", async () => {
    const p = permitOf(await prompt("make deploy", "w1:p4"));
    expect(hud(["permit"]).out).toContain(`#${p}  now  other  prompt  refused  Bash: make deploy`);
    expect(hud(["lane", "other", "--floor", "crm"]).code).toBe(0);
    expect(hud(["permit"]).out).not.toContain(`#${p} `);
    expect(hud(["permit"], "w1:p2").out).toContain(`#${p}  now  other  prompt  refused  Bash: make deploy`);
    expect(hud(["permit", "show", String(p)]).code).toBe(2);
    expect(hud(["permit", "show", String(p)], "w1:p2").out).toContain("lane    other  (floor crm)");
    // its HQ asks; the lane goes before the owner answers
    const r = hud(["permit", "ask", String(p)], "w1:p2");
    expect(r.err).toBe("");
    const a = Number(r.out.match(/^ask #(\d+)/)![1]);
    expect((await req("/api/state")).open.find((x: any) => x.id === a).floor).toBe("crm");
    expect(hud(["rm-lane", "other"]).code).toBe(0);
    expect(await onPage(a, "Allow this once")).toEqual({ status: 400, error: `other is no longer a lane, so nothing could use the allow. HQ: hud withdraw ${a}` });
    expect(marker()).toBe(false);
  });
});
