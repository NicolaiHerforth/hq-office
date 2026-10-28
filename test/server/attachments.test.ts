// Attachments on the server, against a server on a spare port with a throwaway data dir and a stub herdr: each
// allowed kind lands in uploads/ under its own name (name-2.ext when taken) and is served sandboxed, never sniffed,
// inline only for images and video; a refused kind and a file over 25 MB get a 4xx; a room's send box (?attach=1)
// puts files in the room's files/ and on its shelf under the same rules; and the tokens reach hud inbox and hud room
// read with the file's full path on this machine.
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
const ALLOWED = ["pdf", "txt", "md", "csv", "tsv", "json", "log", "yaml", "yml", "xml", "zip", "gz", "tar", "docx", "xlsx", "pptx", "mp4", "mov", "webm", "mp3", "wav", "m4a"];
const INLINE: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

describe("uploads", () => {
  test("each allowed kind lands under its own name and is served sandboxed: inline for video, a download otherwise", async () => {
    for (const ext of ALLOWED) {
      const out = await send("/api/uploads", `Report Q3.${ext}`, `bytes of ${ext}`);
      expect(out).toMatchObject({ status: 200, name: `Report Q3.${ext}`, kind: "file", path: join(DATA, "uploads", `Report Q3.${ext}`), url: `/uploads/${encodeURIComponent(`Report Q3.${ext}`)}` });
      expect(readFileSync(out.path, "utf8")).toBe(`bytes of ${ext}`);
      const res = await fetch(`${BASE}${out.url}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`bytes of ${ext}`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
      const disp = res.headers.get("content-disposition")!;
      if (INLINE[ext]) {
        expect(res.headers.get("content-type")).toBe(INLINE[ext]);
        expect(disp).toStartWith("inline;");
      } else {
        expect(res.headers.get("content-type")).toBe("application/octet-stream");
        expect(disp).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(`Report Q3.${ext}`)}`);
      }
    }
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

  test("a refused kind gets a 4xx and nothing is written", async () => {
    for (const name of ["page.html", "page.htm", "logo.svg", "app.js", "run.sh", "setup.exe", "disk.dmg", "install.pkg", "Thing.app", "noext"]) {
      const out = await send("/api/uploads", name, "<script>alert(1)</script>");
      expect(out.status).toBeGreaterThanOrEqual(400);
      expect(out.status).toBeLessThan(500);
      expect(out.error).toContain("not a type HQ takes");
      expect(existsSync(join(DATA, "uploads", name))).toBe(false);
    }
    // An SVG sent with an image's content type is still not an image the server keeps.
    expect((await send("/api/uploads", "logo.svg", "<svg/>", "image/svg+xml")).status).toBe(415);
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
  });

  test("a name that tries to leave uploads/ is kept inside it, and a path out is not served", async () => {
    const out = await send("/api/uploads", "../../escape.txt", "x");
    expect(out.name).toBe("escape.txt");
    expect(out.path).toBe(join(DATA, "uploads", "escape.txt"));
    for (const p of ["/uploads/..%2Fhud.db", "/uploads/%2E%2E%2Fhud.db", "/uploads/.hidden", "/uploads/nothing.pdf"]) expect((await fetch(`${BASE}${p}`)).status).toBe(404);
  });

  // A Tell waits in HQ's queue, so HQ reads its tokens with hud req next.
  test("a note's tokens reach HQ's queue with the full path on this machine", async () => {
    const pdf = await send("/api/uploads", "brief.pdf", "%PDF-1.4");
    await post("/api/notes", { text: `See this [file: ${pdf.path}]` });
    const { out, code } = await hud(["req", "next"]);
    expect(code).toBe(0);
    expect(out).toContain(`[file: ${pdf.path}]`);
    expect(pdf.path.startsWith(DATA)).toBe(true);
  });
});

describe("a room's send box", () => {
  test("attached files land in the room's files/ and on its shelf; refused kinds and sizes get a 4xx", async () => {
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
    const html = await send(url, "page.html", "<script>1</script>");
    expect(html.status).toBe(400);
    expect(html.error).toContain("not a type HQ takes");
    expect(existsSync(join(DATA, "rooms", "deck", "files", "page.html"))).toBe(false);
    expect((await send(url, "huge.zip", new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(400);
    // The shelf's own ADD and a lane's hud room artifact are not attachments: they still take any file.
    expect((await send("/api/rooms/deck/files?as=owner", "notes.ts", "x")).status).toBe(200);
  });

  test("a message's tokens reach hud room read with the full path", async () => {
    const pdf = await send("/api/rooms/deck/files?as=owner&attach=1", "spec.pdf", "%PDF");
    await post("/api/rooms/deck/post", { text: `Here [file: ${pdf.path}]`, to: "pm" });
    const { out, code } = await hud(["room", "read", "deck"]);
    expect(code).toBe(0);
    expect(out).toContain(`[file: ${join(DATA, "rooms", "deck", "files", "spec.pdf")}]`);
  });
});
