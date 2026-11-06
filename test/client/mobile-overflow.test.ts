// The whole page on three phones, in Chrome with touch, on data that stresses a narrow screen (test/mobile-walk.ts): on
// every surface no sideways scroll, nothing past the viewport and no target under 44 px; a press shows; the room stays
// live; under reduced motion nothing runs. Needs Chrome; skipped without it. MOBILE_ROOT runs the server from another
// tree, to prove the test fails where the page spills: git archive main | tar -x -C DIR, then MOBILE_ROOT=DIR.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { findChrome, startChrome } from "../../scripts/room-hash.ts";
import { AUDIT, LOOKS, MEASURE, PHONES, SURFACES, WIDEST_COUNTS, type Office, type Tab, openPhone, openSurface, startOffice } from "../mobile-walk.ts";

const ROOT = process.env.MOBILE_ROOT ?? join(import.meta.dir, "..", "..");
const chromeFound = !!findChrome();
let chrome: Awaited<ReturnType<typeof startChrome>>;
let office: Office;
let tab: Tab;
const errors: string[] = [];
const lookOf: Record<string, Record<string, string[]>> = {};

beforeAll(async () => {
  if (!chromeFound) return;
  chrome = await startChrome();
  office = await startOffice(ROOT);
  tab = await openPhone(chrome, errors);
}, 60_000);

afterAll(async () => {
  await tab?.s("Page.navigate", { url: "about:blank" });
  await office?.stop();
  await chrome?.close();
});

for (const phone of PHONES) {
  for (const surface of SURFACES) {
    test.skipIf(!chromeFound)(`${phone.width}x${phone.height} ${surface.name}: no sideways scroll, nothing past the edge`, async () => {
      await tab.size(phone);
      await openSurface(tab, office, surface);
      const m = await tab.ev(MEASURE);
      expect(m.spills).toEqual([]);
      expect(m.moved).toBe(false);
      expect(m.scrollers).toEqual([]);
      expect(m.clipped).toEqual([]);
      expect(m.scrollW).toBeLessThanOrEqual(m.vw);
      const { taps } = await tab.ev(AUDIT);
      expect(taps).toEqual([]);
      if (surface.sheet) {
        const edges = await tab.ev(`(() => { const r = document.querySelector(${JSON.stringify(surface.sheet)}).getBoundingClientRect(); return [r.left, document.documentElement.clientWidth - r.right]; })()`);
        expect(edges).toEqual([8, 8]);
      }
      const looks = await tab.ev(LOOKS);
      for (const [kind, seen] of Object.entries(looks) as [string, Record<string, string[]>][]) {
        const all = (lookOf[kind] ??= {});
        for (const [look, labels] of Object.entries(seen)) all[look] = [...new Set([...(all[look] ?? []), ...labels])];
      }
    }, 30_000);
  }
}

