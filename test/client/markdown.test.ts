// core/markdown.js in Chrome: md() renders bold, lists, a code box with COPY, a heading and links; text that looks
// like HTML stays text and never runs; javascript: and data: are never links; mdInline() makes no blocks; mdClip()
// never cuts a code fence nor hides a code box, and keeps MORE/LESS by key. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];

// Runs md/mdInline/mdClip on TEXT in the page and returns what the browser made of the HTML.
const render = (fn: string, text: string, ...args: unknown[]) => page.evaluate(`(async () => {
  const m = await import("/src/client/core/markdown.js");
  const html = m.${fn}(${JSON.stringify(text)}${args.map((a) => `, ${JSON.stringify(a)}`).join("")});
  // Parsed in a template: nothing in it loads or runs.
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const box = tpl.content;
  const all = (s) => [...box.querySelectorAll(s)];
  return {
    html,
    text: box.textContent,
    tags: [...new Set(all("*").map((e) => e.tagName.toLowerCase()))],
    links: all("a").map((a) => ({ href: a.getAttribute("href"), text: a.textContent, target: a.target, rel: a.rel })),
    code: all(".codebox pre").map((p) => p.textContent),
    copy: all(".codebox .copy").length,
    attrs: all("*").flatMap((e) => [...e.attributes].map((a) => a.name)),
  };
})()`);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  page = await newSession(chrome.cdp, errors);
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Page.navigate", { url: `${server.base}/` });
  for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(`!!document.getElementById("lastNote")?.innerHTML`).catch(() => false)) break;
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
});

