// FLOORS: one HQ agent per domain, each with everything it runs. Two floors here: "hq" (the first, HQ agent hq in
// pane w1:p1) and "two" (HQ agent hq-two in pane w2:p1), with lanes on each. hud tells the server who is calling
// with x-hud-pane (HERDR_PANE_ID); the server knows every named agent's pane from its last sync.
// A stub herdr reads its agent list and panes from files the test rewrites, and logs who it typed into and what.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "hq-floors-test-"));
const herdr = join(data, "herdr");
const typedDir = join(data, "typed");
const renameLog = join(data, "renames.log");
const MINUTE = 40;
writeFileSync(herdr, `#!/bin/sh
D="${data}"
case "$1 $2" in
  "agent list") printf '{"result":{"agents":%s}}' "$(cat "$D/agents.json")" ;;
  "agent prompt")
    grep -q "\\"name\\":\\"$3\\"" "$D/agents.json" || { echo '{"error":{"code":"agent_not_found","message":"not found"}}' >&2; exit 1; }
    F=$(mktemp "${typedDir}/XXXXXX"); printf '%s\\n%s' "$3" "$4" > "$F" ;;
  "agent rename") echo "$3 $4" >> "${renameLog}" ;;
  "pane read") [ -f "$D/pane-$3.txt" ] && cat "$D/pane-$3.txt" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
mkdirSync(typedDir);

type Agent = { name?: string; agent_status: string; pane_id: string; agent: string };
const HQ1 = { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" };
const HQ2 = { name: "hq-two", agent_status: "idle", pane_id: "w2:p1", agent: "claude" };
const lane = (name: string, status = "working") => ({ name, agent_status: status, pane_id: `p-${name}`, agent: "claude" });
const world = (list: Agent[]) => writeFileSync(join(data, "agents.json"), JSON.stringify(list));
const LANES = ["alpha", "bravo", "charlie", "delta"];
world([HQ1, HQ2, ...LANES.map((n) => lane(n))]);

let server: Awaited<ReturnType<typeof spawnServer>>;
beforeAll(async () => {
  server = await spawnServer({
    cwd: ROOT,
    env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_SWEEP_MINUTE_MS: String(MINUTE), TZ: "UTC" },
  });
  await sync();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(data, { recursive: true, force: true });
});

const post = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};
const get = async (path: string, headers: Record<string, string> = {}) => (await fetch(`${server.base}${path}`, { headers })).json();
const state = () => get("/api/state");
const sync = async () => {
  await post("/api/sync");
  await Bun.sleep(100); // what goes to an HQ is typed in the background
};
// Everything typed into an agent: [agent, text]. One file per prompt: two HQs are typed into at the same time.
const typed = () => readdirSync(typedDir).map((f) => readFileSync(join(typedDir, f), "utf8")).map((s) => { const i = s.indexOf("\n"); return [s.slice(0, i), s.slice(i + 1)]; });
const typedInto = (agent: string) => typed().filter(([a]) => a === agent).map(([, t]) => t);
const until = async (ok: () => boolean | Promise<boolean>, what = "condition") => {
  for (let i = 0; i < 120; i++) {
    if (await ok()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};
// hud, run as the agent in `pane` (no pane: a shell outside herdr).
const { HERDR_PANE_ID: _pane, ...env } = process.env;
function hud(pane: string | null, ...args: string[]) {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...env, HUD_URL: server.base, ...(pane ? { HERDR_PANE_ID: pane } : {}) }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const AS_HQ1 = "w1:p1";
const AS_HQ2 = "w2:p1";
const laneOf = async (name: string) => (await state()).lanes.find((l: any) => l.name === name);

test("one floor behaves as today: S.floors has the first floor, S.hq its link, S.hqLinks the same", async () => {
  const s = await state();
  expect(s.floors).toHaveLength(1);
  expect(s.floors[0]).toMatchObject({ id: "hq", name: "HQ", hq: "hq", receiving: true, reason: null });
  expect(s.floors[0].counts).toEqual({ needsYou: 0, blocking: 0, oldestWaitAt: null, blocked: 0, working: 0, active: 0, idleSince: expect.any(Number), lanes: 0, unreadMessages: 0 });
  expect(s.hq).toMatchObject({ agent: "hq", ok: true, reason: null });
  expect(s.hqLinks.hq).toEqual(s.hq);
  expect(s.sweepByFloor.hq).toEqual({ lastAt: s.sweep.lastAt, nextAt: s.sweep.nextAt, backoff: s.sweep.backoff });
});

test("hud floor add, list and set; a bad id, colour or a taken HQ is refused", async () => {
  const add = hud(AS_HQ1, "floor", "add", "two", "--name", "Floor Two", "--hq", "hq-two", "--color", "#33aa55");
  expect(add.code).toBe(0);
  expect(hud(null, "floor", "add", "Bad Id", "--hq", "x").code).not.toBe(0);
  expect(hud(null, "floor", "add", "three", "--hq", "hq").err).toContain("hq");
  expect(hud(null, "floor", "add", "three", "--hq", "hq-3", "--color", "green").code).not.toBe(0);
  await sync();
  const s = await state();
  expect(s.floors.map((f: any) => [f.id, f.name, f.hq, f.color])).toEqual([["hq", "HQ", "hq", expect.any(String)], ["two", "Floor Two", "hq-two", "#1a9a8a"]]);
  expect(s.hqLinks.two).toMatchObject({ agent: "hq-two", ok: true });
  expect(hud(null, "floor", "set", "two", "--name", "Second").code).toBe(0);
  expect((await state()).floors[1].name).toBe("Second");
  const list = hud(null, "floor", "list").out;
  expect(list).toContain("two");
  expect(list).toContain("hq-two");
  const api = await get("/api/floors", { "x-hud-pane": AS_HQ2 });
  expect(api.caller).toBe("two");
  expect(api.floors.map((f: any) => f.id)).toEqual(["hq", "two"]);
});

test("a lane registered by an HQ lands on its floor; --floor wins; a child takes its parent's floor", async () => {
  expect(hud(AS_HQ1, "lane", "alpha").code).toBe(0);
  expect(hud(AS_HQ2, "lane", "bravo").code).toBe(0);
  expect(hud(AS_HQ1, "lane", "charlie", "--floor", "two").code).toBe(0);
  expect(hud(null, "lane", "delta", "--parent", "bravo").code).toBe(0);
  expect((await laneOf("alpha")).floor).toBe("hq");
  expect((await laneOf("bravo")).floor).toBe("two");
  expect((await laneOf("charlie")).floor).toBe("two");
  expect((await laneOf("delta")).floor).toBe("two");
  // An unknown pane, a shell outside herdr: the first floor. A lane re-registered from another floor stays put.
  expect(hud("w9:p9", "lane", "echo").code).toBe(0);
  expect((await laneOf("echo")).floor).toBe("hq");
  expect(hud(AS_HQ1, "lane", "bravo", "--note", "still here").code).toBe(0);
  expect((await laneOf("bravo")).floor).toBe("two");
  expect(hud(null, "lane", "zulu", "--floor", "nowhere").code).not.toBe(0);
});

test("moving a lane with --floor moves its subtree", async () => {
  hud(AS_HQ1, "lane", "echo-kid", "--parent", "echo");
  expect((await laneOf("echo-kid")).floor).toBe("hq");
  expect(hud(AS_HQ1, "lane", "echo", "--floor", "two").code).toBe(0);
  expect((await laneOf("echo")).floor).toBe("two");
  expect((await laneOf("echo-kid")).floor).toBe("two");
  expect(hud(AS_HQ2, "lane", "echo", "--floor", "hq").code).toBe(0);
  expect((await laneOf("echo-kid")).floor).toBe("hq");
});

test("a lane calling hud is on its own floor", async () => {
  await sync(); // the lanes' panes are known from the sync
  const out = hud("p-bravo", "ask", "--title", "From bravo itself");
  expect(out.code).toBe(0);
  const s = await state();
  expect(s.open.find((a: any) => a.title === "From bravo itself").floor).toBe("two");
  expect((await get("/api/floors", { "x-hud-pane": "p-alpha" })).caller).toBe("hq");
});

test("asks, updates and rooms: the lane's floor, else the caller's", async () => {
  hud(AS_HQ2, "ask", "--lane", "alpha", "--title", "Alpha's question");
  hud(AS_HQ2, "ask", "--title", "Two's own question");
  hud(AS_HQ1, "tell", "--lane", "bravo", "--title", "Bravo update");
  hud(AS_HQ2, "tell", "--title", "Two's update");
  hud(AS_HQ1, "room", "create", "bravo-room", "--title", "Bravo's room", "--owner", "bravo");
  hud(AS_HQ2, "room", "create", "two-room", "--title", "Two's room", "--owner", "hq");
  const s = await state();
  const ask = (t: string) => s.open.find((a: any) => a.title === t).floor;
  expect(ask("Alpha's question")).toBe("hq");
  expect(ask("Two's own question")).toBe("two");
  const upd = (t: string) => s.updates.find((u: any) => u.title === t).floor;
  expect(upd("Bravo update")).toBe("two");
  expect(upd("Two's update")).toBe("two");
  const room = (slug: string) => s.rooms.find((r: any) => r.slug === slug).floor;
  expect(room("bravo-room")).toBe("two");
  expect(room("two-room")).toBe("two");
  expect(s.floors.find((f: any) => f.id === "two").counts.needsYou).toBe(2);
  expect(s.floors.find((f: any) => f.id === "two").counts.unreadMessages).toBe(2);
}, 30_000); // six hud commands, each a process: slow on a busy machine

test("an answer and a NOT YET reach the ask's floor's HQ only", async () => {
  const s = await state();
  const two = s.open.find((a: any) => a.title === "Two's own question");
  const one = s.open.find((a: any) => a.title === "Alpha's question");
  await post(`/api/asks/${two.id}/answer`, { answer: "yes for two" });
  await post(`/api/asks/${one.id}/notyet`, { note: "later for one" });
  await until(() => typedInto("hq-two").some((t) => t.includes("yes for two")) && typedInto("hq").some((t) => t.includes("later for one")), "deliveries");
  expect(typedInto("hq").some((t) => t.includes("yes for two"))).toBe(false);
  expect(typedInto("hq-two").some((t) => t.includes("later for one"))).toBe(false);
});

test("a note goes to the floor the page sends, else the first floor", async () => {
  await post("/api/notes", { text: "note for two", floor: "two" });
  await post("/api/notes", { text: "note for one" });
  await until(() => typedInto("hq-two").some((t) => t.includes("note for two")) && typedInto("hq").some((t) => t.includes("note for one")), "notes");
  expect(typedInto("hq").some((t) => t.includes("note for two"))).toBe(false);
  expect(typedInto("hq-two").some((t) => t.includes("note for one"))).toBe(false);
  const s = await state();
  expect(s.notes.find((n: any) => n.text === "note for two").floor).toBe("two");
  expect(s.notes.find((n: any) => n.text === "note for one").floor).toBe("hq");
  expect((await post("/api/notes", { text: "x", floor: "nowhere" })).status).toBe(400);
});

test("hud inbox, wait and ack are scoped to the caller's floor; --all shows every floor", async () => {
  const two = JSON.parse(hud(AS_HQ2, "inbox").out);
  expect(two.answers.map((a: any) => a.answer)).toEqual(["yes for two"]);
  expect(two.notes.map((n: any) => n.text)).toEqual(["note for two"]);
  const one = JSON.parse(hud(AS_HQ1, "inbox").out);
  expect(one.answers).toEqual([]);
  expect(one.notes.map((n: any) => n.text)).toEqual(["note for one"]);
  const all = JSON.parse(hud(AS_HQ1, "inbox", "--all").out);
  expect(all.notes.map((n: any) => n.text).sort()).toEqual(["note for one", "note for two"]);
  // An HQ cannot ack another floor's note without --all.
  const noteTwo = two.notes[0].id;
  expect(hud(AS_HQ1, "ack", `n:${noteTwo}`).code).not.toBe(0);
  expect(hud(AS_HQ2, "ack", `n:${noteTwo}`).code).toBe(0);
  expect(JSON.parse(hud(AS_HQ2, "inbox").out).notes).toEqual([]);
  const waited = JSON.parse(hud(AS_HQ2, "wait").out);
  expect(waited.answers.map((a: any) => a.answer)).toEqual(["yes for two"]);
});

test("the board and the tree are scoped per floor, with --all", async () => {
  hud(AS_HQ1, "track", "ONE-1", "--lane", "alpha");
  hud(AS_HQ2, "track", "TWO-1", "--lane", "bravo");
  hud(AS_HQ2, "track", "TWO-2");
  const s = await state();
  const item = (i: string) => s.board.items.find((x: any) => x.issue === i).floor;
  expect([item("ONE-1"), item("TWO-1"), item("TWO-2")]).toEqual(["hq", "two", "two"]);
  const two = JSON.parse(hud(AS_HQ2, "board", "--json").out);
  expect(two.items.map((i: any) => i.issue).sort()).toEqual(["TWO-1", "TWO-2"]);
  const one = hud(AS_HQ1, "board").out;
  expect(one).toContain("ONE-1");
  expect(one).not.toContain("TWO-1");
  const all = JSON.parse(hud(AS_HQ1, "board", "--json", "--all").out);
  expect(all.items.map((i: any) => i.issue).sort()).toEqual(["ONE-1", "TWO-1", "TWO-2"]);
  const tree = hud(AS_HQ2, "tree").out;
  expect(tree).toContain("bravo");
  expect(tree).toContain("delta");
  expect(tree).not.toContain("alpha");
  const treeAll = hud(AS_HQ2, "tree", "--all").out;
  expect(treeAll).toContain("alpha");
  expect(treeAll).toContain("bravo");
  const rooms = hud(AS_HQ1, "room", "list").out;
  expect(rooms).not.toContain("bravo-room");
  expect(hud(AS_HQ1, "room", "list", "--all").out).toContain("bravo-room");
});

test("a lane blocked on a prompt is told to its floor's HQ only", async () => {
  writeFileSync(join(data, "pane-p-delta.txt"), `│ Do you want to proceed?                                       │
│ ❯ 1. Yes                                                      │
│   2. No, and tell Claude what to do differently (esc)         │
`);
  world([HQ1, HQ2, ...LANES.filter((n) => n !== "delta").map((n) => lane(n)), lane("delta", "blocked")]);
  await sync();
  await until(() => typedInto("hq-two").some((t) => t.includes("Lane delta is blocked")), "blocked notice");
  expect(typedInto("hq").some((t) => t.includes("Lane delta"))).toBe(false);
  expect((await state()).floors.find((f: any) => f.id === "two").counts.blocked).toBe(1);
  world([HQ1, HQ2, ...LANES.map((n) => lane(n))]);
  await sync();
});

test("a secret the owner sets reaches every floor's HQ", async () => {
  const res = await post("/api/secrets", { name: "FLOORS_TEST_KEY", value: "TEST_ONLY_FLOORS_VALUE_1", minutes: 5, by: "owner" });
  expect(res.status).toBe(200);
  await until(() => typedInto("hq").some((t) => t.includes("FLOORS_TEST_KEY")) && typedInto("hq-two").some((t) => t.includes("FLOORS_TEST_KEY")), "secret notices");
  expect(typed().some(([, t]) => t.includes("TEST_ONLY_FLOORS_VALUE_1"))).toBe(false);
});

test("hud floor tell types into that floor's HQ, from the caller's floor, with an event line", async () => {
  const out = hud(AS_HQ2, "floor", "tell", "hq", "can", "legal", "review", "this?");
  expect(out.code).toBe(0);
  await until(() => typedInto("hq").some((t) => t.startsWith("HUD from floor two: can legal review this?")), "floor tell");
  expect(typedInto("hq-two").some((t) => t.includes("can legal review"))).toBe(false);
  expect((await state()).events.some((e: any) => e.text.includes("can legal review this?") && e.floor === "hq")).toBe(true);
  expect(hud(AS_HQ2, "floor", "tell", "nowhere", "hi").code).not.toBe(0);
});

test("each floor has its own link: floor two's HQ losing its name shows on floor two only, and is healed there", async () => {
  world([HQ1, ...LANES.map((n) => lane(n))]);
  await sync();
  let s = await state();
  expect(s.hqLinks.two).toMatchObject({ ok: false, reason: 'no agent in herdr is named "hq-two"' });
  expect(s.hq).toMatchObject({ ok: true, reason: null });
  expect(s.floors.find((f: any) => f.id === "two")).toMatchObject({ receiving: false, reason: 'no agent in herdr is named "hq-two"' });
  expect(s.floors.find((f: any) => f.id === "hq").receiving).toBe(true);
  // A note for floor two is held, and goes once hq-two is back; floor one's flow never stops.
  await post("/api/notes", { text: "held for two", floor: "two" });
  await post("/api/notes", { text: "straight to one" });
  await until(() => typedInto("hq").some((t) => t.includes("straight to one")), "floor one note");
  s = await state();
  expect(s.hqLinks.two.held.length).toBeGreaterThan(0);
  expect(s.hq.held).toEqual([]);
  world([HQ1, HQ2, ...LANES.map((n) => lane(n))]);
  await sync();
  await until(() => typedInto("hq-two").some((t) => t.includes("held for two")), "held note");
  expect((await state()).hqLinks.two.ok).toBe(true);
  // herdr drops hq-two's name while it stays in its pane: the server gives it back to that pane, quietly.
  world([HQ1, { ...HQ2, name: undefined }, ...LANES.map((n) => lane(n))]);
  await sync();
  expect(existsSync(renameLog) ? readFileSync(renameLog, "utf8") : "").toContain("w2:p1 hq-two");
  s = await state();
  expect(s.hqLinks.two.ok).toBe(true);
  expect(s.hq.ok).toBe(true);
  world([HQ1, HQ2, ...LANES.map((n) => lane(n))]);
  await sync();
});

test("the sweep nudges each HQ about its own floor only, with its own last and next", async () => {
  world([HQ1, HQ2, lane("alpha", "idle"), lane("bravo", "idle"), lane("charlie"), lane("delta")]);
  await post("/api/settings", { settings: { hqSweep: true, hqSweepHours: "0-24" } });
  await sync();
  await until(() => typedInto("hq").some((t) => t.startsWith("HUD sweep:")) && typedInto("hq-two").some((t) => t.startsWith("HUD sweep:")), "nudges");
  const one = typedInto("hq").find((t) => t.startsWith("HUD sweep:"))!;
  const two = typedInto("hq-two").find((t) => t.startsWith("HUD sweep:"))!;
  expect(one).toContain("alpha");
  expect(one).not.toContain("bravo");
  expect(two).toContain("bravo");
  expect(two).not.toContain("alpha");
  const s = await state();
  expect(s.sweepByFloor.hq.lastAt).toBeGreaterThan(0);
  expect(s.sweepByFloor.two.lastAt).toBeGreaterThan(0);
  expect(s.sweep.lastAt).toBe(s.sweepByFloor.hq.lastAt);
  await post("/api/settings", { settings: { hqSweep: false } });
});

test("hud floor rm is refused while the floor has work; an empty floor goes", async () => {
  const refused = hud(null, "floor", "rm", "two");
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("lanes");
  // A floor's HQ must run in herdr here: hq-three does not, and is refused; once it runs it is taken.
  expect(hud(null, "floor", "add", "three", "--hq", "hq-three").err).toContain("hq-three is not running in herdr");
  world([HQ1, HQ2, ...LANES.map((n) => lane(n)), lane("hq-three", "idle"), lane("hq-four", "idle")]);
  expect(hud(null, "floor", "add", "three", "--hq", "hq-three").code).toBe(0);
  // hq-three runs, so its guide is held for it until the sync types it in: then the floor is empty and goes.
  await until(() => hud(null, "floor", "rm", "three").code === 0, "three's guide delivered and the floor removed");
  expect((await state()).floors.map((f: any) => f.id)).toEqual(["hq", "two"]);
  // POST /api/floors/ID with rm.
  expect((await post("/api/floors", { id: "four", hq: "hq-four" })).status).toBe(200);
  await until(async () => (await post("/api/floors/four", { rm: true })).status === 200, "four's guide delivered and the floor removed");
});

test("no two floors share a colour: a colour another floor wears moves to the nearest free one; all seven taken, a repeat", async () => {
  const PALETTE = ["#3c6fd6", "#1a9a8a", "#7a4fc9", "#b0469a", "#5f6b85", "#8a5a3c", "#2a9fc9"];
  const colors = async () => (await state()).floors.map((f: any) => f.color);
  // Floor two wears teal; asking for teal again gives the nearest free colour (cyan); asking for nothing, an unused one.
  expect((await colors())[1]).toBe("#1a9a8a");
  const names = ["c1", "c2", "c3", "c4", "c5", "c6"];
  world([HQ1, HQ2, ...LANES.map((n) => lane(n)), ...names.map((n) => lane(`hq-${n}`, "idle"))]);
  await sync();
  expect((await post("/api/floors", { id: "c1", hq: "hq-c1", color: "#1a9a8a" })).status).toBe(200);
  expect((await colors())[2]).toBe("#2a9fc9");
  for (const id of ["c2", "c3", "c4", "c5"]) expect((await post("/api/floors", { id, hq: `hq-${id}` })).status).toBe(200);
  const seven = await colors();
  expect(seven).toHaveLength(7);
  expect(new Set(seven).size).toBe(7);
  expect([...seven].sort()).toEqual([...PALETTE].sort());
  // An edit to a worn colour moves too.
  expect((await post("/api/floors/c5", { color: "#3c6fd6" })).status).toBe(200);
  expect(new Set(await colors()).size).toBe(7);
  // An eighth floor: every colour is worn, so it repeats one.
  expect((await post("/api/floors", { id: "c6", hq: "hq-c6" })).status).toBe(200);
  expect(PALETTE).toContain((await colors())[7]);
  for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) await until(async () => (await post(`/api/floors/${id}`, { rm: true })).status === 200, `${id} removed`);
  expect((await post("/api/floors/two", { rm: true })).status).toBe(400);
});
