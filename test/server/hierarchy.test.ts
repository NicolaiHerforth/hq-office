// Lanes in a tree under HQ: `hud lane NAME --parent OTHER` sets who a lane reports to, loops and unknown parents are
// refused, a removed lane's reports move up, the state carries parent, depth, path and level name, `hud tree`
// prints the tree, the level names and theme survive a restart, and `hud board` groups work under managers.
// A spare port, a throwaway data dir, and the real hud CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { boardText } from "../../src/server/board.ts";
import { laneTree, levelName, levelNames, treeText } from "../../src/lane-tree.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-office-tree-"));
let BASE = "";
let server: Awaited<ReturnType<typeof spawnServer>> | null = null;

async function start() {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_MACHINES: "local" },
  });
  BASE = server.base;
}
async function stop() {
  await server?.stop();
  server = null;
}
function hud(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
const lanes = async () => (await (await fetch(`${BASE}/api/state`)).json()).lanes as any[];
const lane = async (name: string) => (await lanes()).find((l) => l.name === name);
const settings = (s: object) => fetch(`${BASE}/api/settings`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ settings: s }) });

beforeAll(start);
afterAll(async () => {
  await stop();
  rmSync(DATA, { recursive: true, force: true });
});

describe("the lane tree on a server", () => {
  test("a lane with no parent sits under HQ at depth 1", async () => {
    expect(hud("lane", "web-pm").code).toBe(0);
    expect(await lane("web-pm")).toMatchObject({ parent: null, depth: 1, path: [], level: "Manager" });
  });

  test("--parent sets who a lane reports to; depth, path and level follow the chain", async () => {
    expect(hud("lane", "api-lead", "--parent", "web-pm").code).toBe(0);
    expect(hud("lane", "api-auth", "--parent", "api-lead").code).toBe(0);
    expect(hud("lane", "api-deep", "--parent", "api-auth").code).toBe(0);
    expect(await lane("api-lead")).toMatchObject({ parent: "web-pm", depth: 2, path: ["web-pm"], level: "Lead" });
    expect(await lane("api-auth")).toMatchObject({ parent: "api-lead", depth: 3, path: ["web-pm", "api-lead"], level: "Engineer" });
    // deeper than the list of names: the last name
    expect(await lane("api-deep")).toMatchObject({ depth: 4, level: "Engineer" });
  });

  test("other fields leave the parent alone; --parent hq and an empty parent put a lane back under HQ", async () => {
    expect(hud("lane", "api-auth", "--note", "halfway").code).toBe(0);
    expect((await lane("api-auth")).parent).toBe("api-lead");
    expect(hud("lane", "api-deep", "--parent", "hq").code).toBe(0);
    expect(await lane("api-deep")).toMatchObject({ parent: null, depth: 1 });
    expect(hud("lane", "api-deep", "--parent", "api-auth").code).toBe(0);
    expect(hud("lane", "api-deep", "--parent", "").code).toBe(0);
    expect(await lane("api-deep")).toMatchObject({ parent: null, depth: 1 });
  });

  test("a loop is refused with a clear error, and nothing changes", async () => {
    const r = hud("lane", "web-pm", "--parent", "api-auth");
    expect(r.code).toBe(1);
    expect(r.err).toContain("loop");
    expect(r.err).toContain("web-pm > api-lead > api-auth");
    expect((await lane("web-pm")).parent).toBeNull();
    const self = hud("lane", "web-pm", "--parent", "web-pm");
    expect(self.code).toBe(1);
    expect(self.err).toContain("cannot report to itself");
  });

  test("an unknown parent is refused, and the lane is not created", async () => {
    const r = hud("lane", "ghost", "--parent", "no-such-lane");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no lane named no-such-lane");
    expect(await lane("ghost")).toBeUndefined();
  });

  test("hud tree prints the tree with level names and status; --json has the fields", async () => {
    expect(hud("tree").out).toBe(["HQ", "├─ api-deep  Manager · waiting on HQ", "└─ web-pm  Manager · waiting on HQ", "   └─ api-lead  Lead · waiting on web-pm", "      └─ api-auth  Engineer · waiting on api-lead"].join("\n"));
    const json = JSON.parse(hud("tree", "--json").out);
    expect(json.find((l: any) => l.name === "api-auth")).toEqual({ name: "api-auth", parent: "api-lead", depth: 3, level: "Engineer", status: "hq_turn", path: ["web-pm", "api-lead"] });
  });

  test("the owner's level names are used; deeper than the list uses the last", async () => {
    expect((await settings({ levels: "PM, Senior" })).ok).toBe(true);
    expect((await lanes()).map((l) => [l.name, l.level])).toEqual([["api-auth", "Senior"], ["api-deep", "PM"], ["api-lead", "Senior"], ["web-pm", "PM"]]);
    expect(hud("tree").out).toContain("api-auth  Senior");
  });

  test("a removed lane's reports move up to the lane it reported to", async () => {
    expect(hud("lane", "api-cache", "--parent", "api-lead").code).toBe(0);
    expect(hud("rm-lane", "api-lead").code).toBe(0);
    expect(await lane("api-auth")).toMatchObject({ parent: "web-pm", depth: 2, path: ["web-pm"] });
    expect(await lane("api-cache")).toMatchObject({ parent: "web-pm", depth: 2 });
    // and from the top, straight to HQ
    expect(hud("rm-lane", "web-pm").code).toBe(0);
    expect(await lane("api-auth")).toMatchObject({ parent: null, depth: 1 });
  });

  test("level names and theme survive a restart", async () => {
    expect((await settings({ levels: "L1, L2, L3", theme: "arena" })).ok).toBe(true);
    await stop();
    await start();
    const s = (await (await fetch(`${BASE}/api/state`)).json()).settings;
    expect(s).toMatchObject({ levels: "L1, L2, L3", theme: "arena" });
    expect((await lane("api-auth")).level).toBe("L1");
  });
});

