// Adding a floor end to end. USE AN AGENT takes only an agent that runs in herdr on this machine (a lane promoted to
// run a domain too) and sends it the HQ guide for its floor; one that is not running, or runs on another machine, is
// refused. START A NEW HQ opens a herdr tab in the first HQ's workspace and directory, starts hq-<id> in its pane, adds
// the floor and sends the new HQ its guide; a failure closes the tab and adds nothing. A floor whose HQ herdr has
// never shown is STARTING: no alarm, no "HQ isn't receiving", nothing typed in; after HUD_HQ_STARTING_MS it is "not
// started", still calm; START ITS HQ (POST /api/floors/ID with start) starts hq-<id> for it. Once its HQ is seen it is
// receiving, and only an HQ seen and then gone is the alarm. A stub herdr (test/fake-herdr.ts) records every call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-floor-start-"));
const HQ = { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" };
const GOLF = { name: "golf", agent_status: "idle", pane_id: "w1:p2", agent: "claude", workspace_id: "w1", cwd: "/tmp/the-project" };
const herdr = fakeHerdr(data, [HQ, GOLF]);
// An agent that runs on another machine: the HUD cannot type into it, so it is no floor's HQ.
herdr.elsewhere("laptop", [{ name: "provisioning-admin", agent_status: "idle", pane_id: "l1:p1", agent: "claude" }]);
const STARTING_MS = 1500;

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local,laptop", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_HQ_STARTING_MS: String(STARTING_MS) },
  });
  await post("/api/lanes", { name: "golf", machine: "local", title: "Runs sales" });
  await sync();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const sync = async () => {
  await post("/api/sync");
  await Bun.sleep(100);
};
const floor = async (id: string) => (await state()).floors.find((f: any) => f.id === id);
const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 160; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const alarms = async () => (await state()).events.filter((e: any) => /HQ isn't receiving/.test(e.text));

const refusedAdd = async (hq: string) => {
  const r = await post("/api/floors", { id: "jj", name: "JJ", hq });
  return { status: r.status, error: r.error as string };
};

test("USE AN AGENT: an agent that is not running in herdr here is refused, and no floor is added", async () => {
  expect(await refusedAdd("nobody-here")).toEqual({ status: 400, error: expect.stringContaining("nobody-here is not running in herdr") });
  expect(await refusedAdd("provisioning-admin")).toEqual({ status: 400, error: expect.stringContaining("provisioning-admin runs on laptop") });
  expect(await floor("jj")).toBeUndefined();
  // Nor can a floor be given one.
  expect((await post("/api/floors/hq", { hq: "nobody-here" })).status).toBe(400);
});

test("GET /api/floors/agents lists the live named agents on this machine only, lanes too, and which floor each runs", async () => {
  const { agents } = await (await fetch(`${server.base}/api/floors/agents`)).json();
  expect(agents.find((a: any) => a.name === "golf")).toMatchObject({ lane: true, floor: null, machine: "local" });
  expect(agents.find((a: any) => a.name === "hq")).toMatchObject({ floor: "hq" });
  expect(agents.some((a: any) => a.name === "provisioning-admin")).toBe(false);
  expect(agents.every((a: any) => a.status !== "gone")).toBe(true);
});

test("a new HQ that herdr never shows is STARTING: no alarm, nothing typed, a note held", async () => {
  herdr.hideStart(true);
  const r = await post("/api/floors", { id: "jj", name: "JJ", start: true });
  herdr.hideStart(false);
  expect(r.status).toBe(200);
  await sync();
  const s = await state();
  expect(s.floors.find((f: any) => f.id === "jj")).toMatchObject({ hq: "hq-jj", starting: true, notStarted: false, receiving: null, reason: null });
  expect(s.hqLinks.jj).toMatchObject({ ok: null, starting: true, reason: null });
  expect(await alarms()).toEqual([]);
  await post("/api/notes", { text: "for the new floor", floor: "jj" });
  await sync();
  expect(herdr.calls().some((c) => c[0] === "agent" && c[1] === "prompt" && c[2] === "hq-jj")).toBe(false);
  expect((await state()).hqLinks.jj.ok).toBeNull();
  expect(herdr.typedInto("hq-jj")).toEqual([]);
});

test("after a while it is 'not started': a calm note, still no alarm", async () => {
  await Bun.sleep(STARTING_MS + 100);
  await sync();
  expect(await floor("jj")).toMatchObject({ starting: true, notStarted: true, receiving: null });
  expect(await alarms()).toEqual([]);
});

test("START ITS HQ: POST /api/floors/ID with start opens a tab and starts hq-<id> for a floor whose HQ is not running", async () => {
  const before = herdr.calls().length;
  const r = await post("/api/floors/jj", { start: true });
  expect(r.status).toBe(200);
  const calls = herdr.calls().slice(before);
  expect(calls.find((c) => c[0] === "tab" && c[1] === "create")).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/the-project", "--label", "JJ HQ", "--no-focus"]);
  expect(calls.find((c) => c[0] === "agent" && c[1] === "start")?.slice(0, 3)).toEqual(["agent", "start", "hq-jj"]);
  await sync();
  await until(() => herdr.typedInto("hq-jj").some((t) => t.includes("for the new floor")), "the held note");
  expect(herdr.typedInto("hq-jj").some((t) => t.includes("You are the HQ of the JJ floor"))).toBe(true);
  expect(await floor("jj")).toMatchObject({ hq: "hq-jj", starting: false, receiving: true });
});

test("seen and then gone is the alarm", async () => {
  herdr.world(herdr.agents().filter((a) => a.name !== "hq-jj"));
  await sync();
  expect(await floor("jj")).toMatchObject({ starting: false, receiving: false, reason: 'no agent in herdr is named "hq-jj"' });
  expect((await alarms()).some((e: any) => e.floor === "jj")).toBe(true);
  // START ITS HQ for an HQ that ran and stopped: a new tab (never its old pane), a fresh hq-jj with its guide again.
  const from = herdr.calls().length, guides = herdr.typedInto("hq-jj").filter((t) => t.includes("You are the HQ of the JJ floor")).length;
  expect((await post("/api/floors/jj", { start: true })).status).toBe(200);
  const calls = herdr.calls().slice(from);
  expect(calls.some((c) => c[0] === "tab" && c[1] === "create")).toBe(true);
  expect(calls.some((c) => c[0] === "agent" && c[1] === "prompt" && c[2] === "hq-jj" && calls.indexOf(c) < calls.findIndex((d) => d[1] === "start"))).toBe(false);
  await sync();
  await until(() => herdr.typedInto("hq-jj").filter((t) => t.includes("You are the HQ of the JJ floor")).length > guides, "the guide again");
  expect(await floor("jj")).toMatchObject({ receiving: true });
  await until(async () => (await post("/api/floors/jj", { rm: true })).status === 200, "jj removed");
});

test("USE AN AGENT: a running lane promoted to HQ gets the guide for its floor", async () => {
  expect((await post("/api/floors", { id: "sales", name: "Sales", hq: "golf" })).status).toBe(200);
  await sync();
  await until(() => herdr.typedInto("golf").some((t) => t.includes("You are the HQ of the Sales floor")), "the guide");
  expect(await floor("sales")).toMatchObject({ starting: false, receiving: true });
  expect(await alarms()).toHaveLength(1); // only jj's, from the test above
});

test("START A NEW HQ: a tab in the first HQ's workspace and directory, hq-<id> started in its pane, the guide", async () => {
  const from = herdr.calls().length;
  const r = await post("/api/floors", { id: "ops", name: "Ops", color: "#2f9e57", start: true });
  expect(r).toMatchObject({ status: 200, id: "ops" });
  const calls = herdr.calls().slice(from);
  const tab = calls.find((c) => c[0] === "tab" && c[1] === "create")!;
  expect(tab).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/the-project", "--label", "Ops HQ", "--no-focus"]);
  const start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start.slice(0, 6)).toEqual(["agent", "start", "hq-ops", "--kind", "claude", "--pane"]);
  expect(start[6]).toMatch(/^w1:p9\d$/);
  expect(await floor("ops")).toMatchObject({ name: "Ops", hq: "hq-ops", color: "#2a9fc9" }); // green is the working reading: teal, but Sales wears it, so cyan
  await sync();
  await until(() => herdr.typedInto("hq-ops").some((t) => t.includes("You are the HQ of the Ops floor (floor id ops)")), "the guide");
  expect(herdr.typedInto("hq-ops")[0]).toContain("HQ Office guidance");
  expect(await floor("ops")).toMatchObject({ starting: false, receiving: true });
});

