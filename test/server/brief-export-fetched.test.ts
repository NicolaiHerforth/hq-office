// BRIEF EXPORT, what a fetched stylesheet or library can do, given as already fetched: the guard now refuses any host on
// this machine, so no local stub can stand in for a public one. In a process of its own, for its data folder.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hq-export-fetched-"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const KEY = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789AB";
const run = async (css: string, script = "window.lib = 1;") => {
  const data = mkdtempSync(join(dir, "data-"));
  mkdirSync(join(data, "uploads"), { recursive: true });
  writeFileSync(join(data, "uploads", "owner-private.png"), PNG);
  const file = join(dir, `run-${Math.random().toString(36).slice(2)}.ts`);
  // In the order main.ts loads them: the server's modules lean on it.
  const SERVER = join(import.meta.dir, "..", "..", "src", "server");
  writeFileSync(file, `${["config", "db", "types", "push", "updates", "events", "herdr", "lanes", "score", "state"].map((m) => `import ${JSON.stringify(join(SERVER, `${m}.ts`))};`).join("\n")}
const { freezer } = await import(${JSON.stringify(join(SERVER, "brief-export.ts"))});
const web = new Map([["https://cdn.example.com/a.css", { text: ${JSON.stringify(css)} }], ["https://cdn.example.com/a.js", { text: ${JSON.stringify(script)} }]]);
const f = freezer({ key: "briefs/1", floor: "main", title: "T", at: 0, text: "", markdown: false, base: "/briefs/1.html" }, web);
const html = f.html('<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"><script src="https://cdn.example.com/a.js"></script></head><body>x</body></html>');
console.log(JSON.stringify({ html, notes: f.notes().map((n) => n.text), scanned: f.scanned() }));
process.exit(0);`);
  const p = Bun.spawn([process.execPath, file], { env: { ...process.env, HUD_DATA_DIR: data, HUD_PORT: "0", HERDR_BIN: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  try { return JSON.parse(out.trim().split("\n").at(-1)!) as { html: string; notes: string[]; scanned: string }; } catch { throw new Error(`no answer: ${out} ${err}`); }
};
const b64 = PNG.toString("base64");

test("a web stylesheet naming the sentinel host cannot pull in a local file", async () => {
  const r = await run(`.a { background: url(http://hud.invalid/uploads/owner-private.png); }`);
  expect(r.html).not.toContain(b64);
  expect(r.notes.join(" ")).not.toContain("from this machine");
}, 30_000);
test("nor by naming this machine or a path of its own: on the web that path is the web host's", async () => {
  const r = await run(`.a { background: url(http://127.0.0.1:4747/uploads/owner-private.png); } .b { background: url(/uploads/owner-private.png); } .c { background: url(../uploads/owner-private.png); }`);
  expect(r.html).not.toContain(b64);
  expect(r.html).toContain("https://cdn.example.com/uploads/owner-private.png");
  expect(r.notes.join(" ")).not.toContain("from this machine");
}, 30_000);
test("a key in a fetched library is looked at by the scan, and a fetched file is named", async () => {
  const r = await run("", `const k = "${KEY}";`);
  expect(r.scanned).toContain(KEY);
  expect(r.notes.join(" ")).toContain("a.js");
}, 30_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
