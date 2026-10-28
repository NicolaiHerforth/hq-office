// The plugin's greet command (run by herdr on pane.agent_detected): the HQ agent's pane, and any floor's HQ, gets the
// HQ guide once per session (a floor's HQ with the line naming its floor), other agents get nothing. A fake herdr serves `agent list` from a file and records every prompt; nothing
// is written outside a temporary directory and the real herdr is never run.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE, guideFor } from "../../src/hq-guide.ts";
import { freePort } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-office-greet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const herdr = join(dir, "herdr");
const agentsFile = join(dir, "agents.json");
const promptLog = join(dir, "prompts.log");
const failFlag = join(dir, "fail-prompts");
writeFileSync(
  herdr,
  `#!/bin/sh
case "$1 $2" in
  "agent list") cat "${agentsFile}" ;;
  "agent prompt") [ -e "${failFlag}" ] && { echo "agent_blocked" >&2; exit 1; }; printf '%s\\n%s\\n<<END>>\\n' "$3" "$4" >> "${promptLog}" ;;
  *) exit 3 ;;
esac
`,
);
chmodSync(herdr, 0o755);

type Agent = { name?: string; pane_id: string; session?: string; ready?: boolean };
function setAgents(agents: Agent[]) {
  const list = agents.map((a) => ({
    agent: "claude",
    name: a.name,
    pane_id: a.pane_id,
    terminal_id: `term_${a.pane_id}`,
    interactive_ready: a.ready ?? true,
    agent_session: a.session ? { agent: "claude", kind: "id", source: "herdr:claude", value: a.session } : null,
  }));
  writeFileSync(agentsFile, JSON.stringify({ result: { agents: list } }));
}
const prompts = () =>
  existsSync(promptLog)
    ? readFileSync(promptLog, "utf8").split("\n<<END>>\n").filter(Boolean).map((r) => ({ to: r.slice(0, r.indexOf("\n")), text: r.slice(r.indexOf("\n") + 1) }))
    : [];

function makeConfig(name: string, body: string | null) {
  const config = join(dir, name, "config");
  const state = join(dir, name, "state");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  if (body !== null) writeFileSync(join(config, "config.env"), body);
  return { config, state };
}
const main = makeConfig("main", `HUD_HQ_AGENT=lead\nHUD_PORT=${freePort()}\nHERDR_BIN=${herdr}\n`);

function plugin(cmd: string, where: { config: string; state: string }, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(dir, "home"),
    TMPDIR: tmpdir(),
    HERDR_PLUGIN_STATE_DIR: where.state,
    HERDR_PLUGIN_CONFIG_DIR: where.config,
    HERDR_PLUGIN_EVENT: "pane.agent_detected",
    HQ_OFFICE_PLATFORM: "none",
    HQ_OFFICE_LAUNCHCTL: "/nonexistent/launchctl",
    HQ_OFFICE_SYSTEMCTL: "/nonexistent/systemctl",
    HQ_OFFICE_OPENER: "true",
    HQ_OFFICE_GREET_WAIT_MS: "400",
    HERDR_BIN_PATH: herdr, // so a missing HERDR_BIN can never reach the real herdr
    ...extra,
  };
  const p = Bun.spawnSync([process.execPath, "bin/hud-plugin.ts", cmd], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
const greet = (pane: string, where = main, extra: Record<string, string> = {}) => plugin("greet", where, { HERDR_PANE_ID: pane, ...extra });

test("the HQ agent's pane gets exactly one prompt with the guide", () => {
  setAgents([{ name: "lead", pane_id: "w1:p1", session: "s-1" }, { name: "worker", pane_id: "w1:p2", session: "s-9" }]);
  const r = greet("w1:p1");
  expect(r.code).toBe(0);
  expect(r.out).toContain("greet: sent the HQ guide to lead in w1:p1");
  expect(prompts()).toEqual([{ to: "lead", text: GUIDE }]);
});

test("a second detection of the same session sends nothing", () => {
  const r = greet("w1:p1");
  expect(r.code).toBe(0);
  expect(r.out).toContain("already has the guide");
  expect(prompts()).toHaveLength(1);
});

test("the status pane says the guide reached this session", () => {
  const r = plugin("status", main);
  expect(r.out).toMatch(/HQ guide: on, sent to lead this session at .*; reply reminder on every message/);
});

test("a new session of the HQ agent gets it again", () => {
  setAgents([{ name: "lead", pane_id: "w1:p1", session: "s-2" }, { name: "worker", pane_id: "w1:p2", session: "s-9" }]);
  expect(plugin("status", main).out).toContain("not sent to lead's current session");
  greet("w1:p1");
  expect(prompts().map((p) => p.to)).toEqual(["lead", "lead"]);
  expect(prompts()[1].text).toBe(GUIDE);
});

test("another agent's pane sends nothing", () => {
  const r = greet("w1:p2");
  expect(r.code).toBe(0);
  expect(r.out).toContain("w1:p2 runs worker, not the HQ agent lead or a floor's HQ; nothing sent");
  expect(prompts()).toHaveLength(2);
});

test("an agent that left its pane, or a pane with no agent, sends nothing", () => {
  expect(greet("w1:p1", main, { HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ type: "pane_agent_detected", pane_id: "w1:p1", released: true }) }).out).toContain("left its pane");
  expect(greet("w9:p9").out).toContain("no HQ agent ready in w9:p9");
  expect(prompts()).toHaveLength(2);
});