test("START A NEW HQ that herdr cannot start: the error, the tab closed, no floor", async () => {
  herdr.failStart(true);
  const from = herdr.calls().length;
  const r = await post("/api/floors", { id: "legal", name: "Legal", start: true });
  herdr.failStart(false);
  expect(r.status).toBe(400);
  expect(r.error).toContain("herdr could not start hq-legal: the pane is not at a shell prompt");
  const made = herdr.calls().slice(from).find((c) => c[0] === "tab" && c[1] === "create");
  expect(made).toBeTruthy();
  expect(herdr.calls().slice(from).some((c) => c[0] === "tab" && c[1] === "close")).toBe(true);
  expect(await floor("legal")).toBeUndefined();
  // An id or a name that is taken is refused before herdr is asked anything.
  const asked = () => herdr.calls().filter((c) => !c.includes("list")).length;
  const before = asked();
  expect((await post("/api/floors", { id: "ops", start: true })).status).toBe(400);
  expect(asked()).toBe(before);
});

test("hud floor add ID --start does the same", async () => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "floor", "add", "legal", "--start", "--name", "Legal"], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain("floor legal added");
  expect(herdr.calls().some((c) => c[0] === "agent" && c[1] === "start" && c[2] === "hq-legal")).toBe(true);
  expect(await floor("legal")).toMatchObject({ name: "Legal", hq: "hq-legal" });
});
