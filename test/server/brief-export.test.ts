// BRIEF EXPORT, what goes in the file: a markdown brief, a page, a room's brief and page, with this server's own secret,
// comments, page data, lanes and floors planted around them, none of which may come out. The PDF and its printing are in
// test/client/brief-export-print.test.ts, the control in test/client/brief-export-walk.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-brief-export-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }, { name: "secret-lane-name", agent_status: "working", pane_id: "w1:p3", agent: "claude" }]);
const SECRET = "PLANTED-SECRET-VALUE-123";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let server: Awaited<ReturnType<typeof spawnServer>>;
const api = async (path: string, body: object, headers: Record<string, string> = {}) => {
  const r = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const asHq = async (pane: string, title: string, body: string) => (await api("/api/briefs", { title, body }, { "x-hud-pane": pane })).body.id as number;
const made = async (page: unknown, format = "html") => {
  const r = await api("/api/exports", { page, format });
  if (r.status !== 200) throw new Error(r.body.error);
  const f = await fetch(`${server.base}${r.body.url}`);
  return { ...r.body, res: f, text: await f.text() } as { name: string; url: string; warnings: string[]; res: Response; text: string };
};
const upload = async (slug: string, name: string, bytes: Uint8Array | string) => {
  const r = await fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=hq`, { method: "POST", headers: { "x-hud": "1" }, body: bytes });
  expect(r.status).toBe(200);
};

let md = 0, other = 0;
const MD = `## Where we are

The price is **live**, see \`src/app.ts\` and [the docs](https://example.com/docs). The key is ${SECRET}.

| Lane | State |
| --- | --- |
| api | merged |

BRIEFREF

#brief/999999

In running text BRIEFREF is plain.

[image: /Users/someone/private/folder/pic.png]

[image: /Users/someone/private/folder/never-uploaded.png]

[file: /Users/someone/private/uploads/pic.png]

\`\`\`ts
const answer = 42;
\`\`\`
`;

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_CHROME_PATH: "/nonexistent/chrome" } });
  await api("/api/sync", {});
  await api("/api/floors", { id: "crm", name: "CRM floor", hq: "hq-crm" });
  await api("/api/sync", {});
  await api("/api/secrets", { name: "PLANTED", value: SECRET, minutes: 60, by: "owner" });
  writeFileSync(join(dir, "uploads", "pic.png"), PNG);
  other = await asHq("w1:p1", "Older plan", "A body that must not come along: the-other-briefs-body.");
  md = await asHq("w1:p1", `Monday ${SECRET}: where we are`, MD.replaceAll("BRIEFREF", `#brief/${other}`));
  expect((await api("/api/comments/post", { page: `briefs/${md}`, text: "planted-comment-text" })).status).toBe(200);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("a markdown brief, as HTML", () => {
  let file = "";
  let out: Awaited<ReturnType<typeof made>>;
  beforeAll(async () => { out = await made(md); file = out.text; });

  test("downloads as a file named after its title, with the secret out of the name too", () => {
    expect(out.res.headers.get("content-disposition")).toStartWith("attachment");
    expect(out.name).toBe("monday-secret-planted-where-we-are.html");
    expect(out.res.headers.get("content-security-policy")).toContain("sandbox");
  });
  test("has the brief: its title and date, headings, table, code, links", () => {
    expect(file).toContain("<title>");
    expect(file).toContain("Where we are");
    expect(file).toContain("<table>");
    expect(file).toContain("const answer = 42;");
    expect(file).toContain(`href="https://example.com/docs"`);
    expect(file).toContain(String(new Date().getFullYear()));
  });
  test("a picture is in the file as data, and a missing one says so", () => {
    expect(file).toContain(`<img class="thumb" src="data:image/png;base64,${PNG.toString("base64")}"`);
    expect(file).toContain("[image left out: never-uploaded.png]");
    expect(out.warnings.join()).toContain("never-uploaded.png");
  });
  test("a reference prints nothing of what it names: on a line of its own it goes, in a sentence it is neutral, and the panel lists it", () => {
    expect(file).not.toContain("shadowrootmode");
    expect(file).not.toContain("Older plan");
    expect(file).not.toContain("the-other-briefs-body");
    expect(file).not.toContain("brief/999999");
    expect(file).not.toContain(`#brief/${other}`);
    expect(file.replaceAll("<!---->", "")).toContain("In running text (internal reference) is plain.");
    expect(out.warnings.join(" ")).toContain(`#brief/${other}`);
    expect(out.warnings.join(" ")).toContain("#brief/999999");
  });
  test("nothing points back at the HUD: no link, script or address", () => {
    expect(file).not.toMatch(/<script/i);
    expect(file).not.toMatch(/href="#brief/);
    expect(file).not.toMatch(/(?:href|src)="\/(?:uploads|rooms|src|api)/);
    expect(file).not.toContain("127.0.0.1");
    expect(file).not.toContain(server.base);
    expect(file).toContain(`content="default-src 'none'; script-src 'none'`);
  });
  test("carries its own font and styles, with both themes", () => {
    expect(file).toContain("data:font/woff2;base64,");
    expect(file).not.toContain("fonts.googleapis");
    expect(file).toContain("--ink:");
    expect(file).toContain("prefers-color-scheme: dark");
  });
  test("what stays out: the secret, comments, who wrote it, lanes, floors, machines, local paths from the markup", () => {
    expect(file).not.toContain(SECRET);
    expect(file).toContain("[secret PLANTED]");
    expect(file).not.toContain("planted-comment-text");
    expect(file).not.toContain("secret-lane-name");
    expect(file).not.toContain("hq-crm");
    expect(file).not.toContain("CRM floor");
    expect(file).not.toContain("/Users/someone");
    expect(file).not.toContain(dir);
    expect(file).not.toContain("COPY");
  });
});

describe("a brief that is a page, as HTML", () => {
  const PAGE = `<!doctype html><html><head><title>Page ${SECRET}</title><base href="http://127.0.0.1:1/"><meta http-equiv="refresh" content="0;url=/api/state"></head><body>
<!-- a note for the lane: /Users/someone/private -->
<h1 class="x">The page</h1><hud-card ref="brief/OTHER"></hud-card><div class="mermaid">graph LR; A--&gt;B</div>
<img src="/uploads/pic.png" alt="p"><img src="/api/state" alt="no"><a href="/rooms/x/files/y.html">other page</a><a href="https://example.com/">web</a>
<iframe src="/api/state"></iframe><script src="https://cdn.example.com/lib.js"></script><script>const v = "${SECRET}"; claude.use("db");</script></body></html>`;
  let file = "", warnings: string[] = [];
  beforeAll(async () => {
    const id = await asHq("w1:p1", "A page", PAGE.replace("OTHER", String(other)));
    const out = await made(id);
    file = out.text;
    warnings = out.warnings;
  });
  test("its own rules and runtime come first, before anything of the page's", () => {
    const csp = file.indexOf(`http-equiv="Content-Security-Policy"`), runtime = file.indexOf("saved copy"), title = file.indexOf("<title>");
    expect(csp).toBeGreaterThan(0);
    expect(csp).toBeLessThan(title);
    expect(runtime).toBeLessThan(title);
    expect(file.slice(0, csp)).toContain(`<meta charset="utf-8">`);
    expect(file.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)![1]).not.toContain("self");
  });
  test("a page with no viewport tag gets one, so it fits a phone; one that has its own keeps it alone", async () => {
    expect(file).toContain(`<meta name="viewport" content="width=device-width`);
    const own = await asHq("w1:p1", "Own viewport", `<!doctype html><html><head><meta name="viewport" content="width=800"></head><body>x</body></html>`);
    const { text } = await made(own);
    expect(text).toContain(`content="width=800"`);
    expect(text).not.toContain("width=device-width");
  });
  test("it cannot redirect or rebase itself, and its comments are gone", () => {
    expect(file).not.toMatch(/http-equiv="refresh"/i);
    expect(file).not.toMatch(/<base\b/i);
    expect(file).not.toContain("a note for the lane");
    expect(file).not.toContain("/Users/someone");
  });
  test("what it names on the HUD is carried as data or dropped; the web stays", () => {
    expect(file).toContain(PNG.toString("base64"));
    expect(file).not.toMatch(/src="\/api/);
    expect(file).not.toContain(`href="/rooms/`);
    expect(file).toContain(`href="https://example.com/"`);
    expect(file).toContain(`src="https://cdn.example.com/lib.js"`);
    expect(warnings.join(" ")).toContain("lib.js");
  });
  test("<hud-card> goes, with nothing of what it names, and the panel lists it; the secret is out of the source too", () => {
    expect(file).not.toMatch(/<hud-card/);
    expect(file).not.toContain("Older plan");
    expect(warnings.join(" ")).toContain(`#brief/${other}`);
    expect(file).not.toContain(SECRET);
  });
  test("the runtime does not talk to anyone: no hello, no HUD bridge", () => {
    expect(file).not.toContain("hud-page");
    expect(file).not.toContain("postMessage");
    expect(file).not.toContain("data-hud-page");
  });
  test("the diagrams' library is in the file, pinned", () => {
    expect(existsSync(join(dir, "export-cache", "mermaid-11.4.1.min.js")) || warnings.join(" ").includes("diagrams")).toBe(true);
    if (existsSync(join(dir, "export-cache", "mermaid-11.4.1.min.js"))) expect(file.length).toBeGreaterThan(2_000_000);
  });
});

describe("rooms", () => {
  const slug = "export-room", farSlug = "far-room";
  beforeAll(async () => {
    await api("/api/lanes", { name: "secret-lane-name", title: "a lane", status: "working" });
    expect((await api("/api/rooms", { slug, title: "Export room", owner: "secret-lane-name" }, { "x-hud-pane": "w1:p1" })).status).toBe(200);
    await api("/api/lanes", { name: "far-lane", title: "a lane", status: "working" }, { "x-hud-pane": "w1:p2" });
    expect((await api("/api/rooms", { slug: farSlug, title: "Far room", owner: "far-lane" }, { "x-hud-pane": "w1:p2" })).body.floor ?? "crm").toBe("crm");
    await upload(slug, "pic.png", PNG);
    await upload(slug, "style.css", `body { background: url(bg.png); color: ${"red"}; } /* ${SECRET} */`);
    await upload(slug, "bg.png", PNG);
    await upload(slug, "app.js", `window.fromFile = "file-script-ran"; const k = "${SECRET}"; const closes = "</script>";`);
    await upload(slug, "icon.svg", `<svg xmlns="http://www.w3.org/2000/svg"><text>${SECRET}</text></svg>`);
    await upload(slug, "notes.bin", "not a picture");
    await upload(farSlug, "far.png", PNG);
    await upload(slug, "page.html", `<!doctype html><html><head><title>Shelf page</title><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><img src="pic.png"><img src="icon.svg"><img src="/rooms/${farSlug}/files/far.png"><object data="notes.bin"></object><p>version two</p></body></html>`);
    await upload(slug, "page.html", `<!doctype html><html><head><title>Shelf page</title><link rel="stylesheet" href="style.css"><script src="app.js"></script></head><body><img src="pic.png"><img src="icon.svg"><img src="/rooms/${farSlug}/files/far.png"><object data="notes.bin"></object><p>version three</p></body></html>`);
    await api(`/api/rooms/${slug}/brief`, { body: "# First brief\n\nThe first words.", by: "hq" });
    await api(`/api/rooms/${slug}/brief`, { body: "# Second brief\n\nThe later words.", by: "hq" });
    await api(`/api/rooms/${slug}/say`, { text: "planted-thread-message", as: "hq" });
  }, 30_000);

  test("a room's markdown brief, with its thread left out", async () => {
    const { text, name } = await made(`rooms/${slug}/brief`);
    expect(name).toBe("export-room.html");
    expect(text).toContain("The later words.");
    expect(text).not.toContain("planted-thread-message");
  });
  test("an older version of a room's brief, by its address", async () => {
    const v = (await (await fetch(`${server.base}/api/rooms/${slug}/versions?brief=1`)).json() as any).versions[0].v;
    const { text } = await made(`rooms/${slug}/brief?v=${v}`);
    expect(text).toContain("The first words.");
    expect(text).not.toContain("The later words.");
  });
  test("a room's page carries its stylesheet, script and pictures, and leaves another floor's file out", async () => {
    const { text, warnings, name } = await made(`#page/rooms/${slug}/files/page.html`);
    expect(name).toBe("shelf-page.html");
    expect(text).toContain("version three");
    expect(text).not.toContain(`<link rel="stylesheet"`);
    expect(text).toContain(`url("data:image/png;base64,`);
    expect(text).toContain("file-script-ran");
    expect(text).toContain("<\\/script>");
    expect(text).not.toContain(`src="app.js"`);
    expect(text).toContain("[image left out: far.png]");
    expect(warnings.join(" ")).toContain("far.png");
    expect(text).not.toContain(SECRET);
    const svg = text.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/)![1];
    expect(Buffer.from(svg, "base64").toString()).not.toContain(SECRET);
    expect(Buffer.from(svg, "base64").toString()).toContain("[secret PLANTED]");
  });
  test("an older version of a room's page", async () => {
    const v = (await (await fetch(`${server.base}/api/rooms/${slug}/versions?file=page.html`)).json() as any).versions[0].v;
    expect((await made(`rooms/${slug}/files/page.html?v=${v}`)).text).toContain("version two");
  });
  test("a page's stored data stays out", async () => {
    const page = `rooms/${slug}/files/page.html`;
    expect((await api("/api/page-runtime/db", { page, op: "set", path: "things/a", data: { x: "planted-db-row" } })).status).toBe(200);
    expect((await api("/api/page-runtime/storage", { page, set: { k: "planted-storage-value" } })).status).toBe(200);
    expect(JSON.stringify((await api("/api/page-runtime/db", { page, op: "get", path: "things/a" })).body)).toContain("planted-db-row");
    const { text } = await made(page);
    expect(text).not.toContain("planted-db-row");
    expect(text).not.toContain("planted-storage-value");
  });
});

describe("a secret written with characters a renderer changes", () => {
  const AMP = `Xk9&amp2<Q"z'9-AMPVAL`, TICK = "abc`def`ghiTICKVAL", URLTOKEN = "PLANTEDLONGTOKEN0123456789012345678901234567890123456789012345678901234567890";
  beforeAll(async () => {
    for (const [name, value] of [["AMP", AMP], ["TICK", TICK], ["URLTOKEN", URLTOKEN]]) await api("/api/secrets", { name, value, minutes: 60, by: "owner" });
  });
  test("it is masked in a markdown body, a title, a link and a clipped address", async () => {
    const id = await asHq("w1:p1", `Title ${AMP}`, `Body ${AMP}\n\nTicks ${TICK}\n\n[a link](https://example.com/${AMP})\n\nhttps://example.com/x?token=${URLTOKEN}`);
    const { text, name } = await made(id);
    const shown = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<\/?code[^>]*>/g, "`");
    expect(shown).not.toContain(AMP);
    expect(shown).not.toContain(TICK);
    expect(text).not.toContain("PLANTEDLONGTOKEN");
    expect(text).toContain("[secret AMP]");
    expect(name).not.toContain("xk9");
  });
  test("a picture holding a secret value is left out and said so", async () => {
    writeFileSync(join(dir, "uploads", "holds-it.png"), `not really a picture, the key is ${SECRET}`);
    const { text, warnings } = await made(await asHq("w1:p1", "Holds it", "[image: /x/holds-it.png]"));
    expect(text).not.toContain(Buffer.from(`the key is ${SECRET}`).toString("base64").slice(0, 20));
    expect(warnings.join(" ")).toContain("holds-it.png");
  });
});

