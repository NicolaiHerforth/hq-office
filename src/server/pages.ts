// HTML PAGES: a page a lane writes (a room's .html file on the shelf, a room's brief, or a floor's brief that is a
// whole HTML document) is rendered in the HUD the way a Claude artifact would be, with no account needed. It runs in a
// sandbox: served with a Content-Security-Policy sandbox (no allow-same-origin), so even opened in its own tab its
// scripts run in an opaque origin and cannot read or call the HUD, its data or its storage; the page shows it in an
// iframe sandboxed the same way. Pictures come from this HUD's own files (a room's files/), data: and blob: URLs, or
// https; scripts and styles inline or from https (CDN libraries). It cannot fetch() from the HUD. Every secret value
// the HUD holds is blanked out of the HTML before it is served.
import { secrets } from "./push.ts";

// A whole HTML document: what makes a brief a page rather than markdown.
export const isHtmlDoc = (text: string | null | undefined) => /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(String(text ?? ""));
export const HTML_EXT = /\.html?$/i;

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

export function pageResponse(html: string, name = "page.html") {
  return new Response(secrets.mask(html), {
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

// What a page is called in a list: its <title>, else its first heading, else its first words.
export function pageTitle(html: string) {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "";
  return t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
// A page's text, for a one-line lead: no tags, scripts or styles.
export const pageText = (html: string) => secrets.mask(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
