// THE PAGE RUNTIME, server side: every page is served with the runtime first in its <head> and its own stored keys
// inline; storage and db are kept per page (the key comes from the page's address, never from the page); the artifact
// db's shape (set, get, update, delete, where/orderBy/limit) and its limits; a write moves S.pageData, a read does not;
// secret values are masked before anything is stored; hud page data reads it back. A stub herdr gives HQ its pane.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-page-runtime-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const SECRET = "page-runtime-value-7q2x9";
const send = async (p: string, b: unknown, h: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: typeof b === "string" ? b : JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string) => { const r = await fetch(`${server.base}${p}`); return { status: r.status, ...(await r.json()) }; };
const db = (page: string, b: object) => send("/api/page-runtime/db", { page, ...b });
const storage = (page: string, set: object, clear = false) => send("/api/page-runtime/storage", { page, set, clear });
const hud = (args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "w1:p1", HUD_LOCAL_MACHINE: "local" }, stdout: "pipe", stderr: "pipe" });
const PAGE = (head = "<head><title>T</title></head>") => `<!doctype html><html>${head}<body><h1>Page</h1></body></html>`;
const bootOf = (html: string) => JSON.parse(html.match(/<script type="application\/json" data-hud-page>(.*?)<\/script>/)![1]);
let b1 = 0, b2 = 0;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await send("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await send("/api/sync", {});
  await send("/api/secrets", { name: "RUNTIME_TEST", value: SECRET, minutes: 60, by: "owner" });
  const brief = (body: string) => send("/api/briefs", { title: "A page", body }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" }).then((r) => r.id as number);
  b1 = await brief(PAGE());
  b2 = await brief(PAGE("<head lang=en>"));
  await send("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  await send("/api/rooms/pricing/brief", { body: `<!doctype html><title>Room brief</title><p>x</p>`, as: "pm" });
  await fetch(`${server.base}/api/rooms/pricing/files?${new URLSearchParams({ name: "model.html", title: "model.html", as: "pm" })}`, { method: "POST", headers: { "content-type": "text/html", "x-hud": "1" }, body: `<html><body>no head</body></html>` });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("every page is served with the runtime first in its <head>, its key from its own address", async () => {
  const cases: [string, string, RegExp][] = [
    [`/briefs/${b1}.html`, `briefs/${b1}`, /^<!doctype html><html><head><script type="application\/json" data-hud-page>/],
    [`/briefs/${b2}.html`, `briefs/${b2}`, /^<!doctype html><html><head lang=en><script type="application\/json" data-hud-page>/],
    ["/rooms/pricing/brief.html", "rooms/pricing/brief", /^<!doctype html><script type="application\/json" data-hud-page>/],
    ["/rooms/pricing/files/model.html", "rooms/pricing/files/model.html", /^<html><script type="application\/json" data-hud-page>/],
  ];
  for (const [url, key, start] of cases) {
    const r = await fetch(server.base + url);
    expect(r.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    const html = await r.text();
    expect(html).toMatch(start);
    expect(html).toContain(`</script><script src="/src/client/page-runtime/runtime.js"></script>`);
    expect(bootOf(html)).toEqual({ page: key, storage: {} });
  }
  // the runtime itself is served like any client file
  const rt = await fetch(`${server.base}/src/client/page-runtime/runtime.js`);
  expect(rt.headers.get("content-type")).toContain("text/javascript");
  expect(await rt.text()).toContain('window.claude === undefined');
});

test("storage is kept per page and inlined into that page only; a value cannot close the script element", async () => {
  expect((await storage(`briefs/${b1}`, { tab: "votes", evil: "</script><script>alert(1)</script>\u2028" })).status).toBe(200);
  expect((await storage(`briefs/${b2}`, { tab: "chart" })).status).toBe(200);
  const one = await (await fetch(`${server.base}/briefs/${b1}.html`)).text();
  expect(one).not.toContain("</script><script>alert(1)");
  expect(bootOf(one).storage).toEqual({ tab: "votes", evil: "</script><script>alert(1)</script>\u2028" });
  expect(bootOf(await (await fetch(`${server.base}/briefs/${b2}.html`)).text()).storage).toEqual({ tab: "chart" });
  // null removes a key; clear empties the page first
  await storage(`briefs/${b1}`, { evil: null });
  expect((await get(`/api/page-runtime/data?page=briefs/${b1}`)).storage).toEqual({ tab: "votes" });
  await storage(`briefs/${b2}`, { fresh: "1" }, true);
  expect((await get(`/api/page-runtime/data?page=briefs/${b2}`)).storage).toEqual({ fresh: "1" });
});

test("only a page's key is accepted, never a path of the page's own choosing", async () => {
  for (const page of ["", "briefs/x", "rooms/../briefs/1", "rooms/pricing/files/.hidden.html", "rooms/pricing/files/a/b.html", "rooms/Pricing/brief", "state", "briefs/1/../2"]) {
    const r = await db(page, { op: "set", path: "a/b", data: { x: 1 } });
    expect({ page, status: r.status }).toEqual({ page, status: 400 });
  }
  // and a request needs the x-hud header, which a page on its opaque origin cannot send
  const r = await fetch(`${server.base}/api/page-runtime/db`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ page: `briefs/${b1}`, op: "set", path: "a/b", data: {} }) });
  expect(r.status).toBe(403);
});

test("db: the artifact db's shape, per page", async () => {
  const P = `briefs/${b1}`;
  expect((await db(P, { op: "get", path: "votes/me" })).exists).toBe(false);
  await db(P, { op: "set", path: "votes/me", data: { picks: ["db", "storage"], n: 2, meta: { a: 1, b: { c: 1 } } } });
  await db(P, { op: "set", path: "votes/you", data: { picks: ["mermaid"], n: 5 } });
  await db(P, { op: "set", path: "votes/them", data: { picks: [], n: 1 } });
  await db(P, { op: "set", path: "votes/me/notes/n1", data: { t: "nested" } });
  expect(await db(P, { op: "get", path: "votes/me" })).toMatchObject({ status: 200, id: "me", exists: true, data: { n: 2 } });
  // update merges nested objects, replaces arrays; it needs the document to exist
  await db(P, { op: "update", path: "votes/me", data: { picks: ["db"], meta: { b: { d: 2 } } } });
  expect((await db(P, { op: "get", path: "votes/me" })).data).toEqual({ picks: ["db"], n: 2, meta: { a: 1, b: { c: 1, d: 2 } } });
  expect(await db(P, { op: "update", path: "votes/nobody", data: { x: 1 } })).toMatchObject({ status: 400, code: "invalid_argument" });
  // queries: by id without orderBy; where, orderBy, limit; only the collection's own documents
  const ids = async (query?: object) => (await db(P, { op: "query", path: "votes", query })).docs.map((d: { id: string }) => d.id);
  expect(await ids()).toEqual(["me", "them", "you"]);
  expect(await ids({ where: [["n", ">", 1]], orderBy: ["n", "desc"] })).toEqual(["you", "me"]);
  expect(await ids({ orderBy: ["n", "asc"], limit: 2 })).toEqual(["them", "me"]);
  expect(await ids({ where: [["picks", "array-contains", "mermaid"]] })).toEqual(["you"]);
  expect(await ids({ where: [["n", "in", [1, 5]]] })).toEqual(["them", "you"]);
  expect((await db(P, { op: "query", path: "votes/me/notes" })).docs).toEqual([{ path: "votes/me/notes/n1", id: "n1", exists: true, data: { t: "nested" } }]);
  // another page sees none of it
  expect((await db(`briefs/${b2}`, { op: "query", path: "votes" })).docs).toEqual([]);
  // delete: idempotent; nested documents survive
  await db(P, { op: "delete", path: "votes/them" });
  expect((await db(P, { op: "delete", path: "votes/them" })).status).toBe(200);
  expect(await ids()).toEqual(["me", "you"]);
  expect((await db(P, { op: "get", path: "votes/me/notes/n1" })).exists).toBe(true);
  // leases: set-if-not-busy
  expect(await db(P, { op: "acquire", path: "locks/edit", holder: "a", ttlMs: 5000 })).toMatchObject({ acquired: true, holder: "a" });
  expect(await db(P, { op: "acquire", path: "locks/edit", holder: "b" })).toMatchObject({ acquired: false });
});

test("a write moves the page's version in the state; a read does not", async () => {
  const P = `briefs/${b2}`;
  const before = (await get("/api/state")).pageData?.[P];
  await db(P, { op: "get", path: "x/y" });
  await db(P, { op: "query", path: "x" });
  expect((await get("/api/state")).pageData?.[P]).toBe(before);
  await db(P, { op: "set", path: "x/y", data: { v: 1 } });
  const after = (await get("/api/state")).pageData?.[P];
  expect(typeof after).toBe("number");
  expect(after).not.toBe(before);
});

test("limits: paths, documents, queries, storage and requests", async () => {
  const P = `briefs/${b2}`;
  const code = async (b: object) => { const r = await db(P, b); return [r.status, r.code]; };
  expect(await code({ op: "set", path: "votes", data: {} })).toEqual([400, "invalid_argument"]); // a collection path
  expect(await code({ op: "query", path: "votes/me" })).toEqual([400, "invalid_argument"]); // a document path
  expect(await code({ op: "set", path: "a/b c", data: {} })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "set", path: "a/..", data: {} })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "set", path: Array(18).fill("a").join("/"), data: {} })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "set", path: "a/b", data: [1, 2] })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "set", path: "a/b", data: { big: "x".repeat(270 * 1024) } })).toEqual([400, "invalid_argument"]);
  let deep: object = {};
  for (let i = 0; i < 40; i++) deep = { d: deep };
  expect(await code({ op: "set", path: "a/b", data: deep })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "query", path: "votes", query: { limit: 1001 } })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "query", path: "votes", query: { where: Array(11).fill(["n", "==", 1]) } })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "query", path: "votes", query: { where: [["n", "in", Array(31).fill(1)]] } })).toEqual([400, "invalid_argument"]);
  expect(await code({ op: "drop", path: "a/b" })).toEqual([400, "invalid_argument"]);
  // storage: a long key, and more than a page may keep (applied whole or not at all)
  expect((await storage(P, { ["k".repeat(1025)]: "v" })).status).toBe(400);
  const full = await storage(P, { a: "x".repeat(600_000), b: "y".repeat(600_000) });
  expect([full.status, full.code]).toEqual([400, "quota_exceeded"]);
  expect(Object.keys((await get(`/api/page-runtime/data?page=${P}`)).storage)).toEqual(["fresh"]);
  expect((await storage(P, { n: 1 } as object)).status).toBe(400); // values are strings
  // a request over 2 MB is refused, and the connection still works afterwards
  expect((await send("/api/page-runtime/storage", "x".repeat(2_100_000))).status).toBe(400);
  expect((await db(P, { op: "get", path: "a/b" })).status).toBe(200);
});

