// Every client module links the way a browser will link it: each import names a file that exists and names that
// file exports, every module is reached from main.js or a feature's index.js, and every file opens with a comment
// saying what it is for. A browser fails on the first of these after a module moves or a name changes; this test
// fails first, with the file and the name.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = join(ROOT, "src", "client");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(CLIENT);
const modules = files.filter((f) => f.endsWith(".js"));
const transpiler = new Bun.Transpiler({ loader: "js" });
const name = (f: string) => relative(CLIENT, f);

type Import = { spec: string; names: string[]; def: string | null };
function importsOf(code: string): Import[] {
  const out: Import[] = [];
  for (const m of code.matchAll(/^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:from\s*)?"([^"]+)";/gm)) {
    const names = (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(/\s+as\s+/)[0]);
    out.push({ spec: m[3], names, def: m[1] ?? null });
  }
  return out;
}

const exportsOf = new Map<string, Set<string>>();
for (const f of modules) exportsOf.set(f, new Set(transpiler.scan(readFileSync(f, "utf8")).exports));

describe("client modules", () => {
  test("there are modules, and main.js is one of them", () => {
    expect(modules.length).toBeGreaterThan(10);
    expect(existsSync(join(CLIENT, "main.js"))).toBe(true);
  });

  for (const f of modules) {
    test(`${name(f)} links`, () => {
      const code = readFileSync(f, "utf8");
      expect(code.startsWith("//")).toBe(true);
      for (const imp of importsOf(code)) {
        expect(imp.spec.startsWith(".")).toBe(true); // no packages: the browser loads files as they are
        const target = resolve(dirname(f), imp.spec);
        expect({ from: name(f), spec: imp.spec, exists: existsSync(target) }).toEqual({ from: name(f), spec: imp.spec, exists: true });
        const exported = exportsOf.get(target)!;
        for (const n of imp.names) expect({ from: name(f), to: name(target), name: n, exported: exported.has(n) }).toEqual({ from: name(f), to: name(target), name: n, exported: true });
        if (imp.def) expect({ from: name(f), to: name(target), default: exported.has("default") }).toEqual({ from: name(f), to: name(target), default: true });
      }
    });
  }

  test("every module is loaded by the page", () => {
    // main.js, every feature's index.js, and a classic script the shell loads itself (MENU › THEME before the first paint)
    const shell = readFileSync(join(ROOT, "public", "index.html"), "utf8");
    const early = [...shell.matchAll(/<script src="\/(src\/client\/[^"]+\.js)"><\/script>/g)].map((m) => join(ROOT, m[1]));
    const entries = [join(CLIENT, "main.js"), ...modules.filter((f) => /^[^/]+\/index\.js$/.test(name(f))), ...early];
    const seen = new Set<string>();
    const visit = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      for (const imp of importsOf(readFileSync(f, "utf8"))) visit(resolve(dirname(f), imp.spec));
    };
    entries.forEach(visit);
    // a classic script is loaded by a <script src> somewhere else (page-runtime/runtime.js: into every HTML page), not by an import
    const classic = (f: string) => readFileSync(f, "utf8").startsWith("// CLASSIC SCRIPT");
    expect(modules.filter((f) => !seen.has(f) && !classic(f)).map(name)).toEqual([]);
  });

  test("every stylesheet opens with a comment", () => {
    for (const f of files.filter((f) => f.endsWith(".css"))) expect({ file: name(f), comment: readFileSync(f, "utf8").startsWith("/*") }).toEqual({ file: name(f), comment: true });
  });

  test("the shell loads main.js and leaves room for styles and features", () => {
    const shell = readFileSync(join(ROOT, "public", "index.html"), "utf8");
    expect(shell).toContain(`<script type="module" src="/src/client/main.js"></script>`);
    expect(shell).toContain("<!-- styles -->");
    expect(shell).toContain("<!-- features -->");
    expect(shell).not.toMatch(/<script>|\son[a-z]+="/); // no inline script or handler: modules do not share globals
  });
});
