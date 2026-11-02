// SUBS: the reader (src/server/sub-usage.sh) on a made-up home (test/fake-subs.ts), the merge (sub-usage-merge.ts),
// and a throwaway server reading that home. Account names are made up; nothing here reads the owner's real accounts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { list, merge, sources, type MachineUsage } from "../../src/server/sub-usage-merge.ts";
import { D, EMAIL, H, IDS, KEY, LEAKS, NOW, SAID, TOKEN, fakeHome } from "../fake-subs.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "src", "server", "sub-usage.sh");

async function read(home: string, path = process.env.PATH) {
  const proc = Bun.spawn(["/bin/sh", SCRIPT], { env: { HOME: home, PATH: path }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code, said: JSON.parse(out) };
}

const homes: string[] = [];
const home = (opts?: Parameters<typeof fakeHome>[0]) => {
  const h = fakeHome(opts);
  homes.push(h);
  return h;
};
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("the reader", () => {
  test("reads each Claude account's windows from grazr and Codex's last reading, and nothing else", async () => {
    const { out, err, code, said } = await read(home());
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const leak of [EMAIL, TOKEN, KEY, SAID, "Made Up Ltd", "12.5"]) expect(out).not.toContain(leak);
    expect(out).not.toMatch(/@|sk-/);
    expect(out.trim().split("\n")).toHaveLength(1);
    const byName = Object.fromEntries(said.claude.map((a: any) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(["owner.person", "side-bravo", "team-alpha"]);
    expect(byName["team-alpha"].active).toBe(true);
    expect(byName["side-bravo"].active).toBe(false);
    expect(byName["team-alpha"].windows).toEqual([{ w: "5h", left: 63, resets: expect.any(Number) }, { w: "week", left: 90, resets: expect.any(Number) }]);
    expect(Math.abs(byName["team-alpha"].windows[0].resets - (NOW + 2 * H))).toBeLessThan(1000);
    expect(Math.abs(byName["team-alpha"].windows[1].resets - (NOW + 3 * D))).toBeLessThan(1000);
    expect(said.codex).toEqual([{ key: "codex", name: "CODEX", plan: "pro", at: expect.any(Number), windows: [{ w: "week", left: 95, resets: expect.any(Number) }] }]);
    expect(Math.abs(said.codex[0].at - (NOW - 5 * 60_000))).toBeLessThan(1000);
  });

  test("a machine without grazr or Codex has no source for it, quietly", async () => {
    const none = await read(home({ grazr: false, codex: false }));
    expect(none.code).toBe(0);
    expect(none.err).toBe("");
    expect(none.said).toEqual({ v: 1, python: true, claude: null, codex: null });
    expect((await read(home({ codex: false }))).said.codex).toBeNull();
    expect((await read(home({ grazr: false }))).said.claude).toBeNull();
  });

  test("a machine without python3 says so and stops, with no error", async () => {
    const { said, err, code } = await read(home(), "/nonexistent");
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(said).toEqual({ v: 1, python: false, claude: null, codex: null });
  });
});

describe("the merge", () => {
  const reading = (key: string, name: string, at: number, windows: object[], active = false) => ({ key, name, at, active, windows });
  const m = (machine: string, claude: object[] | null, codex: object[] | null): MachineUsage => ({ machine, ok: true, python: true, claude: list(claude), codex: list(codex) });

  test("a Claude account seen on two machines is one sub: the newest reading wins, active where it is logged in", () => {
    const subs = merge(
      [
        m("one", [reading(IDS.alpha, "team-alpha", NOW - 60_000, [{ w: "5h", left: 50, resets: NOW + H }], true), reading(IDS.bravo, "side-bravo", NOW - 9 * H, [{ w: "week", left: 70, resets: NOW + D }])], null),
        m("two", [reading(IDS.alpha, "team-alpha", NOW - 9 * H, [{ w: "5h", left: 99, resets: NOW - H }]), reading(IDS.bravo, "side-bravo", NOW - 60_000, [{ w: "week", left: 40, resets: NOW + D }], true)], null),
      ],
      NOW,
    );
    expect(subs.map((s) => [s.name, s.activeOn, s.fiveHour?.left ?? null, s.weekly?.left ?? null])).toEqual([
      ["team-alpha", ["one"], 50, null],
      ["side-bravo", ["two"], null, 40],
    ]);
    expect(JSON.stringify(subs)).not.toContain(IDS.alpha);
  });

  test("each machine's Codex is a sub of its own, and the one with most room comes first", () => {
    const codex = (left: number) => [{ key: "codex", name: "CODEX", plan: "pro", at: NOW, windows: [{ w: "week", left, resets: NOW + D }] }];
    const subs = merge([m("one", null, codex(5)), m("two", null, codex(80))], NOW);
    expect(subs.map((s) => [s.provider, s.activeOn, s.weekly?.left, s.fiveHour])).toEqual([
      ["codex", ["two"], 80, null],
      ["codex", ["one"], 5, null],
    ]);
  });

  test("a window past its reset counts as room in the order, and a sub with no reading goes last", () => {
    const subs = merge([m("one", [reading(IDS.alpha, "spent-then-reset", NOW, [{ w: "5h", left: 0, resets: NOW - 60_000 }]), reading(IDS.bravo, "half", NOW, [{ w: "5h", left: 50, resets: NOW + H }]), reading(IDS.spare, "unread", NOW, [])], null)], NOW);
    expect(subs.map((s) => s.name)).toEqual(["spent-then-reset", "half", "unread"]);
  });

  test("the reader's line is checked field by field", () => {
    expect(list("nope")).toBeNull();
    expect(list([{ key: 1 }, { key: "k", at: "x" }, { key: "k", at: 1, name: "n".repeat(99), windows: [{ w: "5h", left: 140, resets: "soon" }, { w: "day", left: 5 }, { w: "week", left: "lots" }] }])).toEqual([
      { key: "k", name: "n".repeat(40), plan: null, active: false, at: 1, windows: [{ w: "5h", left: 100, resets: null }] },
    ]);
  });

  test("sources say ok, none or unreachable per machine", () => {
    expect(sources([m("one", [], null), { machine: "two", ok: false, python: false, claude: null, codex: null }])).toEqual([
      { machine: "one", claude: "ok", codex: "none" },
      { machine: "two", claude: "unreachable", codex: "unreachable" },
    ]);
  });
});

describe("the server", () => {
  let data: string, fake: string, logged = "";
  let server: Awaited<ReturnType<typeof spawnServer>>;
  beforeAll(async () => {
    data = mkdtempSync(join(tmpdir(), "hq-subs-test-"));
    fake = home();
    server = await spawnServer({
      cwd: ROOT,
      env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: join(data, "no-such-herdr"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_GH_BIN: "false", HUD_SUBS_HOME: fake, HUD_SUBS_MS: "150" },
      out: (chunk) => (logged += new TextDecoder().decode(chunk)),
    });
  }, 30_000);
  afterAll(async () => {
    await server?.stop();
    rmSync(data, { recursive: true, force: true });
  });
  const subs = async () => (await fetch(`${server.base}/api/subs`)).json();
  const until = async (ok: (s: any) => boolean) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await Bun.sleep(100)) {
      const s = await subs();
      if (ok(s)) return s;
    }
    throw new Error("SUBS never got there");
  };

  test("the page gets names, windows and where each runs, and no account id, email or token", async () => {
    const s = await until((s) => s.list.length === 4);
    expect(s.list.map((x: any) => [x.provider, x.name, x.activeOn])).toEqual([
      ["codex", "CODEX", ["local"]],
      ["claude", "team-alpha", ["local"]],
      ["claude", "owner.person", []],
      ["claude", "side-bravo", []],
    ]);
    expect(s.sources).toEqual([{ machine: "local", claude: "ok", codex: "ok" }]);
    const state = await (await fetch(`${server.base}/api/state`)).text();
    expect(JSON.parse(state).subs).toEqual(s);
    for (const leak of LEAKS) expect(state).not.toContain(leak);
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  test("when the sources go away, SUBS is empty and nothing is logged", async () => {
    rmSync(join(fake, ".local"), { recursive: true, force: true });
    rmSync(join(fake, ".codex"), { recursive: true, force: true });
    const s = await until((s) => s.list.length === 0);
    expect(s.sources).toEqual([{ machine: "local", claude: "none", codex: "none" }]);
    expect(logged).not.toMatch(/sub-usage|python|grazr|codex/i);
  });
});
