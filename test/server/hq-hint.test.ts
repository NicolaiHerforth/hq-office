// Every message the server types into HQ ends with the one-line reminder to reply through the HUD, unless
// HUD_HQ_HINT=0. Each server runs on a spare port with a throwaway data dir and a stub herdr that records prompts.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { HINT } from "../../src/hq-guide.ts";

const ROOT = join(import.meta.dir, "..", "..");
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function office(hint: string | undefined) {
  const data = mkdtempSync(join(tmpdir(), "hq-hint-test-"));
  const herdr = join(data, "herdr");
  const log = join(data, "prompts.log");
  // One record per prompt: the text argument, then a separator line (a prompt may span lines).
  writeFileSync(herdr, `#!/bin/sh\ncase "$1 $2" in\n  "agent list") echo '{"result":{"agents":[]}}' ;;\n  "agent prompt") printf '%s\\n<<END>>\\n' "$4" >> "${log}" ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: hint };
  if (hint === undefined) delete env.HUD_HQ_HINT;
  delete env.HUD_OWNER;
  const server = await spawnServer({ cwd: ROOT, env });
  stops.push(async () => {
    await server.stop();
    rmSync(data, { recursive: true, force: true });
  });
  const { base } = server;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return res.json();
  };
  // The stub runs after the request returns: wait for the prompt that contains `part`.
  const prompt = async (part: string) => {
    for (let i = 0; i < 60; i++) {
      const all = existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : [];
      const hit = all.find((p) => p.includes(part));
      if (hit) return hit;
      await Bun.sleep(50);
    }
    throw new Error(`no prompt containing ${part}`);
  };
  const state = async () => (await fetch(`${base}/api/state`)).json();
  return { post, prompt, state };
}

describe("reply reminder on (the default)", async () => {
  const o = await office(undefined);

  // A plain note from the owner waits in HQ's queue (see queue.ts); only an answer or an urgent line is typed.
  test("a plain note types nothing into HQ's pane", async () => {
    await o.post("/api/notes", { text: "ship it" });
    await Bun.sleep(300);
    await expect(o.prompt("ship it")).rejects.toThrow("no prompt containing");
  });

  test("an answer carries it", async () => {
    const { id } = await o.post("/api/asks", { title: "Merge the fix?" });
    await o.post(`/api/asks/${id}/answer`, { answer: "yes, merge" });
    expect(await o.prompt("yes, merge")).toBe(`HUD answer #${id}: "Merge the fix?" -> yes, merge\n${HINT}`);
  });

  // A reply from the MESSAGES tab is an ordinary note now: it waits in HQ's queue and stays in the owner's thread.
  test("a reply from the messages tab waits in the queue and stays in the owner's notes", async () => {
    const { id } = await o.post("/api/updates", { title: "PR is up" });
    await o.post("/api/notes", { text: `re: #u${id} ("PR is up") looks good` });
    await Bun.sleep(300);
    await expect(o.prompt("looks good")).rejects.toThrow("no prompt containing");
    expect((await o.state()).notes.map((n: any) => n.text)).toContain(`re: #u${id} ("PR is up") looks good`);
  });

  test("the reminder is one line and names the commands", () => {
    expect(HINT).not.toContain("\n");
    expect(HINT).toContain("hud tell");
    expect(HINT).toContain("hud comment ID");
  });
});

describe("HUD_HQ_HINT=0", async () => {
  const o = await office("0");

  test("an answer goes without it", async () => {
    const { id } = await o.post("/api/asks", { title: "Q" });
    await o.post(`/api/asks/${id}/answer`, { answer: "plain answer" });
    expect(await o.prompt("plain answer")).not.toContain(HINT);
  });
});
