// THE PAGE RUNTIME's room (src/server/page-room.ts): a HUD tab's stream carries every room its views are in; a view
// joins, sets presence and emits, and every other peer hears it, never the sender; peers are per page and per room
// name; a closed stream takes its tab's peers with it; agents speak (hud page room emit) and listen (hud page room
// listen) as kind "agent". Limits: topics, sizes, peers, rate. Nothing reaches the database. A stub herdr gives HQ and
// a lane their panes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-page-room-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const P = "rooms/pricing/files/board.html";
const send = async (p: string, b: object, h: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const room = (b: object) => send("/api/page-runtime/room", b);

// A HUD tab: its stream, and what has come in on it.
async function tab(id: string, path = `/api/page-runtime/room/events?tab=${id}`, headers: Record<string, string> = {}) {
  const ctl = new AbortController();
  const got: any[] = [];
  const res = await fetch(server.base + path, { signal: ctl.signal, headers });
  expect(res.status).toBe(200);
  (async () => {
    let buf = "";
    try {
      for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (ev.startsWith("data: ")) got.push(JSON.parse(ev.slice(6)));
        }
      }
    } catch {}
  })();
  await Bun.sleep(50);
  return { got, close: () => ctl.abort(), last: (pred: (e: any) => boolean) => got.filter(pred).at(-1) };
}
const until = async (fn: () => unknown, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (fn()) return;
  throw new Error("timed out");
};
const hud = (args: string[], pane = "w1:p2") => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdout: "pipe", stderr: "pipe" });

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await send("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await send("/api/sync", {});
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("two views of a page: each sees the other, hears the other's moments and presence, never its own", async () => {
  const a = await tab("tab-a"), b = await tab("tab-b");
  expect((await room({ tab: "tab-a", op: "join", page: P, room: "", peer: "pa" })).status).toBe(200);
  expect((await room({ tab: "tab-b", op: "join", page: P, room: "", peer: "pb" })).status).toBe(200);
  await until(() => a.last((e) => e.t === "peers")?.peers.length === 2);
  const seen = a.last((e) => e.t === "peers").peers;
  expect(seen.map((p: any) => [p.peer, p.kind, p.by, p.isMe, p.sameTab])).toEqual([["pa", "viewer", "owner", true, true], ["pb", "viewer", "owner", true, false]]);
  await room({ tab: "tab-b", op: "presence", page: P, room: "", peer: "pb", patch: { cursor: { x: 1, y: 2 }, name: "phone" } });
  await until(() => a.last((e) => e.t === "peers")?.peers.find((p: any) => p.peer === "pb")?.presence.name === "phone");
  await room({ tab: "tab-b", op: "presence", page: P, room: "", peer: "pb", patch: { name: null } });
  await until(() => !("name" in a.last((e) => e.t === "peers").peers.find((p: any) => p.peer === "pb").presence));
  expect(await room({ tab: "tab-a", op: "emit", page: P, room: "", peer: "pa", topic: "slide", data: { n: 3 } })).toMatchObject({ status: 200, heard: 1 });
  await until(() => b.got.some((e) => e.t === "msg"));
  expect(b.last((e) => e.t === "msg")).toMatchObject({ to: "pb", room: "", msg: { topic: "slide", data: { n: 3 }, peer: "pa", kind: "viewer", sameTab: false } });
  expect(a.got.some((e) => e.t === "msg")).toBe(false);
  // a named room is its own: the lobby hears nothing from it
  await room({ tab: "tab-a", op: "join", page: P, room: "game-1", peer: "pa1" });
  expect(await room({ tab: "tab-a", op: "emit", page: P, room: "game-1", peer: "pa1", topic: "move" })).toMatchObject({ heard: 0 });
  // a peer speaks only from its own tab, in a room it joined
  expect(await room({ tab: "tab-b", op: "emit", page: P, room: "", peer: "pa", topic: "x" })).toMatchObject({ status: 400, code: "not_permitted" });
  expect(await room({ tab: "tab-b", op: "emit", page: "rooms/pricing/brief", room: "", peer: "pb", topic: "x" })).toMatchObject({ status: 400, code: "not_permitted" });
  // a tab whose stream closes leaves every room
  b.close();
  await until(() => a.last((e) => e.t === "peers")?.peers.length === 1);
  a.close();
});

test("agents: hud page room peers, emit and listen, as kind agent", async () => {
  const a = await tab("tab-c");
  await room({ tab: "tab-c", op: "join", page: P, room: "", peer: "pc" });
  // a lane listens: it is in the room while it listens
  const lane = await tab("", `/api/page-runtime/room/listen?page=${encodeURIComponent(P)}&room=`, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" });
  await until(() => a.last((e) => e.t === "peers")?.peers.some((p: any) => p.kind === "agent" && p.by === "pm"));
  const peers = hud(["page", "room", P, "peers"]);
  expect(peers.exitCode).toBe(0);
  expect(peers.stdout.toString()).toContain("pm (agent");
  // the view emits: the listening lane hears it
  await room({ tab: "tab-c", op: "emit", page: P, room: "", peer: "pc", topic: "vote", data: { pick: "b" } });
  await until(() => lane.got.some((e) => e.topic === "vote"));
  expect(lane.got.find((e) => e.topic === "vote")).toMatchObject({ topic: "vote", data: { pick: "b" }, peer: "pc", kind: "viewer", by: "owner" });
  // the lane speaks: the view hears it, from an agent
  const say = hud(["page", "room", P, "emit", "note", '{"text":"thanks"}']);
  expect(say.stdout.toString()).toContain("heard by 2");
  await until(() => a.got.some((e) => e.t === "msg" && e.msg.topic === "note"));
  expect(a.last((e) => e.t === "msg").msg).toMatchObject({ topic: "note", data: { text: "thanks" }, kind: "agent", by: "pm", isMe: false });
  // only an agent speaks from the CLI
  expect(await send("/api/page-runtime/room/say", { page: P, room: "", topic: "x" })).toMatchObject({ status: 400, code: "not_permitted" });
  lane.close();
  await until(() => !a.last((e) => e.t === "peers").peers.some((p: any) => p.kind === "agent"));
  a.close();
});

test("limits: topics, sizes, room names, the rate of moments; bad tabs and pages", async () => {
  const a = await tab("tab-d");
  await room({ tab: "tab-d", op: "join", page: P, room: "", peer: "pd" });
  const code = async (b: object) => { const r = await room({ tab: "tab-d", page: P, room: "", peer: "pd", ...b }); return r.code ?? r.status; };
  expect(await code({ op: "emit", topic: "1bad" })).toBe("invalid_argument");
  expect(await code({ op: "emit", topic: "big", data: "x".repeat(5000) })).toBe("invalid_argument");
  expect(await code({ op: "presence", patch: { big: "x".repeat(5000) } })).toBe("invalid_argument");
  expect(await code({ op: "presence", patch: [1] })).toBe("invalid_argument");
  let deep: any = 1;
  for (let i = 0; i < 10; i++) deep = { d: deep };
  expect(await code({ op: "emit", topic: "deep", data: deep })).toBe("invalid_argument");
  expect(await code({ op: "join", room: "no spaces", peer: "pd2" })).toBe("invalid_argument");
  expect(await code({ op: "nope" })).toBe("invalid_argument");
  const sent = await Promise.all(Array.from({ length: 30 }, () => code({ op: "emit", topic: "tick" })));
  expect(sent.filter((c) => c === "rate_limited").length).toBe(10);
  expect((await room({ tab: "tab-d", op: "join", page: "state", room: "", peer: "x" })).status).toBe(400);
  expect((await room({ tab: "no-such-tab", op: "join", page: P, room: "", peer: "x" })).code).toBe("upstream_error");
  expect((await fetch(`${server.base}/api/page-runtime/room/events?tab=${encodeURIComponent("bad tab")}`)).status).toBe(400);
  a.close();
});
