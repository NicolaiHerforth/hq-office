// Service mode of the herdr plugin, on macOS (launchd) and Linux (systemd), against fakes: a fake home directory and
// test/fake-service.ts as launchctl and systemctl. The fakes run what the plist or unit says, so each test also sees
// the server the service would run: its port, its data directory and its config. The real launchctl and systemctl
// are never run, and nothing is written outside a temporary directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FAKE = join(ROOT, "test", "fake-service.ts");

function setup(platform: "darwin" | "linux") {
  const dir = mkdtempSync(join(tmpdir(), `hq-office-service-${platform}-`));
  const t = {
    dir,
    platform,
    home: join(dir, "home"),
    state: join(dir, "state"),
    config: join(dir, "config"),
    fake: join(dir, "fake"),
    port: freePort(),
    get base() { return `http://127.0.0.1:${this.port}`; },
  };
  for (const d of [t.home, t.state, t.config, t.fake]) mkdirSync(d, { recursive: true });
  for (const tool of ["launchctl", "systemctl"]) {
    writeFileSync(join(t.fake, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`);
    chmodSync(join(t.fake, tool), 0o755);
  }
  return t;
}
type T = ReturnType<typeof setup>;

// The resource monitor is off in these servers, as a config.env can have it, unless a test leaves that line out to
// see what the plugin does by itself. No server here ever walks the disk.
function writeConfig(t: T, owner: string, monitor: string[] = ["HUD_MONITOR=0"]) {
  writeFileSync(join(t.config, "config.env"), [`HUD_PORT=${t.port}`, "HUD_HOST=127.0.0.1", `HUD_OWNER=${owner}`, `HERDR_BIN=${join(t.dir, "no-such-herdr")}`, "HUD_MACHINES=local", "HUD_HQ_AGENT=hq", "HUD_MONITOR_DISK=0", ...monitor, ""].join("\n"));
}

// Runs the plugin as herdr would, with a made-up environment: nothing from this machine's but PATH.
function plugin(t: T, command: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: t.home,
    TMPDIR: tmpdir(),
    HERDR_PLUGIN_STATE_DIR: t.state,
    HERDR_PLUGIN_CONFIG_DIR: t.config,
    HQ_OFFICE_PLATFORM: t.platform,
    HQ_OFFICE_LAUNCHCTL: join(t.fake, "launchctl"),
    HQ_OFFICE_SYSTEMCTL: join(t.fake, "systemctl"),
    HQ_OFFICE_OPENER: "true",
    FAKE_SERVICE_DIR: t.fake,
    ...extraEnv,
  };
  const p = Bun.spawnSync([process.execPath, "bin/hud-plugin.ts", command, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const calls = (t: T): string[][] => {
  const f = join(t.fake, "calls.log");
  const out = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(f, { force: true });
  return out;
};
const verbs = (list: string[][]) => list.map((c) => c.slice(1).filter((a) => a !== "--user").slice(0, c[0] === "launchctl" ? 1 : 3).join(" ")).filter((v) => !/^(print|show)/.test(v));
const up = async (t: T) => {
  try {
    return (await fetch(`${t.base}/api/state`)).ok;
  } catch {
    return false;
  }
};
const owner = async (t: T) => (await (await fetch(`${t.base}/api/state`)).json()).config.owner;
// Whether the server's resource monitor is on. It runs on macOS only, whatever it is asked.
const monitors = async (t: T) => (await (await fetch(`${t.base}/api/monitor/now`)).json()).on;
const CAN_MONITOR = process.platform === "darwin";

function cleanup(t: T) {
  plugin(t, "remove-service");
  const f = join(t.fake, "state.json");
  if (existsSync(f)) for (const job of Object.values(JSON.parse(readFileSync(f, "utf8"))) as { pid: number | null }[]) try { if (job.pid) process.kill(job.pid, "SIGKILL"); } catch {}
  rmSync(t.dir, { recursive: true, force: true });
}

describe("macOS: a LaunchAgent", () => {
  const t = setup("darwin");
  const label = "dev.hq-office.server";
  const plist = join(t.home, "Library", "LaunchAgents", `${label}.plist`);
  const uid = process.getuid!();
  beforeAll(() => writeConfig(t, "Tester"));
  afterAll(() => cleanup(t));

  test("status says the service is not installed", () => {
    const r = plugin(t, "status");
    expect(r.out).toContain("Service:  not installed");
  });

  test("install service writes the agent, bootstraps it, and the server answers", async () => {
    const r = plugin(t, "install-service");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Installed the HQ Office service ${label} (launchd)`);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(`<key>Label</key>\n    <string>${label}</string>`);
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toContain(`<string>${join(ROOT, "server.ts")}</string>`);
    expect(text).toContain(`<key>HUD_DATA_DIR</key>\n      <string>${t.state}</string>`);
    expect(text).toContain(`<key>HUD_PORT</key>\n      <string>${t.port}</string>`);
    expect(text).toContain(`<key>HUD_OWNER</key>\n      <string>Tester</string>`);
    expect(text).toContain(`<key>HUD_MONITOR</key>\n      <string>0</string>`);
    expect(text).toContain(`<key>StandardOutPath</key>\n    <string>${join(t.state, "server.log")}</string>`);
    const path = text.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)![1].split(":");
    for (const d of [join(t.home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) expect(path).toContain(d);
    const bun = text.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)![1];
    expect(bun.split("/").pop()).toBe("bun");
    if (existsSync("/usr/bin/plutil")) expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", plist]).exitCode).toBe(0);
    expect(calls(t).filter((c) => c[1] === "bootstrap")).toEqual([["launchctl", "bootstrap", `gui/${uid}`, plist]]);
    expect(await up(t)).toBe(true);
    expect(await owner(t)).toBe("Tester");
    expect(existsSync(join(t.state, "hud.db"))).toBe(true);
  });

  test("status shows the service installed and running", () => {
    const r = plugin(t, "status");
    expect(r.out).toContain("HQ Office is up");
    expect(r.out).toMatch(new RegExp(`Service:  installed, running \\(pid \\d+\\): ${label} \\(launchd\\)`));
  });

  test("installing again after a config change rewrites the agent and restarts it", async () => {
    writeConfig(t, "Second");
    const r = plugin(t, "install-service");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updated the HQ Office service");
    expect(readFileSync(plist, "utf8")).toContain("<string>Second</string>");
    expect(verbs(calls(t))).toEqual(["bootout", "bootstrap"]);
    expect(await owner(t)).toBe("Second");
    expect(await monitors(t)).toBe(false);
  });

  test("a config that does not mention the resource monitor gets a service with it on", async () => {
    writeConfig(t, "Second", []);
    expect(plugin(t, "install-service").code).toBe(0);
    expect(readFileSync(plist, "utf8")).toContain(`<key>HUD_MONITOR</key>\n      <string>1</string>`);
    expect(await monitors(t)).toBe(CAN_MONITOR);
    calls(t);
  });

  test("restart (reload) writes the agent again with the current config", async () => {
    writeConfig(t, "Third");
    expect(plugin(t, "reload").code).toBe(0);
    expect(verbs(calls(t))).toEqual(["bootout", "bootstrap"]);
    expect(await owner(t)).toBe("Third");
  });

  test("restart pointed at another data folder is refused and changes nothing; --force moves it", async () => {
    const other = join(t.dir, "other-state");
    const before = readFileSync(plist, "utf8");
    const r = plugin(t, "reload", { HERDR_PLUGIN_STATE_DIR: other });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`uses the data in ${t.state}`);
    expect(r.out).toContain("herdr plugin action invoke hq-office.reload");
    expect(readFileSync(plist, "utf8")).toBe(before);
    expect(verbs(calls(t)).filter((v) => v !== "print")).toEqual([]);
    expect(await owner(t)).toBe("Third");
    const forced = plugin(t, "reload", { HERDR_PLUGIN_STATE_DIR: other }, ["--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(plist, "utf8")).toContain(`<string>${other}</string>`);
    // back where the rest of this suite expects it, with the fake's call log drained
    expect(plugin(t, "reload", {}, ["--force"]).code).toBe(0);
    calls(t);
  });

  test("stop boots it out and leaves the agent; start brings it back", async () => {
    let r = plugin(t, "stop");
    expect(r.code).toBe(0);
    expect(verbs(calls(t))).toEqual(["bootout"]);
    expect(existsSync(plist)).toBe(true);
    expect(await up(t)).toBe(false);
    expect(plugin(t, "status").out).toContain("Service:  installed, stopped");
    r = plugin(t, "start");
    expect(r.code).toBe(0);
    expect(verbs(calls(t))).toEqual(["bootstrap"]);
    expect(await up(t)).toBe(true);
  });

  test("start when the agent is loaded but not running kickstarts it", async () => {
    const state = JSON.parse(readFileSync(join(t.fake, "state.json"), "utf8"));
    process.kill(state[label].pid, "SIGKILL");
    for (let i = 0; i < 50 && (await up(t)); i++) await Bun.sleep(50);
    const r = plugin(t, "start");
    expect(r.code).toBe(0);
    expect(verbs(calls(t))).toEqual(["kickstart"]);
    expect(await up(t)).toBe(true);
  });

  test("remove service boots it out and deletes the agent, and keeps the data", async () => {
    const r = plugin(t, "remove-service");
    expect(r.code).toBe(0);
    expect(verbs(calls(t))).toEqual(["bootout"]);
    expect(existsSync(plist)).toBe(false);
    expect(await up(t)).toBe(false);
    expect(existsSync(join(t.state, "hud.db"))).toBe(true);
    expect(plugin(t, "remove-service").out).toContain("not installed");
  });

  test("install refuses while something else answers on the port", async () => {
    // In its own process: this one waits on the plugin and could not answer.
    const other = Bun.spawn([process.execPath, "-e", `Bun.serve({ port: ${t.port}, hostname: "127.0.0.1", fetch: () => Response.json({ lanes: [] }) })`], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !(await up(t)); i++) await Bun.sleep(50);
    try {
      const r = plugin(t, "install-service");
      expect(r.code).toBe(1);
      expect(r.out).toContain("something else is answering");
      expect(existsSync(plist)).toBe(false);
      expect(verbs(calls(t))).toEqual([]);
    } finally {
      other.kill();
      await other.exited;
    }
  });
});

