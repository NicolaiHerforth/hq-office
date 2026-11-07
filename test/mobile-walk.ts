// The whole page on a phone, for test/client/mobile-overflow.test.ts: a server with data that stresses a narrow screen
// (long names, unbroken strings, wide tables, code, many lanes), a table of every surface and how to reach it by real
// taps, and the in-page measure of what spills. Never the owner's server: a spare port, a throwaway data dir, a fake
// herdr and a fake Linear.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSession, spawnServer, startChrome } from "../scripts/room-hash.ts";
import { fakeHerdr } from "./fake-herdr.ts";
import { fakeHome } from "./fake-subs.ts";

export type Phone = { width: number; height: number };
export const PHONES: Phone[] = [{ width: 390, height: 844 }, { width: 360, height: 780 }, { width: 430, height: 932 }];

const LONG_LANE = "payments-webhook-retry-and-idempotency-keys-migration";
const LANES: [string, string, string, string][] = [
  [LONG_LANE, "Retry failed webhooks with idempotency keys and keep the ledger consistent across every region", "running", "pay"],
  ["checkout-tax-rounding-regression-eu-and-uk", "Rounding regression on tax lines in the EU and the UK", "waiting", "pay"],
  ["invoice-pdf", "supercalifragilisticexpialidocious_invoice_renderer_v2_final_really_final_this_time", "running", "pay"],
  ["ledger-audit", "Audit the ledger", "parked", "pay"],
  ["refunds", "Refunds over the limit", "done", "pay"],
  ["crm-import-the-entire-customer-history-from-the-old-system", "Import the whole customer history", "running", "crm"],
  ["crm-dedupe", "Dedupe contacts by email and phone", "waiting", "crm"],
  ["crm-search", "Search index", "running", "crm"],
  ["crm-merge", "Merge tool", "parked", "crm"],
  ["growth-experiments-landing-page-copy-variants", "Landing copy variants", "running", "growth"],
  ["growth-seo", "Sitemaps", "done", "growth"],
  ["ops-backups", "Nightly backups and restore drill", "running", "ops"],
  ["ops-oncall", "On-call rota", "running", "ops"],
  ["ops-tls", "Rotate certificates before they run out at the end of the month", "waiting", "ops"],
];
const URL_LONG = "https://example.com/a/very/long/path/that/never/breaks/because/it/has/no/spaces/at/all/and/goes/on/and/on/report.html?with=query&and=more";
const WIDE_TABLE = "| Region | Requests per second | Error rate | p50 latency | p99 latency | Owner of the service |\n|---|---|---|---|---|---|\n| eu-west-1 | 1200 | 0.02% | 41 ms | 390 ms | payments-webhook-retry |\n| us-east-1 | 3400 | 0.11% | 38 ms | 512 ms | checkout-tax-rounding |";
const SMALL_TABLE = "| Region | Errors |\n|---|---|\n| eu | 2 |";
const CODE = "```\nbun test test/client/mobile-overflow.test.ts --timeout 120000 --bail --only-failures --preload ./a/very/long/path/to/some/setup/file.ts\n```";
const RICH = `## Where we are\n\nThe long string ${URL_LONG} sits in a sentence, next to [a link](${URL_LONG}) and \`a_very_long_inline_code_span_that_will_not_break_on_its_own_at_all_in_any_browser\`.\n\n${WIDE_TABLE}\n\n${CODE}\n\n- A list item that is long enough to wrap on a phone, and then some more words on top of those.\n- [x] A done thing\n\n> A quote that also runs on for a while, so it has to wrap inside its bar on a narrow screen.`;
const HTML_PAGE = `<!doctype html><html><body><h1>The rollout plan</h1><p>Two phases over two weeks.</p></body></html>`;
const SHELF_NAME = "the-extremely-long-and-detailed-rollout-plan-for-the-payments-migration-v3.html";