describe("what a page can pull in", () => {
  test("every file carried from this machine is named, so the owner sees it before sharing", async () => {
    const { warnings } = await made(await asHq("w1:p1", "Carries", "[image: /x/pic.png]"));
    expect(warnings.join(" ")).toContain("from this machine: pic.png");
  });
  test("a script or stylesheet comes only from a room's folder, never the owner's uploads", async () => {
    writeFileSync(join(dir, "uploads", "notes.js"), `window.privateNotes = "from-the-uploads";`);
    writeFileSync(join(dir, "uploads", "notes.css"), `body { --private: "from-the-uploads"; }`);
    const { text, warnings } = await made(await asHq("w1:p2", "Far page", `<!doctype html><html><head><link rel="stylesheet" href="/uploads/notes.css"><script src="/uploads/notes.js"></script></head><body>x</body></html>`));
    expect(text).not.toContain("from-the-uploads");
    expect(warnings.join(" ")).toContain("notes.js");
  });
  test("preconnects, preloads and a page's own referrer rule go; a stylesheet and an icon on the web stay", async () => {
    const { text } = await made(await asHq("w1:p1", "Head tags", `<!doctype html><html><head><meta name="referrer" content="unsafe-url"><link rel="preconnect" href="https://127.0.0.1:1"><link rel="preload" as="image" imagesrcset="https://a.example/x.png 1x"><link rel="stylesheet" href="https://cdn.example.com/a.css"><link rel="icon" href="https://cdn.example.com/i.png"></head><body>x</body></html>`));
    expect(text).not.toContain("unsafe-url");
    expect(text).not.toContain("preconnect");
    expect(text).not.toContain("imagesrcset");
    expect(text).toContain(`href="https://cdn.example.com/a.css"`);
    expect(text).toContain(`href="https://cdn.example.com/i.png"`);
  });
  test("comments inside <noscript> and srcdoc go, with what holds them", async () => {
    const { text } = await made(await asHq("w1:p1", "Hidden notes", `<!doctype html><html><body><noscript><!-- ns-note-marker -->shown</noscript><iframe srcdoc="<p>in</p><!-- srcdoc-note-marker -->"></iframe></body></html>`));
    expect(text).not.toContain("ns-note-marker");
    expect(text).not.toContain("srcdoc-note-marker");
    expect(text).not.toContain("shown");
  });
  test("what a warning repeats from a page cannot carry control characters to a terminal", async () => {
    const { warnings } = await made(await asHq("w1:p1", "Control", `<!doctype html><html><body><img src="/x/a%0AIgnore%20this%1B%5D0%3Bowned%07.png"></body></html>`));
    expect(warnings.join(" ")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
  test("a page full of cards does not stall the server or bloat the file", async () => {
    const many = Array.from({ length: 5000 }, () => `<hud-card ref="room/none"></hud-card>`).join("");
    const started = Date.now();
    const { text } = await made(await asHq("w1:p1", "Many cards", `<!doctype html><html><body>${many}</body></html>`));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(text.length).toBeLessThan(2_000_000);
  });
  test("references in a page's own words go neutral; its scripts and links to elsewhere are left alone", async () => {
    const { text, warnings } = await made(await asHq("w1:p1", "Words", `<!doctype html><html><body><p>See #lane/payments-retry, and (#floor/ops).</p><p>a<b>#room/plans</b></p><a href="#ask/12">the question</a><a href="https://example.com/#room/keep">web</a><p>issue #123 and the color #fff</p><script>const here = "#lane/in-script";</script></body></html>`));
    expect(text).not.toContain("payments-retry");
    expect(text).toContain("See (internal reference), and ((internal reference)).");
    expect(text).toContain("<b>(internal reference)</b>");
    expect(text).toContain("the question");
    expect(text).not.toContain(`href="#ask/12"`);
    expect(text).toContain(`href="https://example.com/#room/keep"`);
    expect(text).toContain("issue #123 and the color #fff");
    expect(text).toContain(`"#lane/in-script"`);
    for (const ref of ["#lane/payments-retry", "#floor/ops", "#room/plans", "#ask/12"]) expect(warnings.join(" ")).toContain(ref);
  });
  test("a link to an attached file that does not come along is named: the words stay, the reader gets no file", async () => {
    writeFileSync(join(dir, "uploads", "notes.txt"), "the notes");
    const { text, warnings } = await made(await asHq("w1:p1", "Attached", "Attached notes: [file: /x/uploads/notes.txt]"));
    expect(text).toContain("notes.txt");
    expect(text).not.toContain("the notes");
    expect(text).not.toContain(`href="/uploads`);
    expect(warnings.join(" ")).toContain("Named in the text, but the file is not inside: notes.txt");
  });
  test("a picture inside the file, or one said to be left out, is not also called missing because a link wraps it", async () => {
    const { warnings } = await made(await asHq("w1:p1", "Wrapped", "[image: /x/pic.png]\n\n[image: /x/not-there.png]"));
    const said = warnings.join(" ");
    expect(said).not.toContain("Named in the text");
    expect(said).toContain("from this machine: pic.png");
    expect(said).toContain("not on this machine any more: not-there.png");
  });
  test("each thing left out says its own reason", async () => {
    writeFileSync(join(dir, "uploads", "holds-it-2.png"), `not really a picture, the key is ${SECRET}`);
    writeFileSync(join(dir, "uploads", "no-kind.xyz"), "x");
    writeFileSync(join(dir, "uploads", "up.js"), "x");
    const { warnings } = await made(await asHq("w1:p1", "Reasons", `<!doctype html><html><head><script src="/uploads/up.js"></script></head><body><img src="/uploads/gone.png"><img src="/uploads/holds-it-2.png"><img src="/uploads/no-kind.xyz"><img src="http://192.168.1.2/lan.png"><img src="/rooms/far-room/files/far.png"></body></html>`));
    const said = warnings.join("\n");
    expect(said).toMatch(/not on this machine any more: gone\.png/);
    expect(said).toMatch(/holds a secret value: holds-it-2\.png/);
    expect(said).toMatch(/kind of file cannot go inside: no-kind\.xyz/);
    expect(said).toMatch(/public https address.*: lan\.png/);
    expect(said).toMatch(/another floor: far\.png/);
    expect(said).toMatch(/its own room's folder: up\.js/);
    expect(said).not.toContain("cannot carry");
  });
  test("what is known without asking the web is said before there is a file: a module, pointing to the PDF, and a picture's host; a script comes up on the download", async () => {
    const id = await asHq("w1:p1", "Web page", `<!doctype html><html><head><script src="https://cdn.example.com/chart.js"></script><script type="module" src="https://cdn.example.com/mod.js"></script></head><body><img src="https://images.example.com/a.png"></body></html>`);
    const said = (await api("/api/exports/check", { page: id })).body.warnings.join("\n");
    expect(said).not.toContain("chart.js");
    expect(said).toContain("mod.js");
    expect(said).toContain("PDF");
    expect(said).toContain("images.example.com");
    expect((await made(id)).warnings.join("\n")).toContain("chart.js");
  }, 30_000);
});

describe("where the file's own rules land", () => {
  const CSP = `http-equiv="Content-Security-Policy"`;
  const rulesFirst = async (body: string) => {
    const { text } = await made(await asHq("w1:p1", "Tricky head", body));
    const at = text.indexOf(CSP);
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(0, at)).toMatch(/^(?:<!doctype[^>]*>\s*)?<meta charset="utf-8"><meta $/i);
    return text;
  };
  test("before everything, however the page spells its head", async () => {
    await rulesFirst(`<!doctype html><html><head data-x='a>b'><title>x</title></head><body>a</body></html>`);
    await rulesFirst(`<!doctype html><html><head><title><head></title></head><body>a</body></html>`);
    await rulesFirst(`<!doctype html><html><body><script>var s = "<head>";</script></body></html>`);
    await rulesFirst(`<!doctype html><html><script>var early = 1;</script><head></head><body>a</body></html>`);
    await rulesFirst(`<html><body>no doctype</body></html>`);
    await rulesFirst(`<style>a { color: red; }</style><p>a fragment</p>`);
  });
});

describe("the file's name, title and source", () => {
  test("a name keeps its letters, whatever alphabet they are in, so briefs do not share one", async () => {
    expect((await made(await asHq("w1:p1", "Møde i Århus: ÆØÅ", "x"))).name).toBe("møde-i-århus-æøå.html");
    expect((await made(await asHq("w1:p1", "週次レポート", "x"))).name).toBe("週次レポート.html");
    expect((await made(await asHq("w1:p1", "売上の報告", "x"))).name).toBe("売上の報告.html");
    const { res, url } = await made(await asHq("w1:p1", "Résumé № 5", "x"));
    expect(decodeURIComponent(url)).toContain("résumé-5.html");
    expect(res.status).toBe(200);
    expect((await made(await asHq("w1:p1", "!!! ???", "x"))).name).toBe("brief.html");
  });
  test("a fragment gets a title; a page with its own keeps only that", async () => {
    const fragment = await made(await asHq("w1:p1", "Fragment title", `<style>p { color: red; }</style><p>a fragment</p>`));
    expect(fragment.text).toContain("<title>Fragment title</title>");
    const own = await made(await asHq("w1:p1", "Brief title", `<!doctype html><html><head><title>Own title</title></head><body>x</body></html>`));
    expect(own.text).toContain("<title>Own title</title>");
    expect(own.text).not.toContain("<title>Brief title</title>");
  });
  test("nothing in a file's source says where it came from", async () => {
    for (const page of [md, await asHq("w1:p1", "Source page", `<!doctype html><html><body><p>x</p><script>hud.use("x");</script></body></html>`)]) {
      const { text } = await made(page);
      expect(text).not.toMatch(/HQ Office/i);
      expect(text).not.toContain("src/server");
      expect(text).not.toContain("src/client");
    }
  });
});

describe("markup a page may honestly write", () => {
  test("a deferred script from the room's folder still runs after the page is read", async () => {
    await upload("export-room", "late.js", `window.lateScript = "ran-after-the-body";`);
    await api("/api/rooms/export-room/brief", { body: `<!doctype html><html><head><script src="/rooms/export-room/files/late.js" defer></script></head><body><p id="last">the last words</p></body></html>`, by: "hq" });
    const { text } = await made("rooms/export-room/brief");
    expect(text.indexOf("ran-after-the-body")).toBeGreaterThan(text.indexOf("the last words"));
    await api("/api/rooms/export-room/brief", { body: "# Second brief\n\nThe later words.", by: "hq" });
  });
  test("a comma inside an address in srcset stays in the address", async () => {
    const { text, warnings } = await made(await asHq("w1:p1", "Srcset", `<!doctype html><html><body><img srcset="https://images.example.com/w_200,h_100/a.jpg 1x, /uploads/pic.png 2x" src="/uploads/pic.png"></body></html>`));
    expect(text).toContain("https://images.example.com/w_200,h_100/a.jpg 1x");
    expect(warnings.join(" ")).not.toContain("a.jpg");
  });
  test("an address written with an entity finds its file", async () => {
    writeFileSync(join(dir, "uploads", "a&b.png"), PNG);
    const { text, warnings } = await made(await asHq("w1:p1", "Entity", `<!doctype html><html><body><img src="/uploads/a&amp;b.png"><meta http-equiv="&#114;efresh" content="0;url=/api/state"></body></html>`));
    expect(warnings.join(" ")).not.toContain("Left out");
    expect(text).toContain("data:image/png");
    expect(text).not.toContain("0;url=/api/state");
  });
  test("a question mark in a file's name is part of its name", async () => {
    await upload("export-room", "q?a.html", `<!doctype html><html><body>the question file</body></html>`);
    expect((await made("rooms/export-room/files/q?a.html")).text).toContain("the question file");
  });
});

describe("before the file is made: what masking cannot promise", () => {
  // Written in two parts, so no file here holds a whole key-shaped string.
  const STRIPE = "sk_" + "live_51MX9AZQ8KD2xyzw", GITHUB = "ghp_" + "abcdefghij0123456789", SLACK = "xox" + "b-123456789-abcdefgh", AWS = "AKIA" + "ABCDEFGHIJKLMNOP", OPENAI = "sk-" + "proj0123456789abcdefgh", BEARER = "Bearer " + "abcDEF123456ghiJKL789", RANDOM = "Zx81Qp0Lm47Vb29Nc63Tr18Yh50Kd72Ws4";
  const check = (page: unknown, headers?: Record<string, string>) => api("/api/exports/check", { page }, headers);
  test("each known shape and a long random string is named, shortened, never whole, and it says it is no guarantee", async () => {
    const id = await asHq("w1:p1", `Keys ${STRIPE}`, `One ${GITHUB}\n\n\`${SLACK}\`\n\n${AWS} ${OPENAI}\n\ncurl -H "Authorization: ${BEARER}"\n\n${RANDOM}`);
    const r = await check(id);
    expect(r.status).toBe(200);
    const said = r.body.warnings.join(" ");
    for (const whole of [STRIPE, GITHUB, SLACK, AWS, OPENAI, BEARER, RANDOM]) expect(said).not.toContain(whole);
    for (const short of ["sk_l…yzw".replace("yzw", "zw"), "ghp_…89", "xoxb…gh", "AKIA…OP", "sk-p…gh", "Bearer abcD…89", "Zx81…s4"]) expect(said).toContain(short);
    expect(said).toContain("no guarantee");
    // A warning, not a refusal, and what is stored stays as it was.
    expect((await made(id)).text).toContain(GITHUB);
    expect((await made(id)).warnings.join(" ")).toContain("ghp_…89");
  });
  test("plain words, a date, a commit link and a live secret raise nothing", async () => {
    const id = await asHq("w1:p1", "Plain", `Merged the payments-webhook-retry-after-the-migration branch on 2026-11-06, a7f3c1d. Key: ${SECRET}. Id 0f8fad5b-d9cb-469f-a165-70867728950e.\n\n[image: /x/pic.png]`);
    expect((await check(id)).body.warnings.join(" ")).not.toContain("looks like a key");
  });
  test("a picture's data and a script's hash are not keys", async () => {
    const id = await asHq("w1:p1", "Data", `<!doctype html><html><body><img src="data:image/png;base64,${PNG.toString("base64").repeat(3)}"><script integrity="sha384-Zx81Qp0Lm47Vb29Nc63Tr18Yh50Kd72Ws4Zx81Qp0Lm47"></script></body></html>`);
    expect((await check(id)).body.warnings.join(" ")).not.toContain("looks like a key");
  });
  test("a secret removed since it was set is named: its value can no longer be masked", async () => {
    await api("/api/secrets", { name: "SOON_GONE", value: "soon-gone-value-1234", minutes: 60, by: "owner" });
    const id = await asHq("w1:p1", "Gone", "the value is soon-gone-value-1234");
    expect((await check(id)).body.warnings.join(" ")).not.toContain("SOON_GONE");
    await api("/api/secrets/rm", { name: "SOON_GONE" });
    const said = (await check(id)).body.warnings.join(" ");
    expect(said).toContain("no longer holds");
    expect(said).toContain("SOON_GONE");
    await api("/api/secrets", { name: "SOON_GONE", value: "soon-gone-value-1234", minutes: 60, by: "owner" });
    expect((await check(id)).body.warnings.join(" ")).not.toContain("SOON_GONE");
  });
  test("a secret lost in a restart is named, in the check and with the file", async () => {
    const data = mkdtempSync(join(tmpdir(), "hq-export-lost-"));
    const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_CHROME_PATH: "/nonexistent/chrome" };
    const post = (base: string, path: string, body: object) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const first = await spawnServer({ cwd: ROOT, env });
    await post(first.base, "/api/secrets", { name: "LOST_KEY", value: "lost-key-value-1234", minutes: 60, by: "owner" });
    const id = (await post(first.base, "/api/briefs", { title: "Lost", body: "the value is lost-key-value-1234" })).id;
    await first.stop();
    const second = await spawnServer({ cwd: ROOT, env });
    try {
      expect((await post(second.base, "/api/exports/check", { page: id })).warnings.join(" ")).toContain("LOST_KEY");
      expect((await post(second.base, "/api/exports", { page: id, format: "html" })).warnings.join(" ")).toContain("LOST_KEY");
    } finally {
      await second.stop();
      rmSync(data, { recursive: true, force: true });
    }
  }, 40_000);
  test("the check asks what the file asks: another floor's agent is refused", async () => {
    const r = await check(`briefs/${md}`, { "x-hud-pane": "w1:p2" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not yours");
  });
  test("hud says it before the file, and says only what is true of masking", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hq-export-cli-"));
    const id = String(Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "brief", "--title", "Cli key", "--body", `the key ${GITHUB}`], { cwd, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe" }).stdout.toString().match(/#(\d+)/)![1]);
    const r = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "brief", "export", id, "--html"], { cwd, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).not.toContain(GITHUB);
    expect(out.indexOf("ghp_…89")).toBeGreaterThan(-1);
    expect(out.indexOf("ghp_…89")).toBeLessThan(out.indexOf(" KB)"));
    expect(out.match(/ghp_…89/g)!.length).toBe(1);
    expect(out).toContain("Only secret values HQ Office holds right now are masked");
    expect(out).not.toContain("Secret values are masked");
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("a held secret, however a page spells it", () => {
  const AMPV = "FAKE&sec<ret>value42", PLAINV = "FAKEplainSECRETvalue77";
  const page = (head: string, body: string) => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
  beforeAll(async () => {
    await api("/api/secrets", { name: "AMPV", value: AMPV, minutes: 60, by: "owner" });
    await api("/api/secrets", { name: "PLAINV", value: PLAINV, minutes: 60, by: "owner" });
  });
  // The file as a browser reads it.
  const rendered = (t: string) => t.replace(/&#x([0-9a-f]+);?/gi, (_a, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_a, d) => String.fromCodePoint(Number(d))).replace(/&lt;?/g, "<").replace(/&gt;?/g, ">").replace(/&quot;?/g, '"').replace(/&apos;/g, "'").replace(/&lsqb;/g, "[").replace(/&rsqb;/g, "]").replace(/&amp;?/g, "&");
  const out = async (body: string) => (await made(await asHq("w1:p1", "Spelled", body))).text;
  for (const [name, spelled] of [
    ["named references", "FAKE&amp;sec&lt;ret&gt;value42"],
    ["references with no semicolon", "FAKE&ampsec&ltret&gtvalue42"],
    ["decimal references", "FAKE&#38;sec&#60;ret&#62;value42"],
    ["hex references", "FAKE&#x26;sec&#x3C;ret&#x3e;value42"],
  ]) {
    test(`in the text, as ${name}`, async () => {
      const text = await out(page("", `<p>before ${spelled} after</p>`));
      expect(rendered(text)).not.toContain(AMPV);
      expect(text).toContain("before [secret AMPV] after");
    });
  }
  test("one reference in an otherwise plain value", async () => {
    const text = await out(page("", `<p>FAKEplain&#83;ECRETvalue77</p>`));
    expect(rendered(text)).not.toContain(PLAINV);
    expect(text).toContain("[secret PLAINV]");
  });
  test("a name most people never use: &lowbar; and &sol; and friends", async () => {
    await api("/api/secrets", { name: "ODD", value: "odd_value/with+marks", minutes: 60, by: "owner" });
    const text = await out(page("", `<p>odd&lowbar;value&sol;with&plus;marks</p>`));
    expect(text).toContain("[secret ODD]");
    expect(text).not.toContain("value&sol;with");
  });
  test("in an attribute and in <title>", async () => {
    const text = await out(page(`<title>x FAKEplain&#83;ECRETvalue77</title>`, `<div data-k="FAKEplain&#83;ECRETvalue77">x</div>`));
    expect(rendered(text)).not.toContain(PLAINV);
    expect(text).toContain("<title>x [secret PLAINV]</title>");
    expect(text).toContain(`data-k="[secret PLAINV]"`);
  });
  test("what is around it stays as written, entities included", async () => {
    const text = await out(page("", `<p>a &amp; b FAKEplain&#83;ECRETvalue77 &lt;c&gt; &copy; &nosuch;</p>`));
    expect(text).toContain("<p>a &amp; b [secret PLAINV] &lt;c&gt; &copy; &nosuch;</p>");
  });
  test("a room's page, its title and a carried SVG too", async () => {
    await upload("export-room", "spelled.svg", `<svg xmlns="http://www.w3.org/2000/svg"><text>FAKEplain&#83;ECRETvalue77</text></svg>`);
    await upload("export-room", "spelled.html", page(`<title>t FAKEplain&#83;ECRETvalue77</title>`, `<img src="spelled.svg"><p>FAKEplain&#83;ECRETvalue77</p>`));
    const out2 = await made("rooms/export-room/files/spelled.html");
    expect(out2.name).toContain("secret-plainv");
    expect(rendered(out2.text)).not.toContain(PLAINV);
    const svg = out2.text.match(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/)![1];
    expect(rendered(Buffer.from(svg, "base64").toString())).not.toContain(PLAINV);
  });
  test("a markdown brief is not touched by any of this: its source is shown as written", async () => {
    const text = await out("words &#83; and FAKEplainSECRETvalue77 here");
    expect(text).toContain("[secret PLAINV]");
    expect(text).toContain("&amp;#83;");
  });
  test("a value in a warning or the file's name is masked before it is cut: no 80 characters of a long one", async () => {
    const LONG = "L".repeat(40) + "x".repeat(60) + "Z9";
    await api("/api/secrets", { name: "LONGV", value: LONG, minutes: 60, by: "owner" });
    const percent = `${LONG.slice(0, 3)}%${LONG.charCodeAt(3).toString(16)}${LONG.slice(4)}`;
    const r = await made(await asHq("w1:p1", "Long", page("", `<img src="/uploads/${percent}.png">`)));
    expect(r.warnings.join(" ")).not.toContain(LONG.slice(0, 60));
    expect(r.text).not.toContain(LONG.slice(0, 60));
  });
});

describe("what the file's scan looks at", () => {
  const KEY = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789AB";
  const check = async (body: string) => (await api("/api/exports/check", { page: await asHq("w1:p1", "Scan", body) })).body.warnings.join(" ");
  const wrap = (s: string) => `<!doctype html><html><body>${s}</body></html>`;
  test("a key only in a comment does not go out, so it is not called one that would", async () => {
    expect(await check(wrap(`<!-- ${KEY} --><p>clean</p>`))).not.toContain("looks like a key");
  });
  test("a key in noscript or a frame's srcdoc does not go out, so it is not called one that would", async () => {
    for (const body of [`<noscript>${KEY}</noscript>`, `<iframe srcdoc="${KEY}"></iframe>`]) expect(await check(wrap(body))).not.toContain("looks like a key");
  });
  test("a key in a data attribute or a script does go out, and is named", async () => {
    for (const body of [`<div data-k="${KEY}">x</div>`, `<script>const k = "${KEY}";</script>`]) expect(await check(wrap(body))).toContain("ghp_…AB");
  });
  test("an integrity attribute exempts a real hash, not whatever it holds", async () => {
    expect(await check(wrap(`<div integrity="${KEY}">x</div>`))).toContain("ghp_…AB");
    expect(await check(wrap(`<script integrity="sha384-Zx81Qp0Lm47Vb29Nc63Tr18Yh50Kd72Ws4Zx81Qp0Lm47Vb29Nc63Tr18Yh" src="https://cdn.example.com/a.js"></script>`))).not.toContain("looks like a key");
  });
  test("a held value in a carried SVG is masked in the file, so it shows no piece of itself as a key", async () => {
    const V = "ghp_" + "FAKEheldVALUEabcdefghijklmnop0123456789";
    await api("/api/secrets", { name: "GHSVG", value: V, minutes: 60, by: "owner" });
    await upload("export-room", "held.svg", `<svg xmlns="http://www.w3.org/2000/svg"><text>${V}</text></svg>`);
    await upload("export-room", "held.html", wrap(`<img src="held.svg">`));
    const said = (await api("/api/exports/check", { page: "rooms/export-room/files/held.html" })).body.warnings.join(" ");
    expect(said).not.toContain("ghp_…");
  });
  test("a key in a carried SVG that is not held is named", async () => {
    await upload("export-room", "key.svg", `<svg xmlns="http://www.w3.org/2000/svg"><text>${KEY}</text></svg>`);
    await upload("export-room", "key.html", wrap(`<img src="key.svg">`));
    expect((await api("/api/exports/check", { page: "rooms/export-room/files/key.html" })).body.warnings.join(" ")).toContain("ghp_…AB");
  });
  test("a markdown brief's own styles and font raise nothing", async () => {
    expect(await check("Plain words only.")).not.toContain("looks like a key");
  });
});

describe("a page's own name for this machine", () => {
  test("nothing a page or a stylesheet can spell reaches a local file except by its own relative name", async () => {
    writeFileSync(join(dir, "uploads", "owner-private.png"), PNG);
    const { text, warnings } = await made(await asHq("w1:p1", "Spells it", `<!doctype html><html><body><img src="http://hud.invalid/uploads/owner-private.png"><div style="background:url(http://hud.invalid/uploads/owner-private.png)">x</div></body></html>`));
    expect(text).not.toContain(PNG.toString("base64"));
    expect(warnings.join(" ")).not.toContain("from this machine");
  });
  test("the page's own relative and absolute names still work", async () => {
    const { text } = await made(await asHq("w1:p1", "Own names", `<!doctype html><html><body><img src="/uploads/owner-private.png"></body></html>`));
    expect(text).toContain(PNG.toString("base64"));
  });
});

describe("markup that must not stop an export", () => {
  for (const [name, body] of [
    ["svg style", `<svg><style/><text>x</text></svg>`],
    ["svg script", `<svg><script/><text>x</text></svg>`],
    ["svg noscript", `<svg><noscript/><text>x</text></svg>`],
    ["svg script naming a file", `<svg><script href="/nowhere.js"/><script src="/uploads/nowhere.js"/><text>x</text></svg>`],
  ]) {
    test(`self-closed ${name}`, async () => {
      const id = await asHq("w1:p1", "Self closed", `<!doctype html><html><body>${body}<p>after-it</p></body></html>`);
      expect((await api("/api/exports/check", { page: id })).status).toBe(200);
      const r = await api("/api/exports", { page: id, format: "html" });
      expect(r.status).toBe(200);
      expect((await made(id)).text).toContain("after-it");
    });
  }
});

describe("what is said to be taken out is taken out", () => {
  const wrap = (s: string) => `<!doctype html><html><body>${s}</body></html>`;
  test("svg xlink:href, area href and form action on this machine", async () => {
    const { text } = await made(await asHq("w1:p1", "Links", wrap(`<svg><a xlink:href="http://127.0.0.1:4747/#lane/foo"><text>x</text></a><a xlink:href="#lane/bar"><text>y</text></a></svg><map><area href="/rooms/export-room/files/pic.png"><area href="http://192.168.1.2/a"></map><form action="http://127.0.0.1:4747/api/secrets"><button formaction="/api/state">go</button></form>`)));
    expect(text).not.toContain("127.0.0.1:4747");
    expect(text).not.toContain("#lane/");
    expect(text).not.toContain("/rooms/export-room");
    expect(text).not.toContain("192.168.1.2");
    expect(text).not.toContain("/api/state");
  });
  test("a link to a private place is cut and said as that, not as a missing file", async () => {
    const { text, warnings } = await made(await asHq("w1:p1", "Private", wrap(`<a href="http://127.0.0.1:4747/#brief/9">hud</a> <a href="https://192.168.1.2/a">nas</a> <a href="http://printer/x">printer</a>`)));
    for (const gone of ["127.0.0.1:4747", "192.168.1.2", "http://printer"]) expect(text).not.toContain(gone);
    expect(warnings.join(" ")).not.toContain("Named in the text");
    expect(warnings.join(" ")).toContain("private");
  });
  test("a public http link keeps its link, and no note says otherwise", async () => {
    const { text, warnings } = await made(await asHq("w1:p1", "Public http", wrap(`<a href="http://example.com/article-one">read</a>`)));
    expect(text).toContain(`href="http://example.com/article-one"`);
    expect(warnings.join(" ")).not.toContain("article-one");
  });
  test("a reference in a brief's title is out of the footer's title and the file's name, and is listed", async () => {
    const id = await asHq("w1:p1", "Fix for #lane/secret-lane in #floor/ops", "Plain words.");
    const r = await made(id);
    expect(r.name).not.toContain("secret-lane");
    expect(r.name).not.toContain("floor");
    expect(r.text).not.toContain("secret-lane");
    expect(r.warnings.join(" ")).toContain("#lane/secret-lane");
    expect(r.warnings.join(" ")).toContain("#floor/ops");
  });
});

describe("a frame written inside a page, and noscript", () => {
  const wrap = (s: string) => `<!doctype html><html><head><title>Frames</title></head><body><h1>The words</h1>${s}</body></html>`;
  const HELD = "FAKEplainSECRETvalue77", MARKS = "FAKE&sec<ret>value42";
  const brief = (body: string) => asHq("w1:p1", "Frames", wrap(body));
  beforeAll(async () => {
    await api("/api/secrets", { name: "FRAMEHELD", value: HELD, minutes: 60, by: "owner" });
    await api("/api/secrets", { name: "FRAMEMARKS", value: MARKS, minutes: 60, by: "owner" });
  });
  const LEFT = "a frame that is not at a web address";
  test("a held value encoded twice does not go out, and the frame is named, before the file and with it", async () => {
    const id = await brief(`<iframe title="The figures" srcdoc="<p>FAKEplain&amp;#83;ECRETvalue77</p>"></iframe>`);
    const before = (await api("/api/exports/check", { page: id })).body.warnings.join(" ");
    expect(before).toContain(LEFT);
    expect(before).toContain("The figures");
    const r = await api("/api/exports", { page: id, format: "html" });
    expect(r.body.warnings.join(" ")).toContain(LEFT);
    expect(r.body.hold).toBe("missing");
    const text = await (await fetch(`${server.base}${r.body.url}`)).text();
    expect(text).not.toContain("ECRETvalue77");
    expect(text).not.toContain("srcdoc");
    expect(text).toContain("The words");
  });
  test("text shown in a frame never becomes markup: what was encoded twice stays out", async () => {
    const { text } = await made(await brief(`<iframe srcdoc="FAKE&amp;amp;sec&amp;lt;ret&amp;gt;value42 &amp;lt;script&amp;gt;planted()&amp;lt;/script&amp;gt;"></iframe>`));
    expect(text).not.toContain("value42");
    expect(text).not.toContain("planted()");
    expect(text).not.toContain("<iframe");
  });
  test("a file it names does not count as inside: not its src, not its style", async () => {
    const r = await made(await brief(`<iframe srcdoc="<p>x</p>" src="/uploads/pic.png" style="background:url(/uploads/pic.png)"></iframe>`));
    expect(r.warnings.join(" ")).not.toContain("Inside the file");
    expect(r.text).not.toContain("data:image/png");
  });
  test("however it is written", async () => {
    for (const tag of [`<IFRAME SRCDOC="x"></IFRAME>`, `<iframe srcdoc></iframe>`, `<iframe srcdoc=x>`, `<svg><foreignObject><iframe srcdoc="x"></iframe></foreignObject></svg>`, `<template><iframe srcdoc="x"></iframe></template>`]) {
      const r = await api("/api/exports", { page: await brief(tag), format: "html" });
      expect(r.status).toBe(200);
      expect(r.body.hold).toBe("missing");
      expect((await (await fetch(`${server.base}${r.body.url}`)).text()).toLowerCase()).not.toContain("srcdoc");
    }
  });
  test("noscript goes with nothing said, and nothing held back", async () => {
    const r = await api("/api/exports", { page: await brief(`<noscript>Please enable JavaScript <img src="/uploads/pic.png"> #lane/in-noscript</noscript><p>after</p>`), format: "html" });
    expect(r.body.warnings).toEqual([]);
    expect(r.body.hold).toBeUndefined();
    const text = await (await fetch(`${server.base}${r.body.url}`)).text();
    expect(text).not.toContain("Please enable");
    expect(text).not.toContain("noscript");
    expect(text).toContain("after");
  });
  test("a frame made by a script is the page's own, and stays", async () => {
    const r = await api("/api/exports", { page: await brief(`<script>const f = document.createElement("iframe"); f.srcdoc = "<p>made</p>"; document.body.append(f);</script>`), format: "html" });
    expect(r.body.hold).toBeUndefined();
    expect(await (await fetch(`${server.base}${r.body.url}`)).text()).toContain("f.srcdoc");
  });
  describe("a deferred script stays the page's", () => {
    const placed = async (between: string) => {
      await upload("export-room", "late-lib.js", `window.lateLibRan = 1;`);
      await api("/api/rooms/export-room/brief", { body: `<!doctype html><html><head><script src="/rooms/export-room/files/late-lib.js" defer></script></head><body>${between}<p id="last">the last words</p></body></html>`, by: "secret-lane-name" });
      const { text } = await made("rooms/export-room/brief");
      const lib = text.indexOf("lateLibRan");
      expect(lib).toBeGreaterThan(text.indexOf("the last words"));
      expect(text.lastIndexOf("<script", lib)).toBeGreaterThan(text.indexOf("the last words"));
      return text;
    };
    test("next to noscript", async () => {
      expect(await placed(`<noscript>Please enable JavaScript</noscript>`)).not.toContain("noscript");
    });
    test("next to a srcdoc frame", async () => {
      expect(await placed(`<iframe srcdoc="<p>in the frame</p>"></iframe>`)).not.toContain("in the frame");
    });
  });
});

describe("a frame or a picture written inside its own address", () => {
  const wrap = (s: string) => `<!doctype html><html><head><title>Data</title></head><body><h1>The words</h1>${s}</body></html>`;
  const MARKS = "FAKE&dat<ret>value43", SPELLED = "FAKE&amp;dat&lt;ret&gt;value43", CODED = encodeURIComponent(SPELLED);
  const brief = (body: string) => asHq("w1:p1", "Data", wrap(body));
  const file = async (id: number) => {
    const r = await api("/api/exports", { page: id, format: "html" });
    return { warnings: r.body.warnings.join(" "), hold: r.body.hold, text: await (await fetch(`${server.base}${r.body.url}`)).text() };
  };
  beforeAll(() => api("/api/secrets", { name: "DATAMARKS", value: MARKS, minutes: 60, by: "owner" }));
  const LEFT = "a frame that is not at a web address";
  const doc = encodeURIComponent(`<p>${SPELLED}</p><!-- a comment in it --><p>#lane/secret-lane</p>`);
  for (const [name, tag] of [
    ["iframe", `<iframe title="The figures" src="data:text/html,${doc}"></iframe>`],
    ["iframe in upper case", `<IFRAME title="The figures" SRC="DATA:text/html,${doc}"></IFRAME>`],
    ["a scheme after spaces", `<iframe title="The figures" src="   data:text/html,${doc}"></iframe>`],
    ["a scheme after a tab and a new line", `<iframe title="The figures" src="&#9;&#10;da&#10;ta:text/html,${doc}"></iframe>`],
    ["a scheme spelled with references", `<iframe title="The figures" src="&#100;&#97;ta:text/html,${doc}"></iframe>`],
    ["frame", `<frameset><frame title="The figures" src="data:text/html,${doc}"></frameset>`],
    ["object", `<object title="The figures" data="data:text/html,${doc}">words</object>`],
    ["embed", `<embed title="The figures" src="data:text/html,${doc}">`],
    ["javascript:", `<iframe title="The figures" src="javascript:%27${doc}%27"></iframe>`],
    ["javascript: with a tab", `<iframe title="The figures" src="java&#9;script:%27${doc}%27"></iframe>`],
    ["JAVASCRIPT: in an object", `<object title="The figures" data="JAVASCRIPT:%27${doc}%27"></object>`],
    ["view-source:", `<iframe title="The figures" src="view-source:data:text/html,${doc}"></iframe>`],
    ["blob:", `<iframe title="The figures" src="blob:null/x?${doc}"></iframe>`],
    ["file:", `<iframe title="The figures" src="file:///x?${doc}"></iframe>`],
    ["about: other than blank", `<iframe title="The figures" src="about:srcdoc?${doc}"></iframe>`],
  ]) test(`${name}: left out, named, before the file and with it, and the file is held`, async () => {
    const id = await asHq("w1:p1", "Data", name === "frame" ? `<!doctype html><html><head><title>Data</title></head>${tag}</html>` : wrap(tag));
    const before = (await api("/api/exports/check", { page: id })).body.warnings.join(" ");
    expect(before).toContain(LEFT);
    expect(before).toContain("The figures");
    const f = await file(id);
    expect(f.warnings).toContain(LEFT);
    expect(f.hold).toBe("missing");
    expect(f.text).not.toContain(CODED);
    expect(f.text).not.toContain("a%20comment%20in%20it");
    expect(f.text).not.toContain("text/html,");
  });
  test("a frame's address is treated like an iframe's: this machine and a private network cut, the public web kept", async () => {
    const frames = (src: string) => asHq("w1:p1", "Data", `<!doctype html><html><head><title>Data</title></head><frameset><frame src="${src}"></frameset></html>`);
    for (const src of ["http://192.168.1.2/x", "http://127.0.0.1:18450/x", "local-frame.html"]) {
      const f = await file(await frames(src));
      expect(f.text).not.toContain(src);
    }
    expect((await file(await frames("https://e.example/x"))).text).toContain("https://e.example/x");
  });
  test("a frame with no name is still said to be left out", async () => {
    expect((await file(await brief(`<iframe src="data:text/html,x"></iframe>`))).warnings).toContain("a frame with no name");
  });
  for (const [name, src] of [["on the web", "https://e.example/x"], ["public http", "http://e.example/x"], ["relative", "there.html"], ["absolute in the HUD", "/there.html"], ["with no scheme", "//e.example/x"], ["blank", "about:blank"], ["BLANK", "ABOUT:BLANK"]]) test(`a frame ${name} is not one of these`, async () => {
    const f = await file(await brief(`<iframe title="Live" src="${src}"></iframe>`));
    expect(f.warnings).not.toContain(LEFT);
    expect(f.hold).toBeUndefined();
  });
  test("nor one with no address at all", async () => {
    const f = await file(await brief(`<iframe title="Live"></iframe><object></object>`));
    expect(f.warnings).not.toContain(LEFT);
    expect(f.hold).toBeUndefined();
  });
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text y="20">${inner}</text></svg>`;
  const CALLED = "a picture written in the page", PLAIN = "FAKEplaindatavalue77";
  beforeAll(() => api("/api/secrets", { name: "DATAPLAIN", value: PLAIN, minutes: 60, by: "owner" }));
  const addresses: [string, string][] = [
    ["spelled, percent", `data:image/svg+xml,${encodeURIComponent(svg(SPELLED))}`],
    ["spelled, percent, a charset", `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg(SPELLED))}`],
    ["spelled, base64", `data:image/svg+xml;base64,${Buffer.from(svg(SPELLED)).toString("base64")}`],
    ["spelled, base64, a charset, upper case", `DATA:IMAGE/SVG+XML;charset=utf-8;BASE64,${Buffer.from(svg(SPELLED)).toString("base64")}`],
    ["plain, base64", `data:image/svg+xml;base64,${Buffer.from(svg(PLAIN)).toString("base64")}`],
  ];
  const held = (address: string): [string, string][] => [
    ["img src", `<img alt="The chart" src="${address}">`],
    ["img srcset", `<img srcset="${address} 1x">`],
    ["picture source", `<picture><source srcset="${address}"><img alt="x"></picture>`],
    ["input", `<input type="image" src="${address}">`],
    ["video poster", `<video poster="${address}"></video>`],
    ["svg image", `<svg><image href="${address}"/></svg>`],
    ["svg feImage", `<svg><filter><feImage href="${address}"/></filter></svg>`],
    ["image src", `<image src="${address}">`],
    ["svg set", `<svg><image><set attributeName="href" to="${address}"/></image></svg>`],
    ["svg animate", `<svg><image><animate attributeName="href" values="${address}"/></image></svg>`],
    ["style attribute", `<div style="background:url('${address}')"></div>`],
    ["style attribute, escaped quotes", `<div style="background:url(&quot;${address}&quot;)"></div>`],
    ["style tag", `<style>.z{background:url("${address}")}</style>`],
    ["style tag, bare", `<style>.z{background:url(${address})}</style>`],
    ["content", `<style>.z::before{content:url("${address}")}</style>`],
    ["table background", `<table background="${address}"><tr><td>x</td></tr></table>`],
    ["body of the text", `<p>${address}</p>`],
    ["a link", `<a href="${address}">open</a>`],
    ["unquoted", `<img src=${address}>`],
  ];
  for (const [how, address] of addresses) for (const [where, tag] of held(address)) test(`a held value in a data: address, ${how}, ${where}: cut, named as a picture, nothing of its address said`, async () => {
    const id = await brief(tag);
    const said = (await api("/api/exports/check", { page: id })).body.warnings.join(" ");
    expect(said).toContain("holds a secret value");
    expect(said).toContain(CALLED);
    expect(said).not.toContain("svg");
    const f = await file(id);
    expect(f.warnings).toContain(CALLED);
    expect(f.text.toLowerCase()).not.toContain("svg+xml;");
    expect(f.text).not.toContain(address.slice(address.indexOf(",") + 1));
    expect(f.text).toContain("The words");
  });
  test("an address written out, not encoded, is read as the attribute reads it: its own level of references counts", async () => {
    const f = await file(await brief(`<img src='data:image/svg+xml,${svg(SPELLED).replaceAll("&", "&amp;")}'>`));
    expect(f.warnings).toContain(CALLED);
    expect(f.text).not.toContain("svg+xml,");
  });
  test("a text address that is not a picture is cut the same way: what is in the file is what counts", async () => {
    const f = await file(await brief(`<link rel="stylesheet" href="data:text/css,${encodeURIComponent(`a::after{content:"${SPELLED}"}`)}"><a href="data:text/plain;base64,${Buffer.from(SPELLED).toString("base64")}">x</a>`));
    expect(f.warnings).toContain(CALLED);
    expect(f.text).not.toContain(encodeURIComponent(SPELLED));
    expect(f.text).not.toContain(Buffer.from(SPELLED).toString("base64"));
  });
  for (const [name, address] of [
    ["percent", `data:image/svg+xml,${encodeURIComponent(svg("a chart"))}`],
    ["base64", `data:image/svg+xml;base64,${Buffer.from(svg("a chart")).toString("base64")}`],
    ["a stray percent", `data:image/svg+xml,&lt;svg xmlns='http://www.w3.org/2000/svg'&gt;&lt;text&gt;100%&lt;/text&gt;&lt;/svg&gt;`],
    ["a word in a sentence that only looks like one", `data:,`],
  ]) test(`an address holding nothing, ${name}: left byte for byte`, async () => {
    const f = await file(await brief(`<img alt="Fine" src="${address}"><p>x</p>`));
    expect(f.warnings).not.toContain("holds a secret");
    expect(f.text).toContain(`src="${address}"`);
  });
  test("a binary address is not decoded or asked about: it is not text a browser will read", async () => {
    const png = `data:image/png;base64,${Buffer.from(PLAIN).toString("base64")}`;
    const f = await file(await brief(`<img src="${png}">`));
    expect(f.warnings).not.toContain("holds a secret");
    expect(f.text).toContain(png);
  });
  test("an address behind CSS escapes is cut and named, so a private one cannot stay", async () => {
    for (const css of [`url(http://10.0.0.5/a\\(1\\).png)`, `url(http://10.0.0.5/a\\ b.png)`, `url("http://10.0.0.5/a\\.png")`, `url('http://10.0.0.5/a\\.png')`, `url(\\68ttp://10.0.0.5/a.png)`]) {
      const f = await file(await brief(`<style>.a { background: ${css} }</style>`));
      expect(f.text).not.toContain("10.0.0.5");
      expect(f.warnings).toContain("Left out");
    }
  });
  test("what SVG asks for: a private address or a local name is cut, the public web stays", async () => {
    const f = await file(await brief(`<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script href="http://127.0.0.1:18450/a.js"></script><script xlink:href="http://192.168.1.2/b.js"></script><script href="local-part.js"></script><filter><feImage href="http://192.168.1.3/c.png"/><feImage xlink:href="private-picture.png"/><feImage href="https://e.example/d.png"/></filter><script href="https://e.example/e.js"></script></svg>`));
    for (const gone of ["127.0.0.1", "192.168.1.2", "192.168.1.3", "local-part.js", "private-picture.png"]) expect(f.text).not.toContain(gone);
    expect(f.text).toContain("https://e.example/d.png");
    expect(f.text).toContain("https://e.example/e.js");
  });
});

describe("what stood either side of something removed does not join", () => {
  const wrap = (s: string) => `<!doctype html><html><head><title>Joins</title></head><body><h1>The words</h1>${s}</body></html>`;
  const file = async (body: string) => {
    const r = await api("/api/exports", { page: await asHq("w1:p1", "Joins", body), format: "html" });
    return { warnings: r.body.warnings.join(" "), text: await (await fetch(`${server.base}${r.body.url}`)).text() };
  };
  const rendered = (html: string) => new HTMLRewriter().on("iframe, img, meta, base, hud-card, noscript", { element(el) { seen.push(el.tagName); } }).transform(html);
  let seen: string[] = [];
  const tags = (html: string) => { seen = []; rendered(html); return seen.filter((t) => t !== "meta"); };
  for (const [name, between] of [
    ["a comment", "<!---->"], ["a comment with words", "<!-- words -->"], ["a noscript", "<noscript>x</noscript>"], ["a card", `<hud-card ref="#brief/1"></hud-card>`], ["a base", `<base href="x">`],
    ["a preconnect", `<link rel="preconnect" href="https://e.example/">`], ["a refresh", `<meta http-equiv="refresh" content="0">`], ["a referrer rule", `<meta name="referrer" content="always">`],
    ["a frame written inside", `<iframe srcdoc="x"></iframe>`], ["a link cut", `<a href="#brief/1"></a>`], ["a local link cut", `<a href="local-file.html"></a>`], ["an image map's area", `<map><area href="local-file.html"></map>`],
  ]) {
    test(`${name}, then a frame written inside: no frame comes back`, async () => {
      const f = await file(wrap(`<${between}iframe srcdoc="<p>JOINED-WORDS</p>"></iframe>`));
      expect(tags(f.text)).not.toContain("iframe");
    });
    test(`${name}, then a private address: no picture comes back`, async () => {
      const f = await file(wrap(`<${between}img src="http://192.168.1.2/a.png">`));
      expect(tags(f.text)).not.toContain("img");
    });
  }
  test("a link's own words between: neither end joins", async () => {
    const f = await file(wrap(`<a href="#brief/1"><</a>iframe srcdoc="x"></iframe>`));
    expect(tags(f.text)).not.toContain("iframe");
  });
  for (const [name, again] of [["a noscript", "noscript><p>IN-NOSCRIPT</p></noscript>"], ["a card", `hud-card ref="#lane/secret-lane"></hud-card>`], ["a base", `base href="https://e.example/">`], ["a refresh", `meta http-equiv="refresh" content="0;url=https://e.example/">`]]) test(`a comment, then ${name}: not read as a tag`, async () => {
    const f = await file(wrap(`<<!---->${again}`));
    expect(tags(f.text).filter((t) => ["noscript", "hud-card", "base"].includes(t))).toEqual([]);
    expect(f.text).not.toContain("<meta http-equiv=\"refresh");
  });
  test("a comment that would come back as a comment: gone", async () => {
    expect((await file(wrap("<<!---->!-- COMMENT-WORDS -->"))).text).not.toContain("<!-- COMMENT-WORDS");
  });
  test("a page that starts with a comment keeps its doctype first, and the file's rules ahead of everything of the page's", async () => {
    const { text } = await file(`<!-- a note --><!doctype html><html><head><title>Joins</title></head><body><p>x</p></body></html>`);
    expect(text).toMatch(/^<!---->\s*<!doctype html>/i);
    expect(text.indexOf("Content-Security-Policy")).toBeLessThan(text.indexOf("<title"));
  });
});

describe("what a script really imports", () => {
  const P = (head: string) => `<!doctype html><html><head><title>Imports</title>${head}</head><body><h1>Q3 report</h1><canvas id=c></canvas></body></html>`;
  const STOP = "could not bring these in";
  for (const [name, head] of [
    ["a comment that once imported", `<script>// import Chart from "https://esm.sh/chart.js"; // did not work offline\nwindow.x = 1;</script>`],
    ["a comment about where the library came from", `<script>/* Chart is loaded from "https://cdn.jsdelivr.net/npm/chart.js" above */ window.x = 1;</script>`],
    ["a caption naming a data source", `<script>const caption = "Figures from 'https://data.example.gov/q3.csv', fetched in May";</script>`],
    ["a log path shown to the reader", `<script>const note = 'Read from "/var/log/app.log" on the build box';</script>`],
    ["copied from a relative path", `<script>const row = { src: 'copied from "./data/q3.csv"' };</script>`],
    ["a code sample in a string", `<script>const sample = 'import React from "https://esm.sh/react"';</script>`],
    ["a JSON island", `<script type="application/json" id="d">{"caption":"figures from 'https://data.example.gov/q3.csv'"}</script>`],
    ["a text/plain sample", `<script type="text/plain" id="s">import d3 from "https://esm.sh/d3"</script>`],
    ["a text/template", `<script type="text/template"><p>from "/x/y"</p></script>`],
    ["a displayed sample", `<style>pre{margin:0}</style>`],
    ["a script that does not parse makes no claim", `<script>function ( { import("https://esm.sh/z")</script>`],
    ["a script's own text when it has a src", `<script src="data:text/javascript,1">import("https://esm.sh/z")</script>`],
    ["a bare name, which no address backs", `<script type="module">import "d3";</script>`],
    ["require is not an import", `<script>require("./a.js")</script>`],
    ["an import statement in a classic script never runs", `<script>import x from "https://esm.sh/x";</script>`],
    ["an import map that does not parse", `<script type="importmap">{ not json "https://esm.sh/x" }</script>`],
    ["a map to data", `<script type="importmap">{"imports":{"a":"data:text/javascript,1"}}</script>`],
  ]) test(`not held back: ${name}`, async () => {
    const r = await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(head)), format: "html" });
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).not.toContain(STOP);
  });
  for (const [name, head, named] of [
    ["minified, no spaces", `<script type="module">import{a}from"https://esm.sh/x";a()</script>`, "x"],
    ["no binding, no space", `<script type="module">import"https://esm.sh/y";</script>`, "y"],
    ["spaced", `<script type="module">import * as d3 from "https://esm.sh/d3@7";</script>`, "d3@7"],
    ["export from", `<script type="module">export * from "https://esm.sh/z";</script>`, "z"],
    ["relative", `<script type="module">import "./local-part.js";</script>`, "local-part.js"],
    ["import() in a function nobody calls", `<script>function later() { return import("https://esm.sh/lodash"); }</script>`, "lodash"],
    ["text/javascript with import()", `<script type="TEXT/JavaScript">import("https://esm.sh/w")</script>`, "w"],
    ["a map's address", `<script type="importmap">{"imports":{"d3":"https://esm.sh/d3@7"}}</script>`, "d3@7"],
    ["a map's relative address", `<script type="importmap">{"imports":{"a":"./a-part.js"}}</script>`, "a-part.js"],
    ["a map's scope", `<script type="importmap">{"scopes":{"/x/":{"b":"/b-part.js"}}}</script>`, "b-part.js"],
  ]) test(`held back and named: ${name}`, async () => {
    const id = await asHq("w1:p1", "Imports", P(head));
    expect((await api("/api/exports/check", { page: id })).body.warnings.join(" ")).toContain(STOP);
    const r = await api("/api/exports", { page: id, format: "html" });
    expect(r.body.hold).toBe("missing");
    expect(r.body.warnings.join(" ")).toContain(`${named} (it is imported`);
  });
  test("a script from the room's own folder is read too", async () => {
    await upload("export-room", "loader.js", `function load() { return import("./chunk-part.js"); }`);
    await api("/api/rooms/export-room/brief", { body: P(`<script src="/rooms/export-room/files/loader.js"></script>`), by: "secret-lane-name" });
    const r = await api("/api/exports", { page: "rooms/export-room/brief", format: "html" });
    expect(r.body.hold).toBe("missing");
    expect(r.body.warnings.join(" ")).toContain("chunk-part.js");
  });
  const UNREAD = "was not read";
  const LONG = "var aaaaaaaa = 1;\n".repeat(200_000);
  test("a script too long to read says so, is not held, and may still ask the web", async () => {
    const id = await asHq("w1:p1", "Imports", P(`<script>import("https://esm.sh/late");${LONG}</script>`));
    const said = (await api("/api/exports/check", { page: id })).body.warnings.join(" ");
    expect(said).toContain(UNREAD);
    expect(said).toContain("may ask the web");
    expect(said).toContain("a script in the page");
    const r = await api("/api/exports", { page: id, format: "html" });
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).toContain(UNREAD);
  });
  test("so is a script the parser refused, if it has the word", async () => {
    const r = await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(`<script>function ( { import("https://esm.sh/z")</script>`)), format: "html" });
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).toContain(UNREAD);
  });
  test("and nothing is said of a long script without that word, or of what cannot run", async () => {
    const plain = await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(`<script>${LONG}</script>`)), format: "html" });
    expect(plain.body.warnings.join(" ")).not.toContain(UNREAD);
    const data = await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(`<script type="text/plain">function ( { import("https://esm.sh/z")</script>`)), format: "html" });
    expect(data.body.warnings.join(" ")).not.toContain(UNREAD);
  });
  test("the total counts, not each script: past it, the next is not read, though a small one still is", async () => {
    const big = "var aaaaaaaa = 1;\n".repeat(50_000);
    const r = await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(`<script>import("https://esm.sh/one");${big}</script>`.repeat(5) + `<script>import("https://esm.sh/small")</script>`)), format: "html" });
    const said = r.body.warnings.join(" ");
    expect(said).toContain(UNREAD);
    expect(said).toContain("small (it is imported");
  });
  test("a local script too long to read is still said to go in the file, and not to have been read", async () => {
    await upload("export-room", "long-loader.js", `import("./chunk-part.js");${LONG}`);
    await upload("export-room", "long-loader.html", P(`<script src="long-loader.js"></script>`));
    const said = (await api("/api/exports", { page: "rooms/export-room/files/long-loader.html", format: "html" })).body.warnings.join(" ");
    expect(said).toContain("Inside the file, from this machine: long-loader.js");
    expect(said).toContain(`${UNREAD}: long-loader.js`);
    expect(said).not.toContain("chunk-part.js");
  });
  test("a module importing a sibling: what is said of it is true of a local file", async () => {
    const said = (await api("/api/exports", { page: await asHq("w1:p1", "Imports", P(`<script type="module">import "./sibling-part.js";</script>`)), format: "html" })).body.warnings.join(" ");
    expect(said).toContain("sibling-part.js (it is imported when the page runs)");
    expect(said).not.toContain("imported from the web");
  });
  test("a page nobody can parse does not stop the server: nesting deep enough to overflow a parser", async () => {
    const r = await api("/api/exports", { page: await asHq("w1:p1", "Deep", P(`<script>import("https://esm.sh/deep");${"(".repeat(1_000_000)}</script>`)), format: "html" });
    expect(r.status).toBe(200);
    expect(r.body.hold).toBeUndefined();
  });
});

