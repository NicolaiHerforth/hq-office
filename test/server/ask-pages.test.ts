// ASK PAGES: an ask may carry an HTML page (hud ask --file q.html), served at /asks/ID.html like every page: the
// sandbox policy, the page runtime under the key asks/ID, the reader's theme and secret values masked. hud update ID
// --file replaces it in place. What the owner did in it is read with hud page data asks/ID, and the answer HQ gets says
// so. Markdown asks stay as they were. A stub herdr gives HQ its pane and records what is typed into it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { spawnServer } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { PAGE_CSP } from "../../src/server/pages.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DATA = mkdtempSync(join(tmpdir(), "hq-ask-pages-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let server: Awaited<ReturnType<typeof spawnServer>>;
const post = async (p: string, b: object = {}) => { const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }); return { status: r.status, ...(await r.json()) }; };
const state = async () => (await fetch(`${server.base}/api/state`)).json();
const hud = (args: string[], pane = "w1:p1") => Bun.spawnSync([process.execPath, join(ROOT, "hud.ts"), ...args], { cwd: DATA, env: { ...process.env, HUD_URL: server.base, HERDR_PANE_ID: pane, HUD_LOCAL_MACHINE: "local" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const until = async (ok: () => boolean) => { for (let i = 0; i < 120 && !ok(); i++) await Bun.sleep(25); };
const SECRET = "ask-pages-test-value-7h2q";
const PAGE = `<!doctype html><html><head><title>Rows to delete</title></head><body><h1>Pick rows</h1><p>Token ${SECRET}</p><table><tr><td>row 1</td></tr></table></body></html>`;
const FRAGMENT = `<title>A chart</title><style>body{font:14px sans-serif}</style><svg width="40" height="20"><rect width="40" height="20"/></svg>`;
const bootOf = (html: string) => JSON.parse(html.match(/<script type="application\/json" data-hud-page>(.*?)<\/script>/)![1]);
const file = (name: string, text: string) => { const f = join(DATA, name); writeFileSync(f, text); return f; };

beforeAll(async () => {
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_GH_BIN: "false", HUD_OWNER: "", HUD_HQ_RENAME: "0" } });
  await post("/api/sync");
  await post("/api/secrets", { name: "ASK_PAGES_TEST", value: SECRET, minutes: 60, by: "owner" });
}, 30_000);
afterAll(async () => {
  await server?.stop();
  rmSync(DATA, { recursive: true, force: true });
});

test("which field is the page: a --file or body that is a page; a markdown --file is the body", async () => {
  const ask = async (b: object) => {
    const r = await post("/api/asks", { title: "Which field", ...b });
    if (r.status !== 200) return r.error;
    const s = await state();
    return { body: s.open.find((a: any) => a.id === r.id).body, page: s.askPages[r.id]?.title ?? null };
  };
  expect(await ask({ body: "plain **markdown**" })).toEqual({ body: "plain **markdown**", page: null });
  expect(await ask({ file: PAGE })).toEqual({ body: null, page: "Rows to delete" });
  expect(await ask({ file: FRAGMENT, body: "a lead" })).toEqual({ body: "a lead", page: "A chart" });
  expect(await ask({ body: PAGE })).toEqual({ body: null, page: "Rows to delete" });
  expect(await ask({ file: "# Notes\n\nmarkdown" })).toEqual({ body: "# Notes\n\nmarkdown", page: null });
  expect(await ask({ file: "# md", body: "md too" })).toMatch(/not both/);
  expect(await ask({ file: PAGE, body: PAGE })).toMatch(/once/);
  expect(await ask({ file: `<!doctype html>${"x".repeat(5_000_001)}` })).toMatch(/5 MB/);
});

