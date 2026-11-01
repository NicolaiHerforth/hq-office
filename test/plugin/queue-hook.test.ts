// Adding and removing HQ's queue hook in a fake home's ~/.claude/settings.json: the user's other settings and hooks
// stay as they were, a backup is written before each change, a second run changes nothing, and an unreadable file is
// refused rather than overwritten. Never the real home.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS, MARK, hookCommand, install, installed, remove, settingsPath } from "../../bin/queue-hook.ts";

const ROOT = join(import.meta.dir, "..", "..");
const base = mkdtempSync(join(tmpdir(), "hq-queue-hook-"));
let home = "";
let n = 0;
beforeEach(() => {
  home = join(base, `home${n++}`);
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
const settings = () => JSON.parse(readFileSync(settingsPath(home), "utf8"));
const backups = () => readdirSync(join(home, ".claude")).filter((f) => f.endsWith(".bak"));
const CMD = hookCommand("/usr/local/bin/bun", "/opt/hq-office", "http://127.0.0.1:4747");

test("added beside the user's own settings and hooks, with a backup; a second run changes nothing", () => {
  const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] } };
  writeFileSync(settingsPath(home), JSON.stringify(mine));
  const r = install(home, CMD, 111);
  expect(r).toMatchObject({ changed: true, backup: `${settingsPath(home)}.hq-office-111.bak` });
  expect(JSON.parse(readFileSync(r.backup!, "utf8"))).toEqual(mine);
  const s = settings();
  expect(s.model).toBe("opus");
  expect(s.hooks.PreToolUse).toEqual(mine.hooks.PreToolUse);
  expect(s.hooks.Stop[0]).toEqual(mine.hooks.Stop[0]);
  for (const e of EVENTS) expect(s.hooks[e].at(-1)).toEqual({ hooks: [{ type: "command", command: CMD, timeout: 5 }] });
  expect(CMD).toContain(MARK);
  expect(installed(home)).toBe(true);
  expect(install(home, CMD, 222).changed).toBe(false);
  expect(backups()).toEqual(["settings.json.hq-office-111.bak"]);
});

test("removed, leaving exactly what was there before", () => {
  const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, theme: "dark" };
  writeFileSync(settingsPath(home), JSON.stringify(mine));
  install(home, CMD, 1);
  const r = remove(home, 2);
  expect(r.changed).toBe(true);
  expect(settings()).toEqual(mine);
  expect(installed(home)).toBe(false);
  expect(remove(home, 3).changed).toBe(false);
});

test("with no settings file it makes one; removing drops the empty hooks", () => {
  rmSync(join(home, ".claude"), { recursive: true });
  expect(install(home, CMD, 5)).toMatchObject({ changed: true, backup: null });
  expect(Object.keys(settings().hooks).sort()).toEqual([...EVENTS].sort());
  remove(home, 6);
  expect(settings()).toEqual({});
});

test("an unreadable settings file is refused and left untouched", () => {
  writeFileSync(settingsPath(home), "{ not json");
  expect(() => install(home, CMD)).toThrow();
  expect(readFileSync(settingsPath(home), "utf8")).toBe("{ not json");
  expect(backups()).toEqual([]);
});

test("the plugin actions do it for this plugin and port, and say where the backup is", () => {
  const state = join(home, "state"), config = join(home, "config");
  mkdirSync(state, { recursive: true });
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.env"), "HUD_PORT=4799\n");
  writeFileSync(settingsPath(home), JSON.stringify({ model: "opus" }));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: config, HQ_OFFICE_PLATFORM: "none", HQ_OFFICE_LAUNCHCTL: "/nonexistent/launchctl", HQ_OFFICE_SYSTEMCTL: "/nonexistent/systemctl", HQ_OFFICE_OPENER: "true" };
  const run = (a: string) => Bun.spawnSync([process.execPath, "bin/hud-plugin.ts", a], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const add = run("install-queue-hook");
  expect(add.exitCode).toBe(0);
  expect(add.stdout.toString()).toContain("backup:");
  const cmd = settings().hooks.UserPromptSubmit[0].hooks[0].command;
  expect(cmd).toContain("HUD_URL=http://127.0.0.1:4799");
  expect(cmd).toContain(join(ROOT, "bin", MARK));
  expect(settings().model).toBe("opus");
  expect(run("remove-queue-hook").exitCode).toBe(0);
  expect(settings()).toEqual({ model: "opus" });
  expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
});
