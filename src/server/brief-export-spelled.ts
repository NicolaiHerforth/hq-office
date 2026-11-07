// BRIEF EXPORT: a secret as an honest page writes it. A value holding & < > " ' is correctly written FAKE&amp;sec&lt;ret in
// a page and FAKE%26sec%3Cret in an address. A browser reads the value, but the shared mask looks for it literally and finds
// nothing. So the source is read the way a browser reads it, and the source span that spells a held value is replaced.
// What it knows: numeric references, Windows-1252's 128-159 among them; the named references for one printable ASCII
// character; encodeURIComponent's and encodeURI's forms, in either case of hex. Not CSS escapes, a value split by a tag,
// &fjlig; or any other name for several characters, a name for a character outside ASCII, JS escapes or base64.
//
// It runs on every panel open, in the server the question panel depends on, so its cost follows the source's length: a page
// with no reference a value could hold costs one search for &, and only the text around those references is ever decoded.
// Pure.
const NAMED = new Map(Object.entries({
  amp: "&", AMP: "&", lt: "<", LT: "<", gt: ">", GT: ">", quot: '"', QUOT: '"', apos: "'",
  Tab: "\t", NewLine: "\n", nbsp: " ", excl: "!", num: "#", dollar: "$", percnt: "%", lpar: "(", rpar: ")", ast: "*", midast: "*", plus: "+", comma: ",", period: ".", sol: "/",
  colon: ":", semi: ";", equals: "=", quest: "?", commat: "@", lsqb: "[", lbrack: "[", bsol: "\\", rsqb: "]", rbrack: "]", Hat: "^", lowbar: "_", UnderBar: "_", grave: "`", DiacriticalGrave: "`",
  lcub: "{", lbrace: "{", verbar: "|", vert: "|", VerticalLine: "|", rcub: "}", rbrace: "}",
}));
// These few also count with no semicolon, as browsers read them.
const NO_SEMICOLON = ["quot", "QUOT", "amp", "AMP", "lt", "LT", "gt", "GT"];
const LONGEST_NAME = 32;
// What a browser makes of references 128 to 159.
const WINDOWS_1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

const digit = (c: number) => (c >= 48 && c <= 57 ? c - 48 : -1);
const hexDigit = (c: number) => {
  const lower = c | 32;
  return lower >= 97 && lower <= 102 ? lower - 87 : digit(c);
};
const alphanumeric = (c: number) => digit(c) >= 0 || ((c | 32) >= 97 && (c | 32) <= 122);
function fromCode(code: number) {
  if (code >= 0x80 && code <= 0x9f) return String.fromCharCode(WINDOWS_1252[code - 0x80]);
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
}

// The character reference at an &: what it reads as and where it ends, or null if it is none. In an attribute, a name with
// no semicolon followed by = or a letter or digit is not one: ?a=1&lt=3 is a query. The answer is one object, used again: a
// page can hold tens of millions of these.
const found = { text: "", end: 0 };
const reference = (text: string, end: number) => { found.text = text; found.end = end; return found; };
function referenceAt(s: string, at: number, attribute: boolean) {
  let i = at + 1;
  if (s.charCodeAt(i) === 35) {
    const hex = (s.charCodeAt(++i) | 32) === 120;
    if (hex) i++;
    const from = i, base = hex ? 16 : 10, value = hex ? hexDigit : digit;
    let code = 0;
    for (let d = value(s.charCodeAt(i)); d >= 0; d = value(s.charCodeAt(++i))) if (code <= 0x10ffff) code = code * base + d;
    if (i === from) return null;
    return reference(fromCode(code), s.charCodeAt(i) === 59 ? i + 1 : i);
  }
  let stop = i;
  while (stop - i < LONGEST_NAME && alphanumeric(s.charCodeAt(stop))) stop++;
  if (stop === i) return null;
  const name = s.slice(i, stop), whole = s.charCodeAt(stop) === 59 ? NAMED.get(name) : undefined;
  if (whole !== undefined) return reference(whole, stop + 1);
  const short = NO_SEMICOLON.find((n) => name.startsWith(n));
  if (!short) return null;
  const end = i + short.length, next = s.charCodeAt(end);
  return attribute && (next === 61 || alphanumeric(next)) ? null : reference(NAMED.get(short)!, end);
}

// An attribute as a browser reads it: the rewriter gives it as written, references and all.
export function decodedAttribute(text: string) {
  const parts: string[] = [];
  let done = 0;
  for (let at = text.indexOf("&"); at >= 0; at = text.indexOf("&", Math.max(at + 1, done))) {
    const r = referenceAt(text, at, true);
    if (!r) continue;
    parts.push(text.slice(done, at), r.text);
    done = r.end;
  }
  return done ? parts.join("") + text.slice(done) : text;
}

