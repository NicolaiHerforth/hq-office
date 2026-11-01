// Installing HQ's hook for the HQ QUEUE (bin/hq-queue-hook.ts) into the Claude Code settings of this machine's user
// (~/.claude/settings.json), and removing it: plugin actions install-queue-hook and remove-queue-hook, run only when
// the owner chooses. Each writes a backup first (settings.json.hq-office-<time>.bak), touches nothing but its own three
// entries (UserPromptSubmit, PostToolUse, Stop, each a command that names hq-queue-hook.ts), and is a no-op when they
// are already in place or already gone. The hook acts only in a floor's HQ's own session and only while HQ QUEUE is on.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const EVENTS = ["UserPromptSubmit", "PostToolUse", "Stop"] as const;
export const MARK = "hq-queue-hook.ts";
export const settingsPath = (home: string) => join(home, ".claude", "settings.json");
export const hookCommand = (bun: string, root: string, url: string) => `HUD_URL=${url} ${JSON.stringify(bun)} ${JSON.stringify(join(root, "bin", MARK))}`;

function read(path: string): any {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const v = JSON.parse(text); // an unreadable file is refused, never overwritten
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v;
}
function backup(path: string, now: number) {
  if (!existsSync(path)) return null;
  const to = `${path}.hq-office-${now}.bak`;
  copyFileSync(path, to);
  return to;
}
const ours = (group: any) => Array.isArray(group?.hooks) && group.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(MARK));

export function installed(home: string) {
  try {
    const s = read(settingsPath(home));
    return EVENTS.every((e) => (s.hooks?.[e] ?? []).some(ours));
  } catch {
    return false;
  }
}

export function install(home: string, command: string, now = Date.now()) {
  const path = settingsPath(home);
  const s = read(path);
  if (EVENTS.every((e) => (s.hooks?.[e] ?? []).some(ours))) return { changed: false, path, backup: null };
  const saved = backup(path, now);
  s.hooks = s.hooks && typeof s.hooks === "object" ? s.hooks : {};
  for (const e of EVENTS) {
    const list = Array.isArray(s.hooks[e]) ? s.hooks[e].filter((g: any) => !ours(g)) : [];
    list.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    s.hooks[e] = list;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  return { changed: true, path, backup: saved };
}

// The plugin actions: add or remove, and what to tell the owner.
export function run(add: boolean, home: string, command: string): { ok: boolean; lines: string[] } {
  if (!home) return { ok: false, lines: ["HOME is not set, so there is no ~/.claude/settings.json to change"] };
  try {
    const r = add ? install(home, command) : remove(home);
    if (!r.changed) return { ok: true, lines: [add ? `HQ's queue hook is already in ${r.path}` : `HQ's queue hook is not in ${r.path}; nothing to remove`] };
    return { ok: true, lines: [
      `${add ? "Added" : "Removed"} HQ's queue hook ${add ? "to" : "from"} ${r.path}${r.backup ? ` (backup: ${r.backup})` : ""}.`,
      add ? "It acts only in a floor's HQ's own Claude Code session, and only while HQ QUEUE is on in the HUD's SETTINGS. Restart HQ's session to load it." : "Restart HQ's session to unload it.",
    ] };
  } catch (e) {
    return { ok: false, lines: [`could not ${add ? "add" : "remove"} HQ's queue hook: ${(e as Error).message}`] };
  }
}

export function remove(home: string, now = Date.now()) {
  const path = settingsPath(home);
  const s = read(path);
  if (!EVENTS.some((e) => (s.hooks?.[e] ?? []).some(ours))) return { changed: false, path, backup: null };
  const saved = backup(path, now);
  for (const e of EVENTS) {
    if (!Array.isArray(s.hooks?.[e])) continue;
    s.hooks[e] = s.hooks[e].filter((g: any) => !ours(g));
    if (!s.hooks[e].length) delete s.hooks[e];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  return { changed: true, path, backup: saved };
}
