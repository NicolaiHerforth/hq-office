// BRIEF EXPORT, the PDF: a real Chrome prints real pages, and the PDFs are read back with poppler (text, word positions,
// rendered pixels). A hostile page tries everything it can while it is printed, against this server's API, a decoy
// server and a local file. Needs Chrome and poppler (pdftotext, pdfinfo, pdftoppm); skipped without them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ready = !!findChrome() && ["pdftotext", "pdfinfo", "pdftoppm"].every((b) => Bun.which(b));
const dir = mkdtempSync(join(tmpdir(), "hq-brief-print-"));
const profiles = join(dir, "t");
mkdirSync(profiles);
const LOCAL_FILE = join(dir, "local-file.txt");
const SECRET = "PLANTED-SECRET-VALUE-456";
const HUD_MARKER = "hud-api-marker-in-state", FILE_MARKER = "local-file-marker-text";
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>, strict: Awaited<ReturnType<typeof spawnServer>>;
const decoyHits: string[] = [];
let decoy: ReturnType<typeof Bun.serve>;
const env = (data: string, more: object = {}) => ({ ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", TMPDIR: profiles, ...more });
const call = async (base: string, path: string, body: object) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
type Pdf = { path: string; text: string; pages: number; info: string; warnings: string[] };
let n = 0;
async function pdfOf(title: string, body: string, base = server.base): Promise<Pdf> {
  const id = (await call(base, "/api/briefs", { title, body })).body.id;
  const r = await call(base, "/api/exports", { page: id, format: "pdf" });
  if (r.status !== 200) throw new Error(r.body.error);
  const path = join(dir, `made-${++n}.pdf`);
  writeFileSync(path, new Uint8Array(await (await fetch(`${base}${r.body.url}`)).arrayBuffer()));
  const out = (...cmd: string[]) => Bun.spawnSync(cmd, { stdout: "pipe" }).stdout.toString();
  const info = out("pdfinfo", path);
  return { path, text: out("pdftotext", "-layout", path, "-"), pages: Number(info.match(/^Pages:\s+(\d+)/m)?.[1]), info, warnings: r.body.warnings };
}
// Every word's right edge, in points, and the sheet's width.
function words(path: string) {
  const xml = Bun.spawnSync(["pdftotext", "-bbox", path, "-"], { stdout: "pipe" }).stdout.toString();
  return [...xml.matchAll(/<page width="([\d.]+)"|<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)"[^>]*>([^<]*)</g)].reduce((acc, m) => {
    if (m[1]) acc.pages.push(Number(m[1]));
    else acc.words.push({ page: acc.pages.length - 1, xMin: Number(m[2]), xMax: Number(m[3]), text: m[4] });
    return acc;
  }, { pages: [] as number[], words: [] as { page: number; xMin: number; xMax: number; text: string }[] });
}
function nothingCut(pdf: Pdf) {
  const { pages, words: all } = words(pdf.path);
  const out = all.filter((w) => w.xMax > pages[w.page] - 18 || w.xMin < 18);
  expect(out.map((w) => w.text)).toEqual([]);
  // The right margin of every rendered page is blank: anything clipped at the edge would show there.
  const prefix = join(dir, `px-${++n}`);
  Bun.spawnSync(["pdftoppm", "-r", "40", "-gray", pdf.path, prefix]);
  for (const f of readdirSync(dir).filter((x) => x.startsWith(`px-${n}-`) || x === `px-${n}.pgm`)) {
    const data = readFileSync(join(dir, f));
    const head = data.subarray(0, 40).toString("latin1").match(/^P5\s+(\d+)\s+(\d+)\s+255\s/)!;
    const w = Number(head[1]), h = Number(head[2]), start = head[0].length, margin = Math.floor(w * 0.03);
    for (let y = 0; y < h; y++) for (let x = w - margin; x < w; x++) expect(data[start + y * w + x]).toBeGreaterThan(240);
  }
}
const running = () => Bun.spawnSync(["ps", "-A", "-o", "command"], { stdout: "pipe" }).stdout.toString().split("\n").filter((l) => l.includes(profiles));
const leftProfiles = () => readdirSync(profiles).filter((f) => f.startsWith("hq-office-print-"));
// A Chrome that had to be killed: its helpers may write there for a moment, so the removal comes back for it.
const profilesGone = async () => {
  for (let i = 0; i < 80 && leftProfiles().length; i++) await Bun.sleep(100);
  expect(leftProfiles()).toEqual([]);
};

beforeAll(async () => {
  if (!ready) return;
  writeFileSync(LOCAL_FILE, FILE_MARKER);
  decoy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(r) { decoyHits.push(new URL(r.url).pathname); return new Response(`decoy-answer`); } });
  server = await spawnServer({ cwd: ROOT, env: env(dir) });
  const strictDir = join(dir, "strict");
  mkdirSync(strictDir);
  strict = await spawnServer({ cwd: ROOT, env: env(strictDir, { HUD_PRINT_TIMEOUT_MS: "9000" }) });
  await call(server.base, "/api/lanes", { name: HUD_MARKER, machine: "local" });
  await call(server.base, "/api/secrets", { name: "PLANTED", value: SECRET, minutes: 60, by: "owner" });
}, 40_000);
afterAll(async () => {
  await server?.stop();
  await strict?.stop();
  decoy?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)("written inside its own address", () => {
  const MARKS = "FAKE&dat<ret>value43", SPELLED = "FAKE&amp;dat&lt;ret&gt;value43";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text y="20">${SPELLED} SVG-WORDS</text></svg>`;
  const flat = (text: string) => text.replace(/\s+/g, "");
  test("a held value in a data: frame or SVG picture is not in the PDF, nor what a frame says", async () => {
    await call(server.base, "/api/secrets", { name: "DATAMARKS", value: MARKS, minutes: 60, by: "owner" });
    for (const body of [
      `<iframe width="400" height="80" src="data:text/html,${encodeURIComponent(`<p>${SPELLED}</p><p>#lane/secret-lane</p><p>FRAME-WORDS</p>`)}"></iframe>`,
      `<object width="400" height="80" data="data:text/html,${encodeURIComponent(`<p>${SPELLED}</p><p>FRAME-WORDS</p>`)}"></object>`,
      `<img alt="The chart" src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
      `<img srcset="data:image/svg+xml,${encodeURIComponent(svg)} 1x">`,
      `<div style="width:400px;height:60px;background:url('data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}')"></div>`,
      `<svg width="500" height="100"><image width="400" height="60"><set attributeName="href" to="data:image/svg+xml,${encodeURIComponent(svg)}"/></image></svg>`,
      `<iframe width="400" height="80" src="javascript:%27${encodeURIComponent(`<p>${SPELLED}</p><p>FRAME-WORDS</p>`)}%27"></iframe>`,
      `<<!---->iframe width="400" height="80" srcdoc="<p>${SPELLED.replaceAll("&", "&amp;")}</p>"></iframe>`,
    ]) {
      const pdf = await pdfOf("Data", `<!doctype html><html><head><title>Data</title></head><body><h1>The words</h1>${body}</body></html>`);
      expect(flat(pdf.text)).toContain("Thewords");
      expect(flat(pdf.text)).not.toContain(flat(MARKS));
      expect(pdf.text).not.toContain("secret-lane");
      expect(pdf.text).not.toContain("FRAME-WORDS");
      expect(pdf.text).not.toContain("SVG-WORDS");
    }
  }, 120_000);
  test("an SVG picture holding nothing still draws", async () => {
    const pdf = await pdfOf("Fine", `<!doctype html><html><head><title>Fine</title></head><body><h1>The words</h1><img src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60"><text y="20">PICTURE-WORDS</text></svg>`)}"></body></html>`);
    expect(pdf.text).toContain("PICTURE-WORDS");
    expect(pdf.warnings).toEqual([]);
  }, 60_000);
});

