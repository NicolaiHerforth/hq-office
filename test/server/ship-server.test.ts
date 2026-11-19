// SHIP on a real server (src/server/ship-server.ts, routes/ship.ts, docs/ship.md): filing with hud ship and with an ask
// that asks for a merge, GitHub read in one query and never while SHIP is empty, the sorter, the owner's MERGE, MERGE
// WHEN GREEN and SEND BACK, and what the filer hears. A stub gh answers from a JSON world (test/fake-gh-world.ts), a stub
// herdr records what is typed, and a stub model answers the sorter. Nothing reaches the real gh or a real agent.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr, type FakeAgent } from "../fake-herdr.ts";
import { fakeGhWorld, type World } from "../fake-gh-world.ts";
import { MOVED } from "../../src/server/ship-gh.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-ship-"));
const SECRET = "ship-secret-value-7q2w";
setDefaultTimeout(60_000);

const agent = (name: string, pane: string): FakeAgent => ({ name, agent_status: "idle", pane_id: pane, agent: "claude" });
const sha = (n: number, v = 1) => `${String(n).padStart(4, "0")}${"f".repeat(35)}${v}`;
const pr = (n: number, o: Record<string, any> = {}) => ({ title: `PR ${n}`, branch: `fix-${n}`, sha: sha(n), checks: "SUCCESS", files: [`src/f${n}.ts`], body: `body of ${n}`, ...o });
const WORLD: World = {
  repos: {
    "acme/web": { methods: ["merge", "rebase"], autoMergeAllowed: true, prs: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i + 1), pr(i + 1)])) },
    "acme/api": { methods: ["squash", "merge"], autoMergeAllowed: false, prs: { "7": pr(7), "8": pr(8, { body: `uses ${SECRET} to log in`, title: `rotate ${SECRET}` }) } },
  },
};
const link = (n: number, repo = "acme/web") => `https://github.com/${repo}/pull/${n}`;

// The sorter's stand-in: it keeps every prompt, and answers from answer.json, by repo#number, or with its raw text.
function sampler(dir: string) {
  mkdirSync(join(dir, "prompts"), { recursive: true });
  const script = join(dir, "sort.js");
  writeFileSync(script, `const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "prompts"))} + "/" + Date.now() + "-" + process.pid, prompt);
const a = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "answer.json"))}, "utf8"));
if (a.raw !== undefined) { process.stdout.write(a.raw); process.exit(0); }
const out = [...prompt.matchAll(/^### id (\\d+): (\\S+)$/gm)].filter((m) => a[m[2]]).map((m) => ({ id: Number(m[1]), ...a[m[2]] }));
process.stdout.write("Here you go:\\n\`\`\`json\\n" + JSON.stringify(out) + "\\n\`\`\`\\n");
`);
  const answer = (a: object) => writeFileSync(join(dir, "answer.json"), JSON.stringify(a));
  answer({});
  const prompts = () => readdirSync(join(dir, "prompts")).sort().map((f) => readFileSync(join(dir, "prompts", f), "utf8"));
  return { cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, answer, prompts };
}

async function boot(name: string, extra: Record<string, string>) {
  const dir = join(DATA, name);
  mkdirSync(join(dir, "gh"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "subs"), { recursive: true });
  const herdr = fakeHerdr(join(dir, "herdr"), [agent("hq", "w1:p1"), agent("fixer", "w1:p2"), agent("hq-crm", "w1:p3"), agent("helper", "w1:p4")]);
  const gh = fakeGhWorld(join(dir, "gh"), WORLD);
  const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: join(dir, "data"), HERDR_BIN: herdr.bin, HUD_GH_BIN: gh.bin, HUD_SUBS_HOME: join(dir, "subs"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_OWNER: "Sam", HUD_SAMPLE_CMD: "", ...extra };
  let server = await spawnServer({ cwd: ROOT, env });
  const headers = (pane?: string, more: Record<string, string> = {}) => ({ "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}), ...more });
  const req = async (p: string, b?: object, pane?: string, more?: Record<string, string>) => {
    const r = await fetch(`${server.base}${p}`, b ? { method: "POST", headers: headers(pane, more), body: JSON.stringify(b) } : { headers: headers(pane, more) });
    return { status: r.status, ...(await r.json()) };
  };
  const hud = (args: string[], pane = "") => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), code: p.exitCode };
  };
  const state = async () => (await req("/api/state")).ship;
  const until = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
      const v = await fn();
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  // The owner's page: same origin, no pane.
  const page = (p: string, b: object) => req(p, b, undefined, { origin: server.base, "sec-fetch-site": "same-origin" });
  // Killed at once (no clean exit), then started again on the same data and the same fake GitHub; while it is down,
  // meanwhile() changes the world.
  const restart = async (meanwhile: () => unknown = () => {}) => {
    server.kill("SIGKILL");
    await server.stop();
    await meanwhile();
    server = await spawnServer({ cwd: ROOT, env });
  };
  await req("/api/sync", {});
  return { get server() { return server; }, herdr, gh, req, page, hud, state, until, restart };
}
type Box = Awaited<ReturnType<typeof boot>>;

