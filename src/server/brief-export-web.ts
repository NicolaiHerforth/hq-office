// BRIEF EXPORT: a page's script or stylesheet on the web, fetched so the file still works with no internet. Only when the
// owner asks for a file, never to look at one. A page names these, and a page is written by an agent, so every hop passes
// the guard, the size is capped, a hash the page gave must match, and no cookie or credential is sent. What cannot be
// fetched says why, for the panel.
//
// The guard looks a name up, and the fetch looks it up again, so a name can answer public to one and internal to the other
// (DNS rebinding). What stops that here is the certificate check on https, which test/server/brief-export-web.test.ts
// proves on Bun's fetch: an internal service cannot show a valid certificate for the page's name, so the fetch fails and
// nothing it serves is read. It does not stop the connection itself, so an internal address and port can still be
// touched, and how fast that fails can be measured by whoever runs the name. It does not cover an internal service that
// holds a valid certificate for that very name, and it is off if this process runs with NODE_TLS_REJECT_UNAUTHORIZED=0.
export const NOT_PUBLIC = "it is not at a public https address";
export type Fetched = { text: string } | { why: string };
export type Allowed = (url: string) => Promise<boolean>;
// What one export has left to spend, across all its fetches.
export type Spend = { left: number };
type Options = { get?: typeof fetch; spend?: Spend; deadline?: AbortSignal };

// The most library text one export can hold. One fetch at a time, so this is the whole of it.
export const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024, TIME_MS = 8000, MAX_HOPS = 3;
const SRI = /^(sha256|sha384|sha512)-(.+)$/;

// Whether the bytes match the strongest hash in an integrity attribute. A browser would refuse the file if they did not.
function matches(bytes: Uint8Array, integrity: string | null) {
  const parts = (integrity ?? "").trim().split(/\s+/).map((p) => p.match(SRI)).filter(Boolean) as RegExpMatchArray[];
  if (!parts.length) return true;
  const best = parts.reduce((a, b) => (Number(b[1].slice(3)) > Number(a[1].slice(3)) ? b : a));
  return parts.filter((p) => p[1] === best[1]).some((p) => new Bun.CryptoHasher(p[1] as "sha256").update(bytes).digest("base64") === p[2].split("?")[0]);
}

export async function fetchLibrary(url: string, integrity: string | null, allowed: Allowed, { get = fetch, spend = { left: MAX_LIBRARY_BYTES }, deadline }: Options = {}): Promise<Fetched> {
  const signal = deadline ? AbortSignal.any([AbortSignal.timeout(TIME_MS), deadline]) : AbortSignal.timeout(TIME_MS);
  try {
    let at = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!/^https:/i.test(at) || !(await allowed(at))) return { why: NOT_PUBLIC };
      const res = await get(at, { redirect: "manual", signal, credentials: "omit", referrerPolicy: "no-referrer" } as RequestInit);
      const to = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && to) {
        at = new URL(to, at).href;
        continue;
      }
      if (!res.ok || !res.body) return { why: `its server answered ${res.status}` };
      // A sign-in page on a 200 would go in the file as the script.
      if (/text\/html|xhtml/i.test(res.headers.get("content-type") ?? "")) return { why: "its server answered with a web page, not a library" };
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > MAX_BYTES) return { why: "it is too large" };
        if (size > spend.left) return { why: "the page's libraries together are too large" };
        parts.push(part);
      }
      const bytes = Buffer.concat(parts);
      if (!matches(bytes, integrity)) return { why: "it does not match the hash the page gives for it" };
      spend.left -= size;
      return { text: new TextDecoder().decode(bytes) };
    }
    return { why: "it redirects too many times" };
  } catch {
    return { why: "it could not be reached just now" };
  }
}
