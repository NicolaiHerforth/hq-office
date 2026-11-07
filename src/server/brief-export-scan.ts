// BRIEF EXPORT's look for keys: masking only knows values the HUD holds right now, so a key it never held, or holds no
// longer, would go out as written. This finds what looks like one, to warn the owner before the file is made: a few known
// shapes and any long, random-looking string. It rewrites nothing and refuses nothing. It will miss keys and will flag
// things that are not keys. Pure.
const SHAPES = [
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_\w{16,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];
const LONG = /[A-Za-z0-9+=_-]{32,}/g;
// A picture in the file, and the real hash of a script, are long and random and are not keys.
const NOT_KEYS = /data:[\w/+.-]+(?:;[\w=-]+)*;base64,[A-Za-z0-9+/=]+|\bintegrity\s*=\s*["']\s*(?:sha(?:256|384|512)-[A-Za-z0-9+/=]+\s*)+["']/gi;

function entropy(text: string) {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}
// Letters and digits mixed, unpredictable, and in one long run: a sentence-like slug or a UUID's short groups are not.
const randomLooking = (text: string) => /[A-Za-z]/.test(text) && /\d/.test(text) && entropy(text) >= 3.5 && text.split(/[-_]/).some((part) => part.length >= 20);

// A hit as it may be shown: enough to find it in the text, never the whole of it.
function shortened(hit: string) {
  const bearer = hit.match(/^(Bearer\s+)(.*)$/);
  const token = bearer ? bearer[2] : hit;
  return `${bearer ? "Bearer " : ""}${token.slice(0, 4)}…${token.slice(-2)}`;
}

// What looks like a key in this text, each shortened, once.
export function looksLikeKeys(text: string) {
  let plain = text.replace(NOT_KEYS, " ");
  const hits = new Set<string>();
  for (const shape of SHAPES) plain = plain.replace(shape, (hit) => { hits.add(hit); return " "; });
  for (const [hit] of plain.matchAll(LONG)) if (randomLooking(hit)) hits.add(hit);
  return [...new Set([...hits].map(shortened))];
}
