// Adding a floor end to end. A new floor whose HQ herdr has never shown is STARTING: no alarm, no "HQ isn't
// receiving", nothing typed in; after HUD_HQ_STARTING_MS it is "not started", still calm. Once its HQ is seen it is
// receiving, and only an HQ seen and then gone is the alarm. USE AN AGENT takes a running agent (a lane promoted to
// run a domain) and sends it the HQ guide for its floor. START A NEW HQ opens a herdr tab in the first HQ's workspace
// and directory, starts hq-<id> in its pane, adds the floor and sends the new HQ its guide; a failure closes the tab
// and adds nothing. A stub herdr (test/fake-herdr.ts) records every call.
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
const STARTING_MS = 1500;

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_HQ_STARTING_MS: String(STARTING_MS) },
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

test("a new floor whose HQ herdr has never shown is STARTING: no alarm, nothing typed, a note held", async () => {
  const r = await post("/api/floors", { id: "jj", name: "JJ", hq: "provisioning-admin" });
  expect(r.status).toBe(200);
  await sync();
  const s = await state();
  expect(s.floors.find((f: any) => f.id === "jj")).toMatchObject({ starting: true, notStarted: false, receiving: null, reason: null });
  expect(s.hqLinks.jj).toMatchObject({ ok: null, starting: true, reason: null });
  expect(await alarms()).toEqual([]);
  await post("/api/notes", { text: "for the new floor", floor: "jj" });
  await sync();
  expect(herdr.calls().some((c) => c[0] === "agent" && c[1] === "prompt" && c[2] === "provisioning-admin")).toBe(false);
  expect((await state()).hqLinks.jj.ok).toBeNull();
  // No guide for an agent that is not running: the plugin's greet sends it when it starts.
  expect(herdr.typedInto("provisioning-admin")).toEqual([]);
});

test("after a while it is 'not started': a calm note, still no alarm", async () => {
  await Bun.sleep(STARTING_MS + 100);
  await sync();
  expect(await floor("jj")).toMatchObject({ starting: true, notStarted: true, receiving: null });
  expect(await alarms()).toEqual([]);
});

test("once herdr shows it, it is receiving and gets what was held; seen and then gone is the alarm", async () => {
  herdr.world([...herdr.agents(), { name: "provisioning-admin", agent_status: "idle", pane_id: "w3:p1", agent: "claude" }]);
  await sync();
  await until(() => herdr.typedInto("provisioning-admin").some((t) => t.includes("for the new floor")), "the held note");
  expect(await floor("jj")).toMatchObject({ starting: false, receiving: true });
  herdr.world(herdr.agents().filter((a) => a.name !== "provisioning-admin"));
  await sync();
  expect(await floor("jj")).toMatchObject({ starting: false, receiving: false, reason: 'no agent in herdr is named "provisioning-admin"' });
  expect((await alarms()).some((e: any) => e.floor === "jj")).toBe(true);
  expect((await post("/api/floors/jj", { rm: true })).status).toBe(200);
});

test("GET /api/floors/agents lists herdr's live named agents, lanes too, and which floor each runs", async () => {
  const { agents } = await (await fetch(`${server.base}/api/floors/agents`)).json();
  expect(agents.find((a: any) => a.name === "golf")).toMatchObject({ lane: true, floor: null, machine: "local" });
  expect(agents.find((a: any) => a.name === "hq")).toMatchObject({ floor: "hq" });
});

test("USE AN AGENT: a running lane promoted to HQ gets the guide for its floor", async () => {
  expect((await post("/api/floors", { id: "sales", name: "Sales", hq: "golf" })).status).toBe(200);
  await sync();
  await until(() => herdr.typedInto("golf").some((t) => t.includes("You are the HQ of the Sales floor")), "the guide");
  expect(await floor("sales")).toMatchObject({ starting: false, receiving: true });
  expect(await alarms()).toHaveLength(1); // only jj's, from the test above
});

test("START A NEW HQ: a tab in the first HQ's workspace and directory, hq-<id> started in its pane, the guide", async () => {
  const r = await post("/api/floors", { id: "ops", name: "Ops", color: "#2f9e57", start: true });
  expect(r).toMatchObject({ status: 200, id: "ops" });
  const calls = herdr.calls();
  const tab = calls.find((c) => c[0] === "tab" && c[1] === "create")!;
  expect(tab).toEqual(["tab", "create", "--workspace", "w1", "--cwd", "/tmp/the-project", "--label", "Ops HQ", "--no-focus"]);
  const start = calls.find((c) => c[0] === "agent" && c[1] === "start")!;
  expect(start.slice(0, 7)).toEqual(["agent", "start", "hq-ops", "--kind", "claude", "--pane", "w1:p91"]);
  expect(await floor("ops")).toMatchObject({ name: "Ops", hq: "hq-ops", color: "#2f9e57" });
  await sync();
  await until(() => herdr.typedInto("hq-ops").some((t) => t.includes("You are the HQ of the Ops floor (floor id ops)")), "the guide");
  expect(herdr.typedInto("hq-ops")[0]).toContain("HQ Office guidance");
  expect(await floor("ops")).toMatchObject({ starting: false, receiving: true });
});

test("START A NEW HQ that herdr cannot start: the error, the tab closed, no floor", async () => {
  herdr.failStart(true);
  const r = await post("/api/floors", { id: "legal", name: "Legal", start: true });
  herdr.failStart(false);
  expect(r.status).toBe(400);
  expect(r.error).toContain("herdr could not start hq-legal: the pane is not at a shell prompt");
  expect(herdr.calls().some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "w1:t92")).toBe(true);
  expect(await floor("legal")).toBeUndefined();
  // An id or a name that is taken is refused before herdr is asked anything.
  const asked = () => herdr.calls().filter((c) => !(c[0] === "agent" && c[1] === "list")).length;
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
