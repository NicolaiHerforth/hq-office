// A throwaway office for a server test: its own data dir, a stub herdr that records what is typed into agents, a server on a
// spare port. Start it again on the same `data` to see a restart. Never points at a real server, hud.db or herdr.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { spawnServer } from "../../scripts/room-hash.ts";

export const ROOT = join(import.meta.dir, "..", "..");

// `agents`: names `agent list` reports. `failing(true)` makes `agent prompt` fail like an agent that cannot take input.
export async function office(opts: { data?: string; agents?: string[] } = {}) {
  const data = opts.data ?? mkdtempSync(join(tmpdir(), "hq-office-test-"));
  const herdr = join(data, "herdr");
  const log = join(data, "prompts.log");
  const agents = (opts.agents ?? []).map((name, i) => `{"name":"${name}","pane_id":"p${i}","agent":"claude","agent_status":"idle","interactive_ready":true}`).join(",");
  const failFile = join(data, "fail");
  const prompt = `if [ -e "${failFile}" ]; then echo '{"error":{"code":"agent_blocked","message":"stub refuses"}}' >&2; exit 1; fi; printf '%s|%s\\n<<END>>\\n' "$3" "$4" >> "${log}"`;
  writeFileSync(herdr, `#!/bin/sh\ncase "$1 $2" in\n  "agent list") echo '{"result":{"agents":[${agents}]}}' ;;\n  "agent prompt") ${prompt} ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  const env: Record<string, string | undefined> = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0" };
  delete env.HUD_OWNER;
  const server = await spawnServer({ cwd: ROOT, env });
  const { base } = server;
  const send = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  const post = async (path: string, body: unknown) => {
    const res = await send(path, body);
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as any;
  // What was typed into agents so far: "name|text" records.
  const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n<<END>>\n").filter(Boolean) : []);
  const prompted = async (part: string) => {
    for (let i = 0; i < 80; i++) {
      const hit = prompts().find((p) => p.includes(part));
      if (hit) return hit;
      await Bun.sleep(50);
    }
    throw new Error(`no prompt containing ${part}`);
  };
  const failing = (on: boolean) => (on ? writeFileSync(failFile, "") : rmSync(failFile, { force: true }));
  const stop = () => server.stop();
  const remove = () => rmSync(data, { recursive: true, force: true });
  return { base, data, send, post, state, prompts, prompted, failing, stop, remove };
}