describe("Linux: a systemd user unit", () => {
  const t = setup("linux");
  const unitFile = join(t.home, ".config", "systemd", "user", "hq-office.service");
  beforeAll(() => writeConfig(t, "Tester"));
  afterAll(() => cleanup(t));

  test("install service writes the unit, enables and starts it, and the server answers", async () => {
    const r = plugin(t, "install-service");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed the HQ Office service hq-office.service (systemd)");
    expect(r.out).toContain("loginctl enable-linger");
    const text = readFileSync(unitFile, "utf8");
    expect(text).toContain("Restart=always");
    expect(text).toContain("WantedBy=default.target");
    expect(text).toContain(`ExecStart="`);
    expect(text).toContain(` "${join(ROOT, "server.ts")}"`);
    expect(text).toContain(`Environment="HUD_DATA_DIR=${t.state}"`);
    expect(text).toContain(`Environment="HUD_OWNER=Tester"`);
    expect(text).toContain(`Environment="HUD_MONITOR=0"`);
    expect(text).toMatch(/^Environment="PATH=[^"]*\/opt\/homebrew\/bin[^"]*"$/m);
    expect(text).toContain(`StandardOutput=append:${join(t.state, "server.log")}`);
    const all = calls(t);
    expect(all.every((c) => c[0] === "systemctl" && c[1] === "--user")).toBe(true);
    expect(verbs(all)).toEqual(["daemon-reload", "enable --now hq-office.service"]);
    expect(await up(t)).toBe(true);
    expect(await owner(t)).toBe("Tester");
    expect(plugin(t, "status").out).toMatch(/Service:  installed, running \(pid \d+\): hq-office\.service \(systemd\)/);
  });

  test("installing again reloads, enables and restarts it with the new config", async () => {
    writeConfig(t, "Second", []);
    expect(plugin(t, "install-service").code).toBe(0);
    expect(verbs(calls(t))).toEqual(["daemon-reload", "enable hq-office.service", "restart hq-office.service"]);
    expect(await owner(t)).toBe("Second");
    // A config that does not mention the resource monitor gets a unit with it on.
    expect(readFileSync(unitFile, "utf8")).toContain(`Environment="HUD_MONITOR=1"`);
    expect(await monitors(t)).toBe(CAN_MONITOR);
    writeConfig(t, "Second");
    expect(plugin(t, "install-service").code).toBe(0);
    expect(await monitors(t)).toBe(false);
    calls(t);
  });

  test("stop and start use systemctl --user", async () => {
    expect(plugin(t, "stop").code).toBe(0);
    expect(verbs(calls(t))).toEqual(["stop hq-office.service"]);
    expect(await up(t)).toBe(false);
    expect(plugin(t, "start").code).toBe(0);
    expect(verbs(calls(t))).toEqual(["start hq-office.service"]);
    expect(await up(t)).toBe(true);
  });

  test("remove service disables it, deletes the unit and keeps the data", async () => {
    expect(plugin(t, "remove-service").code).toBe(0);
    expect(verbs(calls(t))).toEqual(["disable --now hq-office.service", "daemon-reload"]);
    expect(existsSync(unitFile)).toBe(false);
    expect(await up(t)).toBe(false);
    expect(existsSync(join(t.state, "hud.db"))).toBe(true);
  });
});

