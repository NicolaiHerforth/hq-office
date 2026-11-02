// HTML PAGES: a room's .html file, a room brief that is an HTML document and a floor brief that is one are served as
// pages under a sandbox policy without allow-same-origin (an opaque origin: no access to the HUD, its data or its
// storage), with secret values masked. Anything that is not a page is not served as one. A stub herdr gives HQ its pane.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { asDocument, isFragment, isHtmlDoc, isPage, PAGE_CSP, SKELETON, themed } from "../../src/server/pages.ts";

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

// The page runtime puts its tag first in <head> (src/server/page-runtime-tag.ts): compare the page without it.
const bare = (h: string) => h.replace(/<script type="application\/json" data-hud-page>[\s\S]*?<\/script><script src="\/src\/client\/page-runtime\/runtime\.js"><\/script>/, "");

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

// ---- fragments: a page as a Claude artifact may be one, with no doctype, <html> or <body> ----

const FRAGMENT = `<title>Pricing</title>\n<style>h1 { color: rgb(1, 2, 3) }</style>\n<h1>Pricing</h1>\n<script>document.title += "!"</script>`;
// Markdown that only looks like it might be a page: each stays markdown.
const MARKDOWN = [
  "# Plan\n\n<style>h1{}</style>",
  "<b>bold</b> first",
  "<details><summary>More</summary>x</details>",
  "<titled> is not a tag we know",
  "<metadata>x</metadata>",
  "<scripted> words",
  "<linkage>",
  "```html\n<style>h1{}</style>\n```",
  "Text, then <script>x</script>",
  "> <title>quoted</title>",
  "- <meta> in a list",
];

test("what counts as a fragment: it starts with <title>, <meta>, <link>, <style> or <script>; markdown stays markdown", () => {
  for (const f of [FRAGMENT, "<style>body{}</style><p>x", "  \n<script src=\"https://cdn.example/x.js\"></script>", "<META charset=utf-8>", "<link rel=stylesheet href=x.css>", "<!-- by a lane -->\n<title>x</title>", "<meta/>"]) {
    expect([f, isFragment(f), isPage(f)]).toEqual([f, true, true]);
  }
  for (const md of MARKDOWN) expect([md, isPage(md)]).toEqual([md, false]);
  expect(isPage(PAGE)).toBe(true);
  expect(isFragment(PAGE)).toBe(false);
  expect(isPage(null)).toBe(false);
});

test("a fragment is served in a skeleton (charset, viewport-fit=cover, color-scheme light on :root, body margin 0); a whole document as it is", () => {
  const doc = asDocument(FRAGMENT);
  expect(doc.startsWith(SKELETON)).toBe(true);
  expect(doc).toContain('<meta charset="utf-8">');
  expect(doc).toContain("viewport-fit=cover");
  expect(doc).toContain(":root { color-scheme: light; }");
  expect(doc).not.toContain("light dark");
  expect(doc).toContain("body { margin: 0; }");
  expect(doc.endsWith(FRAGMENT)).toBe(true);
  expect(isHtmlDoc(doc)).toBe(true);
  expect(asDocument(PAGE)).toBe(PAGE);
});

test("a .html file on the shelf that is a fragment, or any markup, is a page, wrapped", async () => {
  for (const [name, body] of [["frag.html", FRAGMENT], ["bare.html", "<div>just markup</div>"]]) {
    const file = join(DATA, name);
    writeFileSync(file, body);
    expect(hud(["room", "artifact", "pricing", "--title", name, "--file", file, "--as", "pm"], "w1:p2").exitCode).toBe(0);
    const r = await fetch(`${server.base}/rooms/pricing/files/${name}`);
    sandboxed(r);
    const html = await r.text();
    expect(bare(html).startsWith(SKELETON)).toBe(true);
    expect(html.endsWith(body)).toBe(true);
  }
  // a whole document is not wrapped twice
  const whole = await (await fetch(`${server.base}/rooms/pricing/files/model.html`)).text();
  expect(bare(whole).startsWith("<!doctype html><html><head><title>Pricing model</title>")).toBe(true);
});