// Fake Linear: one project with criteria, some with very long titles, so DONE MEANS has a list to draw.
function fakeLinear() {
  const issues = Array.from({ length: 8 }, (_, i) => ({
    identifier: `ENG-${100 + i}`,
    title: i % 2 ? `Criterion ${i + 1}` : `Webhooks are retried with the same idempotency key across a restart and nothing is charged twice in region ${i}`,
    url: `https://linear.app/acme/issue/ENG-${100 + i}`,
    updatedAt: "2026-11-05T09:00:00.000Z",
    state: i < 3 ? { name: "Done", type: "completed" } : { name: "In Progress", type: "started" },
    projectMilestone: i < 4 ? { id: "m1", name: "Foundations of the migration", sortOrder: 1 } : null,
  }));
  const project = { id: "0b9f4a2e-aaaaaaaaaaaa", slugId: "aaaaaaaaaaaa", name: "Payments migration and the long road to idempotency", url: "https://linear.app/acme/project/payments-aaaaaaaaaaaa" };
  const linear = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { query } = (await req.json()) as { query: string };
      const op = query.match(/query (\w+)/)?.[1];
      if (op === "ProjectBySlugId") return Response.json({ data: { projects: { nodes: [project] } } });
      if (op === "ProjectByName") return Response.json({ data: { projects: { nodes: [project] } } });
      if (op === "ProjectById") return Response.json({ data: { project } });
      return Response.json({ data: { project: { ...project, issues: { nodes: issues, pageInfo: { hasNextPage: false, endCursor: null } } } } });
    },
  });
  return { linear, ref: project.url };
}

export type Office = Awaited<ReturnType<typeof startOffice>>;

