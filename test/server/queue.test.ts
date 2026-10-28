// The queue: every message to HQ waits as an ask with a recipient; only an urgent one types a line into a pane.
// Urgent sorts first on the owner's desk and on HQ's queue, every urgent use is counted, the board's part of the
// state carries the count, and the owner's Tell HQ takes either path. Own server, own data dir, a fake herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-office-queue-"));
const PROMPTS = join(DATA, "prompts.log");
let stop: () => Promise<void>;
let BASE = "";

// Prompts are typed after the request returns: let an earlier test's finish before counting, so a test sees only its own.
const settled = async () => { await Bun.sleep(300); return prompts().length; };
const prompts = () => (existsSync(PROMPTS) ? readFileSync(PROMPTS, "utf8").trim().split("\n").filter(Boolean) : []);
const post = async (path: string, body: unknown) => {
  const res = await fetch(BASE + path, { method: "POST", headers: { "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (path: string) => (await fetch(BASE + path)).json();
const hud = async (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, "hud.ts", ...args], { cwd: ROOT, env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
};
const file = (over: Record<string, unknown> = {}) => post("/api/requests", { lane: "chat-lane", text: "a plain message", ...over });
const ids = async (path = "/api/requests") => (await get(path)).map((r: any) => r.id);

beforeAll(async () => {
  writeFileSync(join(DATA, "herdr"), `#!/bin/sh\nD=$(dirname "$0")\ncase "$*" in\n*"agent list"*) echo '{"result":{"agents":[{"name":"chat-lane","pane_id":"w8:pQ","agent":"claude","agent_status":"idle"}]}}' ;;\n*"agent prompt"*) printf '%s\\n' "$*" >> "$D/prompts.log" ;;\nesac\n`);
  chmodSync(join(DATA, "herdr"), 0o755);
  const server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "herdr"), HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0" } });
  BASE = server.base;
  stop = server.stop;
  for (const deadline = Date.now() + 8000; !(await get("/api/state")).sync.at && Date.now() < deadline; ) await Bun.sleep(100);
});
afterAll(async () => {
  await stop?.();
  rmSync(DATA, { recursive: true, force: true });
});

test("a plain message waits in the queue and types nothing; an urgent one sorts first and types one line", async () => {
  const before = await settled();
  const first = (await file({ text: "first, plain" })).body.id;
  await Bun.sleep(5);
  const second = (await file({ text: "second, plain" })).body.id;
  await Bun.sleep(5);
  const urgent = (await file({ text: "the build is on fire\nsecond line stays out of the pane", urgent: true })).body.id;
  expect(await ids()).toEqual([urgent, first, second]);
  expect((await get("/api/requests/next")).id).toBe(urgent);
  await Bun.sleep(300);
  expect(prompts().slice(before)).toEqual(["agent prompt hq URGENT from chat-lane: the build is on fire"]);
  for (const id of [urgent, first, second]) expect((await post(`/api/requests/${id}/answer`, { text: "ok" })).status).toBe(200);
  expect(await ids()).toEqual([]);
});

test("the board's part of the state carries the count, the oldest item and the urgent ones", async () => {
  expect((await get("/api/state")).queue).toMatchObject({ lead: "HQ", count: 0, oldest: null, urgent: 0 });
  const a = (await file({ text: "one" })).body.id;
  const b = (await file({ text: "two", urgent: true })).body.id;
  const q = (await get("/api/state")).queue;
  expect(q).toMatchObject({ count: 2, urgent: 1 });
  expect(q.oldest).toBe((await get("/api/requests")).find((r: any) => r.id === a).created_at);
  for (const id of [a, b]) await post(`/api/requests/${id}/answer`, { text: "ok" });
});

test("hud request --file reads the body from a file, the kind is optional, and the command returns at once", async () => {
  const path = join(DATA, "long.txt");
  const long = `Report line one\n${"x".repeat(5000)}\nlast line`;
  writeFileSync(path, long);
  const before = await settled();
  const out = await hud("request", "--lane", "chat-lane", "--file", path);
  expect(out).toMatchObject({ code: 0 });
  const id = Number(out.out.match(/request #(\d+)/)![1]);
  const row = (await get("/api/requests")).find((r: any) => r.id === id);
  expect(row).toMatchObject({ kind: "NOTE", status: "open", lead: "HQ", text: long });
  expect(prompts().length).toBe(before);
  expect((await hud("request", "--lane", "chat-lane", "--file", join(DATA, "missing.txt"))).code).toBe(2);
  await post(`/api/requests/${id}/answer`, { text: "read" });
});

test("urgent is a flag on the desk too: it sorts to the top marked, nothing is typed, and the other asks show as before", async () => {
  const plain = (await post("/api/asks", { title: "plain question", created_at: Date.now() - 60_000 })).body.id;
  const before = await settled();
  const out = await hud("ask", "--lane", "chat-lane", "--title", "urgent question", "--urgent");
  const urgent = Number(out.out.match(/ask #(\d+)/)![1]);
  const open = (await get("/api/state")).open;
  expect(open.map((a: any) => a.id).slice(0, 2)).toEqual([urgent, plain]);
  expect(open[0].urgent_at).toBeGreaterThan(0);
  expect(open[1].urgent_at).toBeNull();
  await Bun.sleep(200);
  expect(prompts().length).toBe(before);
  // The desk shows only the owner's asks: a queue item never appears there, and the owner's answer route refuses it.
  const queued = (await file({ text: "for HQ" })).body.id;
  expect((await get("/api/state")).open.map((a: any) => a.id)).not.toContain(queued);
  expect((await post(`/api/asks/${queued}/answer`, { answer: "x" })).body.error).toContain("hud req answer");
  await post(`/api/requests/${queued}/answer`, { text: "ok" });
  for (const id of [plain, urgent]) await post(`/api/asks/${id}/answer`, { answer: "done" });
});

test("pushing an existing item up is an urgent use; it sorts first and the line is typed once", async () => {
  const a = (await file({ text: "older" })).body.id;
  await Bun.sleep(5);
  const b = (await file({ text: "newer" })).body.id;
  const before = await settled();
  expect((await hud("urgent", String(b), "--by", "pm-lane")).code).toBe(0);
  expect((await hud("urgent", String(b), "--by", "pm-lane")).code).toBe(0);
  expect(await ids()).toEqual([b, a]);
  await Bun.sleep(300);
  expect(prompts().slice(before)).toEqual(["agent prompt hq URGENT from chat-lane: newer"]);
  for (const id of [a, b]) await post(`/api/requests/${id}/answer`, { text: "ok" });
});

test("every urgent use is a row, and hud urgent reports them by who and by recipient", async () => {
  const report = await get("/api/urgent?since=7d");
  const n = (by: string, recipient: string) => report.find((r: any) => r.by === by && r.recipient === recipient)?.n;
  // chat-lane: two urgent requests so far to HQ; the urgent desk ask went to the owner; pm-lane pushed one twice.
  expect(n("chat-lane", "HQ")).toBe(2);
  expect(n("chat-lane", "owner")).toBe(1);
  expect(n("pm-lane", "HQ")).toBe(2);
  const out = await hud("urgent", "--since", "7d");
  expect(out.out).toContain("urgent uses in the last 7d: 5");
  expect(out.out).toMatch(/2\s+chat-lane -> HQ/);
  expect((await get("/api/urgent?since=0m")).length).toBe(0);
  expect((await hud("urgent", "--since", "soon")).code).toBe(1);
});

test("Tell HQ goes to the queue by default, and URGENT puts it first and types the line", async () => {
  const before = await settled();
  expect((await post("/api/notes", { text: "a plain note from the owner" })).status).toBe(200);
  expect((await post("/api/notes", { text: "an urgent note", urgent: true })).status).toBe(200);
  const open = (await get("/api/requests?lead=HQ")).filter((r: any) => ["an urgent note", "a plain note from the owner"].includes(r.text));
  expect(open.map((r: any) => r.text)).toEqual(["an urgent note", "a plain note from the owner"]);
  expect(open[0]).toMatchObject({ lane: null, kind: "NOTE" });
  // HQ's inbox no longer carries it (hud wait does not wake on a Tell: the queue does), but the owner's page still shows
  // what he sent, in the note shape, newest first, and "HQ has it" lights once HQ reads it.
  expect((await get("/api/inbox")).notes).toEqual([]);
  const mine = (await get("/api/state")).notes.filter((n: any) => ["a plain note from the owner", "an urgent note"].includes(n.text));
  expect(mine.map((n: any) => n.text)).toEqual(["an urgent note", "a plain note from the owner"]);
  expect(mine[0]).toMatchObject({ id: expect.stringMatching(/^q\d+$/), acked_at: null });
  await Bun.sleep(300);
  expect(prompts().slice(before)).toEqual(["agent prompt hq URGENT from the owner: an urgent note"]);
  // Reading the first (hud req next) lights it; the other stays unread.
  expect((await get("/api/requests/next")).text).toBe("an urgent note");
  const after = (await get("/api/state")).notes;
  expect(after.find((n: any) => n.text === "an urgent note").acked_at).toBeGreaterThan(0);
  expect(after.find((n: any) => n.text === "a plain note from the owner").acked_at).toBeNull();
  // A note with no lane has nothing to deliver: answering it closes it.
  for (const r of open) expect((await post(`/api/requests/${r.id}/answer`, { text: "read" })).status).toBe(200);
});

test("a reply from the MESSAGES tab reaches the queue and stays in the page's notes, with ids the thread can address", async () => {
  const up = (await post("/api/updates", { title: "PR is up" })).body.id;
  await post("/api/notes", { text: "the first note" });
  const parent = (await get("/api/state")).notes.find((n: any) => n.text === "the first note");
  await post("/api/notes", { text: `re: #u${up} ("PR is up") looks good` });
  await post("/api/notes", { text: `re: #n${parent.id} ("first note") and also this` });
  const notes = (await get("/api/state")).notes;
  const ids = notes.map((n: any) => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(notes.map((n: any) => n.text)).toEqual(expect.arrayContaining([`re: #u${up} ("PR is up") looks good`, `re: #n${parent.id} ("first note") and also this`]));
  for (const r of await get("/api/requests")) await post(`/api/requests/${r.id}/answer`, { text: "read" });
});

test("an old note in the notes table and a queued Tell share the page's list with distinct ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-notes-"));
  const script = `
    await import("./src/server/herdr.ts");
    const { db } = await import("./src/server/db.ts");
    const { tellHq } = await import("./src/server/queue.ts");
    const { state } = await import("./src/server/state.ts");
    db.query("INSERT INTO notes (at, text, acked_at) VALUES (?, ?, ?)").run(1000, "an old note", 2000);
    const id = tellHq("a new tell", false, true, 5000).id;
    console.log(JSON.stringify([id, state().notes]));
    process.exit(0);`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: ROOT, env: { ...process.env, HUD_DATA_DIR: dir, HERDR_BIN: join(DATA, "herdr") }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  const [id, notes] = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(notes).toEqual([
    { id: `q${id}`, at: 5000, text: "a new tell", acked_at: null },
    { id: 1, at: 1000, text: "an old note", acked_at: 2000 },
  ]);
});

test("HQ's answer to an owner's note is an HQ update titled with the note, and the CLI says so", async () => {
  await post("/api/notes", { text: "can you merge the fix?\nthanks" });
  const item = (await get("/api/requests")).find((r: any) => r.text.startsWith("can you merge"));
  const out = await hud("req", "answer", String(item.id), "done,", "merged");
  expect(out).toMatchObject({ code: 0 });
  expect(out.out).toContain("posted to the owner");
  const updates = (await get("/api/state")).updates;
  expect(updates[0]).toMatchObject({ title: "Re: can you merge the fix?", body: "done, merged", lane: null });
  expect(await ids()).not.toContain(item.id);
});

test("HQ closes an owner's note that needs no reply: no update, no delivery error", async () => {
  await post("/api/notes", { text: "fyi: the demo moved to Friday" });
  const item = (await get("/api/requests")).find((r: any) => r.text.startsWith("fyi: the demo"));
  const before = (await get("/api/state")).updates.length;
  const out = await hud("req", "close", String(item.id), "noted");
  expect(out).toMatchObject({ code: 0, out: `the owner's note #${item.id} closed with no reply` });
  const state = await get("/api/state");
  expect(state.updates.length).toBe(before);
  expect(await ids()).not.toContain(item.id);
  expect(state.events.some((e: any) => e.text.startsWith(`closed the owner's note #${item.id}`))).toBe(true);
});

test("an old request number still works: the id falls back to the request it was copied from", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-oldid-"));
  const script = `
    await import("./src/server/herdr.ts");
    const { db } = await import("./src/server/db.ts");
    const { answerRequest, openRequests } = await import("./src/server/queue.ts");
    db.query("INSERT INTO asks (lane, kind, title, created_at, recipient, request_id) VALUES (NULL, 'NOTE', 'old one', 1, 'HQ', 52)").run();
    const r = await answerRequest(52, "ok", async () => ({ ok: true }));
    console.log(JSON.stringify([r.id !== 52, openRequests().length]));
    process.exit(0);`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: ROOT, env: { ...process.env, HUD_DATA_DIR: dir, HERDR_BIN: join(DATA, "herdr") }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  expect(JSON.parse(out.trim().split("\n").at(-1) || "null"), err).toEqual([true, 0]);
});

test("the owner's desk routes refuse a queue item: withdraw, ack, update, comment, secrets", async () => {
  const id = (await file({ text: "queue only" })).body.id;
  for (const [path, body] of [["withdraw", {}], ["ack", {}], ["update", { title: "x" }], ["comment", { text: "x" }], ["items", { text: "x" }]] as const) {
    const r = await post(`/api/asks/${id}/${path}`, body);
    expect(r.status, path).toBe(400);
    expect(r.body.error).toContain("not the owner");
  }
  expect((await get("/api/requests")).find((r: any) => r.id === id)).toMatchObject({ status: "open" });
  await post(`/api/requests/${id}/answer`, { text: "ok" });
});

test("hud urgent ID needs --by or --lane, and a flag value may begin with --", async () => {
  const id = (await file({ text: "who pushes this" })).body.id;
  const bare = await hud("urgent", String(id));
  expect(bare.code).toBe(2);
  expect(bare.err).toContain("--by");
  expect((await hud("urgent", String(id), "--lane", "chat-lane")).code).toBe(0);
  expect((await get("/api/urgent?since=7d")).some((r: any) => r.by === "chat-lane")).toBe(true);
  const ask = await hud("ask", "--title", "flag values", "--opt", "--force push", "--opt", "wait");
  const ctr = Number(ask.out.match(/ask #(\d+)/)![1]);
  expect((await get("/api/state")).open.find((a: any) => a.id === ctr).options).toEqual(["--force push", "wait"]);
  await post(`/api/asks/${ctr}/answer`, { answer: "wait" });
  await post(`/api/requests/${id}/answer`, { text: "ok" });
});

test("a queued item is not closed as gone before the first sync: a live lane's row is in the agents table", async () => {
  const id = (await file({ text: "lane is live" })).body.id;
  const r = await post(`/api/requests/${id}/close`, { reason: "gone" });
  expect(r.status).toBe(400);
  expect(r.body.error).toContain("is live");
  expect((await get("/api/agents")).map((a: any) => a.name)).toContain("chat-lane");
  await post(`/api/requests/${id}/answer`, { text: "ok" });
});

test("tellHq takes either path from the one constant: the queue by default, the pane when it is off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-office-tell-"));
  const script = `
    await import("./src/server/herdr.ts");
    const { tellHq, TELL_GOES_TO_QUEUE } = await import("./src/server/queue.ts");
    console.log(JSON.stringify([TELL_GOES_TO_QUEUE, tellHq("plain", false), tellHq("plain", false, false), tellHq("urgent", true, false).queued, tellHq("plain", false, true).queued]));
    process.exit(0);`;
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: ROOT, env: { ...process.env, HUD_DATA_DIR: dir, HERDR_BIN: join(DATA, "herdr") }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  const [constant, byDefault, off, urgentWhenOff, plainWhenOn] = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(constant).toBe(true);
  expect(byDefault.queued).toBe(true);
  expect(off).toEqual({ queued: false }); // the route then types the note into HQ's pane as before
  expect(urgentWhenOff).toBe(true);
  expect(plainWhenOn).toBe(true);
});
