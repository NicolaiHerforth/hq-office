// Briefs are floor isolated (docs/floors.md): the state carries each floor's newest 100, so a busy floor never pushes
// another's out; an agent reads and answers its own floor's briefs, their comments and their page data, and another
// floor's only with --all; the HUD's page reads every floor. A comment goes to an agent on the brief's floor only. A
// stub herdr gives the HQs and the lanes their panes; nothing real is prompted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-brief-floors-"));
const HQ: FakeAgent = { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" };
const CRM: FakeAgent = { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" };
const WRITER: FakeAgent = { name: "writer", agent_status: "idle", pane_id: "w1:p3", agent: "claude" };
const herdr = fakeHerdr(DATA, [HQ, CRM, WRITER]);
let server: Awaited<ReturnType<typeof spawnServer>>;
// An agent's call carries what hud sends (its pane and folder); the page's carries none.
const agent = (pane: string, floor?: string) => ({ "x-hud-pane": pane, "x-hud-machine": "local", "x-hud-cwd": encodeURIComponent(DATA), ...(floor ? { "x-hud-floor": floor } : {}) });
const post = async (p: string, b: object = {}, h: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string, h: object = {}) => { const r = await fetch(`${server.base}${p}`, { headers: h as Record<string, string> }); return { status: r.status, ...(await r.json()) }; };
const hud = (args: string[], pane: string) => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { cwd: DATA, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
};
async function typed(name: string, part: string, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (herdr.typedInto(name).some((t) => t.includes(part))) break;
  await Bun.sleep(250);
  return herdr.typedInto(name).filter((t) => t.includes(part));
}
let crmBrief = 0, crmPage = 0, writerBrief = 0;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_OWNER: "Sam" } });
  await post("/api/sync");
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "writer", parent: "hq", machine: "local" });
  await post("/api/sync");
  crmBrief = (await post("/api/briefs", { title: "CRM import", body: "Two steps." }, agent("w1:p2"))).id;
  crmPage = (await post("/api/briefs", { title: "CRM board", body: "<!doctype html><html><body><h1>Board</h1></body></html>" }, agent("w1:p2"))).id;
  writerBrief = (await post("/api/briefs", { title: "Copy plan", body: "Short words." }, agent("w1:p3"))).id;
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("the state carries each floor's newest 100 briefs: a busy floor never pushes another's out", async () => {
  for (let i = 0; i < 101; i++) expect((await post("/api/briefs", { title: `HQ note ${i}`, body: "x" }, agent("w1:p1"))).status).toBe(200);
  const s = await get("/api/state");
  const on = (f: string) => s.briefs.filter((b: any) => b.floor === f);
  expect(on("hq").length).toBe(100);
  expect(on("hq")[0].title).toBe("HQ note 100");
  expect(on("hq").some((b: any) => b.id === writerBrief)).toBe(false); // the hq floor's oldest went
  expect(on("crm").map((b: any) => b.id)).toEqual([crmPage, crmBrief]);
  // newest first across floors, as before
  expect(s.briefs.map((b: any) => b.at)).toEqual([...s.briefs.map((b: any) => b.at)].sort((a, b) => b - a));
}, 30_000);

test("GET /api/briefs/ID: another floor's agent is refused unless --all; its own floor and the page read it", async () => {
  const refused = await get(`/api/briefs/${crmBrief}`, agent("w1:p1"));
  expect(refused.status).toBe(403);
  expect(refused.error).toBe(`brief #${crmBrief} is on floor crm, not yours (hq). Its HQ reads and answers it; add --all to reach another floor's`);
  expect(refused.body).toBeUndefined();
  expect(await get(`/api/briefs/${crmBrief}`, agent("w1:p1", "all"))).toMatchObject({ status: 200, body: "Two steps." });
  expect(await get(`/api/briefs/${crmBrief}`, agent("w1:p1", "crm"))).toMatchObject({ status: 200 });
  expect(await get(`/api/briefs/${crmBrief}`, agent("w1:p2"))).toMatchObject({ status: 200, floor: "crm" });
  expect(await get(`/api/briefs/${crmBrief}`)).toMatchObject({ status: 200, floor: "crm" }); // the page
});

