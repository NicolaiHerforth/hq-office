// DONE MEANS: a room linked to a Linear project, and that project's acceptance criteria. Two layers, both against a
// fake Linear GraphQL server on a spare port (never the real one):
//   1. acceptance.ts on an in-memory database, with a fake clock and fake timers.
//   2. server.ts and hud.ts end to end, on a spare port with a throwaway data dir (HUD_LINEAR_API_URL: the fake).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { acceptanceText, CACHE_MS, createAcceptance, NO_KEY, REFRESH_MS } from "../../src/server/acceptance.ts";
import { parseProjectRef } from "../../src/server/linear.ts";

const ROOT = join(import.meta.dir, "..", "..");
const KEY = "lin_api_TESTKEY0123456789abcdefSECRET";
const PID = "0b9f4a2e-1111-4c2d-9e8f-123456789abc";
const SLUG_ID = "6d1c3c8ff5b1";
const URL_ = `https://linear.app/acme/project/q4-launch-${SLUG_ID}`;

// ---- the fake Linear ----

type FakeIssue = { identifier: string; title: string; state: [string, string]; milestone?: [string, string, number]; labels: string[]; updatedAt?: string };
const issue = (n: number, state: [string, string], milestone: FakeIssue["milestone"], labels = ["Acceptance"]): FakeIssue => ({ identifier: `ENG-${n}`, title: `Criterion ${n}`, state, milestone, labels });
const DONE: [string, string] = ["Done", "completed"];
const PROG: [string, string] = ["In Progress", "started"];
const TODO: [string, string] = ["Todo", "unstarted"];
const GONE: [string, string] = ["Canceled", "canceled"];
const BETA: [string, string, number] = ["ms-b", "Beta", 2];
const ALPHA: [string, string, number] = ["ms-a", "Alpha", 1];

function fakeLinear() {
  const projects = [
    {
      id: PID,
      name: "Q4 launch",
      url: URL_,
      slugId: SLUG_ID,
      issues: [
        issue(10, DONE, BETA),
        issue(9, PROG, BETA),
        issue(3, DONE, ALPHA),
        issue(4, GONE, ALPHA),
        issue(7, TODO, undefined),
        issue(8, DONE, ALPHA, ["bug"]), // not acceptance: never shown
      ],
    },
    { id: "0b9f4a2e-2222-4c2d-9e8f-123456789abc", name: "Twin", url: "https://linear.app/acme/project/twin-aaaaaaaaaaaa", slugId: "aaaaaaaaaaaa", issues: [] as FakeIssue[] },
    { id: "0b9f4a2e-3333-4c2d-9e8f-123456789abc", name: "Twin", url: "https://linear.app/acme/project/twin-bbbbbbbbbbbb", slugId: "bbbbbbbbbbbb", issues: [] as FakeIssue[] },
  ];
  const calls: { op: string; variables: any; auth: string | null }[] = [];
  const fake = { projects, calls, echoKey: false, url: "", stop: () => {} };
  const err = (message: string) => Response.json({ errors: [{ message }] }, { status: 400 });
  const node = (p: (typeof projects)[0]) => ({ id: p.id, name: p.name, url: p.url });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { query, variables } = (await req.json()) as { query: string; variables: any };
      const op = query.match(/query (\w+)/)?.[1] ?? "?";
      const auth = req.headers.get("authorization");
      calls.push({ op, variables, auth });
      if (fake.echoKey) return err(`Authentication failed for token ${auth}`);
      if (auth !== KEY) return err("Authentication required, not authenticated");
      if (op === "ProjectBySlugId") return Response.json({ data: { projects: { nodes: projects.filter((p) => p.slugId === variables.value).map(node) } } });
      if (op === "ProjectByName") return Response.json({ data: { projects: { nodes: projects.filter((p) => p.name === variables.value).map(node) } } });
      const p = projects.find((x) => x.id === variables.id);
      if (!p) return err("Entity not found: Project");
      if (op === "ProjectById") return Response.json({ data: { project: node(p) } });
      if (op === "AcceptanceIssues") {
        // Two per page, so every fetch pages.
        const all = p.issues.filter((i) => i.labels.some((l) => l.toLowerCase() === String(variables.label).toLowerCase()));
        const from = Number(variables.after ?? 0);
        const page = all.slice(from, from + 2);
        const nodes = page.map((i) => ({
          identifier: i.identifier,
          title: i.title,
          url: `https://linear.app/acme/issue/${i.identifier.toLowerCase()}`,
          updatedAt: i.updatedAt ?? "2026-11-05T09:00:00.000Z",
          state: { name: i.state[0], type: i.state[1] },
          projectMilestone: i.milestone ? { id: i.milestone[0], name: i.milestone[1], sortOrder: i.milestone[2] } : null,
        }));
        const more = from + 2 < all.length;
        return Response.json({ data: { project: { ...node(p), issues: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? String(from + 2) : null } } } } });
      }
      return err(`unknown operation ${op}`);
    },
  });
  fake.url = `http://127.0.0.1:${server.port}/graphql`;
  fake.stop = () => server.stop(true);
  return fake;
}

