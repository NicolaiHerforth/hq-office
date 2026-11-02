// A made-up home for SUBS tests: grazr's account files (one active), Claude's own file and a Codex session log, with
// what must never leave a machine in them: emails, account ids, token-shaped strings and transcript text.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const NOW = Date.now();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
export const H = 3600_000, D = 24 * H;

export const IDS = { alpha: "aaaaaaaa-1111-4111-8111-111111111111", bravo: "bbbbbbbb-2222-4222-8222-222222222222", spare: "cccccccc-3333-4333-8333-333333333333" };
export const EMAIL = "owner.person@example.test";
export const TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKE";
export const KEY = "sk-proj-FAKEKEYFAKEKEY";
export const SAID = "a line the agent wrote in its transcript";
export const LEAKS = [EMAIL, TOKEN, KEY, SAID, ...Object.values(IDS)];

// A home with grazr's account files (one active), Claude's own file and a Codex session log.
export function fakeHome(opts: { grazr?: boolean; codex?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "hq-subs-fake-"));
  if (opts.grazr !== false) {
    const dir = join(home, ".local", "state", "herdr", "plugins", "wazum.grazr", "accounts");
    mkdirSync(dir, { recursive: true });
    const account = (name: string, snapshot: object[]) => ({ name, email: EMAIL, oauthAccount: { emailAddress: EMAIL, accessToken: TOKEN }, organization: "Made Up Ltd", snapshot });
    writeFileSync(join(dir, `${IDS.alpha}.json`), JSON.stringify(account("team-alpha", [{ kind: "session", scope: null, group: "session", remaining: 63, resets_at: iso(2 * H) }, { kind: "weekly_all", scope: null, group: "weekly", remaining: 90, resets_at: iso(3 * D) }])));
    writeFileSync(join(dir, `${IDS.bravo}.json`), JSON.stringify(account("side-bravo", [{ kind: "session", scope: null, group: "session", remaining: 0, resets_at: iso(H) }, { kind: "weekly_all", scope: null, group: "weekly", remaining: 64, resets_at: iso(2 * D) }])));
    writeFileSync(join(dir, `${IDS.spare}.json`), JSON.stringify(account(EMAIL, [{ kind: "weekly_all", scope: null, group: "weekly", remaining: 8, resets_at: iso(D) }])));
    writeFileSync(join(dir, ".grazr-tmp"), "{}");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: IDS.alpha, emailAddress: EMAIL }, mcpServers: { x: { env: { API_KEY: KEY } } } }));
  }
  if (opts.codex !== false) {
    const day = join(home, ".codex", "sessions", "2026", "11", "02");
    mkdirSync(day, { recursive: true });
    const limits = (used: number) => ({ limit_id: "codex", primary: { used_percent: used, window_minutes: 10080, resets_at: Math.round((NOW + 4 * D) / 1000) }, secondary: null, plan_type: "pro", credits: { balance: "12.5" } });
    const lines = [
      { timestamp: iso(-20 * 60_000), type: "event_msg", payload: { type: "token_count", rate_limits: limits(3) } },
      { timestamp: iso(-10 * 60_000), type: "response_item", payload: { type: "message", content: [{ text: SAID }] } },
      { timestamp: iso(-5 * 60_000), type: "event_msg", payload: { type: "token_count", info: { note: SAID }, rate_limits: limits(5) } },
    ];
    writeFileSync(join(day, "rollout-made-up.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return home;
}
