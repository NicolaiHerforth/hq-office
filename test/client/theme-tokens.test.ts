// Every colour in the HUD's stylesheets comes from a token in core/base.css, so the dark theme reaches it: no hex,
// rgb() or hsl() colour anywhere else (black in a shadow or a mask reads the same in both themes and may stay). And
// the dark palette is given twice, for SYSTEM in a dark browser and for DARK picked in MENU: the two stay the same.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const CLIENT = join(import.meta.dir, "..", "..", "src", "client");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sheets = walk(CLIENT).filter((f) => f.endsWith(".css")).map((f) => relative(CLIENT, f)).filter((f) => f !== "core/base.css");

test("no stylesheet but core/base.css names a colour of its own", () => {
  const found: string[] = [];
  for (const f of sheets) {
    readFileSync(join(CLIENT, f), "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\//g, "");
      for (const m of code.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi)) {
        if (/^#000$|^rgba\(0,\s*0,\s*0,/i.test(m[0])) continue;
        found.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  expect(found).toEqual([]);
});

test("the dark palette is the same for SYSTEM in a dark browser and for DARK", () => {
  const css = readFileSync(join(CLIENT, "core", "base.css"), "utf8");
  const decls = (body: string) => body.split(";").map((d) => d.trim()).filter(Boolean);
  const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1];
  const dark = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1];
  expect(system && dark).toBeTruthy();
  expect(decls(system!)).toEqual(decls(dark!));
  expect(decls(dark!)).toContain("color-scheme: dark");
  // and every token dark sets is one light sets too
  const light = decls(css.match(/^:root \{([^}]*)\}/m)![1].replace(/\/\*[\s\S]*?\*\//g, "")).map((d) => d.split(":")[0]);
  expect(decls(dark!).map((d) => d.split(":")[0]).filter((k) => k.startsWith("--") && !light.includes(k))).toEqual([]);
});