// The tables acceptance.ts reads from the server's database.
function memoryDb() {
  const db = new Database(":memory:");
  for (const f of ["rooms.sql", "room_links.sql", "linear_projects.sql"]) db.exec(readFileSync(join(ROOT, "src/server/schema", f), "utf8"));
  db.exec("ALTER TABLE rooms ADD COLUMN floor TEXT");
  for (const slug of ["r1", "r2"]) db.query("INSERT INTO rooms (slug, title, owner, created_at) VALUES (?, ?, 'hq', 0)").run(slug, slug.toUpperCase());
  return db;
}

describe("parseProjectRef", () => {
  test("a URL, its slug, its slugId, an id or a name", () => {
    expect(parseProjectRef(URL_)).toEqual({ by: "slugId", value: SLUG_ID });
    expect(parseProjectRef(`${URL_}/overview?x=1`)).toEqual({ by: "slugId", value: SLUG_ID });
    expect(parseProjectRef(`q4-launch-${SLUG_ID}`)).toEqual({ by: "slugId", value: SLUG_ID });
    expect(parseProjectRef(SLUG_ID.toUpperCase())).toEqual({ by: "slugId", value: SLUG_ID });
    expect(parseProjectRef(PID)).toEqual({ by: "id", value: PID });
    expect(parseProjectRef(" Q4 launch ")).toEqual({ by: "name", value: "Q4 launch" });
    expect(parseProjectRef("q4-launch")).toEqual({ by: "name", value: "q4-launch" });
    expect(() => parseProjectRef("https://linear.app/acme/project/")).toThrow();
    expect(() => parseProjectRef("")).toThrow();
  });
});

