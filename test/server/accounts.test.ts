// Accounts: account-stats.py reads a fake home (Claude homes found by name and keychain exit code, two Codex homes,
// credentials planted with fake values) and prints names and percentages only; a new home links no login and starts
// from an allow-list of .claude.json keys; and a throwaway server moves a Claude lane through a fake herdr and a
// fake `security` that answers with exit codes only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TMP = realpathOf(mkdtempSync(join(tmpdir(), "hq-office-accounts-")));
const HOME = join(TMP, "home");
const DATA = join(TMP, "data");
const SECRETS = ["FAKE-EMAIL-1@example.invalid", "FAKE-CLAUDE-KEY-1", "FAKE-CODEX-TOKEN-1", "FAKE-CODEX-TOKEN-2", "FAKE-PLAN-1", "FAKE-LOGIN-FILE-1", "FAKE-USER-ID-1", "FAKE-MCP-TOKEN-1", "FAKE-MCP-HEADER-1", "FAKE-MCP-ARG-1", "FAKE-MCP-QUERY-1"];
const hour = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function realpathOf(p: string) {
  return Bun.spawnSync(["realpath", p]).stdout.toString().trim();
}
function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
const service = (dir: string) => `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;

// The default ~/.claude.json: identity next to the things a new home should start with.
const CLAUDE_JSON = {
  oauthAccount: { accountUuid: "FAKE-ACCOUNT-UUID-1", emailAddress: SECRETS[0] },
  userID: SECRETS[6],
  anonymousId: "FAKE-ANON-1",
  primaryApiKey: SECRETS[1],
  customApiKeyResponses: { approved: [SECRETS[1]] },
  hasAvailableSubscription: true,
  machineID: "FAKE-MACHINE-1",
  mcpServers: { files: { command: "files-mcp", env: { TOKEN: SECRETS[7] } }, remote: { type: "http", url: "https://mcp.example.invalid", headers: { Authorization: SECRETS[8] } }, withargs: { command: "args-mcp", args: ["--token", SECRETS[9]] }, withurl: { type: "sse", url: `https://mcp.example.invalid/sse?token=${SECRETS[10]}` }, plain: { command: "plain-mcp" } },
  hasCompletedOnboarding: true,
  lastOnboardingVersion: "2.1.0",
  theme: "dark",
  shiftEnterKeyBindingInstalled: true,
  hasCompletedClaudeInChromeOnboarding: true,
  installMethod: "native",
  numStartups: 99,
  projects: {
    "/work/app": { hasTrustDialogAccepted: true, allowedTools: ["Bash(ls)"], enabledMcpjsonServers: ["files"], lastSessionId: "FAKE-SESSION-1", lastCost: 4.2 },
  },
};
const SEEDED = ["hasCompletedClaudeInChromeOnboarding", "hasCompletedOnboarding", "lastOnboardingVersion", "mcpServers", "projects", "shiftEnterKeyBindingInstalled", "theme"];
const IDENTITY = ["oauthAccount", "userID", "anonymousId", "primaryApiKey", "customApiKeyResponses", "hasAvailableSubscription", "machineID"];

