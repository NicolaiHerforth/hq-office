// ASK ROUTING: a question a lane asked (a PM asking for its lanes) is that lane's. The owner's answer, a secrets answer
// and NOT YET are typed into the asker's pane, not HQ's, one at a time in order, kept while it is away, at a prompt or
// busy; its floor's HQ gets them when the lane cannot (removed, moved, gone long, refused). A lane's inbox, wait and ack
// are its own; HQ sees its lanes' answers under forLanes. A stub herdr records what is typed; no real agent is prompted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-askroute-"));
const GONE_MS = 4000;
const agent = (name: string, pane: string, agent_status = "idle"): FakeAgent => ({ name, agent_status, pane_id: pane, agent: "claude" });
const HQ = agent("hq", "w1:p1"), CRM = agent("hq-crm", "w1:p2"), PM = agent("pm", "w1:p3"), CHILD = agent("child", "w1:p4");
const PMA = agent("pm-a", "w1:p5"), PMB = agent("pm-b", "w1:p6"), PMC = agent("pm-c", "w1:p7"), PMD = agent("pm-d", "w1:p8"), PMX = agent("pm-x", "w1:p9");
const ALL = [HQ, CRM, PM, CHILD, PMA, PMB, PMC, PMD, PMX];
const herdr = fakeHerdr(DATA, ALL);
const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false", HUD_OWNER: "Sam", HUD_LANE_GONE_MS: String(GONE_MS) };
let server: Awaited<ReturnType<typeof spawnServer>>;

