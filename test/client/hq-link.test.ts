// The page when HQ isn't receiving: a red banner above everything with the reason, what is held, and the fix (name
// HQ's last pane again); the title says it; a note sent meanwhile is marked HELD. Fixed, the banner goes and the page
// is as before. Needs Chrome (CHROME_BIN); skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-link-page-"));
const herdr = join(dir, "herdr");
const mode = join(dir, "mode");
// HQ was in w8:p1; herdr dropped its name ("unnamed") until it is renamed ("up").
writeFileSync(herdr, `#!/bin/sh
M=$(cat "${mode}")
case "$1 $2" in
  "agent list") [ "$M" = up ] && echo '{"result":{"agents":[{"name":"hq","agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' || echo '{"result":{"agents":[{"agent_status":"idle","pane_id":"w8:p1","agent":"claude"}]}}' ;;
  "agent prompt") [ "$M" = up ] || { echo '{"error":{"code":"agent_not_found","message":"agent target hq not found"}}' >&2; exit 1; } ;;
  "agent rename") echo up > "${mode}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
writeFileSync(mode, "up");

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const banner = `document.querySelector(".hqdown")`;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr, HUD_HQ_RENAME: "0" }); // the banner, not the quiet fix (hq-heal.test.ts)
  await server.post("/api/sync", {}); // HQ seen in w8:p1
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector("#noteText")`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("HQ receiving: no banner, the page as it was", async () => {
  await until(`document.title === "HQ Office"`);
  expect(await page.evaluate(`!${banner} || ${banner}.hidden`)).toBe(true);
});

test.skipIf(!chromeFound)("HQ's name dropped: the banner shows on the next sync, before anything is sent", async () => {
  writeFileSync(mode, "unnamed");
  await server.post("/api/sync", {});
  await until(`!!${banner} && !${banner}.hidden`);
  const text = await page.evaluate(`${banner}.innerText`);
  expect(text).toContain("HQ ISN'T RECEIVING");
  expect(text).toContain('no agent in herdr is named "hq"');
  expect(text).toContain('NAME w8:p1 "hq"');
  expect(await page.evaluate("document.title")).toBe("HQ ISN'T RECEIVING · HQ Office");
  expect(await page.evaluate(`document.querySelector("#noteText").placeholder`)).toContain("HQ isn't receiving");
  // The banner takes a row of its own: the questions column still reaches the bottom of the window.
  const bottom = await page.evaluate(`Math.round(document.querySelector(".desk").getBoundingClientRect().bottom)`);
  expect(bottom).toBeLessThanOrEqual(900);
  expect(bottom).toBeGreaterThan(800);
  expect(await page.evaluate(`${banner}.getBoundingClientRect().height`)).toBeLessThan(110);
});

test.skipIf(!chromeFound)("an urgent note sent meanwhile is held, listed in the banner and marked HELD", async () => {
  // A plain Tell waits in HQ's queue, so only an urgent one is typed into HQ's pane and can be held.
  await page.evaluate(`(() => { const t = document.querySelector("#noteText"); t.value = "hello?"; document.querySelector(".urgent-toggle").click(); document.querySelector("#compose").requestSubmit(); })()`);
  await until(`${banner}.innerText.includes("HELD FOR HQ (1)")`);
  expect(await page.evaluate(`${banner}.querySelector(".held").textContent`)).toContain("hello?");
  await until(`document.querySelector("#lastNote").innerText.includes("HELD: HQ isn't receiving")`);
});

test.skipIf(!chromeFound)("NAME gives HQ its name back: the held note goes and the banner leaves", async () => {
  await page.evaluate(`${banner}.querySelector('[data-hq="name"]').click()`);
  await until(`${banner}.hidden`);
  await until(`document.title === "HQ Office"`);
  expect(await page.evaluate(`document.querySelector("#lastNote").innerText`)).not.toContain("HELD");
  expect(errors).toEqual([]);
}, 20_000);
