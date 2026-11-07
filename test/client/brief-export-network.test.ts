// BRIEF EXPORT, the printing Chrome's way out: a hostile page tries every channel it has against listeners on this
// machine, and they count what reaches them. Run with a Chrome that trusts any certificate, standing in for an internal
// service whose certificate is trusted, so nothing here is saved by a failed TLS check. Needs Chrome and openssl.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { publicAddresses } from "../../src/server/brief-export-guard.ts";
import { startProxy } from "../../src/server/brief-export-print-proxy.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeBin = findChrome();
const ready = !!chromeBin && !!Bun.which("openssl") && !!Bun.which("pdftotext");
const dir = mkdtempSync(join(tmpdir(), "hq-export-net-"));
const temp = join(dir, "t");
mkdirSync(temp);
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);
const MARKER = "Sign in to continue";

// A listener per channel, so the table says which channel got through.
const TCP = ["fetch", "fetch-http", "image", "font", "stylesheet", "script", "iframe", "object", "blob-frame", "blob-frame-fetch", "data-frame", "data-frame-fetch", "srcdoc-frame", "srcdoc-frame-fetch", "sandboxed-frame", "worker", "worker-wss", "worker-import", "shared-worker", "service-worker", "wss", "ws", "eventsource", "eventsource-http", "preconnect", "dns-prefetch", "prefetch", "beacon", "dynamic-import", "ping", "turn-tcp", "turns-tcp", "mapped-fetch", "mapped-image", "mapped-wss", "mapped-frame", "mapped-worker", "dotted-mapped-fetch", "compatible-fetch", "nat64-fetch", "6to4-fetch", "site-local-fetch", "decimal-fetch", "hex-fetch", "localhost-fetch", "localhost-dot-fetch"];
const hits = new Map<string, number>();
const ports = new Map<string, number>();
const listeners: { stop(force?: boolean): void }[] = [];
const P = (name: string) => ports.get(name)!;
let stun: ReturnType<typeof createSocket>, turnUdp: ReturnType<typeof createSocket>;
let stunPort = 0, turnUdpPort = 0;
let server: Awaited<ReturnType<typeof spawnServer>>;
let stub: ReturnType<typeof Bun.serve>;
let certs: { cert: string; key: string };
const call = async (path: string, body: object) => {
  const r = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

function page() {
  const H = (name: string) => `https://127.0.0.1:${P(name)}`;
  const inside = (fetchName: string, frameName: string) => `<iframe src='${H(frameName)}/in'></iframe><script>fetch('${H(fetchName)}/in').catch(()=>{});<\\/script>`;
  const code = `fetch("${H("worker")}/w").catch(()=>{});try{new WebSocket("wss://127.0.0.1:${P("worker-wss")}/")}catch(e){};try{importScripts("${H("worker-import")}/x.js")}catch(e){}`;
  const script = `
const safely = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (e) {} };
safely(() => fetch("${H("fetch")}/f"));
safely(() => fetch("http://127.0.0.1:${P("fetch-http")}/f"));
safely(() => { const i = new Image(); i.src = "${H("image")}/i.png"; });
safely(() => { const f = document.createElement("iframe"); f.width = 600; f.height = 200; f.src = URL.createObjectURL(new Blob(["${inside("blob-frame-fetch", "blob-frame")}"], { type: "text/html" })); document.body.append(f); });
safely(() => { const f = document.createElement("iframe"); f.width = 600; f.height = 200; f.srcdoc = "${inside("srcdoc-frame-fetch", "srcdoc-frame")}"; document.body.append(f); });
safely(() => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.srcdoc = "<script>fetch('${H("sandboxed-frame")}/in').catch(()=>{});<\\/script>"; document.body.append(f); });
safely(() => { const f = document.createElement("iframe"); f.width = 600; f.height = 200; f.src = "data:text/html," + encodeURIComponent("${inside("data-frame-fetch", "data-frame")}"); document.body.append(f); });
safely(() => { new Worker(URL.createObjectURL(new Blob([${JSON.stringify(code)}], { type: "text/javascript" }))); });
safely(() => { new SharedWorker(URL.createObjectURL(new Blob(['fetch("${H("shared-worker")}/w").catch(()=>{})'], { type: "text/javascript" }))); });
safely(() => navigator.serviceWorker.register("${H("service-worker")}/sw.js"));
safely(() => { new WebSocket("wss://127.0.0.1:${P("wss")}/"); });
safely(() => { new WebSocket("ws://127.0.0.1:${P("ws")}/"); });
safely(() => { new EventSource("${H("eventsource")}/e"); });
safely(() => { new EventSource("http://127.0.0.1:${P("eventsource-http")}/e"); });
for (const [rel, name] of [["preconnect", "preconnect"], ["dns-prefetch", "dns-prefetch"], ["prefetch", "prefetch"]]) safely(() => { const l = document.createElement("link"); l.rel = rel; l.href = "https://127.0.0.1:" + ${JSON.stringify(Object.fromEntries(["preconnect", "dns-prefetch", "prefetch"].map((n) => [n, P(n)])))}[name] + "/l"; document.head.append(l); });
safely(() => navigator.sendBeacon("${H("beacon")}/b", "x"));
safely(() => import("${H("dynamic-import")}/d.js"));
safely(() => { const a = document.createElement("a"); a.href = "#x"; a.ping = "${H("ping")}/p"; document.body.append(a); a.click(); });
safely(() => { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }, { urls: "turn:127.0.0.1:${turnUdpPort}?transport=udp", username: "a", credential: "b" }, { urls: "turn:127.0.0.1:${P("turn-tcp")}?transport=tcp", username: "a", credential: "b" }, { urls: "turns:127.0.0.1:${P("turns-tcp")}?transport=tcp", username: "a", credential: "b" }] }); pc.createDataChannel("x"); return pc.createOffer().then((o) => pc.setLocalDescription(o)); });
safely(() => fetch("https://[::ffff:7f00:1]:${P("mapped-fetch")}/m"));
safely(() => { const i = new Image(); i.src = "https://[::ffff:7f00:1]:${P("mapped-image")}/m.png"; });
safely(() => { new WebSocket("wss://[::ffff:7f00:1]:${P("mapped-wss")}/"); });
safely(() => { const f = document.createElement("iframe"); f.srcdoc = "<iframe src='https://[::ffff:7f00:1]:${P("mapped-frame")}/in'></iframe>"; document.body.append(f); });
safely(() => { new Worker(URL.createObjectURL(new Blob(['fetch("https://[::ffff:7f00:1]:${P("mapped-worker")}/w").catch(()=>{})'], { type: "text/javascript" }))); });
safely(() => fetch("https://[::ffff:127.0.0.1]:${P("dotted-mapped-fetch")}/m"));
safely(() => fetch("https://[::7f00:1]:${P("compatible-fetch")}/m"));
safely(() => fetch("https://[64:ff9b::7f00:1]:${P("nat64-fetch")}/m"));
safely(() => fetch("https://[2002:7f00:1::]:${P("6to4-fetch")}/m"));
safely(() => fetch("https://[fec0::1]:${P("site-local-fetch")}/m"));
safely(() => fetch("https://2130706433:${P("decimal-fetch")}/m"));
safely(() => fetch("https://0x7f.1:${P("hex-fetch")}/m"));
safely(() => fetch("https://localhost:${P("localhost-fetch")}/m"));
safely(() => fetch("https://localhost.:${P("localhost-dot-fetch")}/m"));
setTimeout(() => { document.getElementById("end").textContent = "PAGE-RAN-TO-THE-END"; }, 4000);
`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Reaches out</title><style>@font-face { font-family: X; src: url(${H("font")}/f.woff2); } body { font-family: X; }</style><link rel="stylesheet" href="${H("stylesheet")}/s.css"><script src="${H("script")}/s.js"></script></head><body><h1>Report</h1><p id="end">start</p><iframe src="${H("iframe")}/page"></iframe><object data="${H("object")}/o"></object><script>${script}</script></body></html>`;
}

beforeAll(async () => {
  if (!ready) return;
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["openssl", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  writeFileSync(join(dir, "san.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:public.test\n");
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "stub.key", "-out", "stub.pem", "-days", "2", "-subj", "/CN=stub", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:public.test");
  certs = { cert: readFileSync(join(dir, "stub.pem"), "utf8"), key: readFileSync(join(dir, "stub.key"), "utf8") };
  // TLS on every channel's port: what a real internal service would offer. A connection counts when it is opened.
  for (const name of TCP) {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, tls: certs, socket: { open() { hits.set(name, (hits.get(name) ?? 0) + 1); }, data() {}, handshake() {} } });
    ports.set(name, l.port);
    listeners.push(l);
  }
  const udp = (name: string) => new Promise<[ReturnType<typeof createSocket>, number]>((ok) => {
    const s = createSocket("udp4");
    s.on("message", () => hits.set(name, (hits.get(name) ?? 0) + 1));
    s.bind(0, "127.0.0.1", () => ok([s, s.address().port]));
  });
  [stun, stunPort] = await udp("stun");
  [turnUdp, turnUdpPort] = await udp("turn-udp");
  stub = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: certs, fetch: () => new Response(`<!doctype html><title>Internal</title><h1>${MARKER}</h1>`, { headers: { "content-type": "text/html" } }) });
  const wrapper = join(dir, "chrome-trusts-all");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(chromeBin)} --ignore-certificate-errors "$@"\n`);
  chmodSync(wrapper, 0o755);
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", TMPDIR: temp, HUD_CHROME_PATH: wrapper } });
}, 60_000);
afterAll(async () => {
  await server?.stop();
  for (const l of listeners) l.stop(true);
  stub?.stop(true);
  stun?.close();
  turnUdp?.close();
  rmSync(dir, { recursive: true, force: true });
});

