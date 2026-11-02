// Pasting text that came with a picture of itself (Excel, Word, Notes and web pages put both on the clipboard) into
// a text box pastes the text: the HUD does not take it as an attachment. A screenshot, a copied image and a file
// copied in the Finder still attach. In TELL HQ, a question's answer box and an open room. Needs Chrome.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, spawnServer, startChrome } from "../../scripts/room-hash.ts";
import { fakeHerdr } from "../fake-herdr.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const dir = mkdtempSync(join(tmpdir(), "hq-paste-"));
const herdr = fakeHerdr(dir, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }, { name: "pm", agent_status: "idle", pane_id: "w1:p2", agent: "claude" }]);
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof spawnServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
const ev = (e: string) => page.evaluate(e);
const until = async (expr: string, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ev(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const post = (p: string, b: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(b) }).then((r) => r.json());
// A paste into the focused element: a picture (always), with rich text or not. Returns whether the HUD took it
// (defaultPrevented: the browser would not paste the text).
const paste = (sel: string, kind: "rich" | "image" | "file") => ev(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)}); el.focus();
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "${kind === "file" ? "report.png" : "image.png"}", { type: "image/png" }));
  ${kind === "rich" ? `dt.setData("text/html", "<table><tr><td>Q3</td><td>42</td></tr></table>"); dt.setData("text/plain", "Q3\\t42");` : ""}
  ${kind === "file" ? `dt.setData("text/plain", "report.png");` : ""}
  const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
})()`);

beforeAll(async () => {
  if (!chromeFound) return;
  server = await spawnServer({ cwd: ROOT, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: dir, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_RENAME: "0", HUD_HQ_HINT: "0", HUD_GH_BIN: "false" } });
  await post("/api/lanes", { name: "pm", parent: "hq", machine: "local" });
  await post("/api/sync");
  await post("/api/asks", { lane: "pm", kind: "decision", title: "Which tier?", options: ["A", "B"] });
  await post("/api/rooms", { slug: "pricing", title: "Pricing", owner: "pm" });
  chrome = await startChrome();
  page = await newSession(chrome.cdp, []);
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.navigate", { url: server.base });
  await until(`!!document.getElementById("lastNote")?.innerHTML && !!document.querySelector("#hud .ask textarea")`);
}, 30_000);
afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!chromeFound)("text copied with a picture of itself pastes as text in TELL HQ and an answer box; a screenshot or a file still attaches", async () => {
  for (const sel of ["#tell textarea, .tell textarea", "#hud .ask textarea"]) {
    expect(await paste(sel, "rich")).toBe(false);
    expect(await paste(sel, "image")).toBe(true);
    expect(await paste(sel, "file")).toBe(true);
  }
});

test.skipIf(!chromeFound)("in an open room the same: rich text into the send box or another field is text; a picture goes in", async () => {
  await ev(`location.hash = "#room/pricing"; true`);
  await until(`!!document.querySelector(".rsend textarea")`);
  expect(await paste(".rsend textarea", "rich")).toBe(false);
  expect(await paste(".rsend textarea", "image")).toBe(true);
});