beforeAll(() => {
  // The default home: a login file, a backup of the config, and what a new home should share.
  write(join(HOME, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRETS[5] } }));
  write(join(HOME, ".claude/.claude.json.backup"), JSON.stringify(CLAUDE_JSON));
  write(join(HOME, ".claude/settings.json"), "{}");
  write(join(HOME, ".claude/projects/-work-app/sess-1.jsonl"), "{}\n");
  write(join(HOME, ".claude/skills/one/SKILL.md"), "# one\n");
  write(join(HOME, ".claude/backups/.claude.json.backup.1"), JSON.stringify(CLAUDE_JSON));
  write(join(HOME, ".claude.json"), JSON.stringify(CLAUDE_JSON));
  // Two more homes: work (its login is a keychain item) and spare (never logged in). ~/.claude-code-router is not a home.
  write(join(HOME, ".claude-work/.claude.json"), "{}");
  write(join(HOME, ".claude-spare/.claude.json"), "{}");
  write(join(HOME, ".claude-code-router/config.json"), "{}");
  // work's week is 40% used, as its lane's status line recorded.
  write(join(HOME, ".local/state/hq-office/claude-usage/work.json"), JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor((Date.now() + 2 * hour) / 1000) }, seven_day: { used_percentage: 40, resets_at: Math.floor((Date.now() + 50 * hour) / 1000) } } }));
  // The fake `security` answers with an exit code only, and logs how it was called (to prove it never asks for a secret).
  write(join(TMP, "keychain"), `${service(join(HOME, ".claude-work"))}\n`);
  write(join(TMP, "bin/security"), `#!/bin/sh\necho "$@" >> "${TMP}/security-calls"\n[ "$1" = "find-generic-password" ] && [ "$2" = "-s" ] && grep -qxF "$3" "${TMP}/keychain"\n`);
  chmodSync(join(TMP, "bin/security"), 0o755);
  // Codex: two homes, the second linking to the first one's sessions. ~/.codex-cli is an npm install, not a home.
  write(join(HOME, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: SECRETS[2] } }));
  const limits = { limit_id: "codex", plan_type: SECRETS[4], primary: { used_percent: 92, window_minutes: 10080, resets_at: Math.floor((Date.now() + 30 * hour) / 1000) }, secondary: null };
  write(join(HOME, ".codex/sessions/2026/10/25/rollout-2026-10-25T09-00-00-aaaa.jsonl"), [
    JSON.stringify({ timestamp: iso(Date.now() - 2 * hour), type: "session_meta", payload: { id: "aaaa" } }),
    JSON.stringify({ timestamp: iso(Date.now() - hour), type: "event_msg", payload: { type: "token_count", rate_limits: limits } }),
  ].join("\n") + "\n");
  write(join(HOME, ".codex-spare/auth.json"), JSON.stringify({ tokens: { access_token: SECRETS[3] } }));
  symlinkSync(join(HOME, ".codex/sessions"), join(HOME, ".codex-spare/sessions"));
  write(join(HOME, ".codex-cli/package.json"), "{}");
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function readStats() {
  const proc = Bun.spawnSync(["python3", "-I", join(ROOT, "src/server/account-stats.py")], { env: { HOME, PATH: process.env.PATH, HQ_SECURITY_BIN: join(TMP, "bin/security") } });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

test("the reader prints names and percentages, and no credential, email or account id", () => {
  const out = readStats();
  for (const s of SECRETS) expect(out).not.toContain(s);
  const { claude, codex } = JSON.parse(out);
  // default: its credentials file exists. work: its keychain item answers with exit 0. spare: neither.
  expect(claude.homes.map((h: any) => [h.name, h.logged_in])).toEqual([["default", true], ["spare", false], ["work", true]]);
  expect(claude.homes.find((h: any) => h.name === "work").windows.weekly.left).toBe(60);
  expect(claude.homes.find((h: any) => h.name === "work").windows.session.left).toBe(88);
  // The keychain is asked about an item's existence, never for its attributes or its secret.
  const calls = readFileSync(join(TMP, "security-calls"), "utf8").trim().split("\n");
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) expect(c).toMatch(/^find-generic-password -s Claude Code-credentials(-[0-9a-f]{8})?$/);
  expect(codex.map((h: any) => h.name)).toEqual(["codex", "spare"]);
  expect(codex[0].reading.windows).toEqual([{ minutes: 10080, used: 92, resets_at: expect.any(Number) }]);
  // A session log does not say which account wrote it, so the linked home shows no reading of its own.
  expect(codex[1]).toEqual({ name: "spare", logged_in: true, reading: null, shares_sessions_with: ["codex"] });
});

test("the lane status line keeps the rate limits and nothing else from Claude's payload", () => {
  const run = (payload: object) => Bun.spawnSync(["python3", "-I", join(ROOT, "src/server/claude-statusline.py"), "spare"], { env: { HOME, PATH: process.env.PATH }, stdin: new TextEncoder().encode(JSON.stringify(payload)) });
  const proc = run({ session_id: "FAKE-SESSION-2", cwd: "/work/app", rate_limits: { five_hour: { used_percentage: 30, resets_at: 1 }, seven_day: { used_percentage: 70, resets_at: 2 } } });
  expect(proc.stdout.toString().trim()).toBe("account spare · week 30% left");
  const kept = readFileSync(join(HOME, ".local/state/hq-office/claude-usage/spare.json"), "utf8");
  expect(JSON.parse(kept)).toEqual({ rate_limits: { five_hour: { used_percentage: 30, resets_at: 1 }, seven_day: { used_percentage: 70, resets_at: 2 } } });
  expect(kept).not.toContain("FAKE-SESSION-2");
  expect(JSON.parse(readStats()).claude.homes.find((h: any) => h.name === "spare").windows.weekly.left).toBe(30);
});