test("an HQ agent that is not ready yet is waited for", async () => {
  setAgents([{ name: "lead", pane_id: "w1:p3", ready: false }]);
  const run = Bun.spawn([process.execPath, "bin/hud-plugin.ts", "greet"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), HERDR_PLUGIN_STATE_DIR: main.state, HERDR_PLUGIN_CONFIG_DIR: main.config, HERDR_PANE_ID: "w1:p3", HERDR_BIN_PATH: herdr, HQ_OFFICE_PLATFORM: "none", HQ_OFFICE_GREET_WAIT_MS: "5000" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(300);
  setAgents([{ name: "lead", pane_id: "w1:p3", session: "s-3" }]);
  expect(await run.exited).toBe(0);
  expect(prompts().map((p) => p.to)).toEqual(["lead", "lead", "lead"]);
});

test("a failed prompt is not remembered, so the next detection sends it", () => {
  setAgents([{ name: "lead", pane_id: "w1:p4", session: "s-4" }]);
  writeFileSync(failFlag, "");
  const failed = greet("w1:p4");
  expect(failed.code).toBe(1);
  expect(failed.out).toContain("could not send the guide to lead: agent_blocked");
  rmSync(failFlag);
  expect(greet("w1:p4").out).toContain("sent the HQ guide to lead");
  expect(prompts()).toHaveLength(4);
});

test("HUD_HQ_GREET=0 sends nothing", () => {
  setAgents([{ name: "lead", pane_id: "w1:p5", session: "s-5" }]);
  expect(greet("w1:p5", main, { HUD_HQ_GREET: "0" }).out).toContain("greet: off");
  expect(prompts()).toHaveLength(4);
});

test("without a config, the agent named hq is the HQ agent (herdr's own HERDR_BIN_PATH finds herdr)", () => {
  const bare = makeConfig("bare", null);
  setAgents([{ name: "hq", pane_id: "w2:p1", session: "s-hq" }, { name: "lead", pane_id: "w2:p2", session: "s-6" }]);
  expect(greet("w2:p2", bare).out).toContain("not the HQ agent hq");
  const r = greet("w2:p1", bare);
  expect(r.code).toBe(0);
  expect(prompts().at(-1)).toEqual({ to: "hq", text: GUIDE });
  expect(prompts()).toHaveLength(5);
});

test("any floor's HQ is an HQ: it gets the guide naming its floor; the HUD is asked which agents run floors", async () => {
  const port = freePort();
  const hud = Bun.serve({ port, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/api/floors"
    ? Response.json({ floors: [{ id: "hq", name: "HQ", hq: "lead" }, { id: "ops", name: "Ops", hq: "hq-ops" }], caller: "hq" })
    : new Response("{}", { status: 404 })) });
  try {
    const floors = makeConfig("floors", `HUD_HQ_AGENT=lead\nHUD_PORT=${port}\nHERDR_BIN=${herdr}\n`);
    setAgents([{ name: "hq-ops", pane_id: "w5:p1", session: "s-ops" }, { name: "worker", pane_id: "w5:p2", session: "s-w" }]);
    const before = prompts().length;
    // Run without blocking this process: the fake HUD above answers from it.
    const greetNow = async (pane: string) => {
      const p = Bun.spawn([process.execPath, "bin/hud-plugin.ts", "greet"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), TMPDIR: tmpdir(), HERDR_PLUGIN_STATE_DIR: floors.state, HERDR_PLUGIN_CONFIG_DIR: floors.config, HERDR_PLUGIN_EVENT: "pane.agent_detected", HQ_OFFICE_PLATFORM: "none", HQ_OFFICE_GREET_WAIT_MS: "400", HERDR_BIN_PATH: herdr, HERDR_PANE_ID: pane }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out: out + err };
    };
    const r = await greetNow("w5:p1");
    expect(r.out).toContain("greet: sent the HQ guide to hq-ops");
    const sent = prompts().slice(before);
    expect(sent).toEqual([{ to: "hq-ops", text: guideFor({ id: "ops", name: "Ops" }) }]);
    expect(sent[0].text).toContain("You are the HQ of the Ops floor");
    expect((await greetNow("w5:p2")).out).toContain("not the HQ agent lead or a floor's HQ");
    expect(prompts().length).toBe(before + 1);
  } finally {
    hud.stop(true);
  }
});