describe("a value in an address", () => {
  const VALUE = "PCT&val<ue>4242";
  beforeAll(async () => { await api("/api/secrets", { name: "PCT", value: VALUE, minutes: 60, by: "owner" }); });
  test("in a page, a brief in markdown, a title and a file from the room", async () => {
    const coded = encodeURIComponent(VALUE);
    expect(coded).toContain("%");
    const page = await made(await asHq("w1:p1", "In a page", `<!doctype html><html><body><a href="https://example.com/?k=${coded}">go</a><iframe src="data:text/html,${coded}"></iframe></body></html>`));
    expect(page.text).not.toContain("ue%3E4242");
    expect(page.text).toContain("[secret PCT]");
    expect((await made(await asHq("w1:p1", "In words", `[go](https://example.com/?k=${coded})`))).text).not.toContain("ue%3E4242");
    expect((await made(await asHq("w1:p1", `Title ${coded}`, `words`))).text).not.toContain("ue%3E4242");
    await upload("export-room", "with-link.css", `a { background: url("https://example.com/?k=${coded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())}"); }`);
    await api("/api/rooms/export-room/brief", { body: `<!doctype html><html><head><link rel="stylesheet" href="/rooms/export-room/files/with-link.css"></head><body>x</body></html>`, by: "secret-lane-name" });
    expect((await made("rooms/export-room/brief")).text).not.toContain("ue%3e4242");
  });
  test("Windows-1252 numeric references, in a page", async () => {
    await api("/api/secrets", { name: "EUROV", value: "pre€sec1234", minutes: 60, by: "owner" });
    const { text } = await made(await asHq("w1:p1", "Euro", `<!doctype html><html><body><p>pre&#128;sec1234</p></body></html>`));
    expect(text).not.toContain("sec1234");
  });
  test("a query named like a reference is the address the page wrote", async () => {
    const r = await api("/api/exports/check", { page: await asHq("w1:p1", "Query", `<!doctype html><html><head><script type="module" src="https://cdn.example.com/q-part.js?a=1&lt=3"></script></head><body>x</body></html>`) });
    expect(r.body.warnings.join(" ")).toContain("q-part.js");
  });
});

