// A lane's role and projects (hud lane --role, --project) and its message stream (/api/lanes/stream). A server on a
// spare port with a throwaway data dir.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const PORT = probe.port;
probe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "hq-lanes-test-"));
let server: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  server = Bun.spawn([process.execPath, "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, HUD_PORT: String(PORT), HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_OWNER: "Tester" },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (const deadline = Date.now() + 8000; Date.now() < deadline; await Bun.sleep(100)) {
    try {
      if ((await fetch(`${BASE}/api/state`)).ok) return;
    } catch {}
  }
  throw new Error(`server did not come up on port ${PORT}`);
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  rmSync(DATA, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
const lane = async (name: string) => (await (await fetch(`${BASE}/api/state`)).json()).lanes.find((l: any) => l.name === name);
const stream = async (name: string) => (await (await fetch(`${BASE}/api/lanes/stream?lane=${encodeURIComponent(name)}`)).json()).items;
const hud = async (...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  return { code, err };
};

test("hud lane sets a role and projects; a bare Linear link names itself", async () => {
  expect((await hud("lane", "plan-pm", "--title", "Plans", "--role", "PM", "--project", "Deploy gate=https://linear.app/acme/project/deploy-gate-1a2b3c4d5e6f/overview", "--project", "https://linear.app/acme/project/release-train-9f8e7d6c5b4a/overview")).code).toBe(0);
  expect(await lane("plan-pm")).toMatchObject({
    title: "Plans",
    role: "pm",
    projects: [
      { name: "Deploy gate", url: "https://linear.app/acme/project/deploy-gate-1a2b3c4d5e6f/overview" },
      { name: "release train", url: "https://linear.app/acme/project/release-train-9f8e7d6c5b4a/overview" },
    ],
  });
});

test("a later hud lane changes only what it names; --role \"\" and --project none clear", async () => {
  await hud("lane", "plan-pm", "--note", "on it");
  expect(await lane("plan-pm")).toMatchObject({ role: "pm", note: "on it" });
  expect((await lane("plan-pm")).projects).toHaveLength(2);
  await hud("lane", "plan-pm", "--project", "none");
  expect(await lane("plan-pm")).toMatchObject({ role: "pm", projects: [] });
  await hud("lane", "plan-pm", "--role", "");
  expect((await lane("plan-pm")).role).toBeNull();
});

test("a lane without a role has none, and a wrong role or a project without a link is refused", async () => {
  await post("/api/lanes", { name: "plain" });
  expect(await lane("plain")).toMatchObject({ role: null, projects: [] });
  const bad = await hud("lane", "plain", "--role", "boss");
  expect(bad.code).not.toBe(0);
  expect(bad.err).toContain("role must be one of");
  expect((await post("/api/lanes", { name: "plain", projects: ["no link here"] })).status).toBe(400);
  expect((await lane("plain")).projects).toEqual([]);
});

test("removing a lane forgets its role, so a lane of the same name starts plain", async () => {
  await hud("lane", "gone-lane", "--role", "walker");
  await hud("rm-lane", "gone-lane");
  await post("/api/lanes", { name: "gone-lane" });
  expect((await lane("gone-lane")).role).toBeNull();
});

test("a lane's stream: its updates, events and the replies to its updates, oldest first, and nothing of another lane's", async () => {
  await post("/api/lanes", { name: "alpha", phase: "running", note: "started" });
  const u = await (await post("/api/updates", { lane: "alpha", title: "Halfway", body: "Merged part one." })).json();
  await post("/api/updates", { lane: "beta", title: "Not alpha's" });
  await post("/api/asks", { lane: "alpha", kind: "action", title: "Approve it" });
  await post("/api/notes", { text: `re: #u${u.id} ("Halfway") Nice` });
  await post("/api/notes", { text: "A note to nobody in particular" });
  const items = await stream("alpha");
  expect(items.map((m: any) => [m.who, m.title ?? m.text])).toEqual([
    ["hq", "phase running: started"],
    ["hq", "Halfway"],
    ["hq", "asked: Approve it"],
    ["you", "Nice"],
  ]);
  expect(items.find((m: any) => m.key === `u${u.id}`)).toMatchObject({ text: "Merged part one.", read: false });
  expect(items.at(-1)).toMatchObject({ to: `u${u.id}`, acked: false });
  // the owner's answer is the owner's
  const ask = (await (await fetch(`${BASE}/api/state`)).json()).open.find((a: any) => a.title === "Approve it");
  await post(`/api/asks/${ask.id}/answer`, { answer: "done" });
  expect((await stream("alpha")).at(-1)).toMatchObject({ who: "you", text: `answered "Approve it": done` });
  expect(await stream("nobody")).toEqual([]);
});
