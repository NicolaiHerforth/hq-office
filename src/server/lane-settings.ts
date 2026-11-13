// THE LANE SETTINGS FILE: the Claude Code settings every lane is started with
// (herdr agent start NAME --kind claude --pane P -- --settings "$(hud lane-settings)"). It wires the lane hook
// (bin/lane-hook.ts) to the events that stop an unattended lane, and refuses pages on claude.ai outright (a lane gets
// a page as a file; the Artifact tool stays, so a lane can still publish). Nothing goes into ~/.claude/settings.json
// or any other shared file: a session gets this only when it is started with it.
//
// The file lives in the HUD's data folder, at a path that never changes, and so does the hook it runs: a copy of
// bin/lane-hook.ts beside it. A session reads its settings once, at its start, so a lane that is already running
// keeps the hook path it was given; a plugin update that moves the code must not leave that path empty, or the
// lane's next prompt would show with nobody to answer it. The server writes both at every start and whenever hud
// lane-settings finds one missing or different (lane-permits.ts). Nothing here reads the server's configuration:
// what the file says is what it is given.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// bun: the Bun that runs the hook; if it is gone when a hook runs (a Bun that was upgraded away), the one on PATH is
// used. hook: the hook script. url: the HUD. marker: a file that is there while an "allow this once" waits to be
// used: the PreToolUse command tests for it before anything else, so a tool call costs a lane one file test, not a
// process, while nothing is allowed.
export function laneSettings(o: { bun: string; hook: string; url: string; marker: string }) {
  const hook = (event: string) => `B=${sh(o.bun)}; [ -x "$B" ] || B=bun; HUD_URL=${sh(o.url)} "$B" ${sh(o.hook)} ${event}`;
  const run = (command: string, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 10 }] }];
  return {
    // The hook acts only where this is set: in a session started with this file.
    env: { HUD_LANE_HOOK: "1" },
    hooks: {
      PermissionRequest: run(hook("PermissionRequest")),
      PermissionDenied: run(hook("PermissionDenied")),
      Notification: run(hook("Notification"), "permission_prompt"),
      PreToolUse: run(`[ ! -e ${sh(o.marker)} ] || { ${hook("PreToolUse")}; }`),
    },
    permissions: { deny: ["WebFetch(domain:claude.ai)"] },
  };
}

// Writes the settings file if it is missing or says something else, and returns its path.
export const writeLaneSettings = (path: string, settings: object) => writeIfChanged(path, JSON.stringify(settings, null, 2) + "\n");
// The hook's copy in the data folder: the script as it is now, written if the copy is missing or older.
export const copyLaneHook = (from: string, to: string) => writeIfChanged(to, readFileSync(from, "utf8"));

function writeIfChanged(path: string, text: string) {
  let was: string | null = null;
  try {
    if (existsSync(path)) was = readFileSync(path, "utf8");
  } catch {}
  if (was !== text) {
    mkdirSync(dirname(path), { recursive: true });
    // Whole or not at all: a lane starting, or a hook running, right now never reads half a file.
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  }
  return path;
}
