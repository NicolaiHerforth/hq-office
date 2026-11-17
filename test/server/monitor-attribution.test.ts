// THE MONITOR, who a process belongs to (monitor-attribution.ts): hand-written process tables, never the real one.
import { describe, expect, test } from "bun:test";
import { appOf, attribute, folderLabel, type Ctx } from "../../src/server/monitor-attribution.ts";
import type { Pane, Proc } from "../../src/server/monitor-types.ts";

const UID = 501;
const SELF = 400;
const HOME = "/home/u";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_HELPER = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper";

const proc = (pid: number, ppid: number, name: string, more: Partial<Proc> = {}): Proc => ({ pid, ppid, uid: UID, name, path: `/opt/tools/bin/${name}`, start: 1000, cpuMs: 0, childCpuMs: 0, mem: 0, exact: true, read: 0, written: 0, ...more });
const pane = (id: string, shellPid: number, more: Partial<Pane> = {}): Pane => ({ pane: id, shellPid, lane: null, cwd: null, ...more });
const ctx = (panes: Pane[] = []): Ctx => ({ panes, self: SELF, uid: UID, home: HOME });
const launchd = proc(1, 0, "launchd", { uid: 0, path: "/sbin/launchd" });

describe("under a pane", () => {
  test("a lane's whole tree is the lane's, however deep", () => {
    const procs = [launchd, proc(50, 1, "herdr"), proc(100, 50, "zsh"), proc(101, 100, "claude"), proc(102, 101, "bun"), proc(103, 102, "node"), proc(104, 103, "esbuild")];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "builder", cwd: "/home/u/work/repo" })]));
    for (const pid of [100, 101, 102, 103]) expect(owners.get(pid)).toMatchObject({ kind: "lane", owner: "builder" });
    expect(owners.get(104)).toEqual({ kind: "lane", owner: "builder", name: "esbuild" });
    expect(owners.get(50)).toEqual({ kind: "other", owner: "other", name: "herdr" });
  });

  test("a pane without a named agent is its folder, or its id when the folder is unknown", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(101, 100, "vim"), proc(200, 1, "zsh"), proc(201, 200, "top")];
    const owners = attribute(procs, ctx([pane("p1", 100, { cwd: "/home/u/work/repo" }), pane("p2", 200)]));
    expect(owners.get(101)).toEqual({ kind: "pane", owner: "~/work/repo", name: "vim" });
    expect(owners.get(201)).toEqual({ kind: "pane", owner: "p2", name: "top" });
  });

  test("the nearest pane decides when one runs inside another", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(101, 100, "herdr"), proc(110, 101, "zsh"), proc(111, 110, "bun")];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "outer" }), pane("p2", 110, { lane: "inner" })]));
    expect(owners.get(111)).toMatchObject({ kind: "lane", owner: "inner" });
    expect(owners.get(101)).toMatchObject({ kind: "lane", owner: "outer" });
  });

  test("a browser a lane's test starts is the lane's, named by the app with its helpers", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(101, 100, "bun"), proc(102, 101, "Google Chrome", { path: CHROME }), proc(103, 102, "Google Chrome Helper", { path: CHROME_HELPER })];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "builder" })]));
    expect(owners.get(102)).toEqual({ kind: "lane", owner: "builder", name: "Google Chrome" });
    expect(owners.get(103)).toEqual({ kind: "lane", owner: "builder", name: "Google Chrome" });
  });

  test("a server a lane runs is the lane's, not HQ Office", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(SELF, 100, "bun"), proc(401, SELF, "ps", { path: "/bin/ps" })];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "builder" })]));
    expect(owners.get(SELF)).toEqual({ kind: "lane", owner: "builder", name: "bun" });
    expect(owners.get(401)).toEqual({ kind: "lane", owner: "builder", name: "ps" });
  });
});

