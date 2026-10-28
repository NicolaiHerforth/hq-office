// Requests, now asks with a recipient: a lane files what it needs from HQ, the item stays open until HQ's answer
// reaches the lane's pane, and a stated default drops it out of the queue when its time comes. These tests were
// written for the separate requests table; they pass unchanged in what they claim, which is what shows the
// behaviour survived the move. Own server, own data dir, a fake herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const PORT = probe.port;
probe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "hq-office-requests-"));
const AGENTS = join(DATA, "agents.json");
const PROMPTS = join(DATA, "prompts.log");
const REFUSE = join(DATA, "refuse");
let server: ReturnType<typeof Bun.spawn>;

const REGISTRY = join(DATA, "orchestration.json");
// Besides chat-lane: a lane under a PM, a lane HQ2 lists, and a lane the registry does not know.
const agentList = (status: string) =>
  writeFileSync(
    AGENTS,
    JSON.stringify({
      result: {
        agents: [
          { name: "chat-lane", pane_id: "w8:pQ", agent: "claude", agent_status: status },
          { name: "builder-lane", pane_id: "w2:p1", agent: "claude", agent_status: status },
          { name: "crm-lane", pane_id: "w8:pE", agent: "claude", agent_status: status },
          { name: "stray-lane", pane_id: "w9:p9", agent: "claude", agent_status: status },
        ],
      },
    }),
  );
