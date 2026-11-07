// Text HQ or a lane wrote can never run in the page: what markdown makes for one token must not end up inside another
// token's attribute. Real Chrome, a real mouse, a script that only sets a flag. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];

const inner = "[a](https://y/onmouseover=window.__ran=1//)";
const FORMS: Record<string, string> = {
  "an angle URL around a link": `<https://x${inner}>`,
  "an angle mailto around a link": `<mailto:x${inner}>`,
  "a reference around a link, after a bracket": `(#page/rooms/a/files/x${inner}`,
  "a reference around a link, after a space": `see #page/rooms/a/files/x${inner}`,
  "a reference around a link, at the start": `#page/rooms/a/files/x${inner}`,
  "a link around code": "[a](https://x`c`)",
  "a link around an image": "[a](https://x[image: /y/onmouseover=window.__ran=1//.png])",
  "a link around a file": "[a](https://x[file: /x/uploads/onmouseover=window.__ran=1])",
  "an in-page link around code": "[a](#page/rooms/a/files/x`c`)",
  "an angle URL around code": "<https://x`c`>",
  "an angle URL around an image": "<https://x[image: /y/a.png]>",
  "a reference around code": "(#page/rooms/a/files/x`c`",
};
const ALLOWED = new Set(["href", "target", "rel", "class", "src", "alt"]);

// Moves the real mouse over every element in the box, then says what ran and which attributes came out.
async function hoverAll(selector: string) {
  const points = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].flatMap((box) => [box, ...box.querySelectorAll("*")]).flatMap((e) => { e.scrollIntoView({ block: "center" }); const r = e.getClientRects()[0]; return r ? [{ x: r.x + r.width / 2, y: r.y + r.height / 2 }] : []; })`);
  for (const { x, y } of points) await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await Bun.sleep(50);
  return page.evaluate(`({ ran: window.__ran ?? null, attrs: [...new Set([...document.querySelectorAll(${JSON.stringify(selector)})].flatMap((box) => [...box.querySelectorAll("*")]).flatMap((e) => [...e.attributes].map((a) => a.name)))], n: document.querySelectorAll(${JSON.stringify(selector)}).length })`);
}

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Page.navigate", { url: `${server.base}/` });
  for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(`!!document.querySelector("#menuDrop .seg.on[data-set-theme]")`).catch(() => false)) break;
}, 30_000);

afterAll(async () => {
  await page?.s("Page.navigate", { url: "about:blank" });
  await server?.stop();
  await chrome?.close();
});

for (const [name, text] of Object.entries(FORMS)) {
  for (const fn of ["md", "mdInline", "mdClip"]) {
    test.skipIf(!chromeFound)(`${fn}: ${name} runs nothing and adds no attribute`, async () => {
      await page.evaluate(`(async () => {
        const m = await import("/src/client/core/markdown.js");
        window.__ran = undefined;
        document.getElementById("mdHrefBox")?.remove();
        const box = document.createElement("div");
        box.id = "mdHrefBox";
        box.style.cssText = "position:fixed;left:0;top:0;width:900px;background:#fff;color:#000;z-index:99999";
        box.innerHTML = m.${fn}(${JSON.stringify(text)}, "k");
        document.body.append(box);
      })()`);
      const got = await hoverAll("#mdHrefBox");
      expect(got.ran).toBeNull();
      expect(got.attrs.filter((a: string) => !ALLOWED.has(a))).toEqual([]);
    });
  }
}

const SURFACES: [string, () => Promise<string>, string][] = [
  ["a question's body", async () => { await server.post("/api/asks", { title: "q", body: FORMS["an angle URL around a link"], type: "info" }); return "#"; }, ".ask"],
  ["a question's title", async () => { await server.post("/api/asks", { title: FORMS["a reference around a link, after a bracket"], body: "b", type: "info" }); return "#"; }, ".ask"],
  ["a brief's page", async () => `#brief/${(await server.post("/api/briefs", { title: FORMS["an angle mailto around a link"], body: FORMS["a reference around a link, after a space"] })).id}`, ".briefview"],
];
for (const [name, set, selector] of SURFACES) {
  test.skipIf(!chromeFound)(`${name} on the real page runs nothing`, async () => {
    const hash = await set();
    await page.s("Page.navigate", { url: "about:blank" });
    await page.s("Page.navigate", { url: `${server.base}/${hash === "#" ? "" : hash}` });
    for (const end = Date.now() + 8000; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(`!!document.querySelector("#menuDrop .seg.on[data-set-theme]") && !!document.querySelector(${JSON.stringify(`${selector} h1, ${selector} h3`)})`).catch(() => false)) break;
    const got = await hoverAll(selector);
    expect(got.n).toBeGreaterThan(0);
    expect(got.ran).toBeNull();
  }, 20_000);
}

test.skipIf(!chromeFound)("a link with code in its text still works, and plain links, references and tokens keep theirs", async () => {
  const html = await page.evaluate(`(async () => {
    const m = await import("/src/client/core/markdown.js");
    return m.md("[\`c\`](https://x.y/a) <https://x.y/b> #brief/12 [file: /x/uploads/f.txt]");
  })()`);
  expect(html).toContain('<a href="https://x.y/a" target="_blank" rel="noopener noreferrer"><code class="mdc">c</code></a>');
  expect(html).toContain('<a href="https://x.y/b"');
  expect(html).toContain('<a href="#brief/12">#brief/12</a>');
  expect(html).toContain('<a class="file" href="/uploads/f.txt"');
});

test.skipIf(!chromeFound)("no errors on the page but the pictures the forms name, which do not exist", () => {
  expect(errors.filter((e) => !e.includes("status of 404"))).toEqual([]);
});