test("secret values are masked before they are stored, and never reach hud.db", async () => {
  const P = `rooms/pricing/brief`;
  await db(P, { op: "set", path: "notes/n1", data: { text: `the key is ${SECRET}`, nested: { list: [SECRET] } } });
  await storage(P, { draft: `paste ${SECRET} here` });
  const back = await get(`/api/page-runtime/data?page=${P}`);
  expect(back.docs["notes/n1"]).toEqual({ text: "the key is [secret RUNTIME_TEST]", nested: { list: ["[secret RUNTIME_TEST]"] } });
  expect(back.storage).toEqual({ draft: "paste [secret RUNTIME_TEST] here" });
  for (const f of readdirSync(DATA).filter((f) => f.startsWith("hud.db"))) expect(readFileSync(join(DATA, f)).includes(SECRET)).toBe(false);
});

test("hud page data PAGE [PATH]: what a page keeps, a collection or one document", async () => {
  const P = `briefs/${b1}`;
  const all = hud(["page", "data", P]);
  expect(all.exitCode).toBe(0);
  const out = JSON.parse(all.stdout.toString());
  expect(out.storage).toEqual({ tab: "votes" });
  expect(Object.keys(out.docs)).toEqual(["votes/me", "votes/me/notes/n1", "votes/you"]);
  const coll = JSON.parse(hud(["page", "data", P, "votes"]).stdout.toString());
  expect(coll.docs.map((d: { id: string }) => d.id)).toEqual(["me", "you"]);
  expect(JSON.parse(hud(["page", "data", P, "votes/you"]).stdout.toString())).toMatchObject({ exists: true, data: { picks: ["mermaid"], n: 5 } });
  // without a page: every page that keeps anything
  const list = hud(["page", "data"]).stdout.toString();
  expect(list).toContain(`briefs/${b1}`);
  expect(list).toContain("rooms/pricing/brief");
  const badPage = hud(["page", "data", "nope"]);
  expect(badPage.exitCode).toBe(1);
});
