// HQ things by reference (src/server/refs.ts, GET /api/refs, hud ref): a card for every kind, built from the tables
// with the page's own model; null for a thing that is gone and for text that is not a reference; secret values
// masked; read-only, behind the same origin rules as /api/state. Against a server on a spare port with a throwaway
// data dir and a stub herdr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-refs-"));
const VALUE = "TEST_ONLY_REF_MASK_7c2a";
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "api-auth", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const upload = (slug: string, name: string, body: string | Uint8Array, as = "api-auth") => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=${as}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body }).then((r) => r.json());
const refs = async (...rs: string[]) => (await (await fetch(`${server.base}/api/refs?${rs.map((r) => `r=${encodeURIComponent(r)}`).join("&")}`)).json()).cards;
const hud = (...args: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "w1:p1", HUD_LOCAL_MACHINE: "local" }, stdout: "pipe", stderr: "pipe" });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
let brief = 0, page = 0, open = 0, answered = 0;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/lanes", { name: "api-auth", title: "Rotate the **auth** tokens", machine: "local", pane: "w1:p3" });
  await post("/api/sync", {});
  await post("/api/secrets", { name: "REF_PASS", value: VALUE, minutes: 60, by: "owner" });
  brief = (await post("/api/briefs", { title: "Weekly: pricing", body: `## Where we are\n\nThe pricing page is live; the login is ${VALUE}.` }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  page = (await post("/api/briefs", { title: "Chart", body: "<!doctype html><title>Chart</title><p>Revenue by week</p>" }, { "x-hud-pane": "w1:p2", "x-hud-machine": "local" })).id;
  open = (await post("/api/asks", { title: "Ship the pricing page?", body: "It is ready.\nSecond line.", lane: "api-auth", options: ["yes", "no"] })).id;
  answered = (await post("/api/asks", { title: "Which plan name?", lane: "api-auth" })).id;
  await post(`/api/asks/${answered}/answer`, { answer: "Pro" });
  await post("/api/rooms", { slug: "ope-12", title: "Auth rotation", owner: "api-auth" });
  await post("/api/rooms/ope-12/say", { text: "The new tokens are in." , as: "api-auth" });
  await post("/api/rooms/ope-12/brief", { body: "# Plan\n\nRotate every token by Friday." });
  await upload("ope-12", "chart.png", PNG);
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v1</p>");
  await upload("ope-12", "plan.html", "<!doctype html><title>Plan</title><p>v2</p>");
  await upload("ope-12", "notes.txt", "plain notes");
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("a card for every kind: its title, status chips, one line and its floor", async () => {
  const c = await refs(`brief/${brief}`, `#page/briefs/${page}`, "room/ope-12", "lane/api-auth", `ask/${open}`, `ask/${answered}`, "floor/crm", "page/rooms/ope-12/files/chart.png", "page/rooms/ope-12/files/plan.html", "page/rooms/ope-12/files/notes.txt", "page/rooms/ope-12/brief");
  expect(c[`brief/${brief}`]).toMatchObject({ kind: "brief", word: "BRIEF", title: "Weekly: pricing", chips: [{ t: "NEW" }], floor: "hq", href: `#brief/${brief}` });
  expect(c[`brief/${brief}`].preview).toStartWith("The pricing page is live");
  expect(c[`#page/briefs/${page}`]).toMatchObject({ kind: "brief", title: "Chart", floor: "crm", href: `#page/briefs/${page}`, preview: "Revenue by week" });
  expect(c[`#page/briefs/${page}`].chips.map((x: any) => x.t)).toEqual(["NEW", "PAGE"]);
  expect(c["room/ope-12"]).toMatchObject({ kind: "room", title: "Auth rotation", href: "#room/ope-12", preview: "api-auth: The new tokens are in." });
  expect(c["room/ope-12"].chips.map((x: any) => x.t)).toEqual(["1 NEW", "api-auth"]);
  expect(c["lane/api-auth"]).toMatchObject({ kind: "lane", title: "api-auth", preview: "Rotate the **auth** tokens", chips: [{ c: "st", status: "moving" }, { t: "MANAGER" }], href: "#lane/api-auth", floor: "hq" });
  expect(c[`ask/${open}`]).toMatchObject({ kind: "ask", word: "QUESTION", title: "Ship the pricing page?", preview: "It is ready.", chips: [{ t: "OPEN" }, { t: "api-auth" }] });
  expect(c[`ask/${answered}`]).toMatchObject({ preview: "You: Pro", chips: [{ t: "ANSWERED" }, { t: "api-auth" }] });
  expect(c["floor/crm"]).toMatchObject({ kind: "floor", title: "CRM", preview: "HQ: hq-crm", href: "#floor/crm", floor: "crm" });
  expect(c["page/rooms/ope-12/files/chart.png"]).toMatchObject({ kind: "file", word: "IMAGE", title: "chart.png", thumb: "/rooms/ope-12/files/chart.png", href: "/rooms/ope-12/files/chart.png", tab: true, preview: "On the shelf of Auth rotation" });
  expect(c["page/rooms/ope-12/files/plan.html"]).toMatchObject({ word: "PAGE", href: "#page/rooms/ope-12/files/plan.html", tab: false, thumb: null, chips: [{ t: "V2" }] });
  expect(c["page/rooms/ope-12/files/notes.txt"]).toMatchObject({ word: "FILE", href: "/rooms/ope-12/files/notes.txt", tab: true });
  expect(c["page/rooms/ope-12/brief"]).toMatchObject({ kind: "roombrief", title: "Auth rotation", preview: "Rotate every token by Friday.", href: "#room/ope-12" });
});

test("a thing that is gone, and text that is not a reference, is null", async () => {
  const c = await refs("brief/99999", "room/nope", "lane/nobody", "ask/99999", "floor/nope", "page/rooms/ope-12/files/gone.png", "page/rooms/nope/files/a.png", "page/rooms/nope/brief", "page/rooms/ope-12/files/..%2Fsecret", "hello", "#brief/x");
  expect(Object.values(c)).toEqual(Array(11).fill(null));
});

test("secret values are masked in a card", async () => {
  await post("/api/briefs", { title: `Login ${VALUE}`, body: "x" });
  const s = await (await fetch(`${server.base}/api/state`)).json();
  const id = s.briefs.find((b: any) => b.title.startsWith("Login")).id;
  const c = await refs(`brief/${id}`, `brief/${brief}`);
  expect(c[`brief/${id}`].title).toBe("Login [secret REF_PASS]");
  expect(c[`brief/${brief}`].preview).toContain("[secret REF_PASS]");
  expect(JSON.stringify(c)).not.toContain(VALUE);
});

test("read-only, behind the same origin rules as the state; at most 50 at once", async () => {
  expect((await fetch(`${server.base}/api/refs?r=room/ope-12`, { headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
  expect((await fetch(`${server.base}/api/refs?r=room/ope-12`, { headers: { origin: "null" } })).status).toBe(403); // a sandboxed page
  expect((await fetch(`${server.base}/api/refs`, { method: "POST", headers: { "x-hud": "1" } })).status).toBe(404);
  expect((await fetch(`${server.base}/api/refs?${Array.from({ length: 51 }, (_, i) => `r=ask/${i}`).join("&")}`)).status).toBe(400);
});

test("hud ref KIND ID prints the reference to paste, and fails when the thing does not exist", async () => {
  const out = (...a: string[]) => { const p = hud("ref", ...a); return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
  expect(out("brief", String(brief))).toEqual({ code: 0, out: `#brief/${brief}`, err: "" });
  expect(out("lane", "api-auth").out).toBe("#lane/api-auth");
  expect(out("file", "ope-12/plan.html").out).toBe("#page/rooms/ope-12/files/plan.html");
  expect(out("file", "ope-12", "chart.png").out).toBe("#page/rooms/ope-12/files/chart.png");
  expect(out("roombrief", "ope-12").out).toBe("#page/rooms/ope-12/brief");
  expect(out("#room/ope-12").out).toBe("#room/ope-12");
  expect(JSON.parse(out("ask", String(open), "--json").out)).toMatchObject({ kind: "ask", title: "Ship the pricing page?" });
  const gone = out("brief", "99999");
  expect(gone.code).toBe(1);
  expect(gone.err).toContain("nothing at #brief/99999");
  expect(out("room", "Not A Slug").code).toBe(2);
  expect(out().code).toBe(2);
});

// ---- <hud-card ref> in a page: only the references its author wrote ----

const pageCards = async (page: string, ...rs: string[]) => {
  const r = await fetch(`${server.base}/api/refs?page=${encodeURIComponent(page)}&${rs.map((x) => `r=${encodeURIComponent(x)}`).join("&")}`);
  return { status: r.status, cards: (await r.json()).cards };
};
const version = (html: string) => new Bun.CryptoHasher("sha256").update(html).digest("hex").slice(0, 16);

test("a page resolves the references in its <hud-card> elements and nothing else", async () => {
  const html = `<!doctype html><title>Status</title><hud-card ref="room/ope-12"></hud-card><p>and</p><hud-card class="x" ref='#lane/api-auth'></hud-card><hud-card ref=floor/crm></hud-card>`;
  const id = (await post("/api/briefs", { title: "Status page", body: html }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id;
  const { cards } = await pageCards(`briefs/${id}`, "room/ope-12", "#lane/api-auth", "lane/api-auth", "floor/crm", `ask/${open}`, `brief/${brief}`, "brief/99999");
  expect(cards["room/ope-12"]).toMatchObject({ kind: "room", title: "Auth rotation" });
  expect(cards["#lane/api-auth"]).toMatchObject({ kind: "lane", title: "api-auth" });
  expect(cards["lane/api-auth"]).toMatchObject({ kind: "lane" });
  expect(cards["floor/crm"]).toMatchObject({ kind: "floor", title: "CRM" });
  // Not in the page: the same answer as a thing that is gone.
  expect([cards[`ask/${open}`], cards[`brief/${brief}`], cards["brief/99999"]]).toEqual([null, null, null]);
  // A markdown brief is not a page: none of its references resolve this way.
  expect((await pageCards(`briefs/${brief}`, "room/ope-12")).cards["room/ope-12"]).toBe(null);
});

test("a page that publishes itself cannot add references; one its author wrote stays until the page drops it", async () => {
  const html = `<!doctype html><title>Poll</title><hud-card ref="room/ope-12"></hud-card><hud-card ref="lane/api-auth"></hud-card>`;
  const page = `briefs/${(await post("/api/briefs", { title: "A poll", body: html }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" })).id}`;
  const grabbed = `<!doctype html><title>Poll</title><hud-card ref="room/ope-12"></hud-card><hud-card ref="ask/${open}"></hud-card><hud-card ref="brief/${brief}"></hud-card>`;
  await post("/api/page-runtime/publish", { page, html: grabbed, base: version(html) });
  const { cards } = await pageCards(page, "room/ope-12", `ask/${open}`, `brief/${brief}`, "lane/api-auth");
  expect(cards["room/ope-12"]).toMatchObject({ kind: "room" }); // the author's, still in the page
  expect([cards[`ask/${open}`], cards[`brief/${brief}`]]).toEqual([null, null]); // added by the page itself
  expect(cards["lane/api-auth"]).toBe(null); // the author's, but the page dropped it
});

test("an ask's page and a room's page resolve their author's references; a room page the owner's publish rewrote keeps the lane's", async () => {
  const ask = (await post("/api/asks", { title: "Pick a plan", body: `<!doctype html><title>Plans</title><hud-card ref="room/ope-12"></hud-card>` })).id;
  expect((await pageCards(`asks/${ask}`, "room/ope-12", "lane/api-auth")).cards).toMatchObject({ "room/ope-12": { kind: "room" }, "lane/api-auth": null });
  const v1 = `<!doctype html><title>Board</title><hud-card ref="lane/api-auth"></hud-card>`;
  await upload("ope-12", "board.html", v1);
  expect((await pageCards("rooms/ope-12/files/board.html", "lane/api-auth")).cards["lane/api-auth"]).toMatchObject({ kind: "lane" });
  await post("/api/page-runtime/publish", { page: "rooms/ope-12/files/board.html", html: `${v1}<hud-card ref="floor/crm"></hud-card>`, base: version(v1) });
  const after = (await pageCards("rooms/ope-12/files/board.html", "lane/api-auth", "floor/crm")).cards;
  expect(after["lane/api-auth"]).toMatchObject({ kind: "lane" });
  expect(after["floor/crm"]).toBe(null);
});

test("a page key that is not a page is refused; a sandboxed page's own origin gets nothing", async () => {
  expect((await pageCards("../hud.db", "room/ope-12")).status).toBe(400);
  expect((await fetch(`${server.base}/api/refs?page=asks/1&r=room/ope-12`, { headers: { origin: "null" } })).status).toBe(403);
});
