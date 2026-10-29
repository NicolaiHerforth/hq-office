// The same markdown through every surface that shows text HQ or a lane wrote: NEEDS YOU (title, body, the ledger's
// checklist and comments), MESSAGES (your answers too) and the last note, the worker card (title, note and
// the blocked prompt as a code box), the WORK board, ROOMS (list, brief, thread) and the HQ-isn't-receiving strip.
// Seeded on a temporary server whose herdr has no HQ, so a note is held. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-md-surfaces-"));
const herdr = join(dir, "herdr");
writeFileSync(join(dir, "pane.txt"), "│ Bash command\n│   echo **not bold** <b>x</b>\n│ Do you want to proceed?\n│ ❯ 1. Yes\n");
// No HQ agent: notes to HQ are held. alpha waits at a prompt.
writeFileSync(herdr, `#!/bin/sh
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"golf","agent_status":"working","pane_id":"p1","agent":"claude"},{"name":"alpha","agent_status":"blocked","pane_id":"w3:p2","agent":"claude"},{"name":"bravo","agent_status":"idle","pane_id":"p3","agent":"claude"}]}}' ;;
  "pane read") cat "${dir}/pane.txt" ;;
  "agent prompt") exit 1 ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);

// Inline and block markdown; each surface must show the bold, the code and the link, and block surfaces the list.
const INLINE = "**Bold** with `code` and [a link](https://example.com/x)";
const BLOCK = `${INLINE}\n\n- one\n- two`;

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
// What a surface (a selector) shows: whether it has the bold, the code, the link and a list, and its raw text.
const look = (sel: string) => page.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  return {
    bold: [...el.querySelectorAll("b, strong")].some((b) => b.textContent === "Bold"),
    code: [...el.querySelectorAll("code")].some((c) => c.textContent === "code"),
    link: !!el.querySelector('a[href="https://example.com/x"][rel="noopener noreferrer"]'),
    list: el.querySelectorAll("li").length >= 2,
    stars: el.textContent.includes("**"),
  };
})()`);
const inline = { bold: true, code: true, link: true, stars: false };
const block = { ...inline, list: true };
const tab = (t: string) => page.evaluate(`document.querySelector('[data-qtab="${t}"]').click()`);

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr, HUD_HQ_RENAME: "0" });
  for (const name of ["alpha", "golf", "bravo"]) await server.post("/api/lanes", { name, machine: "local", title: INLINE, note: BLOCK });
  const ask = (await server.post("/api/ledger/asks", { lane: "bravo", kind: "decision", title: INLINE, body: BLOCK, options: ["A", "B"], items: [INLINE] })).id;
  await server.post(`/api/asks/${ask}/comment`, { text: INLINE });
  const done = (await server.post("/api/asks", { lane: "golf", kind: "info", title: INLINE })).id;
  await server.post(`/api/asks/${done}/answer`, { answer: BLOCK });
  await server.post("/api/updates", { lane: "golf", title: INLINE, body: BLOCK });
  await server.post("/api/notes", { text: BLOCK });
  await server.post("/api/board/track", { issue: "ABC-9", lane: "bravo" });
  await server.post("/api/board/pause", { issue: "ABC-9", reason: INLINE });
  await server.post("/api/rooms", { slug: "abc-7", title: INLINE, owner: "golf", members: ["bravo"] });
  await server.post("/api/rooms/abc-7/brief", { body: BLOCK });
  await server.post("/api/rooms/abc-7/say", { text: BLOCK });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector("#hud [data-ask] h3")`);
  await page.evaluate(`import("/src/client/room/input.js").then((m) => m.select("alpha", true))`);
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
}, 20_000);

test.skipIf(!chromeFound)("NEEDS YOU: the title, the body, the checklist and HQ's comments", async () => {
  await tab("questions");
  expect(await look("#hud [data-ask] h3")).toMatchObject(inline);
  expect(await look("#hud [data-ask] .text")).toMatchObject(block);
  await until(`!!document.querySelector("#hud .ledger .lc")`);
  expect(await look("#hud .ledger .lchk .lt")).toMatchObject(inline);
  expect(await look("#hud .ledger .lc")).toMatchObject(inline);
}, 20_000);

test.skipIf(!chromeFound)("MESSAGES: HQ's title and body, and your note", async () => {
  await tab("messages");
  await until(`!!document.querySelector("#msgs .msg.hq h3")`);
  expect(await look("#msgs .msg.hq h3")).toMatchObject(inline);
  expect(await look("#msgs .msg.hq .text")).toMatchObject(block);
  expect(await look("#msgs .msg.you .text")).toMatchObject(block);
  await tab("questions");
}, 20_000);

test.skipIf(!chromeFound)("your answers in MESSAGES (the question and your answer), and the last note under Tell HQ", async () => {
  expect(await look("#lastNote")).toMatchObject(inline);
  await tab("messages");
  await until(`!!document.querySelector('#msgs [data-msg^="a"] .text')`);
  expect(await look('#msgs [data-msg^="a"] h3')).toMatchObject(inline);
  expect(await look('#msgs [data-msg^="a"] .text')).toMatchObject(block);
  await tab("questions");
}, 20_000);

test.skipIf(!chromeFound)("the worker card: the title, the note, and the blocked prompt verbatim in a code box", async () => {
  await until(`!!document.querySelector("#card .prompt")`);
  expect(await look("#card .sub")).toMatchObject(inline);
  expect(await look("#card .note")).toMatchObject(block);
  const prompt = await page.evaluate(`(() => { const p = document.querySelector("#card .prompt"); return { code: p.querySelector(".codebox pre")?.textContent, b: p.querySelectorAll(".codebox b").length }; })()`);
  expect(prompt.code).toContain("echo **not bold** <b>x</b>");
  expect(prompt.b).toBe(0);
}, 20_000);

test.skipIf(!chromeFound)("the WORK board's why", async () => {
  await tab("work");
  await until(`!!document.querySelector("#work .wi .what")`);
  expect(await look("#work .wi .what")).toMatchObject(inline);
  await tab("questions");
}, 20_000);

test.skipIf(!chromeFound)("ROOMS: the list's title and last message, the room's title, brief and thread", async () => {
  await tab("rooms");
  await until(`!!document.querySelector('#rooms [data-room="abc-7"]')`);
  expect(await look('#rooms [data-room="abc-7"] .rt')).toMatchObject({ bold: true, code: true, stars: false });
  expect(await look('#rooms [data-room="abc-7"] .last')).toMatchObject({ bold: true, code: true, stars: false });
  await page.evaluate(`location.hash = "#room/abc-7"`);
  await until(`!!document.querySelector("#roomView .rthread [data-rmsg]") && !!document.querySelector("#roomView .rbrief li")`);
  expect(await look("#roomView .rvhead h2")).toMatchObject(inline);
  expect(await look("#roomView .rbrief .md")).toMatchObject(block);
  expect(await look("#roomView .rthread [data-rmsg] .text")).toMatchObject(block);
  await page.evaluate(`location.hash = ""`);
  await tab("questions");
}, 20_000);

test.skipIf(!chromeFound)("HQ isn't receiving: a held note", async () => {
  await until(`!!document.querySelector(".hqdown .held div")`);
  expect(await look(".hqdown .held div")).toMatchObject({ bold: true, code: true, link: true, stars: false });
}, 20_000);

test.skipIf(!chromeFound)("no errors on the page", () => {
  expect(errors).toEqual([]);
}, 20_000);