describe("acceptance.ts", () => {
  let fake: ReturnType<typeof fakeLinear>;
  beforeAll(() => void (fake = fakeLinear()));
  afterAll(() => fake.stop());

  function setup(opts: { key?: string } = {}) {
    const db = memoryDb();
    const clock = { t: Date.parse("2026-11-05T10:00:00Z") };
    const key = { v: opts.key ?? KEY };
    const ticks: { fn: () => void; ms: number }[] = [];
    let changes = 0;
    const a = createAcceptance({
      db,
      key: () => key.v,
      apiUrl: () => fake.url,
      label: () => "acceptance",
      now: () => clock.t,
      onChange: () => changes++,
      timers: { every: (fn, ms) => (ticks.push({ fn, ms }), ticks.length), cancel: (h) => (ticks[h - 1] = { fn: () => {}, ms: -1 }) },
    });
    fake.calls.length = 0;
    // Linking fetches in the background: wait for it.
    const settle = async () => {
      for (let i = 0; i < 100 && !Object.values(a.state()).every((e) => e.fetchedAt || e.error); i++) await Bun.sleep(10);
    };
    return { db, clock, key, ticks, a, settle, changes: () => changes };
  }

  test("link by URL, slugId or exact name: resolved once to the project's id", async () => {
    for (const ref of [URL_, SLUG_ID, "Q4 launch", PID]) {
      const { a, db, settle } = setup();
      expect(await a.link("r1", { ref })).toEqual({ project: { id: PID, name: "Q4 launch", url: URL_ } });
      expect(db.query("SELECT kind, ref FROM room_links WHERE slug = 'r1'").all()).toEqual([{ kind: "project", ref: PID }]);
      await settle();
      expect(fake.calls[0].op).toBe(ref === URL_ || ref === SLUG_ID ? "ProjectBySlugId" : ref === PID ? "ProjectById" : "ProjectByName");
      a.stop();
    }
  });

  test("met and total, canceled left out of total; milestones in Linear's order, none last; pages followed", async () => {
    const { a, settle, clock } = setup();
    await a.link("r1", { ref: URL_ });
    await settle();
    const s = a.state().r1;
    expect(s).toMatchObject({ project: { id: PID, name: "Q4 launch", url: URL_ }, met: 2, total: 4, fetchedAt: clock.t, error: null });
    expect(s.milestones.map((m) => m.name)).toEqual(["Alpha", "Beta", null]);
    expect(s.milestones.map((m) => m.items.map((i) => i.key))).toEqual([["ENG-3", "ENG-4"], ["ENG-9", "ENG-10"], ["ENG-7"]]);
    expect(s.milestones[1].items[0]).toEqual({ key: "ENG-9", title: "Criterion 9", state: "In Progress", stateType: "started", url: "https://linear.app/acme/issue/eng-9", updatedAt: Date.parse("2026-11-05T09:00:00.000Z") });
    // 5 acceptance issues, two per page: three pages; the bug-labelled one never shows.
    expect(fake.calls.filter((c) => c.op === "AcceptanceIssues").length).toBe(3);
    expect(fake.calls.every((c) => c.variables.label === undefined || c.variables.label === "acceptance")).toBe(true);
    expect(JSON.stringify(s)).not.toContain("ENG-8");
    const text = acceptanceText("r1", s, () => "just now");
    expect(text.split("\n")[0]).toBe("PROJECT Q4 launch: 2 of 4 met");
    expect(text).toContain("Alpha\n  [x] ENG-3  Done  Criterion 3\n  [-] ENG-4  Canceled  Criterion 4");
    expect(text).toContain("NO MILESTONE\n  [ ] ENG-7  Todo  Criterion 7");
    a.stop();
  });

  test("no key: linking says so without a call; a linked room shows it, with no call", async () => {
    const { a, db, key } = setup({ key: "" });
    await expect(a.link("r1", { ref: URL_ })).rejects.toThrow(NO_KEY);
    expect(fake.calls.length).toBe(0);
    db.query("INSERT INTO room_links (slug, kind, ref) VALUES ('r1', 'project', ?)").run(PID);
    await a.refresh(0);
    expect(fake.calls.length).toBe(0);
    expect(a.state().r1).toMatchObject({ project: { id: PID, name: "", url: "" }, met: 0, total: 0, fetchedAt: null, error: NO_KEY });
    key.v = KEY;
    await a.refresh(0);
    expect(a.state().r1).toMatchObject({ project: { name: "Q4 launch" }, met: 2, total: 4, error: null });
    a.stop();
  });

  test("project not found: on link, and later, with the last good data kept", async () => {
    const { a, settle, clock } = setup();
    await expect(a.link("r1", { ref: "No such project" })).rejects.toThrow("project not found");
    await expect(a.link("r1", { ref: "Twin" })).rejects.toThrow("more than one Linear project is named Twin");
    await expect(a.link("nope", { ref: URL_ })).rejects.toThrow("no room nope");
    await a.link("r1", { ref: URL_ });
    await settle();
    const good = a.state().r1;
    // The project goes away in Linear.
    const p = fake.projects.shift()!;
    try {
      clock.t += CACHE_MS;
      await a.refreshRoom("r1");
      expect(a.state().r1).toEqual({ ...good, error: "project not found" });
    } finally {
      fake.projects.unshift(p);
    }
    a.stop();
  });

  test("the key never in an error, the state or the room's text, even when Linear echoes it", async () => {
    const { a, settle, clock } = setup();
    await a.link("r1", { ref: URL_ });
    await settle();
    fake.echoKey = true;
    try {
      const e = await a.link("r2", { ref: URL_ }).catch((x) => x as Error);
      expect(e.message).toBe("Linear: Authentication failed for token [key]");
      clock.t += CACHE_MS;
      await a.refreshRoom("r1");
      expect(a.state().r1.error).toBe("Linear: Authentication failed for token [key]");
      expect(a.state().r1.met).toBe(2);
      expect(JSON.stringify(a.state())).not.toContain(KEY);
      expect(acceptanceText("r1", a.view("r1"), () => "now")).not.toContain(KEY);
      // The key went to Linear, in its header, and nowhere else in the request.
      expect(fake.calls.every((c) => c.auth === KEY && !JSON.stringify(c.variables).includes(KEY))).toBe(true);
    } finally {
      fake.echoKey = false;
    }
    a.stop();
  });

  test("on demand: a fetch only when the cache is over a minute old", async () => {
    const { a, settle, clock } = setup();
    await a.link("r1", { ref: URL_ });
    await settle();
    const n = fake.calls.length;
    a.state();
    a.view("r1");
    await a.refreshRoom("r1");
    clock.t += CACHE_MS - 1;
    await a.refreshRoom("r1");
    expect(fake.calls.length).toBe(n);
    clock.t += 1;
    await a.refreshRoom("r1");
    expect(fake.calls.length).toBe(n + 3);
    a.stop();
  });

  test("the 10-minute poll runs only while an open room has a project", async () => {
    const { a, db, ticks, settle, clock } = setup();
    a.start();
    expect(a.running()).toBe(false);
    expect(fake.calls.length).toBe(0);
    await a.link("r1", { ref: URL_ });
    await settle();
    expect(a.running()).toBe(true);
    expect(ticks.map((t) => t.ms)).toEqual([REFRESH_MS]);
    // A tick fetches what is due.
    const n = fake.calls.length;
    clock.t += REFRESH_MS;
    ticks[0].fn();
    await Bun.sleep(50);
    await settle();
    expect(fake.calls.length).toBe(n + 3);
    // Archived: no open room has a project, the poll stops; reopened, it runs again; unlinked, it stops.
    db.query("UPDATE rooms SET archived_at = 1 WHERE slug = 'r1'").run();
    a.syncTimer();
    expect(a.running()).toBe(false);
    expect(Object.keys(a.state())).toEqual(["r1"]);
    db.query("UPDATE rooms SET archived_at = NULL WHERE slug = 'r1'").run();
    a.syncTimer();
    expect(a.running()).toBe(true);
    expect(await a.link("r1", { clear: true })).toEqual({ project: null });
    expect(a.running()).toBe(false);
    expect(a.state()).toEqual({});
    expect(a.view("r1")).toBeNull();
    a.stop();
  });
});