const tcpReaches = (port: number) => new Promise<boolean>((ok) => {
  const s = connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); ok(true); });
  s.once("error", () => ok(false));
});

describe.skipIf(!ready)("what the printing Chrome can reach", () => {
  let warnings: string[] = [], pdf = "";
  const running: string[] = [];
  beforeAll(async () => {
    const id = (await call("/api/briefs", { title: "Reaches out", body: page() })).body.id;
    let done = false;
    const ask = call("/api/exports", { page: id, format: "pdf" }).finally(() => { done = true; });
    while (!done) {
      for (const l of Bun.spawnSync(["ps", "-A", "-o", "command="], { stdout: "pipe" }).stdout.toString().split("\n")) if (l.includes("--remote-debugging-pipe") && l.includes(temp)) running.push(l);
      await Bun.sleep(200);
    }
    const r = await ask;
    if (r.status !== 200) throw new Error(r.body.error);
    warnings = r.body.warnings;
    const path = join(dir, "reaches-out.pdf");
    writeFileSync(path, new Uint8Array(await (await fetch(`${server.base}${r.body.url}`)).arrayBuffer()));
    pdf = Bun.spawnSync(["pdftotext", "-layout", path, "-"], { stdout: "pipe" }).stdout.toString();
    // UDP and a slow worker get a moment more.
    await Bun.sleep(500);
  }, 120_000);

  test("the listeners are really there: a plain connection is counted, and is taken back off the count", async () => {
    const before = hits.get("fetch") ?? 0;
    expect(await tcpReaches(P("fetch"))).toBe(true);
    await Bun.sleep(100);
    expect(hits.get("fetch")).toBe(before + 1);
    hits.set("fetch", before);
  });
  test("the page really ran to the end, and printed", () => {
    expect(pdf).toContain("PAGE-RAN-TO-THE-END");
  });
  test("nothing reached any listener, by any channel", () => {
    const table = Object.fromEntries([...TCP, "stun", "turn-udp"].map((name) => [name, hits.get(name) ?? 0]));
    console.log(`LISTENER TABLE ${JSON.stringify(table)}`);
    expect(Object.entries(table).filter(([, n]) => n > 0)).toEqual([]);
  });
  test("Chrome ran with its proxy for everything, loopback included, QUIC off, and no lookups of its own", () => {
    const line = running[0];
    expect(line).toContain("--proxy-server=http://127.0.0.1:");
    expect(line).toContain("--proxy-bypass-list=<-loopback>");
    expect(line).toContain("--disable-quic");
    expect(line).toContain("--host-resolver-rules=");
  });
  test("what it asked for is named as refused, once", () => {
    const said = warnings.join("\n");
    expect(said).toContain("refused");
    expect(said).toContain("127.0.0.1");
    const lines = warnings.filter((w) => w.includes("127.0.0.1"));
    expect(lines.length).toBe(1);
  });
});

