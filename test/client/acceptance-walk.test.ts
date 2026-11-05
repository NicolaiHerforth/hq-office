// DONE MEANS walked through as the owner uses it, with real mouse and key input (CDP Input), on the real server with
// a fake Linear GraphQL server on a spare port (HUD_LINEAR_API_URL; never the real Linear): a linked room's criteria
// in its rail, SHOW MET, Linear's errors in plain words with the last list kept, linking a room from its quiet line,
// the count on the ROOMS tiles, every way into and out of a room, 0 and 30 items, an archived room, no key, a phone
// and dark mode. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { aimed, clickLog, settled, did } from "../walk-diag.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const KEY = "lin_api_WALKKEY0123456789abcdefSECRET";

// ---- the fake Linear: three projects; "fail" makes every issues query fail with that message ----

type State = "completed" | "started" | "unstarted" | "canceled";
const NAMES: Record<State, string> = { completed: "Done", started: "In Progress", unstarted: "Todo", canceled: "Canceled" };
// N criteria over two milestones and none, the first MET closed, the last canceled when asked.
function issues(n: number, met: number, canceled = false) {
  const third = Math.ceil(n / 3);
  return Array.from({ length: n }, (_, i) => {
    const type: State = i < met ? "completed" : canceled && i === n - 1 ? "canceled" : i % 2 ? "started" : "unstarted";
    const milestone = i < third ? { id: "m1", name: "Foundations", sortOrder: 1 } : i < 2 * third ? { id: "m2", name: "Launch", sortOrder: 2 } : null;
    return { identifier: `ENG-${100 + i}`, title: i === met ? "Works with **SSO**" : `Criterion ${i + 1}`, url: `https://linear.app/acme/issue/ENG-${100 + i}`, updatedAt: "2026-11-05T09:00:00.000Z", state: { name: NAMES[type], type }, projectMilestone: milestone };
  });
}
const project = (slugId: string, name: string, list: ReturnType<typeof issues>) => ({ id: `0b9f4a2e-${slugId}`, slugId, name, url: `https://linear.app/acme/project/${name.toLowerCase().replace(/ /g, "-")}-${slugId}`, issues: list });
const PROJECTS = [project("aaaaaaaaaaaa", "Checkout revamp", issues(12, 7)), project("bbbbbbbbbbbb", "Big one", issues(30, 11, true)), project("cccccccccccc", "Nothing yet", [])];
const fake = { fail: "" };
const linear = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { query, variables } = (await req.json()) as { query: string; variables: any };
    const op = query.match(/query (\w+)/)?.[1];
    const err = (message: string) => Response.json({ errors: [{ message }] }, { status: 400 });
    if (req.headers.get("authorization") !== KEY) return err("Authentication required, not authenticated");
    const node = (p: (typeof PROJECTS)[0]) => ({ id: p.id, name: p.name, url: p.url });
    if (op === "ProjectBySlugId") return Response.json({ data: { projects: { nodes: PROJECTS.filter((p) => p.slugId === variables.value).map(node) } } });
    if (op === "ProjectByName") return Response.json({ data: { projects: { nodes: PROJECTS.filter((p) => p.name === variables.value).map(node) } } });
    const p = PROJECTS.find((x) => x.id === variables.id);
    if (!p) return err("Entity not found: Project");
    if (op === "ProjectById") return Response.json({ data: { project: node(p) } });
    if (fake.fail) return err(fake.fail);
    return Response.json({ data: { project: { ...node(p), issues: { nodes: p.issues, pageInfo: { hasNextPage: false, endCursor: null } } } } });
  },
});
const urlOf = (name: string) => PROJECTS.find((p) => p.name === name)!.url;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const data = mkdtempSync(join(tmpdir(), "hq-acceptance-walk-"));
const herdr = fakeHerdr(join(data, "herdr-fake"), [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "alpha", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
const errors: string[] = [];
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  const now = await ev(`JSON.stringify({ hash: location.hash, acc: document.querySelector("#roomView .acc")?.textContent.replace(/\\s+/g, " ").slice(0, 200) })`).catch(() => "?");
  throw new Error(`timed out waiting for ${expr}; now ${now}${await clickLog(ev)}`);
};
const post = async (p: string, b: unknown) => {
  const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${p}: ${d.error}`);
  return d;
};
const accOf = async (slug: string) => (await (await fetch(`${server.base}/api/rooms/${slug}/acceptance`)).json());
async function start(env: Record<string, string>) {
  await server?.stop();
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_LINEAR_API_URL: `http://127.0.0.1:${linear.port}/graphql`, ...env } });
}
// A linked room's criteria have landed (the link fetches them in the background).
const landed = async (slug: string) => { for (let i = 0; i < 100 && !(await accOf(slug))?.fetchedAt; i++) await Bun.sleep(50); };

async function load(hash: string, w = 1440, h = 900, mobile = false) {
  await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
  // A new document each time: a navigation that changes only the hash keeps the page and its state as they were.
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
  // A real click right after a load can be dropped: move the mouse until the page has seen it.
  await ev(`window.__moved = false; addEventListener("mousemove", () => { window.__moved = true; }, { once: true }); true`);
  for (let i = 0; i < 40 && !(await ev("window.__moved")); i++) { await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5 + i, y: 5 }); await Bun.sleep(25); }
}
async function click(sel: string) {
  await settled(ev, sel);
  const at = await ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return "missing";
    e.scrollIntoView({ block: "nearest" });
    const r = e.getBoundingClientRect(), x = r.left + Math.min(r.width / 2, 40), y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  })()`);
  if (!Array.isArray(at)) throw new Error(`cannot click ${sel}: ${at}`);
  const [x, y] = at;
  await aimed(ev, sel, x, y, "aim");
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  await aimed(ev, sel, x, y, "pressed");
}
const escape = async () => { for (const type of ["keyDown", "keyUp"]) await page.s("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); };
const text = (sel: string) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.replace(/\\s+/g, " ").trim() ?? null`);
const count = (sel: string) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const visible = (sel: string) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;
const toasted = (t: string) => `[...document.querySelectorAll(".toast")].some((e) => e.textContent === ${JSON.stringify(t)})`;
const inRoom = (slug: string, what: string) => `location.hash === "#room/${slug}" && !document.getElementById("roomView").hidden && ${what}`;
const linked = `${visible("#roomView .acc.linked")}`;
const unlinked = `${visible("#roomView .acclink")} && !document.querySelector("#roomView .acc.linked")`;
const office = `location.hash === "" && document.getElementById("roomView").hidden`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  await start({ HUD_LINEAR_API_KEY: KEY });
  await post("/api/lanes", { name: "alpha", machine: "local" });
  for (const [slug, title] of [["checkout", "Checkout revamp"], ["plain", "One issue"], ["big", "Big one"], ["empty", "Nothing yet"], ["old", "Old room"]]) await post("/api/rooms", { slug, title, owner: "alpha" });
  for (const [slug, name] of [["checkout", "Checkout revamp"], ["big", "Big one"], ["empty", "Nothing yet"], ["old", "Checkout revamp"]]) { await post(`/api/rooms/${slug}/project`, { ref: urlOf(name) }); await landed(slug); }
  await post("/api/rooms/old/archive", { by: "owner" });
  page = await newSession(chrome.cdp, errors);
}, 60_000);

