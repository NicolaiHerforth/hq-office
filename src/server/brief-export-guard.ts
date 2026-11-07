// BRIEF EXPORT's guard: whether an address on the web may be reached while a file is made, by the printing Chrome's proxy
// (brief-export-print-proxy.ts) or by the server fetching a page's library (brief-export.ts). A page is written by an
// agent, so what it names is not trusted: only https on a public host, by name and by what the name resolves to. An
// address is public only if it is in the table here: what is not known to be public is refused. Node's built-ins only:
// the helper runs this with nothing else of the server loaded.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname } from "node:os";

// Names that never mean the public web. Address rules are never run on a name: fd.example.com is a name.
const PRIVATE_NAME = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|ts\.net|home\.arpa|test|invalid)$/i;

// IPv4 special-use blocks: [first octets as a number, prefix length].
const V4_NOT_PUBLIC: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4Number = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
function publicV4(ip: string) {
  const n = v4Number(ip);
  return !V4_NOT_PUBLIC.some(([block, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(block) / 2 ** (32 - bits)));
}
// Eight groups as numbers, whatever way it is written (:: and a dotted tail).
function v6Groups(ip: string) {
  const [text] = ip.split("%");
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  const plain = dotted ? `${dotted[1]}${(v4Number(dotted[2]) >>> 16).toString(16)}:${(v4Number(dotted[2]) & 0xffff).toString(16)}` : text;
  const [head, tail] = plain.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const left = groups(head), right = groups(tail);
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
// Global unicast is 2000::/3, and so this also refuses mapped (::ffff:0:0/96), compatible (::/96) and NAT64 (64:ff9b::/96)
// forms, which are outside it. Within it: 6to4 carries an IPv4 address inside, 2001::/23 is the IETF's own (Teredo,
// benchmarking, ORCHID and the rest), and 2001:db8::/32 and 3fff::/20 are for documents. 2620:4f:8000::/48 is AS112's, where
// the reverse look-ups of private addresses go.
const V6_NOT_PUBLIC: [number, number, number][] = [[0x2002, 0, 16], [0x2001, 0, 23], [0x2001, 0x0db8, 32], [0x3fff, 0, 20]];
function publicV6(ip: string) {
  const [a, b, c] = v6Groups(ip);
  if (a < 0x2000 || a > 0x3fff || (a === 0x2620 && b === 0x4f && c === 0x8000)) return false;
  const start = a * 65536 + b;
  return !V6_NOT_PUBLIC.some(([x, y, bits]) => Math.floor(start / 2 ** (32 - bits)) === Math.floor((x * 65536 + y) / 2 ** (32 - bits)));
}
export function publicAddress(ip: string) {
  const family = isIP(ip);
  return family === 4 ? publicV4(ip) : family === 6 ? publicV6(ip) : false;
}

// A host as the URL parser leaves it: no brackets, no trailing dot, lower case.
export const plainHost = (host: string) => {
  let to = host.length;
  while (host[to - 1] === "." || host[to - 1] === "]") to--;
  return host.slice(host[0] === "[" ? 1 : 0, to).toLowerCase();
};

// Whether a host is plainly not the public web, with no look-up: for an address, the table; for a name, what it is called.
export function plainlyPrivate(rawHost: string, trusted: string[] = []) {
  const host = plainHost(rawHost);
  if (trusted.some((t) => plainHost(t) === host)) return true;
  if (isIP(host)) return !publicAddress(host);
  return !host.includes(".") || PRIVATE_NAME.test(host) || host === hostname().toLowerCase();
}

// What a host may be reached at: a list of checked addresses, an empty list for a name that does not resolve, or null
// when it is refused. Every address a name gives must be public: one that also answers privately is not trusted.
export async function publicAddresses(rawHost: string, trusted: string[]): Promise<string[] | null> {
  const host = plainHost(rawHost);
  if (plainlyPrivate(host, trusted)) return null;
  if (isIP(host)) return [host];
  return Promise.race([
    lookup(host, { all: true }).then((all) => (all.every((a) => publicAddress(a.address)) ? all.map((a) => a.address) : null), () => []),
    Bun.sleep(5000).then(() => null),
  ]);
}

// Whether a URL may be fetched: https on a public host. The answer for a host is kept as long as the guard is. A name that
// does not resolve goes on to fail where it is used, which then says it was not reached.
export function guard(trusted: string[]) {
  const hosts = new Map<string, Promise<boolean>>();
  return async (raw: string) => {
    try {
      const u = new URL(raw);
      if (u.protocol === "data:" || u.protocol === "blob:") return true;
      if (u.protocol !== "https:") return false;
      const host = plainHost(u.hostname);
      if (!hosts.has(host)) hosts.set(host, publicAddresses(host, trusted).then((a) => a !== null));
      return await hosts.get(host)!;
    } catch {
      return false;
    }
  };
}