const prompts = () => (existsSync(PROMPTS) ? readFileSync(PROMPTS, "utf8").trim().split("\n").filter(Boolean) : []);

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "x-hud": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const get = async (path: string) => (await fetch(BASE + path)).json();
const file = (over: Record<string, unknown> = {}) => post("/api/requests", { kind: "BLOCK", lane: "chat-lane", text: "need the seeding answer", ...over });
const hud = async (...args: string[]) => {
  const proc = Bun.spawn([process.execPath, "hud.ts", ...args], { cwd: ROOT, env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
};

beforeAll(async () => {
  // The fake herdr lists the agents in agents.json and, for `agent prompt`, logs the call or refuses when REFUSE exists.
  writeFileSync(join(DATA, "herdr"), `#!/bin/sh\nD=$(dirname "$0")\ncase "$*" in\n*"agent list"*) cat "$D/agents.json" ;;\n*"agent prompt"*) [ -f "$D/refuse" ] && { echo "sandbox refused" >&2; exit 1; }; printf '%s\\n' "$*" >> "$D/prompts.log" ;;\nesac\n`);
  chmodSync(join(DATA, "herdr"), 0o755);
  agentList("idle");
  writeFileSync(
    REGISTRY,
    JSON.stringify({
      orchestrators: { HQ: { pane: "local w1:p1", lanes: { "local w8:pQ": "Chat PM" } }, HQ2: { pane: "local w1:pN", lanes: { "local w8:pE": "CRM PM" } } },
      under: { "local w2:p1": ["local w8:pP4", "builder label"] },
    }),
  );
  server = Bun.spawn([process.execPath, "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, HUD_PORT: String(PORT), HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "herdr"), HUD_ORCHESTRATION: REGISTRY },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await Bun.sleep(100)) {
    try {
      if ((await get("/api/state")).sync.at) return; // the first sync has run
    } catch {}
  }
  throw new Error(`server did not come up on port ${PORT}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(DATA, { recursive: true, force: true });
});

test("an answer reaches the lane's pane and closes the request in the same step", async () => {
  const { body } = await file({ kind: "READY", pr: "#3417", text: "READY: #3417 is green" });
  expect(body.warning).toBeUndefined();
  expect((await get("/api/requests")).map((r: any) => r.id)).toContain(body.id);
  expect((await get("/api/requests/next")).id).toBe(body.id);
  const answered = await post(`/api/requests/${body.id}/answer`, { text: "merge it after the walk" });
  expect(answered.status).toBe(200);
  expect(prompts().at(-1)).toContain(`agent prompt chat-lane HQ answer to your request #${body.id} (READY): merge it after the walk`);
  expect((await get("/api/requests")).map((r: any) => r.id)).not.toContain(body.id);
  const row = (await get("/api/requests?all=1")).find((r: any) => r.id === body.id);
  expect(row).toMatchObject({ status: "closed", answer: "merge it after the walk", pr: "3417" });
  expect((await post(`/api/requests/${body.id}/answer`, { text: "again" })).body.error).toContain("already closed");
});

test("an answer that does not reach the pane leaves the request open and says so", async () => {
  const { body } = await file();
  const before = prompts().length;
  writeFileSync(REFUSE, "");
  const refused = await post(`/api/requests/${body.id}/answer`, { text: "go ahead" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("not delivered to chat-lane: sandbox refused");
  expect(refused.body.error).toContain(`Request #${body.id} stays open`);
  expect(prompts().length).toBe(before);
  const open = (await get("/api/requests")).find((r: any) => r.id === body.id);
  expect(open).toMatchObject({ status: "open", last_error: "sandbox refused" });
  unlinkSync(REFUSE);
  expect((await post(`/api/requests/${body.id}/answer`, { text: "go ahead" })).status).toBe(200);
  expect((await get("/api/requests")).map((r: any) => r.id)).not.toContain(body.id);
});

test("a request whose lane is gone closes with the reason on the record; a live lane's must still be answered", async () => {
  const gone = (await file({ kind: "READY", lane: "gone-lane", text: "READY: pushed" })).body;
  expect((await post(`/api/requests/${gone.id}/answer`, { text: "thanks" })).body.error).toContain("no live herdr agent is named gone-lane");
  const before = prompts().length;
  const closed = await post(`/api/requests/${gone.id}/close`, { reason: "the PM took READY from its own review" });
  expect(closed.status).toBe(200);
  expect(prompts().length).toBe(before);
  const row = (await get("/api/requests?all=1")).find((r: any) => r.id === gone.id);
  expect(row).toMatchObject({ status: "closed", answer: "the PM took READY from its own review", last_error: "not delivered: no live agent named gone-lane" });
  const live = (await file()).body;
  const refused = await post(`/api/requests/${live.id}/close`, { reason: "skip it" });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain(`chat-lane is live: answer it with hud req answer ${live.id}`);
  expect((await get("/api/requests")).map((r: any) => r.id)).toContain(live.id);
  expect((await post(`/api/requests/${live.id}/answer`, { text: "done" })).status).toBe(200);
  const cli = (await file({ lane: "gone-lane" })).body;
  const out = await hud("req", "close", String(cli.id), "lane", "closed", "after", "its", "push");
  expect(out).toMatchObject({ code: 0 });
  expect(out.out).toContain(`request #${cli.id} closed without delivery: gone-lane is gone`);
});

test("a request with a default is marked defaulted when its time comes, and HQ can still correct the lane", async () => {
  const { body } = await file({ text: "may I use the hub stack?", default: "use the hub stack", by: Date.now() + 700 });
  expect((await get("/api/requests")).map((r: any) => r.id)).toContain(body.id);
  await Bun.sleep(900);
  expect((await get("/api/requests")).map((r: any) => r.id)).not.toContain(body.id);
  const row = (await get("/api/requests?all=1")).find((r: any) => r.id === body.id);
  expect(row).toMatchObject({ status: "defaulted", default_action: "use the hub stack" });
  expect((await post(`/api/requests/${body.id}/answer`, { text: "no: use the laptop stack" })).status).toBe(200);
  expect((await get("/api/requests?all=1")).find((r: any) => r.id === body.id).status).toBe("closed");
});

test("a default needs a time, a future time, and a request that asks for something", async () => {
  expect((await file({ default: "go on" })).body.error).toContain("go together");
  expect((await file({ by: Date.now() + 60_000 })).body.error).toContain("go together");
  expect((await file({ default: "go on", by: Date.now() - 1000 })).body.error).toContain("future");
  expect((await file({ kind: "READY", default: "go on", by: Date.now() + 60_000 })).body.error).toContain("nothing to default");
  expect((await file({ kind: "WHATEVER" })).body.error).toContain("kind must be one of");
  expect((await file({ text: "  " })).body.error).toContain("text is required");
});

test("a request from a name no live agent has still files, with a warning", async () => {
  // It can never be answered, so it carries a default that drops it out of the queue for the tests after it.
  const { body } = await file({ lane: "no-such-lane", default: "carry on", by: Date.now() + 1200 });
  expect(body.id).toBeGreaterThan(0);
  expect(body.warning).toContain("no live herdr agent is named no-such-lane");
});

// The hourly sweep reads `since` from /api/agents: the real stop time of a lane that is in no list.
test("the sync records when each agent's status began, and keeps it while the status holds", async () => {
  agentList("idle");
  await post("/api/sync", {});
  const first = (await get("/api/agents")).find((a: any) => a.name === "chat-lane");
  expect(first).toMatchObject({ machine: "local", pane: "w8:pQ", status: "idle" });
  await Bun.sleep(30);
  await post("/api/sync", {});
  expect((await get("/api/agents")).find((a: any) => a.name === "chat-lane").since).toBe(first.since);
  agentList("working");
  await Bun.sleep(30);
  await post("/api/sync", {});
  const after = (await get("/api/agents")).find((a: any) => a.name === "chat-lane");
  expect(after.status).toBe("working");
  expect(after.since).toBeGreaterThan(first.since);
});

test("hud files, shows, answers and refuses: the whole loop from the command line", async () => {
  agentList("idle");
  await post("/api/sync", {});
  for (const deadline = Date.now() + 4000; (await get("/api/requests/next")) && Date.now() < deadline; ) await Bun.sleep(100);
  expect(await get("/api/requests/next")).toBeNull();
  const filed = await hud("request", "--kind", "question", "--lane", "chat-lane", "--pr", "3417", "--default", "use seed B", "--by", "+30m", "Which", "seed", "do", "I", "use?");
  expect(filed.code).toBe(0);
  const id = Number(filed.out.match(/request #(\d+)/)![1]);
  const next = await hud("req", "next");
  expect(next.out).toContain(`#${id} QUESTION chat-lane PR #3417 open 0m`);
  expect(next.out).toContain("Which seed do I use?");
  expect(next.out).toContain("default: use seed B");
  expect((await hud("req", "list")).out).toContain(`#${id} QUESTION chat-lane`);
  writeFileSync(REFUSE, "");
  const refused = await hud("req", "answer", String(id), "seed", "B");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("stays open");
  unlinkSync(REFUSE);
  const done = await hud("req", "answer", String(id), "seed", "B");
  expect(done).toMatchObject({ code: 0 });
  expect(done.out).toContain("delivered to chat-lane and closed");
  expect((await hud("req", "list")).out).not.toContain(`#${id} `);
  expect((await hud("req", "list", "--all")).out).toContain(`#${id} QUESTION chat-lane PR #3417 closed`);
  expect((await hud("request", "--kind", "ready", "--lane", "chat-lane", "--default", "x", "--by", "nonsense", "t")).code).toBe(2);
});

test("a request names who must answer: the registry decides unless --lead says, and the queue filters by it", async () => {
  await post("/api/sync", {});
  const lead = async (lane: string, over: Record<string, unknown> = {}) => {
    const { body } = await file({ lane, text: `lead check for ${lane}`, ...over });
    return { id: body.id as number, lead: (await get("/api/requests")).find((r: any) => r.id === body.id).lead };
  };
  const pm = await lead("builder-lane");
  const hq2 = await lead("crm-lane");
  const hq = await lead("chat-lane");
  const unknown = await lead("stray-lane");
  const explicit = await lead("stray-lane", { lead: "  HQ2 " });
  expect([pm.lead, hq2.lead, hq.lead, unknown.lead, explicit.lead]).toEqual(["local w8:pP4", "HQ2", "HQ", "HQ", "HQ2"]);
  const old = (await lead("stray-lane")).id;

  const ids = async (path: string) => (await get(path)).map((r: any) => r.id);
  const hq2Open = await ids("/api/requests?lead=HQ2");
  expect(hq2Open).toContain(hq2.id);
  expect(hq2Open).toContain(explicit.id);
  expect(hq2Open).not.toContain(hq.id);
  expect(hq2Open).not.toContain(pm.id);
  const hqOpen = await ids("/api/requests?lead=HQ");
  expect(hqOpen).toContain(hq.id);
  expect(hqOpen).toContain(old);
  expect(hqOpen).not.toContain(hq2.id);
  expect((await get("/api/requests/next?lead=local%20w8:pP4")).id).toBe(pm.id);
  expect((await get("/api/requests/next?lead=HQ2")).id).toBe(hq2.id);
  // Without a lead nothing changes: every open request.
  expect(await ids("/api/requests")).toEqual(expect.arrayContaining([pm.id, hq2.id, hq.id, unknown.id, explicit.id, old]));

  const next = await hud("req", "next", "--lead", "HQ2");
  expect(next.out).toContain(`#${hq2.id} BLOCK crm-lane`);
  expect(next.out).toContain("lead HQ2");
  const listed = (await hud("req", "list", "--lead", "HQ2")).out;
  expect(listed).toContain(`#${hq2.id} `);
  expect(listed).toContain(`#${explicit.id} `);
  expect(listed).not.toContain(`#${hq.id} `);
  const hqList = (await hud("req", "list", "--lead", "HQ")).out;
  expect(hqList).toContain(`#${old} `);
  expect(hqList).not.toContain(`#${hq2.id} `);
  // --all still works beside --lead, in either order.
  expect((await hud("req", "list", "--all", "--lead", "HQ2")).out).toContain(`#${hq2.id} `);
  expect((await hud("req", "list", "--lead", "HQ2", "--all")).out).not.toContain(`#${hq.id} `);
  const filed = await hud("request", "--kind", "ready", "--lane", "chat-lane", "--lead", "HQ2", "via cli");
  const cliId = Number(filed.out.match(/request #(\d+)/)![1]);
  expect((await get("/api/requests?all=1")).find((r: any) => r.id === cliId).lead).toBe("HQ2");

  // The answer is signed by the lead.
  await post(`/api/requests/${hq2.id}/answer`, { text: "from two" });
  expect(prompts().at(-1)).toContain(`crm-lane HQ2 answer to your request #${hq2.id} (BLOCK): from two`);
  await post(`/api/requests/${old}/answer`, { text: "from old" });
  expect(prompts().at(-1)).toContain(`stray-lane HQ answer to your request #${old}`);
  // Leave the queue empty for the tests that look at it.
  for (const id of [pm.id, hq.id, unknown.id, explicit.id, cliId]) await post(`/api/requests/${id}/answer`, { text: "done" });
});

test("without a readable registry a request goes to HQ", async () => {
  const saved = readFileSync(REGISTRY, "utf8");
  writeFileSync(REGISTRY, "not json");
  const { body } = await file({ lane: "crm-lane", text: "registry is broken" });
  expect((await get("/api/requests")).find((r: any) => r.id === body.id).lead).toBe("HQ");
  writeFileSync(REGISTRY, saved);
  await post(`/api/requests/${body.id}/answer`, { text: "ok" });
});
