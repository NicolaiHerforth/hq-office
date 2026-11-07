// A markdown heading line, read by hand: a search for what ends it tries every way to share out a run of spaces and
// hashes, which a short line can make last for ever. Pure: core/markdown.js and embeds/model.js (on the server too).
const OPENING = /^\s{0,3}(#{1,6})\s+/;
// A heading is one line: inside its text these end it, so it is not a heading after all.
const LINE_END = /[\n\r\u2028\u2029]/;

// { level, text } for a heading (no closing hashes, no space around), else null.
export function headingOf(line) {
  const m = OPENING.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length).trimEnd();
  let end = rest.length;
  while (end > 0 && rest[end - 1] === "#") end--;
  const text = rest.slice(0, end).trimEnd();
  return LINE_END.test(text) ? null : { level: m[1].length, text };
}
