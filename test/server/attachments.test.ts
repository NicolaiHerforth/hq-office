// Attachments on the server, against a server on a spare port with a throwaway data dir and a stub herdr: a file of
// any type, with or without an extension, lands in uploads/ under its own name (name-2.ext when taken) and is served
// sandboxed, never sniffed, inline only for images and video, so HTML, SVG, a script or a program is a download that
// never runs on the HUD's address; a file over 25 MB and an image over 10 MB get a 413; a room's send box (?attach=1)
// puts files in the room's files/ and on its shelf under the same sizes, where text shows as plain text and an HTML
// file is a sandboxed page; and the tokens reach hud inbox and hud room read with the file's full path on this machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-attachments-test-"));
let server: Awaited<ReturnType<typeof spawnServer>>;
let BASE = "";

beforeAll(async () => {
  const herdr = join(DATA, "herdr");
  writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"pm","agent_status":"idle","pane_id":"p0","agent":"claude"}]}}' ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_OWNER: "Sam" } });
  BASE = server.base;
  await post("/api/lanes", { name: "pm", machine: "local" });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
const send = async (url: string, name: string, body: Uint8Array | string, type = "application/octet-stream") => {
  const res = await fetch(`${BASE}${url}${url.includes("?") ? "&" : "?"}name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type, "x-hud": "1" }, body });
  const raw = await res.text();
  try { return { status: res.status, ...JSON.parse(raw) }; } catch { return { status: res.status, raw }; }
};
async function hud(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out: out.trim(), code };
}
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
// Every kind of file, the ones HQ took before 0.37 and the ones it refused, with and without an extension.
const ANY = ["pdf", "txt", "md", "csv", "json", "zip", "docx", "mp4", "mov", "webm", "mp3", "html", "htm", "svg", "js", "mjs", "sh", "py", "exe", "dmg", "pkg", "app", "key", "sketch", "psd", "heic", "parquet", "wasm", "jar", "bat", "ps1", ""];
const INLINE: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const named = (ext: string) => (ext ? `Report Q3.${ext}` : "Report Q3");
const SCRIPT = "<html><body><script>alert(1)</script><svg onload=alert(2)></svg></body></html>";
// How a stored file is answered: always sandboxed with no scripts and never sniffed, and either inline as TYPE or a
// download of NAME.
async function served(url: string) {
  const res = await fetch(`${BASE}${url}`);
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), csp: res.headers.get("content-security-policy"), nosniff: res.headers.get("x-content-type-options"), body: await res.text() };
}
const download = (name: string, body: string) => ({ status: 200, type: "application/octet-stream", disposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, csp: expect.stringMatching(/^sandbox; default-src 'none'/), nosniff: "nosniff", body });

describe("uploads", () => {
  test("a file of any type, with or without an extension, lands under its own name; only images and video show inline", async () => {
    for (const ext of ANY) {
      const name = named(ext);
      const out = await send("/api/uploads", name, `bytes of ${ext || "none"}`);
      expect(out).toMatchObject({ status: 200, name, kind: "file", path: join(DATA, "uploads", name), url: `/uploads/${encodeURIComponent(name)}` });
      expect(readFileSync(out.path, "utf8")).toBe(`bytes of ${ext || "none"}`);
      const res = await served(out.url);
      if (INLINE[ext]) expect(res).toMatchObject({ status: 200, type: INLINE[ext], disposition: expect.stringMatching(/^inline;/), nosniff: "nosniff" });
      else expect([ext, res]).toEqual([ext, download(name, `bytes of ${ext || "none"}`)]);
    }
  });

  test("HTML, SVG, a script and a program are downloads that never run or render on the HUD's address, whatever type they were sent as", async () => {
    for (const [name, type] of [["page.html", "text/html"], ["logo.svg", "image/svg+xml"], ["app.js", "text/javascript"], ["setup.exe", "application/x-msdownload"]]) {
      const out = await send("/api/uploads", name, SCRIPT, type);
      expect(out).toMatchObject({ status: 200, name, kind: "file" });
      expect([name, await served(out.url)]).toEqual([name, download(name, SCRIPT)]);
    }
  });

  test("a file with no extension keeps its name, a nameless one is called file, and a taken name gets -2", async () => {
    const a = await send("/api/uploads", "Makefile", "all:");
    const b = await send("/api/uploads", "Makefile", "all: again");
    const c = await send("/api/uploads", "", "x");
    const d = await send("/api/uploads", "...", "y");
    expect([a.name, b.name, c.name, d.name]).toEqual(["Makefile", "Makefile-2", "file", "file-2"]);
    expect(await served(b.url)).toEqual(download("Makefile-2", "all: again"));
  });

  test("an image keeps its name with its type's extension and shows inline; a taken name gets -2, -3", async () => {
    const a = await send("/api/uploads", "shot.png", PNG, "image/png");
    const b = await send("/api/uploads", "shot.png", PNG, "image/png");
    const c = await send("/api/uploads", "shot.heic", PNG, "image/png");
    expect([a.name, b.name, c.name]).toEqual(["shot.png", "shot-2.png", "shot-3.png"]);
    expect(a.kind).toBe("image");
    const res = await fetch(`${BASE}${b.url}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toStartWith("inline;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const d = await send("/api/uploads", "notes.pdf", "one");
    const e = await send("/api/uploads", "notes.pdf", "two");
    expect([d.name, e.name]).toEqual(["notes.pdf", "notes-2.pdf"]);
    expect(readFileSync(e.path, "utf8")).toBe("two");
  });

  test("a file over 25 MB, or an image over 10 MB, is refused", async () => {
    const big = await send("/api/uploads", "huge.zip", new Uint8Array(25 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(big.error).toContain("over 25 MB");
    expect(existsSync(join(DATA, "uploads", "huge.zip"))).toBe(false);
    const ok = await send("/api/uploads", "edge.zip", new Uint8Array(25 * 1024 * 1024));
    expect(ok).toMatchObject({ status: 200, name: "edge.zip" });
    const img = await send("/api/uploads", "huge.png", new Uint8Array(10 * 1024 * 1024 + 1), "image/png");
    expect(img.status).toBe(413);
    // Any type, the same 25 MB: a program, a file with no extension, and an SVG (a file, not an image).
    for (const name of ["huge.exe", "HUGE", "huge.svg"]) {
      const out = await send("/api/uploads", name, new Uint8Array(25 * 1024 * 1024 + 1));
      expect([name, out.status, out.error]).toEqual([name, 413, "the file is over 25 MB"]);
      expect(existsSync(join(DATA, "uploads", name))).toBe(false);
    }
    expect(await send("/api/uploads", "big.svg", new Uint8Array(10 * 1024 * 1024 + 1), "image/svg+xml")).toMatchObject({ status: 200, name: "big.svg", kind: "file" });
  });

  test("a name that tries to leave uploads/ is kept inside it, and a path out is not served", async () => {
    const out = await send("/api/uploads", "../../escape.txt", "x");
    expect(out.name).toBe("escape.txt");
    expect(out.path).toBe(join(DATA, "uploads", "escape.txt"));
    for (const p of ["/uploads/..%2Fhud.db", "/uploads/%2E%2E%2Fhud.db", "/uploads/.hidden", "/uploads/nothing.pdf"]) expect((await fetch(`${BASE}${p}`)).status).toBe(404);
  });

  test("a note's tokens reach hud inbox with the full path on this machine", async () => {
    const pdf = await send("/api/uploads", "brief.pdf", "%PDF-1.4");
    await post("/api/notes", { text: `See this [file: ${pdf.path}]` });
    const { out, code } = await hud(["inbox"]);
    expect(code).toBe(0);
    expect(out).toContain(`[file: ${pdf.path}]`);
    expect(pdf.path.startsWith(DATA)).toBe(true);
  });
});

describe("a room's send box", () => {
  test("attached files land in the room's files/ and on its shelf; a file over its size gets a 4xx", async () => {
    await post("/api/rooms", { slug: "deck", title: "Deck", owner: "pm" });
    const url = "/api/rooms/deck/files?as=owner&attach=1";
    const pdf = await send(url, "plan.pdf", "%PDF");
    const png = await send(url, "plan.png", PNG, "image/png");
    expect(pdf).toMatchObject({ status: 200, name: "plan.pdf", kind: "file", path: join(DATA, "rooms", "deck", "files", "plan.pdf"), url: "/rooms/deck/files/plan.pdf" });
    expect(png).toMatchObject({ status: 200, kind: "image" });
    const again = await send(url, "plan.pdf", "%PDF2");
    expect(again.name).toBe("plan-2.pdf");
    const shelf = JSON.parse(readFileSync(join(DATA, "rooms", "deck", "shelf.json"), "utf8")).map((a: any) => a.file);
    expect(shelf).toEqual(["plan.pdf", "plan.png", "plan-2.pdf"]);
    const res = await fetch(`${BASE}${pdf.url}`);
    expect(res.headers.get("content-disposition")).toStartWith("attachment;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
    const mp4 = await send(url, "clip.mp4", "video");
    expect((await fetch(`${BASE}${mp4.url}`)).headers.get("content-type")).toBe("video/mp4");
    expect((await send(url, "huge.zip", new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await send(url, "huge.exe", new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await send(url, "huge.png", new Uint8Array(10 * 1024 * 1024 + 1), "image/png")).status).toBe(400);
    // The shelf's own ADD and a lane's hud room artifact are not attachments: they still take any file.
    expect((await send("/api/rooms/deck/files?as=owner", "notes.ts", "x")).status).toBe(200);
  });

  test("any type goes on the shelf; a script shows as plain text, an HTML file is a sandboxed page, the rest download", async () => {
    const url = "/api/rooms/deck/files?as=owner&attach=1";
    const sent = async (name: string, type?: string) => {
      const out = await send(url, name, SCRIPT, type);
      expect(out).toMatchObject({ status: 200, name, path: join(DATA, "rooms", "deck", "files", name), url: `/rooms/deck/files/${encodeURIComponent(name)}` });
      return served(out.url);
    };
    for (const [name, type] of [["logo.svg", "image/svg+xml"], ["setup.exe", "application/x-msdownload"], ["Deck.key", "application/x-iwork-keynote-sffkey"], ["Makefile", ""]]) {
      expect([name, await sent(name, type)]).toEqual([name, download(name, SCRIPT)]);
    }
    expect(await sent("app.js", "text/javascript")).toMatchObject({ status: 200, type: "text/plain; charset=utf-8", disposition: expect.stringMatching(/^inline;/), csp: expect.stringMatching(/^sandbox; default-src 'none'/), nosniff: "nosniff", body: SCRIPT });
    // A page: its scripts run only inside a sandbox without allow-same-origin, so never as the HUD.
    const page = await sent("page.html", "text/html");
    expect(page).toMatchObject({ status: 200, type: "text/html; charset=utf-8", nosniff: "nosniff" });
    expect(page.csp).toStartWith("sandbox allow-scripts ");
    expect(page.csp!.split(";")[0]).not.toContain("allow-same-origin");
    const shelf = JSON.parse(readFileSync(join(DATA, "rooms", "deck", "shelf.json"), "utf8")).map((a: any) => a.file);
    expect(shelf).toEqual(expect.arrayContaining(["logo.svg", "setup.exe", "Deck.key", "Makefile", "app.js", "page.html"]));
  });

  test("a message's tokens reach hud room read with the full path", async () => {
    const pdf = await send("/api/rooms/deck/files?as=owner&attach=1", "spec.pdf", "%PDF");
    await post("/api/rooms/deck/post", { text: `Here [file: ${pdf.path}]`, to: "pm" });
    const { out, code } = await hud(["room", "read", "deck"]);
    expect(code).toBe(0);
    expect(out).toContain(`[file: ${join(DATA, "rooms", "deck", "files", "spec.pdf")}]`);
  });
});
