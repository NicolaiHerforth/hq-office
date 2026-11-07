// HTML PAGES: a page a lane writes (a room's .html file on the shelf, a room's brief, or a floor's brief that is a
// whole HTML document) is rendered in the HUD the way a Claude artifact would be, with no account needed. It runs in a
// sandbox: served with a Content-Security-Policy sandbox (no allow-same-origin), so even opened in its own tab its
// scripts run in an opaque origin and cannot read or call the HUD, its data or its storage; the page shows it in an
// iframe sandboxed the same way. Pictures come from this HUD's own files (a room's files/), data: and blob: URLs, or
// https; scripts and styles inline or from https (CDN libraries). It cannot fetch() from the HUD. Every secret value
// the HUD holds is blanked out of the HTML before it is served.
import { secrets } from "./push.ts";
import { closed, withRuntime } from "./page-runtime-tag.ts";

// A whole HTML document: what makes a brief a page rather than markdown. One comment in the pattern, not a repeat of
// them: a comment already runs on past a -->, so a second one only adds ways to read the same text, and a search tries
// every way before it gives up.
export const isHtmlDoc = (text: string | null | undefined) => /^\s*(?:<!--[\s\S]*?-->\s*)?(?:<!doctype\s+html|<html[\s>])/i.test(String(text ?? ""));
export const HTML_EXT = /\.html?$/i;
// A fragment, as a Claude artifact may be: no doctype, <html> or <body>, starting with what belongs in a head
// (<title>, <meta>, <link>, <style> or <script>); its host wraps it. A brief that starts any other way is markdown.
export const isFragment = (text: string | null | undefined) => /^\s*(?:<!--[\s\S]*?-->\s*)?<(?:title|meta|link|style|script)[\s>/]/i.test(String(text ?? ""));
// A brief that is a page: a whole HTML document or a fragment. (A .html file on a shelf is a page whatever it holds.)
export const isPage = (text: string | null | undefined) => isHtmlDoc(text) || isFragment(text);
// What a fragment is served in: the few lines a host gives it, as claude.ai's artifact skeleton does. It is light: a
// fragment opts into dark itself (themed() then gives it the matching color-scheme), so one that sets a light
// background keeps dark text on a dark screen. A whole document is served as it is.
export const SKELETON = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>:root { color-scheme: light; } body { margin: 0; }</style>\n`;
export const asDocument = (html: string) => (isHtmlDoc(html) ? html : SKELETON + html);

export const PAGE_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads",
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "connect-src https: data: blob:",
  "frame-src https: data: blob:",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// key names the page for its runtime (page-runtime.ts): rooms/SLUG/files/NAME, rooms/SLUG/brief or briefs/ID.
export function pageResponse(html: string, name = "page.html", key = "") {
  return new Response(secrets.mask(withRuntime(html, key)), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PAGE_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}

// Whether a page has a dark look of its own: a color-scheme that names dark, a prefers-color-scheme query or a
// data-theme selector (the skeleton's own color-scheme does not count).
export const handlesDark = (html: string) => {
  const own = html.startsWith(SKELETON) ? html.slice(SKELETON.length) : html;
  if (/prefers-color-scheme|data-theme/i.test(own)) return true;
  const first = own.search(/color-scheme/i);
  return first >= 0 && own.slice(first).split(/[;>]/).some(namesDark);
};
// Part of a page with no ; or > in it: the first color-scheme sees the most of it, so no later one can find more.
const namesDark = (part: string) => {
  const m = /color-scheme\s*[:=]/i.exec(part);
  return !!m && /dark/i.test(part.slice(m.index + m[0].length));
};
// The page's root tag, where a parser finds it: past leading space, comments and a doctype, and a > in a quoted value does
// not end it. An <html> anywhere else (a comment, a script) is not the root: the root is then implied, and a tag put
// before that content becomes it. The tag is rebuilt from its attributes and joined by position, so nothing a page wrote
// is read as a pattern.
const LEAD = /^(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*/i;
const ROOT_TAG = /^<html(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/i;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
// The reader's theme (?theme=light|dark on the frame's address), as claude.ai gives it to an artifact: data-theme on
// the page's <html>, and the matching color-scheme when the page has a dark look of its own. A page with none keeps
// its own color-scheme: forced dark, its default text would turn light on the light background it set itself.
// Without a theme (SYSTEM) the page is left as it is and follows the screen's own setting. Whatever data-theme the
// page set itself is replaced; its own style on <html> is kept.
export function themed(html: string, theme: string | null | undefined) {
  if (theme !== "light" && theme !== "dark") return html;
  const scheme = theme === "light" || handlesDark(html) ? `color-scheme: ${theme}` : "";
  const start = LEAD.exec(html)![0].length;
  const tag = ROOT_TAG.exec(html.slice(start));
  if (!tag) {
    const lead = html.slice(0, start).trimEnd();
    return `${lead}<html data-theme="${theme}"${scheme ? ` style="${scheme}"` : ""}>${html.slice(lead.length)}`;
  }
  const named = (m: RegExpMatchArray, name: string) => m[1].toLowerCase() === name;
  const attrs = [...tag[1].matchAll(ATTR)].filter((m) => !named(m, "data-theme"));
  const style = attrs.find((m) => named(m, "style"));
  const kept = attrs.map((m) => (m === style && scheme ? `style="${scheme}; ${(m[2] ?? "").replace(/^(["'])(.*)\1$/s, "$2").replace(/"/g, "&quot;")}"` : m[0]));
  if (scheme && !style) kept.push(`style="${scheme}"`);
  return `${html.slice(0, start)}<html data-theme="${theme}"${kept.map((a) => ` ${a}`).join("")}>${html.slice(start + tag[0].length)}`;
}

// A page as the HUD serves it: a fragment wrapped, in the reader's theme, then sandboxed (pageResponse).
export const servePage = (html: string, name = "page.html", theme?: string | null, key = "") => pageResponse(themed(asDocument(html), theme), name, key);

// What a page is called in a list: its <title>, else its first heading, else its first words.
export function pageTitle(html: string) {
  const t = between(html, /<title[^>]*>/i, /<\/title>/i) ?? between(html, /<h1[^>]*>/i, /<\/h1>/i) ?? "";
  return noTags(t, "").replace(/\s+/g, " ").trim();
}
// What is between the first OPEN and the CLOSE after it. With no CLOSE after the first OPEN there is none after a later
// one either.
function between(html: string, open: RegExp, close: RegExp) {
  const m = open.exec(closed(html));
  if (!m) return undefined;
  const rest = html.slice(m.index + m[0].length), end = rest.search(close);
  return end < 0 ? undefined : rest.slice(0, end);
}
const noTags = (s: string, by: string) => {
  const head = closed(s);
  return head.replace(/<[^>]+>/g, by) + s.slice(head.length);
};
// HTML with each <script>, <style> and <title> element blanked, up to the first close of its own name. A name found to
// have no close left is not looked for again.
function noElements(html: string) {
  const open = /<(script|style|title)/gi, unclosed = new Set<string>();
  let out = "", at = 0;
  for (let m; (m = open.exec(html));) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}>`, "gi");
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) { unclosed.add(name); continue; }
    out += `${html.slice(at, m.index)} `;
    at = open.lastIndex = c.index + c[0].length;
  }
  return out + html.slice(at);
}
// A page's text, for a one-line lead: no tags, scripts, styles or title (the list shows that already).
export const pageText = (html: string) => noTags(noElements(secrets.mask(html)), " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