// ---- homes: in this process, with HOME pointed at the fake one ----

test("a new home links everything but a login file, and its .claude.json starts from the allow-list", async () => {
  const realHome = process.env.HOME;
  process.env.HOME = HOME;
  try {
    const { homeDir, makeHome, dialogKind, relaunchCommand, SEED_KEYS } = await import("../../src/server/claude-home.ts");
    // Never make a home outside the fake one: check the path before anything is written.
    expect(homeDir("fresh")).toBe(join(HOME, ".claude-fresh"));
    expect(() => makeHome("Bad Name")).toThrow();
    expect(() => makeHome("default")).toThrow();
    const { dir, mcpNeedsSecret } = makeHome("fresh");
    expect(mcpNeedsSecret).toEqual(["files", "remote", "withargs", "withurl"]);
    expect(dir).toBe(join(HOME, ".claude-fresh"));
    // Settings, skills and session transcripts are shared, so --resume finds the same session from either home.
    // The backups folder holds the default account's identity, so it is not shared.
    expect(readdirSync(dir).sort()).toEqual([".claude.json", ".hq-office-mcp-needs-secret.json", "projects", "settings.json", "skills"]);
    expect(JSON.parse(readFileSync(join(dir, ".hq-office-mcp-needs-secret.json"), "utf8"))).toEqual(["files", "remote", "withargs", "withurl"]);
    for (const entry of ["projects", "settings.json", "skills"]) {
      expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, entry))).toBe(join(HOME, ".claude", entry));
    }
    expect(existsSync(join(dir, "projects/-work-app/sess-1.jsonl"))).toBe(true);
    // No login file crosses, not as a link and not as a copy: the credentials file, nor the config's backup.
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(dir, ".claude.json.backup"))).toBe(false);
    expect(lstatSync(join(dir, ".claude.json")).isSymbolicLink()).toBe(false);

    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(Object.keys(seeded).sort()).toEqual(SEEDED);
    expect(SEED_KEYS.slice().sort()).toEqual(SEEDED);
    for (const key of IDENTITY) expect(seeded).not.toHaveProperty(key);
    // Of a project only its trust and approvals cross, not its last session or cost.
    expect(seeded.projects["/work/app"]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ["Bash(ls)"], enabledMcpjsonServers: ["files"] });
    // A server with env, headers, args or url (a token can sit in any) stays out whole: a secret is never duplicated
    // into another home, and a server stripped of its args would start broken.
    expect(seeded.mcpServers).toEqual({ plain: { command: "plain-mcp" } });
    for (const s of [SECRETS[0], SECRETS[1], SECRETS[5], SECRETS[6], SECRETS[7], SECRETS[8], SECRETS[9], SECRETS[10], "FAKE-ACCOUNT-UUID-1", "FAKE-SESSION-1"]) expect(readFileSync(join(dir, ".claude.json"), "utf8")).not.toContain(s);
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
    expect(() => makeHome("fresh")).toThrow(/already exists/);
    // A config that cannot be read gives no home at all, not a home with no trust.
    writeFileSync(join(HOME, ".claude.json"), "{ half");
    expect(() => makeHome("broken")).toThrow(/could not read/);
    expect(existsSync(join(HOME, ".claude-broken"))).toBe(false);
    writeFileSync(join(HOME, ".claude.json"), JSON.stringify(CLAUDE_JSON));

    // The relaunch: the lane's own home through the environment, the same session, and its own status line.
    expect(relaunchCommand("work", "sess-1", "/d/s.json")).toBe(`CLAUDE_CONFIG_DIR='${HOME}/.claude-work' claude --resume 'sess-1' --settings '/d/s.json'`);
    expect(relaunchCommand("default", "sess-1", "/d/s.json")).toBe("env -u CLAUDE_CONFIG_DIR claude --resume 'sess-1' --settings '/d/s.json'");
    expect(relaunchCommand("work", "it's", "/d/s.json")).toContain(`--resume 'it'\\''s'`);

    // A lane at a prompt is not showing a dialog. A choice menu is, and its wording says which kind.
    expect(dialogKind(PROMPT)).toBe(null);
    expect(dialogKind(WORKING)).toBe(null);
    expect(dialogKind(LIMIT)).toBe("limit");
    expect(dialogKind(CREDITS)).toBe("limit");
    expect(dialogKind(BUDGET)).toBe("limit");
    expect(dialogKind(EXTRA)).toBe("limit");
    expect(dialogKind(PERMISSION)).toBe("prompt");
    // The cursor can sit on any option, with either arrow, and a menu may show only its cancel hint.
    expect(dialogKind(PERMISSION.replace("❯ 1. Yes\n    2. No", "  1. Yes\n  ❯ 2. No"))).toBe("prompt");
    expect(dialogKind(PERMISSION.replace("❯ 1. Yes", "› 1. Yes"))).toBe("prompt");
    expect(dialogKind(PERMISSION.replace(/❯ 1\. Yes\n    2\. No/, "  1. Yes\n  2. No"))).toBe("prompt");
    expect(dialogKind(LIMIT.replace("❯ 1. Stop and wait for limit to reset\n    2. Upgrade your plan", "  1. Stop and wait for limit to reset\n  ❯ 2. Upgrade your plan"))).toBe("limit");
    // A limit message left in the scrollback above an idle prompt is the lane to move, not a dialog.
    expect(dialogKind(PAST_LIMIT)).toBe(null);
    expect(dialogKind(`You've hit your limit\n${"\n.".repeat(60)}\n${PROMPT}`)).toBe(null);
  } finally {
    process.env.HOME = realHome;
  }
});