describe.skipIf(!ready)("a clean page", () => {
  test("says nothing false: no warning at all, from a page or a markdown brief", async () => {
    expect((await pdfOf("Clean", "<!doctype html><title>Clean</title><h1>Clean</h1>")).warnings).toEqual([]);
    expect((await pdfOf("Words", "## Only words\n\nThe rest.")).warnings).toEqual([]);
  }, 60_000);
  test("makes no connection of Chrome's own: the proxy's log holds its document and nothing else", async () => {
    const doc = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><title>Clean</title><h1>Clean</h1><script>setTimeout(() => {}, 8000);</script>`, { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'" } }) });
    const profile = join(dir, `clean-${++n}`);
    mkdirSync(profile);
    const helper = Bun.spawn([process.execPath, join(ROOT, "src/server/brief-export-print-helper.ts")], {
      cwd: profile,
      stdin: new Blob([JSON.stringify({ bin: findChrome(), printUrl: `http://127.0.0.1:${doc.port}/doc`, profile, title: "Clean", date: "today", ink: "#000", timeoutMs: 40_000, trusted: [] })]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const answer = JSON.parse((await new Response(helper.stdout).text()).trim().split("\n").at(-1)!);
    await helper.exited;
    const port = doc.port;
    doc.stop(true);
    expect(answer.pdf).toBeTruthy();
    expect(answer.seen).toEqual([`GET 127.0.0.1:${port}`]);
    expect(answer.warnings).toEqual([]);
  }, 60_000);
  for (const [name, body] of [
    ["a text box", `<input name="q">`],
    ["a text area", `<textarea>words</textarea>`],
    ["a sign-in form", `<form><input type="email" name="e"><input type="password" name="p"><button>Go</button></form>`],
  ]) test(`${name} is no reason for Chrome to tell anyone: the proxy's log holds its document and nothing else`, async () => {
    const doc = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(`<!doctype html><title>Form</title><h1>Form</h1>${body}`, { headers: { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'" } }) });
    const profile = join(dir, `form-${++n}`);
    mkdirSync(profile);
    const helper = Bun.spawn([process.execPath, join(ROOT, "src/server/brief-export-print-helper.ts")], {
      cwd: profile,
      stdin: new Blob([JSON.stringify({ bin: findChrome(), printUrl: `http://127.0.0.1:${doc.port}/doc`, profile, title: "Form", date: "today", ink: "#000", timeoutMs: 40_000, trusted: [] })]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const answer = JSON.parse((await new Response(helper.stdout).text()).trim().split("\n").at(-1)!);
    await helper.exited;
    const port = doc.port;
    doc.stop(true);
    expect(answer.pdf).toBeTruthy();
    expect(answer.seen).toEqual([`GET 127.0.0.1:${port}`]);
    expect(answer.warnings).toEqual([]);
  }, 60_000);
  test("a long list of refused names says how many more", async () => {
    const pdf = await pdfOf("Many", `<!doctype html><html><body><h1>Many</h1>${Array.from({ length: 9 }, (_, i) => `<img src="https://192.168.77.${i + 1}/a.png">`).join("")}</body></html>`);
    const said = pdf.warnings.join(" ");
    expect(said).toContain("192.168.77.");
    expect(said).toMatch(/and \d+ more/);
    expect(said).not.toContain("google");
    expect(said).not.toContain("gvt1");
  }, 60_000);
});

describe.skipIf(!ready)("a link a script sets", () => {
  test("to this machine, by any name, is cut from the PDF; a public one stays", async () => {
    const pdf = await pdfOf("Links", `<!doctype html><html><body><h1>Links</h1><a id=a>one</a> <a id=b>two</a> <a id=c>three</a> <a id=d>four</a> <a id=e>five</a><script>a.href = "http://localhost:4799/api/state"; b.href = "http://127.0.0.1:4799/api/state"; c.href = "http://[::1]:4799/x"; d.href = "http://nas.internal/x"; e.href = "https://example.com/kept-link";</script></body></html>`);
    const raw = readFileSync(pdf.path).toString("latin1");
    for (const gone of ["localhost", "127.0.0.1", "[::1]", "nas.internal"]) expect(raw).not.toContain(gone);
    expect(raw).toContain("example.com/kept-link");
    expect(pdf.text).toContain("three");
  }, 60_000);
});

describe.skipIf(!ready)("a hostile page while it prints", () => {
  let pdf: Pdf;
  let during: string[] = [];
  beforeAll(async () => {
    const HUD = server.base, DECOY = `http://127.0.0.1:${decoy.port}`;
    const page = `<!doctype html><html><head><meta charset="utf-8"><title>Hostile page</title><link rel="stylesheet" href="${DECOY}/style.css"><link rel="prefetch" href="${DECOY}/prefetch"></head><body><h1>PAGE-STILL-HERE</h1><pre id="log">start</pre><img src="${DECOY}/plain-img"><img src="file://${LOCAL_FILE}"><iframe src="${HUD}/api/state"></iframe><iframe src="file://${LOCAL_FILE}"></iframe><iframe src="${DECOY}/frame"></iframe><object data="${HUD}/api/state"></object><embed src="${HUD}/api/state"><a ping="${DECOY}/ping" href="https://example.com/">web</a>
<script>
const log = (t) => { document.getElementById("log").textContent += "\\n" + t; };
const take = (what, p) => p.then((r) => r.text()).then((t) => log(what + " " + t.slice(0, 2000)), () => log(what + " refused"));
take("api", fetch("${HUD}/api/state"));
take("no-cors", fetch("${HUD}/api/state", { mode: "no-cors" }));
take("secrets", fetch("${HUD}/api/secrets"));
take("decoy", fetch("${DECOY}/fetch"));
take("file", fetch("file://${LOCAL_FILE}"));
for (const url of ["file://${LOCAL_FILE}", "${HUD}/api/state"]) { try { const x = new XMLHttpRequest(); x.open("GET", url, false); x.send(); log("xhr " + x.responseText.slice(0, 2000)); } catch (e) { log("xhr refused"); } }
const s = document.createElement("script"); s.src = "${DECOY}/script.js"; document.head.append(s);
try { new Worker(URL.createObjectURL(new Blob(['fetch("${DECOY}/worker").then(() => postMessage("worker reached"), () => postMessage("worker refused"))']))).onmessage = (e) => log(e.data); } catch (e) { log("worker refused"); }
try { const w = new WebSocket("${DECOY.replace("http", "ws")}/ws"); w.onopen = () => log("ws reached"); w.onerror = () => log("ws refused"); } catch (e) { log("ws refused"); }
try { window.open("${HUD}/api/state"); } catch (e) {}
try { navigator.sendBeacon("${DECOY}/beacon", "x"); } catch (e) {}
try { alert("stuck?"); log("alert passed"); } catch (e) { log("alert refused"); }
try { log("cookie " + document.cookie); } catch (e) { log("no cookies"); }
setTimeout(() => { location.href = "${HUD}/api/state"; }, 150);
setTimeout(() => { location.href = "file://${LOCAL_FILE}"; }, 250);
setTimeout(() => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${HUD}/api/state"; document.head.append(m); }, 350);
setTimeout(() => { const f = document.createElement("form"); f.action = "${HUD}/api/state"; document.body.append(f); f.submit(); }, 450);
setTimeout(() => location.reload(), 550);
</script></body></html>`;
    let done = false;
    const made = pdfOf("Hostile", page).finally(() => { done = true; });
    while (!done) { for (const l of running()) if (!during.includes(l)) during.push(l); await Bun.sleep(100); }
    pdf = await made;
  }, 90_000);

  test("Chrome ran with its sandbox on, a temporary profile and no debugging port", () => {
    const browser = during.find((l) => l.includes("--remote-debugging-pipe"))!;
    expect(browser).toBeTruthy();
    expect(browser).toContain("--user-data-dir=");
    expect(browser).toContain("hq-office-print-");
    expect(during.join("\n")).not.toContain("--no-sandbox");
    expect(during.join("\n")).not.toContain("--remote-debugging-port");
    expect(during.join("\n")).not.toContain("--disable-web-security");
    if (process.platform === "darwin") expect(during.some((l) => l.includes("--type=renderer") && l.includes("--seatbelt-client"))).toBe(true);
  });
  test("it printed the page itself, not where it tried to go", () => {
    expect(pdf.text).toContain("PAGE-STILL-HERE");
    expect(pdf.pages).toBeGreaterThanOrEqual(1);
    expect(pdf.text).toContain("api refused");
    expect(pdf.text).toContain("file refused");
    expect(pdf.text).toContain("xhr refused");
    expect(pdf.text).toContain("worker refused");
    expect(pdf.text).toContain("ws refused");
  });
  test("nothing of the HUD's API or of a local file is in the PDF", () => {
    expect(pdf.text).not.toContain(HUD_MARKER);
    expect(pdf.text).not.toContain(FILE_MARKER);
    expect(pdf.text).not.toContain("decoy-answer");
    expect(pdf.text).not.toContain("is blocked");
  });
  test("no request reached a server on this machine", () => {
    expect(decoyHits).toEqual([]);
    expect(pdf.warnings.join(" ")).toContain("refused");
  });
  test("Chrome and its profile are gone afterwards", async () => {
    for (let i = 0; i < 40 && running().length; i++) await Bun.sleep(100);
    expect(running()).toEqual([]);
    await profilesGone();
  });
});

describe.skipIf(!ready)("a page that will not cooperate", () => {
  const blank = () => expect(running()).toEqual([]);
  test("a page that never stops running is killed at the time limit, with a plain message", async () => {
    const id = (await call(strict.base, "/api/briefs", { title: "Stuck", body: `<!doctype html><html><body><script>while (true) {}</script></body></html>` })).body.id;
    const started = Date.now();
    const r = await call(strict.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not ready to print");
    expect(r.body.error).toContain("Download the HTML");
    expect(Date.now() - started).toBeLessThan(25_000);
    for (let i = 0; i < 40 && running().length; i++) await Bun.sleep(100);
    blank();
  }, 40_000);
  test("the next export works after that", async () => {
    const pdf = await pdfOf("After", "Plain words after a stuck page.", strict.base);
    expect(pdf.text).toContain("Plain words after a stuck page.");
  }, 40_000);
  test("a page that leaves for about:blank stops the PDF rather than printing nothing", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Leaves", body: `<!doctype html><html><body><p>here</p><script>setTimeout(() => { location.href = "about:blank"; }, 50);</script></body></html>` })).body.id;
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("somewhere else");
  }, 60_000);
  test("two PDFs asked for at once both arrive, one after the other", async () => {
    const [a, b] = await Promise.all([pdfOf("First", "first-words"), pdfOf("Second", "second-words")]);
    expect(a.text).toContain("first-words");
    expect(b.text).toContain("second-words");
  }, 90_000);
});

describe.skipIf(!ready)("printing happens in a helper of its own", () => {
  const procs = () => Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="], { stdout: "pipe" }).stdout.toString().split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), command: m![3] }));
  const brief = async (title: string, body: string) => (await call(server.base, "/api/briefs", { title, body })).body.id;
  const SLOW = `<!doctype html><html><body><p>slow page</p><script>const until = Date.now() + 20000; const beat = () => { document.body.append("."); if (Date.now() < until) setTimeout(beat, 100); }; beat();</script></body></html>`;
  const watch = async (ask: Promise<any>, test: (found: { helper: { pid: number; ppid: number }; chrome: { pid: number; ppid: number } }) => void) => {
    for (let i = 0; i < 200; i++) {
      const all = procs(), chrome = all.find((p) => p.command.includes("--remote-debugging-pipe") && p.command.includes(profiles));
      if (chrome) return test({ chrome, helper: all.find((p) => p.pid === chrome.ppid)! });
      await Bun.sleep(100);
    }
    await ask;
    throw new Error("no Chrome seen while printing");
  };
  test("Chrome is the helper's child, the helper the server's, and the server keeps no pipe to Chrome", async () => {
    const ask = call(server.base, "/api/exports", { page: await brief("Family", "family words"), format: "pdf" });
    await watch(ask, ({ helper }) => {
      expect(helper.command).toContain("brief-export-print-helper");
      expect(procs().find((p) => p.pid === helper.ppid)!.command).toContain("server.ts");
    });
    expect((await ask).status).toBe(200);
    for (let i = 0; i < 40 && running().length; i++) await Bun.sleep(100);
  }, 60_000);
  test("when the helper dies mid-print: one failed PDF said plainly, the server up, Chrome and its profile gone, the next PDF fine", async () => {
    const ask = call(server.base, "/api/exports", { page: await brief("Dies", SLOW), format: "pdf" });
    await watch(ask, ({ helper }) => { process.kill(helper.pid, "SIGKILL"); });
    const r = await ask;
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("stopped before the PDF was made");
    expect(r.body.error).toContain("Download the HTML");
    expect((await fetch(`${server.base}/api/state`)).status).toBe(200);
    for (let i = 0; i < 80 && running().length; i++) await Bun.sleep(100);
    expect(running()).toEqual([]);
    await profilesGone();
    expect((await pdfOf("After a dead helper", "still-printing-words")).text).toContain("still-printing-words");
  }, 90_000);
});

describe.skipIf(!ready)("a page that takes its time", () => {
  test("what it fills in late is on the paper: timers of 800 ms, 3 s and 8 s", async () => {
    const started = Date.now();
    const pdf = await pdfOf("Slow page", `<!doctype html><html><body><p id="a">A waiting</p><p id="b">B waiting</p><p id="c">C waiting</p><script>setTimeout(() => { a.textContent = "FILLED-AT-800MS"; }, 800); setTimeout(() => { b.textContent = "FILLED-AT-3S"; }, 3000); setTimeout(() => { c.textContent = "FILLED-AT-8S"; }, 8000);</script></body></html>`);
    for (const word of ["FILLED-AT-800MS", "FILLED-AT-3S", "FILLED-AT-8S"]) expect(pdf.text).toContain(word);
    expect(pdf.text).not.toContain("waiting");
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 60_000);
  test("a page still changing when the limit is reached says so, and the answer holds the file back", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Never still", body: `<!doctype html><html><body><p>never still</p><script>setInterval(() => document.body.append("."), 100);</script></body></html>` })).body.id;
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.status).toBe(200);
    expect(r.body.hold).toBe("unfinished");
    expect(r.body.warnings.join(" ")).toContain("still changing");
  }, 60_000);
  test("a PDF of a page whose library cannot be fetched is not stopped for it: paper needs no internet to be read", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "No lib", body: `<!doctype html><html><head><script src="https://cdn.invalid/lib.js"></script></head><body><p>paper words</p></body></html>` })).body.id;
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.status).toBe(200);
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).not.toContain("HTML file");
  }, 60_000);
  test("a calm page is not called unfinished, and costs no wait", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Calm", body: "calm words" })).body.id;
    const started = Date.now();
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.body.hold).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 60_000);
  for (const [name, script] of [
    ["a worker that does nothing", `new Worker(URL.createObjectURL(new Blob(["1"], { type: "text/javascript" })));`],
    ["a worker that answers and is done", `const w = new Worker(URL.createObjectURL(new Blob(["postMessage(2 + 2)"], { type: "text/javascript" }))); w.onmessage = (e) => { document.body.append("SUM " + e.data); w.terminate(); };`],
  ]) test(`${name} is not a page still changing`, async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Worker", body: `<!doctype html><html><body><p>worker words</p><script>${script}</script></body></html>` })).body.id;
    const started = Date.now();
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.body.hold).toBeUndefined();
    expect(r.body.warnings.join(" ")).not.toContain("still changing");
    expect(Date.now() - started).toBeLessThan(11_000);
  }, 60_000);
  test("a page that keeps polling but shows nothing new prints, and is not called unfinished", async () => {
    const id = (await call(server.base, "/api/briefs", { title: "Polls", body: `<!doctype html><html><body><p>polling words</p><script>const again = () => setTimeout(again, 500); again();</script></body></html>` })).body.id;
    const r = await call(server.base, "/api/exports", { page: id, format: "pdf" });
    expect(r.status).toBe(200);
    expect(r.body.hold).toBeUndefined();
  }, 60_000);
  test("a page with a repeating clock prints: the time on it just ticks", async () => {
    const pdf = await pdfOf("Clock", `<!doctype html><html><body><p id="t">0</p><p>clock words</p><script>let n = 0; setInterval(() => { t.textContent = String(++n % 10); }, 1000);</script></body></html>`);
    expect(pdf.text).toContain("clock words");
  }, 60_000);
});