describe("the tree helpers", () => {
  test("level names: a comma list, blanks dropped, the defaults when empty", () => {
    expect(levelNames(" PM ,, Senior ,Junior ")).toEqual(["PM", "Senior", "Junior"]);
    expect(levelNames("")).toEqual(["Manager", "Lead", "Engineer"]);
    expect(levelNames(undefined)).toEqual(["Manager", "Lead", "Engineer"]);
    expect(levelName(0, ["A"])).toBe("HQ");
    expect(levelName(5, ["A", "B"])).toBe("B");
  });

  test("a parent that is not a lane counts as HQ, and a bad loop in the data does not hang", () => {
    const t = laneTree([{ name: "a", parent: "gone" }, { name: "b", parent: "c" }, { name: "c", parent: "b" }]);
    expect(t.get("a")).toEqual({ depth: 1, path: [] });
    expect(t.get("b")!.depth).toBeLessThan(4);
    expect(treeText([])).toContain("no lanes yet");
  });

  test("hud board groups each state's work under its lanes' managers, stalled first", () => {
    const item = (issue: string, state: string, lane: string, manager: string | null) => ({ issue, state, lane, manager, laneStatus: null, prs: [], why: "", last: null }) as any;
    const v = {
      counts: { stalled: 2, owner: 0, ci: 0, moving: 1, paused: 0, done: 0 },
      items: [item("OPE-1", "stalled", "api-auth", "api-lead"), item("OPE-2", "stalled", "web-pm", null), item("OPE-3", "moving", "ui-forms", "ui-lead")],
    } as any;
    expect(boardText(v).split("\n").slice(1)).toEqual([
      "",
      "STALLED (push these)",
      "  under api-lead",
      "    OPE-1  lane api-auth  PR -  last: nothing yet",
      "  under HQ",
      "    OPE-2  lane web-pm  PR -  last: nothing yet",
      "",
      "MOVING",
      "  under ui-lead",
      "    OPE-3  lane ui-forms  PR -  last: nothing yet",
    ]);
    // no tree: the board reads as before
    const flat = { ...v, items: v.items.map((i: any) => ({ ...i, manager: null })) };
    expect(boardText(flat)).not.toContain("under");
  });
});
