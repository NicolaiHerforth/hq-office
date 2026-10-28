// A room's folder, against a server on a spare port with a throwaway data dir and a stub herdr: the folder and its
// mirrors, uploads landing in files/, a file dropped in or deleted by a lane, paths that try to leave the folder,
// how files are served, and the move of shelf files from before rooms had folders (with their old links).
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-room-folder-test-"));
const ROOMS = join(DATA, "rooms");
let server: Awaited<ReturnType<typeof spawnServer>>;
let BASE = "";

const env = () => {
  const herdr = join(DATA, "herdr");
  writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"pm","agent_status":"idle","pane_id":"p0","agent":"claude"}]}}' ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  return { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_OWNER: "Sam" };
};
const start = async () => {
  server = await spawnServer({ cwd: ROOT, env: env() });
  BASE = server.base;
};

beforeAll(async () => {
  await start();
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
const room = async (slug: string) => (await fetch(`${BASE}/api/rooms/${slug}`)).json();
const upload = async (slug: string, name: string, body: string | Uint8Array, extra = "") => {
  const res = await fetch(`${BASE}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}${extra}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });
  return { status: res.status, ...(await res.json()) };
};
async function hud(args: string[]) {
  const proc = Bun.spawn([process.execPath, join(ROOT, "hud.ts"), ...args], { env: { ...process.env, HUD_URL: BASE }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out.trim(), err: err.trim(), code };
}
// A file change reaches the shelf by the system's file events or, when those stall (macOS's fseventsd can), by the
// check every herdr sync makes: the wait asks for a sync now and then, so it holds either way.
async function until(fn: () => Promise<boolean>, ms = 5000) {
  for (let i = 0, end = Date.now() + ms; Date.now() < end; i++, await Bun.sleep(50)) {
    if (await fn()) return;
    if (i % 10 === 9) await fetch(`${BASE}/api/sync`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: "{}" }).catch(() => {});
  }
  throw new Error("timed out");
}
const shelfJson = (slug: string) => JSON.parse(readFileSync(join(ROOMS, slug, "shelf.json"), "utf8"));
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("a room's folder", () => {
  test("create makes rooms/SLUG/ with files/, shelf.json and brief.md; hud room path and create print it", async () => {
    const made = await hud(["room", "create", "auth", "--title", "Auth", "--owner", "pm"]);
    expect(made.code).toBe(0);
    expect(made.out.split("\n")).toEqual(["room auth created", `folder ${join(ROOMS, "auth")} (files/ is shared; anything saved there shows on the shelf)`]);
    expect((await hud(["room", "path", "auth"])).out).toBe(join(ROOMS, "auth"));
    expect(readdirSync(join(ROOMS, "auth")).sort()).toEqual(["brief.md", "files", "shelf.json"]);
    expect(shelfJson("auth")).toEqual([]);
    expect(readFileSync(join(ROOMS, "auth", "brief.md"), "utf8")).toBe("");
    expect((await room("auth")).folder).toBe(join(ROOMS, "auth"));
  });

  test("the mirrors follow the brief and the shelf, and are not rewritten when nothing changed", async () => {
    await post("/api/rooms/auth/brief", { body: "# Plan\n- rotate tokens" });
    expect(readFileSync(join(ROOMS, "auth", "brief.md"), "utf8")).toBe("# Plan\n- rotate tokens\n");
    await post("/api/rooms/auth/artifacts", { title: "Runbook", url: "https://example.com/runbook", as: "pm" });
    const shelf = shelfJson("auth");
    expect(shelf).toHaveLength(1);
    expect(shelf[0]).toMatchObject({ kind: "link", title: "Runbook", url: "https://example.com/runbook", by: "pm" });
    expect(shelf[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const stamps = () => ["brief.md", "shelf.json"].map((f) => statSync(join(ROOMS, "auth", f)).mtimeMs);
    const before = stamps();
    await Bun.sleep(20);
    await post("/api/rooms/auth/say", { text: "a message changes neither mirror" });
    await post("/api/rooms/auth/brief", { body: "# Plan\n- rotate tokens" });
    expect(stamps()).toEqual(before);
  });

  test("an upload lands in files/ under its own name, de-duplicated, and on the shelf by the owner", async () => {
    const a = await upload("auth", "trace notes.txt", "one\n", "&as=owner");
    expect(a).toMatchObject({ status: 200, kind: "file", name: "trace notes.txt", url: "/rooms/auth/files/trace%20notes.txt", path: join(ROOMS, "auth", "files", "trace notes.txt") });
    const b = await upload("auth", "trace notes.txt", "two\n", "&as=owner");
    expect(b.name).toBe("trace notes-2.txt");
    expect(readFileSync(join(ROOMS, "auth", "files", "trace notes-2.txt"), "utf8")).toBe("two\n");
    const img = await upload("auth", "shot.png", PNG, "&as=owner");
    expect(img.kind).toBe("image");
    // A hostile name keeps no folder part: it stays inside files/.
    const sneaky = await upload("auth", "../../hud.db", "x");
    expect(sneaky.path).toBe(join(ROOMS, "auth", "files", "hud.db"));
    const shelf = (await room("auth")).artifactList;
    expect(shelf.filter((x: any) => x.by === "owner").map((x: any) => x.title)).toEqual(["trace notes.txt", "trace notes-2.txt", "shot.png"]);
    expect(shelfJson("auth").find((x: any) => x.title === "shot.png")).toMatchObject({ kind: "image", file: "shot.png", by: "owner" });
    // The CLI's --file does the same, and says where the file is.
    const file = join(DATA, "report.md");
    writeFileSync(file, "# Report\n");
    const cli = await hud(["room", "artifact", "auth", "--title", "Report", "--file", file]);
    expect(cli.out).toContain(`file ${join(ROOMS, "auth", "files", "report.md")}`);
    // Nothing doubled once the watcher has looked.
    await Bun.sleep(900);
    expect((await room("auth")).artifactList.filter((x: any) => x.path?.includes("/files/")).length).toBe(5);
  });

  test("a file a lane saves into files/ joins the shelf once, by folder; a file deleted drops off", async () => {
    const dir = join(ROOMS, "auth", "files");
    // A large file written in parts appears once, when it is complete.
    const big = join(dir, "dump.log");
    writeFileSync(big, "part 1\n");
    for (let i = 2; i <= 4; i++) { await Bun.sleep(100); writeFileSync(big, `part ${i}\n`, { flag: "a" }); }
    writeFileSync(join(dir, "plot.png"), PNG);
    writeFileSync(join(dir, ".DS_Store"), "hidden");
    mkdirSync(join(dir, "a folder"));
    await until(async () => (await room("auth")).artifactList.some((x: any) => x.title === "plot.png"));
    await Bun.sleep(800);
    const shelf = (await room("auth")).artifactList;
    const dropped = shelf.filter((x: any) => x.by === "folder");
    expect(dropped.map((x: any) => [x.title, x.kind])).toEqual(expect.arrayContaining([["dump.log", "file"], ["plot.png", "image"]]));
    expect(dropped).toHaveLength(2);
    expect(shelfJson("auth").some((x: any) => x.file === "dump.log" && x.by === "folder")).toBe(true);
    unlinkSync(big);
    await until(async () => !(await room("auth")).artifactList.some((x: any) => x.title === "dump.log"));
    expect(shelfJson("auth").some((x: any) => x.file === "dump.log")).toBe(false);
  });

  test("the owner removing an item takes its file with it", async () => {
    const it = await upload("auth", "picked.png", PNG, "&as=owner");
    await post(`/api/rooms/auth/artifacts/${it.id}/remove`, {});
    expect(existsSync(it.path)).toBe(false);
    expect((await room("auth")).artifactList.some((x: any) => x.id === it.id)).toBe(false);
  });

  test("files are served sandboxed: images inline, text as plain text, HTML and SVG as downloads", async () => {
    await upload("auth", "report.html", "<script>alert(1)</script>");
    await upload("auth", "logo.svg", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
    const get = (name: string) => fetch(`${BASE}/rooms/auth/files/${encodeURIComponent(name)}`);
    for (const name of ["report.html", "logo.svg", "shot.png", "trace notes.txt"]) {
      const r = await get(name);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toStartWith("sandbox");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    for (const name of ["report.html", "logo.svg"]) {
      const r = await get(name);
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.headers.get("content-disposition")).toStartWith("attachment");
    }
    expect((await get("shot.png")).headers.get("content-type")).toBe("image/png");
    expect((await get("shot.png")).headers.get("content-disposition")).toStartWith("inline");
    const txt = await get("trace notes.txt");
    expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await txt.text()).toBe("one\n");
  });

  test("a path that tries to leave the folder is refused", async () => {
    writeFileSync(join(ROOMS, "auth", "secret.txt"), "not shared");
    for (const p of ["/rooms/auth/files/..%2Fsecret.txt", "/rooms/auth/files/..%2F..%2Fhud.db", "/rooms/auth/files/%2E%2E%2Fbrief.md", "/rooms/..%2F..%2Fhud.db/files/x", "/rooms/auth/files/.DS_Store", "/rooms/auth/files/a%5C..%5Csecret.txt", "/rooms/auth/files/%E0%A4%A"]) {
      const r = await fetch(`${BASE}${p}`);
      expect([p, r.status]).toEqual([p, 404]);
    }
    // A link inside files/ that points elsewhere is neither served nor shelved.
    symlinkSync(join(ROOMS, "auth", "secret.txt"), join(ROOMS, "auth", "files", "link.txt"));
    await Bun.sleep(900);
    expect((await fetch(`${BASE}/rooms/auth/files/link.txt`)).status).toBe(404);
    expect((await room("auth")).artifactList.some((x: any) => x.title === "link.txt")).toBe(false);
    await expect(post("/api/rooms/..%2Fx/brief", { body: "x" })).rejects.toThrow();
  });

  test("the lane's prompt names the room's folder", async () => {
    const log = join(DATA, "prompts.log");
    const herdr = join(DATA, "herdr");
    writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[{"name":"pm","agent_status":"idle","pane_id":"p0","agent":"claude"}]}}' ;;\n  *"agent prompt"*) printf '%s\\n' "$@" >> "${log}" ;;\nesac\nexit 0\n`);
    await post("/api/rooms/auth/post", { text: "Where is the report?" });
    await until(async () => existsSync(log) && readFileSync(log, "utf8").includes("Where is the report?"));
    expect(readFileSync(log, "utf8")).toContain(`Room folder: ${join(ROOMS, "auth")} (files/ is shared; anything you save there shows on the shelf)`);
  });

  test("archiving keeps the folder and stops watching it; reopening picks up what changed", async () => {
    await hud(["room", "archive", "auth"]);
    expect(existsSync(join(ROOMS, "auth", "files", "shot.png"))).toBe(true);
    writeFileSync(join(ROOMS, "auth", "files", "while-away.txt"), "x");
    await Bun.sleep(900);
    expect((await room("auth")).artifactList.some((x: any) => x.title === "while-away.txt")).toBe(false);
    await hud(["room", "create", "auth"]);
    expect((await room("auth")).artifactList.some((x: any) => x.title === "while-away.txt" && x.by === "folder")).toBe(true);
  });

  test("shelf files from before folders move into their room at start, once; old links redirect", async () => {
    await hud(["room", "create", "legacy", "--title", "Legacy", "--owner", "pm"]);
    await server.stop();
    // The layout of 0.10: one flat room-files/ folder, and a row pointing at it.
    mkdirSync(join(DATA, "room-files"), { recursive: true });
    writeFileSync(join(DATA, "room-files", "1700000000000-old_notes.txt"), "from before\n");
    const db = new Database(join(DATA, "hud.db"));
    db.query("INSERT INTO room_artifacts (slug, at, by, kind, title, url, path) VALUES ('legacy', 1, 'pm', 'file', 'Old notes', '/room-files/1700000000000-old_notes.txt', ?)").run(join(DATA, "room-files", "1700000000000-old_notes.txt"));
    db.close();
    await start();
    const moved = join(ROOMS, "legacy", "files", "1700000000000-old_notes.txt");
    const check = async () => {
      const shelf = (await room("legacy")).artifactList;
      expect(shelf).toHaveLength(1);
      expect(shelf[0]).toMatchObject({ title: "Old notes", by: "pm", url: "/rooms/legacy/files/1700000000000-old_notes.txt", path: moved });
      expect(readFileSync(moved, "utf8")).toBe("from before\n");
      expect(existsSync(join(DATA, "room-files", "1700000000000-old_notes.txt"))).toBe(false);
      expect(shelfJson("legacy")[0]).toMatchObject({ file: "1700000000000-old_notes.txt", title: "Old notes" });
    };
    await check();
    // The old link in a message still works.
    const old = await fetch(`${BASE}/room-files/1700000000000-old_notes.txt`, { redirect: "manual" });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/rooms/legacy/files/1700000000000-old_notes.txt");
    expect(await (await fetch(`${BASE}/room-files/1700000000000-old_notes.txt`)).text()).toBe("from before\n");
    expect((await fetch(`${BASE}/room-files/nope.txt`)).status).toBe(404);
    // Again: nothing moves twice, nothing doubles.
    await server.stop();
    await start();
    await check();
  }, 40_000);
});