// A server at root (this tree, or a baseline exported elsewhere) holding the data every surface draws.
export async function startOffice(root: string) {
  const data = mkdtempSync(join(tmpdir(), "hq-mobile-"));
  const home = fakeHome();
  const agents = [
    { name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" },
    { name: "hq-pay", agent_status: "working", pane_id: "w2:p1", agent: "claude" },
    { name: "hq-crm", agent_status: "idle", pane_id: "w3:p1", agent: "claude" },
    { name: "hq-growth", agent_status: "idle", pane_id: "w4:p1", agent: "claude" },
    { name: "hq-ops", agent_status: "idle", pane_id: "w5:p1", agent: "claude" },
    ...LANES.map(([name], i) => ({ name, agent_status: i % 3 ? "idle" : "working", pane_id: `w9:p${i + 2}`, agent: "claude" })),
  ];
  const herdr = fakeHerdr(join(data, "herdr-fake"), agents);
  const { linear, ref } = fakeLinear();
  const server = await spawnServer({
    cwd: root,
    env: {
      ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr.bin, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq",
      HUD_SUBS_HOME: home, HUD_SUBS_MS: "150", HUD_LINEAR_API_URL: `http://127.0.0.1:${linear.port}/graphql`, HUD_LINEAR_API_KEY: "lin_api_FAKE_FOR_THE_TEST",
    },
  });
  const post = async (p: string, b: object = {}, pane?: string) => {
    const r = await fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...(pane ? { "x-hud-pane": pane } : {}) }, body: JSON.stringify(b) });
    const d = await r.json();
    if (!r.ok) throw new Error(`${p}: ${d.error}`);
    return d;
  };
  const upload = (slug: string, name: string, body: string, as: string) => fetch(`${server.base}/api/rooms/${slug}/files?name=${encodeURIComponent(name)}&as=${encodeURIComponent(as)}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hud": "1" }, body });

  await post("/api/sync");
  await post("/api/floors", { id: "pay", name: "Payments and the long road to idempotency", hq: "hq-pay" });
  await post("/api/floors", { id: "crm", name: "CRM", hq: "hq-crm" });
  await post("/api/floors", { id: "growth", name: "Growth", hq: "hq-growth" });
  await post("/api/floors", { id: "ops", name: "Operations and reliability", hq: "hq-ops" });
  for (const [name, title, phase, floor] of LANES) await post("/api/lanes", { name, title, phase, floor, machine: "local", pr: name === LONG_LANE ? "812" : undefined });
  await post("/api/sync");
  const asked = await post("/api/asks", { lane: LONG_LANE, kind: "decision", title: "Retry the webhooks with the same idempotency key across a restart, or mint a new key for every attempt?", body: `Two ways to go. ${URL_LONG}\n\n${CODE}\n\n${WIDE_TABLE}`, options: ["Keep the same key across every restart of the worker", "A new key each time", "Ask the payments provider first"], recommended: "A new key each time" });
  await post(`/api/asks/${asked.id}/items`, { text: "Write the migration notes for every region that still sends webhooks" });
  for (let i = 1; i <= 7; i++) await post(`/api/asks/${asked.id}/comment`, { text: i === 7 ? `A long comment. ${URL_LONG}` : `Note ${i}` });
  await post("/api/asks", { lane: "crm-dedupe", kind: "action", title: "supercalifragilisticexpialidocious_action_with_no_spaces_at_all_for_the_title_of_this_ask" });
  await post("/api/asks", { lane: "ops-tls", kind: "decision", title: "Rotate now?", options: ["Yes", "No"] });
  for (const n of [1, 2, 3]) await post("/api/asks", { lane: "ledger-audit", kind: "decision", title: `Audit step ${n}: go on?`, options: ["Go on", "Stop here"], recommended: "Go on" });
  await post("/api/asks", { lane: "ops-tls", kind: "action", title: "A long body", body: "A long question body that takes up room on a small screen. ".repeat(12) });
  for (let i = 1; i <= 6; i++) await post("/api/updates", { lane: i % 2 ? LONG_LANE : "crm-dedupe", title: i === 3 ? `A_very_long_update_title_with_no_spaces_that_goes_on_past_the_edge_of_the_phone_screen_${i}` : `Update ${i}: halfway there`, body: i % 3 === 0 ? RICH : i === 1 ? SMALL_TABLE : "Two lines of news.\nThe second line." });
  await post("/api/notes", { text: `Keep going. ${URL_LONG}` });
  await post("/api/notes", { text: "Short note." });

  await post("/api/board/track", { issue: "OPE-1934", lane: LONG_LANE });
  await post("/api/board/track", { issue: "OPE-20021", lane: "crm-dedupe" });

  await post("/api/rooms", { slug: "pay-migration", title: "The payments migration and the long road to idempotency across every region", owner: LONG_LANE });
  await post("/api/rooms/pay-migration/brief", { body: RICH });
  await post("/api/rooms/pay-migration/artifacts", { title: "An eval report with a long title that keeps going for a while", url: URL_LONG });
  await upload("pay-migration", SHELF_NAME, HTML_PAGE, LONG_LANE);
  await upload("pay-migration", "notes.md", "# Notes\n\nShort.", LONG_LANE);
  await post("/api/rooms/pay-migration/project", { ref });
  for (let i = 1; i <= 6; i++) await post("/api/rooms/pay-migration/say", { text: i === 2 ? RICH : `Finding ${i}: the worker retries with a new key.\nA second line.` });
  await post("/api/rooms/pay-migration/post", { text: `Owner's message. ${URL_LONG}` });
  await post("/api/rooms", { slug: "crm-short", title: "CRM", owner: "crm-dedupe" });
  await post("/api/rooms", { slug: "ops-drill-with-a-long-slug-for-the-tile", title: "supercalifragilisticexpialidocious_room_title_without_any_spaces_for_the_tile", owner: "ops-tls" });

  const brief = (await post("/api/briefs", { title: "Weekly: the payments migration and everything that came along with it", body: `${RICH}\n\n#lane/${LONG_LANE}\n\n#room/pay-migration\n\n#page/rooms/pay-migration/files/${SHELF_NAME}` }, "w2:p1")).id as number;
  await post("/api/briefs", { title: "supercalifragilisticexpialidocious_brief_title_with_no_spaces_at_all_for_the_row", body: "Short." }, "w3:p1");
  const pageBrief = (await post("/api/briefs", { title: "A brief that is a page", body: HTML_PAGE }, "w2:p1")).id as number;
  await post("/api/comments/post", { page: `briefs/${brief}`, text: `Why the rush? ${URL_LONG}` });
  await post("/api/comments/reply", { page: `briefs/${brief}`, text: `Because the **launch** moved up.\n\n${CODE}` }, "w2:p1");
  await post("/api/comments/post", { page: `rooms/pay-migration/files/${SHELF_NAME}`, text: "On the page: looks good." });
  await post("/api/secrets", { name: "AN_API_TOKEN_WITH_A_VERY_LONG_NAME_THAT_GOES_ON_AND_ON_AND_ON", value: "not-a-real-value", minutes: 5, by: "owner" });
  await post("/api/sync");
  // The subs source lands on its own poll.
  await Bun.sleep(400);

  return {
    base: server.base,
    post,
    ids: { brief, pageBrief, shelf: SHELF_NAME, longLane: LONG_LANE },
    stop: async () => {
      await server.stop();
      linear.stop(true);
      rmSync(data, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// ---- the phone: a Chrome tab with touch, and real taps ----

export type Tab = Awaited<ReturnType<typeof openPhone>>;

export async function openPhone(chrome: Awaited<ReturnType<typeof startChrome>>, errors: string[]) {
  const page = await newSession(chrome.cdp, errors);
  const ev = (e: string) => page.evaluate(e);
  // The page says when: ms only stops a wait that will never end, so a loaded machine is slow, not a failure.
  const until = async (expr: string, ms = 90_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(40)) if (await ev(expr).catch(() => false)) return true;
    throw new Error(`timed out waiting for ${expr}`);
  };
  return {
    ...page,
    ev,
    until,
    async size(p: Phone) {
      await page.s("Emulation.setDeviceMetricsOverride", { width: p.width, height: p.height, deviceScaleFactor: 3, mobile: true });
      await page.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    },
    // A new document on this address with these browser-kept choices: a hash-only navigation would keep the old page.
    async load(base: string, hash: string, stored: Record<string, string>) {
      await page.s("Page.navigate", { url: "about:blank" });
      const seed = await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `if (window === top && location.protocol === "http:") { sessionStorage.clear(); localStorage.clear(); for (const [k, v] of Object.entries(${JSON.stringify(stored)})) localStorage.setItem(k, v); }` });
      await page.s("Page.navigate", { url: `${base}/${hash}` });
      // Every feature is a module script in the shell, so "complete" means they have all run; lastNote that a state came.
      await until(`document.readyState === "complete" && !!document.getElementById("lastNote")?.innerHTML && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`);
      await page.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: seed.identifier });
    },
    // Nothing is still moving and the fonts have landed: two frames after, what is measured is what stays.
    async rest() {
      await until(`document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming?.().iterations === Infinity)`);
      await ev(`document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true)))))`);
    },
    async tapAt(x: number, y: number) {
      await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await Bun.sleep(120);
    },
    // A finger on the first match that is on the screen, where nothing covers it.
    async tap(sel: string) {
      await until(`[...document.querySelectorAll(${JSON.stringify(sel)})].some((x) => x.getBoundingClientRect().width > 0)`);
      const at = await ev(`(() => {
        const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0);
        if (!e) return "not shown";
        e.scrollIntoView({ block: "center", behavior: "instant" });
        const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
        return hit && (hit === e || e.contains(hit) || hit.contains(e)) ? [x, y] : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
      })()`);
      if (!Array.isArray(at)) throw new Error(`cannot tap ${sel}: ${at}`);
      const [x, y] = at;
      await page.s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await page.s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await Bun.sleep(120);
    },
  };
}

