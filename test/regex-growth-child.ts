// One case of test/server/regex-growth.test.ts, in a process the parent can kill: a search that blows up never comes
// back, so nothing in the parent could stop it. Doubles the input and prints { bytes, ms } per size, the fastest of 3.
// With no argument the file is only the table of cases; nothing is loaded until a case runs. HUD_DATA_DIR must be a
// throwaway folder: the cases that write do so through the server's own modules.
type Fn = (s: string) => unknown;
type Case = { load: () => Promise<Fn>; build: (k: number) => string };

const pages = () => import("../src/server/pages.ts");
const markdown = () => import("../src/client/core/markdown.js");
// The server's modules need one another loaded in this order, as main.ts loads them.
const server = async () => {
  for (const m of ["config", "db", "types", "push", "updates", "events", "herdr", "lanes", "score", "state"]) await import(`../src/server/${m}.ts`);
};
const fn = (load: () => Promise<Fn>) => load;
const isPage = fn(async () => (await pages()).isPage);
const themed = fn(async () => { const { themed } = await pages(); return (s) => themed(s, "dark"); });
const served = fn(async () => { const { servePage } = await pages(); return (s) => servePage(s, "p.html", "dark", ""); });
const runtime = fn(async () => (await import("../src/server/page-runtime-tag.ts")).withRuntime);
const pageTitle = fn(async () => (await pages()).pageTitle);
const pageText = fn(async () => (await pages()).pageText);
const refsIn = fn(async () => { await server(); return (await import("../src/server/refs.ts")).refsIn; });
const typed = fn(async () => { await server(); return (await import("../src/server/hq-queue.ts")).typed; });
const boxHolds = fn(async () => { await server(); const { boxHolds } = await import("../src/server/hq-queue.ts"); return (s) => boxHolds("box", s); });
const prOf = fn(async () => { await server(); return (await import("../src/server/ledger.ts")).prOf; });
const postBrief = fn(async () => { await server(); const { postBrief } = await import("../src/server/briefs.ts"); return (s) => { try { postBrief({ title: "t", body: s }, "", "x"); } catch {} }; });
const askFields = fn(async () => { await server(); const { pageOfFields } = await import("../src/server/ask-pages.ts"); return (s) => { try { pageOfFields({ body: s }); } catch {} }; });
const firstLine = fn(async () => (await import("../src/client/embeds/model.js")).firstLine);
const md = fn(async () => (await markdown()).md);
const mdInline = fn(async () => (await markdown()).mdInline);
const mdClip = fn(async () => { const { mdClip } = await markdown(); return (s) => mdClip(s, "closed"); });
const mdClipOpen = fn(async () => { const { expanded, mdClip } = await markdown(); expanded.add("open"); return (s) => mdClip(s, "open"); });

