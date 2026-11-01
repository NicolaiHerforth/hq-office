// An ask with a recommended option and a deadline goes ahead with that option when nobody answers by then. It leaves
// the open questions, reads "Went ahead", HQ's inbox gets one item, and the owner can still answer (HQ hears it marked).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-ask-default-test-"));
const herdr = join(data, "herdr");
const log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_OWNER: "" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});
const post = (path: string, body: unknown) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
const get = async (path: string) => (await fetch(`${server.base}${path}`)).json();
const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
const until = async (ok: () => boolean | Promise<boolean>) => { for (let i = 0; i < 400 && !(await ok()); i++) await Bun.sleep(25); };

test("an unanswered ask goes ahead with its recommendation at the deadline, once", async () => {
  const { id } = await (await post("/api/asks", { title: "Pick a plan", lane: "golf", options: ["A", "B"], recommended: "B", default_by: Date.now() + 300 })).json();
  expect((await get("/api/state")).open.map((a: any) => a.id)).toContain(id);
  await until(async () => (await get("/api/state")).defaulted.some((a: any) => a.id === id));
  const s = await get("/api/state");
  expect(s.open.map((a: any) => a.id)).not.toContain(id);
  const row = s.defaulted.find((a: any) => a.id === id);
  expect(row.answer).toBe("B");
  expect(row.defaulted_at).toBeGreaterThan(0);
  expect(s.answered.find((a: any) => a.id === id).status).toBe("defaulted");
  const box = await get("/api/inbox");
  expect(box.answers.filter((a: any) => a.id === id).map((a: any) => a.summary)).toEqual([`#${id} defaulted to "B"`]);
  await until(() => prompts().some((p) => p.includes("defaulted")));
  await Bun.sleep(300);
  expect(prompts().filter((p) => p.includes(`defaulted #${id}`))).toEqual([`HUD defaulted #${id} (golf): "Pick a plan" -> went ahead with "B"`]);
  expect(s.events.filter((e: any) => e.text.includes(`ask #${id} went ahead`))).toHaveLength(1);
});

test("answering after the default reaches HQ as an answer, marked", async () => {
  const { id } = await (await post("/api/asks", { title: "Ship it?", options: ["yes", "no"], recommended: "yes", default_by: Date.now() + 200 })).json();
  await until(async () => (await get("/api/state")).defaulted.some((a: any) => a.id === id));
  await post(`/api/asks/${id}/ack`, {});
  expect((await post(`/api/asks/${id}/answer`, { answer: "no" })).status).toBe(200);
  const s = await get("/api/state");
  expect(s.defaulted.map((a: any) => a.id)).not.toContain(id);
  const box = await get("/api/inbox");
  const a = box.answers.find((x: any) => x.id === id);
  expect(a.answer).toBe("no");
  expect(a.summary).toBe(`#${id} answered after the default: no`);
  await until(() => prompts().some((p) => p.includes(`answer #${id}`)));
  expect(prompts().find((p) => p.includes(`answer #${id}`))).toBe(`HUD answer #${id}: "Ship it?" -> no (after the default: it went ahead with "yes")`);
  expect((await post(`/api/asks/${id}/answer`, { answer: "again" })).status).toBe(400);
});

test("--by needs --rec, and never goes with a secret", async () => {
  const soon = Date.now() + 60_000;
  expect((await post("/api/asks", { title: "No rec", default_by: soon })).status).toBe(400);
  expect((await post("/api/asks", { title: "Secret", recommended: "x", secrets: ["TOKEN_A"], default_by: soon })).status).toBe(400);
  expect((await post("/api/asks", { title: "Plain", recommended: "x" })).status).toBe(200);
  const hud = Bun.spawnSync(["bun", join(ROOT, "hud.ts"), "ask", "--title", "t", "--by", "+1m"], { env: { ...process.env, HUD_URL: server.base } });
  expect(hud.exitCode).toBe(1);
  expect(hud.stderr.toString()).toContain("--by needs --rec");
});