describe("outside every pane", () => {
  test("the server and what it starts are HQ Office", () => {
    const procs = [launchd, proc(SELF, 1, "bun"), proc(401, SELF, "ps", { path: "/bin/ps" }), proc(402, 401, "sh", { path: "/bin/sh" }), proc(403, SELF, "Google Chrome", { path: CHROME })];
    const owners = attribute(procs, ctx());
    expect(owners.get(SELF)).toEqual({ kind: "hq", owner: "HQ Office", name: "bun" });
    expect(owners.get(401)).toEqual({ kind: "hq", owner: "HQ Office", name: "ps" });
    expect(owners.get(402)).toEqual({ kind: "hq", owner: "HQ Office", name: "sh" });
    expect(owners.get(403)).toEqual({ kind: "hq", owner: "HQ Office", name: "Google Chrome" });
  });

  test("an app's helper is found by its own bundle path while its parent is launchd", () => {
    const owners = attribute([launchd, proc(300, 1, "Google Chrome Helper", { path: CHROME_HELPER })], ctx());
    expect(owners.get(300)).toEqual({ kind: "app", owner: "Google Chrome", name: "Google Chrome Helper" });
  });

  test("a child outside the bundle is found through its nearest app ancestor", () => {
    const procs = [
      launchd,
      proc(300, 1, "Editor", { path: "/Applications/Editor.app/Contents/MacOS/Editor" }),
      proc(301, 300, "zsh", { path: "/bin/zsh" }),
      proc(302, 301, "node", { path: "/opt/tools/bin/node" }),
      proc(303, 302, "Google Chrome", { path: CHROME }),
      proc(304, 303, "crashpad", { path: null }),
      proc(305, 300, "helperd", { path: "/usr/libexec/helperd" }),
    ];
    const owners = attribute(procs, ctx());
    expect(owners.get(302)).toEqual({ kind: "app", owner: "Editor", name: "node" });
    expect(owners.get(303)).toEqual({ kind: "app", owner: "Google Chrome", name: "Google Chrome" });
    expect(owners.get(304)).toEqual({ kind: "app", owner: "Google Chrome", name: "crashpad" });
    expect(owners.get(305)).toEqual({ kind: "app", owner: "Editor", name: "helperd" });
  });

  test("another user's daemon and a daemon by its path are the system", () => {
    const procs = [
      launchd,
      proc(20, 1, "postgres", { uid: 70, path: "/opt/db/bin/postgres" }),
      proc(21, 1, "cfprefsd", { path: "/usr/sbin/cfprefsd" }),
      proc(22, 1, "Finder", { path: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder" }),
      proc(23, 1, "agent", { path: "/usr/libexec/agent" }),
      proc(24, 1, "updater", { path: "/Library/Apple/System/Library/updater" }),
      proc(25, 1, "mount", { path: "/sbin/mount" }),
    ];
    const owners = attribute(procs, ctx());
    for (const p of procs) expect(owners.get(p.pid)).toEqual({ kind: "system", owner: "system", name: p.name });
  });

  test("the user's own process that fits nothing is other", () => {
    const owners = attribute([launchd, proc(30, 1, "ollama"), proc(31, 1, "git", { path: "/usr/bin/git" }), proc(32, 1, "ghost", { path: null })], ctx());
    for (const [pid, name] of [[30, "ollama"], [31, "git"], [32, "ghost"]] as const) expect(owners.get(pid)).toEqual({ kind: "other", owner: "other", name });
  });
});

describe("what the parent chain does not say", () => {
  const WEBKIT = "/System/Library/Frameworks/WebKit.framework/XPCServices/WebContent.xpc/Contents/MacOS/WebContent";
  const asking = (panes: Pane[], lookup: Partial<Ctx["lookup"] & object>): Ctx => ({ ...ctx(panes), lookup: { launchPane: () => null, cwd: () => null, responsible: () => null, ...lookup } });

  test("a tree a lane started and detached is the lane's, by the pane its root was started from", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(900, 1, "tmux"), proc(901, 900, "node"), proc(902, 901, "Chromium", { path: "/Applications/Chromium.app/Contents/MacOS/Chromium" })];
    const owners = attribute(procs, asking([pane("p1", 100, { lane: "builder" })], { launchPane: (p) => (p.pid === 900 ? "p1" : null) }));
    expect(owners.get(901)).toEqual({ kind: "lane", owner: "builder", name: "node" });
    expect(owners.get(902)).toEqual({ kind: "lane", owner: "builder", name: "Chromium" });
  });

  test("a root that gives no environment is passed over: what it started still carries the pane", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(900, 1, "sh", { path: "/bin/sh" }), proc(901, 900, "bun"), proc(902, 901, "esbuild")];
    const asked: number[] = [];
    const owners = attribute(procs, asking([pane("p1", 100, { lane: "builder" })], { launchPane: (p) => (asked.push(p.pid), p.pid === 901 ? "p1" : null) }));
    expect(owners.get(902)).toEqual({ kind: "lane", owner: "builder", name: "esbuild" });
    expect(owners.get(901)).toEqual({ kind: "lane", owner: "builder", name: "bun" });
    expect(owners.get(900)).toMatchObject({ kind: "other" });
    expect(asked.indexOf(900)).toBeLessThan(asked.indexOf(901));
  });

  test("a pane that is gone, or another user's process, is not taken from it", () => {
    const procs = [launchd, proc(900, 1, "tmux"), proc(950, 1, "daemon", { uid: 0 })];
    const owners = attribute(procs, asking([pane("p1", 100, { lane: "builder" })], { launchPane: (p) => (p.pid === 900 ? "closed" : "p1") }));
    expect(owners.get(900)).toMatchObject({ kind: "other" });
    expect(owners.get(950)).toMatchObject({ kind: "system" });
  });

  test("a system helper counts toward the app it works for", () => {
    const procs = [launchd, proc(30, 1, "Browser", { path: "/Applications/Browser.app/Contents/MacOS/Browser" }), proc(31, 1, "WebContent", { path: WEBKIT }), proc(32, 1, "WebContent", { path: WEBKIT })];
    const owners = attribute(procs, asking([], { responsible: (p) => (p.pid === 31 ? 30 : p.pid) }));
    expect(owners.get(31)).toEqual({ kind: "app", owner: "Browser", name: "WebContent" });
    expect(owners.get(32)).toEqual({ kind: "system", owner: "system", name: "WebContent" });
  });

  test("what fits nothing is grouped by the folder its tree runs in", () => {
    const procs = [launchd, proc(900, 1, "tmux"), proc(901, 900, "node"), proc(910, 1, "agent"), proc(920, 1, "helper")];
    const cwd = (p: Proc) => ({ 900: "/home/u/work/trees/shop/api", 910: "/", 920: HOME })[p.pid] ?? "/somewhere/else";
    const owners = attribute(procs, asking([], { cwd }));
    expect(owners.get(901)).toEqual({ kind: "other", owner: "~/…/shop/api", name: "node" });
    expect(owners.get(910)).toEqual({ kind: "other", owner: "other", name: "agent" });
    expect(owners.get(920)).toEqual({ kind: "other", owner: "other", name: "helper" });
  });
});

