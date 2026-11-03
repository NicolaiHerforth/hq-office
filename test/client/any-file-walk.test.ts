// Any file type, with real input, in Chrome against a temporary server: a program (.exe), an SVG with a script in it,
// a file with no extension and a Keynote deck (.key), real files on disk, go through the attach button (a real click
// and Chrome's own file chooser), a real drag onto a room's send box, and a paste into a question's answer (a paste
// event: headless Chrome has no clipboard that holds files). Each time they show as file chips, upload, send, and a
// real click on each link in the sent message downloads the file with its own bytes; none opens in the page. Needs
// Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, newSession, seed, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
const DIR = mkdtempSync(join(tmpdir(), "hq-any-file-walk-"));
const DOWNLOADS = join(DIR, "downloads");
let chrome: Awaited<ReturnType<typeof startChrome>>;
let server: Awaited<ReturnType<typeof startServer>>;
let page: Awaited<ReturnType<typeof newSession>>;
let askId = 0;
const errors: string[] = [];
const until = async (expr: string, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await page.evaluate(expr).catch(() => false)) return true;
  throw new Error(`timed out waiting for ${expr}`);
};
const state = async () => (await fetch(`${server.base}/api/state`)).json();

const FILES: Record<string, string> = {
  "tool.exe": "MZ\u0090\u0000 this program cannot be run in DOS mode",
  "logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="9" height="9"/></svg>`,
  LICENSE: "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "Deck.key": "PK\u0003\u0004 a keynote deck",
};
const NAMES = Object.keys(FILES);
const paths = NAMES.map((n) => join(DIR, n));

// Browser-wide: the file chooser a click opens, and each download with its file name and where it was saved.
let chooser: ((m: any) => void) | null = null;
const downloads = new Map<string, { name: string; done: boolean }>();