// ---- every surface ----

export type Surface = {
  name: string;
  hash?: (o: Office) => string;
  stored?: Record<string, string>;
  // Tap to it, and wait for what proves it is open.
  go?: (t: Tab, o: Office) => Promise<void>;
  shows: string;
  // A sheet over the page: 8 px from both edges of the screen.
  sheet?: string;
};

const room = "#room/pay-migration";
// On a phone the first tap opens a floor's row, the second goes in.
const enterFloor = async (t: Tab) => { await t.tap('.tgo[data-floor-go="pay"]'); await t.tap('.tenterb[data-floor-go="pay"]'); await t.until(`!document.querySelector(".building") || document.querySelector(".building").getBoundingClientRect().height === 0`); };
// Words left on closed questions, parked as a reload parks them: back, they wait behind one row at the top of the list.
const closedRow = async (t: Tab) => {
  await t.ev(`import("/src/client/questions/drafts.js").then((m) => { for (const id of [900001, 900002, 900003]) m.drafts.set(id, { text: "Words that were not sent, and they go on for a line or two so the box has something to hold.", about: { title: "A question with a very long title that closed while you were away from this page", who: ${JSON.stringify(LONG_LANE)} } }); })`);
  await t.ev(`(setTimeout(() => location.reload(), 0), true)`);
  await Bun.sleep(300);
  await t.until(`document.readyState === "complete" && !!document.querySelector(".leftrow [data-left-open]")`);
};

