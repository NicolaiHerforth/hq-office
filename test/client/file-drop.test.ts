// Files and images dropped or pasted into every send box, in Chrome against a temporary server: Tell HQ, a NEEDS YOU
// card, a reply in MESSAGES and a room's thread. On each, a PDF and a PNG dropped on the box's panel land in its
// tray (the file as a chip with its name and size, the image as a thumbnail), a pasted file joins them, × removes
// one, sending puts [file: PATH] and [image: PATH] at the end of the text, and the sent message shows a thumbnail
// and a link named after the file, both made by core/markdown.js. A drop anywhere else on the page does nothing and
// never navigates; a refused kind, a file over 25 MB and an eleventh attachment say why in the tray; a draft keeps
// its files through a reload; the attach button takes files too. Needs Chrome; skipped without it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findChrome, newSession, seed, startChrome, startServer } from "../../scripts/room-hash.ts";

const ROOT = join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
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
const load = async (hash = "") => {
  await page.s("Page.navigate", { url: "about:blank" });
  await page.s("Page.navigate", { url: `${server.base}/${hash}` });
  await until(`!!document.querySelector(".ask") && !!document.querySelector('#compose label.attach')`);
};
// In the page: files from a spec [name, type, size] (a real 1x1 PNG for image/png), a DataTransfer of them, a drop
// (dragover first, as a browser does) and a paste, and what a box's tray shows.
const HELPERS = `
  window.__files = (specs) => specs.map(([name, type, size]) => type === "image/png"
    ? new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], name, { type })
    : new File([new Uint8Array(size ?? 1234).fill(65)], name, { type }));
  window.__dt = (specs) => { const dt = new DataTransfer(); for (const f of window.__files(specs)) dt.items.add(f); return dt; };
  window.__drop = (sel, specs) => {
    const el = typeof sel === "string" ? document.querySelector(sel) : sel, dt = window.__dt(specs);
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(over);
    const lit = [...document.querySelectorAll(".dropping")].map((d) => d.dataset.composer ?? d.id ?? d.className);
    const drop = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(drop);
    return { over: over.defaultPrevented, lit, drop: drop.defaultPrevented, after: document.querySelectorAll(".dropping").length };
  };
  window.__paste = (sel, specs) => {
    const el = document.querySelector(sel);
    el.focus();
    const ev = new ClipboardEvent("paste", { clipboardData: window.__dt(specs), bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  window.__tray = (key) => [...document.querySelectorAll('[data-chips="' + key + '"] .chip')].map((c) => ({
    state: ["prep", "up", "done", "err"].find((s) => c.classList.contains(s)), kind: c.classList.contains("file") ? "file" : "image",
    name: c.querySelector(".fname")?.textContent ?? null, size: c.querySelector(".fsize")?.textContent ?? null, thumb: !!c.querySelector("img"), rm: !!c.querySelector("[data-chip-rm]") }));
`;
const tray = (key: string) => page.evaluate(`__tray(${JSON.stringify(key)})`);
const allDone = (key: string, n: number) => until(`(() => { const t = __tray(${JSON.stringify(key)}); return t.length === ${n} && t.every((c) => c.state === "done"); })()`);
const FILE_TOKEN = /\[file: (\/[^\]]+)\]/g, IMAGE_TOKEN = /\[image: (\/[^\]]+)\]/g;

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  server = await startServer(ROOT);
  askId = await seed(server.post);
  await server.post("/api/rooms", { slug: "ope-5", title: "Files room", owner: "golf" });
  page = await newSession(chrome.cdp, errors);
  await page.s("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
  await page.s("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
  await page.s("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await load();
}, 40_000);

afterAll(async () => {
  await server?.stop();
  await chrome?.close();
}, 20_000);

// One surface, from the drop to the sent message on the page.
type Surface = { key: string; open: () => Promise<void>; dropOn: string; pasteInto: string; send: () => Promise<void>; sent: () => Promise<string>; shown: () => Promise<string> };
async function roundTrip(s: Surface) {
  await s.open();
  const d = await page.evaluate(`__drop(${JSON.stringify(s.dropOn)}, [["spec sheet.pdf", "application/pdf", 1234], ["pic.png", "image/png"]])`);
  // The drop is the page's (no navigation), the box lights up while a file is over it, and the light goes after.
  expect(d).toEqual({ over: true, lit: [s.key], drop: true, after: 0 });
  await allDone(s.key, 2);
  expect(await tray(s.key)).toEqual([
    { state: "done", kind: "file", name: "spec sheet.pdf", size: "1.2 KB", thumb: false, rm: true },
    { state: "done", kind: "image", name: null, size: null, thumb: true, rm: true },
  ]);
  // Pasted into the box's field: a zip joins them.
  expect(await page.evaluate(`__paste(${JSON.stringify(s.pasteInto)}, [["notes.zip", "application/zip", 3 * 1024 * 1024]])`)).toBe(true);
  await allDone(s.key, 3);
  expect((await tray(s.key))[2]).toMatchObject({ kind: "file", name: "notes.zip", size: "3.0 MB" });
  // × removes one.
  await page.evaluate(`document.querySelectorAll('[data-chips=${JSON.stringify(s.key)}] [data-chip-rm]')[2].click()`);
  expect((await tray(s.key)).map((c: any) => c.name ?? "image")).toEqual(["spec sheet.pdf", "image"]);
  await s.send();
  await until(`__tray(${JSON.stringify(s.key)}).length === 0`);
  const text = await s.sent();
  const files = [...text.matchAll(FILE_TOKEN)].map((m) => m[1]), images = [...text.matchAll(IMAGE_TOKEN)].map((m) => m[1]);
  expect(files).toHaveLength(1);
  // Tell HQ, the card and the reply share uploads/: a name taken before gets -2, -3.
  expect(files[0]).toMatch(/\/spec sheet(-\d)?\.pdf$/);
  expect(images).toHaveLength(1);
  expect(images[0]).toMatch(/\/pic(-\d)?\.png$/);
  // The full path on this machine, so HQ or the lane can open it.
  expect(existsSync(files[0]) && existsSync(images[0])).toBe(true);
  expect(text).not.toContain("notes.zip");
  // The sent message: a thumbnail and a link named after the file.
  const sel = await s.shown();
  await until(`!!document.querySelector(${JSON.stringify(`${sel} a.file`)}) && !!document.querySelector(${JSON.stringify(`${sel} img.thumb`)})`);
  const link = await page.evaluate(`(() => { const a = document.querySelector(${JSON.stringify(`${sel} a.file`)}); return [a.textContent, a.getAttribute("href"), a.closest(".md, .ans") !== null]; })()`);
  expect(link[0]).toBe(files[0].split("/").pop());
  expect(link[1]).toMatch(/^\/(uploads|rooms\/ope-5\/files)\/spec%20sheet(-\d)?\.pdf$/);
  expect(link[2]).toBe(true);
  const res = await fetch(`${server.base}${link[1]}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toStartWith("attachment;");
}

describe.skipIf(!chromeFound)("files on every send box", () => {
  test("TELL HQ: drop on its panel, paste into its field, send, and the message shows a thumbnail and a file link", async () => {
    await roundTrip({
      key: "note",
      open: async () => {},
      dropOn: ".box.tell .head",
      pasteInto: "#noteText",
      send: async () => { await page.evaluate(`document.getElementById("noteText").value = "Have a look"; document.getElementById("compose").requestSubmit()`); },
      sent: async () => {
        await until(`document.getElementById("lastNote").textContent.includes("Have a look")`);
        return (await state()).notes[0].text;
      },
      shown: async () => {
        await page.evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
        const id = (await state()).notes[0].id;
        return `#msgs [data-msg="n${id}"]`;
      },
    });
    await page.evaluate(`document.querySelector('[data-qtab="questions"]').click()`);
  }, 30_000);

  test("NEEDS YOU: drop on the card, paste into its field, answer, and the answer shows them", async () => {
    const card = `[data-ask="${askId}"]`;
    await roundTrip({
      key: String(askId),
      open: async () => {},
      dropOn: `${card} h3`,
      pasteInto: `${card} textarea`,
      send: async () => {
        await page.evaluate(`document.querySelector('${card} .opt[data-opt="Yes"]').click()`);
        await until(`!!document.querySelector('${card} .opt.sel')`);
        await page.evaluate(`document.querySelector('${card} .send').click()`);
      },
      sent: async () => {
        await until(`!document.querySelector('${card}')`);
        return (await state()).answered.find((a: any) => a.id === askId).answer;
      },
      shown: async () => {
        // your answer is in the MESSAGES thread
        await page.evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
        return `#msgs [data-msg="a${askId}"]`;
      },
    });
  }, 30_000);

  test("MESSAGES: drop on the reply's panel, paste into it, send, and the reply shows them", async () => {
    await roundTrip({
      key: "reply",
      open: async () => {
        await page.evaluate(`document.querySelector('[data-qtab="messages"]').click()`);
        await until(`!!document.querySelector('#msgs [data-reply="u1"]')`);
        await page.evaluate(`document.querySelector('#msgs [data-reply="u1"]').click()`);
        await until(`!!document.querySelector("[data-rbox] textarea")`);
      },
      dropOn: "[data-rbox] .quote",
      pasteInto: "[data-rbox] textarea",
      send: async () => {
        await page.evaluate(`(() => { const t = document.querySelector("[data-rbox] textarea"); t.value = "Answer"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("[data-rsend]").click(); })()`);
      },
      sent: async () => {
        await until(`!document.querySelector("[data-rbox]")`);
        return (await state()).notes[0].text;
      },
      shown: async () => `#msgs [data-msg="n${(await state()).notes[0].id}"]`,
    });
    await page.evaluate(`document.querySelector('[data-qtab="questions"]').click()`);
  }, 30_000);

  test("a room: drop on the send box's panel, paste into it, send, and the thread shows them; the files are on the shelf", async () => {
    await roundTrip({
      key: "room:ope-5",
      open: async () => {
        await page.evaluate(`location.hash = "#room/ope-5"`);
        await until(`!document.getElementById("roomView").hidden && !!document.querySelector("#roomView .rsend textarea")`);
      },
      dropOn: "#roomView .rsend .rto",
      pasteInto: "#roomView .rsend textarea",
      send: async () => {
        await page.evaluate(`(() => { const t = document.querySelector("#roomView .rsend textarea"); t.value = "For the room"; t.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("[data-room-send]").click(); })()`);
      },
      sent: async () => {
        await until(`[...document.querySelectorAll("#roomView .rthread [data-rmsg]")].some((m) => m.textContent.includes("For the room"))`);
        const r = await (await fetch(`${server.base}/api/rooms/ope-5`)).json();
        return r.messages.at(-1).text;
      },
      shown: async () => {
        const r = await (await fetch(`${server.base}/api/rooms/ope-5`)).json();
        return `#roomView .rthread [data-rmsg="${r.messages.at(-1).id}"]`;
      },
    });
    const r = await (await fetch(`${server.base}/api/rooms/ope-5`)).json();
    // In the room's folder and on its shelf; the removed zip came off again.
    expect(r.artifactList.map((a: any) => [a.title, a.kind])).toEqual([["spec sheet.pdf", "file"], ["pic.png", "image"]]);
    expect(r.artifactList[0].path).toEndWith("/rooms/ope-5/files/spec sheet.pdf");
    await page.evaluate(`location.hash = ""`);
    await until(`document.getElementById("roomView").hidden`);
  }, 30_000);

  test("a drop anywhere else on the page does nothing, and never opens the file in place of the page", async () => {
    for (const sel of ["#room", ".topbar, header", "#menuBtn", ".qtabs"]) {
      const d = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? __drop(el, [["stray.pdf", "application/pdf"]]) : null; })()`);
      if (!d) continue;
      expect([sel, d]).toEqual([sel, { over: true, lit: [], drop: true, after: 0 }]);
    }
    expect(await page.evaluate(`document.querySelectorAll(".chips .chip").length`)).toBe(0);
  });

  test("refused kinds, a file over 25 MB and an eleventh attachment say why in one line each, and upload nothing", async () => {
    await page.evaluate(`__drop(".box.tell .head", [["page.html", "text/html"], ["logo.svg", "image/svg+xml"], ["tool.exe", "application/x-msdownload"], ["fake.pdf", "text/html"], ["big.mp4", "video/mp4", 25 * 1024 * 1024 + 1]])`);
    await until(`__tray("note").length === 5 && __tray("note").every((c) => c.state === "err")`);
    const why = await page.evaluate(`[...document.querySelectorAll('[data-chips="note"] .why')].map((w) => [w.textContent, Math.round(w.getBoundingClientRect().height / parseFloat(getComputedStyle(w).lineHeight))])`);
    expect(why.map((w: any) => w[0])).toEqual([
      "page.html: .html files cannot be attached.",
      "logo.svg: .svg files cannot be attached.",
      "tool.exe: .exe files cannot be attached.",
      "fake.pdf: its type (text/html) does not match .pdf.",
      "big.mp4 is 25.0 MB; the limit is 25 MB.",
    ]);
    expect(why.every((w: any) => w[1] === 1)).toBe(true);
    expect(await page.evaluate(`[...document.querySelectorAll('[data-chips="note"] .chip')].every((c) => c.querySelector(".fname") && !c.querySelector("[data-chip-retry]"))`)).toBe(true);
    for (let i = 0; i < 5; i++) await page.evaluate(`document.querySelector('[data-chips="note"] [data-chip-rm]').click()`);
    // Ten at most per message: the eleventh is refused, the ten upload.
    const eleven = Array.from({ length: 11 }, (_, i) => [`part-${i + 1}.txt`, "text/plain", 10]);
    await page.evaluate(`__drop(".box.tell .head", ${JSON.stringify(eleven)})`);
    await until(`__tray("note").filter((c) => c.state === "done").length === 10`);
    expect((await tray("note")).map((c: any) => c.state)).toEqual([...Array(10).fill("done"), "err"]);
    expect(await page.evaluate(`document.querySelector('[data-chips="note"] .why').textContent`)).toBe("part-11.txt: 10 attachments per message at most.");
    for (let i = 0; i < 11; i++) await page.evaluate(`document.querySelector('[data-chips="note"] [data-chip-rm]').click()`);
    expect(await tray("note")).toEqual([]);
  }, 30_000);

  test("a draft keeps its files, with name and size, through a reload; sending waits for an upload", async () => {
    await page.evaluate(`__drop(".box.tell .head", [["kept.csv", "text/csv", 2048]])`);
    await allDone("note", 1);
    await page.evaluate(`location.reload()`);
    await until(`!!document.querySelector('[data-chips="note"] .chip.file.done')`);
    expect(await tray("note")).toEqual([{ state: "done", kind: "file", name: "kept.csv", size: "2.0 KB", thumb: false, rm: true }]);
    await page.evaluate(`document.getElementById("compose").requestSubmit()`);
    await until(`__tray("note").length === 0`);
    expect((await state()).notes[0].text).toMatch(/^\[file: \/\S+\/uploads\/kept\.csv\]$/);
  }, 30_000);

  test("the attach button takes images and the allowed files, several at once; a picked file joins the tray", async () => {
    const accept = await page.evaluate(`[...document.querySelectorAll("input[data-attach]")].map((i) => [i.accept, i.multiple])`);
    for (const [a, m] of accept) {
      expect(a.split(",")).toEqual(expect.arrayContaining(["image/*", ".pdf", ".zip", ".docx", ".mp4", ".m4a", ".md"]));
      expect(a).not.toMatch(/html|svg|\.js(,|$)|\.sh(,|$)|\.exe|\.app|\.dmg|\.pkg/);
      expect(m).toBe(true);
    }
    await page.evaluate(`(() => { const i = document.querySelector('input[data-attach="note"]'); i.files = __dt([["picked.docx", ""]]).files; i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await allDone("note", 1);
    expect((await tray("note"))[0]).toMatchObject({ kind: "file", name: "picked.docx" });
    await page.evaluate(`document.querySelector('[data-chips="note"] [data-chip-rm]').click()`);
    expect(errors).toEqual([]);
  });
});