// Screens as the pane shows them (the wording is the one Claude Code 2.1.310 ships).
const PROMPT = "● Done. The tests pass.\n\n╭────────────────────────────╮\n│ ❯                          │\n╰────────────────────────────╯\n  ? for shortcuts";
const WORKING = "✻ Thinking… (12s · esc to interrupt)\n\n╭────────────────────────────╮\n│ ❯                          │\n╰────────────────────────────╯";
const LIMIT = "  You've hit your limit · resets Mon 9:00\n\n  What do you want to do?\n\n  ❯ 1. Stop and wait for limit to reset\n    2. Upgrade your plan\n\n  Enter to confirm · Esc to cancel";
const CREDITS = "  Usage limit reached\n\n  ❯ 1. Add funds to continue with usage credits\n    2. Stop and wait for limit to reset";
const BUDGET = "  You've hit your team's shared budget. Run /usage-credits to raise it\n  ❯ 1. Switch to another model\n    2. Wait\n  Enter to confirm";
const EXTRA = "  Request extra usage from your admin\n  ❯ 1. /extra-usage\n    2. Wait";
const PERMISSION = "  Bash command\n    rm -rf build\n  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n  Esc to cancel";
const PAST_LIMIT = `● You've hit your limit · resets Mon 9:00\n\n${PROMPT}`;
const BACKGROUND = `${PROMPT}\n  2 shells still running`;

// ---- the server: a fake herdr and the fake security ----

let server: Awaited<ReturnType<typeof spawnServer>>;
const HERDR = join(TMP, "bin/herdr");
const agent = (over: object) => JSON.stringify({ result: { agents: [{ agent: "claude", agent_status: "idle", name: "lane-a", pane_id: "w1:p1", agent_session: { kind: "id", value: "sess-1" }, ...over }] } });
const calls = () => (existsSync(join(TMP, "herdr-calls")) ? readFileSync(join(TMP, "herdr-calls"), "utf8").trim().split("\n") : []);
function scene(agentJson: string, screen = PROMPT) {
  write(join(TMP, "agents.json"), agentJson);
  write(join(TMP, "screen.txt"), screen);
  rmSync(join(TMP, "herdr-calls"), { force: true });
  rmSync(join(TMP, "exited"), { force: true });
}
const api = (path: string, body: object) => fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const move = (lane: string, account: string) => api("/api/accounts/move", { lane, account });
const state = async (): Promise<any> => (await fetch(`${server.base}/api/state`)).json();

