// SENT & ANSWERED says where each note and answer stands with HQ: typed in while HQ was busy (sent again once it is
// free), delivered (HQ started working on it), HQ has it / HQ acted (acked), or HELD. Needs Chrome; skipped without it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-delivery-marks-"));
const herdr = join(dir, "herdr");
const status = join(dir, "status");
writeFileSync(herdr, `#!/bin/sh
S=$(cat "${status}")
case "$1 $2" in
  "agent list") echo "{\\"result\\":{\\"agents\\":[{\\"name\\":\\"hq\\",\\"agent_status\\":\\"$S\\",\\"pane_id\\":\\"w8:p1\\",\\"agent\\":\\"claude\\"}]}}" ;;
esac
exit 0
`);
chmodSync(herdr, 0o755);
writeFileSync(status, "working");
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const errors: string[] = [];
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const log = `document.getElementById("lastNote").textContent`; // the line under Tell HQ

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT, { HERDR_BIN: herdr, HUD_HQ_RENAME: "0" });
  await server.post("/api/sync", {});
  page = await newSession(chrome.cdp, errors);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.getElementById("lastNote")?.innerHTML`);
}, 30_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("a note typed in while HQ was busy says so; once HQ is free it is delivered; acked, HQ has it", async () => {
  await server.post("/api/notes", { text: "while you were busy" });
  await until(`${log}.includes("typed in while HQ was busy")`);
  writeFileSync(status, "idle");
  await server.post("/api/hq/check", {});
  await until(`${log}.includes("delivered to HQ")`);
  const { notes } = await (await fetch(`${server.base}/api/state`)).json();
  await server.post(`/api/notes/${notes[0].id}/ack`, {});
  await until(`${log}.includes("HQ has it")`);
  expect(errors).toEqual([]);
});
