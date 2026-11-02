// HTML PAGES: a room's .html file, a room brief that is an HTML document and a floor brief that is one are served as
// pages under a sandbox policy without allow-same-origin (an opaque origin: no access to the HUD, its data or its
// storage), with secret values masked. Anything that is not a page is not served as one. A stub herdr gives HQ its pane.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { isHtmlDoc, PAGE_CSP } from "../../src/server/pages.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-pages-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const get = async (p: string) => { const r = await fetch(`${server.base}${p}`); return { status: r.status, ...(await r.json()) }; };
const hud = (args: string[], pane: string, stdin?: string) => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
const SECRET = "pages-test-value-9f3k2";
const PAGE = `<!doctype html><html><head><title>Pricing model</title><style>body{font:16px sans-serif}</style></head><body><h1>Pricing</h1><p>Key ${SECRET}</p><script>document.body.dataset.ran = "1"</script></body></html>`;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/secrets", { name: "PAGES_TEST", value: SECRET, minutes: 60, by: "owner" });
  expect(hud(["room", "create", "pricing", "--title", "Pricing", "--owner", "pm"], "w1:p1").exitCode).toBe(0);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

const sandboxed = (r: Response) => {
  const csp = r.headers.get("content-security-policy") ?? "";
  expect(csp).toBe(PAGE_CSP);
  expect(csp).toMatch(/^sandbox allow-scripts /);
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).not.toContain("allow-top-navigation");
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
};

test("what counts as a page: a whole HTML document, not markdown with a tag in it", () => {
  expect(isHtmlDoc(PAGE)).toBe(true);
  expect(isHtmlDoc("<!-- made by a lane -->\n<html lang=en><body>x</body></html>")).toBe(true);
  expect(isHtmlDoc("  <!DOCTYPE html>\n<p>x")).toBe(true);
  expect(isHtmlDoc("# Brief\n\n<b>bold</b> and <html> later")).toBe(false);
  expect(isHtmlDoc("<div>a fragment</div>")).toBe(false);
  expect(isHtmlDoc(null)).toBe(false);
});

test("hud room artifact --file page.html: on the shelf, served as a sandboxed page with secrets masked", async () => {
  const file = join(DATA, "model.html");
  writeFileSync(file, PAGE);
  const p = hud(["room", "artifact", "pricing", "--title", "Pricing model", "--file", file, "--as", "pm"], "w1:p2");
  expect(p.stderr.toString()).toBe("");
  const out = p.stdout.toString();
  expect(out).toContain("/rooms/pricing/files/model.html");
  expect(out).toContain(`${server.base}/#page/rooms/pricing/files/model.html`);
  const room = await get("/api/rooms/pricing");
  const a = room.artifactList.find((x: any) => x.title === "Pricing model");
  expect(a).toMatchObject({ kind: "file", url: "/rooms/pricing/files/model.html" });
  const r = await fetch(`${server.base}${a.url}`);
  expect(r.status).toBe(200);
  sandboxed(r);
  const html = await r.text();
  expect(html).toContain("<h1>Pricing</h1>");
  expect(html).not.toContain(SECRET);
});

test("other files on the shelf are not served as pages", async () => {
  const file = join(DATA, "notes.txt");
  writeFileSync(file, PAGE);
  expect(hud(["room", "artifact", "pricing", "--title", "Notes", "--file", file, "--as", "pm"], "w1:p2").exitCode).toBe(0);
  const r = await fetch(`${server.base}/rooms/pricing/files/notes.txt`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy") ?? "").not.toBe(PAGE_CSP);
  expect(r.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("a room brief that is an HTML document: briefHtml, and /rooms/SLUG/brief.html serves it; a markdown brief is not a page", async () => {
  expect(hud(["room", "brief", "pricing", "--as", "pm"], "w1:p2", PAGE).exitCode).toBe(0);
  const room = await get("/api/rooms/pricing");
  expect(room.briefHtml).toBe(true);
  const r = await fetch(`${server.base}/rooms/pricing/brief.html`);
  expect(r.status).toBe(200);
  sandboxed(r);
  expect(await r.text()).toContain("<h1>Pricing</h1>");
  expect(hud(["room", "brief", "pricing", "--body", "# Plain markdown", "--as", "pm"], "w1:p2").exitCode).toBe(0);
  expect((await get("/api/rooms/pricing")).briefHtml).toBe(false);
  expect((await fetch(`${server.base}/rooms/pricing/brief.html`)).status).toBe(404);
  expect((await fetch(`${server.base}/rooms/nosuchroom/brief.html`)).status).toBe(404);
});

test("hud brief --file page.html: a floor brief that is a page; the state gives its text as the lead, never the markup", async () => {
  const file = join(DATA, "update.html");
  writeFileSync(file, PAGE);
  const p = hud(["brief", "--title", "Pricing update", "--file", file], "w1:p1");
  expect(p.stderr.toString()).toBe("");
  const s = await get("/api/state");
  const b = s.briefs.find((x: any) => x.title === "Pricing update");
  expect(b).toMatchObject({ html: true });
  expect(b.lead).toContain("Pricing");
  expect(b.lead).not.toContain("<");
  expect(b.lead).not.toContain(SECRET);
  const full = await get(`/api/briefs/${b.id}`);
  expect(full).toMatchObject({ id: b.id, html: true, body: null });
  const r = await fetch(`${server.base}/briefs/${b.id}.html`);
  expect(r.status).toBe(200);
  sandboxed(r);
  const html = await r.text();
  expect(html).toContain("<h1>Pricing</h1>");
  expect(html).not.toContain(SECRET);
  expect(hud(["brief", "--title", "Markdown one", "--body", "# Just text"], "w1:p1").exitCode).toBe(0);
  const md = (await get("/api/state")).briefs.find((x: any) => x.title === "Markdown one");
  expect(md.html).toBe(false);
  expect((await fetch(`${server.base}/briefs/${md.id}.html`)).status).toBe(404);
  expect((await fetch(`${server.base}/briefs/999999.html`)).status).toBe(404);
});

test("a page may be large; a markdown brief keeps its limit", async () => {
  const big = PAGE.replace("<h1>", `<img src="data:image/png;base64,${"A".repeat(1_000_000)}"><h1>`);
  expect((await post("/api/rooms/pricing/brief", { body: big, as: "pm" })).status).toBe(200);
  expect((await post("/api/rooms/pricing/brief", { body: "x".repeat(200_000), as: "pm" })).status).toBe(400);
});