describe.skipIf(!ready)("what paper cannot show, and how it breaks", () => {
  const onPage = (pdf: Pdf, word: string) => words(pdf.path).words.find((w) => w.text.includes(word))?.page;
  test("a tab that is not open is named: real words hidden in the page are said, empty ones are not", async () => {
    const pdf = await pdfOf("Tabs", `<!doctype html><html><head><style>.t { display: none; } .t.on { display: block; }</style></head><body><button>One</button><div class="t on"><p>TAB-ONE-OVERVIEW content.</p></div><div class="t"><p>TAB-TWO-RISKS content here.</p></div><div hidden> </div><template><p>a template</p></template></body></html>`);
    expect(pdf.text).toContain("TAB-ONE-OVERVIEW");
    expect(pdf.text).not.toContain("TAB-TWO-RISKS");
    const said = pdf.warnings.join(" ");
    expect(said).toContain("hidden");
    expect(said).toContain("TAB-TWO-RISKS");
    expect(said).not.toContain("a template");
  }, 60_000);
  test("words loose in a closed <details> are named, not only those in an element", async () => {
    const pdf = await pdfOf("Details", `<!doctype html><html><body><h1>Tabs</h1><details><summary>Open me</summary>Closed section words here</details></body></html>`);
    expect(pdf.warnings.join(" ")).toContain("Closed section words");
    expect(pdf.warnings.join(" ")).not.toContain("Open me");
  }, 60_000);
  test("nothing hidden, nothing said", async () => {
    const pdf = await pdfOf("Plain", "All of it is here.");
    expect(pdf.warnings.join(" ")).not.toContain("hidden");
  }, 60_000);
  test("a long table breaks between rows with its header again; the first page is not left half empty", async () => {
    const rows = Array.from({ length: 90 }, (_, i) => `| row-${i} | words in this row |`).join("\n");
    const pdf = await pdfOf("Long table", `Some words to start.\n\n| HEADCOL | Other |\n| --- | --- |\n${rows}\n\nAFTERTABLE`);
    const pages = pdf.text.split("\f").filter((p) => p.trim());
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[0]).toContain("row-0");
    expect(pages[0]).toContain("row-10");
    expect(pages[1]).toContain("HEADCOL");
    expect(pdf.text).toContain("row-89");
    // No row is cut in two: each row's words stay on one line of one page.
    for (const n of [20, 40, 60]) expect(pdf.text).toMatch(new RegExp(`row-${n}\\s+words in this row`));
  }, 60_000);
  test("a card that fits on a page stays whole; one taller than a page may break", async () => {
    const filler = `<div style="height:800px">start of the page</div>`;
    const card = `<div style="border:1px solid #ccc;border-radius:8px;padding:12px;height:400px;display:flex;flex-direction:column;justify-content:space-between"><b>CARDTOP</b><b>CARDBOTTOM</b></div>`;
    const tall = `<div style="border:1px solid #ccc;height:1400px;display:flex;flex-direction:column;justify-content:space-between"><b>TALLTOP</b><b>TALLBOTTOM</b></div>`;
    const pdf = await pdfOf("Cards", `<!doctype html><html><body>${filler}${card}${tall}</body></html>`);
    expect(onPage(pdf, "CARDTOP")).toBe(onPage(pdf, "CARDBOTTOM"));
    expect(onPage(pdf, "TALLTOP")).not.toBe(onPage(pdf, "TALLBOTTOM"));
    nothingCut(pdf);
  }, 60_000);
  test("nothing repeats over page 1's own title: title, date and number are at the foot of every sheet, the date once on page 1", async () => {
    const long = Array.from({ length: 70 }, (_, i) => `Paragraph ${i} goes on long enough to take up room on the sheet, so that this brief runs on.`).join("\n\n");
    const pdf = await pdfOf("OnceTitle", `| a | b |\n| - | - |\n| 1 | 2 |\n\n${long}`);
    const pages = pdf.text.split("\f").filter((p) => p.trim());
    const lines = pages[0].split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe("OnceTitle");
    expect(lines.at(-1)).toMatch(/^OnceTitle\s+.*\d{4} · 1 of \d$/);
    expect(pages[0].match(new RegExp(String(new Date().getFullYear()), "g"))!.length).toBe(1);
    expect(pages[1].split("\n").map((l) => l.trim()).filter(Boolean).at(-1)).toMatch(/^OnceTitle\s+.*\d{4} · 2 of \d$/);
  }, 60_000);
});