const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
function forms(value: string) {
  try {
    const part = encodeURIComponent(value), whole = encodeURI(value);
    return [...new Set([value, part, lowerHex(part), whole, lowerHex(whole)])];
  } catch {
    return [value]; // half of a surrogate pair: no address can hold it
  }
}

type Form = { text: string; mask: string };

// One stretch of the source with the references that could be part of a value in it. Decoded into typed arrays: the
// character, and where in the source it came from. Each span found is marked at its start and over its length, so a shorter
// value never takes what a longer one holds, and the new text is built in one pass. Returns what to keep of the source
// up to the end of the stretch, added to parts.
const INSIDE = 0xffff;
function maskStretch(s: string, from: number, to: number, starts: Int32Array, ends: Int32Array, first: number, last: number, all: Form[], parts: string[], done: number) {
  const chars = new Uint16Array(to - from), at = new Int32Array(to - from + 1);
  let n = 0, i = from;
  const plain = (end: number) => { for (; i < end; i++) { chars[n] = s.charCodeAt(i); at[n++] = i; } };
  for (let k = first; k <= last; k++) {
    plain(starts[k]);
    const { text } = referenceAt(s, starts[k], false)!;
    for (let u = 0; u < text.length; u++) { chars[n] = text.charCodeAt(u); at[n++] = starts[k]; }
    i = ends[k];
  }
  plain(to);
  at[n] = to;
  const text = Buffer.from(chars.buffer, 0, n * 2).toString("utf16le");
  let marks: Uint16Array | null = null;
  all.forEach((form, index) => {
    const length = form.text.length;
    for (let m = text.indexOf(form.text); m >= 0;) {
      marks ??= new Uint16Array(n);
      if (marks[m] || marks[m + length - 1]) { m = text.indexOf(form.text, m + 1); continue; }
      marks[m] = index + 1;
      marks.fill(INSIDE, m + 1, m + length);
      m = text.indexOf(form.text, m + length);
    }
  });
  if (!marks) return done;
  const marked = marks as Uint16Array;
  for (let m = 0; m < n;) {
    const mark = marked[m];
    if (!mark || mark === INSIDE) { m++; continue; }
    const form = all[mark - 1];
    if (at[m] > done) parts.push(s.slice(done, at[m]));
    parts.push(form.mask);
    done = at[m + form.text.length];
    m += form.text.length;
  }
  return done;
}

// The spans that spell a form through a reference. What holds no reference is left for the plain search after this.
function maskReferences(source: string, all: Form[]) {
  const wanted = new Uint8Array(65536);
  for (const { text } of all) for (let i = 0; i < text.length; i++) wanted[text.charCodeAt(i)] = 1;
  // The references that could be part of a value: one whose character no value holds cannot.
  let starts = new Int32Array(256), ends = new Int32Array(256), count = 0;
  for (let at = source.indexOf("&"); at >= 0;) {
    const r = referenceAt(source, at, false);
    if (r && wanted[r.text.charCodeAt(0)]) {
      if (count === starts.length) {
        const more = (a: Int32Array) => { const b = new Int32Array(a.length * 2); b.set(a); return b; };
        starts = more(starts);
        ends = more(ends);
      }
      starts[count] = at;
      ends[count++] = r.end;
    }
    at = source.indexOf("&", r ? r.end : at + 1);
  }
  if (!count) return source;
  // A value that holds a reference lies within a value's length of it, so references further apart than that are read apart.
  const reach = all[0].text.length - 1, parts: string[] = [];
  let done = 0;
  for (let first = 0, last = 0; first < count; first = ++last) {
    while (last + 1 < count && starts[last + 1] - ends[last] <= 2 * reach) last++;
    done = maskStretch(source, Math.max(0, starts[first] - reach), Math.min(source.length, ends[last] + reach), starts, ends, first, last, all, parts, done);
  }
  if (!parts.length) return source;
  parts.push(source.slice(done));
  return parts.join("");
}

// Each held value's spellings replaced by [secret NAME], longest first, as the shared mask does, and through references
// first, so a shorter value written plainly cannot cut through a longer one written with them. A value under 4 characters
// is left alone, as it is there.
export function maskSpelled(source: string, held: { name: string; value: string }[]) {
  const all = held.filter((e) => e.value.length >= 4)
    .flatMap((e) => forms(e.value).map((text) => ({ text, mask: `[secret ${e.name}]` })))
    .sort((a, b) => b.text.length - a.text.length);
  if (!all.length) return source;
  let out = maskReferences(source, all);
  for (const { text, mask } of all) if (out.includes(text)) out = out.replaceAll(text, () => mask);
  return out;
}
