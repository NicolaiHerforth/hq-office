// Who calls hud when an agent's commands do not run in its own herdr pane: some agents run them from one process
// shared by all their sessions, started in another pane, so HERDR_PANE_ID names a pane that is gone or another
// agent's. The session id in hud's environment, else the folder hud runs in, says who it is; agents on several floors
// in that folder is an error asking for --floor, never a note filed on the wrong floor. A pane herdr has, whose agent
// the session ids do not contradict, is trusted as before (an HQ may cd into a lane's worktree and stay itself).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-caller-who-"));
const dirs = realpathSync(mkdtempSync(join(tmpdir(), "hq-caller-dirs-")));
const PROJ = join(dirs, "proj"), SCRATCH = join(dirs, "scratch pm ø"), OTHER = join(dirs, "other");
for (const d of [PROJ, join(SCRATCH, "sub"), OTHER]) mkdirSync(d, { recursive: true });
const herdr = fakeHerdr(data, [
  { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude", workspace_id: "w1", cwd: PROJ, agent_session: { value: "sess-hq-0001" } },
  { name: "hq-cx", agent_status: "idle", pane_id: "w1:p2", agent: "codex", workspace_id: "w1", cwd: SCRATCH, foreground_cwd: SCRATCH },
  { name: "other-cx", agent_status: "idle", pane_id: "w1:p4", agent: "codex", workspace_id: "w1", cwd: OTHER, agent_session: { value: "sess-other-0001" } },
]);
writeFileSync(join(data, "shells.json"), JSON.stringify([{ pane_id: "w1:p9", cwd: SCRATCH }]));

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false" },
  });
  await sync();
  expect((await post("/api/floors", { id: "cx", name: "CX", hq: "hq-cx" })).status).toBe(200);
  await sync();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
  rmSync(dirs, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const sync = async () => {
  await post("/api/sync");
  await Bun.sleep(100);
};
const who = async (h: Record<string, string>) => {
  const res = await fetch(`${server.base}/api/floors`, { headers: { "x-hud-machine": "local", ...h } });
  return { status: res.status, ...(await res.json()) };
};
const cwd = (d: string) => encodeURIComponent(d);

test("a pane herdr does not have: the agent working in hud's folder (or under it) is the caller", async () => {
  expect((await who({ "x-hud-pane": "wZ:p1", "x-hud-cwd": cwd(SCRATCH) })).caller).toBe("cx");
  expect((await who({ "x-hud-pane": "wZ:p1", "x-hud-cwd": cwd(join(SCRATCH, "sub")) })).caller).toBe("cx");
});

test("a session id in hud's environment that herdr reports wins", async () => {
  expect((await who({ "x-hud-pane": "wZ:p1", "x-hud-cwd": cwd(SCRATCH), "x-hud-session": "nope-0000001,sess-hq-0001" })).caller).toBe("hq");
});

test("another agent's pane whose session the caller's does not match: the folder decides", async () => {
  expect((await who({ "x-hud-pane": "w1:p4", "x-hud-cwd": cwd(SCRATCH), "x-hud-session": "thread-of-the-pm-01" })).caller).toBe("cx");
  // no session ids sent: nothing contradicts the pane, so it is other-cx's (the first floor), as before
  expect((await who({ "x-hud-pane": "w1:p4", "x-hud-cwd": cwd(SCRATCH) })).caller).toBe("hq");
});

test("a real pane is trusted wherever hud runs: an HQ in a lane's folder stays itself; a plain shell pane is no agent", async () => {
  expect((await who({ "x-hud-pane": "w1:p2", "x-hud-cwd": cwd(PROJ) })).caller).toBe("cx");
  expect((await who({ "x-hud-pane": "w1:p9", "x-hud-cwd": cwd(SCRATCH) })).caller).toBe("hq");
  expect((await who({ "x-hud-cwd": cwd(SCRATCH) })).caller).toBe("hq"); // no pane at all: the owner's own terminal
});

test("agents on two floors in that folder: an error that says to add --floor, and --floor works", async () => {
  herdr.world([...herdr.agents(), { name: "cx-helper", agent_status: "idle", pane_id: "w1:p5", agent: "codex", workspace_id: "w1", cwd: PROJ }]);
  await post("/api/lanes", { name: "cx-helper", machine: "local", title: "helps", floor: "cx" });
  await sync();
  const r = await post("/api/updates", { title: "where does this go" }, { "x-hud-pane": "wZ:p1", "x-hud-machine": "local", "x-hud-cwd": cwd(PROJ) });
  expect(r.status).toBe(400);
  expect(r.error).toContain("hud cannot tell which agent is calling");
  expect(r.error).toContain("Add --floor ID");
  expect((await who({ "x-hud-pane": "wZ:p1", "x-hud-cwd": cwd(PROJ), "x-hud-floor": "cx" })).caller).toBe("cx");
});

test("hud itself sends its folder and session ids: a tell from a stale pane lands on the caller's floor", async () => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "tell", "--title", "from the codex floor"], {
    cwd: SCRATCH,
    env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "wZ:p1", HUD_LOCAL_MACHINE: "local", SOME_AGENT_THREAD_ID: "thread-of-the-pm-01" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.stderr.toString()).toBe("");
  const s = await (await fetch(`${server.base}/api/state`)).json();
  expect(s.updates.find((u: any) => u.title === "from the codex floor")).toMatchObject({ floor: "cx" });
});