describe("without a service", () => {
  const t = setup("darwin");
  beforeAll(() => writeConfig(t, "Tester"));
  afterAll(() => cleanup(t));

  test("start and stop run the server as a plain process, and touch no service manager", async () => {
    expect(plugin(t, "start").code).toBe(0);
    expect(await up(t)).toBe(true);
    expect(existsSync(join(t.state, "hud.pid"))).toBe(true);
    expect(plugin(t, "stop").out).toContain("Stopped HQ Office (pid");
    expect(await up(t)).toBe(false);
    expect(verbs(calls(t))).toEqual([]);
  });

  test("the server the plugin starts has the resource monitor on, unless config.env turns it off", async () => {
    writeConfig(t, "Tester", []);
    expect(plugin(t, "start").code).toBe(0);
    expect(await monitors(t)).toBe(CAN_MONITOR);
    expect(plugin(t, "stop").code).toBe(0);
    writeConfig(t, "Tester");
    expect(plugin(t, "start").code).toBe(0);
    expect(await monitors(t)).toBe(false);
    expect(plugin(t, "stop").code).toBe(0);
    calls(t);
  });

  test("install service takes over from a server the plugin started", async () => {
    expect(plugin(t, "start").code).toBe(0);
    expect(plugin(t, "install-service").code).toBe(0);
    expect(existsSync(join(t.state, "hud.pid"))).toBe(false);
    expect(await up(t)).toBe(true);
    expect(verbs(calls(t))).toEqual(["bootstrap"]);
  });
});