export const SURFACES: Surface[] = [
  { name: "needs-you", shows: "#hud .ask" },
  { name: "closed-row", go: closedRow, shows: ".leftrow [data-left-all]" },
  { name: "closed-row-open", go: async (t) => { await closedRow(t); await t.tap("[data-left-open]"); }, shows: ".ask.parked [data-left-drop]" },
  { name: "ledger", shows: ".ledger [data-ledger-more]" },
  { name: "ledger-all", go: (t) => t.tap(".ledger [data-ledger-more]"), shows: ".ledger .lc:nth-of-type(7)" },
  { name: "building-row", go: (t) => t.tap('.tgo[data-floor-go="pay"]'), shows: ".ftile.pic .tenterb" },
  { name: "building", shows: ".building [data-floor-go]" },
  { name: "floor-list", go: (t) => t.tap("[data-pill]"), shows: ".flhead", sheet: ".fmenu" },
  { name: "floor-add", go: async (t) => { await t.tap("[data-pill]"); await t.tap("[data-floor-add]"); }, shows: ".fpanel", sheet: ".fpanel" },
  { name: "office", go: enterFloor, shows: "#room" },
  { name: "floor-edit", go: async (t) => { await t.tap("[data-pill]"); await t.tap('.fledit[data-floor-edit="pay"]'); }, shows: ".fpanel", sheet: ".fpanel" },
  { name: "lanes-board", stored: { "hq-layout": "board" }, go: enterFloor, shows: ".lanesboard .lbrow" },
  { name: "agent-drawer", stored: { "hq-layout": "board" }, go: async (t) => { await enterFloor(t); await t.tap("[data-lane-pick]"); }, shows: ".card:not([hidden])", sheet: ".card:not([hidden])" },
  { name: "messages", stored: { "hq-qtab": "messages" }, shows: "#msgs [data-msg]" },
  { name: "work-board", stored: { "hq-qtab": "work" }, shows: "#work .wi" },
  { name: "rooms-list", stored: { "hq-qtab": "rooms" }, shows: "#rooms article[data-room]" },
  { name: "new-room", stored: { "hq-qtab": "rooms" }, go: (t) => t.tap(".rnew"), shows: ".nrpanel", sheet: ".nrpanel" },
  { name: "briefs-list", stored: { "hq-qtab": "briefs" }, shows: "#briefs .brow" },
  { name: "room-chat", hash: () => room, shows: ".roomview .rvchat" },
  { name: "room-brief", hash: () => room, go: (t) => t.tap('[data-ptab="brief"]'), shows: ".roomview .rbrief" },
  { name: "room-shelf", hash: () => room, go: (t) => t.tap('[data-ptab="shelf"]'), shows: ".roomview .rshelf" },
  { name: "done-means", hash: () => room, go: (t) => t.tap('[data-ptab="brief"]'), shows: ".roomview .acc" },
  { name: "brief", hash: (o) => `#brief/${o.ids.brief}`, shows: ".briefview h1, .briefview .bvbody" },
  { name: "export", hash: (o) => `#brief/${o.ids.brief}`, go: (t) => t.tap(".bvbar [data-export]"), shows: ".xpanel [data-export-as]", sheet: ".xpanel" },
  { name: "brief-comments", hash: (o) => `#brief/${o.ids.brief}`, stored: { "hq-comments-open": "1" }, shows: ".cmount .cthread, .cmount textarea" },
  { name: "page", hash: (o) => `#page/rooms/pay-migration/files/${o.ids.shelf}`, shows: ".pageview iframe" },
  { name: "page-comments", hash: (o) => `#page/rooms/pay-migration/files/${o.ids.shelf}`, go: (t) => t.tap(".pageview [data-comments-toggle]"), shows: ".pageview .cmount textarea", sheet: ".cmount.open" },
  { name: "page-brief", hash: (o) => `#page/briefs/${o.ids.pageBrief}`, shows: ".pageview iframe" },
  { name: "split-room-brief", hash: (o) => `${room}+brief/${o.ids.brief}`, shows: ".briefview h1, .briefview .bvbody" },
  { name: "split-room-page", hash: (o) => `${room}+page/rooms/pay-migration/files/${o.ids.shelf}`, shows: ".pageview iframe" },
  { name: "menu", go: (t) => t.tap("#menuBtn"), shows: "#menuDrop:not([hidden])", sheet: "#menuDrop" },
  { name: "secrets", go: async (t) => { await t.tap("#menuBtn"); await t.tap("#secretsBtn"); }, shows: ".spanel:not([hidden])", sheet: ".spanel" },
  { name: "settings", go: async (t) => { await t.tap("#menuBtn"); await t.tap("#settingsBtn"); }, shows: "#settings:not([hidden])", sheet: "#settings" },
  { name: "subs", go: (t) => t.tap("#subsBtn"), shows: "#subsDrop:not([hidden])", sheet: "#subsDrop" },
  { name: "tell-sheet", go: async (t) => { await t.tap("#menuBtn"); await t.tap("#menuTell"); }, shows: ".tell.sheet textarea", sheet: ".tell" },
  { name: "close-room-confirm", hash: () => room, go: (t) => t.tap("[data-room-close]"), shows: ".confirm:not([hidden])", sheet: ".confirm" },
  { name: "secret-delete-confirm", go: async (t) => { await t.tap("#menuBtn"); await t.tap("#secretsBtn"); await t.tap('[data-secret-rm]'); }, shows: ".confirm:not([hidden])", sheet: ".confirm" },
  { name: "brief-comment-sheet", hash: (o) => `#brief/${o.ids.brief}`, go: (t) => t.tap(".bvbar [data-comments-toggle]"), shows: ".cmount.open textarea", sheet: ".cmount.open" },
  { name: "message-reply", stored: { "hq-qtab": "messages" }, go: (t) => t.tap("#msgs [data-reply]"), shows: "#msgs [data-rbox] textarea" },
  { name: "shelf-add", hash: () => room, go: async (t) => { await t.tap('[data-ptab="shelf"]'); await t.tap(".rshelf .addbtn"); }, shows: ".radd input[type=url]" },
  { name: "room-versions", hash: () => room, go: async (t) => { await t.tap('[data-ptab="brief"]'); }, shows: ".roomview .rbrief" },
  { name: "toast-long", go: async (t) => { await t.ev(`import("/src/client/core/dom.js").then((m) => m.toast("DELETED AN_API_TOKEN_WITH_A_VERY_LONG_NAME_THAT_GOES_ON_AND_ON_AND_ON."))`); }, shows: ".toast" },
];

