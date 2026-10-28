// Accounts: account-stats.py reads a fake home (grazr's accounts, two Codex homes, credentials planted with fake
// values) and prints names and percentages only; a throwaway server shows what each account has left and runs
// grazr's swap through a fake herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const TMP = mkdtempSync(join(tmpdir(), "hq-office-accounts-"));
const HOME = join(TMP, "home");
const DATA = join(TMP, "data");
const WORK = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const SECRETS = ["FAKE-EMAIL-1@example.invalid", "FAKE-CLAUDE-KEY-1", "FAKE-CODEX-TOKEN-1", "FAKE-CODEX-TOKEN-2", "FAKE-PLAN-1"];
const hour = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
function grazrAccount(id: string, name: string, session: number, weekly: number, weeklyResets = Date.now() + 50 * hour) {
  const window = (group: string, remaining: number, at: number) => ({ kind: "usage", scope: "all", group, remaining, resets_at: iso(at) });
  write(join(HOME, ".local/state/herdr/plugins/wazum.grazr/accounts", `${id}.json`), JSON.stringify({ name, snapshot: [window("session", session, Date.now() + 2 * hour), window("weekly", weekly, weeklyResets)] }));
}

beforeAll(() => {
  mkdirSync(join(HOME, ".config/herdr/plugins/github/wazum.grazr-abc123"), { recursive: true });
  write(join(HOME, ".config/herdr/plugins/config/wazum.grazr/config.env"), 'REMAINING_SESSION=15\nREMAINING_WEEKLY=10\nACCOUNTS="work personal"\nENABLED=1\nDRY_RUN=0\nSECRET_LOOKING=FAKE-CLAUDE-KEY-1\n');
  // work is the login in use, under its session line; personal's week reset after its last reading.
  grazrAccount(WORK, "work", 12, 52);
  grazrAccount(PERSONAL, "personal", 97, 0, Date.now() - hour);
  write(join(HOME, ".local/state/herdr/plugins/wazum.grazr/grazr.log"), "2026-10-25 09:12:00 rotated personal -> work\n");
  write(join(HOME, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: WORK, emailAddress: SECRETS[0] }, primaryApiKey: SECRETS[1] }));
  write(join(HOME, ".claude/settings.json"), JSON.stringify({ statusLine: { type: "command", command: "python3 /x/wazum.grazr/grazr.py statusline" } }));
  // Two Codex homes: the second links to the first one's sessions. ~/.codex-cli is an npm install, not a home.
  write(join(HOME, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: SECRETS[2] } }));
  const limits = { limit_id: "codex", plan_type: SECRETS[4], primary: { used_percent: 92, window_minutes: 10080, resets_at: Math.floor((Date.now() + 30 * hour) / 1000) }, secondary: null };
  write(join(HOME, ".codex/sessions/2026/10/25/rollout-2026-10-25T09-00-00-aaaa.jsonl"), [
    JSON.stringify({ timestamp: iso(Date.now() - 2 * hour), type: "session_meta", payload: { id: "aaaa" } }),
    JSON.stringify({ timestamp: iso(Date.now() - hour), type: "event_msg", payload: { type: "token_count", rate_limits: limits } }),
  ].join("\n") + "\n");
  write(join(HOME, ".codex-spare/auth.json"), JSON.stringify({ tokens: { access_token: SECRETS[3] } }));
  symlinkSync(join(HOME, ".codex/sessions"), join(HOME, ".codex-spare/sessions"));
  write(join(HOME, ".codex-cli/package.json"), "{}");
  // The fake herdr records what it was asked and answers as grazr's swap does.
  write(join(TMP, "bin/herdr"), `#!/bin/sh\necho "$@" >> "${TMP}/herdr-calls"\necho "grazr: now on personal"\n`);
  chmodSync(join(TMP, "bin/herdr"), 0o755);
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function readStats() {
  const proc = Bun.spawnSync(["python3", "-I", join(ROOT, "src/server/account-stats.py")], { env: { HOME, PATH: process.env.PATH } });
  expect(proc.exitCode).toBe(0);
  return proc.stdout.toString();
}

test("the reader prints names and percentages, and no credential, email or account id", () => {
  const out = readStats();
  for (const s of [...SECRETS, WORK, PERSONAL]) expect(out).not.toContain(s);
  const { claude, codex } = JSON.parse(out);
  expect(claude.accounts.map((a: any) => [a.name, a.active])).toEqual([["work", true], ["personal", false]]);
  expect(claude.accounts.find((a: any) => a.name === "work").windows.session.left).toBe(12);
  expect(claude.config).toEqual({ REMAINING_SESSION: "15", REMAINING_WEEKLY: "10", ACCOUNTS: "work personal", ENABLED: "1", DRY_RUN: "0" });
  expect(claude.status_line).toBe(true);
  expect(claude.log).toEqual(["2026-10-25 09:12:00 rotated personal -> work"]);
  expect(codex.map((h: any) => h.name)).toEqual(["codex", "spare"]);
  expect(codex[0].reading.windows).toEqual([{ minutes: 10080, used: 92, resets_at: expect.any(Number) }]);
  // A session log does not say which account wrote it, so the linked home shows no reading of its own.
  expect(codex[1]).toEqual({ name: "spare", logged_in: true, reading: null, shares_sessions_with: ["codex"] });
});

let server: Awaited<ReturnType<typeof spawnServer>>;
async function accounts(): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`${server.base}/api/accounts`)).json();
    if (list[0]?.ok) return list[0];
    await Bun.sleep(100);
  }
  throw new Error("accounts were never read");
}
const swap = (machine: string) => fetch(`${server.base}/api/accounts/swap`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ machine }) });

test("the server shows each account's windows and whether it can still be spent", async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HOME, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(TMP, "bin/herdr") } });
  try {
    const m = await accounts();
    expect(m.claude.state).toBe("rotating");
    expect(m.claude.accounts.map((a: any) => [a.name, a.active, a.session.left, a.weekly.left, a.low, a.out])).toEqual([
      ["work", true, 12, 52, true, false],
      // Its week reset after the last reading, so it reads full, not empty.
      ["personal", false, 97, 100, false, false],
    ]);
    expect(m.claude.low).toBe(true);
    expect(m.claude.canSwap).toBe(true);
    expect(m.codex.map((h: any) => [h.name, h.loggedIn, h.weekly?.left ?? null, h.low])).toEqual([["codex", true, 8, true], ["spare", true, null, false]]);
    const state = await (await fetch(`${server.base}/api/state`)).json();
    expect(state.accounts[0].claude.state).toBe("rotating");
    const page = JSON.stringify(state);
    for (const s of [...SECRETS, WORK, PERSONAL]) expect(page).not.toContain(s);

    // Swap now runs grazr's own swap, then reads the accounts again: work has since hit its limit.
    grazrAccount(WORK, "work", 0, 52);
    const res = await swap("local");
    expect(await res.json()).toEqual({ ok: true, said: "grazr: now on personal" });
    expect(readFileSync(join(TMP, "herdr-calls"), "utf8").split("\n")).toContain("plugin action invoke wazum.grazr.swap");
    const after = await accounts();
    expect([after.claude.out, after.claude.accounts[0].out]).toEqual([true, true]);

    expect((await swap("elsewhere")).status).toBe(400);
  } finally {
    await server.stop();
  }
});