test("hud brief comments|reply: refused on another floor's brief without --all", async () => {
  const c = await post("/api/comments/post", { page: `briefs/${crmBrief}`, text: "Which step first?" });
  expect(c.to).toBe("hq-crm");
  const read = hud(["brief", "comments", String(crmBrief)], "w1:p1");
  expect(read.code).toBe(1);
  expect(read.err).toContain(`is on floor crm, not yours (hq)`);
  expect(read.err).toContain("--all");
  expect(hud(["brief", "comments", "--all", String(crmBrief)], "w1:p1")).toMatchObject({ code: 0, out: expect.stringContaining("Which step first?") });
  expect(hud(["brief", "comments", String(crmBrief)], "w1:p2").out).toContain("Which step first?");
  const reply = hud(["brief", "reply", String(crmBrief), "Import first."], "w1:p1");
  expect(reply.code).toBe(1);
  expect(reply.err).toContain("not yours (hq)");
  expect((await get(`/api/comments?page=briefs/${crmBrief}`)).comments.length).toBe(1); // nothing written
  expect(hud(["brief", "reply", "--all", String(crmBrief), "Import", "first."], "w1:p1").code).toBe(0);
  expect(hud(["brief", "reply", String(crmBrief), "Then", "the", "board."], "w1:p2").code).toBe(0);
  // the page reads every floor's thread
  const t = await get(`/api/comments?page=briefs/${crmBrief}`);
  expect(t.status).toBe(200);
  expect(t.comments.map((x: any) => x.text)).toEqual(["Which step first?", "Import first.", "Then the board."]);
});

test("comments on a room's page follow the room's floor", async () => {
  await post("/api/rooms", { slug: "deals", title: "Deals", owner: "hq" }, agent("w1:p2"));
  expect((await get("/api/state")).rooms.find((r: any) => r.slug === "deals")?.floor).toBe("crm");
  await post("/api/rooms/deals/brief", { body: "<!doctype html><html><body>Deals</body></html>" }, agent("w1:p2"));
  await post("/api/comments/post", { page: "rooms/deals/brief", text: "Looks good" });
  expect(hud(["page", "comments", "rooms/deals/brief"], "w1:p1")).toMatchObject({ code: 1, err: expect.stringContaining("the brief of room deals is on floor crm, not yours (hq)") });
  expect(hud(["page", "comments", "rooms/deals/brief", "--all"], "w1:p1").code).toBe(0);
  expect(hud(["page", "comments", "rooms/deals/brief"], "w1:p2").code).toBe(0);
});

test("a brief's page data stays on the brief's floor: hud page data needs --all from another floor", async () => {
  const key = `briefs/${crmPage}`;
  const r = await fetch(`${server.base}/api/page-runtime/db`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ page: key, op: "set", path: "votes/you", data: { pick: "a" } }) });
  expect(r.status).toBe(200);
  const refused = hud(["page", "data", key], "w1:p1");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain(`brief #${crmPage} is on floor crm, not yours (hq)`);
  expect(hud(["page", "data", key, "--all"], "w1:p1").out).toContain("votes");
  expect(hud(["page", "data", key], "w1:p2").out).toContain("votes");
  // the listing leaves out another floor's briefs, unless --all
  expect(hud(["page", "data"], "w1:p1").out).not.toContain(key);
  expect(hud(["page", "data", "--all"], "w1:p1").out).toContain(key);
  expect(hud(["page", "data"], "w1:p2").out).toContain(key);
  // the page (its runtime bridge) reads it whatever floor
  expect((await get(`/api/page-runtime/data?page=${key}`)).status).toBe(200);
});

test("a comment never goes to a lane on another floor than its brief's: that floor's HQ gets it", async () => {
  const before = await post("/api/comments/post", { page: `briefs/${writerBrief}`, text: "Shorter?" });
  expect(before.to).toBe("writer");
  expect((await typed("writer", "Shorter?")).length).toBe(1);
  expect(hud(["lane", "writer", "--floor", "crm"], "w1:p1").code).toBe(0);
  const after = await post("/api/comments/post", { page: `briefs/${writerBrief}`, text: "Still there?" });
  expect(after.to).toBe("hq");
  expect((await typed("hq", "Still there?")).length).toBe(1);
  expect(herdr.typedInto("writer").some((t) => t.includes("Still there?"))).toBe(false);
});
