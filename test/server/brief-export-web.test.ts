// BRIEF EXPORT, a page's library from the web and the look for keys: small and pure, with fake answers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LIBRARY_BYTES, fetchLibrary } from "../../src/server/brief-export-web.ts";
import { looksLikeKeys } from "../../src/server/brief-export-scan.ts";

const yes = async () => true;
const answers = (map: Record<string, Response>) => (async (u: string) => map[u] ?? new Response("nope", { status: 404 })) as unknown as typeof fetch;
const sha384 = (text: string) => `sha384-${new Bun.CryptoHasher("sha384").update(text).digest("base64")}`;

describe("fetching a page's library", () => {
  test("brings the text", async () => {
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({ "https://cdn.test/a.js": new Response("the-lib") }) })).toEqual({ text: "the-lib" });
  });
  test("refuses an address the guard refuses, and only asks for https", async () => {
    const asked: string[] = [];
    const get = (async (u: string) => { asked.push(u); return new Response("x"); }) as unknown as typeof fetch;
    expect(await fetchLibrary("https://inside.test/a.js", null, async () => false, { get })).toEqual({ why: "it is not at a public https address" });
    expect(await fetchLibrary("http://cdn.test/a.js", null, yes, { get })).toEqual({ why: "it is not at a public https address" });
    expect(asked).toEqual([]);
  });
  test("every redirect passes the guard again", async () => {
    const seen: string[] = [];
    const guard = async (u: string) => { seen.push(u); return !u.includes("inside"); };
    const get = answers({ "https://cdn.test/a.js": new Response(null, { status: 302, headers: { location: "https://inside.test/x.js" } }) });
    expect(await fetchLibrary("https://cdn.test/a.js", null, guard, { get })).toEqual({ why: "it is not at a public https address" });
    expect(seen).toEqual(["https://cdn.test/a.js", "https://inside.test/x.js"]);
  });
  test("a redirect may not leave https, and there is an end to them", async () => {
    const toHttp = answers({ "https://cdn.test/a.js": new Response(null, { status: 301, headers: { location: "http://cdn.test/a.js" } }) });
    expect("why" in await fetchLibrary("https://cdn.test/a.js", null, yes, { get: toHttp })).toBe(true);
    const loop = (async () => new Response(null, { status: 302, headers: { location: "https://cdn.test/again" } })) as unknown as typeof fetch;
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: loop })).toEqual({ why: "it redirects too many times" });
  });
  test("past the cap it stops reading and says so", async () => {
    let sent = 0;
    const big = new ReadableStream({ pull(c) { sent += 1 << 20; c.enqueue(new Uint8Array(1 << 20)); } });
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({ "https://cdn.test/a.js": new Response(big) }) })).toEqual({ why: "it is too large" });
    expect(sent).toBeLessThan(40 << 20);
  });
  test("a hash the page gave must match, and the strongest one counts", async () => {
    const lib = () => answers({ "https://cdn.test/a.js": new Response("the-lib") });
    expect(await fetchLibrary("https://cdn.test/a.js", sha384("the-lib"), yes, { get: lib() })).toEqual({ text: "the-lib" });
    expect(await fetchLibrary("https://cdn.test/a.js", sha384("other"), yes, { get: lib() })).toEqual({ why: "it does not match the hash the page gives for it" });
    const weak = `sha256-${new Bun.CryptoHasher("sha256").update("the-lib").digest("base64")}`;
    expect("why" in await fetchLibrary("https://cdn.test/a.js", `${weak} ${sha384("other")}`, yes, { get: lib() })).toBe(true);
  });
  test("a server that answers an error, or not at all, is a reason", async () => {
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({}) })).toEqual({ why: "its server answered 404" });
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: (async () => { throw new Error("no route"); }) as unknown as typeof fetch })).toEqual({ why: "it could not be reached just now" });
  });
});

describe("what comes back", () => {
  test("a web page answering 200 is not a library, and is not put in the file", async () => {
    const page = () => new Response("<h1>Sign in</h1>", { headers: { "content-type": "text/html; charset=utf-8" } });
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({ "https://cdn.test/a.js": page() }) })).toEqual({ why: "its server answered with a web page, not a library" });
  });
  test("a script or a stylesheet, whatever it calls itself, comes through", async () => {
    for (const type of ["application/javascript", "text/css", "text/plain", "application/octet-stream"]) {
      expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({ "https://cdn.test/a.js": new Response("x", { headers: { "content-type": type } }) }) })).toEqual({ text: "x" });
    }
  });
});