// The fake herdr: lists agents from agents.json, shows screen.txt, and logs every call. Like the real one it clears the
// agent's name when the agent exits, and a pane run starts an agent again (unnamed) unless a flag file says otherwise.
// Flag files in TMP: noexit, getfail, runfail, noreturn, renamefail, othersession (applies once pane run has run).
function installHerdr() {
  write(HERDR, `#!/bin/sh
echo "$@" >> "${TMP}/herdr-calls"
case "$1 $2" in
  "agent list")
    out=$(cat "${TMP}/agents.json")
    [ -e "${TMP}/unnamed" ] && out=$(echo "$out" | sed 's/"name":"lane-a"/"name":null/')
    [ -e "${TMP}/othersession" ] && [ -e "${TMP}/ran" ] && out=$(echo "$out" | sed 's/sess-1/sess-other/')
    echo "$out" ;;
  "pane read") cat "${TMP}/screen.txt" ;;
  "pane get")
    if [ -e "${TMP}/exited" ]; then
      [ -e "${TMP}/getfail" ] && { echo "pane gone" >&2; exit 1; }
      echo '{"result":{"pane":{"pane_id":"w1:p1"}}}'
    else echo '{"result":{"pane":{"pane_id":"w1:p1","agent":"claude"}}}'; fi ;;
  "agent prompt") if [ "$4" = "/exit" ] && [ ! -e "${TMP}/noexit" ]; then touch "${TMP}/exited" "${TMP}/unnamed"; fi ;;
  "pane run") [ -e "${TMP}/runfail" ] && { echo "pane run failed" >&2; exit 1; }; touch "${TMP}/ran"; [ -e "${TMP}/noreturn" ] || rm -f "${TMP}/exited" ;;
  "agent rename") [ -e "${TMP}/renamefail" ] && { echo "rename failed" >&2; exit 1; }; rm -f "${TMP}/unnamed" ;;
esac
exit 0
`);
  chmodSync(HERDR, 0o755);
}
const FLAGS = ["exited", "unnamed", "noexit", "getfail", "runfail", "noreturn", "othersession", "renamefail", "ran"];
const flag = (...names: string[]) => names.forEach((n) => writeFileSync(join(TMP, n), ""));
const sentToLane = () => calls().filter((c) => /^(agent prompt lane-|pane run|agent rename)/.test(c));
const startServer = (extra: Record<string, string> = {}) =>
  spawnServer({ cwd: ROOT, env: { ...process.env, HOME, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: HERDR, HQ_SECURITY_BIN: join(TMP, "bin/security"), HUD_LOCAL_MACHINE: "local", HUD_MACHINES: "local", ...extra } });
const accountsReady = async () => {
  for (let i = 0; i < 100; i++) {
    const s = await state();
    if (s.lanes.find((l: any) => l.name === "lane-a")?.agent === "claude" && s.accounts[0]?.ok) return;
    await Bun.sleep(100);
  }
};

