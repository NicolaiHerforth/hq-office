// MERGE (the ship tab) walked as the owner uses it, with 60 PRs from a stub gh: real mouse, touch and key input (CDP
// Input), every way in and out (the tab, a reload, a group opened and closed, a PR opened, MERGE N's confirm with Esc,
// Enter, the scrim, NOT NOW, a line unticked and yes, an unchecked PR's own confirm, one press and its UNDO, a reload
// inside the hold, another tab inside it, SEND BACK and its UNDO, an idle lane's name, DONE), at desktop and phone
// width, and beside NEEDS YOU (a question stays one tap away), MESSAGES (one line per press) and floors (scope and SHOW
// ALL). A click lands only where the owner could click: the point must hit the element. Needs Chrome; skipped without
// it. Nothing reaches the real gh.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";
import { fileShips, prOf, shaOf, shipEnv, shipSettled } from "../ship-seed.ts";
import { counts, groups, idle, idleOn, stuck, stuckOn, verdict } from "../../src/client/ship/model.js";
import { WIDEST_COUNTS } from "../mobile-walk.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const COUNT = 60;
const dir = mkdtempSync(join(tmpdir(), "hq-ship-walk-"));
for (const d of ["data", "subs"]) mkdirSync(join(dir, d));
const LANES: [string, string, string][] = [["alpha", "w1:p3", ""], ["bravo", "w1:p4", ""], ["crm-lane", "w1:p5", "crm"]];
const herdr = fakeHerdr(join(dir, "herdr"), [
  { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" },
  { name: "hq-crm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" },
  { name: "alpha", agent_status: "idle", pane_id: "w1:p3", agent: "claude" },
  { name: "bravo", agent_status: "working", pane_id: "w1:p4", agent: "claude" },
  { name: "crm-lane", agent_status: "idle", pane_id: "w1:p5", agent: "claude" },
]);
const ship = shipEnv(dir, COUNT);
const DOMAINS = ["billing", "checkout ui", "search", "infra", "docs"].map((d) => `d:${d}`);
// Every domain open, as the owner's own choice; the tab starts with every group folded.
const OPEN = { "hq-qtab": "ship", "hq-merge-open": JSON.stringify([...DOMAINS, "low", "done"]) };

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
let askId = 0;
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ tab: document.querySelector("#qtabs .tab.on")?.dataset.qtab, confirm: !document.querySelector(".mcf")?.hidden, rows: document.querySelectorAll("#ship [data-pr]").length })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}${await clickLog(ev)}`);
};
const post = async (p: string, b: object, pane?: string) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane, "x-hud-machine": "local" } : {}) }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const state = async () => (await (await fetch(`${server.base}/api/state`)).json()) as { ship?: { items: any[]; done: any[] }; lanes: any[]; open: any[] };
const shipItems = async () => (await state()).ship?.items ?? [];

async function load(o: { w?: number; h?: number; mobile?: boolean; stored?: Record<string, string> } = {}) {
  const { w = 1280, h = 900, mobile = false, stored = {} } = o;
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await page.s("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: 5 });
  await page.s("Page.navigate", { url: "about:blank" });
  const seed = await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === top && location.protocol === "http:") { sessionStorage.clear(); localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(stored)})) localStorage.setItem(k, v); }` });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await ready();
  await page.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: seed.identifier });
}
// Every feature has run (MENU's theme is set last) and a state came; then the mouse moves until the page has seen it,
// so the first real click is not dropped.
async function ready() {
  await until(`document.readyState === "complete" && !!document.getElementById("lastNote")?.innerHTML && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`);
  await ev(`window.__moved = false; addEventListener("mousemove", () => { window.__moved = true; }, { once: true }); true`);
  for (let i = 0; i < 40 && !(await ev(`window.__moved`)); i++) { await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5 + i, y: 5 }); await Bun.sleep(25); }
}
async function point(sel: string, scroll = true) {
  await settled(ev, sel);
  const at = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return "missing";
    ${scroll ? `e.scrollIntoView({ block: "center" });` : ""}
    const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot click ${sel}: ${at}`);
  return at as [number, number];
}
// The page takes no press inside 600 ms of putting a button where the pointer is (the second click of a double click):
// the walk presses on purpose, so no sooner than a person who reads and aims. Double presses are sent by twice().
let pressed = 0;
const paced = async () => { const wait = pressed + 650 - Date.now(); if (wait > 0) await Bun.sleep(wait); };
async function clickAt([x, y]: [number, number]) {
  await paced();
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  pressed = Date.now();
}
const touch = async ([x, y]: [number, number]) => {
  await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
async function tapAt(at: [number, number]) {
  await paced();
  await touch(at);
  pressed = Date.now();
}
async function click(sel: string, scroll = true) {
  const at = await point(sel, scroll);
  await aimed(ev, sel, at[0], at[1], "aim");
  await clickAt(at);
  await aimed(ev, sel, at[0], at[1], "pressed");
}
async function tap(sel: string, scroll = true) {
  const at = await point(sel, scroll);
  await aimed(ev, sel, at[0], at[1], "aim");
  await tapAt(at);
  await aimed(ev, sel, at[0], at[1], "pressed");
}
async function key(k: string, code: number, text?: string) {
  await page.s("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
  await page.s("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
}
const esc = () => key("Escape", 27);
const enterKey = () => key("Enter", 13, "\r");
const type = (text: string) => page.s("Input.insertText", { text });
// On screen and not covered: the middle of SEL hits SEL.
const shows = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) / 2 + Math.min(r.bottom, innerHeight) / 2); return !!hit && (hit === e || e.contains(hit)); })()`;
const onTab = (t: string) => `document.querySelector("#qtabs .tab.on")?.dataset.qtab === ${JSON.stringify(t)}`;
const merges = () => ship.gh.merges();
const merged = (from: number) => merges().slice(from).map((c) => `${c[c.indexOf("--repo") + 1]}#${c[2]}`);
const ref = (it: any) => `${it.repo}#${it.number}`;
const row = (id: number) => `#ship [data-pr="${id}"]`;
const listed = (g: string) => ev(`[...document.querySelectorAll('#ship [data-g="${g}"] [data-pr]')].map((e) => Number(e.dataset.pr))`) as Promise<number[]>;
const topOf = (sel: string) => ev(`Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top)`) as Promise<number>;
const tagText = () => ev(`[document.getElementById("qtShipReady"), document.getElementById("qtShipUrgent")].map((t) => t.hidden ? "" : t.textContent)`) as Promise<string[]>;
const expectTags = (items: any[]) => { const c = counts(items); return [c.ready || c.check ? String(c.ready || c.check) : "", c.urgent ? `!${c.urgent}` : ""]; };
// A domain group with at least N ready PRs, and those PRs, in model.js's order.
async function domainWith(n: number) {
  const g = groups(await shipItems()).find((x) => x.key.startsWith("d:") && x.items.filter((it: any) => verdict(it).can === "merge").length >= n);
  if (!g) throw new Error(`no domain with ${n} ready`);
  return { key: g.key, rd: g.items.filter((it: any) => verdict(it).can === "merge") };
}
// What the page posts to /api/ship/..., as the server receives it: [path, body] from now until the next load.
const capturePosts = () => ev(`(() => { window.__posts = []; const f = window.fetch; window.fetch = (u, o) => { if (String(u).startsWith("/api/ship/")) window.__posts.push([String(u), JSON.parse(o?.body ?? "{}")]); return f(u, o); }; return true; })()`);
const posts = (path: string) => ev(`window.__posts.filter((p) => p[0] === ${JSON.stringify(path)}).map((p) => p[1])`) as Promise<any[]>;
// Every text SEL ever showed from now on (a MutationObserver), so a state that lasts a moment is seen too.
const recordTexts = (sel: string) => ev(`(() => { const seen = (window.__seen = new Set()); const look = () => { for (const e of document.querySelectorAll(${JSON.stringify(sel)})) seen.add(e.textContent.trim()); }; look(); new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true }); return true; })()`);
const texts = () => ev(`[...window.__seen]`) as Promise<string[]>;
// PRs of this test's own, filed from alpha's pane and read from the fake GitHub: [repo, number, fields, sorter's answer].
async function fileNew(prs: [string, number, Record<string, any>, { domain: string; urgency: string; why: string }][], urgent?: string) {
  const w = ship.gh.world();
  for (const [repo, n, f] of prs) w.repos[repo].prs[String(n)] = { ...prOf(0), sha: shaOf(n), title: `PR ${n} of this test`, ...f };
  ship.gh.setWorld(w);
  const answer = join(dir, "sorter", "answer.json");
  writeFileSync(answer, JSON.stringify({ ...JSON.parse(readFileSync(answer, "utf8")), ...Object.fromEntries(prs.map(([repo, n, , a]) => [`${repo}#${n}`, a])) }));
  for (const [repo, n] of prs) await post("/api/ship", { url: `https://github.com/${repo}/pull/${n}`, ...(urgent ? { urgent } : {}) }, "w1:p3");
  let got: any[] = [];
  for (const end = Date.now() + 30_000; Date.now() < end && !(got.length === prs.length && got.every((x) => x.gh && x.sorted)); await Bun.sleep(150)) got = (await shipItems()).filter((x) => prs.some(([repo, n]) => x.repo === repo && x.number === n));
  if (got.length !== prs.length) throw new Error("the new PRs did not settle");
  return prs.map(([repo, n]) => got.find((x) => x.repo === repo && x.number === n));
}
// A group of this test's own in acme/api, one PR per entry of FIELDS (ready unless they say otherwise), and the
// tab with that group open. The walk's earlier tests merge what the seed made ready.
let nextPr = 400;
async function ownGroup(domain: string, fields: Record<string, any>[]) {
  const its = await fileNew(fields.map((f) => ["acme/api", nextPr++, f, { domain, urgency: "NORMAL", why: "" }]));
  return { key: `d:${domain}`, its, stored: { "hq-qtab": "ship", "hq-merge-open": JSON.stringify([`d:${domain}`, "check"]) } };
}
// GitHub says something new about PR N of REPO: the server reads it 2 s after a filing, so the PR is filed again as it was.
async function ghSays(repo: string, n: number, fields: Record<string, any>, urgent?: string) {
  ship.gh.setPr(repo, n, fields);
  await post("/api/ship", { url: `https://github.com/${repo}/pull/${n}`, ...(urgent ? { urgent } : {}) }, "w1:p3");
}
// Waits until gh has merged more than FROM, then a little longer, so a second merge would have shown.
async function mergedOnce(from: number, ms = 12_000) {
  for (const end = Date.now() + ms; Date.now() < end && merges().length === from; await Bun.sleep(100));
  await Bun.sleep(2000);
  return merged(from);
}

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: join(dir, "data"), HERDR_BIN: herdr.bin, HUD_SUBS_HOME: join(dir, "subs"), HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_OWNER: "Tester", HUD_SHIP_HOLD_MS: "5000", ...ship.env } });
  await post("/api/sync", {});
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  for (const [name, pane, floor] of LANES) await post("/api/lanes", { name, title: "Fix bugs", phase: "running", machine: "local", pane, ...(floor ? { floor } : {}) });
  await post("/api/sync", {});
  askId = (await post("/api/asks", { lane: "bravo", kind: "action", title: "Rotate the staging keys" })).id;
  await fileShips(post, COUNT, "w1:p1", LANES.map(([n, p]) => [n, p]));
  await shipSettled(server.base, COUNT);
  chrome = await startChrome();
  page = await newSession(chrome.cdp, errors);
  // Web fonts arrive at their own time and move what a click aimed at: the walk runs without them.
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
}, 120_000);
afterAll(async () => {
  await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
  await chrome?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("the tab says MERGE; its counts and the top line are model.js's; GitHub is read once on opening; nothing is drawn off the tab", async () => {
  await load();
  const items = await shipItems(), c = counts(items);
  expect(await ev(onTab("questions"))).toBe(true);
  expect(await ev(`document.querySelector('[data-qtab="ship"]').firstChild.textContent.trim()`)).toBe("MERGE");
  expect(await tagText()).toEqual(expectTags(items));
  expect(await ev(`document.querySelector("#ship .mgs").childElementCount`)).toBe(0);
  const reads = ship.gh.reads().length;
  await click('[data-qtab="ship"]');
  await until(`${onTab("ship")} && !!document.querySelector("#ship .sum")`);
  for (const end = Date.now() + 8000; Date.now() < end && ship.gh.reads().length === reads; await Bun.sleep(100));
  expect(ship.gh.reads().length).toBe(reads + 1);
  // the answer first: ready, then what is left to check and what is not ready, in words
  expect(await ev(`document.querySelector("#ship .sum .n").textContent`)).toBe(String(c.ready));
  const of = await ev(`document.querySelector("#ship .sum .of").textContent`);
  expect(of).toContain(`${c.check} more to check yourself`);
  // the seed has PRs waiting on an agent, on a review and on checks
  expect(of).toContain(`${c.wait} are not ready: an agent, a reviewer or a check has the next move.`);
  expect(c.ready + c.check + c.wait).toBe(COUNT);
  // who is idle until he merges, with how many
  expect(await ev(`[...document.querySelectorAll("#ship .idler[data-jump]")].map((b) => [b.dataset.jump, Number(b.children[1].textContent)])`)).toEqual(idle(items, (await state()).lanes).map((x) => [x.lane, x.count]));
  // URGENT first and open, each domain folded with its MERGE N, CHECK THESE YOURSELF after them, then DONE
  const heads = await ev(`[...document.querySelectorAll("#ship [data-g]")].map((g) => [g.dataset.g, g.querySelectorAll("[data-pr]").length, g.querySelector("[data-all]")?.textContent ?? ""])`);
  expect(heads.map((h: any) => h[0])).toEqual([...groups(items).map((g) => g.key), "done"]);
  expect(heads[0][1]).toBeGreaterThan(0);
  for (const g of groups(items).filter((x) => !x.one)) {
    const n = g.items.filter((it) => verdict(it).can === "merge").length;
    expect(heads.find((h: any) => h[0] === g.key)).toEqual([g.key, 0, n ? `MERGE ${n}` : ""]);
  }
  // out and back in, and a reload: GitHub is not read twice in 30 s
  await click('[data-qtab="questions"]');
  await until(`${onTab("questions")} && document.querySelector("#ship .mgs").childElementCount === 0 && ${shows(`#hud [data-ask="${askId}"]`)}`);
  await click('[data-qtab="ship"]');
  await until(`${onTab("ship")} && !!document.querySelector("#ship .sum")`);
  await page.s("Page.reload");
  await ready();
  await until(`${onTab("ship")} && !!document.querySelector("#ship .sum")`);
  await Bun.sleep(500);
  expect(ship.gh.reads().length).toBe(reads + 1);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("a group opens and closes and stays as he left it across a reload; a PR opens and closes, by click and by key", async () => {
  await load({ stored: { "hq-qtab": "ship" } });
  const { key: g } = await domainWith(1);
  await click(`#ship [data-g="${g}"] [data-fold]`);
  await until(`document.querySelectorAll('#ship [data-g="${g}"] [data-pr]').length > 0`);
  await page.s("Page.reload");
  await ready();
  await until(`document.querySelectorAll('#ship [data-g="${g}"] [data-pr]').length > 0`);
  const id = (await listed(g))[0];
  await click(`${row(id)} .t`);
  await until(`!!document.querySelector('${row(id)}.open .d .ref a[href^="https://github.com/"]')`);
  expect(await ev(`document.activeElement === document.querySelector('${row(id)}')`)).toBe(true);
  await key("Enter", 13);
  await until(`!document.querySelector('${row(id)}.open')`);
  await key(" ", 32);
  await until(`!!document.querySelector('${row(id)}.open')`);
  await click(`${row(id)} .t`);
  await until(`!document.querySelector('${row(id)}.open')`);
  await click(`#ship [data-g="${g}"] [data-fold]`);
  await until(`document.querySelectorAll('#ship [data-g="${g}"] [data-pr]').length === 0`);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("a phone: MERGE N's confirm is the HUD's sheet; NOT NOW and a tap outside merge nothing", async () => {
  await load({ w: 390, h: 844, mobile: true, stored: OPEN });
  await until(`!!document.querySelector("#ship [data-all]")`);
  const from = merges().length;
  await tap("#ship [data-all]");
  await until(`!!document.querySelector(".mcf.sheet") && ${shows(".mcf [data-no]")}`);
  expect(await ev(`document.activeElement === document.querySelector(".mcf")`)).toBe(true);
  await tap(".mcf [data-no]");
  await until(`document.querySelector(".mcf").hidden && !document.querySelector(".sheet")`);
  await tap("#ship [data-all]");
  await until(`!!document.querySelector(".mcf.sheet")`);
  await tapAt([195, 20]);
  await until(`document.querySelector(".mcf").hidden && !document.querySelector(".sheet")`);
  expect(merges().length).toBe(from);
  expect(await ev(`document.scrollingElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("MERGE N: the confirm lists the ready ones in the column; Enter, Esc, the scrim and NOT NOW merge nothing; an unticked line stays behind", async () => {
  await load({ stored: OPEN });
  const { key: g, rd } = await domainWith(2);
  const from = merges().length;
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  // in the desk column; the focus on the confirm, not on its green button
  expect(await ev(`(() => { const c = document.querySelector(".mcf").getBoundingClientRect(), d = document.querySelector(".desk").getBoundingClientRect(); return c.left >= d.left && c.right <= d.right && c.bottom <= d.bottom; })()`)).toBe(true);
  expect(await ev(`document.activeElement === document.querySelector(".mcf")`)).toBe(true);
  expect(await ev(`[...document.querySelectorAll(".mcf [data-pick]")].map((e) => Number(e.dataset.pick))`)).toEqual(rd.map((it: any) => it.id));
  expect(await ev(`document.querySelector(".mcf [data-yes]").textContent`)).toBe(`MERGE ${rd.length}`);
  await enterKey();
  await Bun.sleep(400);
  expect(merges().length).toBe(from);
  await esc();
  await until(`document.querySelector(".mcf").hidden`);
  await until(`document.activeElement === document.querySelector('#ship [data-g="${g}"] [data-all]')`);
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-no]"));
  await click(".mcf [data-no]");
  await until(`document.querySelector(".mcf").hidden`);
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  await clickAt(await ev(`(() => { const r = document.querySelector(".mscrim").getBoundingClientRect(); return [r.left + 20, r.top + 20]; })()`));
  await until(`document.querySelector(".mcf").hidden`);
  expect(merges().length).toBe(from);
  // untick the second line: the button counts what is left, and only the ticked ones merge
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  const out = rd[1];
  await click(`.mcf [data-pick="${out.id}"]`);
  await until(`document.querySelector(".mcf [data-yes]").textContent === "MERGE ${rd.length - 1}" && document.querySelector('.mcf [data-pick="${out.id}"]').closest("li").classList.contains("out")`);
  expect(await ev(`document.querySelector(".mcf .rest").textContent`)).toContain("1 you left out");
  expect(await ev(`document.querySelector(".mcf .rest").textContent`)).toContain("can only be reverted on GitHub");
  await click(".mcf [data-yes]");
  const want = rd.filter((it: any) => it.id !== out.id);
  await until(want.map((it: any) => `document.querySelector('${row(it.id)}.gone .mark')?.textContent === "MERGED✓"`).join(" && "), 20_000);
  expect(merged(from).sort()).toEqual(want.map(ref).sort());
  for (const c of merges().slice(from)) { expect(c).toContain("--match-head-commit"); expect(c).not.toContain("--auto"); }
  // the one left out is still there, ready, and is the group's MERGE 1
  expect(await ev(`!!document.querySelector('${row(out.id)}:not(.gone)')`)).toBe(true);
  await until(`document.querySelector('#ship [data-g="${g}"] [data-all]')?.textContent === "MERGE 1"`);
  // MESSAGES: one line for the group, not one per PR
  await click('[data-qtab="messages"]');
  await until(`[...document.querySelectorAll("#msgs [data-msg]")].filter((m) => m.textContent.includes("merged ${want.length} in")).length === 1`);
  expect(errors).toEqual([]);
}, 90_000);

test.skipIf(!chromeFound)("a PR nothing checked never merges with its group: it asks first, NOT NOW merges nothing, MERGE IT merges that one only", async () => {
  await load({ stored: OPEN });
  const check = groups(await shipItems()).find((g) => g.key === "check")!;
  expect(check.items.length).toBeGreaterThan(0);
  // no group's confirm lists a PR from the check pile
  const { key: g } = await domainWith(1);
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  const picks: number[] = await ev(`[...document.querySelectorAll(".mcf [data-pick]")].map((e) => Number(e.dataset.pick))`);
  expect(picks.some((id) => check.items.some((it) => it.id === id))).toBe(false);
  const look = `(() => { const s = getComputedStyle(document.querySelector(".mcf [data-yes]")); return [s.backgroundColor, s.borderColor]; })()`;
  const green = await ev(look);
  await esc();
  await until(`document.querySelector(".mcf").hidden`);
  const it = check.items[0];
  const from = merges().length;
  await click(`${row(it.id)} [data-ask]`);
  await until(`${shows(".mcf [data-yes]")} && document.querySelector("#mcfh").textContent === "MERGE THIS ONE UNCHECKED?"`);
  expect(await ev(`document.querySelector(".mcf .rest.warn").textContent`)).toContain("nothing has tested it");
  // its MERGE IT does not look like a group's green MERGE N in the same place: a hand used to those does not press it by habit
  const risky = await ev(look);
  expect([risky[0] === green[0], risky[1] === green[1]]).toEqual([false, false]);
  await click(".mcf [data-no]");
  await until(`document.querySelector(".mcf").hidden`);
  expect(merges().length).toBe(from);
  await click(`${row(it.id)} [data-ask]`);
  await until(shows(".mcf [data-yes]"));
  await click(".mcf [data-yes]");
  await until(`document.querySelector('${row(it.id)}.gone .mark')?.textContent === "MERGED✓"`);
  expect(await mergedOnce(from)).toEqual([ref(it)]);
}, 60_000);

test.skipIf(!chromeFound)("one press shows UNDO where the button was; UNDO means no merge; left alone it merges once and DONE lists it", async () => {
  await load({ stored: OPEN });
  const it = (await domainWith(1)).rd[0], from = merges().length;
  await click(`${row(it.id)} .t`);
  await click(`${row(it.id)} .d [data-merge]`);
  await until(`!!document.querySelector('${row(it.id)} .d [data-undo]') && /MERGING/.test(document.querySelector('${row(it.id)} .d .heldb').textContent)`);
  expect((await shipItems()).find((x) => x.id === it.id).hold.verb).toBe("merge");
  await click(`${row(it.id)} .d [data-undo]`);
  await until(`!!document.querySelector('${row(it.id)} .d [data-merge]')`);
  expect((await shipItems()).find((x) => x.id === it.id).hold).toBeNull();
  await Bun.sleep(6000);
  expect(merges().length).toBe(from);
  await click(`${row(it.id)} .d [data-merge]`);
  await until(`!!document.querySelector('${row(it.id)} [data-undo]')`);
  await until(`document.querySelector('${row(it.id)}.gone .mark')?.textContent === "MERGED✓"`);
  expect(await mergedOnce(from)).toEqual([ref(it)]);
  await until(`[...document.querySelectorAll('#ship [data-g="done"] .dr a')].some((a) => a.href === ${JSON.stringify(it.url)})`);
  expect(errors).toEqual([]);
}, 60_000);

// The second click of a double click (or the second tap of a double tap) lands where the first one did, on whatever
// took the button's place: it must not undo what the first one did, nor do it again.
test.skipIf(!chromeFound)("a double click or a double tap merges once: what takes a button's place ignores the second press; a deliberate UNDO after that still takes it back", async () => {
  const twice = async (sel: string, by: "click" | "tap") => {
    const at = await point(sel);
    await (by === "tap" ? tapAt(at) : clickAt(at));
    await Bun.sleep(180);
    if (by === "tap") await touch(at);
    else for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 2 });
    pressed = Date.now();
  };
  const holdOf = async (id: number) => (await shipItems()).find((x) => x.id === id)?.hold ?? null;
  await load({ stored: OPEN });
  const urgent = groups(await shipItems()).find((g) => g.key === "urgent")!.items;
  const [u0, u1] = urgent.filter((it) => verdict(it).can === "merge"), auto = urgent.find((it) => verdict(it).can === "auto")!;
  expect([!!u0, !!u1, !!auto]).toEqual([true, true, true]);
  // MERGE in its row, double clicked: one merge; the row keeps its height through the hold and after, so nothing under
  // the pointer moves
  const tall = (id: number) => ev(`Math.round(document.querySelector('${row(id)}').getBoundingClientRect().height)`) as Promise<number>;
  let from = merges().length;
  const h0 = await tall(u0.id);
  await twice(`${row(u0.id)} .side [data-merge]`, "click");
  expect(await tall(u0.id)).toBe(h0);
  expect(await mergedOnce(from)).toEqual([ref(u0)]);
  await until(`!!document.querySelector('${row(u0.id)}.gone')`);
  expect(await tall(u0.id)).toBe(h0);
  // MERGE WHEN CHECKS PASS, double clicked: auto-merge turned on once
  from = merges().length;
  await twice(`${row(auto.id)} .side [data-later]`, "click");
  expect(await mergedOnce(from)).toEqual([ref(auto)]);
  expect(merges().at(-1)).toContain("--auto");
  // MERGE N, double clicked: the confirm that opened under the pointer stays open, every line ticked, nothing merged
  const { key: g, rd } = await domainWith(1);
  from = merges().length;
  await twice(`#ship [data-g="${g}"] [data-all]`, "click");
  await until(shows(".mcf [data-yes]"));
  await Bun.sleep(400);
  expect(await ev(`[...document.querySelectorAll(".mcf [data-pick]")].map((e) => e.checked)`)).toEqual(rd.map(() => true));
  expect(merges().length).toBe(from);
  await esc();
  await until(`document.querySelector(".mcf").hidden`);
  // UNDO pressed on purpose takes it back; the second click of a double click on UNDO does not press MERGE again
  from = merges().length;
  await click(`${row(u1.id)} .side [data-merge]`);
  await until(`!!document.querySelector('${row(u1.id)} .side [data-undo]')`);
  await Bun.sleep(800);
  await twice(`${row(u1.id)} .side [data-undo]`, "click");
  await until(`!!document.querySelector('${row(u1.id)} .side [data-merge]')`);
  await Bun.sleep(6000);
  expect(await holdOf(u1.id)).toBeNull();
  expect(merges().length).toBe(from);
  // SEND BACK's own button, double clicked: it goes back, and is not taken back by its UNDO
  const back = groups(await shipItems()).find((g) => g.key.startsWith("d:"))!.items.find((x) => verdict(x).pile === "wait")!;
  await click(`${row(back.id)} .t`);
  await click(`${row(back.id)} [data-back]`);
  await until(`document.activeElement === document.querySelector('${row(back.id)} [data-backform] textarea')`);
  await type("Not like this.");
  await twice(`${row(back.id)} [data-backform] .send`, "click");
  await until(`document.querySelector('${row(back.id)}.gone .mark')?.textContent === "SENT BACK"`, 12_000);
  // a phone: MERGE in an opened row, double tapped: one merge
  await load({ w: 390, h: 844, mobile: true, stored: OPEN });
  const [d] = (await domainWith(1)).rd;
  await tap(`${row(d.id)} .t`);
  await until(`!!document.querySelector('${row(d.id)} .d [data-merge]')`);
  from = merges().length;
  const h1 = await tall(d.id);
  await twice(`${row(d.id)} .d [data-merge]`, "tap");
  expect(await mergedOnce(from)).toEqual([ref(d)]);
  await until(`!!document.querySelector('${row(d.id)}.gone')`);
  expect(await tall(d.id)).toBe(h1);
  expect(errors).toEqual([]);
}, 150_000);

test.skipIf(!chromeFound)("a reload inside the hold still shows UNDO with the time left and the merge happens once; another tab neither sends it early nor loses it", async () => {
  await load({ stored: OPEN });
  const [a, b] = (await domainWith(2)).rd, from = merges().length;
  await click(`${row(a.id)} .t`);
  await click(`${row(a.id)} .d [data-merge]`);
  await until(`!!document.querySelector('${row(a.id)} [data-undo]')`);
  await page.s("Page.reload");
  await ready();
  await until(`!!document.querySelector('${row(a.id)} .side [data-undo]')`);
  const delay = await ev(`parseFloat(document.querySelector('${row(a.id)} [data-undo]').style.animationDelay)`);
  expect(delay).toBeLessThan(0);
  expect(delay).toBeGreaterThan(-5000);
  expect(await mergedOnce(from)).toEqual([ref(a)]);
  // MERGE, then another tab at once: nothing is sent before the hold runs out, and it runs once
  const mid = merges().length;
  await click(`${row(b.id)} .t`);
  await click(`${row(b.id)} .d [data-merge]`);
  await until(`!!document.querySelector('${row(b.id)} [data-undo]')`);
  await click('[data-qtab="messages"]');
  await Bun.sleep(1500);
  expect(merges().length).toBe(mid);
  expect(await mergedOnce(mid)).toEqual([ref(b)]);
  await click('[data-qtab="ship"]');
  await until(`!document.querySelector('${row(b.id)}')`);
  expect(errors).toEqual([]);
}, 90_000);

test.skipIf(!chromeFound)("SEND BACK: Esc and CANCEL close the box; sent, UNDO brings the note back; sent and left alone, it leaves and DONE keeps the note", async () => {
  await load({ stored: OPEN });
  const it = groups(await shipItems()).find((g) => g.key.startsWith("d:"))!.items.find((x) => verdict(x).pile === "wait")!;
  await click(`${row(it.id)} .t`);
  await click(`${row(it.id)} [data-back]`);
  await until(`document.activeElement === document.querySelector('${row(it.id)} [data-backform] textarea')`);
  await esc();
  await until(`!document.querySelector('${row(it.id)} [data-backform]') && !!document.querySelector('${row(it.id)} [data-back]')`);
  await click(`${row(it.id)} [data-back]`);
  await until(`!!document.querySelector('${row(it.id)} [data-backform]')`);
  expect(await ev(`document.querySelector('${row(it.id)} [data-backform] .send').disabled`)).toBe(true);
  await click(`${row(it.id)} [data-cancel]`);
  await until(`!document.querySelector('${row(it.id)} [data-backform]')`);
  await click(`${row(it.id)} [data-back]`);
  await until(`document.activeElement === document.querySelector('${row(it.id)} [data-backform] textarea')`);
  await type("Split the migration out first.");
  await enterKey(); // a new line, not a send
  await type("Then file it again.");
  expect((await shipItems()).find((x) => x.id === it.id).hold).toBeNull();
  await click(`${row(it.id)} [data-backform] .send`);
  await until(`!!document.querySelector('${row(it.id)} [data-undo]') && document.querySelector('${row(it.id)} .d .note')?.textContent.includes("Split the migration out first.")`);
  expect((await shipItems()).find((x) => x.id === it.id).hold.verb).toBe("back");
  await click(`${row(it.id)} [data-undo]`);
  await until(`document.querySelector('${row(it.id)} [data-backform] textarea')?.value === "Split the migration out first.\\nThen file it again."`);
  await click(`${row(it.id)} [data-backform] .send`);
  await until(`document.querySelector('${row(it.id)}.gone .mark')?.textContent === "SENT BACK"`);
  expect((await shipItems()).some((x) => x.id === it.id)).toBe(false);
  expect(await ev(`document.querySelector('${row(it.id)} .d .note').textContent`)).toContain("Split the migration out first.");
  await until(`[...document.querySelectorAll('#ship [data-g="done"] .dr')].some((d) => d.textContent.includes("SENT BACK") && d.textContent.includes("Split the migration out first."))`);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("Idle until you merge: a name opens the groups where that lane's PRs are, marks exactly them and brings the first into view", async () => {
  await load({ stored: { "hq-qtab": "ship" } });
  const items = await shipItems(), lanes = (await state()).lanes;
  const [first] = idle(items, lanes);
  expect(first).toBeTruthy();
  const want = groups(items).flatMap((g) => g.items).filter((it) => idleOn(it, lanes) === first.lane).map((it) => it.id);
  expect(want.length).toBe(first.count);
  await click(`#ship .idler[data-jump="${first.lane}"]`);
  await until(`document.querySelectorAll("#ship .r.hl").length > 0`);
  expect(await ev(`[...document.querySelectorAll("#ship .r.hl")].map((e) => Number(e.dataset.pr))`)).toEqual(want);
  expect(await ev(shows(`#ship .r.hl`))).toBe(true);
  const g = groups(items).find((x) => x.items.some((it) => it.id === want[0]))!;
  // the next press ends the pointing
  await click(`#ship [data-g="${g.key}"] .r.hl .t`, false);
  await until(`document.querySelectorAll("#ship .r.hl").length === 0`);
}, 60_000);

test.skipIf(!chromeFound)("nothing moves under the pointer: a group merged above leaves the rows under it where they were", async () => {
  await load({ stored: OPEN });
  const { key: g, rd } = await domainWith(1);
  const keys = groups(await shipItems()).map((x) => x.key);
  const last = (await listed(keys.at(-1)!)).at(-1)!;
  await ev(`document.querySelector('${row(last)}').scrollIntoView({ block: "end" }), true`);
  await Bun.sleep(300);
  const was = await topOf(row(last));
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  await ev(`document.querySelector('${row(last)}').scrollIntoView({ block: "end" }), true`);
  await Bun.sleep(200);
  const before = await topOf(row(last));
  await click(".mcf [data-yes]", false);
  await until(rd.map((it: any) => `!!document.querySelector('${row(it.id)}.gone')`).join(" && "), 20_000);
  await Bun.sleep(1500); // the state after the merge, and GitHub's read
  expect(await topOf(row(last))).toBe(before);
  expect(was).toBeGreaterThan(0);
}, 60_000);

test.skipIf(!chromeFound)("floors: inside a floor MERGE lists and counts that floor's; SHOW ALL lists every floor's, each row with its floor's stripe", async () => {
  await load({ stored: OPEN });
  const all = await shipItems(), crm = all.filter((x) => x.floor === "crm");
  expect(crm.length).toBeGreaterThan(0);
  expect(await ev(`[...document.querySelectorAll("#ship [data-pr]")].every((e) => e.querySelector(".fstripe"))`)).toBe(true);
  await click('.ftile[data-floor="crm"] .tgo');
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await until(`(() => { const ids = [...document.querySelectorAll("#ship [data-pr]")].map((e) => Number(e.dataset.pr)); return ids.length > 0 && ids.every((id) => ${JSON.stringify(crm.map((x) => x.id))}.includes(id)); })()`);
  expect(await ev(`document.querySelectorAll("#ship .fstripe").length`)).toBe(0);
  expect(await tagText()).toEqual(expectTags(crm));
  expect(await ev(`document.querySelector("#ship .sum .n").textContent`)).toBe(String(counts(crm).ready || counts(crm).check || "✓"));
  await click(".scoperow [data-scope-all]");
  await until(`[...document.querySelectorAll("#ship [data-pr]")].some((e) => !${JSON.stringify(crm.map((x) => x.id))}.includes(Number(e.dataset.pr))) && !!document.querySelector("#ship .fstripe")`);
  expect(await tagText()).toEqual(expectTags(await shipItems()));
  await click(".scoperow [data-scope-all]");
  await until(`document.querySelectorAll("#ship .fstripe").length === 0`);
  await click(".scoperow [data-scope-out]");
  await until(`document.querySelector(".stage").dataset.floors === "building" && !!document.querySelector("#ship .fstripe")`);
}, 60_000);

test.skipIf(!chromeFound)("a phone: a title with bold and code reads as one block of text, two lines at most, with no sideways scroll", async () => {
  await load({ w: 390, h: 844, mobile: true, stored: OPEN });
  await until(`[...document.querySelectorAll("#ship .r .t")].some((t) => t.querySelector("code") && t.querySelector("strong, b"))`);
  const t = await ev(`(() => {
    const t = [...document.querySelectorAll("#ship .g:not(.one) .r:not(.open) .t")].find((t) => t.querySelector("code") && t.querySelector("strong, b"));
    t.scrollIntoView({ block: "center" });
    const r = t.getBoundingClientRect(), line = parseFloat(getComputedStyle(t).lineHeight);
    return { flows: !/flex|grid/.test(getComputedStyle(t).display), inline: [...t.children].every((c) => getComputedStyle(c).display === "inline"), lines: Math.round(r.height / line), wide: r.width > 180 };
  })()`);
  expect(t).toEqual({ flows: true, inline: true, lines: 2, wide: true });
  expect(await ev(`document.scrollingElement.scrollWidth <= document.documentElement.clientWidth`)).toBe(true);
}, 60_000);

test.skipIf(!chromeFound)("a phone, MERGE open and scrolled: the open question is one tap away and its count shows; a toast never covers the tab row", async () => {
  const id = (await post("/api/asks", { lane: "bravo", kind: "action", title: "Approve the new pricing copy" })).id;
  await load({ w: 390, h: 844, mobile: true, stored: OPEN });
  await until(`document.querySelectorAll("#ship [data-pr]").length > 20`);
  await ev(`scrollTo(0, 3000), true`);
  await Bun.sleep(300);
  const n = (await state()).open.length;
  expect(await ev(shows('[data-qtab="questions"]'))).toBe(true);
  expect(await ev(`(() => { const t = document.getElementById("qtCount"), r = t.getBoundingClientRect(); return !t.hidden && t.textContent === "${n}" && r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
  // a toast, on any tab: under the tab row, clear of the tabs and their counts
  await ev(`import("/src/client/core/dom.js").then((m) => m.toast("A TOAST WHILE MERGE IS SCROLLED."))`);
  await until(`!!document.querySelector(".toast")`);
  expect(await ev(`(() => { const t = document.querySelector(".toast").getBoundingClientRect(), q = document.getElementById("qtabs").getBoundingClientRect(); return t.top > q.bottom && t.bottom <= innerHeight; })()`)).toBe(true);
  await tap('[data-qtab="questions"]', false);
  await until(`${onTab("questions")} && ${shows(`#hud [data-ask="${id}"]`)}`);
  expect(errors).toEqual([]);
}, 60_000);

test.skipIf(!chromeFound)("the tab row fits whole, no scroll and no fade, at 1180, 1280 and 1440 wide with every count at its widest", async () => {
  // measured in the page's own pixel font: the fallback is narrower and would fit anything
  await page.s("Network.setBlockedURLs", { urls: [] });
  try {
    for (const w of [1180, 1280, 1440]) {
      await load({ w, h: 900 });
      await ev(`document.fonts.ready.then(() => true)`);
      expect(await ev(`[...document.fonts].some((f) => /Press Start 2P/.test(f.family) && f.status === "loaded")`)).toBe(true);
      await ev(`${WIDEST_COUNTS}, dispatchEvent(new Event("resize")), true`);
      const r = await ev(`(() => { const q = document.getElementById("qtabs"), b = q.getBoundingClientRect(); return { over: q.scrollWidth - q.clientWidth, out: [...q.querySelectorAll("[data-qtab]")].filter((t) => { const r = t.getBoundingClientRect(); return r.left < b.left - 0.5 || r.right > b.right + 0.5 || t.scrollWidth > t.clientWidth; }).map((t) => t.dataset.qtab), fade: q.classList.contains("more-r") || q.classList.contains("more-l") }; })()`);
      expect({ w, ...r }).toEqual({ w, over: 0, out: [], fade: false });
    }
  } finally {
    await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  }
}, 60_000);

test.skipIf(!chromeFound)("MERGE keeps its place: another tab and back, it is where it was, on a desktop and on a phone", async () => {
  await load({ stored: OPEN });
  await until(`document.querySelectorAll("#ship [data-pr]").length > 20`);
  await ev(`document.querySelector("#ship .mgs").scrollTop = 900, true`);
  await Bun.sleep(200);
  const top = await ev(`document.querySelector("#ship .mgs").scrollTop`);
  expect(top).toBeGreaterThan(600);
  await click('[data-qtab="messages"]', false);
  await until(onTab("messages"));
  await click('[data-qtab="ship"]', false);
  await until(`${onTab("ship")} && document.querySelectorAll("#ship [data-pr]").length > 20`);
  expect(Math.abs((await ev(`document.querySelector("#ship .mgs").scrollTop`)) - top)).toBeLessThanOrEqual(2);
  await load({ w: 390, h: 844, mobile: true, stored: OPEN });
  await until(`document.querySelectorAll("#ship [data-pr]").length > 20`);
  await ev(`scrollTo(0, 2500), true`);
  await Bun.sleep(300);
  const first = Number(await ev(`[...document.querySelectorAll("#ship [data-pr]")].find((e) => e.getBoundingClientRect().top > 120)?.dataset.pr`));
  const was = await topOf(row(first));
  await tap('[data-qtab="work"]', false);
  await until(onTab("work"));
  await tap('[data-qtab="ship"]', false);
  await until(`${onTab("ship")} && document.querySelectorAll("#ship [data-pr]").length > 20`);
  await Bun.sleep(300);
  expect(Math.abs((await topOf(row(first))) - was)).toBeLessThanOrEqual(2);
}, 60_000);


// Stuck, nobody moving: not his move, and whoever has it is idle, or it needs a review on GitHub. The top says so,
// beside who is idle until he merges, and never that nothing waits on him while any is stuck.
test.skipIf(!chromeFound)("stuck, nobody moving: the top names who, each name marks exactly those PRs; with nothing to merge and something stuck it never says nothing waits on him", async () => {
  await load({ stored: { "hq-qtab": "ship" } });
  const items = await shipItems(), lanes = (await state()).lanes, s = stuck(items, lanes);
  expect([s.lanes.length > 0, s.review > 0]).toEqual([true, true]);
  expect(await ev(`[...document.querySelectorAll("#ship .sum .stuck .idler")].map((b) => b.textContent)`)).toEqual([...s.lanes.map((l) => `${l.lane}${l.count}↓`), `${s.review} ${s.review === 1 ? "needs" : "need"} a review on GitHub↓`]);
  const inOrder = (pick: (it: any) => boolean) => groups(items).flatMap((g) => g.items).filter(pick).map((it) => it.id);
  for (const [sel, want] of [
    [`[data-stuck="lane"][data-lane="${s.lanes[0].lane}"]`, inOrder((it) => stuckOn(it, lanes) === "lane" && it.lane === s.lanes[0].lane)],
    [`[data-stuck="review"]`, inOrder((it) => stuckOn(it, lanes) === "review")],
  ] as [string, number[]][]) {
    await click(`#ship .sum ${sel}`);
    await until(`document.querySelectorAll("#ship .r.hl").length === ${want.length}`);
    expect(await ev(`[...document.querySelectorAll("#ship .r.hl")].map((e) => Number(e.dataset.pr))`)).toEqual(want);
    expect(await ev(shows(row(want[0])))).toBe(true);
  }
  // a floor with nothing to merge: one PR behind main whose lane is idle, one that needs a review
  herdr.world([...herdr.agents(), { name: "hq-ops", agent_status: "idle", pane_id: "w1:p6", agent: "claude" }, { name: "golf", agent_status: "idle", pane_id: "w1:p7", agent: "claude" }]);
  await post("/api/sync", {});
  await post("/api/floors", { id: "ops", name: "OPS", hq: "hq-ops" });
  await post("/api/lanes", { name: "golf", title: "Fix bugs", phase: "running", machine: "local", pane: "w1:p7", floor: "ops" });
  await post("/api/sync", {});
  const w = ship.gh.world();
  w.repos["acme/web"].prs["300"] = { ...prOf(0), sha: shaOf(300), title: "Fix the backup job skipping the last table", mergeState: "BEHIND" };
  w.repos["acme/web"].prs["301"] = { ...prOf(0), sha: shaOf(301), title: "Lock the account after ten wrong passwords", mergeState: "BLOCKED", review: "REVIEW_REQUIRED" };
  ship.gh.setWorld(w);
  const answer = join(dir, "sorter", "answer.json");
  writeFileSync(answer, JSON.stringify({ ...JSON.parse(readFileSync(answer, "utf8")), "acme/web#300": { domain: "infra", urgency: "NORMAL", why: "" }, "acme/web#301": { domain: "accounts", urgency: "NORMAL", why: "" } }));
  for (const n of [300, 301]) await post("/api/ship", { url: `https://github.com/acme/web/pull/${n}` }, "w1:p7");
  let ops: any[] = [];
  for (const end = Date.now() + 30_000; Date.now() < end && !(ops.length === 2 && ops.every((x) => x.gh && x.sorted)); await Bun.sleep(150)) ops = (await shipItems()).filter((x) => x.number >= 300);
  expect(ops.map((x: any) => [x.floor, x.lane, verdict(x).why])).toEqual([["ops", "golf", "behind main"], ["ops", "golf", "needs a review"]]);
  await load({ stored: { "hq-qtab": "ship" } });
  await click('.ftile[data-floor="ops"] .tgo');
  // every group starts folded: the names at the top open them
  await until(`document.querySelector(".stage").dataset.floors === "floor" && document.querySelectorAll("#ship [data-g]").length === 3 && document.querySelectorAll("#ship [data-pr]").length === 0`);
  expect(await ev(`document.querySelector("#ship .sum .k").textContent`)).toBe("NOTHING TO MERGE");
  expect(await ev(`document.querySelector("#ship .sum").textContent`)).not.toContain("NOTHING HERE WAITS ON YOU");
  expect(await ev(`document.querySelector("#ship .sum .of").textContent`)).toBe("2 are not ready: an agent or a reviewer has the next move.");
  expect(await ev(`[...document.querySelectorAll("#ship .sum .stuck .idler")].map((b) => b.textContent)`)).toEqual(["golf1↓", "1 needs a review on GitHub↓"]);
  await click(`#ship .sum [data-stuck="lane"][data-lane="golf"]`);
  await until(`[...document.querySelectorAll("#ship .r.hl")].map((e) => Number(e.dataset.pr)).join() === "${ops[0].id}"`);
  expect(await ev(shows(row(ops[0].id)))).toBe(true);
  await click(`#ship .sum [data-stuck="review"]`);
  await until(`[...document.querySelectorAll("#ship .r.hl")].map((e) => Number(e.dataset.pr)).join() === "${ops[1].id}"`);
  expect(await ev(shows(row(ops[1].id)))).toBe(true);
  expect(errors).toEqual([]);
}, 120_000);

// The server applies a group's rules to a group of one: the page says which button sent a merge.
test.skipIf(!chromeFound)("every merge request says what sent it: a group's MERGE N kind group, an unchecked PR's own confirm kind one", async () => {
  const { key: g, stored } = await ownGroup("kinds", [{}]);
  const [check] = (await ownGroup("kinds-check", [{ checks: null }])).its;
  await load({ stored });
  await capturePosts();
  await click(`#ship [data-g="${g}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  await click(".mcf [data-yes]");
  await until(`!document.querySelector('#ship [data-g="${g}"] .act [role=status]')?.textContent.includes("MERGING")`, 20_000);
  await click(`${row(check.id)} [data-ask]`);
  await until(shows(".mcf [data-yes]"));
  await click(".mcf [data-yes]");
  await until(`document.querySelector('${row(check.id)}.gone .mark')?.textContent === "MERGED✓"`, 20_000);
  expect((await posts("/api/ship/merge")).map((b) => b.kind)).toEqual(["group", "one"]);
  expect(errors).toEqual([]);
}, 60_000);

// A held or merging PR is no longer his to merge: the top, the tab and MERGE N leave it out alike and the top says so.
test.skipIf(!chromeFound)("held and merging PRs are counted apart: during the hold the top, the tab and the group's MERGE N agree", async () => {
  const { key: g, its: rd, stored } = await ownGroup("counts", [{}, {}]);
  await load({ stored });
  const top = () => ev(`[document.querySelector("#ship .sum .n").textContent, document.querySelector("#ship .sum .k").textContent, document.getElementById("qtShipReady").textContent, document.querySelector('#ship [data-g="${g}"] [data-all]')?.textContent]`) as Promise<string[]>;
  const [n0, k0, tab0, all0] = await top();
  expect([tab0, k0, all0]).toEqual([n0, "READY TO MERGE", `MERGE ${rd.length}`]);
  await click(`${row(rd[0].id)} .t`);
  await click(`${row(rd[0].id)} .d [data-merge]`);
  await until(`!!document.querySelector('${row(rd[0].id)} [data-undo]')`);
  expect(await top()).toEqual([String(Number(n0) - 1), "READY TO MERGE · 1 merging", String(Number(n0) - 1), `MERGE ${rd.length - 1}`]);
  await until(`document.querySelector('${row(rd[0].id)}.gone .mark')?.textContent === "MERGED✓"`, 20_000);
  expect(await top()).toEqual([String(Number(n0) - 1), "READY TO MERGE", String(Number(n0) - 1), `MERGE ${rd.length - 1}`]);
  expect(errors).toEqual([]);
}, 60_000);

// Past its five seconds a press runs and UNDO is gone: the row says in words that it cannot be taken back now.
test.skipIf(!chromeFound)("past the hold the row says it in words: MERGING · CAN'T BE UNDONE", async () => {
  const { its: [it], stored } = await ownGroup("past", [{}]);
  await load({ stored });
  await click(`${row(it.id)} .t`);
  await recordTexts(`${row(it.id)} .doing`);
  await click(`${row(it.id)} .d [data-merge]`);
  await until(`document.querySelector('${row(it.id)}.gone .mark')?.textContent === "MERGED✓"`, 20_000);
  const seen = await texts();
  expect(seen).toContain("MERGING · CAN'T BE UNDONE");
  expect(seen.filter((t) => t !== "MERGING · CAN'T BE UNDONE")).toEqual(["MERGING…"]);
  expect(errors).toEqual([]);
}, 60_000);

// A press whose answer is lost may still have been taken: the row says so and reads what happened, and never says
// "Not done" while the server holds it. A press the server refused says "Not done" and why.
test.skipIf(!chromeFound)("a hold whose answer is lost says it may have gone through and shows what really happened; a refused one says Not done and why", async () => {
  const { its: [a, b], stored } = await ownGroup("lost", [{}, {}]);
  await load({ stored });
  const answers = (how: "lost" | "refused") => ev(`(() => { const f = window.fetch; window.fetch = (u, o) => !String(u).endsWith("/hold") ? f(u, o) : ${how === "lost" ? `f(u, o).then(() => { throw new TypeError("Failed to fetch"); })` : `Promise.resolve(new Response(JSON.stringify({ error: "it is held already for another verb" }), { status: 409 }))`}; return true; })()`);
  // lost: the server took it, the answer never came
  await click(`${row(a.id)} .t`);
  await recordTexts(`${row(a.id)} .d .err`);
  await answers("lost");
  await click(`${row(a.id)} .d [data-merge]`);
  await until(`window.__seen.has("May have gone through: looking again.") && !!document.querySelector('${row(a.id)} .d [data-undo]') && !document.querySelector('${row(a.id)} .d .err')`);
  expect((await shipItems()).find((x) => x.id === a.id).hold?.verb).toBe("merge");
  expect(await texts()).toEqual(["May have gone through: looking again."]);
  await click(`${row(a.id)} .d [data-undo]`);
  await until(`!!document.querySelector('${row(a.id)} .d [data-merge]')`);
  expect((await shipItems()).find((x) => x.id === a.id).hold).toBeNull();
  // refused: the server said no
  await load({ stored });
  await answers("refused");
  await click(`${row(b.id)} .t`);
  await click(`${row(b.id)} .d [data-merge]`);
  await until(`document.querySelector('${row(b.id)} .d .err')?.textContent === "Not done: it is held already for another verb"`);
  expect(await ev(`!!document.querySelector('${row(b.id)} .d [data-merge]')`)).toBe(true);
  expect((await shipItems()).find((x) => x.id === b.id).hold).toBeNull();
  expect(errors).toEqual([]);
}, 60_000);

// UNDO runs on the server's hold: a device clock a minute off must neither take UNDO away at once nor show it longer.
test.skipIf(!chromeFound)("UNDO's time left is the server's: with the device's clock a minute fast or slow, UNDO is offered for about five seconds", async () => {
  const { its, stored } = await ownGroup("clock", [{}, {}]);
  for (const [skew, it] of [[60_000, its[0]], [-60_000, its[1]]] as [number, any][]) {
    const off = await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `{ const now = Date.now.bind(Date); Date.now = () => now() + ${skew}; }` });
    await load({ stored });
    await page.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: off.identifier });
    expect(Math.abs((await ev(`Date.now()`)) - Date.now() - skew)).toBeLessThan(2000);
    await click(`${row(it.id)} .t`);
    const at = await point(`${row(it.id)} .d [data-merge]`);
    await clickAt(at);
    const t0 = Date.now();
    await until(`!!document.querySelector('${row(it.id)} .d [data-undo]')`, 3000);
    await Bun.sleep(3000 - (Date.now() - t0));
    // three seconds in, UNDO is there and its bar has run out about three fifths of the way
    const ran = await ev(`(() => { const u = document.querySelector('${row(it.id)} .d [data-undo]'); const a = u && document.getAnimations().find((x) => x.animationName === "mrunout" && x.effect.target === u); return a ? a.effect.getComputedTiming().progress : null; })()`);
    expect({ skew, ran: ran > 0.45 && ran < 0.75 }).toEqual({ skew, ran: true });
    await until(`!document.querySelector('${row(it.id)} [data-undo]')`, 8000);
    expect({ skew, gone: Date.now() - t0 }).toEqual({ skew, gone: expect.any(Number) });
    expect(Date.now() - t0).toBeGreaterThan(4000);
    expect(Date.now() - t0).toBeLessThan(6500);
    await until(`document.querySelector('${row(it.id)}.gone .mark')?.textContent === "MERGED✓"`, 20_000);
  }
  expect(errors).toEqual([]);
}, 90_000);

// MERGE N merges what its confirm listed when he pressed it, as it was listed: never a PR that turned ready while it
// was open (that one shows, unticked and marked new), and never a head he did not see.
test.skipIf(!chromeFound)("an open MERGE N confirm merges only what it listed: a PR turning ready meanwhile shows unticked and new, one whose head moved is left out and says so", async () => {
  const sort = { domain: "audit", urgency: "NORMAL", why: "" };
  const [a, b, c, d] = await fileNew([["acme/api", 330, {}, sort], ["acme/api", 331, {}, sort], ["acme/api", 332, {}, sort], ["acme/api", 333, { checks: "PENDING", mergeState: "UNSTABLE" }, sort]]);
  expect([a, b, c, d].map((x) => verdict(x).pile)).toEqual(["ready", "ready", "ready", "wait"]);
  await load({ stored: { "hq-qtab": "ship", "hq-merge-open": JSON.stringify(["d:audit"]) } });
  await click(`#ship [data-g="d:audit"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  expect(await ev(`[...document.querySelectorAll(".mcf [data-pick]")].map((e) => Number(e.dataset.pick))`)).toEqual([a.id, b.id, c.id]);
  const from = merges().length;
  // while it is open: D's checks pass, and B gets a new commit
  await ghSays("acme/api", 333, { checks: "SUCCESS", mergeState: "CLEAN" });
  await ghSays("acme/api", 331, { sha: shaOf(331, 2) });
  for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(150)) {
    const now = await shipItems(), dd = now.find((x) => x.id === d.id), bb = now.find((x) => x.id === b.id);
    if (verdict(dd).pile === "ready" && bb.gh.sha === shaOf(331, 2)) break;
  }
  await until(`document.querySelectorAll(".mcf [data-pick]").length === 4`);
  const lines = await ev(`[...document.querySelectorAll(".mcf li")].map((l) => [Number(l.querySelector("[data-pick]").dataset.pick), l.querySelector("[data-pick]").checked, l.querySelector("[data-pick]").disabled, l.querySelector(".lt")?.textContent ?? ""])`);
  const button = await ev(`document.querySelector(".mcf [data-yes]").textContent`);
  await click(".mcf [data-yes]");
  const went = (await mergedOnce(from)).sort();
  const shas = merges().slice(from).map((m) => m[m.indexOf("--match-head-commit") + 1]).sort();
  expect(went).toEqual([ref(a), ref(c)].sort());
  expect(shas).toEqual([a.gh.sha, c.gh.sha].sort());
  expect(button).toBe("MERGE 2");
  expect(lines).toEqual([[a.id, true, false, ""], [b.id, false, true, "NEW COMMITS · LEFT OUT"], [c.id, true, false, ""], [d.id, false, false, "NEW"]]);
  expect(errors).toEqual([]);
}, 90_000);

test.skipIf(!chromeFound)("a scope change closes an open MERGE N confirm: SHOW ALL lists more, so nothing is merged from a list he did not see", async () => {
  const { key, its: [it], stored } = await ownGroup("scope", [{}]);
  await load({ stored });
  await click(`.ftile[data-floor="${it.floor}"] .tgo`);
  await until(`document.querySelector(".stage").dataset.floors === "floor"`);
  await until(`!!document.querySelector('#ship [data-g="${key}"] [data-all]')`);
  await click(`#ship [data-g="${key}"] [data-all]`);
  await until(shows(".mcf [data-yes]"));
  await ev(`document.querySelector(".scoperow [data-scope-all]").click(), true`);
  await until(`document.querySelector(".mcf").hidden`);
  expect(errors).toEqual([]);
}, 60_000);

// A push that changes the list must not take what he is doing from him: the SEND BACK box keeps every character, its
// selection and a composition under way, and a press that started before the push lands.
test.skipIf(!chromeFound)("a push while he types or presses: SEND BACK keeps every character, the selection and the composition; a click across a push lands", async () => {
  const { its: [it, other], stored } = await ownGroup("typing", [{ checks: "FAILURE" }, { checks: "FAILURE" }]);
  await load({ stored });
  await ev(`(() => { window.__muts = 0; new MutationObserver(() => window.__muts++).observe(document.querySelector("#ship .mgs"), { subtree: true, childList: true, attributes: true, characterData: true }); return true; })()`);
  let busy = false;
  // crm-lane starts or stops working: the top's "Idle until you merge" changes, and the list is drawn again
  const push = async () => {
    const was = await ev(`window.__muts`);
    busy = !busy;
    herdr.world(herdr.agents().map((x: any) => (x.name === "crm-lane" ? { ...x, agent_status: busy ? "working" : "idle" } : x)));
    await post("/api/sync", {});
    await until(`window.__muts > ${was}`);
  };
  await click(`${row(it.id)} .t`);
  await click(`${row(it.id)} [data-back]`);
  const box = `${row(it.id)} [data-backform] textarea`;
  await until(`document.activeElement === document.querySelector('${box}')`);
  await type("Split");
  await push();
  await type(" the");
  await push();
  await type(" migration");
  expect(await ev(`document.querySelector('${box}').value`)).toBe("Split the migration");
  await ev(`document.querySelector('${box}').setSelectionRange(6, 9, "backward"), true`);
  await push();
  expect(await ev(`(() => { const t = document.querySelector('${box}'); return [document.activeElement === t, t.selectionStart, t.selectionEnd, t.selectionDirection]; })()`)).toEqual([true, 6, 9, "backward"]);
  // a composition under way (an input method, or dictation) is still his after a push
  await ev(`(() => { const t = document.querySelector('${box}'); t.setSelectionRange(t.value.length, t.value.length); return true; })()`);
  await page.s("Input.imeSetComposition", { text: " fir", selectionStart: 4, selectionEnd: 4 });
  await push();
  await page.s("Input.insertText", { text: " first" });
  expect(await ev(`document.querySelector('${box}').value`)).toBe("Split the migration first");
  // a press that began before a push ends on the same row: it opens
  await click(`${row(it.id)} [data-cancel]`);
  const at = await point(`${row(other.id)} .t`);
  await paced();
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0], y: at[1] });
  await page.s("Input.dispatchMouseEvent", { type: "mousePressed", x: at[0], y: at[1], button: "left", clickCount: 1 });
  await push();
  await page.s("Input.dispatchMouseEvent", { type: "mouseReleased", x: at[0], y: at[1], button: "left", clickCount: 1 });
  pressed = Date.now();
  await until(`!!document.querySelector('${row(other.id)}.open')`, 3000);
  expect(errors).toEqual([]);
}, 60_000);

// While he aims (the pointer moving over the list, or a touch or a key in it under 1.5 s ago) no row changes its
// place: a push that reorders the list waits until he leaves it or rests, so a press lands on the row he aimed at.
test.skipIf(!chromeFound)("a push never moves a row under the pointer: aiming at an URGENT row while a push reorders the list, the click holds that row", async () => {
  const why = "the nightly export stops halfway";
  const sort = { domain: "export", urgency: "URGENT", why };
  const n = nextPr;
  nextPr += 3;
  const [a, b, c] = await fileNew([["acme/api", n, {}, sort], ["acme/api", n + 1, {}, sort], ["acme/api", n + 2, { checks: "PENDING", mergeState: "UNSTABLE" }, sort]], why);
  await load({ stored: { "hq-qtab": "ship" } });
  const order = () => ev(`[...document.querySelectorAll('#ship [data-g="urgent"] [data-pr]')].map((e) => Number(e.dataset.pr)).filter((id) => [${a.id}, ${b.id}, ${c.id}].includes(id))`) as Promise<number[]>;
  expect(await order()).toEqual([a.id, b.id, c.id]);
  const at = await point(`${row(b.id)} .side [data-merge]`);
  // he aims at B's MERGE; meanwhile A's checks fail and C's pass, so B would take A's place and C B's
  let aiming = true;
  const aim = (async () => { for (let i = 0; aiming; i++) { await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: at[0] + (i % 2), y: at[1] }); await Bun.sleep(150); } })();
  await ghSays("acme/api", n, { checks: "FAILURE" }, why);
  await ghSays("acme/api", n + 2, { checks: "SUCCESS", mergeState: "CLEAN" }, why);
  for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(150)) {
    const now = await shipItems();
    if (verdict(now.find((x) => x.id === a.id)).pile === "wait" && verdict(now.find((x) => x.id === c.id)).pile === "ready") break;
  }
  await until(`!!document.querySelector('${row(c.id)} .side [data-merge]')`);
  await Bun.sleep(500);
  aiming = false;
  await aim;
  await clickAt(at);
  await until(`!!document.querySelector('${row(b.id)} [data-undo]') || !!document.querySelector('${row(c.id)} [data-undo]')`);
  const held = (await shipItems()).filter((x) => [a.id, b.id, c.id].includes(x.id) && x.hold).map((x) => x.id);
  expect(held).toEqual([b.id]);
  await click(`${row(b.id)} [data-undo]`);
  // he leaves the list: the new order comes in
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  await until(`(() => { const ids = [...document.querySelectorAll('#ship [data-g="urgent"] [data-pr]')].map((e) => Number(e.dataset.pr)); return ids.indexOf(${c.id}) < ids.indexOf(${a.id}) && ids.indexOf(${b.id}) < ids.indexOf(${a.id}); })()`);
  expect(errors).toEqual([]);
}, 90_000);

// What he does himself is not held back while he aims: a row he closes takes its closed height at once.
test.skipIf(!chromeFound)("while he aims, a row he opens and closes takes its new height at once", async () => {
  const { its: [it], stored } = await ownGroup("aimed", [{ note: "Opened and closed by the owner." }]);
  await load({ stored });
  const tall = () => ev(`Math.round(document.querySelector('${row(it.id)}').getBoundingClientRect().height)`) as Promise<number>;
  const shut = await tall();
  await click(`${row(it.id)} .t`);
  await until(`!!document.querySelector('${row(it.id)}.open')`);
  expect(await tall()).toBeGreaterThan(shut + 40);
  await click(`${row(it.id)} .t`);
  await until(`!document.querySelector('${row(it.id)}.open')`);
  expect(await tall()).toBe(shut);
  expect(errors).toEqual([]);
}, 60_000);
