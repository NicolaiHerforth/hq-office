// VERSIONS: a lane uploading a file under a name already on the shelf replaces it and keeps the older one in the
// room's folder (versions/files/NAME/); a room's brief keeps its earlier versions too (versions/brief/). The card stays
// one card, showing the newest; an older version is served at the file's own address with ?v=V, sandboxed like the
// file. The owner's uploads from the page keep both files (name-2.ext). A stub herdr gives HQ its pane.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { PAGE_CSP } from "../../src/server/pages.ts";

const ROOT = join(import.meta.dir, "..", "..");
// MAX_VERSIONS in src/server/room-folder.ts (not imported: that would open a database here).
const MAX_VERSIONS = 20;
const DATA = mkdtempSync(join(tmpdir(), "hq-page-versions-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string) => { const r = await fetch(`${server.base}${p}`); return { status: r.status, ...(await r.json()) }; };
const hud = (args: string[], pane = "w1:p2") => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const page = (n: number) => `<!doctype html><html><head><title>Model v${n}</title></head><body><h1>Version ${n}</h1><img src="dot.png"></body></html>`;
const upload = (name: string, body: string, q: Record<string, string> = {}) =>
  fetch(`${server.base}/api/rooms/plans/files?${new URLSearchParams({ name, ...q })}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const shelf = async () => (await get("/api/rooms/plans")).artifactList;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  expect(hud(["room", "create", "plans", "--title", "Plans", "--owner", "pm"], "w1:p1").exitCode).toBe(0);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("hud room artifact --file again under the same name: one card with the newest, the older ones kept and served with ?v=", async () => {
  const file = join(DATA, "model.html");
  for (const n of [1, 2, 3]) {
    writeFileSync(file, page(n));
    const p = hud(["room", "artifact", "plans", "--title", `Model v${n}`, "--file", file]);
    expect(p.stderr.toString()).toBe("");
    if (n > 1) expect(p.stdout.toString()).toContain(`replaced the file of that name; ${n - 1} earlier ${n === 2 ? "version" : "versions"} kept`);
  }
  const cards = (await shelf()).filter((a: any) => a.url === "/rooms/plans/files/model.html");
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ title: "Model v3", by: "pm", versions: 2 });
  expect(existsSync(join(DATA, "rooms", "plans", "files", "model-2.html"))).toBe(false);
  // the current one at its address, the older ones at the same address with ?v=, sandboxed the same
  expect(await (await fetch(`${server.base}/rooms/plans/files/model.html`)).text()).toContain("Version 3");
  const v = await get("/api/rooms/plans/versions?file=model.html");
  expect(v).toMatchObject({ status: 200, file: "model.html", title: "Model v3", current: { by: "pm" } });
  expect(v.versions).toHaveLength(2);
  expect(v.versions[0].at).toBeGreaterThan(v.versions[1].at); // newest first
  const old = await fetch(`${server.base}/rooms/plans/files/model.html?v=${v.versions[1].v}`);
  expect(old.status).toBe(200);
  expect(old.headers.get("content-security-policy")).toBe(PAGE_CSP);
  expect(await old.text()).toContain("Version 1");
  expect(await (await fetch(`${server.base}/rooms/plans/files/model.html?v=${v.versions[0].v}`)).text()).toContain("Version 2");
  // the versions live in the room's folder, outside files/, so they are not on the shelf
  expect(readdirSync(join(DATA, "rooms", "plans", "versions", "files", "model.html"))).toHaveLength(2);
  await Bun.sleep(900); // the folder watcher has looked: still one card
  expect((await shelf()).filter((a: any) => a.title.startsWith("Model"))).toHaveLength(1);
  // hud room versions lists them, with where each opens
  const list = hud(["room", "versions", "plans", "model.html"]).stdout.toString();
  expect(list).toContain(`#page/rooms/plans/files/model.html?v=${v.versions[1].v}`);
});

test("a version that does not exist, or a ?v= that is not one, is not found", async () => {
  for (const p of ["/rooms/plans/files/model.html?v=123", "/rooms/plans/files/model.html?v=..%2F..%2Fhud.db", "/rooms/plans/files/..%2Fbrief.md?v=1", "/rooms/plans/brief.html?v=1", "/rooms/nosuch/files/model.html?v=1"]) {
    expect([p, (await fetch(`${server.base}${p}`)).status]).toEqual([p, 404]);
  }
  expect((await get("/api/rooms/plans/versions?file=nothing.html")).status).toBe(400);
});

test("any lane file keeps its versions; the owner's uploads from the page, and attachments, keep both files", async () => {
  await upload("notes.txt", "one", { as: "pm" });
  const two = await upload("notes.txt", "two", { as: "pm" });
  expect(two).toMatchObject({ name: "notes.txt", replaced: true, versions: 1 });
  const v = await get("/api/rooms/plans/versions?file=notes.txt");
  expect(await (await fetch(`${server.base}/rooms/plans/files/notes.txt?v=${v.versions[0].v}`)).text()).toBe("one");
  const a = await upload("image.txt", "first paste", { as: "owner" });
  const b = await upload("image.txt", "second paste", { as: "owner" });
  expect([a.name, b.name, b.replaced]).toEqual(["image.txt", "image-2.txt", false]);
  const c = await upload("notes.txt", "attached", { as: "pm", attach: "1" });
  expect(c.name).toBe("notes-2.txt");
});

test("a room's brief keeps its earlier versions, markdown and page alike; the same brief again is not a new one", async () => {
  expect(hud(["room", "brief", "plans", "--body", "# First plan"]).exitCode).toBe(0);
  expect(hud(["room", "brief", "plans", "--body", "# First plan"]).exitCode).toBe(0);
  const html = join(DATA, "brief.html");
  writeFileSync(html, page(7));
  expect(hud(["room", "brief", "plans", "--file", html]).exitCode).toBe(0);
  writeFileSync(html, page(8));
  expect(hud(["room", "brief", "plans", "--file", html]).exitCode).toBe(0);
  const room = await get("/api/rooms/plans");
  expect(room.briefVersions).toBe(2);
  const v = await get("/api/rooms/plans/versions?brief=1");
  expect(v.current).toMatchObject({ by: "pm", html: true });
  expect(v.versions.map((x: any) => x.html)).toEqual([true, false]);
  // the earlier page at the brief's address with ?v=; the earlier markdown by its text
  expect(await (await fetch(`${server.base}/rooms/plans/brief.html?v=${v.versions[0].v}`)).text()).toContain("Version 7");
  expect((await fetch(`${server.base}/rooms/plans/brief.html?v=${v.versions[1].v}`)).status).toBe(404);
  const md = await get(`/api/rooms/plans/versions?brief=1&v=${v.versions[1].v}`);
  expect(md.version).toMatchObject({ html: false, body: "# First plan", by: "pm" });
  // clearing keeps the last one too
  expect(hud(["room", "brief", "plans", "--clear"]).exitCode).toBe(0);
  expect((await get("/api/rooms/plans/versions?brief=1")).versions).toHaveLength(3);
  expect(hud(["room", "versions", "plans", "--brief"]).stdout.toString()).toContain("#page/rooms/plans/brief?v=");
});

test(`each thing keeps its newest ${MAX_VERSIONS} versions`, async () => {
  for (let i = 0; i < MAX_VERSIONS + 3; i++) await upload("log.txt", `v${i}`, { as: "pm" });
  const v = await get("/api/rooms/plans/versions?file=log.txt");
  expect(v.versions).toHaveLength(MAX_VERSIONS);
  expect(await (await fetch(`${server.base}/rooms/plans/files/log.txt?v=${v.versions[0].v}`)).text()).toBe(`v${MAX_VERSIONS + 1}`);
});
