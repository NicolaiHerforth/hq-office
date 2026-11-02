#!/usr/bin/env bun
// PARITY LAB: how close an HTML page in the HUD comes to a Claude artifact. Posts a page as a floor brief on a
// throwaway server (its own port, data folder and stub herdr), opens #brief/ID in headless Chrome, prints every check
// the page reports to its parent, and saves the results and screenshots (desktop light and dark, phone).
//
//   bun scripts/parity-lab/harness.ts [PAGE] [--ref REF] [--out DIR]
//
// PAGE: an HTML file (default: template.html next to this script), a whole document or, as the Artifact tool takes it,
// the body only (it is wrapped in the tool's document). A __PACE__ in it becomes the releases per day from this
// checkout's CHANGELOG.md. --ref runs the server from a git ref (exported with git archive) instead of this
// checkout, so a before and an after can be compared: --ref main. --out: where results.json and the screenshots go
// (default: a new temporary folder, printed). Needs Chrome (CHROME_BIN), and the network for the page's CDN checks.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newSession, spawnServer, startChrome, treeOf } from "../room-hash.ts";
import { fakeHerdr } from "../../test/fake-herdr.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const ref = opt("--ref");
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
try {
  const post = (p: string, b: object, h: object = {}) => fetch(`${server.base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1", ...h }, body: JSON.stringify(b) }).then((r) => r.json());
  await post("/api/sync", {});
  const { id } = await post("/api/briefs", { title: "Parity Lab", body: html }, { "x-hud-pane": "w1:p1", "x-hud-machine": "local" });
  if (!id) throw new Error("the brief was not posted");
  const errors: string[] = [];
  const page = await newSession(chrome.cdp, errors);
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
  const r = await page.evaluate(`window.__parity`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(r, null, 1));
  console.log(`Parity Lab on ${ref ?? "this checkout"} (${PAGE})`);
  if (r) {
    const all = Object.entries(r.checks) as [string, { state: string; detail: string }][];
    for (const [k, v] of all) console.log(`${v.state.padEnd(5)} ${k.padEnd(10)} ${v.detail}`);
    const judged = all.filter(([, v]) => v.state === "pass" || v.state === "fail");
    console.log(`${judged.filter(([, v]) => v.state === "pass").length} of ${judged.length} automatic checks pass (manual ones wait for a click)`);
  } else console.log("no results posted");
  await snap("brief-light.png");
  await open(1440, 900, false, true); await snap("brief-dark.png");
  await open(390, 844, true, false); await snap("brief-phone.png");
  console.log("page errors:", errors.filter((e) => !/SecurityError|sandbox|Failed to load resource/i.test(e)).slice(0, 8));
  console.log(`results and screenshots: ${OUT}`);
} finally {
  await chrome.close();
  await server.stop();
  tree.done();
}
