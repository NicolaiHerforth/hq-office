// One renderer for text: every place the page shows text that HQ or a lane wrote goes through core/markdown.js
// (md, mdInline, mdClip). This scans src/client and fails on the old renderers (linkify, clipText, renderBody,
// rooms/markdown.js) and on a text field put on the page raw: esc(x.text), esc(short(x.body, 80)), or ${x.title}
// with no escaping at all. Names and UI strings stay esc(); a text field that is right as plain text (an attribute,
// a draft in a textarea) is on the allow-list below with its reason. Each failure names the file and the line.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLIENT = join(ROOT, "src", "client");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(CLIENT).filter((f) => f.endsWith(".js"));
const lines = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((text, i) => ({ file: relative(ROOT, f), line: i + 1, text })));
const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;

const FIELD = "(?:text|body|title|note|why|answer|brief|what|summary|prompt)";
// esc( ... x.FIELD ... ) within one call, and ${x.FIELD} put into markup unescaped.
const RAW = [new RegExp(`\\besc\\([^)]*\\.${FIELD}\\b`, "g"), new RegExp(`\\$\\{\\s*[\\w$.?]+\\.${FIELD}\\s*\\}`, "g")];

// Where plain text is right. Each entry: the file, text on the line, and why.
const ALLOW = [
  { file: "src/client/rooms/index.js", has: 'title="${esc(w.item.why)}"', why: "a tooltip attribute: markup cannot go in an attribute" },
  { file: "src/client/rooms/index.js", has: 'aria-label="Go to room ${esc(r.title)}"', why: "an aria-label attribute" },
  { file: "src/client/rooms/index.js", has: 'title="${esc(x.title)}"', why: "a tooltip attribute on a room's tab" },
  { file: "src/client/rooms/index.js", has: 'aria-label="See ${esc(a.title)} full screen"', why: "an aria-label attribute" },
  { file: "src/client/rooms/index.js", has: '<div class="at" title="${esc(a.title)}">', why: "a tooltip attribute on a shelf card" },
  { file: "src/client/rooms/index.js", has: '>${esc(d.text)}</textarea>', why: "the owner's own draft, put back into a textarea" },
  { file: "src/client/questions/questions.js", has: '>${esc(d.text || "")}</textarea>', why: "the owner's own draft, put back into a textarea" },
  { file: "src/client/rooms/new.js", has: 'value="${esc(form.title)}"', why: "the owner's own room title, put back into its input" },
  { file: "src/client/rooms/new.js", has: '>${esc(form.text)}</textarea>', why: "the owner's own first message, put back into its textarea" },
];

test("the old renderers are gone and nothing imports them", () => {
  expect(existsSync(join(CLIENT, "rooms", "markdown.js"))).toBe(false);
  const bad = lines.filter((l) => /\b(linkify|clipText|renderBody)\b/.test(l.text) || /from\s+"[^"]*rooms\/markdown\.js"/.test(l.text) || (l.file.startsWith("src/client/rooms/") && /from\s+"\.\/markdown\.js"/.test(l.text)));
  expect(bad.map((l) => `${at(l)}: ${l.text.trim().slice(0, 160)}`)).toEqual([]);
});

test("core/markdown.js exports md, mdInline and mdClip", () => {
  const code = readFileSync(join(CLIENT, "core", "markdown.js"), "utf8");
  for (const name of ["md", "mdInline", "mdClip", "copyCode", "expanded"]) expect(code).toMatch(new RegExp(`export (function|const|let) ${name}\\b`));
});

test("no text field reaches the page raw: it goes through md, mdInline or mdClip", () => {
  const used = new Set<number>();
  const bad: string[] = [];
  for (const l of lines) {
    for (const re of RAW) for (const m of l.text.matchAll(re)) {
      const ok = ALLOW.findIndex((a) => a.file === l.file && l.text.includes(a.has) && a.has.includes(m[0].replace(/^\$\{\s*/, "${")));
      if (ok >= 0) used.add(ok);
      else bad.push(`${at(l)}: ${m[0]} (render it with md, mdInline or mdClip from core/markdown.js, or add an allow-list entry with a reason)`);
    }
  }
  expect(bad).toEqual([]);
  // An entry nothing matches any more is stale: remove it.
  expect(ALLOW.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.has}`)).toEqual([]);
});
