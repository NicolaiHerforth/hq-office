#!/usr/bin/env bun
// PARITY LAB: how close an HTML page in the HUD comes to a Claude artifact. Posts a page as a floor brief on a
// throwaway server (its own port, data folder and stub herdr), opens #brief/ID in headless Chrome, prints every check
// the page reports to its parent, and saves the results and screenshots (desktop light and dark, phone). The checks
// that need a person's click (copy, fullscreen, saving a file) get a real one: mouse input through CDP at the
// button's place inside the sandboxed frame, so the page has a user's gesture as in any browser, and a click on the
// HUD's SAVE prompt. Chrome grants clipboard writing to the HUD as a browser does after a click; the frame is as it
// always is.
//
//   bun scripts/parity-lab/harness.ts [PAGE] [--ref REF] [--out DIR] [--expect N]
//
// PAGE: an HTML file (default: template.html next to this script), a whole document or, as the Artifact tool takes it,
// the body only (it is wrapped in the tool's document). A __PACE__ in it becomes the releases per day from this
// checkout's CHANGELOG.md. --ref runs the server from a git ref (exported with git archive) instead of this
// checkout, so a before and an after can be compared: --ref main. --out: where results.json and the screenshots go
// (default: a new temporary folder, printed). --expect N: exit 1 when fewer than N checks pass, to catch a regression.
// Needs Chrome (CHROME_BIN), and the network for the page's CDN checks.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newSession, spawnServer, startChrome, treeOf } from "../room-hash.ts";
import { fakeHerdr } from "../../test/fake-herdr.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const ref = opt("--ref");
const expect = opt("--expect");
if (expect !== undefined && !/^\d+$/.test(expect)) throw new Error("--expect takes a number of checks");
const OUT = resolve(opt("--out") ?? mkdtempSync(join(tmpdir(), "parity-lab-out-")));
const PAGE = resolve(args[0] ?? join(import.meta.dir, "template.html"));
mkdirSync(OUT, { recursive: true });

