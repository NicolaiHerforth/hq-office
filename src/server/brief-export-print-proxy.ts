// The only way out for the printing Chrome (brief-export-print-helper.ts starts it with this as its proxy, loopback
// included, with QUIC off, WebRTC's UDP off and its own name lookups off). The Fetch domain sees one page's requests and
// no others: not a frame or worker of its own, not WebRTC. Every connection reaches this instead, and this decides:
//   CONNECT to port 443 of a public host: resolved once, checked, and only those checked addresses are dialled, so a name
//   cannot answer one way to the check and another to the connection;
//   a plain http request: only the print's own document, once, then closed. Nothing else on the HUD's port;
//   Chrome's own services: refused, and never named, since the page did not ask;
//   anything else: refused, and named.
// Node's built-ins only, plus the guard.
import { connect, createServer, type Socket } from "node:net";
import { publicAddresses, plainHost } from "./brief-export-guard.ts";

const HEAD_LIMIT = 16 * 1024, HEAD_MS = 10_000, DIAL_MS = 5000, MAX_DIALS = 3, MAX_OPEN = 256, MAX_SEEN = 200;
// The services a Chrome may call whatever the helper's flags say, and a page has no use for.
const CHROMES_OWN = /^(?:content-autofill\.googleapis\.com|update\.googleapis\.com|clients\d*\.google\.com|edgedl\.me\.gvt1\.com|redirector\.gvt1\.com|optimizationguide-pa\.googleapis\.com|safebrowsing\.googleapis\.com|accounts\.google\.com)$/;
const BAD_GATEWAY = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

type Options = {
  printUrl: string;
  trusted: string[];
  // For a test: what a host resolves to, and how to dial it.
  addressesOf?: (host: string) => Promise<string[] | null>;
  dial?: (address: string, port: number) => Socket;
};

export function startProxy({ printUrl, trusted, addressesOf = (host) => publicAddresses(host, trusted), dial = (address, port) => connect(port, address) }: Options) {
  const refused = new Set<string>(), seen: string[] = [], hosts = new Map<string, Promise<string[] | null>>(), open = new Set<Socket>();
  let served = false;
  // name: as the URL parser spells a host, brackets and a port that is not the default, so one host reads the same everywhere.
  const refuse = (client: Socket, name: string, own = false) => {
    if (!own) refused.add(name);
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  };
  const track = (s: Socket) => {
    open.add(s);
    s.on("close", () => open.delete(s));
    s.on("error", () => s.destroy());
    return s;
  };
  // No path or query: this is kept, and a print's address holds its token.
  const hostIn = (target: string) => { try { return new URL(target).host; } catch { return target.slice(0, 60); } };
  const joined = (a: Socket, b: Socket) => {
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
    a.pipe(b);
    b.pipe(a);
  };

  async function tunnel(client: Socket, target: string, rest: Buffer) {
    const m = target.match(/^(\[[^\]]*\]|[^:]+):(\d+)$/);
    let u: URL | null = null;
    // As the URL parser reads it: 0177.0.0.1 is 127.0.0.1. What it reads as anything more than a host is not one.
    try { u = new URL(`https://${m?.[1]}`); } catch {}
    if (!m || !u || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return refuse(client, target.slice(0, 60));
    const host = plainHost(u.hostname);
    if (CHROMES_OWN.test(host)) return refuse(client, host, true);
    if (m[2] !== "443") return refuse(client, `${u.hostname}:${m[2]}`);
    if (!hosts.has(host)) hosts.set(host, addressesOf(host));
    const addresses = await hosts.get(host)!;
    if (addresses === null) return refuse(client, u.hostname);
    // A name that does not resolve was not refused for what it is: it is simply not there, and Chrome says so.
    const tryNext = (i: number) => {
      if (client.destroyed) return;
      if (i >= Math.min(addresses.length, MAX_DIALS)) { client.end(BAD_GATEWAY); return; }
      const remote = track(dial(addresses[i], 443));
      let gaveUp = false;
      const giveUp = () => {
        if (gaveUp) return;
        gaveUp = true;
        remote.destroy();
        tryNext(i + 1);
      };
      remote.setTimeout(DIAL_MS, giveUp);
      remote.once("error", giveUp);
      remote.once("connect", () => {
        if (gaveUp) return;
        gaveUp = true;
        remote.setTimeout(0);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) remote.write(rest);
        joined(client, remote);
      });
    };
    tryNext(0);
  }

  function theDocument(client: Socket) {
    const u = new URL(printUrl);
    const server = track(connect(Number(u.port), plainHost(u.hostname)));
    server.once("error", () => client.destroy());
    server.once("connect", () => {
      server.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: text/html\r\nConnection: close\r\n\r\n`);
      server.pipe(client);
    });
  }

  const listener = createServer((raw) => {
    if (open.size >= MAX_OPEN) { raw.destroy(); return; }
    const client = track(raw);
    let head = Buffer.alloc(0);
    client.setTimeout(HEAD_MS, () => client.destroy());
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > HEAD_LIMIT) client.destroy();
        return;
      }
      client.off("data", onData);
      client.setTimeout(0);
      const [method = "", target = ""] = head.subarray(0, head.indexOf("\r\n")).toString("latin1").split(" ");
      if (seen.length < MAX_SEEN) seen.push(`${method} ${method === "CONNECT" ? target : hostIn(target)}`.slice(0, 80));
      if (method === "CONNECT") { tunnel(client, target, head.subarray(end + 4)).catch(() => client.destroy()); return; }
      if (method === "GET" && target === printUrl && !served) { served = true; theDocument(client); return; }
      refuse(client, hostIn(target), CHROMES_OWN.test(hostIn(target)));
    };
    client.on("data", onData);
  });

  return new Promise<{ port: number; refused: Set<string>; seen: string[]; close: () => void }>((ok, no) => {
    listener.once("error", no);
    listener.listen(0, "127.0.0.1", () => ok({
      port: (listener.address() as { port: number }).port,
      refused,
      seen,
      close() {
        listener.close();
        for (const s of open) s.destroy();
      },
    }));
  });
}