// ---- what spills ----

// Run in the page. Returns where it spills; html and body never count as containing anything, so a clip on the root
// that hides a spill still fails.
export const MEASURE = `(() => {
  const root = document.scrollingElement, vw = document.documentElement.clientWidth;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 3).join(".") : "");
  const shown = (e) => {
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    const r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const clips = (s) => s.overflowX !== "visible";
  const contained = (e) => {
    let fixed = getComputedStyle(e).position === "fixed";
    for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (fixed && s.transform === "none" && s.contain === "none") continue;
      if (clips(s)) return true;
      if (s.position === "fixed") fixed = true;
    }
    return false;
  };
  const spills = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (!shown(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
    if (contained(e)) continue;
    if (e.closest("svg") && e.tagName.toLowerCase() !== "svg") continue;
    spills.push({ el: name(e), left: Math.round(r.left), right: Math.round(r.right), text: (e.textContent || "").trim().slice(0, 40) });
  }
  // A line that runs out of a box that fits: the box's rect says nothing, the text's does.
  const lines = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let t = lines.nextNode(); t; t = lines.nextNode()) {
    const e = t.parentElement;
    if (!t.textContent.trim() || !e || !shown(e) || contained(e)) continue;
    if (e.closest("script, style, svg, select, textarea")) continue;
    if (getComputedStyle(e).overflowX !== "visible") continue;
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
      spills.push({ el: name(e) + " (its text)", left: Math.round(r.left), right: Math.round(r.right), text: t.textContent.trim().slice(0, 40) });
      break;
    }
  }
  // Only a wide table or a line of code may scroll sideways inside its box: a row of navigation or actions must show
  // all it holds, or a real item sits out of sight. A control that its box clips is hidden the same way.
  const content = "pre, .codebox, .mdtable";
  const scrollers = [], clipped = [];
  for (const e of document.body.querySelectorAll("*")) {
    if (!shown(e)) continue;
    const s = getComputedStyle(e);
    if ((s.overflowX === "auto" || s.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 1 && !e.matches(content)) scrollers.push({ el: name(e), by: e.scrollWidth - e.clientWidth });
    if (!e.matches("a[href], button, select, input:not([type=hidden]), textarea, [role=tab]") || e.closest(content)) continue;
    const r = e.getBoundingClientRect();
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX === "visible") continue;
      const b = a.getBoundingClientRect();
      if (r.left < b.left - 1 || r.right > b.right + 1) { clipped.push({ el: name(e), in: name(a), text: (e.textContent || "").trim().slice(0, 24) }); break; }
    }
  }
  const before = scrollX;
  scrollTo(40, scrollY);
  const moved = scrollX !== before;
  scrollTo(before, scrollY);
  return { vw, scrollW: root.scrollWidth, moved, spills, scrollers, clipped };
})()`;