// A real click: the mouse moves to the middle of the element, presses and lets go.
async function click(sel: string) {
  const box = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing to click at ${sel}`);
  await page.s("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  for (const type of ["mousePressed", "mouseReleased"]) await page.s("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
}
async function type(sel: string, text: string) {
  await click(sel);
  await page.s("Input.insertText", { text });
}
const tray = (key: string) => page.evaluate(`[...document.querySelectorAll('[data-chips=${JSON.stringify(key)}] .chip')].map((c) => [c.querySelector(".fname")?.textContent ?? "image", ["prep", "up", "done", "err"].find((s) => c.classList.contains(s)), c.classList.contains("file")])`);
const uploaded = (key: string) => until(`(() => { const c = [...document.querySelectorAll('[data-chips=${JSON.stringify(key)}] .chip')]; return c.length === 4 && c.every((x) => x.classList.contains("done")); })()`);
function chipsShown(t: any[]) {
  expect(t.map(([name, , file]: any) => [name.replace(/-\d+(?=\.|$)/, ""), file])).toEqual(NAMES.map((n) => [n, true]));
  expect(t.every(([, s]: any) => s === "done")).toBe(true);
}

// The sent message's file links, each clicked for real: every one is a download of the file's own bytes, and the
// page stays where it was.
async function linksDownload(sel: string) {
  await until(`document.querySelectorAll(${JSON.stringify(`${sel} a.file`)}).length === 4`);
  const links: [string, string][] = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${sel} a.file`)})].map((a) => [a.textContent, a.getAttribute("href")])`);
  const here = await page.evaluate("location.href");
  for (const [i, [name, href]] of links.entries()) {
    const res = await fetch(`${server.base}${href}`);
    expect([name, res.headers.get("content-type"), res.headers.get("content-disposition"), res.headers.get("content-security-policy")?.startsWith("sandbox;")])
      .toEqual([name, "application/octet-stream", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, true]);
    const before = new Set(downloads.keys());
    const mark = `${downloads.size}-${i}`;
    await page.evaluate(`document.querySelectorAll(${JSON.stringify(`${sel} a.file`)})[${i}].dataset.walk = "${mark}"`);
    await click(`a.file[data-walk="${mark}"]`);
    const deadline = Date.now() + 10_000;
    let got: [string, { name: string; done: boolean }] | undefined;
    while (Date.now() < deadline && !(got = [...downloads].find(([g, d]) => !before.has(g) && d.done))) await Bun.sleep(50);
    expect(got?.[1].name).toBe(name);
    expect(readFileSync(join(DOWNLOADS, got![0]), "latin1")).toBe(FILES[NAMES.find((n) => name.replace(/-\d+(?=\.|$)/, "") === n)!]);
  }
  expect(await page.evaluate("location.href")).toBe(here);
  // A link opens a tab of its own for its download; nothing is left showing a file.
  const { targetInfos } = await chrome.cdp.send("Target.getTargets", {});
  for (const t of targetInfos) if (t.type === "page" && /\/(uploads|rooms)\//.test(t.url)) await chrome.cdp.send("Target.closeTarget", { targetId: t.targetId });
}

beforeAll(async () => {
  for (const [n, body] of Object.entries(FILES)) writeFileSync(join(DIR, n), body, "latin1");
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  askId = await seed(server.post);
  await server.post("/api/rooms", { slug: "kit", title: "Kit room", owner: "golf" });
  chrome.cdp.listeners.push((m) => {
    if (m.method === "Page.fileChooserOpened") chooser?.(m.params);
    if (m.method === "Browser.downloadWillBegin") downloads.set(m.params.guid, { name: m.params.suggestedFilename, done: false });
    if (m.method === "Browser.downloadProgress" && m.params.state === "completed") { const d = downloads.get(m.params.guid); if (d) d.done = true; }
  });
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOADS, eventsEnabled: true });
  page = await newSession(chrome.cdp, errors);
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.s("Page.setInterceptFileChooserDialog", { enabled: true });
  await page.s("Page.navigate", { url: `${server.base}/` });
  await until(`!!document.querySelector(".ask") && !!document.querySelector('#compose label.attach')`);
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
  rmSync(DIR, { recursive: true, force: true });
}, 20_000);

describe.skipIf(!chromeFound)("any file type, with real input", () => {
  test("the attach button: Chrome's file chooser takes the four, they send with a note and download from MESSAGES", async () => {
    const opened = new Promise<any>((res) => { chooser = res; });
    await click("#compose label.attach");
    const { backendNodeId, mode } = await opened;
    expect(mode).toBe("selectMultiple");
    await page.s("DOM.setFileInputFiles", { files: paths, backendNodeId });
    await uploaded("note");
    chipsShown(await tray("note"));
    await type("#noteText", "Four files");
    await click("#compose .acts .send");
    await until(`!document.querySelector('[data-chips="note"] .chip')`);
    const note = (await state()).notes[0];
    expect(note.text).toStartWith("Four files [file: ");
    expect([...note.text.matchAll(/\[file: [^\]]+\/uploads\/([^\]]+)\]/g)].map((m) => m[1])).toEqual(NAMES);
    await click('[data-qtab="messages"]');
    await linksDownload(`#msgs [data-msg="n${note.id}"]`);
    await click('[data-qtab="questions"]');
  }, 40_000);

  test("a real drag onto a room's send box: they join its tray, send to the room, go on its shelf and download from the thread", async () => {
    await page.evaluate(`location.hash = "#room/kit"`);
    await until(`!document.getElementById("roomView").hidden && !!document.querySelector("#roomView .rsend .rto") && !!document.querySelector("#roomView .rsend textarea")`);
    const at = await page.evaluate(`(() => { const r = document.querySelector("#roomView .rsend .rto").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const data = { items: [], files: paths, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await page.s("Input.dispatchDragEvent", { type, ...at, data });
    await uploaded("room:kit");
    chipsShown(await tray("room:kit"));
    await type("#roomView .rsend textarea", "For the room");
    await click("[data-room-send]");
    await until(`!document.querySelector('[data-chips="room:kit"] .chip')`);
    const r = await (await fetch(`${server.base}/api/rooms/kit`)).json();
    expect(r.artifactList.map((a: any) => a.path.split("/").pop()).sort()).toEqual([...NAMES].sort());
    expect(r.messages.at(-1).text).toStartWith("For the room [file: ");
    await linksDownload(`#roomView .rthread [data-rmsg="${r.messages.at(-1).id}"]`);
    await page.evaluate(`location.hash = ""`);
    await until(`document.getElementById("roomView").hidden`);
  }, 40_000);

  test("a paste into a question's answer: they join its tray, go with the answer and download from MESSAGES", async () => {
    const card = `[data-ask="${askId}"]`;
    await click(`${card} textarea`);
    const files = NAMES.map((n) => [n, Buffer.from(FILES[n], "latin1").toString("base64")]);
    const taken = await page.evaluate(`(() => {
      const dt = new DataTransfer();
      for (const [n, b] of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], n));
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    expect(taken).toBe(true);
    await uploaded(String(askId));
    chipsShown(await tray(String(askId)));
    await click(`${card} .opt[data-opt="Yes"]`);
    await until(`!!document.querySelector('${card} .opt.sel')`);
    await click(`${card} .send`);
    await until(`!document.querySelector('${card}')`);
    const answer = (await state()).answered.find((a: any) => a.id === askId).answer;
    expect([...answer.matchAll(/\[file: [^\]]+\/uploads\/([^\]]+)\]/g)].map((m) => m[1].replace(/-\d+(?=\.|$)/, ""))).toEqual(NAMES);
    await click('[data-qtab="messages"]');
    await linksDownload(`#msgs [data-msg="a${askId}"]`);
    expect(errors).toEqual([]);
  }, 40_000);
});