afterAll(async () => {
  await page?.s("Page.navigate", { url: "about:blank" }).catch(() => {});
  await server?.stop();
  await chrome?.close();
  linear.stop(true);
  rmSync(data, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a linked room shows DONE MEANS: the project, a bar, N of M closed, and what is left per milestone", async () => {
  await load("#room/checkout");
  await until(inRoom("checkout", linked));
  expect(await text("#roomView .acc .k")).toBe("DONE MEANSCheckout revamp ↗");
  expect(await ev(`document.querySelector("#roomView .accproj").href`)).toBe(urlOf("Checkout revamp"));
  expect(await ev(`(() => { const b = document.querySelector("#roomView .accbar"); return [b.getAttribute("aria-valuenow"), b.getAttribute("aria-valuemax"), b.querySelector("i").style.width]; })()`)).toEqual(["7", "12", "58%"]);
  expect(await text("#roomView .accsum b")).toBe("7 of 12 closed");
  // Closed is Linear's word for it, not proof: the count says where it comes from.
  for (const sel of ["#roomView .accsum b", "#roomView .accbar", "#roomView .accmh span"]) expect(await ev(`document.querySelector(${JSON.stringify(sel)}).title`)).toBe("Closed in Linear. PMs close a criterion after it's walked on production.");
  expect(await text("#roomView .accwhen")).toBe("updated 1 min ago");
  // The age is the page clock's (data-since, data-ago): nothing in the panel redraws on a timer of its own.
  expect(await ev(`Number(document.querySelector("#roomView .accwhen [data-since][data-ago]").dataset.since)`)).toBe((await accOf("checkout")).fetchedAt);
  const html = await ev(`document.querySelector("#roomView .acc").innerHTML`);
  await Bun.sleep(1500);
  expect(await ev(`document.querySelector("#roomView .acc").innerHTML`)).toBe(html);
  // Closed ones fold away: Foundations (4 of 4) is one line; the open ones show with their key, state and title.
  expect(await ev(`[...document.querySelectorAll("#roomView .accmh")].map((h) => h.textContent)`)).toEqual(["Foundations✓ 4/4", "Launch3/4", "NO MILESTONE0/4"]);
  expect(await count("#roomView .accitem")).toBe(5);
  expect(await ev(`(() => { const a = document.querySelector("#roomView .accitem .acckey"); return [a.textContent, a.href, a.target]; })()`)).toEqual(["ENG-107", "https://linear.app/acme/issue/ENG-107", "_blank"]);
  expect(await text("#roomView .accitem .accmeta")).toBe("ENG-107 · In Progress");
  expect(await ev(`document.querySelector("#roomView .accitem .acctitle").innerHTML`)).toBe("Works with <b>SSO</b>");
  await click("#roomView [data-acc-closed]");
  await until(`document.querySelectorAll("#roomView .accitem").length === 12`);
  expect(await count("#roomView .accitem.closed")).toBe(7);
  expect(await text("#roomView [data-acc-closed]")).toBe("HIDE CLOSED");
  await click("#roomView [data-acc-closed]");
  await until(`document.querySelectorAll("#roomView .accitem").length === 5`);
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("Linear's errors are in plain words, the last list kept under them; the panel draws again when it changes", async () => {
  // Linked again while Linear fails: the fetch fails, what was fetched before stays.
  fake.fail = "rate limited";
  await post("/api/rooms/checkout/project", { ref: urlOf("Checkout revamp") });
  await until(`document.querySelector("#roomView .accerr")?.textContent === "Linear didn't answer: rate limited"`);
  expect(await text("#roomView .accsum b")).toBe("7 of 12 closed");
  fake.fail = "";
  PROJECTS[0].issues[7].state = { name: "Done", type: "completed" };
  await post("/api/rooms/checkout/project", { ref: urlOf("Checkout revamp") });
  await until(`!document.querySelector("#roomView .accerr") && document.querySelector("#roomView .accsum b")?.textContent === "8 of 12 closed"`);
  fake.fail = "Entity not found: Project";
  await post("/api/rooms/checkout/project", { ref: urlOf("Checkout revamp") });
  await until(`/can't find this project/.test(document.querySelector("#roomView .accerr")?.textContent)`);
  fake.fail = "";
  PROJECTS[0].issues[7].state = { name: "In Progress", type: "started" };
  await post("/api/rooms/checkout/project", { ref: urlOf("Checkout revamp") });
  await until(`!document.querySelector("#roomView .accerr") && document.querySelector("#roomView .accsum b")?.textContent === "7 of 12 closed"`);
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("a room without a project offers one quiet line; LINK links it and the panel takes its place", async () => {
  await load("#room/plain");
  await until(inRoom("plain", unlinked));
  expect(await ev(`document.querySelector("#roomView .acclink input").placeholder`)).toBe("Paste a Linear project URL");
  expect(await ev(`(() => { const [i, b] = document.querySelectorAll("#roomView .acclink input, #roomView .acclink button"); return Math.abs(i.getBoundingClientRect().top - b.getBoundingClientRect().top) < 8; })()`)).toBe(true);
  await click("#roomView .acclink input");
  await page.s("Input.insertText", { text: "https://linear.app/acme/project/gone-dddddddddddd" });
  await click("#roomView .acclink button");
  await until(toasted("Linear can't find this project any more. It may have been deleted, or the key can't see it."));
  expect(await ev(`document.querySelector("#roomView .acclink input").value`)).toBe("https://linear.app/acme/project/gone-dddddddddddd");
  expect(errors.splice(0)).toEqual(["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
  await ev(`document.querySelector("#roomView .acclink input").select(); true`);
  await page.s("Input.insertText", { text: urlOf("Nothing yet") });
  await click("#roomView .acclink button");
  await until(linked);
  await until(toasted("LINKED TO NOTHING YET."));
  expect(await text("#roomView .acc .k")).toBe("DONE MEANSNothing yet ↗");
  // 0 criteria: no bar, a line that says how to add them.
  await until(`document.querySelector("#roomView .acc .none")?.textContent === "No acceptance criteria yet. In Linear, label the project's issues acceptance and they show here."`);
  expect(await count("#roomView .accbar")).toBe(0);
  expect(await ev(visible("#roomView .acclink"))).toBe(false);
  // The owner linked it: the event says so.
  const ev1 = (await (await fetch(`${server.base}/api/state`)).json()).events.find((e: any) => e.text === "linked room plain to Linear project Nothing yet");
  expect(ev1?.who).toBe("Tester");
  await post("/api/rooms/plain/project", { clear: true });
  await until(unlinked);
  expect(await ev(`document.querySelector("#roomView .acclink input").value`)).toBe("");
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("every way in and out: the tile, BACK, Esc, the browser's back, room to room and a reload; 30 items", async () => {
  await load("");
  await click('[data-qtab="rooms"]');
  // The tile: the project's name, a small bar and the count; a room without a project has none.
  await until(`!!document.querySelector('#rooms [data-room="checkout"] .acctile')`);
  expect(await text('#rooms [data-room="checkout"] .acctile')).toBe("Checkout revamp7/12");
  expect(await ev(`document.querySelector('#rooms [data-room="checkout"] .acctile b').title`)).toBe("Closed in Linear. PMs close a criterion after it's walked on production.");
  expect(await text('#rooms [data-room="big"] .acctile')).toBe("Big one11/29");
  expect(await text('#rooms [data-room="empty"] .acctile')).toBe("Nothing yetNO CRITERIA");
  expect(await count('#rooms [data-room="plain"] .acctile')).toBe(0);
  // An archived room keeps its project on its tile.
  expect(await text('#rooms [data-room="old"] .acctile')).toBe("Checkout revamp7/12");

  await click('#rooms [data-room="checkout"] .rt');
  await until(inRoom("checkout", linked));
  await click("#roomView [data-room-back]");
  await until(office);
  await click('#rooms [data-room="checkout"] .rt');
  await until(inRoom("checkout", linked));
  await escape();
  await until(office);
  await click('#rooms [data-room="checkout"] .rt');
  await until(inRoom("checkout", linked));
  await did(ev, "back");
  const h = await page.s("Page.getNavigationHistory");
  await page.s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
  await until(office);
  // Room to room: each room shows its own, never the one before.
  await click('#rooms [data-room="checkout"] .rt');
  await until(inRoom("checkout", linked));
  await click('#roomView [data-room-go="plain"]');
  await until(inRoom("plain", unlinked));
  expect(await count("#roomView .acc")).toBe(1);
  await click('#roomView [data-room-go="big"]');
  await until(inRoom("big", linked));
  expect(await text("#roomView .accsum b")).toBe("11 of 29 closed");
  expect(await count("#roomView .acc")).toBe(1);
  // 30 items, one canceled: SHOW CLOSED lists all 30, the canceled one struck through and not counted.
  await click("#roomView [data-acc-closed]");
  await until(`document.querySelectorAll("#roomView .accitem").length === 30`);
  expect(await count("#roomView .accitem.gone")).toBe(1);
  await click("#roomView [data-acc-closed]");
  await until(`document.querySelectorAll("#roomView .accitem").length === 18`);
  // The list stays beside the room, the long rail scrolls on its own.
  expect(await ev(visible("#rooms .rlist"))).toBe(true);
  expect(await ev(`(() => { const r = document.querySelector("#roomView .rvrail"); return r.scrollHeight > r.clientHeight; })()`)).toBe(true);
  await load("#room/big");
  await until(inRoom("big", linked));
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("an archived room shows its project, with no way to link one when it has none; a phone; dark mode", async () => {
  await load("#room/old");
  await until(inRoom("old", linked));
  expect(await text("#roomView .accsum b")).toBe("7 of 12 closed");
  // A phone: the panel is on the BRIEF tab with the lanes, not on SHELF or CHAT.
  await load("#room/checkout", 390, 844, true);
  await until(`!document.getElementById("roomView").hidden`);
  expect(await ev(visible("#roomView .acc"))).toBe(false);
  await click('#roomView [data-ptab="brief"]');
  await until(linked);
  expect(await ev(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await click('#roomView [data-ptab="shelf"]');
  await until(`!(${linked})`);
  await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await load("#room/checkout");
  await until(linked);
  const fill = await ev(`getComputedStyle(document.querySelector("#roomView .accbar i")).backgroundColor`);
  const ground = await ev(`getComputedStyle(document.querySelector("#roomView .acc")).backgroundColor`);
  expect(fill).not.toBe(ground);
  await page.s("Emulation.setEmulatedMedia", { features: [] });
  expect(errors).toEqual([]);
});

test.skipIf(!chromeFound)("with no key the panel says so in plain words, and an archived room with no project shows nothing", async () => {
  await page.s("Page.navigate", { url: "about:blank" });
  await start({ HUD_LINEAR_API_KEY: "" });
  await post("/api/rooms", { slug: "bare", title: "Bare", owner: "alpha" });
  await post("/api/rooms/bare/archive", { by: "owner" });
  await load("#room/big");
  await until(inRoom("big", `document.querySelector("#roomView .accerr")?.textContent === "Linear isn't connected yet: HQ asked for a key."`));
  expect(await text("#roomView .acc .k")).toBe("DONE MEANSBig one ↗");
  await load("#room/bare");
  await until(`location.hash === "#room/bare" && !document.getElementById("roomView").hidden`);
  expect(await ev(visible("#roomView .acc"))).toBe(false);
  expect(errors).toEqual([]);
});