test("the server moves an idle lane to a logged-in account, and refuses the rest", async () => {
  installHerdr();
  scene(agent({}));
  for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
  server = await startServer();
  try {
    await api("/api/lanes", { name: "lane-a", machine: "local" });
    await api("/api/lanes", { name: "lane-b", machine: "local" });
    // The lane's herdr sync fills in its agent; the accounts are read once at start.
    await accountsReady();
    const view = (await state()).accounts[0].claude;
    expect(view.accounts.map((a: any) => [a.name, a.loggedIn, a.lanes])).toEqual([["default", true, ["lane-a"]], ["fresh", false, []], ["spare", false, []], ["work", true, []]]);
    // The panel hears which MCP servers a home was made without a secret for (names only).
    expect(view.accounts.find((a: any) => a.name === "fresh").mcpNeedsSecret).toEqual(["files", "remote", "withargs", "withurl"]);
    expect(view.accounts.find((a: any) => a.name === "work").mcpNeedsSecret).toEqual([]);
    expect(view.accounts.find((a: any) => a.name === "work").weekly.left).toBe(60);
    expect(view.lanes).toEqual([{ name: "lane-a", status: expect.any(String), account: "default" }]);
    const page = JSON.stringify(await state());
    for (const s of SECRETS) expect(page).not.toContain(s);

    // Refused: the target is not logged in, or does not exist; nothing is sent to the lane.
    expect((await move("lane-a", "spare")).error).toMatch(/spare is not logged in.*claude auth login/);
    expect((await move("lane-a", "nobody")).error).toMatch(/no Claude home named nobody/);
    expect((await move("nolane", "work")).error).toMatch(/no lane named/);
    expect((await move("lane-a", "default")).error).toMatch(/already runs on default/);
    expect(sentToLane()).toEqual([]);

    // Refused: the lane is working, or its session id is unknown.
    scene(agent({ agent_status: "working" }));
    expect((await move("lane-a", "work")).error).toMatch(/lane-a is working/);
    scene(agent({ agent_session: undefined }));
    expect((await move("lane-a", "work")).error).toMatch(/session id is unknown/);
    scene(agent({ agent_session: { kind: "id", value: "" } }));
    expect((await move("lane-a", "work")).error).toMatch(/session id is unknown/);
    // Refused: background work that /exit would end, though herdr calls the lane idle.
    scene(agent({}), BACKGROUND);
    expect((await move("lane-a", "work")).error).toMatch(/background work \(2 shells still running\)/);
    expect(sentToLane()).toEqual([]);

    // Refused: a choice menu is showing. Nothing is typed, and a question is filed once per kind, however often it is tapped.
    for (const [status, screen] of [["idle", LIMIT], ["done", CREDITS], ["idle", BUDGET], ["idle", PERMISSION], ["blocked", PROMPT]] as const) {
      scene(agent({ agent_status: status }), screen);
      expect((await move("lane-a", "work")).error).toMatch(/shows a dialog.*question is filed/);
      expect(sentToLane()).toEqual([]);
    }
    const open = (await state()).open.filter((a: any) => a.lane === "lane-a");
    expect(open.map((a: any) => a.title).sort()).toEqual(["lane-a shows a limit/credits dialog", "lane-a shows a permission prompt"]);
    expect(open.find((a: any) => /limit/.test(a.title)).body).toContain("never types into a limit/credits dialog");
    for (const a of open) await api(`/api/asks/${a.id}/answer`, { answer: "Answered in the pane" });

    // Moved, from a lane that hit its limit earlier: the message above an idle prompt is no dialog. /exit, then the
    // lane's own home, the same session and its status line; the lane gets its name back.
    scene(agent({}), PAST_LIMIT);
    for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
    const ok = await move("lane-a", "work");
    expect(ok).toMatchObject({ status: 200, said: "lane-a moved to work" });
    expect(sentToLane()).toEqual([
      "agent prompt lane-a /exit",
      `pane run w1:p1 CLAUDE_CONFIG_DIR='${HOME}/.claude-work' claude --resume 'sess-1' --settings '${DATA}/claude-lane-work.settings.json'`,
      "agent rename w1:p1 lane-a",
    ]);
    expect(existsSync(join(TMP, "unnamed"))).toBe(false);
    expect(JSON.parse(readFileSync(join(DATA, "claude-lane-work.settings.json"), "utf8")).statusLine.command).toContain("claude-statusline.py' 'work'");
    const after = (await state()).accounts[0].claude;
    expect(after.accounts.map((a: any) => [a.name, a.lanes])).toEqual([["default", []], ["fresh", []], ["spare", []], ["work", ["lane-a"]]]);
    // Moving back is the same act.
    scene(agent({}));
    for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
    expect((await move("lane-a", "default")).said).toBe("lane-a moved to default");
    expect(sentToLane()[1]).toBe("pane run w1:p1 env -u CLAUDE_CONFIG_DIR claude --resume 'sess-1' --settings '" + DATA + "/claude-lane-default.settings.json'");
    // The default keychain item and the planted login files were never written: the fake keychain is as it was.
    expect(readFileSync(join(TMP, "keychain"), "utf8")).toBe(`${service(join(HOME, ".claude-work"))}\n`);
    for (const c of readFileSync(join(TMP, "security-calls"), "utf8").trim().split("\n")) expect(c.startsWith("find-generic-password -s ")).toBe(true);

    // A home is made through the panel's route: no login in it, and it shows up not logged in.
    const made = await api("/api/accounts/home", { name: "third" });
    expect(made.said).toContain("CLAUDE_CONFIG_DIR=~/.claude-third claude auth login");
    expect(made.said).toContain("4 MCP servers need their secret set in this home");
    expect(existsSync(join(HOME, ".claude-third/.credentials.json"))).toBe(false);
    expect((await api("/api/accounts/home", { name: "../x" })).error).toBeTruthy();
    expect((await state()).accounts[0].claude.accounts.find((a: any) => a.name === "third").loggedIn).toBe(false);
  } finally {
    await server.stop();
  }
}, 60_000);