test.skipIf(!chromeFound)("across every surface, one look per kind of action", () => {
  for (const [kind, looks] of Object.entries(lookOf)) expect({ kind, looks: Object.keys(looks).length, seen: looks }).toEqual({ kind, looks: 1, seen: looks });
});

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} the scope row reads whole, its chip the floor's colour and the way out`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "office")!);
    const row = await tab.ev(`(() => { const w = document.querySelector(".sall .swhat"), s = document.querySelector(".sall"), g = document.querySelector(".sall .sgo").getBoundingClientRect(), x = document.querySelector(".schip .sx").getBoundingClientRect(); return { cut: w.scrollWidth > w.clientWidth || s.scrollWidth > s.clientWidth, goInside: g.right <= s.getBoundingClientRect().right, out: x.width >= 44 && x.height >= 44, label: document.querySelector(".schip .sx").getAttribute("aria-label") }; })()`);
    expect(row).toEqual({ cut: false, goInside: true, out: true, label: expect.stringContaining("Payments") });
  }, 30_000);
}

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} a brief's and a page's bar: each label on one line, the sheet's close inside the sheet`, async () => {
    await tab.size(phone);
    const lines = `[...document.querySelectorAll(".bvbar .btn-s, .pvbar .btn-s")].filter((b) => b.getBoundingClientRect().width).map((b) => { const r = document.createRange(); r.selectNodeContents(b); return [...new Set([...r.getClientRects()].map((c) => Math.round(c.top)))].length; })`;
    for (const name of ["brief", "page"]) {
      await openSurface(tab, office, SURFACES.find((s) => s.name === name)!);
      const seen: number[] = await tab.ev(lines);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.filter((n) => n > 1)).toEqual([]);
    }
    await openSurface(tab, office, SURFACES.find((s) => s.name === "page-comments")!);
    expect(await tab.ev(`(() => { const x = document.querySelector(".cclose").getBoundingClientRect(), m = document.querySelector(".cmount.open").getBoundingClientRect(); return x.top >= m.top && x.right <= m.right; })()`)).toBe(true);
  }, 30_000);
}

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} all five question tabs show whole with the widest counts, as 44 px targets`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
    await tab.ev(`document.fonts.ready.then(() => true)`);
    await tab.ev(WIDEST_COUNTS);
    const tabs = await tab.ev(`[...document.querySelectorAll("#qtabs [data-qtab]")].map((t) => { const r = t.getBoundingClientRect(), q = document.getElementById("qtabs"), b = q.getBoundingClientRect(); return { name: t.dataset.qtab, inside: r.left >= Math.max(0, b.left) && r.right <= Math.min(document.documentElement.clientWidth, b.right), target: r.width >= 44 && r.height >= 44, whole: t.scrollWidth <= t.clientWidth, count: !!t.querySelector(".tag:not([hidden])"), scrolls: q.scrollWidth > q.clientWidth + 1 }; })`);
    expect(tabs).toEqual(["questions", "messages", "work", "rooms", "briefs"].map((name) => ({ name, inside: true, target: true, whole: true, count: true, scrolls: false })));
    const m = await tab.ev(MEASURE);
    expect(m.scrollers).toEqual([]);
    expect(m.clipped).toEqual([]);
  }, 30_000);
}

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} every open room is one pick away from a room, and the picker goes there`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "room-chat")!);
    const picker = await tab.ev(`(() => { const b = document.querySelector(".rvjump").getBoundingClientRect(), s = document.querySelector(".rvjump select"), back = document.querySelector(".rvbar .back").getBoundingClientRect(); return { rooms: [...s.options].map((o) => o.value).sort(), chosen: s.value, target: b.width >= 44 && b.height >= 44, inside: b.right <= document.documentElement.clientWidth - 16, apart: back.right <= b.left, backWhole: document.querySelector(".rvbar .back").scrollWidth <= document.querySelector(".rvbar .back").clientWidth }; })()`);
    expect(picker).toEqual({ rooms: ["crm-short", "ops-drill-with-a-long-slug-for-the-tile", "pay-migration"], chosen: "pay-migration", target: true, inside: true, apart: true, backWhole: true });
    await tab.ev(`(() => { const s = document.querySelector(".rvjump select"); s.value = "crm-short"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await tab.until(`location.hash === "#room/crm-short" && document.querySelector(".rvjump select").value === "crm-short"`);
  }, 30_000);
}

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} a question's SEND is one colour, a disabled one reads, a lane tag is rounded, MORE adds no height`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
    const q = await tab.ev(`(() => {
      const c = (e) => { const s = getComputedStyle(e); return { fill: s.backgroundColor, ink: s.color, opacity: s.opacity }; };
      const live = [...document.querySelectorAll("#hud .ask .send:not(:disabled), .tell .send:not(:disabled)")].map(c);
      const quiet = [...document.querySelectorAll("#hud .ask .send:disabled")].map(c);
      const lane = getComputedStyle(document.querySelector("#hud .ask .tag.lane"));
      const body = [...document.querySelectorAll("#hud .ask")].find((a) => a.querySelector("h3")?.textContent === "A long body").querySelector(".text p");
      const r = document.createRange(); r.selectNodeContents(body);
      const tops = [...new Set([...r.getClientRects()].map((x) => x.top))].sort((a, b) => a - b);
      return { liveLooks: new Set(live.map((x) => x.fill + x.ink)).size, liveFill: live[0]?.fill, quiet: quiet[0], quietLooks: new Set(quiet.map((x) => x.fill)).size, corner: lane.borderTopLeftRadius.split(" ").map(parseFloat), border: parseFloat(lane.borderTopWidth), steps: tops.slice(1).map((t, i) => t - tops[i]), lines: tops.length };
    })()`);
    expect(q.liveLooks).toBe(1);
    expect(q.quietLooks).toBe(1);
    expect(q.quiet.opacity).toBe("1");
    // A SEND that cannot act yet does not look like one that can.
    expect(q.quiet.fill).not.toBe(q.liveFill);
    const parse = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const lum = (c: number[]) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const [hi, lo] = [lum(parse(q.quiet.fill)), lum(parse(q.quiet.ink))].sort((a, b) => b - a);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5);
    // The clear border leaves the 4 px corner of every tag.
    expect([q.corner[0], q.corner[1] - q.border]).toEqual([4, 4]);
    expect(q.lines).toBeGreaterThan(1);
    // The last line, the one MORE sits on, is as far from the one above as every other line.
    expect(Math.max(...q.steps) - Math.min(...q.steps)).toBeLessThanOrEqual(1);
  }, 30_000);
}

test.skipIf(!chromeFound)("on the work board a lane tag is a 44 px target that shows the whole name", async () => {
  await tab.size(PHONES[1]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "work-board")!);
  const tag = await tab.ev(`(() => { const e = document.querySelector("#work .tag.lane"), r = e.getBoundingClientRect(); return { target: r.height >= 44 && r.width >= 44, whole: e.scrollWidth <= e.clientWidth, name: e.textContent.trim() }; })()`);
  expect(tag).toEqual({ target: true, whole: true, name: expect.stringContaining("migration") });
}, 30_000);