describe.skipIf(!ready)("what a dead server leaves behind", () => {
  test("a print's profile names its owner, and the next print clears those whose owner is dead, however new", async () => {
    const data = join(dir, "dead");
    mkdirSync(data);
    const temp = join(dir, "dead-temp");
    mkdirSync(temp);
    const first = await spawnServer({ cwd: ROOT, env: env(data, { TMPDIR: temp }) });
    const id = (await call(first.base, "/api/briefs", { title: "Slow one", body: `<!doctype html><html><body><p>slow one</p><script>setInterval(() => document.body.append(". "), 100);</script></body></html>` })).body.id;
    call(first.base, "/api/exports", { page: id, format: "pdf" }).catch(() => {});
    const profiles2 = () => readdirSync(temp).filter((f) => f.startsWith("hq-office-print-"));
    for (let i = 0; i < 100 && !profiles2().length; i++) await Bun.sleep(100);
    expect(profiles2().length).toBe(1);
    const name = profiles2()[0];
    const owner = Number(name.match(/^hq-office-print-(\d+)-/)![1]);
    expect(owner).toBeGreaterThan(0);
    process.kill(owner, "SIGKILL");
    await first.stop();
    // The dead print's own Chrome, which can write to its profile until it has gone: the next print comes after that.
    const chromes = () => Bun.spawnSync(["ps", "-A", "-o", "command="], { stdout: "pipe" }).stdout.toString().split("\n").filter((l) => l.includes(temp));
    for (let i = 0; i < 300 && chromes().length; i++) await Bun.sleep(100);
    const second = await spawnServer({ cwd: ROOT, env: env(data, { TMPDIR: temp }) });
    try {
      const plain = (await call(second.base, "/api/briefs", { title: "Plain", body: "plain words" })).body.id;
      expect((await call(second.base, "/api/exports", { page: plain, format: "pdf" })).status).toBe(200);
      // The whole folder, the dead print's profile and this print's own: a profile still being written goes at the second removal, 4 s on.
      for (let i = 0; i < 150 && profiles2().length; i++) await Bun.sleep(100);
      expect({ dead: name, left: profiles2(), chromes: chromes() }).toEqual({ dead: name, left: [], chromes: [] });
    } finally {
      await second.stop();
    }
  }, 90_000);
  test("a Chrome killed mid-print is not blamed on the sandbox", async () => {
    const ask = call(server.base, "/api/exports", { page: (await call(server.base, "/api/briefs", { title: "Killed", body: `<!doctype html><html><body><p>k</p><script>setInterval(() => document.body.append(". "), 100);</script></body></html>` })).body.id, format: "pdf" });
    for (let i = 0; i < 100; i++) {
      const browser = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="], { stdout: "pipe" }).stdout.toString().split("\n").find((l) => l.includes("--remote-debugging-pipe") && l.includes(profiles));
      if (browser) { process.kill(Number(browser.trim().split(/\s+/)[0]), "SIGKILL"); break; }
      await Bun.sleep(100);
    }
    const r = await ask;
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Chrome stopped");
    expect(r.body.error).not.toMatch(/does not allow/);
    expect(r.body.error).toContain("Download the HTML");
  }, 60_000);
});

