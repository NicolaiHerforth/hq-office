// The first state reaches every feature. The state stream must open only after the feature scripts (they load after
// main.js) listen, or a state that comes sooner is lost to them until the next change. Here one feature script is held
// back until the server has answered, as a slow load would; the BLOCKED count (blocked/index.js, which
// renders only from "state") must still appear with no further change on the server. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-boot-first-state-"));
const herdr = join(dir, "herdr");
writeFileSync(herdr, `#!/bin/sh
case "$*" in
  *"agent list"*) echo '{"result":{"agents":[{"name":"alpha","agent_status":"blocked","pane_id":"w3:p2","agent":"claude"}]}}' ;;
  *"pane read"*) printf '│ Do you want to proceed?\\n│ ❯ 1. Yes\\n│   2. No (esc)\\n' ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);

let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr });
  await server.post("/api/lanes", { name: "alpha", machine: "local" });
  await server.post("/api/sync", {});
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a feature script that loads late still renders from the first state", async () => {
  const page = await newSession(chrome.cdp, []);
  // blocked/index.js is held until the first state has reached the page, or until no other page file has been asked for
  // in 1.5 s (with the fix the stream waits for that script, so no state comes first).
  let lastOther = Date.now();
  chrome.cdp.listeners.push(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (request.url.endsWith("/src/client/blocked/index.js")) {
      while (Date.now() - lastOther < 1500 && !(await page.evaluate(`window.__states > 0`).catch(() => false))) await Bun.sleep(50);
    } else lastOther = Date.now();
    page.s("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: `window.__states = 0; const Source = EventSource; window.EventSource = class extends Source { constructor(url) { super(url); this.addEventListener("message", () => { window.__states++; }); } };` });
  await page.s("Fetch.enable", { patterns: [{ urlPattern: "*/src/client/*" }] });
  await page.s("Page.navigate", { url: `${server.base}/` });
  for (const end = Date.now() + 20_000; Date.now() < end && (await page.evaluate(`document.readyState`)) !== "complete"; await Bun.sleep(50));
  await Bun.sleep(500);
  expect(await page.evaluate(`document.querySelector("#sBlocked:not([hidden])")?.textContent ?? null`)).toBe("BLOCKED1");
}, 40_000);