test("a room brief or a floor brief that is a fragment is a page; a markdown brief that looks like one is not", async () => {
  expect((await post("/api/rooms/pricing/brief", { body: FRAGMENT, as: "pm" })).html).toBe(true);
  expect((await get("/api/rooms/pricing")).briefHtml).toBe(true);
  const r = await fetch(`${server.base}/rooms/pricing/brief.html`);
  sandboxed(r);
  expect(bare(await r.text()).startsWith(SKELETON)).toBe(true);
  for (const md of MARKDOWN) {
    expect((await post("/api/rooms/pricing/brief", { body: md, as: "pm" })).html).toBe(false);
    expect((await fetch(`${server.base}/rooms/pricing/brief.html`)).status).toBe(404);
  }
  const p = hud(["brief", "--title", "A fragment brief"], "w1:p1", FRAGMENT);
  expect(p.stderr.toString()).toBe("");
  const b = (await get("/api/state")).briefs.find((x: any) => x.title === "A fragment brief");
  expect(b).toMatchObject({ html: true });
  expect(b.lead).toBe("Pricing");
  expect((await get(`/api/briefs/${b.id}`)).body).toBe(null);
  expect(bare(await (await fetch(`${server.base}/briefs/${b.id}.html`)).text()).startsWith(SKELETON)).toBe(true);
  expect(hud(["brief", "--title", "Looks like one", "--body", MARKDOWN[0]], "w1:p1").exitCode).toBe(0);
  const md = (await get("/api/state")).briefs.find((x: any) => x.title === "Looks like one");
  expect(md.html).toBe(false);
  expect((await get(`/api/briefs/${md.id}`)).body).toBe(MARKDOWN[0]);
});

// ---- the reader's theme: ?theme=light|dark puts data-theme and a matching color-scheme on the page's <html> ----

// A page with a dark look of its own, as artifacts are written: dark under :root[data-theme=dark].
const DARKABLE = PAGE.replace("<style>", `<style>:root[data-theme="dark"] body { background: #111; color: #eee }`);
test("themed: data-theme and color-scheme on <html>; nothing for system; the page's own data-theme replaced, its style kept", () => {
  expect(themed(DARKABLE, null)).toBe(DARKABLE);
  expect(themed(DARKABLE, "system")).toBe(DARKABLE);
  expect(themed(DARKABLE, "blue")).toBe(DARKABLE);
  expect(themed(DARKABLE, "dark")).toStartWith(`<!doctype html><html data-theme="dark" style="color-scheme: dark"><head>`);
  expect(themed(`<!doctype html><html lang="en" data-theme="light" style="font-size:20px">x`, "dark")).toBe(`<!doctype html><html data-theme="dark" lang="en" style="color-scheme: dark; font-size:20px">x`);
  expect(themed(`<!DOCTYPE html>\n<head><title>x</title>`, "light")).toBe(`<!DOCTYPE html><html data-theme="light" style="color-scheme: light">\n<head><title>x</title>`);
  const frag = themed(asDocument(`<style>@media (prefers-color-scheme: dark) { body { color: #eee } }</style><p>x`), "dark");
  expect(frag).toContain(`<html data-theme="dark" style="color-scheme: dark">`);
  expect(frag.match(/<html/g)).toHaveLength(1);
});

test("a page with no dark look of its own gets data-theme but keeps its color-scheme, so its text stays readable", () => {
  expect(themed(PAGE, "dark")).toStartWith(`<!doctype html><html data-theme="dark"><head>`);
  expect(themed(PAGE, "light")).toStartWith(`<!doctype html><html data-theme="light" style="color-scheme: light"><head>`);
  // the skeleton's own color-scheme does not count as the fragment's
  expect(themed(asDocument(FRAGMENT), "dark")).toContain(`<html data-theme="dark">`);
  expect(themed(`<!doctype html><html style="margin:0"><style>body { color-scheme: light dark }</style>`, "dark")).toContain(`<html data-theme="dark" style="color-scheme: dark; margin:0">`);
});

test("every page address takes ?theme=: a shelf page, an older version, a room brief, a floor brief", async () => {
  await post("/api/rooms/pricing/brief", { body: PAGE, as: "pm" });
  const b = (await get("/api/state")).briefs.find((x: any) => x.title === "Pricing update");
  for (const p of ["/rooms/pricing/files/model.html", "/rooms/pricing/files/frag.html", "/rooms/pricing/brief.html", `/briefs/${b.id}.html`]) {
    const dark = await fetch(`${server.base}${p}?theme=dark`);
    sandboxed(dark);
    expect([p, (await dark.text()).includes(`data-theme="dark"`)]).toEqual([p, true]);
    expect([p, (await (await fetch(`${server.base}${p}`)).text()).includes("data-theme")]).toEqual([p, false]);
  }
  const v = (await get("/api/rooms/pricing/versions?brief=1")).versions.find((x: any) => x.html);
  expect(await (await fetch(`${server.base}/rooms/pricing/brief.html?v=${v.v}&theme=light`)).text()).toContain(`data-theme="light"`);
});