test("hud ask --file q.html: served sandboxed at /asks/ID.html with the runtime key asks/ID, masked, themed", async () => {
  const p = hud(["ask", "--title", "Which rows go?", "--opt", "Delete them", "--opt", "Keep them", "--rec", "Delete them", "--file", file("q.html", PAGE)]);
  expect(p.stderr.toString()).toBe("");
  const out = p.stdout.toString();
  const id = Number(out.match(/ask #(\d+)/)![1]);
  expect(out).toContain(`#page/asks/${id}`);
  expect(out).toContain(`hud page data asks/${id}`);
  const s = await state();
  const ask = s.open.find((a: any) => a.id === id);
  expect(ask).toMatchObject({ title: "Which rows go?", options: ["Delete them", "Keep them"], recommended: "Delete them", body: null });
  expect(s.askPages[id]).toMatchObject({ title: "Rows to delete" });
  expect(s.askPages[id].lead).toContain("Pick rows");
  expect(JSON.stringify(s)).not.toContain(SECRET);
  expect(JSON.stringify(s)).not.toContain("<table>");

  const r = await fetch(`${server.base}/asks/${id}.html?theme=dark`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
  expect(r.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  const html = await r.text();
  expect(bootOf(html).page).toBe(`asks/${id}`);
  expect(html).toContain('<html data-theme="dark"');
  expect(html).toContain("<h1>Pick rows</h1>");
  expect(html).toContain('"hud-ask-height"');
  expect(html).not.toContain(SECRET);
  // never kept in the database either
  const db = new Database(join(DATA, "hud.db"), { readonly: true });
  expect(JSON.stringify(db.query("SELECT * FROM ask_pages").all())).not.toContain(SECRET);
  db.close();
});

test("a fragment is wrapped like an artifact; asks without a page have none", async () => {
  const { id } = await post("/api/asks", { title: "Chart?", file: FRAGMENT });
  const html = await (await fetch(`${server.base}/asks/${id}.html`)).text();
  expect(html).toMatch(/^<!doctype html>\n<html>\n<head><script type="application\/json" data-hud-page>/);
  expect(html).toContain("<rect");
  const plain = await post("/api/asks", { title: "Plain one", body: "**markdown** body" });
  expect((await fetch(`${server.base}/asks/${plain.id}.html`)).status).toBe(404);
  expect((await fetch(`${server.base}/asks/999999.html`)).status).toBe(404);
});

test("markdown asks are unchanged: the body stays the body, no page", async () => {
  const { id, page } = await post("/api/asks", { title: "Merge it?", body: "Some <b>html</b> in **markdown**", options: ["Yes", "No"] });
  expect(page).toBeUndefined();
  const s = await state();
  expect(s.open.find((a: any) => a.id === id)).toMatchObject({ body: "Some <b>html</b> in **markdown**", options: ["Yes", "No"] });
  expect(s.askPages[id]).toBeUndefined();
  // a markdown --file is the body
  const p = hud(["ask", "--title", "From a file", "--file", file("q.md", "# Heading\n\nmarkdown body")]);
  const mid = Number(p.stdout.toString().match(/ask #(\d+)/)![1]);
  expect(p.stdout.toString()).not.toContain("#page/");
  expect((await state()).open.find((a: any) => a.id === mid).body).toBe("# Heading\n\nmarkdown body");
});

test("hud update ID --file replaces the page in place; the ask and its other fields stay", async () => {
  const { id } = await post("/api/asks", { title: "Layout?", body: "the lead", file: PAGE, options: ["A", "B"] });
  const before = (await state()).askPages[id].at;
  await Bun.sleep(5);
  const p = hud(["update", String(id), "--file", file("q2.html", PAGE.replace("Pick rows", "Pick rows again"))]);
  expect(p.stderr.toString()).toBe("");
  const s = await state();
  expect(s.askPages[id].at).toBeGreaterThan(before);
  expect(s.open.find((a: any) => a.id === id)).toMatchObject({ title: "Layout?", body: "the lead", options: ["A", "B"] });
  expect(s.ledger[id].editedAt).toBeGreaterThan(0);
  expect(await (await fetch(`${server.base}/asks/${id}.html`)).text()).toContain("Pick rows again");
  // a plain ask gets a page the same way
  const plain = await post("/api/asks", { title: "Plain first" });
  expect(hud(["update", String(plain.id), "--file", file("q3.html", FRAGMENT)]).exitCode).toBe(0);
  expect((await fetch(`${server.base}/asks/${plain.id}.html`)).status).toBe(200);
  expect(hud(["update", String(plain.id)]).stderr.toString()).toContain("--file");
});

test("what the owner does in the page is page data under asks/ID; the answer HQ gets says where it is", async () => {
  const { id } = await post("/api/asks", { title: "Delete which rows?", file: PAGE, options: ["Delete the picked rows", "None"] });
  // the HUD's bridge, as it writes for the page in an ask's frame
  expect((await post("/api/page-runtime/db", { page: `asks/${id}`, op: "set", path: "picks/owner", data: { rows: [2, 5] } })).status).toBe(200);
  await post(`/api/asks/${id}/answer`, { answer: "Delete the picked rows" });
  await until(() => herdr.typedInto("hq").some((t) => t.includes(`#${id}`)));
  const typed = herdr.typedInto("hq").find((t) => t.includes(`HUD answer #${id}`))!;
  expect(typed).toBe(`HUD answer #${id}: "Delete which rows?" -> Delete the picked rows (it has a page: what the owner did in it: hud page data asks/${id})`);
  const inbox = await (await fetch(`${server.base}/api/inbox`)).json();
  expect(inbox.answers.find((a: any) => a.id === id).page).toBe(`asks/${id}`);
  const data = hud(["page", "data", `asks/${id}`, "picks"]);
  expect(data.stderr.toString()).toBe("");
  expect(data.stdout.toString()).toContain('"rows"');
  // still served once answered, and still in the state for MESSAGES
  expect((await fetch(`${server.base}/asks/${id}.html`)).status).toBe(200);
  expect((await state()).askPages[id]).toBeTruthy();
  // an answer to a plain ask says nothing about a page
  const plain = await post("/api/asks", { title: "Plain answer" });
  await post(`/api/asks/${plain.id}/answer`, { answer: "yes" });
  await until(() => herdr.typedInto("hq").some((t) => t.includes(`#${plain.id}`)));
  expect(herdr.typedInto("hq").find((t) => t.includes(`HUD answer #${plain.id}`))).toBe(`HUD answer #${plain.id}: "Plain answer" -> yes`);
  expect((await (await fetch(`${server.base}/api/inbox`)).json()).answers.find((a: any) => a.id === plain.id).page).toBeUndefined();
});

test("the page runtime takes asks/ID as a page key, nothing looser", async () => {
  expect((await post("/api/page-runtime/storage", { page: "asks/12", set: { k: "v" } })).status).toBe(200);
  for (const bad of ["asks/x", "asks/1/2", "asks/", "ask/1"]) expect((await post("/api/page-runtime/storage", { page: bad, set: { k: "v" } })).status).toBe(400);
});

test("an ask's page data stays on the ask's floor: hud page data needs --all from another floor", async () => {
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/sync");
  const out = hud(["ask", "--title", "CRM rows?", "--file", file("crm.html", PAGE)], "w1:p2").stdout.toString();
  const id = Number(out.match(/ask #(\d+)/)![1]);
  expect((await state()).open.find((a: any) => a.id === id).floor).toBe("crm");
  expect((await post("/api/page-runtime/db", { page: `asks/${id}`, op: "set", path: "picks/owner", data: { rows: [1] } })).status).toBe(200);
  const refused = hud(["page", "data", `asks/${id}`], "w1:p1");
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain(`ask #${id} is on floor crm, not yours (hq)`);
  expect(hud(["page", "data", `asks/${id}`, "--all"], "w1:p1").stdout.toString()).toContain("picks");
  expect(hud(["page", "data", `asks/${id}`], "w1:p2").stdout.toString()).toContain("picks");
  expect(hud(["page", "data"], "w1:p1").stdout.toString()).not.toContain(`asks/${id} `);
  expect(hud(["page", "data"], "w1:p2").stdout.toString()).toContain(`asks/${id} `);
});