describe("a file kept for the page it was made from", () => {
  const token = (r: { body: { url: string } }) => r.body.url.split("/")[2];
  const kept = async (t: string, page: unknown) => (await api("/api/exports/kept", { token: t, page })).body.kept;
  test("a room's brief replaced: no longer kept", async () => {
    await api("/api/rooms/export-room/brief", { body: "# The first words", by: "secret-lane-name" });
    const t = token(await api("/api/exports", { page: "rooms/export-room/brief", format: "html" }));
    expect(await kept(t, "rooms/export-room/brief")).toBe(true);
    await api("/api/rooms/export-room/brief", { body: "# The new words", by: "secret-lane-name" });
    expect(await kept(t, "rooms/export-room/brief")).toBe(false);
  });
  test("a room's file replaced: no longer kept", async () => {
    await upload("export-room", "moved.html", "<!doctype html><title>Moved</title><p>first</p>");
    const page = "rooms/export-room/files/moved.html";
    const t = token(await api("/api/exports", { page, format: "html" }));
    expect(await kept(t, page)).toBe(true);
    await upload("export-room", "moved.html", "<!doctype html><title>Moved</title><p>second</p>");
    expect(await kept(t, page)).toBe(false);
  });
  test("a file made from an older version stands, whatever the newest says", async () => {
    await upload("export-room", "versions.html", "<!doctype html><title>V</title><p>one</p>");
    await upload("export-room", "versions.html", "<!doctype html><title>V</title><p>two</p>");
    const t = token(await api("/api/exports", { page: "rooms/export-room/files/versions.html", format: "html" }));
    expect(await kept(t, "rooms/export-room/files/versions.html")).toBe(true);
  });
  describe("a held value and a kept file", () => {
    const PAGE = (v: string) => `<!doctype html><title>Held</title><p>the words ${v}</p>`;
    test("a value handed over since the file was made, and found in the page: no longer kept", async () => {
      const V = "FAKEaddedLATERvalue99";
      const id = await asHq("w1:p1", "Held", PAGE(V));
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      expect(await kept(t, id)).toBe(true);
      await api("/api/secrets", { name: "ADDEDLATER", value: V, minutes: 60, by: "owner" });
      expect(await kept(t, id)).toBe(false);
    });
    test("spelled in the page, the same", async () => {
      const id = await asHq("w1:p1", "Held", PAGE("FAKEspelled&#76;ATERvalue98"));
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      await api("/api/secrets", { name: "SPELLEDLATER", value: "FAKEspelledLATERvalue98", minutes: 60, by: "owner" });
      expect(await kept(t, id)).toBe(false);
    });
    test("in the title, the same", async () => {
      const id = await asHq("w1:p1", "Title FAKEtitleLATERvalue97", "the words");
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      await api("/api/secrets", { name: "TITLELATER", value: "FAKEtitleLATERvalue97", minutes: 60, by: "owner" });
      expect(await kept(t, id)).toBe(false);
    });
    test("any change in what is held starts every kept file over, whether or not it touches the page", async () => {
      const id = await asHq("w1:p1", "Held", PAGE("no value here"));
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      expect(await kept(t, id)).toBe(true);
      await api("/api/secrets", { name: "ELSEWHERE", value: "FAKEelsewhereVALUE96", minutes: 60, by: "owner" });
      expect(await kept(t, id)).toBe(false);
    });
    test("a value only in a linked stylesheet or script, the same", async () => {
      await upload("export-room", "kept.css", "a::after{content:'FAKEinCSSvalue94'}");
      await upload("export-room", "kept.js", "var a = 'FAKEinJSvalue93';");
      await upload("export-room", "kept.html", `<!doctype html><title>Kept</title><link rel="stylesheet" href="kept.css"><script src="kept.js"></script><p>x</p>`);
      const page = "rooms/export-room/files/kept.html";
      const t = token(await api("/api/exports", { page, format: "html" }));
      await api("/api/secrets", { name: "INCSS", value: "FAKEinCSSvalue94", minutes: 60, by: "owner" });
      expect(await kept(t, page)).toBe(false);
      const again = token(await api("/api/exports", { page, format: "html" }));
      expect(await kept(again, page)).toBe(true);
      await api("/api/secrets", { name: "INJS", value: "FAKEinJSvalue93", minutes: 60, by: "owner" });
      expect(await kept(again, page)).toBe(false);
    });
    test("nothing changed, nothing starts over: asking twice gives the same answer", async () => {
      const id = await asHq("w1:p1", "Held", PAGE("still"));
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      expect(await kept(t, id)).toBe(true);
      expect(await kept(t, id)).toBe(true);
    });
    test("a value no longer held, that the file masked: no longer kept either", async () => {
      const V = "FAKEremovedLATERvalue95";
      await api("/api/secrets", { name: "REMOVEDLATER", value: V, minutes: 60, by: "owner" });
      const id = await asHq("w1:p1", "Held", PAGE(V));
      const t = token(await api("/api/exports", { page: id, format: "html" }));
      expect(await kept(t, id)).toBe(true);
      expect((await api("/api/secrets/rm", { name: "REMOVEDLATER" })).status).toBe(200);
      expect(await kept(t, id)).toBe(false);
    });
  });
  test("a page gone, another page, an unknown token, or no page at all: not kept", async () => {
    const id = await asHq("w1:p1", "Kept", "words");
    const t = token(await api("/api/exports", { page: id, format: "html" }));
    expect(await kept(t, id)).toBe(true);
    expect(await kept(t, `#brief/${id}`)).toBe(true);
    expect(await kept(t, other)).toBe(false);
    expect(await kept(t, undefined)).toBe(false);
    expect(await kept("0".repeat(32), id)).toBe(false);
  });
});