describe.skipIf(!ready)("a Chrome that cannot start", () => {
  test("says so, leaves nothing behind, and the server stays up well past the time limit", async () => {
    const data = join(dir, "broken");
    mkdirSync(data);
    const notRunnable = join(dir, "not-runnable");
    writeFileSync(notRunnable, "not a program");
    const broken = await spawnServer({ cwd: ROOT, env: env(data, { HUD_CHROME_PATH: notRunnable, HUD_PRINT_TIMEOUT_MS: "1500" }) });
    try {
      const id = (await call(broken.base, "/api/briefs", { title: "x", body: "words" })).body.id;
      const r = await call(broken.base, "/api/exports", { page: id, format: "pdf" });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("Chrome would not start");
      await Bun.sleep(2500);
      expect((await fetch(`${broken.base}/api/state`)).status).toBe(200);
      expect((await call(broken.base, "/api/exports", { page: id, format: "html" })).status).toBe(200);
      await profilesGone();
    } finally {
      await broken.stop();
    }
  }, 40_000);
});

describe.skipIf(!ready)("the guard's names for this machine", () => {
  test("a trailing dot does not make localhost public", async () => {
    const seen: string[] = [];
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { seen.push("connected"); }, data() {} } });
    const pdf = await pdfOf("Dots", `<!doctype html><html><head><link rel="stylesheet" href="https://localhost.:${listener.port}/a.css"></head><body><p>dot page</p><img src="https://localhost.:${listener.port}/x"><img src="https://localhost:${listener.port}/y"></body></html>`);
    listener.stop(true);
    expect(pdf.text).toContain("dot page");
    expect(seen).toEqual([]);
    expect(pdf.warnings.join(" ")).toContain("refused");
  }, 60_000);
  test("a script-made link does not put this server's address in the PDF", async () => {
    const pdf = await pdfOf("Links", `<!doctype html><html><body><p>links <a id="a">rel</a> <svg width="50" height="20"><a xlink:href="foo"><text y="15">svg</text></a></svg> <a href="https://example.com/keep">web</a></p><script>document.getElementById("a").setAttribute("href", "foo/bar");</script></body></html>`);
    const bytes = new TextDecoder("latin1").decode(await Bun.file(pdf.path).arrayBuffer());
    expect(bytes).not.toContain("127.0.0.1");
    expect(bytes).not.toContain("exports/print");
    expect(bytes).toContain("example.com/keep");
  }, 60_000);
});

