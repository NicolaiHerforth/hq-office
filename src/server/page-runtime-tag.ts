// THE PAGE RUNTIME's tag: what pages.ts puts first in every page's <head>, the page's key and stored keys as JSON and
// then the runtime script (src/client/page-runtime/runtime.js), so it runs before any of the page's own scripts. No
// database here, so pages.ts stays importable on its own: page-runtime.ts hands in where the stored keys come from.
const RUNTIME_SRC = "/src/client/page-runtime/runtime.js";

let storageOf: (page: string) => Record<string, string> = () => ({});
export function setStorageSource(fn: (page: string) => Record<string, string>) {
  storageOf = fn;
}
// The version of the page as it is stored, not as it is served (a fragment wrapped, a theme put on it): what publish
// compares with. page-publish.ts hands it in.
let versionOf: (page: string) => string = () => "";
export function setVersionSource(fn: (page: string) => string) {
  versionOf = fn;
}

// Which version of a page this is: what the page sends back when it publishes itself (page-publish.ts), so a page
// published over by someone else in the meantime is told so (conflict) instead of overwriting it.
export const sourceVersion = (html: string) => new Bun.CryptoHasher("sha256").update(html).digest("hex").slice(0, 16);

// After <head>, else after <html>, else after the doctype, else at the very start. JSON in a script element: every <
// (and the two JavaScript line separators) escaped, so no value can close the element.
export function withRuntime(html: string, page = "") {
  const boot = JSON.stringify({ page, version: page ? versionOf(page) : "", storage: page ? storageOf(page) : {} }).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const tag = `<script type="application/json" data-hud-page>${boot}</script><script src="${RUNTIME_SRC}"></script>`;
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  return tag + html;
}
