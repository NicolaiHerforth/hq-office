// The page for a lane blocked on a prompt in herdr: a BLOCKED count in the top bar (only while there is one), a red
// bubble at the lane's desk (not the queue), the card with the excerpt and where to answer it (the click chooses the
// lane), and the WORK board
// with the blocked item on top. Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-blocked-page-"));
const herdr = join(dir, "herdr");
// golf works; alpha waits at a Claude permission prompt.
writeFileSync(join(dir, "pane.txt"), `│ Bash command
│   rm -rf build
│   Remove the build folder
│ Do you want to proceed?
│ ❯ 1. Yes
│   2. No, and tell Claude what to do differently (esc)
`);
writeFileSync(herdr, `#!/bin/sh
case "$*" in
  *"agent list"*) echo '{"result":{"agents":[{"name":"golf","agent_status":"working","pane_id":"p1","agent":"claude"},{"name":"alpha","agent_status":"blocked","pane_id":"w3:p2","agent":"claude"}]}}' ;;
  *"pane read w3:p2"*) cat "${dir}/pane.txt" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
// Where alpha stands and the colour inside its bubble (10x9 room pixels at (x + 9, y - 9), inside one pixel in).
const PROBE = `(async () => {
  const { workers } = await import("/src/client/room/workers.js");
  const { SEATS, QUEUE } = await import("/src/client/room/spots.js");
  const { ctx, TS, SC } = await import("/src/client/room/canvas.js");
  const w = workers.get("alpha");
  const at = (list) => list.some((p) => Math.abs(p.x - w.target.x) < 0.5 && Math.abs(p.y - w.target.y) < 0.5);
  const bx = w.x * TS + 9, by = w.y * TS - 6 - 9;
  // The bubble bounces up to 2.5 pixels: 3 pixels down from its resting top is inside it at every height.
  const d = ctx.getImageData(Math.round((bx + 2) * SC), Math.round((by + 3) * SC), 1, 1).data;
  return { status: w.lane.status, desk: at(SEATS), queue: at(QUEUE), still: !w.path.length, red: d[0] === 0xd6 && d[1] === 0x3c && d[2] === 0x3c };
})()`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr });
  for (const name of ["golf", "alpha"]) await server.post("/api/lanes", { name, machine: "local" });
  await server.post("/api/board/track", { issue: "ABC-7", lane: "alpha" });
  await server.post("/api/board/track", { issue: "ABC-8", lane: "golf" });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`import("/src/client/room/workers.js").then(({ workers }) => workers.size === 2)`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a blocked lane: BLOCKED in the top bar, a red bubble at its desk, the prompt on its card, first on WORK", async () => {
  // The top bar.
  await until(`!!document.querySelector("#sBlocked:not([hidden])")`);
  expect(await page.evaluate(`document.querySelector("#sBlocked .k").textContent + " " + document.querySelector("#sBlocked .v").textContent`)).toBe("BLOCKED 1");
  // The room: at its desk, under a red bubble.
  await until(`(${PROBE}).then((p) => p.still && p.red)`, 15_000);
  expect(await page.evaluate(PROBE)).toMatchObject({ status: "blocked", desk: true, queue: false, red: true });
  // The card: clicking the count selects the lane, and its card shows what it asks and where.
  await page.evaluate(`document.querySelector("#sBlocked").click()`);
  await until(`!!document.querySelector("#card .prompt")`);
  const card = await page.evaluate(`document.querySelector("#card").innerText`);
  // Choosing the lane scopes the page to it; the BLOCKED box itself stays, as it counts every blocked lane.
  expect(await page.evaluate(`document.querySelector(".scopechip").textContent`)).toBe("alpha ✕");
  expect(await page.evaluate(`!document.querySelector("#sBlocked").hidden`)).toBe(true);
  expect(card).toContain("BLOCKED ON A PROMPT");
  expect(card).toContain("ANSWER IT IN HERDR ON LOCAL, PANE w3:p2");
  expect(card).toContain("Remove the build folder · Do you want to proceed?\n1. Yes\n2. No, and tell Claude what to do differently (esc)");
  // WORK: the blocked item first, the excerpt as its why.
  await page.evaluate(`document.querySelector('[data-qtab="work"]').click()`);
  await until(`!!document.querySelector("#work .wi")`);
  const first = await page.evaluate(`(() => { const a = document.querySelector("#work .wi"); return { cls: a.className, key: a.querySelector(".key").textContent, what: a.querySelector(".what").textContent }; })()`);
  expect(first).toEqual({ cls: "wi blocked", key: "ABC-7", what: "Remove the build folder · Do you want to proceed? / 1. Yes / 2. No, and tell Claude what to do differently (esc)" });
  expect(await page.evaluate(`document.querySelector("#work h4").textContent`)).toBe("BLOCKED ON A PROMPT (1)");
  expect(errors).toEqual([]);
}, 40_000);
