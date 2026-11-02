// COMMENTS on a brief or a room's page: the owner's comment is typed into the page's author (a lane that posted the
// brief, else the floor's HQ through its outbox; a room's page, the room's owner), kept while a lane is away and sent
// once when it is back; authors read and answer from the CLI, and an answer marks the page (S.comments) and puts one
// line in MESSAGES. A stub herdr records what is typed; no real agent is ever prompted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-comments-"));
const HQ: FakeAgent = { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" };
const CRM: FakeAgent = { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" };
const WRITER: FakeAgent = { name: "writer", agent_status: "idle", pane_id: "w1:p3", agent: "claude" };
const herdr = fakeHerdr(DATA, [HQ, CRM, WRITER]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const req = async (p: string, b?: object, pane?: string) => {
  const r = await fetch(`${server.base}${p}`, b ? { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}) }, body: JSON.stringify(b) } : {});
  return { status: r.status, ...(await r.json()) };
};
const hud = (args: string[], pane = "", stdin?: string) => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
};
// What was typed into an agent and contains `part`, once it has landed (delivery runs after the request returns).
async function typed(name: string, part: string, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (herdr.typedInto(name).some((t) => t.includes(part))) break;
  await Bun.sleep(250); // a duplicate would land by now
  return herdr.typedInto(name).filter((t) => t.includes(part));
}
const thread = (page: string) => req(`/api/comments?page=${encodeURIComponent(page)}`);
let hqBrief = 0, laneBrief = 0, crmBrief = 0;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_OWNER: "Sam" } });
  await req("/api/sync", {});
  await req("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await req("/api/lanes", { name: "writer", parent: "hq", machine: "local" });
  await req("/api/sync", {});
  hqBrief = (await req("/api/briefs", { title: "Weekly: pricing", body: "## Where we are\n\nThe pricing page is live." }, "w1:p1")).id;
  laneBrief = (await req("/api/briefs", { title: "Copy plan", body: "<!doctype html><html><body><h1>Copy plan</h1></body></html>" }, "w1:p3")).id;
  crmBrief = (await req("/api/briefs", { title: "CRM import", body: "Two steps." }, "w1:p2")).id;
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("a comment on HQ's brief goes to that floor's HQ through its outbox, with the quote and how to answer", async () => {
  const r = await req("/api/comments/post", { page: `briefs/${hqBrief}`, text: "Why live already?", quote: "The pricing page is live." });
  expect(r).toMatchObject({ status: 200, to: "hq" });
  const got = await typed("hq", "Why live already?");
  expect(got.length).toBe(1);
  expect(got[0]).toContain(`HUD comment on brief #${hqBrief} ("Weekly: pricing"): Sam commented (comment #${r.id}):`);
  expect(got[0]).toContain("> The pricing page is live.\nWhy live already?");
  expect(got[0]).toContain(`hud brief reply ${hqBrief} "<your answer>" --reply ${r.id}`);
  const t = await thread(`briefs/${hqBrief}`);
  expect(t).toMatchObject({ page: `briefs/${hqBrief}`, kind: "brief", title: "Weekly: pricing", to: "hq", hq: true, link: `#brief/${hqBrief}` });
  expect(t.comments).toEqual([expect.objectContaining({ id: r.id, who: "owner", to: "hq", text: "Why live already?", quote: "The pricing page is live.", delivery: "sent" })]);
  // another floor's brief: that floor's HQ
  await req("/api/comments/post", { page: `#brief/${crmBrief}`, text: "Which step first?" });
  expect((await typed("hq-crm", "Which step first?")).length).toBe(1);
  expect(herdr.typedInto("hq").some((t) => t.includes("Which step first?"))).toBe(false);
});

test("a brief a lane posted: its comments are typed into that lane", async () => {
  const r = await req("/api/comments/post", { page: `briefs/${laneBrief}`, text: "Shorter headline?" });
  expect(r.to).toBe("writer");
  const got = await typed("writer", "Shorter headline?");
  expect(got.length).toBe(1);
  expect(got[0]).toContain(`hud brief reply ${laneBrief}`);
  expect((await thread(`briefs/${laneBrief}`)).comments.at(-1)).toMatchObject({ to: "writer", delivery: "sent" });
});

test("a lane that is away keeps the comment, and gets it once when herdr sees it again", async () => {
  herdr.world([HQ, CRM]);
  await req("/api/sync", {});
  const r = await req("/api/comments/post", { page: `briefs/${laneBrief}`, text: "Are you there?" });
  await Bun.sleep(300);
  expect(herdr.typedInto("writer").some((t) => t.includes("Are you there?"))).toBe(false);
  expect((await thread(`briefs/${laneBrief}`)).comments.at(-1)).toMatchObject({ id: r.id, delivery: "away" });
  expect((await thread(`briefs/${laneBrief}`)).away).toBe(true);
  herdr.world([HQ, CRM, WRITER]);
  await req("/api/sync", {});
  await req("/api/sync", {});
  const got = await typed("writer", "Are you there?");
  expect(got.length).toBe(1);
  expect(got[0]).toContain("while you were away");
  expect((await thread(`briefs/${laneBrief}`)).comments.at(-1)).toMatchObject({ id: r.id, delivery: "sent" });
});

test("the CLI: hud brief comments reads the thread, hud brief reply answers; the answer marks the brief and MESSAGES", async () => {
  const first = (await thread(`briefs/${laneBrief}`)).comments[0].id;
  const read = hud(["brief", "comments", String(laneBrief)], "w1:p3");
  expect(read.code).toBe(0);
  expect(read.out).toContain(`comments on Copy plan (briefs/${laneBrief}), for writer`);
  expect(read.out).toContain(`#${first} `);
  expect(read.out).toContain("owner [delivered]:\n  Shorter headline?");
  expect(read.out).toContain(`answer: hud brief reply ${laneBrief} "<your answer>" [--reply N]`);
  const json = JSON.parse(hud(["brief", "comments", String(laneBrief), "--json"]).out);
  expect(json.comments.length).toBe(2);

  const r = hud(["brief", "reply", String(laneBrief), "Yes:", "four", "words", "max.", "--reply", String(first)], "w1:p3");
  expect(r.err).toBe("");
  expect(r.out).toMatch(new RegExp(`^answer #\\d+ on briefs/${laneBrief}$`));
  const t = await thread(`briefs/${laneBrief}`);
  expect(t.comments.at(-1)).toMatchObject({ who: "writer", text: "Yes: four words max.", reply: first, delivery: null, read: false });
  const s = await req("/api/state");
  expect(s.comments[`briefs/${laneBrief}`]).toMatchObject({ n: 3, unread: 1 });
  expect(s.updates.find((u: any) => u.title === "writer answered on brief: Copy plan")).toMatchObject({ floor: "hq", body: `Yes: four words max.\n\n[Open the comments](#brief/${laneBrief})` });
  // the owner opens the thread: the answer is read
  await req("/api/comments/seen", { page: `briefs/${laneBrief}` });
  expect((await req("/api/state")).comments[`briefs/${laneBrief}`].unread).toBe(0);
  // a reply to a comment on another page, an empty one and an unknown brief are refused
  expect(hud(["brief", "reply", String(hqBrief), "x", "--reply", String(first)]).err).toContain(`no comment #${first} on briefs/${hqBrief}`);
  expect(hud(["brief", "reply", String(hqBrief)]).code).toBe(2);
  expect(hud(["brief", "comments", "99999"]).err).toContain("no brief #99999");
});

test("a room's pages: comments go to the room's owner; hud page comments and reply take the page's key", async () => {
  await req("/api/rooms", { slug: "copy", title: "Copy", owner: "writer" });
  const key = "rooms/copy/files/plan v2.html";
  const r = await req("/api/comments/post", { page: `#page/rooms/copy/files/${encodeURIComponent("plan v2.html")}`, text: "Swap the two sections." });
  expect(r.to).toBe("writer");
  const got = await typed("writer", "Swap the two sections.");
  expect(got[0]).toContain(`HUD comment on the page plan v2.html in room copy: Sam commented`);
  expect(got[0]).toContain(`hud page reply ${key} "<your answer>" --reply ${r.id}`);
  const out = hud(["page", "reply", key, "--reply", String(r.id)], "w1:p3", "Swapped.");
  expect(out.out).toBe(`answer #${Number(r.id) + 1} on ${key}`);
  expect(hud(["page", "comments", key]).out).toContain("writer (re #");
  const s = await req("/api/state");
  expect(s.comments[key]).toMatchObject({ n: 2, unread: 1 });
  expect(s.updates.find((u: any) => u.title === "writer answered on plan v2.html in room copy").body).toContain(`(#page/rooms/copy/files/plan%20v2.html)`);
  // a room's brief, and a room HQ owns: that floor's HQ
  await req("/api/rooms", { slug: "ops", title: "Ops", owner: "hq" });
  await req("/api/comments/post", { page: "rooms/ops/brief", text: "Who runs this?" });
  expect((await typed("hq", "Who runs this?"))[0]).toContain("HUD comment on the brief of room ops: Sam commented");
  // not pages
  expect((await thread("rooms/copy/files/notes.md")).status).toBe(404);
  expect((await thread("rooms/nope/brief")).error).toBe("no room nope");
  expect((await req("/api/comments/post", { page: "elsewhere/1", text: "x" })).status).toBe(400);
  expect((await req("/api/comments/post", { page: `briefs/${hqBrief}`, text: "  " })).error).toBe("write a comment first");
});