describe("one at a time", () => {
  test("big makes at once: each answer's file is there when it answers", async () => {
    const id = await asHq("w1:p1", "Big", `<!doctype html><html><body><img src="/uploads/big-one.png"></body></html>`);
    writeFileSync(join(dir, "uploads", "big-one.png"), Buffer.concat([PNG, Buffer.alloc(60 * 1024 * 1024, 1)]));
    const statuses = await Promise.all([0, 1, 2, 3].map(async () => {
      const r = await api("/api/exports", { page: id, format: "html" });
      const f = await fetch(`${server.base}${r.body.url}`);
      await f.body?.cancel();
      return f.status;
    }));
    rmSync(join(dir, "uploads", "big-one.png"));
    expect(statuses).toEqual([200, 200, 200, 200]);
  }, 60_000);
  test("the HUD answers while a spelled page is checked", async () => {
    await api("/api/secrets", { name: "PINGED", value: "FAKEpingSECRETvalue88", minutes: 60, by: "owner" });
    const id = await asHq("w1:p1", "Pinged", `<!doctype html><html><body>${"FAKEping&#83;ECRETvalue88 ".repeat(150_000)}</body></html>`);
    let done = false, worst = 0;
    const pinging = (async () => {
      while (!done) {
        const started = performance.now();
        await (await fetch(`${server.base}/api/state`)).arrayBuffer();
        worst = Math.max(worst, performance.now() - started);
        await Bun.sleep(5);
      }
    })();
    const r = await Promise.all([1, 2, 3, 4].map(() => api("/api/exports/check", { page: id })));
    done = true;
    await pinging;
    expect(r.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(worst).toBeLessThan(3000);
  }, 60_000);
});

describe("the web is reached only on a download", () => {
  // A proxy that refuses everything: it sees every https request this server makes, and each of them fails.
  const asked: string[] = [];
  let proxy: ReturnType<typeof Bun.listen>, away: Awaited<ReturnType<typeof spawnServer>>, data = "";
  const call = async (path: string, body: object) => {
    const r = await fetch(`${away.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const brief = async (body: string) => (await call("/api/briefs", { title: "On the web", body })).body.id;
  const WEB = `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"><script src="https://cdn.example.com/lib.js"></script></head><body><div class="mermaid">graph LR; A--&gt;B</div></body></html>`;
  beforeAll(async () => {
    proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(s, d) { const m = d.toString().match(/^CONNECT (\S+)/); if (m) asked.push(m[1]); s.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); s.end(); } } });
    data = mkdtempSync(join(tmpdir(), "hq-export-away-"));
    const via = `http://127.0.0.1:${proxy.port}`;
    away = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_CHROME_PATH: "/nonexistent/chrome", HTTPS_PROXY: via, https_proxy: via } });
  }, 30_000);
  afterAll(async () => {
    await away?.stop();
    proxy?.stop(true);
    rmSync(data, { recursive: true, force: true });
  });
  const answerOf = (path: string, body: object) => call(path, body);

  test("the check asks the web for nothing, however much the page names, and is quick about it", async () => {
    const id = await brief(WEB);
    asked.length = 0;
    const started = Date.now();
    const r = await call("/api/exports/check", { page: id });
    expect(r.status).toBe(200);
    await Bun.sleep(300);
    expect(asked).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(existsSync(join(data, "export-cache"))).toBe(false);
  });
  test("the download does: its script, its stylesheet and the diagrams' library", async () => {
    const id = await brief(WEB);
    asked.length = 0;
    await answerOf("/api/exports", { page: id, format: "html" });
    expect(asked.join(" ")).toContain("cdn.example.com");
    expect(asked.join(" ")).toContain("cdn.jsdelivr.net");
  }, 40_000);
  test("HTML that could not bring in a script or stylesheet is held back, naming them, in words about that", async () => {
    const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"><script src="https://cdn.example.com/lib.js"></script></head><body>x</body></html>`), format: "html" });
    expect(r.status).toBe(200);
    expect(r.body.hold).toBe("missing");
    const said = r.body.warnings.join(" ");
    expect(said).toContain("lib.js");
    expect(said).toContain("a.css");
    expect(said).not.toContain("unfinished");
  }, 40_000);
  test("so is HTML whose diagrams' library could not be fetched", async () => {
    const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><body><div class="mermaid">graph LR; A--&gt;B</div></body></html>`), format: "html" });
    expect(r.body.hold).toBe("missing");
    expect(r.body.warnings.join(" ")).toContain("diagrams");
  }, 40_000);
  test("so is a module, which is known without asking the web, and the check says so first", async () => {
    const id = await brief(`<!doctype html><html><head><script type="module" src="https://cdn.example.com/mod.js"></script></head><body>x</body></html>`);
    asked.length = 0;
    expect((await call("/api/exports/check", { page: id })).body.warnings.join(" ")).toContain("mod.js");
    expect(asked).toEqual([]);
    expect((await answerOf("/api/exports", { page: id, format: "html" })).body.hold).toBe("missing");
  }, 40_000);
  test("a script that cannot come from this machine holds it back too", async () => {
    const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><head><script src="/uploads/gone.js"></script></head><body>x</body></html>`), format: "html" });
    expect(r.body.hold).toBe("missing");
    expect(r.body.warnings.join(" ")).toContain("gone.js");
  });
  test("a picture on the web stays a plain note, with no stop", async () => {
    const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><body><img src="https://images.example.com/a.png"></body></html>`), format: "html" });
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).toContain("images.example.com");
  }, 40_000);
  test("an address a browser would clean up is the same address: a space, a tab in the scheme, a newline", async () => {
    for (const src of [" https://cdn.example.com/spaced.js", "ht&#9;tps://cdn.example.com/spaced.js", "https://cdn.example.com/spa&#10;ced.js"]) {
      const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><head><script src="${src}"></script></head><body>x</body></html>`), format: "html" });
      expect(r.body.hold).toBe("missing");
      expect(r.body.warnings.join(" ")).toContain("spaced.js");
    }
  }, 60_000);
  test("a private address stays out of the file, however it is spelled, and is known without asking anyone", async () => {
    const id = await brief(`<!doctype html><html><head><script src="ht&#9;tps://127.0.0.1:18443/private.js"></script><link rel="stylesheet" href=" https://[::ffff:7f00:1]/private.css"></head><body>x</body></html>`);
    asked.length = 0;
    expect((await call("/api/exports/check", { page: id })).body.warnings.join(" ")).toContain("private.js");
    const r = await answerOf("/api/exports", { page: id, format: "html" });
    expect(r.body.hold).toBe("missing");
    const text = await (await fetch(`${away.base}${r.body.url}`)).text();
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("7f00");
    expect(asked).toEqual([]);
  }, 40_000);
  test("an import a page's script names is treated like a module script: named before the click, and it holds the file", async () => {
    for (const script of [
      `<script type="module">import * as d3 from "https://esm.sh/d3@7"; document.body.append(d3.version);</script>`,
      `<script type="module">import "https://esm.sh/d3@7";</script>`,
      `<script type="module">export * from 'https://esm.sh/d3@7';</script>`,
      `<script type="importmap">{"imports":{"d3":"https://esm.sh/d3@7"}}</script><script type="module">import * as d3 from "d3";</script>`,
      `<script>import("https://esm.sh/d3@7").then((d3) => document.body.append(d3.version));</script>`,
    ]) {
      const id = await brief(`<!doctype html><html><head></head><body><h1>Before</h1>${script}</body></html>`);
      expect((await call("/api/exports/check", { page: id })).body.warnings.join(" ")).toContain("d3@7");
      const r = await answerOf("/api/exports", { page: id, format: "html" });
      expect(r.body.hold).toBe("missing");
      expect(r.body.warnings.join(" ")).toContain("PDF");
    }
  }, 60_000);
  test("words that look a bit like an import are not one", async () => {
    const r = await answerOf("/api/exports", { page: await brief(`<!doctype html><html><body><script>const note = "we import from a list"; const a = 1;</script><p>x</p></body></html>`), format: "html" });
    expect(r.body.hold).toBeUndefined();
  });
  test("a page with nothing on the web is not held", async () => {
    const r = await answerOf("/api/exports", { page: await brief("Plain words."), format: "html" });
    expect(r.body.hold).toBeUndefined();
  });
  test("hud writes nothing without --anyway, says why, and writes it with it", async () => {
    const id = await brief(`<!doctype html><html><head><script src="https://cdn.example.com/lib.js"></script></head><body>x</body></html>`);
    const cwd = mkdtempSync(join(tmpdir(), "hq-export-cli-"));
    const hud = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), "brief", "export", String(id), "--html", ...args], { cwd, env: { ...process.env, HUD_URL: away.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    const held = await hud();
    expect(held.code).toBe(1);
    expect(held.err).toContain("--anyway");
    expect(held.err).not.toContain("unfinished");
    expect(held.out).toContain("lib.js");
    expect(existsSync(join(cwd, "on-the-web.html"))).toBe(false);
    const anyway = await hud("--anyway");
    expect(anyway.code).toBe(0);
    expect(existsSync(join(cwd, "on-the-web.html"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  }, 40_000);
});

describe("who may ask, and what they hear", () => {
  test("another floor's agent is refused, with --all it passes", async () => {
    const r = await api("/api/exports", { page: `briefs/${md}`, format: "html" }, { "x-hud-pane": "w1:p2" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not yours");
    expect((await api("/api/exports", { page: `briefs/${md}`, format: "html" }, { "x-hud-pane": "w1:p2", "x-hud-floor": "all" })).status).toBe(200);
  });
  test("a request without x-hud cannot start anything", async () => {
    const r = await fetch(`${server.base}/api/exports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page: md, format: "pdf" }) });
    expect(r.status).toBe(403);
  });
  test("what it cannot make, it says", async () => {
    expect((await api("/api/exports", { page: md, format: "docx" })).body.error).toContain("pdf or html");
    expect((await api("/api/exports", { page: "briefs/999999", format: "html" })).body.error).toContain("no brief");
    expect((await api("/api/exports", { page: "rooms/export-room/files/pic.png", format: "html" })).body.error).toContain("not a page");
    expect((await api("/api/exports", { page: "../../etc/passwd", format: "html" })).body.error).toContain("nothing to export");
    expect((await api("/api/exports", { page: "rooms/export-room/files/..%2F..%2Fhud.db", format: "html" })).status).toBe(400);
  });
  test("with no Chrome on this machine a PDF says what to do, and HTML still works", async () => {
    const r = await api("/api/exports", { page: md, format: "pdf" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("no Chrome");
    expect(r.body.error).toContain("Install Google Chrome");
    expect(r.body.error).toContain("HUD_CHROME_PATH");
    expect((await api("/api/exports", { page: md, format: "html" })).status).toBe(200);
  });
  test("a file's address and a print's address are not guessable, and a print is gone once read", async () => {
    expect((await fetch(`${server.base}/exports/${"0".repeat(32)}/x.pdf`)).status).toBe(404);
    expect((await fetch(`${server.base}/exports/print/${"0".repeat(64)}`)).status).toBe(404);
    expect((await fetch(`${server.base}/exports/print/short`)).status).toBe(404);
  });
});

describe("hud brief export", () => {
  const hud = (args: string[], cwd: string) => {
    const r = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "brief", "export", ...args], { cwd, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  test("--html writes the file under its own name, and never over another", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hq-export-cli-"));
    const one = hud([String(md), "--html"], cwd);
    expect(one.err).toBe("");
    expect(one.code).toBe(0);
    expect(one.out).toContain("monday-secret-planted-where-we-are.html");
    expect(readFileSync(join(cwd, "monday-secret-planted-where-we-are.html"), "utf8")).toContain("Where we are");
    expect(hud([String(md), "--html"], cwd).out).toContain("where-we-are-2.html");
    rmSync(cwd, { recursive: true, force: true });
  });
  test("--out names the file, and a room's page works the same", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hq-export-cli-"));
    expect(hud(["rooms/export-room/files/page.html", "--html", "--out", "shared.html"], cwd).code).toBe(0);
    expect(readFileSync(join(cwd, "shared.html"), "utf8")).toContain("version three");
    rmSync(cwd, { recursive: true, force: true });
  });
  test("it says how to use it, and passes on what the server says", () => {
    const cwd = mkdtempSync(join(tmpdir(), "hq-export-cli-"));
    expect(hud([String(md)], cwd).err).toContain("usage: hud brief export");
    expect(hud([String(md), "--pdf", "--html"], cwd).code).toBe(2);
    const noChrome = hud([String(md), "--pdf"], cwd);
    expect(noChrome.code).toBe(1);
    expect(noChrome.err).toContain("no Chrome");
    rmSync(cwd, { recursive: true, force: true });
  });
});