// One look per kind of action on a phone, the pair and the close mark: what fills and edges it, its shape and its
// font. The question panel's own buttons wait for their lane, a button under a finger shows its hover state, and these
// are other kinds: a chosen tab, an alarm on COMMENTS, a destructive action, one that says it is unavailable.
export const KINDS = {
  primary: ".send:not(:disabled), .ftile.pic .tenterb, .fpanel .fpacts .btn-s.on, .nracts .btn-s.on",
  secondary: ".btn, .btn-s:not(.on, .off, .rclose, .new, .danger, [data-fp-rm], [data-del]), .copy, .tab:not(.on), .fswitch .fbtn, .fledit, .cmount .cjump, .bgrid .fslot",
  close: ".spx, .cardx, .fpx, .cclose",
};
export const LOOKS = `(() => {
  const out = {};
  for (const [kind, sel] of Object.entries(${JSON.stringify(KINDS)})) {
    out[kind] = {};
    for (const e of document.querySelectorAll(sel)) {
      if (e.closest("#hud") && !e.matches(".send") || e.matches(":hover") || !e.getBoundingClientRect().width) continue;
      const c = getComputedStyle(e), r = parseFloat(c.borderTopLeftRadius);
      const look = [r >= e.offsetHeight / 2 - 1 ? "pill" : r ? "soft" : "square", c.backgroundColor, c.borderTopColor, c.fontFamily.split(",")[0]].join(" | ");
      (out[kind][look] ??= new Set()).add((e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 16));
    }
    out[kind] = Object.fromEntries(Object.entries(out[kind]).map(([k, v]) => [k, [...v]]));
  }
  return out;
})()`;