describe("the parent chain", () => {
  test("every process gets one owner", () => {
    const procs = [launchd, proc(100, 1, "zsh"), proc(101, 100, "bun"), proc(30, 1, "ollama")];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "builder" })]));
    expect([...owners.keys()].sort((a, b) => a - b)).toEqual([1, 30, 100, 101]);
  });

  test("a cycle of parents ends", () => {
    const owners = attribute([proc(10, 11, "a"), proc(11, 10, "b"), proc(12, 12, "c")], ctx());
    expect(owners.get(10)).toEqual({ kind: "other", owner: "other", name: "a" });
    expect(owners.get(11)).toEqual({ kind: "other", owner: "other", name: "b" });
    expect(owners.get(12)).toEqual({ kind: "other", owner: "other", name: "c" });
  });

  test("a parent that is gone ends it, and launchd says nothing about its children", () => {
    const hosted = { ...launchd, path: "/Applications/Odd.app/Contents/MacOS/launchd" };
    const owners = attribute([hosted, proc(30, 1, "ollama"), proc(31, 999, "orphan")], ctx([pane("p1", 1, { lane: "init" })]));
    expect(owners.get(30)).toEqual({ kind: "other", owner: "other", name: "ollama" });
    expect(owners.get(31)).toEqual({ kind: "other", owner: "other", name: "orphan" });
  });

  test("a table of 900 processes in one deep chain is attributed", () => {
    const procs = [launchd, proc(100, 1, "zsh"), ...Array.from({ length: 900 }, (_, i) => proc(101 + i, 100 + i, "worker"))];
    const owners = attribute(procs, ctx([pane("p1", 100, { lane: "builder" })]));
    expect(owners.size).toBe(902);
    expect(owners.get(150)).toMatchObject({ kind: "lane", owner: "builder" });
    // Deeper than the walk goes: the pane is out of reach, so it is nobody's.
    expect(owners.get(1000)).toMatchObject({ kind: "other" });
  });
});

describe("appOf", () => {
  test.each([
    [CHROME, "Google Chrome"],
    [CHROME_HELPER, "Google Chrome"],
    ["/home/u/Applications/My Tool.app/Contents/MacOS/tool", "My Tool"],
    ["/Applications/Utilities/Disk.app/Contents/MacOS/Disk", "Disk"],
    ["/System/Applications/Notes.app/Contents/MacOS/Notes", "Notes"],
    ["/System/Volumes/Preboot/Cryptexes/App/System/Applications/Browser.app/Contents/MacOS/Browser", "Browser"],
    ["/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", null],
    ["/usr/libexec/Thing.app/Contents/MacOS/Thing", null],
    ["/Library/Apple/System/Library/CoreServices/Up.app/Contents/MacOS/Up", null],
    ["/opt/tools/bin/node", null],
    ["/opt/apps/.app/bin/x", null],
    ["/opt/happy/bin/snapp", null],
    [null, null],
  ])("%p is %p", (path, app) => {
    expect(appOf(path)).toBe(app);
  });
});

describe("folderLabel", () => {
  test.each([
    ["/home/u", "~"],
    ["/home/u/", "~"],
    ["/home/u/a", "~/a"],
    ["/home/u/a/b/c", "~/a/b/c"],
    ["/home/u/a/b/c/d", "~/…/c/d"],
    ["/home/u/a/b/c/d/e", "~/…/d/e"],
    ["/home/user2/a", "…/user2/a"],
    ["/opt/tools", "/opt/tools"],
    ["/srv/www/shop/releases/42", "…/releases/42"],
    ["/private/tmp/run-8f3a/work", "a temp folder"],
    ["/var/folders/fw/abc/T/x", "a temp folder"],
    ["/tmp", "a temp folder"],
    ["/", "/"],
    [null, null],
  ])("%p is %p", (cwd, label) => {
    expect(folderLabel(cwd, HOME)).toBe(label);
  });
});