describe("one budget for all of a page's libraries", () => {
  const MB = 1 << 20;
  const of = (bytes: number) => answers({ "https://cdn.test/a.js": new Response(new Uint8Array(bytes)) });
  test("what is spent is spent for the next file; past the budget it stops and says so, and a smaller one still fits", async () => {
    const spend = { left: 20 * MB };
    expect("text" in await fetchLibrary("https://cdn.test/a.js", null, yes, { get: of(12 * MB), spend })).toBe(true);
    expect(spend.left).toBe(8 * MB);
    expect(await fetchLibrary("https://cdn.test/a.js", null, yes, { get: of(12 * MB), spend })).toEqual({ why: "the page's libraries together are too large" });
    expect(spend.left).toBe(8 * MB);
    expect("text" in await fetchLibrary("https://cdn.test/a.js", null, yes, { get: of(1 * MB), spend })).toBe(true);
    expect(spend.left).toBe(7 * MB);
  });
  test("it stops reading past the budget, rather than reading the file first", async () => {
    let sent = 0;
    const endless = new ReadableStream({ pull(c) { sent += MB; c.enqueue(new Uint8Array(MB)); } });
    const r = await fetchLibrary("https://cdn.test/a.js", null, yes, { get: answers({ "https://cdn.test/a.js": new Response(endless) }), spend: { left: 2 * MB } });
    expect("why" in r).toBe(true);
    expect(sent).toBeLessThan(8 * MB);
  });
  test("the budget and the time limit for one export are real numbers", () => {
    expect(MAX_LIBRARY_BYTES).toBe(32 * MB);
  });
  test("a deadline shared across fetches ends them", async () => {
    const stall = ((_u: string, o: RequestInit) => new Promise((_ok, no) => o.signal!.addEventListener("abort", () => no(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    const r = await fetchLibrary("https://cdn.test/a.js", null, yes, { get: stall, deadline: AbortSignal.timeout(100) });
    expect(r).toEqual({ why: "it could not be reached just now" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// With real TLS: a certificate from a certificate authority the fetching process trusts, so the only thing wrong with the
// wrong one is its name. Run in a process of its own, which is where the trust is set. Needs openssl; skipped without.
describe.skipIf(!Bun.which("openssl"))("a certificate that does not match the name", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-export-tls-"));
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const leaf = (name: string, san: string) => {
    writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\n`);
    run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    run("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
    return { cert: readFileSync(join(dir, `${name}.pem`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
  };
  let right: ReturnType<typeof Bun.serve>, wrong: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=test authority");
    const fetchIt = () => new Response("served-over-tls");
    right = Bun.serve({ port: 0, hostname: "localhost", tls: leaf("right", "DNS:localhost"), fetch: fetchIt });
    wrong = Bun.serve({ port: 0, hostname: "localhost", tls: leaf("wrong", "DNS:someone-else.example"), fetch: fetchIt });
  });
  afterAll(() => {
    right?.stop(true);
    wrong?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  const fetchedBy = async (port: number, env: Record<string, string>) => {
    const script = join(dir, "client.ts");
    writeFileSync(script, `import { fetchLibrary } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "server", "brief-export-web.ts"))};\nconsole.log(JSON.stringify(await fetchLibrary("https://localhost:${port}/a.js", null, async () => true)));`);
    const p = Bun.spawn([process.execPath, script], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return JSON.parse(out);
  };
  const trusted = () => ({ NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") });
  test("the right name from a trusted authority is fetched: the setup itself works", async () => {
    expect(await fetchedBy(right.port, trusted())).toEqual({ text: "served-over-tls" });
  }, 30_000);
  test("the wrong name from the same authority is refused", async () => {
    expect(await fetchedBy(wrong.port, trusted())).toEqual({ why: "it could not be reached just now" });
  }, 30_000);
  test("that refusal is the certificate check: with checking switched off, the same fetch goes through", async () => {
    expect(await fetchedBy(wrong.port, { ...trusted(), NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toEqual({ text: "served-over-tls" });
  }, 30_000);
  test("an authority nobody trusts is refused too", async () => {
    expect(await fetchedBy(right.port, {})).toEqual({ why: "it could not be reached just now" });
  }, 30_000);
});

describe("what looks like a key", () => {
  test("each hit once, never whole", () => {
    const key = "ghp_" + "abcdefghij0123456789";
    const hits = looksLikeKeys(`${key} and again ${key}`);
    expect(hits).toEqual(["ghp_…89"]);
  });
  test("a shape inside a longer run counts once", () => {
    expect(looksLikeKeys("sk_" + "live_51MX9AZQ8KD2xyzw0123456789abcdef").length).toBe(1);
  });
  test("a short word with a key's start is not one", () => {
    expect(looksLikeKeys("task-force, sk-learn, the xox pattern, ghp_x, Bearer token")).toEqual([]);
  });
});