describe.skipIf(!ready)("an internal page in a frame", () => {
  const frames = (url: string): Record<string, string> => ({
    "blob frame": `<script>const f = document.createElement("iframe"); f.width = 600; f.height = 200; f.src = URL.createObjectURL(new Blob(["<iframe src='${url}' width=500 height=150></iframe>"], { type: "text/html" })); document.body.append(f);</script>`,
    "data frame": `<iframe width="600" height="200" src="data:text/html,${encodeURIComponent(`<iframe src='${url}' width=500 height=150></iframe>`)}"></iframe>`,
    // A srcdoc written in the page is left out of the file: a script's is the page's own.
    "srcdoc frame": `<script>const f = document.createElement("iframe"); f.width = 600; f.height = 200; f.srcdoc = "<iframe src='${url}' width=500 height=150></iframe>"; document.body.append(f);</script>`,
    "direct frame": `<iframe width="600" height="200" src="${url}"></iframe>`,
  });
  for (const name of ["blob frame", "data frame", "srcdoc frame", "direct frame"]) {
    test(`${name}: a Chrome that trusts its certificate still prints nothing of it`, async () => {
      const id = (await call("/api/briefs", { title: name, body: `<!doctype html><html><body><h1>Report</h1>${frames(`https://127.0.0.1:${stub.port}/page`)[name]}<script>setTimeout(() => {}, 1500);</script></body></html>` })).body.id;
      const r = await call("/api/exports", { page: id, format: "pdf" });
      expect(r.status).toBe(200);
      const path = join(dir, "frame.pdf");
      writeFileSync(path, new Uint8Array(await (await fetch(`${server.base}${r.body.url}`)).arrayBuffer()));
      expect(Bun.spawnSync(["pdftotext", "-layout", path, "-"], { stdout: "pipe" }).stdout.toString()).not.toContain(MARKER);
    }, 60_000);
  }
});

describe.skipIf(!ready)("the proxy itself, with a real Chrome and a host it is told is public", () => {
  test("a redirect from there to a private address, plain or mapped, reaches nothing: each hop is asked again", async () => {
    let started = 0;
    const seen: string[] = [];
    const target = Bun.listen({ hostname: "127.0.0.1", port: 0, tls: certs, socket: { open() { seen.push("connected"); }, data() {}, handshake() {} } });
    const publicStub = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: certs, fetch(req) {
      const u = new URL(req.url);
      started++;
      if (u.pathname === "/plain") return new Response(null, { status: 302, headers: { location: `https://127.0.0.1:${target.port}/after` } });
      if (u.pathname === "/mapped") return new Response(null, { status: 302, headers: { location: `https://[::ffff:7f00:1]:${target.port}/after` } });
      if (u.pathname === "/http") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${target.port}/after` } });
      return new Response(`<!doctype html><body>THE-PUBLIC-PAGE<iframe src="/plain"></iframe><iframe src="/mapped"></iframe><iframe src="/http"></iframe><script>for (const p of ["/plain", "/mapped", "/http"]) fetch(p).catch(() => {});</script></body>`, { headers: { "content-type": "text/html" } });
    } });
    const proxy = await startProxy({
      printUrl: "http://127.0.0.1:1/none",
      trusted: [],
      addressesOf: async (host) => (host === "public.test" ? ["192.0.2.1"] : publicAddresses(host, [])),
      dial: (_address, _port) => connect(publicStub.port, "127.0.0.1"),
    });
    const profile = mkdtempSync(join(dir, "redirect-profile-"));
    const chrome = Bun.spawn([chromeBin!, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--ignore-certificate-errors", `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>", "--disable-quic", "--timeout=4000", "--dump-dom", "https://public.test/start"], { stdout: "pipe", stderr: "ignore" });
    const dom = await new Response(chrome.stdout).text();
    await chrome.exited;
    proxy.close();
    target.stop(true);
    publicStub.stop(true);
    rmSync(profile, { recursive: true, force: true });
    expect(dom).toContain("THE-PUBLIC-PAGE");
    expect(started).toBeGreaterThanOrEqual(4);
    expect(seen).toEqual([]);
    expect([...proxy.refused].join(" ")).toContain("127.0.0.1");
  }, 60_000);
  test("a plain request gets only the print's document, once; nothing else on that port", async () => {
    const asked: string[] = [];
    const hud = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { asked.push(new URL(req.url).pathname); return new Response("THE-DOCUMENT"); } });
    const doc = `http://127.0.0.1:${hud.port}/exports/print/TOKEN`;
    const proxy = await startProxy({ printUrl: doc, trusted: [] });
    const viaProxy = (first: string) => new Promise<string>((ok) => {
      const s = connect(proxy.port, "127.0.0.1");
      let got = "";
      s.on("data", (d) => { got += d.toString(); });
      s.on("close", () => ok(got));
      s.on("error", () => ok(got));
      s.once("connect", () => s.write(`${first}\r\nHost: x\r\n\r\n`));
    });
    expect(await viaProxy(`GET http://127.0.0.1:${hud.port}/api/state HTTP/1.1`)).toContain("403");
    expect(await viaProxy(`POST ${doc} HTTP/1.1`)).toContain("403");
    expect(await viaProxy(`CONNECT 127.0.0.1:${hud.port} HTTP/1.1`)).toContain("403");
    expect(await viaProxy(`CONNECT 8.8.8.8:80 HTTP/1.1`)).toContain("403");
    expect(asked).toEqual([]);
    expect(await viaProxy(`GET ${doc} HTTP/1.1`)).toContain("THE-DOCUMENT");
    expect(await viaProxy(`GET ${doc} HTTP/1.1`)).toContain("403");
    expect(asked).toEqual(["/exports/print/TOKEN"]);
    proxy.close();
    hud.stop(true);
  }, 30_000);
});