describe.skipIf(!ready)("the PDF, for reading", () => {
  test("a markdown brief: title and date on every page, code and wide tables whole, secret masked", async () => {
    const long = Array.from({ length: 70 }, (_, i) => `Paragraph ${i} goes on long enough to take up room on the sheet, so that this brief runs over several pages of paper.`).join("\n\n");
    const body = `## Plan\n\nKey: ${SECRET}\n\n\`\`\`ts\nconst veryLongLine = "this code line runs far past the right edge of any sheet of paper because nobody wrapped it, ENDOFLONGLINE";\n\`\`\`\n\n| a | b | c | d | e | f | g | h | i | j | k | l | m | n |\n| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |\n| alpha-alpha-alpha | bravo-bravo-bravo | charlie-charlie | delta-delta-delta | echo-echo-echo | foxtrot-foxtrot | golf-golf-golf | hotel-hotel | india-india | juliet-juliet | kilo-kilo | lima-lima | mike-mike | ENDOFWIDETABLE |\n\n${long}\n\nENDOFBRIEF`;
    const pdf = await pdfOf(`Reading test ${SECRET}`, body);
    expect(pdf.pages).toBeGreaterThanOrEqual(3);
    expect(pdf.text).toContain("ENDOFLONGLINE");
    expect(pdf.text).toContain("ENDOFWIDETABLE");
    expect(pdf.text).toContain("ENDOFBRIEF");
    expect(pdf.text).not.toContain(SECRET);
    expect(pdf.info).not.toContain(SECRET);
    expect(pdf.text.split("\f").filter((p) => p.trim()).every((p) => p.includes("Reading test") && p.includes(String(new Date().getFullYear())) && / of \d/.test(p))).toBe(true);
    nothingCut(pdf);
    // The table is shrunk on its own, so the text keeps its size: this stayed on upright pages.
    expect(pdf.info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+/);
  }, 60_000);
  test("a page wider than any sheet turns sideways and shrinks, and says so when it is small", async () => {
    const pdf = await pdfOf("Wide", `<!doctype html><html><body style="margin:0"><div style="width:2400px;display:flex;justify-content:space-between"><span>LEFTMARK</span><span>RIGHTMARK</span></div></body></html>`);
    expect(pdf.text).toContain("LEFTMARK");
    expect(pdf.text).toContain("RIGHTMARK");
    expect(pdf.info).toMatch(/Page size:\s+841\.\d+ x 595\.\d+/);
    expect(pdf.warnings.join(" ")).toContain("wider than a sheet");
    nothingCut(pdf);
  }, 60_000);
  test("a scroll box and a full-height app shell print all they hold", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `<p>row ${i}</p>`).join("");
    const wideCode = "x".repeat(40) + " " + "word ".repeat(100) + "CODEEND";
    const pdf = await pdfOf("Shell", `<!doctype html><html><head><style>html, body { height: 100%; margin: 0; overflow: hidden; } main { height: 100vh; overflow-y: auto; } .code { max-width: 300px; overflow-x: auto; white-space: nowrap; }</style></head><body><main><pre class="code">${wideCode}</pre>${rows}<p>SHELLEND</p></main></body></html>`);
    expect(pdf.pages).toBeGreaterThanOrEqual(3);
    expect(pdf.text).toContain("SHELLEND");
    expect(pdf.text).toContain("CODEEND");
    nothingCut(pdf);
  }, 60_000);
  test("a page with no title, or one that blanks it, does not name the PDF after this server's address", async () => {
    const pdf = await pdfOf("Fallback title", `<!doctype html><html><head><title>x</title></head><body><p>words</p><script>document.title = "";</script></body></html>`);
    expect(pdf.info).toContain("Fallback title");
    expect(pdf.info).not.toContain("127.0.0.1");
    expect(new TextDecoder("latin1").decode(await Bun.file(pdf.path).arrayBuffer())).not.toContain("127.0.0.1");
  }, 60_000);
  test("a brief prints light whatever the screen, and a page with a dark look of its own does too", async () => {
    const pdf = await pdfOf("Themes", `<!doctype html><html><head><style>body { background: white; color: black; } @media (prefers-color-scheme: dark) { body { background: black; color: white; } } [data-theme="dark"] body { background: black; }</style></head><body><p>light words</p></body></html>`);
    const prefix = join(dir, `theme-${++n}`);
    Bun.spawnSync(["pdftoppm", "-r", "20", "-gray", "-f", "1", "-l", "1", pdf.path, prefix]);
    const file = readdirSync(dir).find((f) => f.startsWith(`theme-${n}`))!;
    const data = readFileSync(join(dir, file));
    const mean = data.subarray(40).reduce((a: number, b: number) => a + b, 0) / (data.length - 40);
    expect(mean).toBeGreaterThan(230);
  }, 60_000);
  test("the Parity Lab page: chart, diagram, fonts from a CDN, and its runtime checks report honestly", async () => {
    const lab = await Bun.file(join(ROOT, "scripts/parity-lab/template.html")).text();
    const pdf = await pdfOf("Parity Lab", lab.replaceAll("__PACE__", `{"days":["2026-11-01"],"counts":[3]}`));
    expect(pdf.pages).toBeGreaterThanOrEqual(3);
    expect(pdf.text).toContain("How a page is shown");
    expect(pdf.text).toContain('the host rendered the diagram');
    expect(pdf.text).toContain("Release pace");
    expect(pdf.text).toContain("gave nothing");
    nothingCut(pdf);
  }, 90_000);
});