// Releases per day over the last two weeks of releases, from the changelog's "## [X.Y.Z] - YYYY-MM-DD" lines.
function pace() {
  const days = new Map<string, number>();
  for (const m of readFileSync(join(REPO, "CHANGELOG.md"), "utf8").matchAll(/^## \[\d+\.\d+\.\d+\] - (\d{4}-\d{2}-\d{2})/gm)) days.set(m[1], (days.get(m[1]) ?? 0) + 1);
  const last = [...days].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-11);
  return { days: last.map(([d]) => d), counts: last.map(([, n]) => n) };
}
// A page written for the Artifact tool is the body only: wrap it in the document the tool publishes it in.
const SKELETON = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>`;
const text = readFileSync(PAGE, "utf8").replace("__PACE__", () => JSON.stringify(pace()));
const html = /^\s*(?:<!doctype|<html[\s>])/i.test(text) ? text : `${SKELETON}${text}</body></html>`;

const tree = ref ? await treeOf(ref, REPO) : { dir: REPO, done: () => {} };
const DATA = mkdtempSync(join(tmpdir(), "parity-lab-data-"));
const herdr = fakeHerdr(DATA, [{ name: "hq", agent_status: "idle", pane_id: "w1:p1", agent: "claude" }]);
const server = await spawnServer({ cwd: tree.dir, env: { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: DATA, HERDR_BIN: herdr.bin, HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HUD_HQ_HINT: "0", HUD_HQ_RENAME: "0", HUD_GH_BIN: "false" } });
const chrome = await startChrome();
let passed = -1, via = "";
try {
  const post = (p: string, b: object, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
  await post("/api/sync", {});
  const { id } = await post("/api/briefs", { title: "Parity Lab", body: html }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" });
  if (!id) throw new Error("the brief was not posted");
  const errors: string[] = [];
  // The page's frame may run in a process of its own (an opaque origin): attach to its target when it does.
  const frames = new Map<string, string>(); // an attached frame's target id: its session
  chrome.cdp.listeners.push((m: any) => { if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") frames.set(m.params.targetInfo.targetId, m.params.sessionId); });
  const page = await newSession(chrome.cdp, errors);
  await page.s("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // What a browser gives a page after a click: writing to the clipboard, for the HUD (a frame's permission is its
  // top page's). Files the HUD saves land in OUT/downloads.
  await chrome.cdp.send("Browser.grantPermissions", { origin: server.base, permissions: ["clipboardSanitizedWrite"] });
  const DOWNLOADS = join(OUT, "downloads");
  mkdirSync(DOWNLOADS, { recursive: true });
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS });
  const snap = async (n: string) => writeFileSync(join(OUT, n), Buffer.from((await page.s("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const open = async (w: number, h: number, mobile: boolean, dark: boolean) => {
    await page.s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await page.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await page.s("Page.navigate", { url: "about:blank" });
    await page.s("Page.navigate", { url: `${server.base}/` });
    await Bun.sleep(1200);
    await page.evaluate(`window.__parity = null; addEventListener("message", (e) => { if (e.data?.parityLab) window.__parity = e.data.parityLab; }); location.hash = "#brief/${id}"; true`);
    await Bun.sleep(9000);
  };
  await open(1440, 900, false, false);
  const r0 = await page.evaluate(`window.__parity`);
  if (r0) await clicks();
  const r = await page.evaluate(`window.__parity`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(r, null, 1));
  console.log(`Parity Lab on ${ref ?? "this checkout"} (${PAGE})`);
  if (r) {
    const all = Object.entries(r.checks) as [string, { state: string; detail: string }][];
    for (const [k, v] of all) console.log(`${v.state.padEnd(5)} ${k.padEnd(10)} ${v.detail}`);
    passed = all.filter(([, v]) => v.state === "pass").length;
    const waiting = all.filter(([, v]) => v.state !== "pass" && v.state !== "fail").map(([k]) => k);
    console.log(`${passed} of ${all.length} checks pass${waiting.length ? ` (${waiting.join(", ")} not judged)` : ""}`);
    if (via) console.log(`clicks: real mouse input; buttons found through ${via}`);
    if (existsSync(join(DOWNLOADS, "parity-test.txt"))) console.log(`file saved: ${join(DOWNLOADS, "parity-test.txt")}`);
  } else console.log("no results posted");
  await snap("brief-light.png");
  await open(1440, 900, false, true); await snap("brief-dark.png");
  await open(390, 844, true, false); await snap("brief-phone.png");
  console.log("page errors:", errors.filter((e) => !/SecurityError|sandbox|Failed to load resource/i.test(e)).slice(0, 8));
  console.log(`results and screenshots: ${OUT}`);

  // ---- the checks that need a click ----

  // Runs in the page's frame: in its own target when it has one, else in an isolated world of the frame.
  async function inFrame(expression: string) {
    const url = `/briefs/${id}.html`;
    // (a frame's address is known once it has loaded, so it is looked up now, not when it was attached)
    const target = (await chrome.cdp.send("Target.getTargets")).targetInfos.find((t: any) => t.type === "iframe" && t.url.includes(url) && frames.has(t.targetId));
    let r: any;
    via = target ? "the frame's own target" : "an isolated world in the frame";
    if (target) r = await chrome.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, frames.get(target.targetId));
    else {
      const find = (t: any): any => (t.frame.url.includes(url) ? t.frame : (t.childFrames ?? []).map(find).find(Boolean));
      const frame = find((await page.s("Page.getFrameTree")).frameTree);
      if (!frame) throw new Error("the page's frame is not there");
      const { executionContextId } = await page.s("Page.createIsolatedWorld", { frameId: frame.id, worldName: "parity-lab" });
      r = await page.s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, contextId: executionContextId });
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  // A real click at a point of the HUD's page (CSS pixels), as a mouse gives it.
  async function click([x, y]: number[]) {
    await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
  // Where a button inside the frame is on the HUD's page: scrolled into view in the frame, then offset by the frame.
  async function frameButton(el: string) {
    const [bx, by] = await inFrame(`(() => { const b = document.getElementById(${JSON.stringify(el)}); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const [fx, fy] = await page.evaluate(`(() => { const f = document.querySelector(".briefview .pageframe"); const r = f.getBoundingClientRect(); return [r.left + f.clientLeft, r.top + f.clientTop]; })()`);
    return [fx + bx, fy + by];
  }
  // (function declarations: clicks() runs above, before any constant down here exists)
  function judged(check: string) { return page.evaluate(`window.__parity?.checks?.${check}?.state !== "wait"`); }
  async function until(what: () => Promise<boolean>, ms = 8000) {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(100)) if (await what().catch(() => false)) return true;
    return false;
  }
  async function clicks() {
    for (const [button, check] of [["tCopy", "copy"], ["tFull", "full"]]) {
      await Bun.sleep(300); // the frame has scrolled
      await click(await frameButton(button));
      if (!(await until(() => judged(check)))) console.log(`${check}: the page did not answer the click`);
    }
    await until(() => page.evaluate(`!document.fullscreenElement`)); // the page leaves fullscreen by itself
    // Saving a file: the page asks the HUD, the HUD asks its viewer (SAVE), then the browser saves it.
    await click(await frameButton("tSave"));
    if (await until(() => page.evaluate(`!!document.querySelector(".pr-save .pr-yes")`))) {
      await click(await page.evaluate(`(() => { const r = document.querySelector(".pr-save .pr-yes").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`));
    } else console.log("save: the HUD did not ask to save the file");
    if (!(await until(() => judged("save")))) console.log("save: the page did not hear back");
    await until(async () => existsSync(join(DOWNLOADS, "parity-test.txt")), 5000);
  }
} finally {
  await chrome.close();
  await server.stop();
  tree.done();
}
if (expect !== undefined && passed < Number(expect)) {
  console.log(passed < 0 ? `no results: expected ${expect} checks to pass` : `${passed} checks pass, fewer than the ${expect} expected`);
  process.exit(1);
}