describe("SHIP, with a model to sort and the 5-minute poll", () => {
  let s: Box;
  const model = sampler(join(DATA, "model"));
  const page = (p: string, b: object) => s.page(p, b);
  const itemOf = async (repo: string, n: number) => (await s.state()).items.find((i: any) => i.repo === repo && i.number === n);
  const read = (repo: string, n: number) => s.until(`${repo}#${n} read`, async () => (await itemOf(repo, n))?.gh && (await itemOf(repo, n)));
  const sorted = (repo: string, n: number) => s.until(`${repo}#${n} sorted`, async () => (await itemOf(repo, n))?.sorted && (await itemOf(repo, n)));
  const typed = (name: string, part: string) => s.until(`"${part}" typed into ${name}`, async () => s.herdr.typedInto(name).find((t) => t.includes(part)));

  beforeAll(async () => {
    s = await boot("main", { HUD_SAMPLE_CMD: model.cmd, HUD_SHIP_SORT_MS: "300" });
    await s.req("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
    await s.req("/api/lanes", { name: "fixer", machine: "local" });
    await s.req("/api/lanes", { name: "helper", machine: "local" });
    await s.req("/api/sync", {});
    await s.req("/api/secrets", { name: "SHIP_TOKEN", value: SECRET, minutes: 60, by: "owner" });
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("nothing in SHIP: gh is never run", async () => {
    await Bun.sleep(2500);
    expect(await s.state()).toEqual({ sampler: true, items: [], done: [] });
    expect(s.gh.calls()).toEqual([]);
  });

  test("a lane files its own PR; filing it again updates the one item", async () => {
    const first = s.hud(["ship", link(1), "--note", "fixes the **login**"], "w1:p2");
    expect(first).toMatchObject({ code: 0, out: "filed acme/web#1 in MERGE on floor hq" });
    const again = s.hud(["ship", `${link(1)}/files`, "--urgent", "users cannot log in"], "w1:p2");
    expect(again).toMatchObject({ code: 0, out: "updated acme/web#1 in MERGE on floor hq" });
    const it = await read("acme/web", 1);
    expect(it).toMatchObject({ lane: "fixer", filer: "fixer", floor: "hq", note: "fixes the **login**", urgency: "URGENT", why: "users cannot log in", url: link(1), gh: { title: "PR 1", sha: sha(1), checks: "passing", methods: ["merge", "rebase"], autoMergeAllowed: true } });
    expect((await s.state()).items.filter((i: any) => i.number === 1 && i.repo === "acme/web")).toHaveLength(1);
  });

  test("HQ files a lane's PR with --lane; another floor's HQ files on its floor; hud refuses --urgent without a reason", async () => {
    expect(s.hud(["ship", link(2), "--lane", "helper"], "w1:p1").out).toBe("filed acme/web#2 in MERGE on floor hq");
    expect(s.hud(["ship", link(3)], "w1:p3").out).toBe("filed acme/web#3 in MERGE on floor crm");
    expect(await itemOf("acme/web", 2)).toMatchObject({ lane: "helper", filer: null, floor: "hq" });
    expect(await itemOf("acme/web", 3)).toMatchObject({ lane: null, filer: null, floor: "crm" });
    const bad = s.hud(["ship", link(4), "--urgent"], "w1:p1");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("--urgent WHY");
    expect(s.hud(["ship", "https://github.com/acme/web/issues/4"], "w1:p1")).toMatchObject({ code: 2, err: expect.stringContaining("not a GitHub PR link") });
  });

  test("an ask with five PR links that asks for a merge files five items in one GitHub read, and makes no ask", async () => {
    await Bun.sleep(2500);
    const before = s.gh.reads().length;
    const body = [10, 11, 12, 13].map((n) => link(n)).concat(link(7, "acme/api")).join("\n");
    const r = s.hud(["ask", "--kind", "action", "--title", "Please merge tonight's fixes", "--body", body], "w1:p1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("goes to the MERGE tab, not NEEDS YOU");
    expect(r.out.split("\n").filter((l) => l.startsWith("filed "))).toEqual([10, 11, 12, 13].map((n) => `filed acme/web#${n} in MERGE on floor hq`).concat("filed acme/api#7 in MERGE on floor hq"));
    for (const n of [10, 11, 12, 13]) expect(await read("acme/web", n)).toMatchObject({ note: `Please merge tonight's fixes\n\n${body}`, filer: null });
    await read("acme/api", 7);
    const reads = s.gh.reads().slice(before);
    expect(reads).toHaveLength(1);
    for (const n of [10, 11, 12, 13]) expect(reads[0][3]).toContain(`pullRequest(number: ${n})`);
    expect((await s.req("/api/state")).open.filter((a: any) => a.title.includes("tonight"))).toEqual([]);
  });

  test("only an ask whose title says merge, that links a PR and carries nothing else to answer, goes to SHIP; every other stays an ask", async () => {
    const asks = [
      ["--title", "Is this design right?", "--body", link(20)],
      ["--title", `merge ${link(21)}`, "--item", "check the docs"],
      ["--title", "Roll back or hotfix?", "--body", `After ${link(25)} merged, login broke`, "--opt", "rollback", "--opt", "hotfix"],
      ["--title", "Should I merge #26 or #27?", "--body", `${link(26)}\n${link(27)}`, "--opt", "#26", "--opt", "#27"],
      ["--title", `Merge ${link(28)} once the key is in`, "--secret", "DEPLOY_KEY"],
      ["--title", "Ready to go?", "--body", `Please merge ${link(29)}`],
    ];
    for (const a of asks) expect(s.hud(["ask", ...a], "w1:p1")).toMatchObject({ code: 0, out: expect.stringMatching(/^ask #\d+$/) });
    const page = await s.req("/api/asks", { title: `Merge ${link(39)}?`, file: "<!doctype html><title>pick</title><p>which one</p>" }, "w1:p1");
    expect(page).toMatchObject({ status: 200, id: expect.any(Number), page: expect.any(String) });
    const titles = (await s.req("/api/state")).open.map((a: any) => a.title);
    for (const t of ["Is this design right?", `merge ${link(21)}`, "Roll back or hotfix?", "Should I merge #26 or #27?", `Merge ${link(28)} once the key is in`, "Ready to go?", `Merge ${link(39)}?`]) expect(titles).toContain(t);
    for (const n of [20, 21, 25, 26, 27, 28, 29, 39]) expect(await itemOf("acme/web", n)).toBeUndefined();
    // The title says merge, the body links the PR, nothing else to answer: SHIP.
    expect(s.hud(["ask", "--title", "Merge this?", "--body", link(29)], "w1:p1")).toMatchObject({ code: 0, out: expect.stringContaining("filed acme/web#29 in MERGE on floor hq") });
  });

  test("the sorter: the model's domains and urgency, the domains in use in its prompt, --urgent over LOW, masked secrets, nonsense falls back", async () => {
    model.answer({ "acme/api#8": { domain: "Auth  Service", urgency: "low", why: null }, "acme/web#22": { domain: "billing", urgency: "URGENT", why: "invoices fail" } });
    s.hud(["ship", link(8, "acme/api"), "--urgent", "the token leaked"], "w1:p1");
    s.hud(["ship", link(22)], "w1:p1");
    expect(await sorted("acme/api", 8)).toMatchObject({ domain: "auth service", urgency: "URGENT", why: "the token leaked" });
    expect(await sorted("acme/web", 22)).toMatchObject({ domain: "billing", urgency: "URGENT", why: "invoices fail" });
    const prompt = model.prompts().find((p) => p.includes("acme/api#8"))!;
    expect(prompt).toContain("rotate [secret SHIP_TOKEN]");
    expect(prompt).toContain("uses [secret SHIP_TOKEN] to log in");
    expect(prompt).toContain("src/f8.ts");
    expect(prompt).not.toContain(SECRET);

    model.answer({ "acme/web#23": { domain: "growth", urgency: "NORMAL", why: null } });
    s.hud(["ship", link(23)], "w1:p1");
    await sorted("acme/web", 23);
    expect(model.prompts().find((p) => p.includes("acme/web#23"))).toMatch(/Domains already in use: .*billing/);

    model.answer({ raw: "I would rather not." });
    s.hud(["ship", link(24)], "w1:p1");
    expect(await sorted("acme/web", 24)).toMatchObject({ domain: "web", urgency: "NORMAL", why: null });
    expect(JSON.stringify(await s.req("/api/state"))).not.toContain(SECRET);
  });

  test("MERGE: read again first, merged with the repo's method and the head the page showed; the lane and MESSAGES hear it", async () => {
    s.hud(["ship", link(30)], "w1:p2");
    const it = await read("acme/web", 30);
    const r = await page("/api/ship/merge", { items: [{ id: it.id, sha: sha(30) }] });
    expect(r).toMatchObject({ status: 200, results: [{ id: it.id, ok: true, merged: true }] });
    expect(s.gh.merges().at(-1)).toEqual(["pr", "merge", "30", "--repo", "acme/web", "--merge", "--match-head-commit", sha(30)]);
    expect(await itemOf("acme/web", 30)).toBeUndefined();
    expect(await typed("fixer", "HUD SHIP: merged acme/web#30 (PR 30)")).toBeTruthy();
    const st = await s.req("/api/state");
    expect(st.updates.find((u: any) => u.title === "MERGE: merged acme/web#30 (PR 30)")).toMatchObject({ lane: "fixer", body: link(30), read_at: expect.any(Number) });
  });

  test("a PR pushed to since the owner looked, or with failing checks, is not merged; a merge gh refuses stays and says why", async () => {
    for (const n of [31, 32, 33]) s.hud(["ship", link(n)], "w1:p1");
    const [a, b, c] = [await read("acme/web", 31), await read("acme/web", 32), await read("acme/web", 33)];
    s.gh.setPr("acme/web", 31, { sha: sha(31, 2) });
    s.gh.setPr("acme/web", 32, { checks: "FAILURE" });
    s.gh.setPr("acme/web", 33, { unmergeable: "GraphQL: Pull request is in unstable status (mergePullRequest)" });
    const merges = s.gh.merges().length;
    const r = await page("/api/ship/merge", { items: [{ id: a.id, sha: sha(31) }, { id: b.id, sha: sha(32) }, { id: c.id, sha: sha(33) }] });
    expect(r.results).toEqual([
      { id: a.id, ok: false, error: "Not merged: new commits came in while it waited here, and a merge only takes what this page showed you." },
      { id: b.id, ok: false, error: "checks failing" },
      { id: c.id, ok: false, error: "Not merged: some checks on it are not passing." },
    ]);
    expect(s.gh.merges().slice(merges).map((m) => m[2])).toEqual(["33"]);
    expect(await itemOf("acme/web", 31)).toMatchObject({ gh: { sha: sha(31, 2) }, mergeError: MOVED });
    expect(await itemOf("acme/web", 33)).toMatchObject({ mergeError: "Not merged: some checks on it are not passing." });
  });

  test("MERGE WHEN CHECKS PASS: auto-merge on, the item stays; when GitHub merges it later the filer hears and MESSAGES has it unread", async () => {
    s.gh.setPr("acme/web", 34, { checks: "PENDING" });
    s.hud(["ship", link(34)], "w1:p2");
    const it = await read("acme/web", 34);
    const r = await page("/api/ship/merge", { items: [{ id: it.id, sha: sha(34), auto: true }] });
    expect(r.results).toEqual([{ id: it.id, ok: true, queued: true }]);
    expect(s.gh.merges().at(-1)).toEqual(["pr", "merge", "34", "--repo", "acme/web", "--merge", "--match-head-commit", sha(34), "--auto"]);
    expect(await itemOf("acme/web", 34)).toMatchObject({ gh: { autoMerge: true } });
    s.gh.setPr("acme/web", 34, { state: "MERGED" });
    s.hud(["ship", link(35)], "w1:p1");
    expect(await typed("fixer", "HUD SHIP: merged acme/web#34 (PR 34)")).toBeTruthy();
    const st = await s.req("/api/state");
    expect(st.ship.items.some((i: any) => i.number === 34)).toBe(false);
    expect(st.updates.find((u: any) => u.title === "MERGE: merged acme/web#34 (PR 34)")).toMatchObject({ read_at: null });
  });

  test("merged or closed on GitHub by someone else: it leaves SHIP, and nobody is told", async () => {
    s.hud(["ship", link(36)], "w1:p2");
    await read("acme/web", 36);
    s.gh.setPr("acme/web", 36, { state: "CLOSED" });
    s.hud(["ship", link(37)], "w1:p1");
    await s.until("#36 gone", async () => !(await itemOf("acme/web", 36)));
    await Bun.sleep(500);
    expect(s.herdr.typed().filter(([, t]) => t.includes("acme/web#36"))).toEqual([]);
  });

  test("only the owner's page merges or sends back: hud's POST, an agent's pane and another site are refused", async () => {
    const it = await read("acme/web", 37);
    const merges = s.gh.merges().length;
    const no = "only the owner merges, from the HUD's page";
    expect(await s.req("/api/ship/merge", { items: [{ id: it.id, sha: sha(37) }] }, "w1:p1")).toEqual({ status: 400, error: no });
    expect(await s.req("/api/ship/merge", { items: [{ id: it.id, sha: sha(37) }] })).toEqual({ status: 400, error: no });
    expect(await s.req("/api/ship/merge", { items: [{ id: it.id, sha: sha(37) }] }, "w1:p1", { origin: s.server.base })).toEqual({ status: 400, error: no });
    expect(await s.req("/api/ship/merge", { items: [{ id: it.id, sha: sha(37) }] }, undefined, { origin: s.server.base, "sec-fetch-site": "cross-site" })).toEqual({ status: 400, error: no });
    expect(await s.req(`/api/ship/${it.id}/back`, { note: "no" })).toEqual({ status: 400, error: "only the owner sends a PR back, from the HUD's page" });
    expect(s.gh.merges().length).toBe(merges);
    expect(await itemOf("acme/web", 37)).toBeTruthy();
  });

  test("SEND BACK: a lane's PR goes back to the lane's pane, HQ's to HQ; the item leaves until it is filed again", async () => {
    s.hud(["ship", link(38)], "w1:p2");
    const lanes = await read("acme/web", 38);
    const hqs = await read("acme/web", 37);
    expect(await page(`/api/ship/${lanes.id}/back`, { note: "add a test first" })).toMatchObject({ status: 200 });
    expect(await page(`/api/ship/${hqs.id}/back`, { note: "split it in two" })).toMatchObject({ status: 200 });
    expect(await typed("fixer", "HUD SHIP: sent back acme/web#38: add a test first")).toBeTruthy();
    expect(await typed("hq", "HUD SHIP: sent back acme/web#37: split it in two")).toBeTruthy();
    expect(s.herdr.typedInto("hq").some((t) => t.includes("acme/web#38"))).toBe(false);
    expect(await itemOf("acme/web", 38)).toBeUndefined();
    expect(s.hud(["ship", link(38)], "w1:p2").out).toBe("filed acme/web#38 in MERGE on floor hq");
    expect(await itemOf("acme/web", 38)).toMatchObject({ id: lanes.id, sorted: expect.any(Boolean) });
  });

  test("a page opening SHIP reads GitHub at most every 30 s", async () => {
    expect(await s.req("/api/ship/look", {})).toEqual({ status: 200, reading: true });
    expect(await s.req("/api/ship/look", {})).toEqual({ status: 200, reading: false });
  });

  test("a floor with a PR in MERGE cannot be removed; once it has left, the floor goes and its DONE moves to the first floor", async () => {
    expect(s.hud(["ship", link(40)], "w1:p3").out).toBe("filed acme/web#40 in MERGE on floor crm");
    const on = (await s.state()).items.filter((i: any) => i.floor === "crm");
    expect(await s.req("/api/floors/crm", { rm: true })).toMatchObject({ status: 400, error: expect.stringContaining(`${on.length} PRs in MERGE`) });
    expect(await itemOf("acme/web", 40)).toMatchObject({ floor: "crm" });
    for (const it of on) expect(await page(`/api/ship/${it.id}/back`, { note: "not on this floor" })).toMatchObject({ status: 200 });
    expect(await s.req("/api/floors/crm", { rm: true })).toMatchObject({ status: 200 });
    const done = (await s.state()).done.filter((d: any) => on.some((i: any) => i.id === d.id));
    expect(done.map((d: any) => [d.how, d.floor])).toEqual(on.map(() => ["back", "hq"]));
  });
});

describe("a sorter that hangs", () => {
  let s: Box;
  const dir = join(DATA, "hang-model");
  const model = sampler(dir);
  const itemOf = async (n: number) => (await s.state()).items.find((i: any) => i.repo === "acme/web" && i.number === n);
  const sorted = (n: number) => s.until(`acme/web#${n} sorted`, async () => (await itemOf(n))?.sorted && (await itemOf(n)), 6000);
  beforeAll(async () => {
    const cmd = `if [ -f ${join(dir, "hang")} ]; then rm -f ${join(dir, "hang")}; sleep 8 & sleep 30; else ${model.cmd}; fi`;
    s = await boot("hang", { HUD_SAMPLE_CMD: cmd, HUD_SHIP_SORT_MS: "200", HUD_SHIP_SORT_TIMEOUT_MS: "800" });
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("is stopped at its time: its batch falls back to the repo's name, and the next batch is sorted by the model without a restart", async () => {
    writeFileSync(join(dir, "hang"), "");
    s.hud(["ship", link(1)], "w1:p1");
    expect(await sorted(1)).toMatchObject({ domain: "web", urgency: "NORMAL" });
    model.answer({ "acme/web#2": { domain: "billing", urgency: "NORMAL", why: null } });
    s.hud(["ship", link(2)], "w1:p1");
    expect(await sorted(2)).toMatchObject({ domain: "billing" });
  });
});

describe("SHIP with no model and a short poll", () => {
  let s: Box;
  beforeAll(async () => {
    s = await boot("poll", { HUD_SHIP_POLL_MS: "400" });
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("empty: no gh call over several poll intervals", async () => {
    await Bun.sleep(1500);
    expect(s.gh.calls()).toEqual([]);
  });

  test("no model: sorted at once by repo name, NORMAL", async () => {
    s.hud(["ship", link(5)], "w1:p1");
    const it = (await s.state()).items[0];
    expect(it).toMatchObject({ domain: "web", urgency: "NORMAL", sorted: true });
    expect((await s.state()).sampler).toBe(false);
  });

  test("a read that finds nothing new pushes nothing to the pages; one that does pushes", async () => {
    const shipBumps = async () => (await s.req("/api/push")).bumps["SHIP read GitHub"] ?? 0;
    await s.until("the first read", async () => (await s.state()).items[0]?.gh);
    const before = await shipBumps();
    expect(before).toBeGreaterThan(0);
    const reads = s.gh.reads().length;
    await s.until("three more reads", async () => s.gh.reads().length >= reads + 3);
    expect(await shipBumps()).toBe(before);
    s.gh.setPr("acme/web", 5, { checks: "FAILURE" });
    await s.until("the change read", async () => (await s.state()).items[0]?.gh?.checks === "failing");
    expect(await shipBumps()).toBe(before + 1);
  });

  test("the poll reads while something is open, and stops once nothing is", async () => {
    await s.until("three reads", async () => s.gh.reads().length >= 3);
    const it = (await s.state()).items[0];
    await s.req(`/api/ship/${it.id}/back`, { note: "not now" }, undefined, { origin: s.server.base });
    await Bun.sleep(300);
    const after = s.gh.reads().length;
    await Bun.sleep(1500);
    expect(s.gh.reads().length).toBe(after);
  });
});

describe("UNDO's hold, the group rule, MESSAGES and DONE", () => {
  let s: Box;
  const itemOf = async (n: number) => (await s.state()).items.find((i: any) => i.repo === "acme/web" && i.number === n);
  const read = (n: number) => s.until(`acme/web#${n} read`, async () => (await itemOf(n))?.gh && (await itemOf(n)));
  const gone = (n: number) => s.until(`acme/web#${n} gone`, async () => !(await itemOf(n)));
  const doneOf = async (n: number) => (await s.state()).done.find((d: any) => d.number === n);
  const merges = (n: number) => s.gh.merges().filter((m) => m[2] === String(n));
  const updates = async () => (await s.req("/api/state")).updates as any[];
  const file = (n: number, pane = "w1:p2") => (s.hud(["ship", link(n)], pane), read(n));

  beforeAll(async () => {
    s = await boot("hold", { HUD_SHIP_HOLD_MS: "300" });
    await s.req("/api/lanes", { name: "fixer", machine: "local" });
    await s.req("/api/sync", {});
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("a held MERGE runs after the hold, once, though the page pressed twice; MESSAGES and DONE have it", async () => {
    const it = await file(1);
    const first = await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(1) });
    expect(first).toEqual({ status: 200, until: expect.any(Number), now: expect.any(Number) });
    expect(await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(1) })).toEqual({ ...first, now: expect.any(Number) });
    expect((await itemOf(1)).hold).toEqual({ verb: "merge", until: first.until, note: null });
    expect(merges(1)).toEqual([]);
    await gone(1);
    await Bun.sleep(600);
    expect(merges(1)).toEqual([["pr", "merge", "1", "--repo", "acme/web", "--merge", "--match-head-commit", sha(1)]]);
    expect(await doneOf(1)).toEqual({ id: it.id, floor: "hq", repo: "acme/web", number: 1, url: link(1), lane: "fixer", title: "PR 1", how: "merged", at: expect.any(Number), note: null });
    expect((await updates()).filter((u) => u.title === "MERGE: merged acme/web#1 (PR 1)")).toMatchObject([{ lane: "fixer", read_at: expect.any(Number) }]);
    expect(await s.until("the filer told", async () => s.herdr.typedInto("fixer").find((t) => t.includes("HUD SHIP: merged acme/web#1 (PR 1)")))).toBeTruthy();
    expect(await s.page(`/api/ship/${it.id}/undo`, {})).toEqual({ status: 200, undone: false, why: "it is merged already: a merge cannot be taken back", now: expect.any(Number) });
  });

  test("UNDO inside the hold: nothing reaches GitHub, and the PR stays as it was", async () => {
    const it = await file(2);
    await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(2) });
    expect(await s.page(`/api/ship/${it.id}/undo`, {})).toEqual({ status: 200, undone: true, now: expect.any(Number) });
    await Bun.sleep(900);
    expect(merges(2)).toEqual([]);
    expect(await itemOf(2)).toMatchObject({ hold: null, mergeError: null });
    expect(await s.page(`/api/ship/${it.id}/undo`, {})).toEqual({ status: 200, undone: false, why: "nothing to undo: it was not held", now: expect.any(Number) });
  });

  test("a head that moved during the hold is not merged, and the PR says so in the owner's words", async () => {
    const it = await file(3);
    await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(3) });
    s.gh.setPr("acme/web", 3, { sha: sha(3, 2) });
    const after = await s.until("the hold ran", async () => {
      const x = await itemOf(3);
      return x && !x.hold && x;
    });
    expect(after).toMatchObject({ mergeError: MOVED, gh: { sha: sha(3, 2) } });
    expect(merges(3)).toEqual([]);
  });

  test("a held MERGE WHEN CHECKS PASS turns auto-merge on; a held SEND BACK sends the note; a press the PR does not allow is refused", async () => {
    s.gh.setPr("acme/web", 4, { checks: "PENDING" });
    const a = await file(4);
    expect(await s.page(`/api/ship/${a.id}/hold`, { verb: "merge", sha: sha(4) })).toEqual({ status: 400, error: "its checks are still running: MERGE WHEN CHECKS PASS" });
    await s.page(`/api/ship/${a.id}/hold`, { verb: "auto", sha: sha(4) });
    expect(await s.page(`/api/ship/${a.id}/hold`, { verb: "back", note: "no" })).toEqual({ status: 400, error: "acme/web#4 is held to merge when its checks pass already: UNDO it first" });
    await s.until("auto-merge on", async () => (await itemOf(4))?.gh?.autoMerge && !(await itemOf(4)).hold);
    expect(merges(4)).toEqual([["pr", "merge", "4", "--repo", "acme/web", "--merge", "--match-head-commit", sha(4), "--auto"]]);

    const b = await file(5);
    expect(await s.page(`/api/ship/${b.id}/hold`, { verb: "back", note: " " })).toMatchObject({ status: 400, error: expect.stringContaining("say why it goes back") });
    await s.page(`/api/ship/${b.id}/hold`, { verb: "back", note: "add a test first" });
    expect((await itemOf(5)).hold).toEqual({ verb: "back", until: expect.any(Number), note: "add a test first" });
    await gone(5);
    expect(await s.until("the filer told", async () => s.herdr.typedInto("fixer").find((t) => t.includes("HUD SHIP: sent back acme/web#5: add a test first")))).toBeTruthy();
    expect(await doneOf(5)).toMatchObject({ how: "back", note: "add a test first", title: "PR 5" });
  });

  test("merged on GitHub without the owner's press: in DONE as merged there", async () => {
    await file(6);
    s.gh.setPr("acme/web", 6, { state: "MERGED" });
    await file(7);
    await gone(6);
    expect(await doneOf(6)).toMatchObject({ how: "self", title: "PR 6" });
  });

  test("a group never merges a PR no checks ran on; that one merges alone; a group's merge is one line in MESSAGES", async () => {
    s.gh.setPr("acme/web", 10, { checks: null });
    const [a, b, c] = [await file(10), await file(11), await file(12)];
    const r = await s.page("/api/ship/merge", { items: [{ id: a.id, sha: sha(10) }, { id: b.id, sha: sha(11) }, { id: c.id, sha: sha(12) }] });
    expect(r.results).toEqual([
      { id: a.id, ok: false, error: "no checks ran on it: it merges only by its own button" },
      { id: b.id, ok: true, merged: true },
      { id: c.id, ok: true, merged: true },
    ]);
    expect(merges(10)).toEqual([]);
    const group = (await updates()).filter((u) => u.title === "MERGE: merged 2 in web");
    expect(group).toEqual([expect.objectContaining({ lane: "fixer", read_at: expect.any(Number), body: `- [acme/web#11](${link(11)}) PR 11\n- [acme/web#12](${link(12)}) PR 12` })]);
    expect((await updates()).filter((u) => /acme\/web#1[12] /.test(u.title))).toEqual([]);

    expect(await s.page(`/api/ship/${a.id}/hold`, { verb: "merge", sha: sha(10) })).toEqual({ status: 400, error: "no checks ran on it: it merges only by its own button" });
    expect((await s.page("/api/ship/merge", { kind: "one", items: [{ id: a.id, sha: sha(10) }] })).results).toEqual([{ id: a.id, ok: true, merged: true }]);
    expect((await updates()).filter((u) => u.title === "MERGE: merged acme/web#10 (PR 10)")).toHaveLength(1);
  });

  test("a group of one is a group: a PR no checks ran on merges only when the page says it is one press, and one press is one PR", async () => {
    s.gh.setPr("acme/web", 15, { checks: null });
    const [a, b] = [await file(15), await file(16)];
    const noChecks = [{ id: a.id, ok: false, error: "no checks ran on it: it merges only by its own button" }];
    for (const kind of [undefined, "group", "all"]) {
      expect([kind, (await s.page("/api/ship/merge", { kind, items: [{ id: a.id, sha: sha(15) }] })).results]).toEqual([kind, noChecks]);
    }
    expect(await s.page("/api/ship/merge", { kind: "one", items: [{ id: a.id, sha: sha(15) }, { id: b.id, sha: sha(16) }] })).toEqual({ status: 400, error: "one press merges one PR: this asked for 2" });
    expect([merges(15), merges(16)]).toEqual([[], []]);
    expect((await s.page("/api/ship/merge", { kind: "one", items: [{ id: a.id, sha: sha(15) }] })).results).toEqual([{ id: a.id, ok: true, merged: true }]);
    expect(merges(15)).toHaveLength(1);
  });

  test("a held PR is not merged or sent back at once: the hold decides", async () => {
    const it = await file(13);
    await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(13) });
    expect((await s.page("/api/ship/merge", { items: [{ id: it.id, sha: sha(13) }] })).results).toEqual([{ id: it.id, ok: false, error: "it is held: UNDO it, or let it run" }]);
    expect(await s.page(`/api/ship/${it.id}/back`, { note: "no" })).toEqual({ status: 400, error: "it is held: UNDO it, or let it run" });
    await gone(13);
    expect(merges(13)).toHaveLength(1);
  });

  test("only the owner's page holds or takes back a press", async () => {
    const it = await file(14);
    for (const [pane, more] of [["w1:p1", {}], [undefined, {}], [undefined, { origin: s.server.base, "sec-fetch-site": "cross-site" }]] as const) {
      expect(await s.req(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(14) }, pane, more)).toEqual({ status: 400, error: "only the owner merges, from the HUD's page" });
      expect(await s.req(`/api/ship/${it.id}/hold`, { verb: "back", note: "x" }, pane, more)).toEqual({ status: 400, error: "only the owner sends a PR back, from the HUD's page" });
      expect(await s.req(`/api/ship/${it.id}/undo`, {}, pane, more)).toEqual({ status: 400, error: "only the owner takes a press back, from the HUD's page" });
    }
    expect((await itemOf(14)).hold).toBeNull();
  });
});

describe("a merge that takes a while", () => {
  let s: Box;
  const itemOf = async (n: number) => (await s.state()).items.find((i: any) => i.repo === "acme/web" && i.number === n);
  const read = (n: number) => s.until(`acme/web#${n} read`, async () => (await itemOf(n))?.gh && (await itemOf(n)));
  beforeAll(async () => {
    s = await boot("slow", { HUD_SHIP_POLL_MS: "300" });
    await s.req("/api/lanes", { name: "fixer", machine: "local" });
    await s.req("/api/sync", {});
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("a PR found merged by a read while gh merges it is the owner's merge; presses on PRs being merged wait; the group goes on", async () => {
    s.hud(["ship", link(1)], "w1:p2");
    s.hud(["ship", link(2)], "w1:p2");
    const [a, b] = [await read(1), await read(2)];
    s.gh.setPr("acme/web", 1, { mergeSlowMs: 2500 });
    const group = s.page("/api/ship/merge", { items: [{ id: a.id, sha: sha(1) }, { id: b.id, sha: sha(2) }] });
    await s.until("a read found #1 merged on GitHub", async () => !(await itemOf(1)));
    const being = "it is being merged now: wait for it to finish";
    expect(await s.page(`/api/ship/${b.id}/back`, { note: "not this one" })).toEqual({ status: 400, error: being });
    expect(await s.page(`/api/ship/${b.id}/hold`, { verb: "merge", sha: sha(2) })).toEqual({ status: 400, error: being });
    expect((await s.page("/api/ship/merge", { items: [{ id: b.id, sha: sha(2) }] })).results).toEqual([{ id: b.id, ok: false, error: being }]);
    expect(await group).toEqual({ status: 200, results: [{ id: a.id, ok: true, merged: true }, { id: b.id, ok: true, merged: true }] });
    expect(s.gh.merges().map((m) => m[2])).toEqual(["1", "2"]);
    const st = await s.req("/api/state");
    expect(st.ship.done.filter((d: any) => d.number === 1 || d.number === 2).map((d: any) => [d.number, d.how]).sort()).toEqual([[1, "merged"], [2, "merged"]]);
    expect(st.updates.filter((u: any) => u.title === "MERGE: merged 2 in web")).toHaveLength(1);
    await s.until("the filer told", async () => s.herdr.typedInto("fixer").find((t) => t.includes("HUD SHIP: merged acme/web#2")));
    await Bun.sleep(500);
    expect(s.herdr.typedInto("fixer").filter((t) => t.includes("HUD SHIP: merged acme/web#1 "))).toHaveLength(1);
  });
});

describe("a hold across a restart", () => {
  let s: Box;
  const itemOf = async (n: number) => (await s.state()).items.find((i: any) => i.repo === "acme/web" && i.number === n);
  const merges = (n: number) => s.gh.merges().filter((m) => m[2] === String(n));
  beforeAll(async () => {
    s = await boot("restart", { HUD_SHIP_HOLD_MS: "2000" });
    await s.req("/api/lanes", { name: "fixer", machine: "local" });
    await s.req("/api/sync", {});
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("UNDO's clock is the server's: the hold's and UNDO's answers say now, S.shipNow is the server's now while a hold exists, and no push carries it otherwise", async () => {
    const sent: any[] = [];
    const reader = (await fetch(`${s.server.base}/api/stream`)).body!.getReader();
    let buf = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) if (buf.startsWith("data: ")) sent.push(JSON.parse(buf.slice(6, i)));
      }
    })().catch(() => {});
    const pushedRead = (n: number, from: number) => s.until(`#${n} read and pushed`, async () => sent.slice(from).some((m) => m.ship?.items?.some((i: any) => i.number === n && i.gh)));
    try {
      await s.until("the whole state", async () => sent.length >= 1);
      expect(sent[0].shipNow).toBeNull();
      // no hold: a push about SHIP says nothing of the clock
      s.hud(["ship", link(3)], "w1:p2");
      await pushedRead(3, 1);
      expect(sent.slice(1).filter((m) => "shipNow" in m)).toEqual([]);
      expect((await s.req("/api/state")).shipNow).toBeNull();

      const it = await itemOf(3);
      const held = await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(3) });
      expect(held).toEqual({ status: 200, until: expect.any(Number), now: expect.any(Number) });
      expect(held.until - held.now).toBeGreaterThan(1500);
      expect(held.until - held.now).toBeLessThanOrEqual(2000);
      const during = await s.until("a push with the server's now", async () => sent.find((m) => typeof m.shipNow === "number"));
      expect(during.shipNow).toBeGreaterThanOrEqual(held.now);
      expect(during.shipNow).toBeLessThan(held.until);
      expect(typeof (await s.req("/api/state")).shipNow).toBe("number");

      expect(await s.page(`/api/ship/${it.id}/undo`, {})).toEqual({ status: 200, undone: true, now: expect.any(Number) });
      const at = sent.indexOf(during);
      await s.until("a push that says no hold", async () => sent.slice(at + 1).some((m) => m.shipNow === null));
      expect((await s.req("/api/state")).shipNow).toBeNull();
      // and again nothing of the clock once no hold is left
      const from = sent.length;
      s.hud(["ship", link(4)], "w1:p2");
      await pushedRead(4, from);
      expect(sent.slice(from).filter((m) => "shipNow" in m)).toEqual([]);
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  test("a server killed during a hold runs it once when it is back", async () => {
    s.hud(["ship", link(1)], "w1:p2");
    const it = await s.until("read", async () => (await itemOf(1))?.gh && (await itemOf(1)));
    await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(1) });
    await s.restart();
    await s.until("merged after the restart", async () => (await s.state()).done.find((d: any) => d.number === 1));
    await Bun.sleep(2500);
    expect(merges(1)).toHaveLength(1);
  });

  test("a hold whose merge went through before the server died is not merged again", async () => {
    s.hud(["ship", link(2)], "w1:p2");
    const it = await s.until("read", async () => (await itemOf(2))?.gh && (await itemOf(2)));
    await s.page(`/api/ship/${it.id}/hold`, { verb: "merge", sha: sha(2) });
    // gh merged it just before the server died: the PR is merged on GitHub, the row still holds the press
    await s.restart(() => s.gh.setPr("acme/web", 2, { state: "MERGED" }));
    const done = await s.until("left after the restart", async () => (await s.state()).done.find((d: any) => d.number === 2));
    expect(done).toMatchObject({ how: "merged" });
    await Bun.sleep(2500);
    expect(merges(2)).toEqual([]);
    expect(await s.until("the filer told", async () => s.herdr.typedInto("fixer").find((t) => t.includes("HUD SHIP: merged acme/web#2")))).toBeTruthy();
  });
});

describe("a hold long overdue when the server comes back", () => {
  let s: Box;
  const itemOf = async (n: number) => (await s.state()).items.find((i: any) => i.repo === "acme/web" && i.number === n);
  const read = (n: number) => s.until(`acme/web#${n} read`, async () => (await itemOf(n))?.gh && (await itemOf(n)));
  beforeAll(async () => {
    s = await boot("late", { HUD_SHIP_HOLD_MS: "400", HUD_SHIP_LATE_MS: "1000" });
    await s.req("/api/lanes", { name: "fixer", machine: "local" });
    await s.req("/api/sync", {});
  }, 60_000);
  afterAll(async () => {
    await s?.server.stop();
  });

  test("is dropped, not run: the PR stays in MERGE, says the HUD was down, nothing reaches GitHub, and the log has it", async () => {
    s.hud(["ship", link(1)], "w1:p2");
    s.hud(["ship", link(2)], "w1:p2");
    const [a, b] = [await read(1), await read(2)];
    await s.page(`/api/ship/${a.id}/hold`, { verb: "merge", sha: sha(1) });
    await s.page(`/api/ship/${b.id}/hold`, { verb: "back", note: "add a test" });
    await s.restart(() => Bun.sleep(1600));
    const after = await s.until("the holds dropped", async () => {
      const [x, y] = [await itemOf(1), await itemOf(2)];
      return x && y && !x.hold && !y.hold && x.mergeError && y.mergeError && [x, y];
    });
    expect(after[0].mergeError).toContain("the HUD was down");
    expect(after[1].mergeError).toContain("the HUD was down");
    await Bun.sleep(800);
    expect(s.gh.merges()).toEqual([]);
    expect(s.herdr.typedInto("fixer").filter((t) => t.includes("sent back"))).toEqual([]);
    expect((await s.state()).items.map((i: any) => i.number).sort()).toEqual([1, 2]);
    const log = (await s.req("/api/state")).events.map((e: any) => e.text);
    expect(log.filter((t: string) => t.includes("the HUD was down"))).toHaveLength(2);
  });
});

afterAll(() => rmSync(DATA, { recursive: true, force: true }));
