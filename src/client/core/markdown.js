// The one renderer for text that HQ or a lane wrote: md() for blocks, mdInline() for one-line places, mdClip() for
// long text with MORE/LESS, and COPY on code boxes. Everything is escaped first; the only tags are the ones made
// here, and a link goes only to http(s), mailto, this HUD's own /uploads/, /room-files/ and /rooms/ paths, or a place
// on this page: an HQ thing's reference (core/refs.js: #brief/ID, #room/SLUG, #lane/NAME, #ask/ID, #floor/ID, a page).
// A bare reference is a link too, and a paragraph that is only one (bare or [label](#ref)) comes out as
// <p class="hudref">, which embeds/ draws as a card of that thing.
//
// Blocks: paragraphs (a line break shows), headings, bullet, numbered and task lists (nested by indent), quotes,
// rules, tables and ``` fences (a code box with COPY, verbatim). Inline: `code`, **bold**, *italic*, ~~struck~~,
// [text](url), bare and <angle> URLs (long ones shortened), #1234 as a PR when a GitHub repo is set, and
// [image: PATH] as a thumbnail of an attached image, [file: PATH] as a link named after an attached file.
import { esc } from "./format.js";
import { CONFIG } from "./state.js";
import { REF_SOURCE } from "./refs.js";
import { headingOf } from "./heading.js";

const unesc = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
// An attached image's address on this HUD: from a room's folder (rooms/SLUG/files/NAME), an old shelf file
// (room-files/), or the general uploads/. Only the file's name is kept from anything else.
function imageUrl(escaped) {
  const p = unesc(escaped), f = p.split("/").pop();
  const room = p.match(/\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/files\/([^/]+)$/);
  if (room) return `/rooms/${room[1]}/files/${encodeURIComponent(room[2])}`;
  return `/${/\/room-files\/[^/]+$/.test(p) ? "room-files" : "uploads"}/${encodeURIComponent(f)}`;
}
// An attached file's address on this HUD and its name, or null: only a file straight inside the general uploads/ or
// a room's files/, named by an absolute path on this machine that never climbs (anything else stays text).
function fileRef(escaped) {
  const p = unesc(escaped);
  if (!p.startsWith("/") || /(^|\/)\.\.(\/|$)|\\|\u0000/.test(p)) return null;
  const room = p.match(/\/rooms\/([a-z0-9][a-z0-9-]{0,47})\/files\/([^/]+)$/), up = p.match(/\/uploads\/([^/]+)$/);
  const name = room?.[2] ?? up?.[1];
  if (!name || name.startsWith(".")) return null;
  return { name, url: room ? `/rooms/${room[1]}/files/${encodeURIComponent(name)}` : `/uploads/${encodeURIComponent(name)}` };
}
// A link's target, as escaped text: http(s), mailto, a path on this HUD that does not climb out of it, or a place on
// this page (an HQ thing's reference), which opens here rather than in a new tab.
const IN_PAGE = new RegExp(`^#${REF_SOURCE}$`, "i");
// A bare reference in running text; the sentence keeps its trailing punctuation.
const BARE_REF = new RegExp(`(^|[\\s(])(#${REF_SOURCE})`, "g");
// A paragraph that is only a reference: bare, or [label](#ref).
const REF_LINE = new RegExp(`^(?:#${REF_SOURCE}|\\[[^\\]\\n]+\\]\\(#${REF_SOURCE}\\))$`);
// Never one with a held token in it: that token's HTML would land inside the href.
const safeUrl = (u) => !u.includes("\u0000") && (/^(?:https?:\/\/[^\s/]|mailto:[^\s/])/i.test(u) || (/^\/(?:uploads|room-files|rooms)\//.test(u) && !/\.\.|\\/.test(u)) || IN_PAGE.test(u));
const anchor = (href, label) => (IN_PAGE.test(href) ? `<a href="${href}">${label}</a>` : `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`);
const shorten = (u) => { const t = unesc(u); return esc(t.length > 60 ? t.slice(0, 57) + "…" : t); };
// FN on T up to the last CH, the rest as it is: for a token that ends in CH, which past that has no end to find, so a
// line full of them is not read to its end once per token.
const upToLast = (t, ch, fn) => {
  const end = t.lastIndexOf(ch) + 1;
  return fn(t.slice(0, end)) + t.slice(end);
};
// `code`: a run of backticks opens, and the next run of just its length closes. A start inside a run is a shorter
// opener, so the longest of a run's lengths that a later run closes wins, and any leftover backticks stay text.
function codeSpans(line, make) {
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, n: m[0].length }));
  const ofLength = new Map(); // length: the runs of it, nearest last
  for (let r = runs.length - 1; r >= 0; r--) {
    if (!ofLength.has(runs[r].n)) ofLength.set(runs[r].n, []);
    ofLength.get(runs[r].n).push(r);
  }
  let out = "", from = 0;
  for (let r = 0; r < runs.length; r++) {
    const { at, n } = runs[r], end = at + n;
    for (let len = n; len > 0; len--) {
      const later = ofLength.get(len);
      while (later?.length && later.at(-1) <= r) later.pop();
      if (!later?.length) continue;
      const close = later.at(-1);
      out += line.slice(from, end - len) + make(line.slice(end, runs[close].at));
      from = runs[close].at + len;
      r = close;
      break;
    }
  }
  return out + line.slice(from);
}
// [text](url): every [ up to the first ] meets that same ], so one try settles them all; the end of the url is kept
// between tries for the same reason. MAKE gets what matched, the text and the url.
function textLinks(t, make) {
  const urlEnd = /[\s)]/g;
  let out = "", from = 0, stop = -1;
  for (let i = t.indexOf("["), close; i >= 0 && (close = t.indexOf("]", i + 1)) >= 0; i = t.indexOf("[", close + 1)) {
    if (close === i + 1 || t[close + 1] !== "(") continue;
    const url = close + 2;
    if (stop < url) {
      urlEnd.lastIndex = url;
      stop = urlEnd.exec(t)?.index ?? t.length;
    }
    if (stop === url || t[stop] !== ")") continue;
    out += t.slice(from, i) + make(t.slice(i, stop + 1), t.slice(i + 1, close), t.slice(url, stop));
    from = stop + 1;
    close = stop;
  }
  return out + t.slice(from);
}

