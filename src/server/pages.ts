// HTML PAGES: a page a lane writes (a room's .html file on the shelf, a room's brief, or a floor's brief that is a
// whole HTML document) is rendered in the HUD the way a Claude artifact would be, with no account needed. It runs in a
// sandbox: served with a Content-Security-Policy sandbox (no allow-same-origin), so even opened in its own tab its
// scripts run in an opaque origin and cannot read or call the HUD, its data or its storage; the page shows it in an
// iframe sandboxed the same way. Pictures come from this HUD's own files (a room's files/), data: and blob: URLs, or
// https; scripts and styles inline or from https (CDN libraries). It cannot fetch() from the HUD. Every secret value
// the HUD holds is blanked out of the HTML before it is served.
import { secrets } from "./push.ts";
import { withRuntime } from "./page-runtime-tag.ts";

// A whole HTML document: what makes a brief a page rather than markdown.
export const isHtmlDoc = (text: string | null | undefined) => /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(String(text ?? ""));
export const HTML_EXT = /\.html?$/i;
// A fragment, as a Claude artifact may be: no doctype, <html> or <body>, starting with what belongs in a head
// (<title>, <meta>, <link>, <style> or <script>); its host wraps it. A brief that starts any other way is markdown.
export const isFragment = (text: string | null | undefined) => /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:title|meta|link|style|script)[\s>/]/i.test(String(text ?? ""));
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
export const handlesDark = (html: string) => /color-scheme\s*[:=][^;>]*dark|prefers-color-scheme|data-theme/i.test(html.startsWith(SKELETON) ? html.slice(SKELETON.length) : html);
// The reader's theme (?theme=light|dark on the frame's address), as claude.ai gives it to an artifact: data-theme on
// the page's <html>, and the matching color-scheme when the page has a dark look of its own. A page with none keeps
// its own color-scheme: forced dark, its default text would turn light on the light background it set itself.
// Without a theme (SYSTEM) the page is left as it is and follows the screen's own setting. Whatever data-theme the
// page set itself is replaced; its own style on <html> is kept.
export function themed(html: string, theme: string | null | undefined) {
  if (theme !== "light" && theme !== "dark") return html;
  const scheme = theme === "light" || handlesDark(html) ? `color-scheme: ${theme}` : "";
  const tag = html.match(/<html\b[^>]*>/i);
  if (!tag) return html.replace(/^(\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>)?/i, `$1<html data-theme="${theme}"${scheme ? ` style="${scheme}"` : ""}>`);
  let attrs = tag[0].slice(5, -1).replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  const style = attrs.match(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (scheme) {
    attrs = style
      ? attrs.replace(style[0], ` style="${scheme}; ${(style[2] ?? style[3] ?? "").replace(/"/g, "&quot;")}"`)
      : `${attrs} style="${scheme}"`;
  }
  return html.replace(tag[0], `<html data-theme="${theme}"${attrs}>`);
}

// A page as the HUD serves it: a fragment wrapped, in the reader's theme, then sandboxed (pageResponse).
export const servePage = (html: string, name = "page.html", theme?: string | null, key = "") => pageResponse(themed(asDocument(html), theme), name, key);

// What a page is called in a list: its <title>, else its first heading, else its first words.
export function pageTitle(html: string) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
  return t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
// A page's text, for a one-line lead: no tags, scripts, styles or title (the list shows that already).
export const pageText = (html: string) => secrets.mask(html).replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
