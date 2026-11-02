// ASK PAGES: an ask (a question or a to-do) may carry an HTML page, as a brief can (pages.ts: a whole document or an
// artifact-style fragment). hud ask --file q.html gives it, hud update ID --file replaces it. The HUD shows it in the
// question's card and on the stage at #page/asks/ID, served from /asks/ID.html like any other page (sandboxed, with the
// page runtime under the key asks/ID, in the reader's theme, secrets masked). The page cannot answer: answering stays
// the HUD's own buttons. What the owner does in it is read back with hud page data asks/ID.
import { db } from "./db.ts";
import { secrets } from "./push.ts";
import { addStatePart } from "./state.ts";
import { isPage, pageText, pageTitle, servePage } from "./pages.ts";

const MAX_PAGE = 5_000_000; // as a brief that is a page

// What an ask's fields say: { page, body }. A --file that is a page is the page, any other is the body (markdown); a
// body that is a page is the page too, by the same rule as a brief. Markdown asks come out as they went in.
export function pageOfFields(fields: { body?: unknown; file?: unknown }) {
  let body = fields.body === undefined || fields.body === null ? undefined : String(fields.body);
  let page: string | undefined;
  if (body !== undefined && isPage(body)) [page, body] = [body, undefined];
  if (fields.file !== undefined && fields.file !== null) {
    const file = String(fields.file);
    if (isPage(file)) {
      if (page !== undefined) throw new Error("give the page once: --file or --body, not both");
      page = file;
    } else {
      if (body !== undefined) throw new Error("--file is markdown here: give it or --body, not both (an HTML page starts with <!doctype html>, <html>, or <title>/<style>/<script> as a fragment)");
      body = file;
    }
  }
  if (page !== undefined && page.length > MAX_PAGE) throw new Error("an ask's page is at most 5 MB");
  return { page: page?.replace(/\s+$/, ""), body };
}

// Masked before it is kept: a secret value never reaches hud.db.
export function setAskPage(id: number, html: string) {
  const page = secrets.mask(html);
  db.query("INSERT INTO ask_pages (ask_id, html, at, title, lead) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ask_id) DO UPDATE SET html = excluded.html, at = excluded.at, title = excluded.title, lead = excluded.lead").run(
    id,
    page,
    Date.now(),
    pageTitle(page).slice(0, 200),
    pageText(page).slice(0, 240),
  );
}
export const hasAskPage = (id: number) => !!db.query("SELECT 1 FROM ask_pages WHERE ask_id = ?").get(id);
// The floor an ask is on (hud page data asks/ID: an agent reads its own floor's only, unless --all), or null.
export const askFloor = (id: number) => (db.query("SELECT floor FROM asks WHERE id = ?").get(id) as { floor: string | null } | null)?.floor ?? null;
// The page's key for the runtime and hud page data.
export const askPageKey = (id: number) => `asks/${id}`;

// Tells the HUD how tall the page is, so a card's frame is no taller than the page (the card caps it). Only a number
// goes out; the HUD takes it from its own ask frames and nothing else. Only once the size has held for 120 ms, and never
// 0 (a page not laid out yet): each step would move the answer row under the owner's pointer.
const REPORT_HEIGHT = `<script>(()=>{if(parent===window)return;let last=0,t=0;const say=()=>{clearTimeout(t);t=setTimeout(()=>{const h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h&&h!==last){last=h;parent.postMessage({"hud-ask-height":h},"*");}},120);};new ResizeObserver(say).observe(document.documentElement);addEventListener("load",say);})();</script>`;

export function serveAskPage(id: number, theme?: string | null) {
  const row = db.query("SELECT html FROM ask_pages WHERE ask_id = ?").get(id) as { html: string } | null;
  return row ? servePage(row.html + REPORT_HEIGHT, `ask-${id}.html`, theme, askPageKey(id)) : null;
}

// S.askPages[id]: { at, title, lead } for the asks the page shows (open, and answered in the last day as MESSAGES
// lists them). Never the page itself.
addStatePart("askPages", () => {
  const out: Record<number, { at: number; title: string; lead: string }> = {};
  const rows = db.query("SELECT p.ask_id, p.at, p.title, p.lead FROM ask_pages p JOIN asks a ON a.id = p.ask_id WHERE a.status = 'open' OR COALESCE(a.answered_at, a.created_at) >= ?").all(Date.now() - 24 * 3600_000) as { ask_id: number; at: number; title: string; lead: string }[];
  for (const r of rows) out[r.ask_id] = { at: r.at, title: r.title, lead: r.lead };
  return out;
});