const headers = (pane?: string) => ({ "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}) });
const req = async (p: string, b?: object, pane?: string) => {
  const r = await fetch(`${server.base}${p}`, b ? { method: "POST", headers: headers(pane), body: JSON.stringify(b) } : { headers: headers(pane) });
  return { status: r.status, ...(await r.json()) };
};
const hud = (args: string[], pane = "") => {
  const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
};
const sync = () => req("/api/sync", {});
const world = async (list: FakeAgent[]) => { herdr.world(list); await sync(); };
// What was typed into an agent and contains `part`, once it has landed (delivery runs after the request returns).
async function typed(name: string, part: string, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (herdr.typedInto(name).some((t) => t.includes(part))) break;
  await Bun.sleep(300); // a duplicate would land by now
  return herdr.typedInto(name).filter((t) => t.includes(part));
}
const nowhere = (part: string) => herdr.typed().filter(([, t]) => t.includes(part)).map(([who]) => who);
// An ask filed with hud from an agent's pane, as a PM files it.
function ask(pane: string, args: string[]) {
  const r = hud(["ask", ...args], pane);
  expect(r.err).toBe("");
  return Number(r.out.match(/^ask #(\d+)/)![1]);
}
const askers = async () => (await req("/api/state")).askers;
const answer = (id: number, text: string) => req(`/api/asks/${id}/answer`, { answer: text });

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env });
  await sync();
  await req("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  for (const name of ["pm", "pm-a", "pm-b", "pm-c", "pm-d"]) await req("/api/lanes", { name, parent: "hq", machine: "local" });
  await req("/api/lanes", { name: "child", parent: "pm", machine: "local" });
  await req("/api/lanes", { name: "pm-x", machine: "local" }, "w1:p2");
  await sync();
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("S1: HQ's own question: the answer is typed into HQ only, and it is HQ's to ack", async () => {
  const id = ask("w1:p1", ["--lane", "child", "--title", "Ship the HQ thing?", "--opt", "Yes", "--opt", "No", "--rec", "Yes"]);
  expect((await askers())[id]).toBeUndefined();
  await answer(id, "Yes");
  expect(await typed("hq", `HUD answer #${id} (child): "Ship the HQ thing?" -> Yes`)).toHaveLength(1);
  expect(nowhere(`HUD answer #${id}`)).toEqual(["hq"]);
  const box = JSON.parse(hud(["inbox"], "w1:p1").out);
  expect(box.answers.map((a: any) => a.id)).toContain(id);
  expect(box.forLanes.map((a: any) => a.id)).not.toContain(id);
  expect(hud(["ack", `a:${id}`], "w1:p1").code).toBe(0);
});

test("S2: a PM's question: the answer lands in the PM's pane and not HQ's; the PM's inbox and wait have it, HQ's forLanes", async () => {
  const id = ask("w1:p3", ["--lane", "child", "--title", "Which cache?", "--opt", "Redis", "--opt", "Memory", "--rec", "Redis"]);
  expect((await askers())[id]).toEqual({ name: "pm", now: null, delivery: null });
  expect((await req("/api/state")).open.find((a: any) => a.id === id)).toMatchObject({ lane: "child", recommended: "Redis" });
  // HQ's wait is not woken by the PM's answer; the PM's is.
  const hqWait = req("/api/wait?s=2", undefined, "w1:p1");
  const pmWait = req("/api/wait?s=8", undefined, "w1:p3");
  await Bun.sleep(300);
  await answer(id, "Redis. Keep it small");
  const got = await typed("pm", `HUD answer #${id} (child): "Which cache?" -> Redis. Keep it small`);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`Ack it once you have acted on it: hud ack a:${id}`);
  expect(got[0]).toContain("Sam reads the HUD, not this terminal.");
  expect(nowhere(`HUD answer #${id}`)).toEqual(["pm"]);
  expect((await pmWait).answers.map((a: any) => a.id)).toEqual([id]);
  expect((await hqWait).answers.map((a: any) => a.id)).not.toContain(id);
  const hqBox = JSON.parse(hud(["inbox"], "w1:p1").out);
  expect(hqBox.answers.map((a: any) => a.id)).not.toContain(id);
  expect(hqBox.forLanes).toContainEqual(expect.objectContaining({ id, for: "pm", lane: "child", answer: "Redis. Keep it small", delivery: "sent" }));
  const pmBox = JSON.parse(hud(["inbox"], "w1:p3").out);
  expect(pmBox).toEqual({ answers: [expect.objectContaining({ id, answer: "Redis. Keep it small" })], notes: [] });
  expect((await askers())[id]).toEqual({ name: "pm", now: null, delivery: "sent" });
  expect((await req("/api/state")).events.some((e: any) => e.text === `answered for pm "Which cache?": Redis. Keep it small`)).toBe(true);
  expect(hud(["ack", `a:${id}`], "w1:p3").code).toBe(0);
  expect(JSON.parse(hud(["inbox"], "w1:p1").out).forLanes.map((a: any) => a.id)).not.toContain(id);
});

test("S3: NOT YET on a PM's TO DO goes to the PM; the question stays open", async () => {
  const id = ask("w1:p3", ["--kind", "action", "--lane", "child", "--title", "Sign in to the store"]);
  await req(`/api/asks/${id}/notyet`, { note: "after lunch" });
  const got = await typed("pm", `HUD not yet #${id} (child): "Sign in to the store" -> after lunch`);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain("The question stays open in the owner's NEEDS YOU.");
  expect(nowhere(`HUD not yet #${id}`)).toEqual(["pm"]);
  expect((await req("/api/state")).open.some((a: any) => a.id === id)).toBe(true);
  await answer(id, "done");
  expect(await typed("pm", `HUD answer #${id}`)).toHaveLength(1);
  hud(["ack", `a:${id}`], "w1:p3");
});

test("S4: a PM's secrets ask: the PM gets the names only; the value is in no typed text and no file", async () => {
  const VALUE = "zq-routing-VALUE-7731";
  const id = ask("w1:p3", ["--kind", "action", "--lane", "child", "--title", "The store token", "--secret", "STORE_TOKEN"]);
  expect((await req(`/api/asks/${id}/secrets`, { values: { STORE_TOKEN: VALUE }, minutes: 5 })).status).toBe(200);
  const got = await typed("pm", `HUD answer #${id}`);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain("secrets set: STORE_TOKEN");
  expect(herdr.typed().some(([, t]) => t.includes(VALUE))).toBe(false);
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  expect(files(DATA).filter((f) => readFileSync(f).includes(VALUE))).toEqual([]);
  hud(["ack", `a:${id}`], "w1:p3");
});

test("S5: a PM that is away keeps its answer and gets it once when herdr sees it again", async () => {
  const id = ask("w1:p3", ["--lane", "child", "--title", "Rename the table?", "--opt", "Yes", "--opt", "No"]);
  await world(ALL.filter((a) => a !== PM));
  await answer(id, "No");
  await Bun.sleep(400);
  expect(nowhere(`HUD answer #${id}`)).toEqual([]);
  expect((await askers())[id]).toMatchObject({ name: "pm", delivery: "away" });
  expect(JSON.parse(hud(["inbox"], "w1:p1").out).forLanes).toContainEqual(expect.objectContaining({ id, for: "pm", delivery: "away" }));
  await world(ALL);
  const got = await typed("pm", `HUD answer #${id}`);
  expect(got).toHaveLength(1);
  expect(got[0]).toMatch(/^\(kept while you were away; written at \d\d:\d\d\) HUD answer/);
  await sync();
  await sync();
  expect(await typed("pm", `HUD answer #${id}`)).toHaveLength(1);
  expect(nowhere(`HUD answer #${id}`)).toEqual(["pm"]);
  hud(["ack", `a:${id}`], "w1:p3");
});

test("S6: a PM waiting at a prompt is not typed into; it gets the answer once the prompt is gone", async () => {
  const id = ask("w1:p3", ["--lane", "child", "--title", "Drop the index?", "--opt", "Yes", "--opt", "No"]);
  await world(ALL.map((a) => (a === PM ? { ...PM, agent_status: "blocked" } : a)));
  expect((await req("/api/state")).lanes.find((l: any) => l.name === "pm").prompt).toBeTruthy();
  await answer(id, "Yes");
  await Bun.sleep(400);
  expect(nowhere(`HUD answer #${id}`)).toEqual([]);
  expect((await askers())[id]).toMatchObject({ now: "away", delivery: "away" });
  await world(ALL);
  expect(await typed("pm", `HUD answer #${id}`)).toHaveLength(1);
  hud(["ack", `a:${id}`], "w1:p3");
});

test("S7: a busy PM: kept until idle; acked meanwhile (hud wait, hud inbox) it is never typed, else typed once when idle", async () => {
  const read = ask("w1:p3", ["--lane", "child", "--title", "Read it in wait", "--opt", "A", "--opt", "B"]);
  const left = ask("w1:p3", ["--lane", "child", "--title", "Left for later", "--opt", "A", "--opt", "B"]);
  await world(ALL.map((a) => (a === PM ? { ...PM, agent_status: "working" } : a)));
  expect((await askers())[read]).toMatchObject({ now: "busy" });
  await answer(read, "A");
  await answer(left, "B");
  await Bun.sleep(400);
  expect((await askers())[read]).toMatchObject({ delivery: "busy" });
  expect(nowhere("Read it in wait")).toEqual([]);
  expect(JSON.parse(hud(["inbox"], "w1:p3").out).answers.map((a: any) => a.id)).toEqual([read, left]);
  expect(hud(["ack", `a:${read}`], "w1:p3").code).toBe(0);
  await world(ALL);
  const got = await typed("pm", `HUD answer #${left}`);
  expect(got).toHaveLength(1);
  expect(got[0]).toMatch(/^\(kept while you were busy; written at/);
  expect(nowhere("Read it in wait")).toEqual([]);
  hud(["ack", `a:${left}`], "w1:p3");
});

test("S8: kept for an away PM, a NOT YET and a later answer arrive in the order written; a NOT YET on a since-answered ask is dropped", async () => {
  const todo = ask("w1:p3", ["--kind", "action", "--lane", "child", "--title", "Order: record the demo"]);
  const pick = ask("w1:p3", ["--lane", "child", "--title", "Order: which logo", "--opt", "Round", "--opt", "Square"]);
  const done = ask("w1:p3", ["--kind", "action", "--lane", "child", "--title", "Order: sign the form"]);
  await world(ALL.filter((a) => a !== PM));
  await req(`/api/asks/${todo}/notyet`, { note: "tonight" });
  await answer(pick, "Round");
  await req(`/api/asks/${done}/notyet`, {});
  await answer(done, "done");
  await world(ALL);
  await typed("pm", `HUD answer #${done}`);
  const order = herdr.typedInto("pm").filter((t) => t.includes("Order: ")).map((t) => t.match(/HUD (answer|not yet) #(\d+)/)!.slice(1).join(" "));
  expect(order).toEqual([`not yet ${todo}`, `answer ${pick}`, `answer ${done}`]);
  for (const id of [pick, done]) hud(["ack", `a:${id}`], "w1:p3");
});

test("S9: a lane that cannot take it hands it to its floor's HQ, saying why: removed, moved away, gone long, refused", async () => {
  // removed while its answer is kept
  const a = ask("w1:p5", ["--lane", "child", "--title", "Removed asker", "--opt", "X", "--opt", "Y"]);
  await world(ALL.filter((x) => x !== PMA));
  await answer(a, "X");
  await Bun.sleep(300);
  expect(nowhere("Removed asker")).toEqual([]);
  await req("/api/lanes/delete", { name: "pm-a" });
  const toHq = await typed("hq", `HUD answer #${a}`);
  expect(toHq).toHaveLength(1);
  expect(toHq[0]).toContain("(for pm-a, which did not get it: it is no longer a lane)");
  // moved to another floor before the answer: the ask's floor's HQ gets it, the card is HQ's again
  const b = ask("w1:p6", ["--lane", "child", "--title", "Moved asker", "--opt", "X", "--opt", "Y"]);
  expect((await askers())[b]).toMatchObject({ name: "pm-b" });
  expect(hud(["lane", "pm-b", "--floor", "crm"], "w1:p1").code).toBe(0);
  expect((await askers())[b]).toBeUndefined();
  await answer(b, "Y");
  expect(await typed("hq", `HUD answer #${b}`)).toHaveLength(1);
  expect(nowhere(`HUD answer #${b}`)).toEqual(["hq"]);
  // gone longer than HUD_LANE_GONE_MS: what was kept goes to HQ at the next look, and a new answer goes there at once
  const c = ask("w1:p7", ["--lane", "child", "--title", "Gone asker kept", "--opt", "X", "--opt", "Y"]);
  const c2 = ask("w1:p7", ["--lane", "child", "--title", "Gone asker later", "--opt", "X", "--opt", "Y"]);
  await world(ALL.filter((x) => x !== PMC && x !== PMA));
  await answer(c, "X");
  await Bun.sleep(GONE_MS + 300);
  await sync();
  expect((await typed("hq", `HUD answer #${c}`))[0]).toMatch(/\(for pm-c, which did not get it: herdr has not seen it for \d+ min\)/);
  expect((await askers())[c2]).toBeUndefined();
  await answer(c2, "Y");
  expect(await typed("hq", `HUD answer #${c2}`)).toHaveLength(1);
  // herdr refuses (gone between syncs): HQ gets it with herdr's reason
  const d = ask("w1:p8", ["--lane", "child", "--title", "Refused asker", "--opt", "X", "--opt", "Y"]);
  herdr.world(ALL.filter((x) => x !== PMC && x !== PMA && x !== PMD));
  await answer(d, "X");
  expect((await typed("hq", `HUD answer #${d}`))[0]).toContain("(for pm-d, which did not get it: herdr could not type into it:");
  expect(nowhere(`HUD answer #${d}`)).toEqual(["hq"]);
  await world(ALL.filter((x) => x !== PMA));
  for (const id of [a, b, c, c2, d]) hud(["ack", `a:${id}`], "w1:p1");
}, 30_000);

test("S10: a lane acks only its own answers; HQ acks its lanes' too; an HQ registered as a lane stays HQ", async () => {
  const mine = ask("w1:p3", ["--lane", "child", "--title", "Ack mine", "--opt", "A", "--opt", "B"]);
  const hqs = ask("w1:p1", ["--lane", "child", "--title", "Ack HQ's", "--opt", "A", "--opt", "B"]);
  await answer(mine, "A");
  await answer(hqs, "A");
  await req("/api/notes", { text: "A note for HQ" });
  const note = (await req("/api/state")).notes.find((n: any) => n.text === "A note for HQ").id;
  expect(hud(["ack", `a:${hqs}`], "w1:p3").err).toContain(`answer ${hqs} is not yours (pm)`);
  expect(hud(["ack", `n:${note}`], "w1:p3").err).toContain(`note ${note} is for HQ, not for pm`);
  expect(hud(["ack", `a:${mine}`], "w1:p3").code).toBe(0);
  const other = ask("w1:p3", ["--lane", "child", "--title", "HQ acks it", "--opt", "A", "--opt", "B"]);
  await answer(other, "B");
  expect(hud(["ack", `a:${other}`], "w1:p1").code).toBe(0);
  // HQ registered as a lane (its rooms deliver to it): still HQ when it asks, reads and acks
  await req("/api/lanes", { name: "hq", machine: "local" });
  await sync();
  const own = ask("w1:p1", ["--title", "HQ as a lane asks", "--opt", "A", "--opt", "B"]);
  expect((await askers())[own]).toBeUndefined();
  await answer(own, "A");
  expect(await typed("hq", `HUD answer #${own}`)).toHaveLength(1);
  const box = JSON.parse(hud(["inbox"], "w1:p1").out);
  expect(box.answers.map((a: any) => a.id)).toEqual(expect.arrayContaining([hqs, own]));
  expect(box.notes.map((n: any) => n.id)).toContain(note);
  for (const r of [`a:${hqs}`, `a:${own}`, `n:${note}`]) expect(hud(["ack", r], "w1:p1").code).toBe(0);
  await req("/api/lanes/delete", { name: "hq" });
});

test("S12: a PM on another floor: typed into it, never into either HQ; its floor's HQ has it under forLanes", async () => {
  const id = ask("w1:p9", ["--lane", "pm-x", "--title", "CRM fields?", "--opt", "Few", "--opt", "Many"]);
  expect((await req("/api/state")).open.find((a: any) => a.id === id).floor).toBe("crm");
  await answer(id, "Few");
  expect(await typed("pm-x", `HUD answer #${id}`)).toHaveLength(1);
  expect(nowhere(`HUD answer #${id}`)).toEqual(["pm-x"]);
  expect(JSON.parse(hud(["inbox"], "w1:p2").out).forLanes.map((a: any) => a.id)).toContain(id);
  expect(JSON.parse(hud(["inbox"], "w1:p1").out).forLanes.map((a: any) => a.id)).not.toContain(id);
  hud(["ack", `a:${id}`], "w1:p9");
});

test("S13: hud tree says a lane waits on the lane it reports to, and on HQ under HQ", async () => {
  for (const q of (await req("/api/state")).open.filter((x: any) => x.lane === "child")) await req(`/api/asks/${q.id}/withdraw`, {}, "w1:p1");
  const tree = hud(["tree"], "w1:p1").out;
  expect(tree).toContain("└─ child  Lead · waiting on pm");
  expect(tree).toMatch(/pm {2}Manager · waiting on HQ/);
});

test("S11: a restart in the middle of a send keeps it, and it is sent once when herdr shows the lane", async () => {
  const id = ask("w1:p3", ["--lane", "child", "--title", "Restart mid-send", "--opt", "A", "--opt", "B"]);
  await world(ALL.filter((a) => a !== PM && a !== PMA));
  await answer(id, "A");
  await Bun.sleep(300);
  await server.stop();
  const db = new Database(join(DATA, "hud.db"));
  db.query("UPDATE lane_outbox SET delivery = 'sending' WHERE ref = ?").run(`ask:${id}`);
  db.close();
  server = await spawnServer({ cwd: ROOT, env });
  await sync();
  expect((await askers())[id]).toMatchObject({ delivery: "away" });
  await world(ALL.filter((a) => a !== PMA));
  expect(await typed("pm", `HUD answer #${id}`)).toHaveLength(1);
  await sync();
  expect(await typed("pm", `HUD answer #${id}`)).toHaveLength(1);
}, 30_000);