test("two moves at once: the second is refused before anything is sent twice", async () => {
  installHerdr();
  scene(agent({}));
  for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
  server = await startServer();
  try {
    await accountsReady();
    const [a, b] = await Promise.all([move("lane-a", "work"), move("lane-a", "work")]);
    expect([a.said, b.said].filter(Boolean)).toEqual(["lane-a moved to work"]);
    expect([a.error, b.error].filter(Boolean)).toEqual([expect.stringMatching(/already being moved/)]);
    expect(sentToLane().filter((c) => c.startsWith("pane run")).length).toBe(1);
    // Back on default for the next test.
    scene(agent({}));
    for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
    expect((await move("lane-a", "default")).said).toBe("lane-a moved to default");
  } finally {
    await server.stop();
  }
}, 60_000);

test("a failure after /exit files one question with the command that brings the lane back, and is never recorded", async () => {
  installHerdr();
  server = await startServer({ HUD_MOVE_EXIT_WAIT_MS: "1200", HUD_MOVE_BACK_WAIT_MS: "1500" });
  const back = `env -u CLAUDE_CONFIG_DIR claude --resume 'sess-1' --settings '${DATA}/claude-lane-default.settings.json'`;
  try {
    await accountsReady();
    // lane-a is on default from the last test's move back.
    const paths: [string, string[], RegExp][] = [
      ["Claude never exits", ["noexit"], /had not exited/],
      ["herdr errors while the exit is awaited", ["getfail"], /pane gone/],
      ["the relaunch command fails", ["runfail"], /pane run failed/],
      ["the relaunch does not bring an agent back", ["noreturn"], /did not come back/],
    ];
    for (const [name, flags, why] of paths) {
      scene(agent({}));
      for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
      flag(...flags);
      const res = await move("lane-a", "work");
      expect(res.error, name).toMatch(why);
      expect(res.error, name).toMatch(/not recorded/);
      const open = (await state()).open.filter((a: any) => a.lane === "lane-a");
      expect(open.map((a: any) => a.title), name).toEqual(["lane-a was exited for a move and is not confirmed back"]);
      expect(open[0].body, name).toContain(back);
      expect((await state()).accounts[0].claude.lanes.map((l: any) => [l.name, l.account]), name).toEqual([["lane-a", "default"]]);
      for (const a of open) await api(`/api/asks/${a.id}/answer`, { answer: "Brought back" });
    }
    // Once the agent is back on the new account the lane is recorded there; a later failure files a question about that step only.
    const after: [string, string[], RegExp][] = [
      ["the agent cannot be renamed", ["renamefail"], /rename failed/],
      ["the agent comes back on another conversation", ["othersession"], /different conversation/],
    ];
    for (const [name, flags, why] of after) {
      scene(agent({}));
      for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
      flag(...flags);
      const res = await move("lane-a", "work");
      expect(res.error, name).toMatch(why);
      expect(res.error, name).toMatch(/recorded on work/);
      const open = (await state()).open.filter((a: any) => a.lane === "lane-a");
      expect(open.map((a: any) => a.title), name).toEqual(["lane-a is on work but a step after the move failed"]);
      expect(open[0].body, name).not.toContain("claude --resume");
      expect((await state()).accounts[0].claude.lanes.map((l: any) => [l.name, l.account]), name).toEqual([["lane-a", "work"]]);
      for (const a of open) await api(`/api/asks/${a.id}/answer`, { answer: "Checked" });
      {
        for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
        scene(agent({}));
        expect((await move("lane-a", "default")).error, name).toBeUndefined();
      }
    }
    // A settings file that cannot be written stops the move before /exit: the lane is not touched.
    scene(agent({}));
    for (const f of FLAGS) rmSync(join(TMP, f), { force: true });
    rmSync(join(DATA, "claude-lane-work.settings.json"), { force: true });
    mkdirSync(join(DATA, "claude-lane-work.settings.json"));
    expect((await move("lane-a", "work")).error).toBeTruthy();
    expect(sentToLane()).toEqual([]);
  } finally {
    await server.stop();
  }
}, 90_000);