function emphasis(t) {
  return t
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^\w_])__([^_\n]+?)__(?![\w_])/g, "$1<b>$2</b>")
    .replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w_])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\w_])/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
}
// One line of inline markdown. links: false (for text inside a button or a link) keeps link labels as plain text.
// thumbs: false shows an attached image as a link instead of a thumbnail.
function inline(raw, o = {}) {
  const links = o.links !== false, held = [];
  const keep = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let t = esc(String(raw ?? "").replace(/\u0000/g, ""));
  // A code span never crosses a line end, and mdInline's text can still hold one.
  t = t.replace(/[^\n\r\u2028\u2029]+/g, (line) => codeSpans(line, (c) => keep(`<code class="mdc">${c.replace(/^ (.*) $/, "$1")}</code>`)));
  t = upToLast(t, "]", (s) => s.replace(/\[image: ([^\]\n]+?)\]/g, (m, p) => {
    const u = esc(imageUrl(p));
    return keep(!links ? "[image]" : o.thumbs === false ? anchor(u, "[image]") : anchor(u, `<img class="thumb" src="${u}" alt="">`));
  }));
  t = upToLast(t, "]", (s) => s.replace(/\[file: ([^\]\n]+?)\]/g, (m, p) => {
    const f = fileRef(p);
    if (!f) return keep(m); // stays text, as it is: not linked by any rule below
    return keep(links ? `<a class="file" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.name)}</a>` : `[file: ${esc(f.name)}]`);
  }));
  t = textLinks(t, (m, label, url) => (safeUrl(url) ? keep(links ? anchor(url, emphasis(label)) : emphasis(label)) : m));
  t = t.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/gi, (m, u) => (safeUrl(u) ? keep(links ? anchor(u, shorten(u)) : u) : m));
  t = t.replace(/(^|[^\w/])(https?:\/\/[^\s\u0000]+)/g, (m, p, url) => {
    const whole = url.replace(/(&lt;|&gt;|&quot;|&#39;).*$/, "");
    // Trailing punctuation is the sentence's, and so is a closing bracket the URL did not open.
    const opened = (whole.match(/\(/g) || []).length;
    let closed = (whole.match(/\)/g) || []).length, end = whole.length;
    for (;; end--) {
      if (whole[end - 1] === ")" && opened < closed) closed--;
      else if (!".,;:!?*_".includes(whole[end - 1])) break;
    }
    const u = whole.slice(0, end);
    return p + keep(links ? anchor(u, shorten(u)) : u) + url.slice(end);
  });
  t = t.replace(BARE_REF, (m, p, r) => {
    if (r.includes("\u0000")) return m;
    let end = r.length;
    while (end > 0 && ".,;:!?".includes(r[end - 1])) end--;
    const ref = r.slice(0, end);
    return p + keep(links ? anchor(ref, ref) : ref) + r.slice(ref.length);
  });
  if (CONFIG.githubRepo) t = t.replace(/(^|[\s(])#(\d{4,5})\b/g, (m, p, n) => p + keep(links ? anchor(`https://github.com/${esc(CONFIG.githubRepo)}/pull/${n}`, `#${n}`) : `#${n}`));
  t = emphasis(t);
  for (let i = 0; i < 4 && t.includes("\u0000"); i++) t = t.replace(/\u0000(\d+)\u0000/g, (m, n) => held[n]);
  return t;
}
const task = (lines) => {
  const m = lines[0].match(/^\[([ xX])\]\s+(.*)$/);
  const rest = lines.slice(1).map((l) => inline(l));
  if (!m) return [inline(lines[0]), ...rest].join("<br>");
  return `<span class="tick${m[1] === " " ? "" : " on"}">${m[1] === " " ? "" : "✓"}</span>${[inline(m[2]), ...rest].join("<br>")}`;
};

// A lookahead after each greedy run, so a line that fails is not tried again with a shorter one.
const FENCE = /^(\s*)(`{3,}(?!`)|~{3,}(?!~))(.*)$/;
const closes = (line, open) => { const m = line.match(/^\s*(`{3,}|~{3,})\s*$/); return !!m && m[1][0] === open[0] && m[1].length >= open.length; };
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(?!\s)(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const indent = (l) => l.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const dedent = (lines) => {
  const n = lines.reduce((least, l) => (l.trim() ? Math.min(least, indent(l)) : least), Infinity);
  return lines.map((l) => l.replace(/\t/g, "    ").slice(n));
};
// A fence's opening line, if LINE is one (its backticks or tildes), else null.
const fenceOpen = (line) => { const m = line.match(FENCE); return m && !(m[2][0] === "`" && m[3].includes("`")) ? m[2] : null; };

// A list starting at line i: items at its indent, and whatever is indented under an item (a wrapped line, a nested
// list, a code box) belongs to that item.
function list(lines, i, level) {
  const first = lines[i].match(ITEM), base = indent(lines[i]), ordered = /\d/.test(first[2]);
  const items = [];
  while (i < lines.length) {
    const l = lines[i], m = l.match(ITEM);
    if (m && indent(l) <= base + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ head: [m[3]], rest: [] });
      i++;
      continue;
    }
    const cur = items[items.length - 1];
    if (!l.trim()) {
      // A blank line: the list goes on if what follows is indented under the item or is the next item.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const n = lines[j], nm = n?.match(ITEM);
      if (n !== undefined && indent(n) > base + 1) { for (; i < j; i++) cur.rest.push(""); continue; }
      if (nm && indent(n) <= base + 1 && /\d/.test(nm[2]) === ordered) { i = j; continue; }
      break;
    }
    if (indent(l) > base) {
      if (!cur.rest.length && !ITEM.test(l) && !fenceOpen(l)) cur.head.push(l.trim());
      else cur.rest.push(l);
      i++;
      continue;
    }
    break;
  }
  const tag = ordered ? "ol" : "ul", start = ordered ? parseInt(first[2], 10) : 1;
  const html = `<${tag}${start !== 1 ? ` start="${start}"` : ""}>${items.map((it) => `<li>${task(it.head)}${it.rest.length ? blocks(dedent(it.rest), level + 1) : ""}</li>`).join("")}</${tag}>`;
  return [html, i];
}

// How many quote marks LINE starts with, up to MAX, and what follows them.
function quoteMarks(line, max) {
  const mark = /\s{0,3}>\s?/y;
  let n = 0, end = 0;
  while (n < max && mark.test(line)) { n++; end = mark.lastIndex; }
  return [n, line.slice(end)];
}

// Lists and quotes nest this deep. Past it, what is left is its text, escaped: each level copies all it holds, so a body
// nested thousands of levels would stall the page for many seconds and then run out of stack.
const MAX_LEVELS = 30;
function blocks(lines, level = 0) {
  if (level > MAX_LEVELS) return `<p>${esc(lines.join("\n"))}</p>`;
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p${para.length === 1 && REF_LINE.test(para[0]) ? ` class="hudref"` : ""}>${para.map((l) => inline(l)).join("<br>")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    const open = fenceOpen(l);
    let m;
    if (open) {
      flush();
      const pad = indent(l), body = [];
      for (i++; i < lines.length && !closes(lines[i], open); i++) body.push(lines[i].replace(new RegExp(`^ {0,${pad}}`), ""));
      i++;
      out.push(`<div class="codebox"><button class="copy" type="button">COPY</button><pre>${esc(body.join("\n"))}</pre></div>`);
    } else if ((m = headingOf(l))) {
      flush();
      const h = Math.min(m.level, 4) + 2;
      out.push(`<h${h}>${inline(m.text)}</h${h}>`);
      i++;
    } else if (RULE.test(l)) {
      flush();
      out.push("<hr>");
      i++;
    } else if (ITEM.test(l)) {
      flush();
      const [html, next] = list(lines, i, level);
      out.push(html);
      i = next;
    } else if (/^\s{0,3}>/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++]);
      // The marks every line has are quotes straight inside quotes: taken at once, not one recursion per mark.
      let depth = MAX_LEVELS + 1 - level;
      for (const line of q) depth = Math.min(depth, quoteMarks(line, depth)[0]);
      out.push(`${"<blockquote>".repeat(depth)}${blocks(q.map((line) => quoteMarks(line, depth)[1]), level + depth)}${"</blockquote>".repeat(depth)}`);
    } else if (/^\s*\|.*\|\s*$/.test(l) && /^\s*(?:\|\s*)?:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(l), rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<div class="mdtable"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (!l.trim()) {
      flush();
      i++;
    } else {
      para.push(l.trim());
      i++;
    }
  }
  flush();
  return out.join("");
}
const lines = (text) => String(text ?? "").replace(/\r\n?/g, "\n").split("\n");

// Block text: a body, a note, a comment, an answer, a brief, a message.
export function md(text) {
  try {
    return blocks(lines(text));
  } catch (e) {
    // A single line of millions of - marks fills Chrome's stack for the rule search. One body never stops the render
    // around it.
    if (e instanceof RangeError) return `<p>${esc(text)}</p>`;
    throw e;
  }
}
// One-line places (titles, board lines, a room's last message, strip lines): inline markdown only, line breaks as
// spaces. { links: false } inside a button or a link.
export function mdInline(text, o = {}) {
  return inline(String(text ?? "").replace(/\s+/g, (w) => (w.includes("\n") ? " " : w)).trim(), { thumbs: false, ...o });
}
// Text as a code block, verbatim: a fence longer than any run of backticks in it.
export function fence(text) {
  const run = (String(text ?? "").match(/`+/g) ?? []).reduce((most, r) => Math.max(most, r.length), 2);
  const f = "`".repeat(run + 1);
  return `${f}\n${String(text ?? "")}\n${f}`;
}

// Long text shows its first part and MORE. Which ones are open is remembered by key, so re-renders keep it
// (core/clicks.js toggles the key and redraws).
export const expanded = new Set();
// Where to cut TEXT near LIMIT: at a line break late enough, else a space, and never before the end of the last code
// fence: a code box (a command to copy) is never cut or hidden behind MORE. Not inside an inline code, bold or link
// on the last line either.
function cutAt(text, limit) {
  const nl = text.lastIndexOf("\n", limit), sp = text.lastIndexOf(" ", limit);
  let cut = nl > limit * 0.6 ? nl : sp > limit * 0.3 ? sp : limit;
  let pos = 0, open = null, fenceEnd = 0;
  for (const l of text.split("\n")) {
    const end = pos + l.length;
    if (open) { if (closes(l, open)) { fenceEnd = end; open = null; } }
    else open = fenceOpen(l);
    pos = end + 1;
  }
  if (open) return text.length;
  if (fenceEnd >= cut) return fenceEnd;
  const lineStart = text.lastIndexOf("\n", cut - 1) + 1, last = text.slice(lineStart, cut);
  let back = last.length;
  if ((last.match(/`/g) || []).length % 2) back = Math.min(back, last.lastIndexOf("`"));
  if ((last.match(/\*\*/g) || []).length % 2) back = Math.min(back, last.lastIndexOf("**"));
  const link = last.search(/\[[^\]]*$|\[[^\]]*\]\([^)]*$/);
  if (link >= 0) back = Math.min(back, link);
  return back > 0 || lineStart > 0 ? lineStart + back : cut;
}
// Attachment tokens at the end of a message ([image: ...], [file: ...]) never count toward the limit and always show,
// after the cut. Walked back from the end, one token at a time, so a long text is not read through from every start.
function attachedTail(all) {
  let start = all.length, end = all.trimEnd().length;
  while (all[end - 1] === "]") {
    const inner = all.slice(all.lastIndexOf("]", end - 2) + 1, end - 1), line = inner.slice(inner.lastIndexOf("\n") + 1);
    const open = /\[(?:image|file): /.exec(line);
    if (!open || open.index + open[0].length === line.length) break;
    start = end = all.slice(0, end - 1 - line.length + open.index).trimEnd().length;
  }
  return all.slice(start);
}
export function mdClip(text, key, limit = 280) {
  const all = String(text ?? "");
  const tail = attachedTail(all), t = tail ? all.slice(0, -tail.length) : all;
  if (t.length <= limit) return md(all);
  const cut = cutAt(t, limit);
  if (cut >= t.trimEnd().length) return md(all);
  const open = expanded.has(key);
  let shown = t;
  if (!open) {
    shown = t.slice(0, cut).trimEnd();
    // After a closing fence the ellipsis goes on a line of its own, or it would undo the fence.
    shown += /^\s*(`{3,}|~{3,})$/.test(shown.slice(shown.lastIndexOf("\n") + 1)) ? "\n\n…" : "…";
  }
  return `${md(shown + (tail ? ` ${tail.trim()}` : ""))}<button class="more" type="button" data-more="${esc(key)}">${open ? "LESS" : "MORE"}</button>`;
}

export function copyCode(btn) {
  const pre = btn.parentElement.querySelector("pre");
  const done = (ok) => {
    btn.textContent = ok ? "COPIED" : "SELECTED: PRESS CMD-C";
    setTimeout(() => { btn.textContent = "COPY"; }, 1600);
  };
  // Fallback: select the box's text so a plain Cmd-C works.
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { return document.execCommand("copy"); } catch { return false; }
  };
  // The write starts inside the click itself, so the browser allows it.
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(pre.textContent).then(() => done(true), () => done(select()));
  else done(select());
}