// ---- end to end ----

describe("server and hud", () => {
  let fake: ReturnType<typeof fakeLinear>;
  let server: Awaited<ReturnType<typeof spawnServer>>;
  let BASE = "";
  const DATA = mkdtempSync(join(tmpdir(), "hq-acceptance-test-"));
  let log = "";

  beforeAll(async () => {
    fake = fakeLinear();
    const env: Record<string, string | undefined> = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: "/usr/bin/true", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_LINEAR_API_KEY: KEY, HUD_LINEAR_API_URL: fake.url, HUD_LINEAR_ACCEPTANCE_LABEL: "ACCEPTANCE" };
    server = await spawnServer({ cwd: ROOT, env, out: (c) => void (log += new TextDecoder().decode(c)) });
    BASE = server.base;
    for (const slug of ["r1", "r2"]) await post("/api/rooms", { slug, title: slug, owner: "hq" });
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    fake?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown) {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
  }
  const get = async (path: string) => (await fetch(`${BASE}${path}`)).json();
  async function hud(args: string[]) {
    const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: out.trim(), err: err.trim(), code };
  }

  test("a page load never fetches", async () => {
    expect((await fetch(`${BASE}/`)).ok).toBe(true);
    expect((await get("/api/state")).acceptance).toEqual({});
    expect(await get("/api/rooms/r1/acceptance?refresh=1")).toBeNull();
    expect(fake.calls.length).toBe(0);
  });

  test("hud room project links, prints and clears; hud room acceptance answers 'are we done?'", async () => {
    const linked = await hud(["room", "project", "r1", URL_]);
    expect(linked).toMatchObject({ code: 0, out: `room r1 linked to Linear project Q4 launch  ${URL_}` });
    for (let i = 0; i < 100 && !(await get("/api/rooms/r1/acceptance"))?.fetchedAt; i++) await Bun.sleep(20);
    const s = (await get("/api/state")).acceptance;
    expect(Object.keys(s)).toEqual(["r1"]);
    expect(s.r1).toMatchObject({ project: { id: PID, name: "Q4 launch", url: URL_ }, met: 2, total: 4, error: null });
    expect(s.r1.milestones.map((m: any) => m.name)).toEqual(["Alpha", "Beta", null]);
    // The label from HUD_LINEAR_ACCEPTANCE_LABEL, matched in any case.
    expect(fake.calls.find((c) => c.op === "AcceptanceIssues")!.variables.label).toBe("ACCEPTANCE");

    expect((await hud(["room", "project", "r1"])).out).toBe(`room r1: Linear project Q4 launch  ${URL_}`);
    const text = await hud(["room", "acceptance", "r1"]);
    expect(text.code).toBe(0);
    expect(text.out.split("\n")[0]).toBe("PROJECT Q4 launch: 2 of 4 met");
    expect(text.out).toContain("Beta\n  [ ] ENG-9  In Progress  Criterion 9\n  [x] ENG-10  Done  Criterion 10");
    const json = JSON.parse((await hud(["room", "acceptance", "r1", "--json"])).out);
    expect(json).toEqual(s.r1);

    // Reads, with or without --refresh inside the minute, never call Linear again.
    const n = fake.calls.length;
    await fetch(`${BASE}/`);
    await get("/api/state");
    await hud(["room", "acceptance", "r1", "--refresh"]);
    expect(fake.calls.length).toBe(n);

    expect((await hud(["room", "project", "r2", "No such project"]))).toMatchObject({ code: 1, err: "project not found" });
    expect((await hud(["room", "acceptance", "nope"]))).toMatchObject({ code: 1, err: "no room nope" });
    expect((await hud(["room", "project", "r1", "--clear"])).out).toBe("room r1 has no Linear project now");
    expect((await get("/api/state")).acceptance).toEqual({});
    expect((await hud(["room", "acceptance", "r1"])).out).toBe("room r1 has no Linear project: hud room project r1 URL");
    expect((await hud(["room"])).err).toContain("hud room acceptance SLUG [--json] [--refresh]");
  });

  test("the key is never in the state, a reply, the log or the database", async () => {
    await hud(["room", "project", "r1", SLUG_ID]);
    fake.echoKey = true;
    let r;
    try {
      r = await hud(["room", "project", "r2", URL_]);
    } finally {
      fake.echoKey = false;
    }
    expect(r).toMatchObject({ code: 1, err: "Linear: Authentication failed for token [key]" });
    const seen = [JSON.stringify(await get("/api/state")), JSON.stringify(await get("/api/rooms/r1/acceptance")), JSON.stringify(await get("/api/events")), log];
    for (const f of readdirSync(DATA).filter((f) => f.startsWith("hud.db"))) seen.push(readFileSync(join(DATA, f)).toString("latin1"));
    for (const s of seen) expect(s).not.toContain(KEY);
  });
});
