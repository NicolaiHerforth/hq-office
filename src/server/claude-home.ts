// A Claude home is one account: ~/.claude is "default", ~/.claude-<name> the rest. This file makes a home, seeds its
// .claude.json, builds the command that starts a lane on it, and spots a dialog on a lane's screen. It reads and
// writes no login: a new home links everything except the login files, and its .claude.json is seeded from an
// allow-list of keys that are not identity.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT = "default";
export const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
// HOME as the environment says, as account-stats.py reads it (os.homedir() would not follow a changed HOME).
const home = () => process.env.HOME || homedir();
export const homeDir = (account: string) => (account === DEFAULT ? join(home(), ".claude") : join(home(), `.claude-${account}`));

// Files of the default home that are a login (or a copy of one): a new home never links them.
const LOGIN_FILE = /^(\.credentials[^/]*|\.claude\.json.*)$/;
// Folders that hold a copy of the default account's identity (backups of .claude.json): each home keeps its own.
const NOT_SHARED = new Set([".DS_Store", "backups"]);
// Beside .claude.json in a new home: the names (only) of the MCP servers whose env, headers, args or url were left out.
export const MCP_NOTE = ".hq-office-mcp-needs-secret.json";

// The keys of ~/.claude.json a new home starts with: MCP servers, trust and onboarding. An allow-list, so a key
// Claude adds later is not copied until someone reads its name and adds it here. Identity (oauthAccount, userID,
// anything about accounts, tokens or keys) is never on it.
export const SEED_KEYS = ["mcpServers", "projects", "hasCompletedOnboarding", "lastOnboardingVersion", "theme", "shiftEnterKeyBindingInstalled", "hasCompletedClaudeInChromeOnboarding"];
// Of each project's entry only its trust and tool approvals cross (not its last session, cost or timings).
export const PROJECT_KEYS = ["allowedTools", "disabledMcpServers", "disabledMcpjsonServers", "enabledMcpjsonServers", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown", "hasTrustDialogAccepted", "mcpContextUris"];

const pick = (from: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in from).map((k) => [k, from[k]]));

// A secret is never duplicated into another home: an MCP server's env, headers, args and url (a token can sit in any of
// them) stay in the home they were set in.
const MCP_SECRET_KEYS = ["env", "headers", "args", "url"];
export function mcpNeedingSecret(source: Record<string, any>): string[] {
  return Object.entries(source.mcpServers ?? {}).filter(([, server]: [string, any]) => server && MCP_SECRET_KEYS.some((k) => k in server)).map(([name]) => name).sort();
}

export function seedFor(source: Record<string, any>): Record<string, unknown> {
  const out = pick(source, SEED_KEYS) as Record<string, any>;
  if (out.mcpServers && typeof out.mcpServers === "object") {
    // A server that had any of those keys is left out whole: without its args or url it would start broken.
    const needing = new Set(mcpNeedingSecret(source));
    out.mcpServers = Object.fromEntries(Object.entries(out.mcpServers as Record<string, any>).filter(([name]) => !needing.has(name)));
  }
  if (out.projects && typeof out.projects === "object") {
    out.projects = Object.fromEntries(Object.entries(out.projects as Record<string, any>).map(([path, entry]) => [path, pick(entry ?? {}, PROJECT_KEYS)]));
  }
  return out;
}

// Make a home: links to everything in the default home except the login files and the config backups, and a seeded
// .claude.json. Undo: delete the folder. Returns the folder and the MCP servers that need their secret set in it.
export function makeHome(account: string): { dir: string; mcpNeedsSecret: string[] } {
  if (!NAME.test(account) || account === DEFAULT) throw new Error("a home's name is lowercase letters, digits and dashes");
  const target = homeDir(account);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const source = homeDir(DEFAULT);
  // Read before anything is made: a half-written file (Claude rewriting it) must not give a home with no trust.
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(join(home(), ".claude.json"), "utf8"));
  } catch (e) {
    throw new Error(`could not read ${join(home(), ".claude.json")} (${(e as Error).message}). No home was made; try again`);
  }
  mkdirSync(target, { mode: 0o700 });
  for (const entry of readdirSync(source)) {
    if (LOGIN_FILE.test(entry) || NOT_SHARED.has(entry)) continue;
    symlinkSync(join(source, entry), join(target, entry));
  }
  writeFileSync(join(target, ".claude.json"), JSON.stringify(seedFor(config), null, 2), { mode: 0o600 });
  const mcpNeedsSecret = mcpNeedingSecret(config);
  if (mcpNeedsSecret.length) writeFileSync(join(target, MCP_NOTE), JSON.stringify(mcpNeedsSecret), { mode: 0o600 });
  return { dir: target, mcpNeedsSecret };
}

export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function relaunchCommand(account: string, session: string, settings: string): string {
  const env = account === DEFAULT ? "env -u CLAUDE_CONFIG_DIR" : `CLAUDE_CONFIG_DIR=${quote(homeDir(account))}`;
  return `${env} claude --resume ${quote(session)} --settings ${quote(settings)}`;
}

// A dialog is the owner's alone: nothing is typed into it. The signal is the pane's visible text, since herdr's status
// calls these panes idle or blocked without saying which dialog. A dialog is a choice menu at the bottom of the
// screen; a limit message left in the scrollback above an idle prompt is not one (a lane that hit its limit is the
// main case for a move). Wording is the one Claude Code 2.1.310 ships.
const MENU = /Enter to (?:confirm|select)|Esc to cancel|^\s*[❯›>]\s*\d+\.\s/m;
const LIMIT = [
  /you(?:'|’)ve hit your .{0,40}(?:limit|budget)/i,
  /(?:usage|budget|\w+) limit reached/i,
  /shared budget/i,
  /stop and wait for limit to reset/i,
  /add funds to continue with/i,
  /upgrade your plan/i,
  /extra[- ]usage/i,
  /usage[- ]credits/i,
];
const lastLines = (screen: string, n: number) => screen.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

// "limit": a limit, budget or credits menu. "prompt": any other choice menu (a permission prompt). null: no menu.
export function dialogKind(screen: string): "limit" | "prompt" | null {
  if (!MENU.test(lastLines(screen, 12))) return null;
  return LIMIT.some((p) => p.test(lastLines(screen, 25))) ? "limit" : "prompt";
}