// Each run of backticks a length of its own, so no two ever pair up.
const backtickRuns = (k: number) => { let s = "a "; for (let i = 1; s.length < k; i++) s += `${"`".repeat(i)} `; return s; };
const pasteIds = (k: number) => Array.from({ length: k }, (_, i) => `<pasted_content id="${i}">`).join("");
const staircase = (mark: string) => (k: number) => { let s = ""; for (let i = 1; s.length < k; i++) s += `${mark.repeat(i)}a\n`; return s; };
const stepDown = (line: (i: number) => string) => (k: number) => { let s = ""; for (let i = 0; s.length < k; i++) s += line(i); return s; };
const rep = (load: () => Promise<Fn>, unit: string, before = "", after = ""): Case => ({ load, build: (k) => before + unit.repeat(k) + after });

export const CASES: Record<string, Case> = {
  "isPage closed comments": rep(isPage, "<!---->", "", "x"),
  "isPage open comments": rep(isPage, "<!-- "),
  "isPage comments and spaces": rep(isPage, "<!---->  ", "", "x"),
  "isPage one comment many ends": rep(isPage, "--> ", "<!-- "),
  "themed closed comments": rep(themed, "<!---->", "", "x"),
  "themed open comments": rep(themed, "<!-- "),
  "themed one comment many doctypes": rep(themed, "--><!doctype ", "<!-- "),
  "themed open html": rep(themed, "<html "),
  "themed open doctype": rep(themed, "<!doctype "),
  "themed one long html": rep(themed, "<html ", "", ">"),
  "themed dark words": rep(themed, "color-scheme:"),
  "themed data-theme attrs": rep(themed, " data-theme", "<html", ">"),
  "themed open quotes": rep(themed, ' data-theme="', "<html", ">"),
  "themed style attrs": rep(themed, " style=", "<html", ">"),
  "withRuntime open head": rep(runtime, "<head "),
  "withRuntime open html": rep(runtime, "<html "),
  "withRuntime open doctype": rep(runtime, "<!doctype "),
  "servePage open head": rep(served, "<head ", "<!doctype html>"),
  "pageTitle open title": rep(pageTitle, "<title "),
  "pageTitle open h1": rep(pageTitle, "<h1 "),
  "pageTitle titles": rep(pageTitle, "<title>"),
  "pageTitle h1s": rep(pageTitle, "<h1>"),
  "pageTitle brackets": rep(pageTitle, "<"),
  "pageTitle brackets in title": rep(pageTitle, "<", "<title>", "</title>"),
  "pageText open script": rep(pageText, "<script "),
  "pageText open style": rep(pageText, "<style "),
  "pageText open title": rep(pageText, "<title "),
  "pageText brackets": rep(pageText, "<"),
  "pageText crossed closes": rep(pageText, "<script></style>"),
  "refsIn open cards": rep(refsIn, "<hud-card "),
  "refsIn open ref": rep(refsIn, '<hud-card ref="'),
  "refsIn cards then a close": rep(refsIn, "<hud-card ", "", ">"),
  "refsIn cards then a ref": rep(refsIn, "<hud-card ", "", " ref=a"),
  "refsIn many refs": rep(refsIn, "<hud-card ref=a "),
  "typed open pastes": rep(typed, '<pasted_content id="x">'),
  "typed pastes of many ids": { load: typed, build: pasteIds },
  "boxHolds open pastes": rep(boxHolds, '<pasted_content id="x">'),
  "prOf a word": rep(prOf, "a"),
  "postBrief spaces": rep(postBrief, " ", "", "x"),
  "ask page spaces": rep(askFields, " ", "<title>t</title>", "x"),
  "firstLine heading spaces": rep(firstLine, " ", "# ", "x"),
  "firstLine heading hashes": rep(firstLine, " #", "# ", "x"),
  "firstLine heading gap": rep(firstLine, " ", "# a", "b"),
  "firstLine broken heading": rep(firstLine, " ", "# ", "a\u2028b"),
  "md brackets": rep(md, "["),
  "md open links": rep(md, "[a]("),
  "md open images": rep(md, "![a]("),
  "md open image tokens": rep(md, "[image: "),
  "md open file tokens": rep(md, "[file: "),
  "md backticks": rep(md, "`", "a ", "b"),
  "md backtick runs": { load: md, build: backtickRuns },
  "md open code": rep(md, "`a "),
  "md stars": rep(md, "*", "a "),
  "md open italics": rep(md, "*a "),
  "md open bold": rep(md, "**a "),
  "md open underscores": rep(md, "_a "),
  "md open dunders": rep(md, "__a "),
  "md tildes": rep(md, "~", "a "),
  "md open strikes": rep(md, "~~a "),
  "md url dots": rep(md, ".", "https://a"),
  "md url closing brackets": rep(md, ")", "https://a"),
  "md url both ends": rep(md, ".)", "https://a"),
  "md urls": rep(md, "https://a "),
  "md angle urls": rep(md, "<http://a "),
  "md reference dots": rep(md, ".", "#page/rooms/a/files/", "x"),
  "md heading spaces": rep(md, " ", "# ", "x"),
  "md heading hashes": rep(md, " #", "# ", "x"),
  "md heading words": rep(md, "a ", "# "),
  "md heading gap": rep(md, " ", "# a", "b"),
  "md heading gap hashes": rep(md, " #", "# a", "b"),
  "md broken heading": rep(md, " ", "# ", "a\u2028b"),
  "md hashes": rep(md, "#"),
  "md rule dashes": rep(md, "- ", "", "x"),
  "md item spaces": rep(md, " ", "- ", "a b"),
  "md fence backticks": rep(md, "`", "", " "),
  "md spaces": rep(md, " ", "", "x"),
  "md table divider": rep(md, " ", "|a|\n", "x"),
  "md table rows": rep(md, "|a|b|\n", "|a|b|\n|-|-|\n"),
  "md pipes": rep(md, "|"),
  "md quote marks": rep(md, "> "),
  "md quote marks tight": rep(md, ">"),
  "md quote lines": rep(md, "> a\n"),
  "md quote staircase": { load: md, build: staircase("> ") },
  "md list staircase": { load: md, build: staircase("  - ") },
  "md list nested by tabs": { load: md, build: stepDown((i) => `${"\t".repeat(i >> 1)}${i & 1 ? "  " : ""}- a\n`) },
  "md list nested by spaces": { load: md, build: stepDown((i) => `${"  ".repeat(i)}- a\n`) },
  "md quote inside a list, nested": { load: md, build: stepDown((i) => `${"  ".repeat(i)}- > - a\n`) },
  "md list blank lines": rep(md, "\n", "- a\n", "  x"),
  "md nested items": rep(md, "  - b\n", "- a\n"),
  "md list blanks then a long indented line": { load: md, build: (k) => `- a\n${"\n".repeat(k)}${" ".repeat(k)}x` },
  "md list blanks then a long item": { load: md, build: (k) => `- a\n${"\n".repeat(k)}- ${" ".repeat(k)}x` },
  "md fence padding": rep(md, " ", "", "```\na\n```"),
  "md list items": rep(md, "- a\n"),
  "md lines": rep(md, "a\n"),
  "md fences": rep(md, "```\n"),
  "mdInline spaces": rep(mdInline, " ", "", "x"),
  "mdClip spaces": rep(mdClip, " ", "", "x"),
  "mdClip tokens then a word": rep(mdClip, "[file: a]", "", "x"),
  "mdClip spaced tokens then a word": rep(mdClip, "[file: a] ", "", "x"),
  "mdClip tokens": rep(mdClip, "[file: /uploads/a]"),
  "mdClip open tokens": rep(mdClip, "[image: "),
  "mdClip brackets": rep(mdClip, "["),
  "mdClip words": rep(mdClip, "a "),
  "mdClip blank lines in a fence": rep(mdClip, "\n", "```\n", `\`\`\`\n${"x ".repeat(200)}`),
  "mdClip open fence": rep(mdClip, "a\n", "```\n"),
  "mdClip list blanks before a fence": { load: mdClip, build: (k) => `- a\n${"\n".repeat(k)}${" ".repeat(k)}x\n\n\`\`\`\nb\n\`\`\`\n${"c ".repeat(200)}` },
  "mdClip nested by tabs before a fence": { load: mdClip, build: (k) => `${stepDown((i) => `${"\t".repeat(i >> 1)}${i & 1 ? "  " : ""}- a\n`)(k)}\n\`\`\`\nb\n\`\`\`\n${"c ".repeat(200)}` },
  "mdClip opened spaces": rep(mdClipOpen, " ", "", "x"),
};

if (import.meta.main) {
  const name = process.argv[2], c = CASES[name];
  if (!c) throw new Error(`no case: ${name}`);
  const run = await c.load();
  const FLOOR_MS = Number(process.env.GROWTH_FLOOR_MS ?? 10), DOUBLINGS = Number(process.env.GROWTH_DOUBLINGS ?? 3), MAX_BYTES = Number(process.env.GROWTH_MAX_BYTES ?? 4_000_000);
  let above = 0;
  for (let k = 1; above <= DOUBLINGS; k *= 2) {
    const text = c.build(k);
    if (text.length > MAX_BYTES) break;
    let ms = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      run(text);
      ms = Math.min(ms, performance.now() - t);
    }
    console.log(JSON.stringify({ bytes: text.length, ms }));
    if (ms >= FLOOR_MS) above++;
  }
  process.exit(0);
}
