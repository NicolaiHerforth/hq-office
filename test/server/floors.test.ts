// Which floor each lane is on: floorsOf on the trees of the floor rule, and the floor and heads fields in /api/state.
// A spare port and a throwaway data dir for the server part.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { floorsOf } from "../../src/lane-tree.ts";

const ROOT = join(import.meta.dir, "..", "..");
const L = (name: string, parent: string | null = null) => ({ name, parent });
const floors = (lanes: { name: string; parent: string | null }[]) => Object.fromEntries([...floorsOf(lanes)].map(([n, f]) => [n, f.heads ? `${f.floor}*` : f.floor]));

describe("floorsOf", () => {
  test("flat lanes under HQ are all on HQ's floor", () => {
    expect(floors([L("a"), L("b")])).toEqual({ a: "hq", b: "hq" });
  });

  test("HQ > PM > builder stays one floor: the PM is not a general", () => {
    expect(floors([L("pm"), L("b", "pm")])).toEqual({ pm: "hq", b: "hq" });
  });

  test("a general over PMs heads a floor; its subtree is on it, HQ's own PMs are not", () => {
    const f = floors([L("g"), L("pm", "g"), L("b", "pm"), L("own-pm"), L("own-b", "own-pm")]);
    expect(f).toEqual({ g: "g*", pm: "g", b: "g", "own-pm": "hq", "own-b": "hq" });
  });

  test("a deep subtree is all on its head's floor", () => {
    const f = floors([L("g"), L("a", "g"), L("b", "a"), L("c", "b"), L("d", "c"), L("e", "d")]);
    expect(Object.values(f)).toEqual(["g*", "g", "g", "g", "g", "g"]);
  });

  test("a parent that is gone counts as HQ: the lane is on HQ's floor", () => {
    expect(floors([L("x", "vanished"), L("y", "x")])).toEqual({ x: "hq", y: "hq" });
  });

  test("a head removed: its reports move up to HQ and the rule runs again", () => {
    expect(floors([L("pm"), L("b", "pm"), L("c", "b")])).toEqual({ pm: "pm*", b: "pm", c: "pm" });
    expect(floors([L("b"), L("c", "b")])).toEqual({ b: "hq", c: "hq" });
  });

  test("a loop in bad rows ends and gives an answer", () => {
    expect(Object.keys(floors([L("a", "b"), L("b", "a")])).sort()).toEqual(["a", "b"]);
  });

  // The server stores --parent hq as no parent, so no lane reports to a lane named hq; even rows that say so land on
  // HQ's floor, whose id is hq.
  test("a lane named hq is on HQ's floor", () => {
    expect(floors([L("hq"), L("m", "hq"), L("n", "m"), L("o", "n")]).hq).toBe("hq");
  });
});

describe("floor and heads in /api/state", () => {
  const DATA = mkdtempSync(join(tmpdir(), "hq-floors-test-"));
  let server: Awaited<ReturnType<typeof spawnServer>>;
  beforeAll(async () => {
    server = await spawnServer({
      cwd: ROOT,
      env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: join(DATA, "no-such-herdr"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local" },
    });
  });
  afterAll(async () => {
    await server?.stop();
    rmSync(DATA, { recursive: true, force: true });
  });
  const lane = (name: string, parent?: string) =>
    fetch(`${server.base}/api/lanes`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify({ name, parent }) });

  test("every lane carries its floor, and the general carries heads", async () => {
    await lane("gen");
    await lane("mid", "gen");
    await lane("eng", "mid");
    await lane("solo");
    const lanes = (await (await fetch(`${server.base}/api/state`)).json()).lanes as any[];
    const by = Object.fromEntries(lanes.map((l) => [l.name, [l.floor, l.heads]]));
    expect(by).toEqual({ gen: ["gen", true], mid: ["gen", false], eng: ["gen", false], solo: ["hq", false] });
  });

  // A general's name is its floor's id in /floor/<id>/...: "." or ".." there would load another floor's copy.
  test("a lane cannot be named . or ..", async () => {
    for (const name of [".", "..", " .. "]) {
      const res = await lane(name);
      expect(res.status).not.toBe(200);
      expect(((await res.json()) as any).error).toContain("a lane cannot be named");
    }
    const lanes = (await (await fetch(`${server.base}/api/state`)).json()).lanes as any[];
    expect(lanes.map((l) => l.name.trim())).not.toContain("..");
  });

  // ask_comments and room_messages record the owner and HQ as "owner" and "hq": a lane with either name would be read as them.
  test("a lane cannot be named owner or hq, in any case or with spaces; ordinary names still work", async () => {
    for (const name of ["owner", "hq", "HQ", "Owner", " hq ", "OWNER "]) {
      const res = await lane(name);
      expect(res.status).not.toBe(200);
      expect(((await res.json()) as any).error).toContain("a lane cannot be named");
    }
    expect((await lane("hq-ops")).status).toBe(200);
    expect((await lane("owner-docs")).status).toBe(200);
    const lanes = (await (await fetch(`${server.base}/api/state`)).json()).lanes as any[];
    expect(lanes.map((l) => l.name.trim().toLowerCase()).filter((n) => ["owner", "hq"].includes(n))).toEqual([]);
  });
});
