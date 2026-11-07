// BRIEF EXPORT's proxy, with a raw socket and its seams: what it answers, and what it says it refused. A real Chrome against
// it is in test/client/brief-export-network.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { connect, Socket } from "node:net";
import { startProxy } from "../../src/server/brief-export-print-proxy.ts";

let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
afterEach(() => { proxy?.close(); proxy = null; });
const DOC = "http://127.0.0.1:9/doc";
const ask = (port: number, head: string, ms = 10_000) => new Promise<string>((done) => {
  const s = connect(port, "127.0.0.1");
  let got = "";
  const end = () => { s.destroy(); done(got); };
  s.on("data", (d) => { got += d.toString(); end(); });
  s.on("close", end);
  s.on("error", end);
  s.setTimeout(ms, end);
  s.on("connect", () => s.write(`${head}\r\n\r\n`));
});

describe("what a page did not ask for", () => {
  for (const host of ["update.googleapis.com", "content-autofill.googleapis.com", "clients2.google.com", "edgedl.me.gvt1.com", "optimizationguide-pa.googleapis.com", "accounts.google.com", "UPDATE.GOOGLEAPIS.COM"]) {
    test(`Chrome's own ${host}: refused, and never named`, async () => {
      const dials: string[] = [];
      proxy = await startProxy({ printUrl: DOC, trusted: [], addressesOf: async () => ["8.8.8.8"], dial: (a) => { dials.push(a); return new Socket(); } });
      expect(await ask(proxy.port, `CONNECT ${host}:443 HTTP/1.1`)).toContain("403");
      expect(dials).toEqual([]);
      expect([...proxy.refused]).toEqual([]);
    });
  }
  test("and its plain requests", async () => {
    proxy = await startProxy({ printUrl: DOC, trusted: [] });
    expect(await ask(proxy.port, "GET http://clients2.google.com/time/1/current?cup2key=9 HTTP/1.1")).toContain("403");
    expect(await ask(proxy.port, "POST http://update.googleapis.com/service/update2/json HTTP/1.1")).toContain("403");
    expect([...proxy.refused]).toEqual([]);
  });
  test("a host a page might use is not among them", async () => {
    const dials: string[] = [];
    proxy = await startProxy({ printUrl: DOC, trusted: [], addressesOf: async () => [], dial: (a) => { dials.push(a); return new Socket(); } });
    for (const host of ["www.google.com", "www.gstatic.com", "fonts.googleapis.com"]) expect(await ask(proxy.port, `CONNECT ${host}:443 HTTP/1.1`)).toContain("502");
    expect([...proxy.refused]).toEqual([]);
  });
});

describe("a host, as the URL parser reads it", () => {
  for (const [written, shown] of [["0177.0.0.1", "127.0.0.1"], ["2130706433", "127.0.0.1"], ["0x7f.1", "127.0.0.1"], ["%31%32%37.0.0.1", "127.0.0.1"], ["LOCALHOST", "localhost"], ["[::ffff:7f00:1]", "[::ffff:7f00:1]"], ["[0:0:0:0:0:0:0:1]", "[::1]"]]) {
    test(`${written} is refused, and reads ${shown}`, async () => {
      proxy = await startProxy({ printUrl: DOC, trusted: [] });
      expect(await ask(proxy.port, `CONNECT ${written}:443 HTTP/1.1`)).toContain("403");
      expect([...proxy.refused]).toEqual([shown]);
    });
  }
  test("a port other than 443 keeps the host's brackets, as a URL's host does", async () => {
    proxy = await startProxy({ printUrl: DOC, trusted: [] });
    await ask(proxy.port, "CONNECT [::ffff:7f00:1]:18454 HTTP/1.1");
    expect([...proxy.refused]).toEqual([new URL("https://[::ffff:7f00:1]:18454/").host]);
  });
  for (const written of ["a@example.com", "example.com#x", "example.com?x", "example.com/x", "a b"]) {
    test(`${written} is no host`, async () => {
      const dials: string[] = [];
      proxy = await startProxy({ printUrl: DOC, trusted: [], addressesOf: async () => ["8.8.8.8"], dial: (a) => { dials.push(a); return new Socket(); } });
      expect(await ask(proxy.port, `CONNECT ${written}:443 HTTP/1.1`)).toContain("403");
      expect(dials).toEqual([]);
    });
  }
});

describe("reaching a host", () => {
  test("a host that never answers gets a 502, not silence", async () => {
    proxy = await startProxy({ printUrl: DOC, trusted: [], addressesOf: async () => ["8.8.8.8"], dial: () => new Socket() });
    const started = Date.now();
    expect(await ask(proxy.port, "CONNECT silent.example:443 HTTP/1.1", 9000)).toContain("502");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
  test("a dead first address: the next one is tried", async () => {
    const dials: string[] = [];
    proxy = await startProxy({
      printUrl: DOC,
      trusted: [],
      addressesOf: async () => ["8.8.8.8", "8.8.4.4"],
      dial: (address) => {
        dials.push(address);
        const s = new Socket();
        setTimeout(() => (address === "8.8.8.8" ? s.emit("error", new Error("refused")) : s.emit("connect")), 5);
        return s;
      },
    });
    expect(await ask(proxy.port, "CONNECT two.example:443 HTTP/1.1")).toContain("200 Connection Established");
    expect(dials).toEqual(["8.8.8.8", "8.8.4.4"]);
  });
  test("all dead: a 502, after a few", async () => {
    const dials: string[] = [];
    proxy = await startProxy({
      printUrl: DOC,
      trusted: [],
      addressesOf: async () => ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9"],
      dial: (address) => {
        dials.push(address);
        const s = new Socket();
        setTimeout(() => s.emit("error", new Error("refused")), 5);
        return s;
      },
    });
    expect(await ask(proxy.port, "CONNECT dead.example:443 HTTP/1.1")).toContain("502");
    expect(dials.length).toBe(3);
  });
});

test("connections are capped: past that they are closed, and the ones it holds stay", async () => {
  proxy = await startProxy({ printUrl: DOC, trusted: [] });
  const sockets: Socket[] = [];
  const closed = new Set<number>();
  for (let i = 0; i < 300; i++) {
    const s = connect(proxy.port, "127.0.0.1");
    s.on("close", () => closed.add(i));
    s.on("error", () => {});
    sockets.push(s);
    await new Promise<void>((ok) => s.once("connect", () => ok()));
  }
  await Bun.sleep(300);
  expect(closed.size).toBe(44);
  expect(closed.has(0)).toBe(false);
  expect(closed.has(299)).toBe(true);
  for (const s of sockets) s.destroy();
});

test("what it saw names hosts, never a print's address", async () => {
  proxy = await startProxy({ printUrl: "http://127.0.0.1:9/exports/print/SECRET-TOKEN", trusted: [] });
  await ask(proxy.port, "POST http://127.0.0.1:9/exports/print/SECRET-TOKEN?x=1 HTTP/1.1");
  await ask(proxy.port, "CONNECT 127.0.0.1:443 HTTP/1.1");
  expect(proxy.seen).toEqual(["POST 127.0.0.1:9", "CONNECT 127.0.0.1:443"]);
});
