// BRIEF EXPORT, what a page cannot do to the server the question panel depends on: the check and the file run on its one
// thread, so no page may hold it up, whatever it is made of. On a server of its own: on the old code a page here stops it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "hq-export-limits-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const api = async (path: string, body: object, headers: Record<string, string> = {}, ms = 60_000) => {
  const r = await fetch(`${server.base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  return { status: r.status, body: await r.json() as any };
};
const brief = async (body: string) => (await api("/api/briefs", { title: "Big", body }, { "x-hud-pane": "w1:p1" })).body.id as number;
const page = (body: string) => `<!doctype html><html><head><title>Big</title></head><body>${body}</body></html>`;
const check = (id: unknown) => api("/api/exports/check", { page: id });
const SLUG = "limits-room";
const inRoom = async (name: string, text: string) => {
  writeFileSync(join(dir, "rooms", SLUG, "files", name), text);
  const key = `rooms/${SLUG}/files/${name}`;
  for (let i = 0; i < 100 && (await check(key)).status !== 200; i++) await Bun.sleep(50);
  return key;
};

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HUD_SUBS_HOME: mkdtempSync(join(dir, "subs-")), HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_CHROME_PATH: "/nonexistent/chrome" } });
  await api("/api/lanes", { name: "limits-lane", machine: "local" });
  await api("/api/floors", { id: "crm", name: "CRM floor", hq: "hq-crm" });
  await api("/api/sync", {});
  await api("/api/rooms", { slug: SLUG, title: "Limits", owner: "limits-lane" });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const TOO_MANY = "too many links";

describe("a page with too many links", () => {
  const N = 100_000;
  for (const [name, body] of [
    ["distinct links", Array.from({ length: N }, (_, i) => `<a href="f${i}.html">y</a>`).join("")],
    ["distinct pictures", Array.from({ length: N }, (_, i) => `<img src="p${i}.png">`).join("")],
    ["distinct addresses in a style", `<style>${Array.from({ length: N }, (_, i) => `.a{background:url(u${i})}`).join("")}</style>`],
    ["distinct addresses on elements", Array.from({ length: N }, (_, i) => `<p style="background:url(u${i})">y</p>`).join("")],
    ["distinct addresses in one srcset", `<img srcset="${Array.from({ length: N }, (_, i) => `s${i}.png 1x`).join(", ")}">`],
  ]) test(`${name}: the check says so, and no file is made in either format`, async () => {
    const id = await brief(page(body));
    const said = await check(id);
    expect(said.status).toBe(200);
    expect(said.body.stop).toContain(TOO_MANY);
    expect(said.body.warnings).toEqual([]);
    for (const format of ["html", "pdf"]) {
      const r = await api("/api/exports", { page: id, format });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(TOO_MANY);
      expect(r.body.url).toBeUndefined();
    }
  }, 60_000);
  test("so does a stylesheet in the room's folder", async () => {
    writeFileSync(join(dir, "rooms", SLUG, "files", "many.css"), Array.from({ length: N }, (_, i) => `.a{background:url(u${i})}`).join(""));
    const key = await inRoom("uses-many.html", page(`<link rel="stylesheet" href="many.css">`));
    expect((await check(key)).body.stop).toContain(TOO_MANY);
  }, 60_000);
  for (const [name, body] of [
    ["31,000 uses of one symbol", `<svg><symbol id="d"><path/></symbol>${`<use href="#d"/>`.repeat(31_000)}</svg>`],
    ["15,100 rows with two links", Array.from({ length: 15_100 }, (_, i) => `<tr><td><a href="https://e.example/${i}">a</a></td><td><a href="#r${i}">b</a></td></tr>`).join("")],
    ["31,000 inputs", "<input>".repeat(31_000)],
    ["31,000 comments", "<!-- x -->".repeat(31_000)],
    ["31,000 elements with a style", `<b style="color:red">x</b>`.repeat(31_000)],
    ["100,000 of the same link", `<a href="x">y</a>`.repeat(100_000)],
    ["100,000 links on the web", Array.from({ length: 100_000 }, (_, i) => `<a href="https://e.example/${i}">y</a>`).join("")],
    ["100,000 frames written inside", `<iframe srcdoc="x"></iframe>`.repeat(100_000)],
  ]) test(`${name} is not too many: none of them is looked up, or only one`, async () => {
    const id = await brief(page(body));
    expect((await check(id)).body.stop).toBeUndefined();
    expect((await api("/api/exports", { page: id, format: "html" })).status).toBe(200);
  }, 60_000);
  test("a page exactly at the limit is exported, one over is not", async () => {
    const distinct = (n: number) => `<!doctype html><html><body>${Array.from({ length: n }, (_, i) => `<a href="f${i}.html">y</a>`).join("")}</body></html>`;
    const limit = Number((await check(await brief(distinct(N)))).body.stop.match(/[\d,]+/)[0].replaceAll(",", ""));
    expect(limit).toBeGreaterThan(5_000);
    expect(limit).toBeLessThan(N);
    expect((await check(await brief(distinct(limit)))).body.stop).toBeUndefined();
    expect((await check(await brief(distinct(limit + 1)))).body.stop).toContain(TOO_MANY);
  }, 60_000);
  test("hud says so, and writes nothing", async () => {
    const id = await brief(page(Array.from({ length: N }, (_, i) => `<a href="f${i}.html">y</a>`).join("")));
    const cwd = mkdtempSync(join(dir, "cli-"));
    const r = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "brief", "export", String(id), "--html"], { cwd, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(TOO_MANY);
    expect(new Bun.Glob("*").scanSync(cwd).toArray()).toEqual([]);
  }, 60_000);
});

describe("a page too big to read", () => {
  const MB = 1024 * 1024, TOO_BIG = "too big to export";
  const sized = (bytes: number) => { const shell = page(""); return page("x".repeat(bytes - shell.length)); };
  test("over 20 MB: the check says so, no file is made in either format, and hud writes nothing", async () => {
    const key = await inRoom("over.html", page("<p>x</p>"));
    writeFileSync(join(dir, "rooms", SLUG, "files", "over.html"), sized(20 * MB + 1));
    const said = await check(key);
    expect(said.status).toBe(200);
    expect(said.body.stop).toContain(TOO_BIG);
    expect(said.body.stop).toContain("20 MB");
    expect(said.body.warnings).toEqual([]);
    for (const format of ["html", "pdf"]) {
      const r = await api("/api/exports", { page: key, format });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(TOO_BIG);
    }
    const cwd = mkdtempSync(join(dir, "cli-"));
    const r = Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), "brief", "export", key, "--html"], { cwd, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: "" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(TOO_BIG);
    expect(new Bun.Glob("*").scanSync(cwd).toArray()).toEqual([]);
  }, 60_000);
  test("exactly 20 MB is exported", async () => {
    const key = await inRoom("at.html", page("<p>x</p>"));
    writeFileSync(join(dir, "rooms", SLUG, "files", "at.html"), sized(20 * MB));
    expect((await check(key)).body.stop).toBeUndefined();
    expect((await api("/api/exports", { page: key, format: "html" })).status).toBe(200);
  }, 60_000);
  test("the owner's floor is still asked about first: another floor hears that it is not theirs", async () => {
    const key = await inRoom("over-floor.html", page("<p>x</p>"));
    writeFileSync(join(dir, "rooms", SLUG, "files", "over-floor.html"), sized(20 * MB + 1));
    const other = await api("/api/exports/check", { page: key }, { "x-hud-pane": "w1:p2" });
    expect(other.status).toBe(400);
    expect(other.body.error).toContain("not yours");
  }, 60_000);
});

describe("the floor is asked first", () => {
  const OTHER = { "x-hud-pane": "w1:p2" };
  test("another floor is refused while the owner's checks of that big page wait their turn, and costs none", async () => {
    const key = await inRoom("waited.html", page("<p>plain words in a very long page</p>\n".repeat(500_000)));
    const order: string[] = [];
    const owners = Array.from({ length: 4 }, () => check(key).then((r) => { order.push("owner"); return r; }));
    const other = api("/api/exports/check", { page: key }, OTHER).then((r) => { order.push("other"); return r; });
    const made = api("/api/exports", { page: key, format: "html" }, OTHER).then((r) => { order.push("other"); return r; });
    const [refused, refusedMake] = await Promise.all([other, made]);
    await Promise.all(owners);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("not yours");
    expect(refused.body.warnings).toBeUndefined();
    expect(refusedMake.body.error).toContain("not yours");
    // One turn may already be running when they arrive, and nothing runs alongside it. They wait for no other.
    expect(order.lastIndexOf("other")).toBeLessThanOrEqual(2);
  }, 120_000);
  test("its answer is the same whatever the page's size: refused, before reading it", async () => {
    const small = await inRoom("floor-small.html", page("<p>x</p>"));
    const big = await inRoom("floor-big.html", page("<p>x</p>"));
    writeFileSync(join(dir, "rooms", SLUG, "files", "floor-big.html"), page("x".repeat(25 * 1024 * 1024)));
    const [a, b] = await Promise.all([small, big].map((k) => api("/api/exports/check", { page: k }, OTHER)));
    expect(a.body.error?.replace("floor-small", "")).toBe(b.body.error?.replace("floor-big", ""));
    expect(a.status).toBe(400);
  }, 60_000);
  test("--all still passes, and a page that does not exist says so", async () => {
    const id = await brief(page("<p>x</p>"));
    expect((await api("/api/exports/check", { page: id }, { ...OTHER, "x-hud-floor": "all" })).status).toBe(200);
    expect((await check("briefs/999999")).body.error).toBe("no brief #999999");
    expect((await check(`rooms/no-such-room/files/x.html`)).status).toBe(400);
  });
});

describe("the HUD answers throughout", () => {
  const pinged = async (work: () => Promise<unknown>) => {
    let done = false, worst = 0;
    const pinging = (async () => {
      while (!done) {
        const t = performance.now();
        await (await fetch(`${server.base}/api/state`)).arrayBuffer();
        worst = Math.max(worst, performance.now() - t);
        await Bun.sleep(5);
      }
    })();
    await work();
    done = true;
    await pinging;
    return worst;
  };
  test("while five checks of a page with a great many links are asked for", async () => {
    const id = await brief(page(Array.from({ length: 170_000 }, (_, i) => `<a href="f${i}.html">y</a>`).join("")));
    const worst = await pinged(() => Promise.all(Array.from({ length: 5 }, () => check(id))));
    expect(worst).toBeLessThan(5000);
  }, 180_000);
  test("while eight big scripts are looked at", async () => {
    const script = `<script>/* import */ ${"var aaaaaaaa = 1;\n".repeat(130_000)}</script>`;
    const key = await inRoom("scripts.html", page(script.repeat(8)));
    const worst = await pinged(() => check(key));
    expect(worst).toBeLessThan(3000);
  }, 180_000);
});

// Last: on the old code, each of these stops the server, and what comes after waits on it.
describe("a small page cannot stop the server: what is searched is searched once", () => {
  const K = 100_000;
  const quick = async (body: string, path = "/api/exports/check", more: object = {}) => {
    const id = await brief(body);
    const t = performance.now();
    const r = await api(path, { page: id, ...more }, {}, 10_000);
    expect(r.status).toBe(200);
    expect(performance.now() - t).toBeLessThan(5000);
    return r;
  };
  test("an address in a style with spaces and no end", () => quick(page(`<style>a{b:url(${" ".repeat(K)}x}</style>`)), 20_000);
  test("addresses in a style with no end", () => quick(page(`<style>${"url(".repeat(K)}</style>`)), 20_000);
  test("addresses on an element with no end", () => quick(page(`<p style="${"url(".repeat(K)}">x</p>`)), 20_000);
  test("a srcset of nothing but commas", () => quick(page(`<img srcset="${",".repeat(K)}">`)), 20_000);
  test("a srcset of nothing but spaces", () => quick(page(`<img srcset="${" ".repeat(K)}">`)), 20_000);
  test("a srcset of one address and commas", () => quick(page(`<img srcset="a.png${",".repeat(K)}">`)), 20_000);
  test("meta tags with no end", () => quick(page("<meta ".repeat(K))), 20_000);
  test("a file made of a diagram and script tags with no end", () => quick(page(`<div class="mermaid">x</div>${"<script ".repeat(K)}`), "/api/exports", { format: "html" }), 40_000);
});

describe("addresses in a style, and sets of them, read as before", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const b64 = PNG.toString("base64");
  const file = async (body: string) => {
    const r = await api("/api/exports", { page: await inRoom(`s-${Math.random().toString(36).slice(2)}.html`, page(body)), format: "html" });
    return { ...r.body, text: await (await fetch(`${server.base}${r.body.url}`)).text() } as { warnings: string[]; text: string };
  };
  test("quoted, unquoted, spaced, and a name holding a space or a bracket", async () => {
    for (const name of ["pl ain.png", "br(ack)et.png", "qu'ote.png"]) writeFileSync(join(dir, "rooms", SLUG, "files", name), PNG);
    writeFileSync(join(dir, "rooms", SLUG, "files", "plain.png"), PNG);
    for (const css of [`url(plain.png)`, `url( plain.png )`, `URL("plain.png")`, `url( 'plain.png' )`, `url("pl ain.png")`, `url("br(ack)et.png")`, `url("qu'ote.png")`]) {
      const { text } = await file(`<style>.a{background:${css}}</style>`);
      expect(text).toContain(`url("data:image/png;base64,${b64}")`);
    }
  }, 30_000);
  test("what cannot be read as an address stays as it was, and a data: address stays", async () => {
    expect((await file(`<style>.a{background:url(a b.png)}</style>`)).text).toContain("url(a b.png)");
    expect((await file(`<style>.a{background:url(data:image/png;base64,AAAA)}</style>`)).text).toContain("url(data:image/png;base64,AAAA)");
  }, 30_000);
  test("a srcset keeps its sizes, its commas in an address, and takes in a file of this room", async () => {
    const { text } = await file(`<img srcset="plain.png 1x, https://e.example/a,b.png 2x,https://e.example/c.png 3x, data:image/png;base64,AAAA 4x">`);
    expect(text).toContain(`data:image/png;base64,${b64} 1x`);
    expect(text).toContain("https://e.example/a,b.png 2x");
    expect(text).toContain("https://e.example/c.png 3x");
    expect(text).toContain("data:image/png;base64,AAAA 4x");
  }, 30_000);
  test("a page's own viewport tag is left alone, and one is added to a page without", async () => {
    const own = (await file(`<meta name="viewport" content="width=500"><p>x</p>`)).text;
    expect(own).toContain("width=500");
    expect(own).not.toContain("viewport-fit=cover");
    expect((await file(`<p>x</p>`)).text).toContain("viewport-fit=cover");
  }, 30_000);
});
