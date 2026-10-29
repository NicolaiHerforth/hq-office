// A floor's HQ and its lanes may be any agent herdr can run: nothing in a floor assumes a provider. Here the first
// floor's HQ is a codex agent, so a new HQ starts as codex unless the owner picks another kind; the kind is
// remembered for START ITS HQ; an agent that stops at a question while it starts is kept; and hud, run where it cannot
// reach the HUD (an agent's sandbox), says how to get through.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { GUIDE } from "../../src/hq-guide.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-floor-any-"));
const HQ = { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "codex", workspace_id: "w1", cwd: "/tmp/the-project" };
const herdr = fakeHerdr(data, [HQ]);

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false" },
  });
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
const startCall = (name: string) => herdr.calls().filter((c) => c[0] === "agent" && c[1] === "start" && c[2] === name).at(-1);

test("the kinds herdr can start, those with its integration installed, and the first HQ's kind", async () => {
  const k = await (await fetch(`${server.base}/api/floors/kinds`)).json();
  expect(k).toEqual({ kinds: ["pi", "claude", "codex", "gemini"], ready: ["claude", "codex"], lead: "codex" });
});

test("START A NEW HQ starts the first HQ's kind by default, and S.floors says which kind each HQ runs", async () => {
  expect((await post("/api/floors", { id: "ops", name: "Ops", start: true })).status).toBe(200);
  expect(startCall("hq-ops")!.slice(3, 5)).toEqual(["--kind", "codex"]);
  await sync();
  expect(await floor("hq")).toMatchObject({ kind: "codex" });
  expect(await floor("ops")).toMatchObject({ kind: "codex", receiving: true });
  await until(() => herdr.typedInto("hq-ops").some((t) => t.includes("You are the HQ of the Ops floor")), "the guide");
});

test("any other kind herdr names, picked by the owner, and START ITS HQ starts that kind again", async () => {
  expect((await post("/api/floors", { id: "legal", name: "Legal", start: true, kind: "Gemini" })).status).toBe(200);
  expect(startCall("hq-legal")!.slice(3, 5)).toEqual(["--kind", "gemini"]);
  // its HQ goes away; START ITS HQ brings back a gemini HQ, not the first floor's kind
  herdr.world(herdr.agents().filter((a) => a.name !== "hq-legal"));
  await sync();
  expect(await floor("legal")).toMatchObject({ kind: "gemini" });
  expect((await post("/api/floors/legal", { start: true })).status).toBe(200);
  expect(startCall("hq-legal")!.slice(3, 5)).toEqual(["--kind", "gemini"]);
  expect((await post("/api/floors", { id: "bad", name: "Bad", start: true, kind: "rm -rf" })).status).toBe(400);
});

test("an HQ that stops at a question while it starts is kept: the floor is added, the owner told, the guide waits", async () => {
  herdr.blockStart("  Update available\n\n› 1. Update now\n  2. Skip\n  3. Skip until next version\n\n  enter continue · esc skip\n");
  const from = herdr.calls().length;
  const r = await post("/api/floors", { id: "sales", name: "Sales", start: true, kind: "codex" });
  herdr.blockStart(null);
  expect(r.status).toBe(200);
  expect(r.waiting).toBe("Update available\n1. Update now\n2. Skip\n3. Skip until next version");
  expect(herdr.calls().slice(from).some((c) => c[0] === "tab" && c[1] === "close")).toBe(false);
  await sync();
  expect(await floor("sales")).toMatchObject({ kind: "codex", receiving: false, reason: "HQ is stopped at a prompt (a permission or a question) in its pane" });
  expect((await state()).events.some((e: any) => /started its HQ hq-sales \(codex\) in herdr; it waits on a prompt in its pane: Update available/.test(e.text))).toBe(true);
  expect(herdr.typedInto("hq-sales")).toEqual([]);
  // the owner answers it in the pane: the HQ is ready, and its guide goes in
  herdr.world(herdr.agents().map((a) => (a.name === "hq-sales" ? { ...a, agent_status: "idle" } : a)));
  await sync();
  await until(() => herdr.typedInto("hq-sales").some((t) => t.includes("You are the HQ of the Sales floor")), "the guide after the prompt");
});

test("hud floor add --start --kind, and hud floor list names each HQ's kind", async () => {
  const hud = (...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
  const p = hud("floor", "add", "web", "--start", "--kind", "pi", "--name", "Web");
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  expect(startCall("hq-web")!.slice(3, 5)).toEqual(["--kind", "pi"]);
  await sync();
  expect(hud("floor", "list").stdout.toString()).toContain(`web  "Web"  HQ hq-web (pi)`);
});

test("hud that cannot reach the HUD says to run it outside a sandbox that blocks the network", () => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "inbox"], { env: { ...process.env, HUD_URL: "http://127.0.0.1:9", HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain("could not reach the HUD at http://127.0.0.1:9");
  expect(p.stderr.toString()).toContain("run hud outside the sandbox");
  expect(GUIDE).toContain("If your commands run in a sandbox that blocks the network, run `hud` outside it");
});

test("no floor code names a provider: the floor's HQ and its lanes are whatever agent herdr runs", () => {
  const files = ["src/server/floor-start.ts", "src/server/floors.ts", "src/server/hq-link.ts", "src/server/hq-sweep.ts", "src/server/routes/floors.ts", "src/hq-guide.ts", "bin/hud-plugin.ts",
    ...readdirSync(join(ROOT, "src/client/floors")).map((f) => `src/client/floors/${f}`), "src/client/hq-link/index.js", "src/client/core/floors.js"];
  for (const f of files) expect({ f, hits: readFileSync(join(ROOT, f), "utf8").match(/claude|anthropic|openai/gi) ?? [] }).toEqual({ f, hits: [] });
});