test.skipIf(!chromeFound)("md renders bold, italic, a heading, lists, a quote, a code box with COPY and links", async () => {
  const r = await render("md", "## Plan\nThe **fast** way, *maybe*, with `bun test`.\nA second line.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [x] done\n- [ ] open\n\n> quoted\n\n```sh\nbun test\n  indented <b>raw</b>\n```\n\nSee [the doc](https://example.com/doc), https://example.com/plain. and <https://example.com/auto> or [mail](mailto:a@example.com) or [a file](/uploads/x.png)");
  for (const t of ["h4", "b", "i", "code", "br", "ul", "ol", "li", "blockquote", "a", "pre", "p"]) expect(r.tags).toContain(t);
  expect(r.code).toEqual(["bun test\n  indented <b>raw</b>"]);
  expect(r.copy).toBe(1);
  expect(r.links).toContainEqual({ href: "https://example.com/doc", text: "the doc", target: "_blank", rel: "noopener noreferrer" });
  expect(r.links.map((l: any) => l.href)).toEqual(["https://example.com/doc", "https://example.com/plain", "https://example.com/auto", "mailto:a@example.com", "/uploads/x.png"]);
  for (const l of r.links) expect(l.rel).toBe("noopener noreferrer");
  expect(r.html).toMatch(/<ul>.*<li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  expect(r.html).toContain('<span class="tick on">');
});

test.skipIf(!chromeFound)("HTML in text stays text and never runs", async () => {
  const r = await render("md", 'hi <script>window.pwned = 1</script> <img src=x onerror="window.pwned = 2"> **<i>x</i>** [x](https://e.com/" onmouseover="alert(1))');
  expect(r.tags.filter((t: string) => !["p", "b", "a"].includes(t))).toEqual([]);
  expect(r.attrs.filter((a: string) => !["href", "target", "rel"].includes(a))).toEqual([]);
  expect(r.text).toContain("<script>window.pwned = 1</script>");
  expect(r.text).toContain('<img src=x onerror="window.pwned = 2">');
  // On the live page too.
  await page.evaluate(`(async () => {
    const m = await import("/src/client/core/markdown.js");
    const box = document.createElement("div");
    box.innerHTML = m.md(${JSON.stringify('<script>window.pwned = 1</script><img src=x onerror="window.pwned = 2"><svg onload="window.pwned = 3">')});
    document.body.append(box);
    await new Promise((r) => setTimeout(r, 300));
    box.remove();
  })()`);
  expect(await page.evaluate("window.pwned ?? null")).toBe(null);
  const inline = await render("mdInline", "<img src=x onerror=alert(1)> **b**");
  expect(inline.tags).toEqual(["b"]);
});

test.skipIf(!chromeFound)("javascript: and data: are never links; neither is another site's path or a protocol-relative URL", async () => {
  const r = await render("md", "[a](javascript:alert(1)) [b](data:text/html,x) [c](JAVASCRIPT:alert(1)) [d](//evil.example/x) [e](/api/secrets) javascript:alert(1) <javascript:alert(1)>");
  expect(r.links).toEqual([]);
  expect(r.text).toContain("[a](javascript:alert(1))");
});

test.skipIf(!chromeFound)("[image: path] is a thumbnail on this HUD, and a long URL is shortened", async () => {
  const long = "https://example.com/" + "x".repeat(120);
  const r = await render("md", `[image: /tmp/shot.png] [image: /data/rooms/abc-7/files/a b.png] ${long}`);
  expect(r.tags).toContain("img");
  expect(r.links.map((l: any) => l.href)).toEqual(["/uploads/shot.png", "/rooms/abc-7/files/a%20b.png", long]);
  expect(r.links[2].text.length).toBeLessThan(62);
});

test.skipIf(!chromeFound)("[file: path] is a link named after the file, only for this HUD's own uploads/ and rooms/ files", async () => {
  const r = await render("md", "[file: /data/uploads/Report Q3.pdf] [file: /data/rooms/abc-7/files/plan-2.zip] and [image: /data/uploads/a.png]");
  expect(r.links.map((l: any) => [l.href, l.text])).toEqual([["/uploads/Report%20Q3.pdf", "Report Q3.pdf"], ["/rooms/abc-7/files/plan-2.zip", "plan-2.zip"], ["/uploads/a.png", ""]]);
  expect(r.html).toContain('class="file"');
  // Anything else stays text: a path outside, a climb out, a script, another site, a hidden file.
  for (const p of ["/etc/passwd", "/data/uploads/../hud.db", "javascript:alert(1)", "JaVaScRiPt:alert(1)//uploads/x.pdf", "https://evil.example/uploads/x.pdf", "/data/uploads/.env", "/data/rooms/x/files/sub/a.pdf", "/data/rooms/../files/a.pdf", "data:text/html,<b>x</b>"]) {
    const t = await render("md", `[file: ${p}]`);
    expect([p, t.links]).toEqual([p, []]);
    expect(t.text).toBe(`[file: ${p}]`);
    expect(t.tags).toEqual(["p"]);
  }
  // Inside a button or a link it is its name, as text.
  const plain = await render("mdInline", "[file: /data/uploads/a.pdf]", { links: false });
  expect(plain.links).toEqual([]);
  expect(plain.text).toBe("[file: a.pdf]");
});

test.skipIf(!chromeFound)("mdInline makes no blocks and turns line breaks into spaces", async () => {
  const r = await render("mdInline", "# Title with **bold**\n- not a list\n```\ncode\n```\n> no quote [link](https://example.com)");
  for (const t of r.tags) expect(["b", "i", "code", "a", "s"]).toContain(t);
  expect(r.tags).toContain("b");
  expect(r.tags).toContain("a");
  expect(r.text).not.toContain("\n");
  const plain = await render("mdInline", "a [link](https://example.com) and https://example.com/x", { links: false });
  expect(plain.links).toEqual([]);
  expect(plain.text).toBe("a link and https://example.com/x");
});

test.skipIf(!chromeFound)("mdClip never hides attachments behind MORE: the tokens at the end count for nothing and always show", async () => {
  const toks = " [file: /a/very/long/data/directory/on/this/machine/uploads/Q3 report.pdf] [image: /a/very/long/data/directory/on/this/machine/uploads/chart.png]";
  const short = await render("mdClip", `From the phone${toks.repeat(3)}`, "att1");
  expect(short.html).not.toContain("data-more");
  expect(short.links.filter((l: any) => l.href.startsWith("/uploads/"))).toHaveLength(6);
  const long = await render("mdClip", `${"word ".repeat(80)}${toks}`, "att2");
  expect(long.html).toContain("data-more");
  expect(long.text).toContain("…");
  expect(long.links.map((l: any) => l.href)).toEqual(["/uploads/Q3%20report.pdf", "/uploads/chart.png"]);
  expect(long.tags).toContain("img");
});

test.skipIf(!chromeFound)("mdClip never cuts a code fence nor hides a code box behind MORE, and keeps MORE/LESS by key", async () => {
  const words = "word ".repeat(40);
  const text = `${words}\n\`\`\`\n${"line of code\n".repeat(30)}\`\`\`\n\n${words}${words}`;
  const r = await render("mdClip", text, "t1");
  expect(r.code.length).toBe(1);
  expect(r.code[0]).toBe("line of code\n".repeat(30).trimEnd());
  expect(r.html).toContain('data-more="t1"');
  expect(r.text).toContain("MORE");
  expect(r.text.length).toBeLessThan(text.length);
  // A code box well past the limit still shows, whole; only the text after it waits behind MORE.
  const late = await render("mdClip", `${words}${words}${words}\n\`\`\`\nbun test\n\`\`\`\n${words}`, "t3");
  expect(late.code).toEqual(["bun test"]);
  expect(late.text).toContain("MORE");
  // Wherever the cut falls near a fence, the fence shows whole, never half.
  for (let n = 0; n < 400; n += 7) {
    const t = `${"a".repeat(n)}\n\`\`\`\n${"x y z\n".repeat(80)}\`\`\`\nafter ${words}${words}`;
    const c = await render("mdClip", t, `n${n}`);
    for (const code of c.code) expect(code).toBe("x y z\n".repeat(80).trimEnd());
    expect(c.html).not.toContain("```");
  }
  const short = await render("mdClip", "**short**", "t2");
  expect(short.html).not.toContain("data-more");
  await page.evaluate(`import("/src/client/core/markdown.js").then((m) => m.expanded.add("t1"))`);
  const open = await render("mdClip", text, "t1");
  expect(open.text).toContain("LESS");
  expect(open.text).toContain(words.trim());
  expect(open.code[0]).toBe("line of code\n".repeat(30).trimEnd());
});

test.skipIf(!chromeFound)("no errors on the page", () => {
  expect(errors).toEqual([]);
});