// The audit's fuller reading, on top of MEASURE: tap targets, cut text, unequal edges, nesting and contrast.
export const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 3).join(".") : "");
  const chainShown = (e) => { for (let a = e; a; a = a.parentElement) { const s = getComputedStyle(a); if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false; } const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const all = [...document.body.querySelectorAll("*")].filter(chainShown);
  const SEL = "a[href], button, input:not([type=hidden]), select, textarea, summary, label:has(input), [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [tabindex='0']";
  const taps = [];
  for (const e of all) {
    if (!e.matches(SEL) || e.disabled) continue;
    const s = getComputedStyle(e);
    if (e.tagName === "A" && s.display === "inline" && e.parentElement.textContent.trim().length > e.textContent.trim().length) continue;
    const r = e.getBoundingClientRect();
    if (e.matches("input[type=checkbox], input[type=radio]") && e.closest("label")?.getBoundingClientRect().height >= 44) continue;
    if (s.pointerEvents === "none") continue; // a tap goes through it, to what holds it
    if (r.height < 44 || r.width < 44) taps.push({ el: name(e), w: Math.round(r.width), h: Math.round(r.height), text: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24) });
  }
  const cuts = [], scrollers = [];
  for (const e of all) {
    const s = getComputedStyle(e);
    if (s.overflowX === "visible" || e.scrollWidth <= e.clientWidth + 1) continue;
    const o = { el: name(e), by: e.scrollWidth - e.clientWidth, text: (e.textContent || "").trim().slice(0, 40), ellipsis: s.textOverflow === "ellipsis" };
    (s.overflowX === "auto" || s.overflowX === "scroll" ? scrollers : cuts).push(o);
  }
  const wrap = document.querySelector(".wrap"), ws = getComputedStyle(wrap), wr = wrap.getBoundingClientRect();
  const L = wr.left + parseFloat(ws.paddingLeft), R = wr.right - parseFloat(ws.paddingRight);
  const edges = [];
  for (const parent of document.querySelectorAll(".wrap, .top, .main, .desk, .stage, .qwrap")) {
    const kids = [...parent.children].filter((k) => chainShown(k) && getComputedStyle(k).position !== "fixed" && getComputedStyle(k).position !== "absolute");
    for (const k of kids) { const r = k.getBoundingClientRect(); if (r.left < L - 1 || r.right > R + 1 || Math.abs(r.left - L) > 1 || Math.abs(r.right - R) > 1) edges.push({ el: name(k), left: Math.round(r.left - L), right: Math.round(R - r.right) }); }
  }
  const boxy = (e) => { const s = getComputedStyle(e); return parseFloat(s.borderLeftWidth) >= 1 && parseFloat(s.borderRightWidth) >= 1 && parseFloat(s.borderTopWidth) >= 1 && parseFloat(s.borderBottomWidth) >= 1 && s.borderLeftColor !== "rgba(0, 0, 0, 0)" && e.getBoundingClientRect().height > 40 && !e.matches("button, textarea, input, select, a.btn-s, a.btn, th, td"); };
  const deep = new Map();
  for (const e of all) { if (!boxy(e)) continue; let d = 0; for (let a = e; a; a = a.parentElement) if (boxy(a)) d++; if (d > 2) deep.set(name(e), Math.max(d, deep.get(name(e)) || 0)); }
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const scale = c.startsWith("color(") ? 255 : 1; return { r: m[0] * scale, g: m[1] * scale, b: m[2] * scale, a: m[3] ?? 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const v = [c.r, c.g, c.b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ground = (e) => { const st = []; for (let a = e; a; a = a.parentElement) { const c = parse(getComputedStyle(a).backgroundColor); if (c.a > 0) { st.push(c); if (c.a === 1) break; } } let g = { r: 255, g: 255, b: 255, a: 1 }; for (const c of st.reverse()) g = over(c, g); return g; };
  const low = new Map(), small = new Map();
  for (const e of all) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(e), size = parseFloat(s.fontSize);
    let op = 1; for (let a = e; a; a = a.parentElement) op *= parseFloat(getComputedStyle(a).opacity);
    const g = ground(e), c = parse(s.color), fg = over({ ...c, a: c.a * op }, g);
    const a = lum(fg), b = lum(g), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5 && !e.disabled) low.set(name(e), { el: name(e), ratio: Math.round(ratio * 10) / 10, size, text: e.textContent.trim().slice(0, 24) });
    if (size < 8) small.set(name(e), { el: name(e), size, text: e.textContent.trim().slice(0, 24) });
  }
  return { taps, cuts, scrollers, edges, deep: [...deep].map(([el, depth]) => ({ el, depth })), contrast: [...low.values()], small: [...small.values()] };
})()`;

// The widest counts the question tabs realistically carry, on every tab at once.
export const WIDEST_COUNTS = `(() => { for (const [id, n] of [["qtCount", 87], ["qtUnread", 12], ["qtStalled", 12], ["qtRooms", 3], ["qtBriefs", 2]]) { const t = document.getElementById(id); t.hidden = false; t.textContent = n; } })()`;

export const openSurface = async (t: Tab, o: Office, s: Surface) => {
  await t.load(o.base, s.hash?.(o) ?? "", s.stored ?? {});
  if (s.go) await s.go(t, o);
  await t.until(`!!document.querySelector(${JSON.stringify(s.shows)})`);
  await t.rest();
};
