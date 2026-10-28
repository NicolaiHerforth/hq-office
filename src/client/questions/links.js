// The links on a question, as tags for its meta row: the open project its room names (PROJECT opens the project panel,
// ROOM goes to the conference room) and its lane's issue and pull requests. Nothing for a question that names no room (core/floors.js).
import { esc } from "../core/format.js";
import { mdInline } from "../core/markdown.js";
import { askLinks } from "../core/floors.js";
import { CONFIG } from "../core/state.js";

const tag = (cls, href, text) => (href ? `<a class="tag ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : `<span class="tag ${cls}">${esc(text)}</span>`);

// A question's own link, as OPEN LINK, only when it is a web address. The server refuses any other, but a question stored
// before it did may still hold one.
export const openLinkHTML = (ask) => (/^https?:\/\//i.test(String(ask?.link ?? "")) ? `<a class="tag" href="${esc(ask.link)}" target="_blank" rel="noopener">OPEN LINK</a>` : "");

export function linksHTML(S, ask) {
  const { projects, issues, prs } = askLinks(S, CONFIG, ask);
  return projects.map((p) => `<button class="tag project" type="button" data-project="${esc(p.slug)}" title="${esc(p.title)}">PROJECT · ${mdInline(p.title, { links: false })}</button><a class="tag roomlink" href="#room/${esc(p.slug)}">ROOM</a>`).join("")
    + issues.map((i) => tag("key", i.href, i.key)).join("")
    + prs.map((p) => tag("pr", p.href, `#${p.num}`)).join("");
}