test.skipIf(!chromeFound)("the ledger keeps to its card through what arrives, on the keyed cards", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "ledger")!);
  const card = `document.querySelector("#hud .ask:has(.ledger)")`;
  const id = await tab.ev(`${card}.dataset.ask`);
  const comments = `document.querySelectorAll('#hud [data-ask="${id}"] .ledger .lc').length`;
  await tab.ev(`document.querySelector('#hud [data-ask="${id}"] [data-ledger-more]').click()`);
  const before = await tab.ev(comments);
  await office.post(`/api/asks/${id}/comment`, { text: "One more note, on a live card." });
  await tab.until(`${comments} === ${before + 1}`);
  const other = await office.post("/api/asks", { lane: "crm-dedupe", kind: "decision", title: "Arrives above the ledger", options: ["Yes", "No"], due: Date.now() + 3_600_000 });
  await tab.until(`!!document.querySelector('#hud [data-ask="${other.id}"]')`);
  expect(await tab.ev(comments)).toBe(before + 1);
  await office.post(`/api/asks/${other.id}/answer`, { answer: "Yes" });
  await tab.until(`!document.querySelector('#hud [data-ask="${other.id}"]')`);
  expect(await tab.ev(comments)).toBe(before + 1);
  await office.post(`/api/asks/${id}/items`, { text: "A second item, on a live card." });
  await tab.until(`document.querySelectorAll('#hud [data-ask="${id}"] .ledger .lchk li').length === 2`);
  expect(await tab.ev(`document.querySelectorAll("#hud .ledger").length`)).toBe(1);
}, 30_000);

test.skipIf(!chromeFound)("the open question comes first: its title in the top half of the first screen, and an alarm above it", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
  const top = (sel: string) => tab.ev(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY`);
  expect(await top("#hud .ask h3")).toBeLessThan(PHONES[0].height / 2);
  expect(await top(".top .strip")).toBeGreaterThan(await top(".main"));
  await tab.ev(`document.querySelector(".top .strip").classList.add("nomove")`);
  expect(await top(".top .strip")).toBeLessThan(await top("#hud .ask"));
}, 30_000);

test.skipIf(!chromeFound)("a press shows on touch: a button under a finger changes", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, { name: "menu", go: (t) => t.tap("#menuBtn"), shows: "#menuDrop:not([hidden])" });
  const { root } = await tab.s("DOM.getDocument");
  const { nodeId } = await tab.s("DOM.querySelector", { nodeId: root.nodeId, selector: "#menuBtn" });
  await tab.s("CSS.enable");
  const filter = `getComputedStyle(document.getElementById("menuBtn")).filter`;
  expect(await tab.ev(filter)).toBe("none");
  await tab.s("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
  expect(await tab.ev(filter)).not.toBe("none");
  await tab.s("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
}, 30_000);

test.skipIf(!chromeFound)("the office stays live and whole on a phone", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "office")!);
  await tab.ev(`document.getElementById("room").scrollIntoView({ block: "center", behavior: "instant" })`);
  const box = await tab.ev(`(() => { const r = document.getElementById("room").getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height, vw: document.documentElement.clientWidth }; })()`);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.vw);
  expect(box.width).toBeGreaterThan(box.vw * 0.8);
  expect(box.height).toBeGreaterThan(200);
  const first = await tab.ev(`document.getElementById("room").toDataURL()`);
  await tab.until(`document.getElementById("room").toDataURL() !== ${JSON.stringify(first)}`, 10_000);
}, 30_000);

test.skipIf(!chromeFound)("asked for less motion: no animation runs, the count rests, nothing is hidden", async () => {
  await tab.size(PHONES[0]);
  await tab.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
    await Bun.sleep(1200);
    const running = await tab.ev(`document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName ?? a.transitionProperty)`);
    expect(running).toEqual([]);
    expect(await tab.ev(`getComputedStyle(document.querySelector("#sWait .count")).opacity`)).toBe("1");
    expect(await tab.ev(`(() => { const r = document.querySelector("#hud .ask").getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`)).toBe(true);
    // The room rests too, once its workers have reached their seats: the same picture a second apart.
    await openSurface(tab, office, SURFACES.find((s) => s.name === "office")!);
    await tab.ev(`document.getElementById("room").scrollIntoView({ block: "center", behavior: "instant" })`);
    const still = async () => {
      for (const end = Date.now() + 15_000; Date.now() < end; ) {
        const a = await tab.ev(`document.getElementById("room").toDataURL()`);
        await Bun.sleep(1000);
        if (a === (await tab.ev(`document.getElementById("room").toDataURL()`))) return true;
      }
      return false;
    };
    expect(await still()).toBe(true);
  } finally {
    await tab.s("Emulation.setEmulatedMedia", { features: [] });
  }
}, 45_000);
