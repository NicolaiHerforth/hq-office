// Delivery to HQ is confirmed. Typed into an idle HQ, a message must start HQ working (herdr agent prompt --wait
// --until working), or it is held and tried again. Typed in while HQ is mid-turn, it cannot be confirmed (a queued
// message can be lost, as five answers were): it is typed in once more when HQ is next idle, unless HQ acked it
// first. S.hq.deliveries says where each of the owner's notes and answers stands, for the page.
// Under the queue only an urgent Tell is typed into HQ (queue.ts tellHq), so the notes here are urgent; a queued
// Tell is qN on the page and its outbox ref is ask:N.
// The stub herdr: status is "idle", "working" or "deaf" (idle, but a prompt never starts it working).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-confirm-test-"));
const herdr = join(data, "herdr");
const status = join(data, "status");
const log = join(data, "prompts.log");
writeFileSync(herdr, `#!/bin/sh
S=$(cat "${status}")
case "$1 $2" in
  "agent list") L=$S; [ "$S" = deaf ] && L=idle; echo "{\\"result\\":{\\"agents\\":[{\\"name\\":\\"hq\\",\\"agent_status\\":\\"$L\\",\\"pane_id\\":\\"w8:p1\\",\\"agent\\":\\"claude\\"}]}}" ;;
  "agent prompt")
    case "$*" in
      *--wait*)
        [ "$S" = deaf ] && { echo '{"error":{"code":"agent_prompt_stalled","message":"no working state within 5000ms"}}' >&2; exit 1; }
        printf 'TOOK %s\\n<<END>>\\n' "$4" >> "${log}" ;;
      *) printf 'QUEUED %s\\n<<END>>\\n' "$4" >> "${log}" ;;
    esac ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
writeFileSync(status, "idle");

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_RESEND_WINDOW_MS: "1500" } });
});
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}) => (await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) })).json();
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const entries = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
const took = (part: string) => entries().filter((e) => e.startsWith("TOOK ") && e.includes(part));
const queued = (part: string) => entries().filter((e) => e.startsWith("QUEUED ") && e.includes(part));
const delivery = async (ref: string) => (await state()).hq.deliveries[ref];
const until = async (ok: () => Promise<boolean> | boolean) => { for (let i = 0; i < 80; i++) { if (await ok()) return; await Bun.sleep(25); } throw new Error("timed out"); };
const noteId = async (text: string) => (await state()).notes.find((n: any) => n.text === text).id;
const noteRef = async (text: string) => { const id = String(await noteId(text)); return id.startsWith("q") ? `ask:${id.slice(1)}` : `note:${id}`; };

test("HQ idle: typed in and confirmed (HQ started working on it)", async () => {
  await post("/api/sync");
  await post("/api/notes", { text: "first note", urgent: true });
  await until(() => took("first note").length === 1);
  await until(async () => (await delivery(await noteRef("first note"))) === "delivered");
});

test("HQ mid-turn: typed in, unconfirmed; once HQ is idle it goes again, once, and is confirmed", async () => {
  writeFileSync(status, "working");
  await post("/api/sync");
  const { id } = await post("/api/asks", { title: "Merge it?", kind: "action" });
  await post(`/api/asks/${id}/answer`, { answer: "done" });
  await until(() => queued(`HUD answer #${id}`).length === 1);
  expect(await delivery(`ask:${id}`)).toBe("unconfirmed");
  await post("/api/sync"); // still mid-turn: nothing more
  expect(took(`HUD answer #${id}`)).toHaveLength(0);
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await until(() => took(`HUD answer #${id}`).length === 1);
  expect(took(`HUD answer #${id}`)[0]).toContain(`sent again: it was typed in while you were mid-turn; ack it with hud ack a:${id}`);
  await until(async () => (await delivery(`ask:${id}`)) === "delivered");
  await post("/api/hq/check");
  expect(took(`HUD answer #${id}`)).toHaveLength(1);
});

test("HQ mid-turn, then closes it from its queue: not typed in again", async () => {
  writeFileSync(status, "working");
  await post("/api/sync");
  await post("/api/notes", { text: "read in the inbox", urgent: true });
  await until(() => queued("read in the inbox").length === 1);
  const ref = await noteRef("read in the inbox");
  await post(`/api/requests/${ref.slice(4)}/close`, { reason: "read" }); // HQ closes a queued Tell: hud req close
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await Bun.sleep(200);
  expect(took("read in the inbox")).toHaveLength(0);
  expect(await delivery(ref)).toBe("acked");
});

test("HQ idle but deaf (the prompt never starts it): held, said on the page, and tried again until it takes", async () => {
  writeFileSync(status, "deaf");
  await post("/api/sync");
  await post("/api/notes", { text: "into the void", urgent: true });
  const ref = await noteRef("into the void");
  await until(async () => ((await state()).hq.reason ?? "").includes("did not start working")); // the attempt has failed
  expect(await delivery(ref)).toBe("held");
  const link = (await state()).hq;
  expect(link.ok).toBe(false);
  expect(link.reason).toContain("did not start working");
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await until(async () => (await delivery(ref)) === "delivered");
  expect((await state()).hq.ok).toBe(true);
});

test("only recent ones go again: one typed in mid-turn longer ago than the window is never sent again", async () => {
  writeFileSync(status, "working");
  await post("/api/sync");
  await post("/api/notes", { text: "too old to replay", urgent: true });
  await until(() => queued("too old to replay").length === 1);
  await Bun.sleep(1700); // past the window (1.5 s here, 3 h for real)
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await Bun.sleep(300);
  expect(took("too old to replay")).toHaveLength(0);
  expect(await delivery(await noteRef("too old to replay"))).toBe("delivered");
});

test("at most 3 go again per idle check; the rest on the next", async () => {
  writeFileSync(status, "working");
  await post("/api/sync");
  for (let i = 1; i <= 5; i++) await post("/api/notes", { text: `batch note ${i}`, urgent: true });
  await until(() => queued("batch note").length === 5);
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await Bun.sleep(300);
  expect(took("batch note")).toHaveLength(3);
  await post("/api/hq/check");
  await until(() => took("batch note").length === 5);
});

test("a lane's urgent request typed in mid-turn goes again with its queue number, not hud ack", async () => {
  writeFileSync(status, "working");
  await post("/api/sync");
  const { id } = await post("/api/requests", { lane: "some-lane", kind: "BLOCK", text: "stuck on the build", urgent: true });
  await until(() => queued("stuck on the build").length === 1);
  writeFileSync(status, "idle");
  await post("/api/hq/check");
  await until(() => took("stuck on the build").length === 1);
  expect(took("stuck on the build")[0]).toContain(`it is #${id} in your queue (hud req next)`);
  expect(took("stuck on the build")[0]).not.toContain("hud ack");
});
