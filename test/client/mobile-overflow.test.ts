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
}, 180_000);

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
      const looks = await tab.ev(LOOKS);
      for (const [kind, seen] of Object.entries(looks) as [string, Record<string, string[]>][]) {
        const all = (lookOf[kind] ??= {});
        for (const [look, labels] of Object.entries(seen)) all[look] = [...new Set([...(all[look] ?? []), ...labels])];
      }
    }, 180_000);
  }
}

// ---- the one sheet ----

const SHEETS = SURFACES.filter((s) => s.sheet);
const sheetLooks = new Set<string>();
for (const phone of PHONES) {
  for (const surface of SHEETS) {
    test.skipIf(!chromeFound)(`${phone.width}x${phone.height} ${surface.name}: one sheet: anchored, scrim, page locked, an outside tap closes it`, async () => {
      await tab.size(phone);
      await openSurface(tab, office, surface);
      await tab.rest();
      const sel = JSON.stringify(surface.sheet);
      const at = await tab.ev(`(() => { const e = document.querySelector(${sel}), r = e.getBoundingClientRect(), c = getComputedStyle(e), bg = document.querySelector(".sheetbg"), v = document.documentElement.clientWidth; return { position: c.position, left: r.left, right: v - r.right, bottom: innerHeight - r.bottom, top: r.top, scrim: !!bg && !bg.hidden && getComputedStyle(bg).position === "fixed", under: document.elementFromPoint(v / 2, Math.max(2, r.top / 2))?.className, locked: getComputedStyle(document.documentElement).overflowY, look: [c.borderTopWidth, c.borderTopColor, c.borderTopLeftRadius, c.boxShadow, c.animationName, c.animationDuration, c.overscrollBehaviorY].join(" | "), inside: e.scrollWidth <= e.clientWidth + 1 }; })()`);
      expect(at).toMatchObject({ position: "fixed", left: 8, right: 8, bottom: 8, scrim: true, under: "sheetbg", locked: "hidden", inside: true });
      expect(at.top).toBeGreaterThanOrEqual(8);
      sheetLooks.add(at.look);
      const y = await tab.ev(`scrollY`);
      await tab.s("Input.synthesizeScrollGesture", { x: phone.width / 2, y: Math.max(4, at.top / 2), yDistance: -300, gestureSourceType: "touch", speed: 3000 });
      expect(await tab.ev(`scrollY`)).toBe(y);
      await tab.tapAt(phone.width / 2, Math.max(2, at.top / 2));
      await tab.until(`(() => { const e = document.querySelector(${sel}); return !e || !e.classList.contains("sheet"); })()`);
      // A sheet under this one (SECRETS under its confirmation) stays; with none, the page is free again.
      const under = await tab.ev(`!!document.querySelector(".sheet")`);
      expect(await tab.ev(`document.documentElement.classList.contains("sheetopen")`)).toBe(under);
      expect(await tab.ev(`document.querySelector(".sheetbg").hidden`)).toBe(!under);
    }, 180_000);
  }
}

test.skipIf(!chromeFound)("every sheet has one border, radius, shadow and motion, the drawer's 0.18 s", () => {
  expect([...sheetLooks].length).toBe(1);
  expect([...sheetLooks][0]).toContain("0.18s");
});

for (const name of ["secrets", "menu", "subs", "floor-add"]) {
  test.skipIf(!chromeFound)(`with ${name} open, a tap on an answer behind it selects nothing`, async () => {
    await tab.size(PHONES[0]);
    await openSurface(tab, office, SURFACES.find((s) => s.name === name)!);
    await tab.rest();
    const spot = await tab.ev(`(() => { const top = document.querySelector(".sheet").getBoundingClientRect().top; const o = [...document.querySelectorAll("#hud .opt")].map((x) => x.getBoundingClientRect()).find((r) => r.bottom > 0 && r.top + r.height / 2 < top); return o ? [o.left + o.width / 2, o.top + o.height / 2] : [195, Math.max(2, top / 2)]; })()`);
    await tab.tapAt(spot[0], spot[1]);
    await Bun.sleep(200);
    expect(await tab.ev(`document.querySelectorAll("#hud .opt.sel").length`)).toBe(0);
  }, 180_000);
}

for (const name of ["agent-drawer", "menu", "secrets"]) {
  test.skipIf(!chromeFound)(`Back with ${name} open closes it and stays in the app; Back again is not lost`, async () => {
    await tab.size(PHONES[0]);
    await openSurface(tab, office, SURFACES.find((s) => s.name === name)!);
    const url = await tab.ev(`location.href`);
    await tab.ev(`history.back()`);
    await tab.until(`!document.querySelector(".sheet")`);
    // Opened through MENU, MENU's entry is under it: Back goes on through that too, so the next Back is a real one.
    await tab.until(`!history.state?.hqSheet`, 5000);
    expect(await tab.ev(`location.href`)).toBe(url);
    expect(await tab.ev(`!!document.getElementById("hud")`)).toBe(true);
  }, 180_000);
}

test.skipIf(!chromeFound)("turning wide with a sheet open does not go back: a navigation right then still lands", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "menu")!);
  await tab.ev(`window.__pops = 0; addEventListener("popstate", () => { window.__pops++; })`);
  await tab.s("Emulation.setTouchEmulationEnabled", { enabled: false });
  await tab.s("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await tab.until(`!document.querySelector(".sheet")`);
  await tab.rest();
  await tab.until(`new Promise((ok) => setTimeout(() => ok(true), 100))`);
  expect(await tab.ev(`window.__pops`)).toBe(0);
}, 180_000);

test.skipIf(!chromeFound)("a closed sheet takes its Back entry with it, so the next Back is a real one", async () => {
  await tab.size(PHONES[0]);
  await tab.load(office.base, "", {});
  await tab.tap("#menuBtn");
  await tab.until(`!!document.querySelector(".sheet")`);
  await tab.rest();
  await tab.tapAt(195, 3);
  await tab.until(`!document.querySelector(".sheet") && !history.state?.hqSheet`);
  // With nothing open, Back leaves: the page before this one was about:blank.
  await tab.s("Runtime.evaluate", { expression: "history.back()" }).catch(() => {});
  await tab.until(`location.protocol !== "http:"`);
}, 180_000);

test.skipIf(!chromeFound)("after a confirmation in a room, BACK leaves the room and the next link still opens", async () => {
  await tab.size(PHONES[0]);
  await tab.load(office.base, "", { "hq-qtab": "rooms" });
  await tab.tap('#rooms article[data-room="pay-migration"]');
  await tab.until(`location.hash === "#room/pay-migration"`);
  await tab.tap("[data-room-close]");
  await tab.until(`!!document.querySelector(".confirm.sheet")`);
  await tab.rest();
  await tab.tapAt(195, 3);
  await tab.until(`!document.querySelector(".sheet") && !history.state?.hqSheet`);
  await tab.tap("[data-room-back]");
  await tab.until(`location.hash === "" && document.querySelector(".roomview").hidden`);
  await tab.ev(`location.hash = "#brief/${office.ids.brief}"`);
  await tab.until(`(() => { const e = document.querySelector(".briefview .bbody"); return !!e && e.getBoundingClientRect().height > 0; })()`);
  await tab.rest();
  expect(await tab.ev(`location.hash`)).toBe(`#brief/${office.ids.brief}`);
}, 180_000);

test.skipIf(!chromeFound)("CLOSE ROOM asks in a sheet you can read whole; KEEP keeps it, CLOSE closes it", async () => {
  await tab.size(PHONES[1]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "close-room-confirm")!);
  const said = await tab.ev(`(() => { const p = document.querySelector(".confirm p"), r = p.getBoundingClientRect(); return { text: p.textContent, inside: r.left >= 0 && r.right <= document.documentElement.clientWidth }; })()`);
  expect(said.inside).toBe(true);
  expect(said.text).toContain("stops taking messages");
  await tab.tap(".confirmno");
  await tab.until(`!document.querySelector(".sheet")`);
  expect(await tab.ev(`!!document.querySelector("[data-room-close]")`)).toBe(true);
}, 180_000);

test.skipIf(!chromeFound)("a long toast wraps inside the screen", async () => {
  await tab.size(PHONES[1]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "toast-long")!);
  const r = await tab.ev(`(() => { const r = document.querySelector(".toast").getBoundingClientRect(); return [r.left, document.documentElement.clientWidth - r.right]; })()`);
  expect(r[0]).toBeGreaterThanOrEqual(8);
  expect(r[1]).toBeGreaterThanOrEqual(8);
}, 180_000);

// ---- the drawer ----

const openLaneDrawer = async (name: string) => {
  await tab.size(PHONES[0]);
  await tab.load(office.base, "", { "hq-layout": "board" });
  await tab.tap('.tgo[data-floor-go="pay"]');
  await tab.tap('.tenterb[data-floor-go="pay"]');
  await tab.until(`!!document.querySelector('[data-lane-pick="${name}"]')`);
  await tab.tap(`[data-lane-pick="${name}"]`);
  await tab.until(`document.getElementById("card").classList.contains("sheet")`);
  await tab.rest();
};

test.skipIf(!chromeFound)("the drawer: its terminal comes before the questions, its close stays on screen, options read as text", async () => {
  await openLaneDrawer("ledger-audit");
  const d = await tab.ev(`(() => { const c = document.getElementById("card"), t = c.querySelector(".agterm").getBoundingClientRect(), q = c.querySelector(".agq").getBoundingClientRect(), o = getComputedStyle(c.querySelector(".agopts span")); return { questions: c.querySelectorAll(".agq").length, termFirst: t.top < q.top, termOnScreen: t.top < innerHeight - 100, optBorder: o.borderTopWidth, optFill: o.backgroundColor }; })()`);
  expect(d).toEqual({ questions: 3, termFirst: true, termOnScreen: true, optBorder: "0px", optFill: "rgba(0, 0, 0, 0)" });
  await tab.ev(`document.getElementById("card").scrollTop = 1e6`);
  await tab.rest();
  const x = await tab.ev(`(() => { const c = document.getElementById("card"), r = c.querySelector(".cardx").getBoundingClientRect(), b = c.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { scrolled: c.scrollTop > 100, inside: r.top >= b.top && r.bottom <= b.bottom && r.top >= 0, top: hit?.closest("[data-card-close]") !== null }; })()`);
  expect(x).toEqual({ scrolled: true, inside: true, top: true });
  await tab.tap(".cardx");
  await tab.until(`document.getElementById("card").hidden`);
}, 180_000);

test.skipIf(!chromeFound)("a tap in the middle of a ROOMS tile opens the room, not the lane", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "rooms-list")!);
  const at = await tab.ev(`(() => { const e = document.querySelector('#rooms article[data-room="crm-short"]'); e.scrollIntoView({ block: "center", behavior: "instant" }); const l = e.querySelector(".rlane").getBoundingClientRect(); return [l.left + l.width / 2, l.top + l.height / 2]; })()`);
  await tab.tapAt(at[0], at[1]);
  await tab.until(`location.hash === "#room/crm-short"`);
  expect(await tab.ev(`document.getElementById("card").hidden`)).toBe(true);
}, 180_000);

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} the scope row is quiet with a red count, and its way out says so`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "office")!);
    const r = await tab.ev(`(() => { const a = document.querySelector(".sall"), n = a.querySelector(".sn"), box = getComputedStyle(document.querySelector(".tell")).backgroundColor, x = document.querySelector(".sx"); return { barIsPanel: getComputedStyle(a).backgroundColor === box, count: n?.textContent.trim().startsWith("+"), countRed: getComputedStyle(n).color !== getComputedStyle(a).color, word: x.innerText.includes("LEAVE"), whole: a.scrollWidth <= a.clientWidth && x.scrollWidth <= x.clientWidth }; })()`);
    expect(r).toEqual({ barIsPanel: true, count: true, countRed: true, word: true, whole: true });
  }, 180_000);
}

test.skipIf(!chromeFound)("from MENU, without scrolling past the list: TELL HQ opens in a sheet and the office is a jump with a way back", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
  await tab.ev(`scrollTo(0, 600)`);
  await tab.ev(`scrollTo(0, 0)`);
  await tab.tap("#menuBtn");
  await tab.tap("#menuTell");
  await tab.until(`document.querySelector(".tell").classList.contains("sheet")`);
  await tab.rest();
  const t = await tab.ev(`(() => { const a = document.getElementById("noteText"); return { focused: document.activeElement === a, y: scrollY, onScreen: a.getBoundingClientRect().bottom <= innerHeight }; })()`);
  expect(t).toEqual({ focused: true, y: 0, onScreen: true });
  await tab.tapAt(195, 20);
  await tab.until(`!document.querySelector(".tell").classList.contains("sheet")`);
  await tab.tap("#menuBtn");
  await tab.tap("#menuOffice");
  await tab.until(`(() => { const r = document.querySelector(".stage").getBoundingClientRect(); return r.top < innerHeight * .5 && r.top >= -2; })()`);
  await Bun.sleep(200);
  await tab.tap(".jumpback");
  await tab.until(`scrollY === 0`);
  expect(await tab.ev(`!!document.querySelector(".jumpback:not([hidden])")`)).toBe(false);
  await tab.tap("#menuBtn");
  await tab.tap("#menuSubs");
  await tab.until(`document.getElementById("subsDrop").classList.contains("sheet")`);
  expect(await tab.ev(`scrollY`)).toBe(0);
}, 180_000);

test.skipIf(!chromeFound)("a room's strip folds while its composer has focus, and the chat gets the room", async () => {
  await tab.s("Emulation.setDeviceMetricsOverride", { width: 390, height: 508, deviceScaleFactor: 3, mobile: true });
  await tab.s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.load(office.base, "#room/pay-migration", {});
  await tab.until(`!!document.querySelector(".rsend textarea")`);
  await tab.rest();
  const h = `document.querySelector(".rthread").getBoundingClientRect().height`;
  const before = await tab.ev(h);
  await tab.tap(".rsend textarea");
  await tab.until(`document.activeElement === document.querySelector(".rsend textarea")`);
  await tab.rest();
  expect(await tab.ev(`getComputedStyle(document.querySelector(".rvpix")).display`)).toBe("none");
  expect(await tab.ev(h)).toBeGreaterThan(before + 60);
  await tab.ev(`document.activeElement.blur()`);
  await tab.until(`getComputedStyle(document.querySelector(".rvpix")).display !== "none"`);
}, 180_000);

test.skipIf(!chromeFound)("no keyboard hint on a touch screen outside the question panel", async () => {
  await tab.size(PHONES[0]);
  for (const name of ["messages", "message-reply", "room-chat", "brief-comment-sheet", "tell-sheet"]) {
    await openSurface(tab, office, SURFACES.find((s) => s.name === name)!);
    const seen = await tab.ev(`[...document.querySelectorAll("[placeholder], .hint")].filter((e) => !e.closest("#hud") && e.getBoundingClientRect().height > 0 && /⌘/.test(e.placeholder || e.textContent)).map((e) => e.placeholder || e.textContent)`);
    expect(seen).toEqual([]);
  }
}, 180_000);

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} the add-a-floor sheet: START A NEW HQ on one line, swatches in two even rows, no dimmed ones`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "floor-add")!);
    const f = await tab.ev(`(() => { const lines = (e) => { const r = document.createRange(); r.selectNodeContents(e); return new Set([...r.getClientRects()].map((c) => Math.round(c.top))).size; }; const sw = [...document.querySelectorAll(".fcolor")].filter((c) => c.getBoundingClientRect().width > 0); const rows = {}; for (const c of sw) { const t = Math.round(c.getBoundingClientRect().top); rows[t] = (rows[t] || 0) + 1; } return { oneLine: [...document.querySelectorAll(".fphow .seg")].every((s) => lines(s) === 1), dimmed: sw.filter((c) => c.disabled).length, lonely: Object.values(rows).some((n) => n === 1 && sw.length > 1), big: sw.every((c) => c.getBoundingClientRect().width >= 44) }; })()`);
    expect(f).toEqual({ oneLine: true, dimmed: 0, lonely: false, big: true });
  }, 180_000);
}

test.skipIf(!chromeFound)("one close mark across every sheet, and the shelf hides the raw folder path", async () => {
  await tab.size(PHONES[0]);
  const marks = new Set<string>();
  for (const [name, sel] of [["secrets", ".spx"], ["new-room", ".spx"], ["floor-add", ".fpanel .fpx"], ["floor-list", ".fmenu .fpx"], ["agent-drawer", ".cardx"], ["settings", "#settings [data-close]"], ["page-comments", ".cclose"]]) {
    await openSurface(tab, office, SURFACES.find((s) => s.name === name)!);
    marks.add(await tab.ev(`document.querySelector(${JSON.stringify(sel)}).textContent.trim()`));
  }
  expect([...marks]).toEqual(["✕"]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "room-shelf")!);
  expect(await tab.ev(`(() => { const f = document.querySelector(".rfolder"); return !f || f.getBoundingClientRect().height === 0; })()`)).toBe(true);
}, 180_000);

test("no :hover rule lacks a hover-capable guard, so a finger leaves nothing behind", () => {
  const glob = new Bun.Glob("src/client/**/*.css");
  const bad: string[] = [];
  for (const f of glob.scanSync(ROOT)) {
    let depth = 0, guarded = -1;
    for (const [i, line] of require("node:fs").readFileSync(join(ROOT, f), "utf8").split("\n").entries()) {
      if (/@media[^{]*\(hover: hover\)/.test(line)) { const inline = line.includes(":hover"); if (inline) continue; guarded = depth; }
      if (line.includes(":hover") && guarded < 0) bad.push(`${f}:${i + 1}`);
      for (const c of line) { if (c === "{") depth++; if (c === "}") { depth--; if (depth <= guarded) guarded = -1; } }
    }
  }
  expect(bad).toEqual([]);
});

test.skipIf(!chromeFound)("across every surface, one look per kind of action", () => {
  for (const [kind, looks] of Object.entries(lookOf)) expect({ kind, looks: Object.keys(looks).length, seen: looks }).toEqual({ kind, looks: 1, seen: looks });
});

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} the scope row reads whole, its chip the floor's colour and the way out`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "office")!);
    const row = await tab.ev(`(() => { const w = document.querySelector(".sall .swhat"), s = document.querySelector(".sall"), g = document.querySelector(".sall .sgo").getBoundingClientRect(), x = document.querySelector(".schip .sx").getBoundingClientRect(); return { cut: w.scrollWidth > w.clientWidth || s.scrollWidth > s.clientWidth, goInside: g.right <= s.getBoundingClientRect().right, out: x.width >= 44 && x.height >= 44, label: document.querySelector(".schip .sx").getAttribute("aria-label") }; })()`);
    expect(row).toEqual({ cut: false, goInside: true, out: true, label: expect.stringContaining("Payments") });
  }, 180_000);
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
  }, 180_000);
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
  }, 180_000);
}

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} every open room is one pick away from a room, and the picker goes there`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "room-chat")!);
    const picker = await tab.ev(`(() => { const b = document.querySelector(".rvjump").getBoundingClientRect(), s = document.querySelector(".rvjump select"), back = document.querySelector(".rvbar .back").getBoundingClientRect(); return { rooms: [...s.options].map((o) => o.value).sort(), chosen: s.value, target: b.width >= 44 && b.height >= 44, inside: b.right <= document.documentElement.clientWidth - 16, apart: back.right <= b.left, backWhole: document.querySelector(".rvbar .back").scrollWidth <= document.querySelector(".rvbar .back").clientWidth }; })()`);
    expect(picker).toEqual({ rooms: ["crm-short", "ops-drill-with-a-long-slug-for-the-tile", "pay-migration"], chosen: "pay-migration", target: true, inside: true, apart: true, backWhole: true });
    await tab.ev(`(() => { const s = document.querySelector(".rvjump select"); s.value = "crm-short"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await tab.until(`location.hash === "#room/crm-short" && document.querySelector(".rvjump select").value === "crm-short"`);
  }, 180_000);
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
  }, 180_000);
}

test.skipIf(!chromeFound)("on WORK a request's lane tag is a 44 px target that shows the whole name", async () => {
  await tab.size(PHONES[1]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "requests")!);
  const tag = await tab.ev(`(() => { const e = document.querySelector("#work .tag.lane"), r = e.getBoundingClientRect(); return { target: r.height >= 44 && r.width >= 44, whole: e.scrollWidth <= e.clientWidth, name: e.textContent.trim() }; })()`);
  expect(tag).toEqual({ target: true, whole: true, name: expect.stringContaining("migration") });
}, 180_000);

test.skipIf(!chromeFound)("a small table's box ends where the table does; a wide one scrolls in its", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "messages")!);
  const boxes = await tab.ev(`[...document.querySelectorAll("#msgs .mdtable")].map((b) => { const t = b.querySelector("table").getBoundingClientRect(), r = b.getBoundingClientRect(); return { small: b.scrollWidth <= b.clientWidth + 1, band: Math.round(r.right - t.right) }; })`);
  expect(boxes.some((b: any) => b.small)).toBe(true);
  expect(boxes.some((b: any) => !b.small)).toBe(true);
  for (const b of boxes.filter((x: any) => x.small)) expect(b.band).toBeLessThanOrEqual(1);
}, 180_000);

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
}, 180_000);

for (const phone of PHONES) {
  test.skipIf(!chromeFound)(`${phone.width}x${phone.height} the question comes first: one row above the tabs, the count once, an alarm on that row`, async () => {
    await tab.size(phone);
    await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
    await tab.ev(`document.fonts.ready.then(() => true)`);
    const top = (sel: string) => tab.ev(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY`);
    const shown = (sel: string) => tab.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getBoundingClientRect().height > 0; })()`);
    // No alarm: the card starts within 190 px, against 277 before.
    await tab.ev(`document.getElementById("machines").classList.remove("bad", "off"); document.querySelector(".top .strip").classList.remove("nomove")`);
    expect(await top("#hud .ask")).toBeLessThanOrEqual(190);
    expect(await shown(".top .title")).toBe(false);
    // The count once in what is on the first screen: on its tab, not in a box or on the pill as well.
    const counts = await tab.ev(`(() => { const n = document.querySelector("#qtCount").textContent.trim(); return [...document.querySelectorAll("#sWait .count, .fpill .slot.sa, #qtCount")].filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight / 2 && r.top >= 0; }).length; })()`);
    expect(counts).toBe(1);
    expect(await top(".top .strip")).toBeGreaterThan(await top(".main"));
    expect(await shown("#menuBtn")).toBe(true);
    // An alarm shows on the same row and does not push the question down.
    const before = await top("#hud .ask");
    await tab.ev(`document.getElementById("machines").classList.add("bad")`);
    expect(await top("#machines")).toBeLessThan(await top("#qtabs"));
    expect(await top("#hud .ask")).toBe(before);
    const row = await tab.ev(`(() => { const m = document.getElementById("machines").getBoundingClientRect(), p = document.querySelector(".floornav").getBoundingClientRect(), b = document.getElementById("menuBtn").getBoundingClientRect(), v = document.documentElement.clientWidth; return { oneRow: Math.abs(m.top - p.top) < 2 && Math.abs(p.top - b.top) < 2, apart: m.right <= p.left && p.right <= b.left, inside: b.right <= v - 16, pill: p.width >= 90 }; })()`);
    expect(row).toEqual({ oneRow: true, apart: true, inside: true, pill: true });
    await tab.ev(`document.getElementById("machines").classList.remove("bad"); document.querySelector(".top .strip").classList.add("nomove")`);
    expect(await top(".top .strip")).toBeLessThan(await top("#qtabs"));
    expect(await top("#hud .ask")).toBe(before);
  }, 180_000);
}

test.skipIf(!chromeFound)("a blink never fades a number: full opacity at every step, and the signal still there", async () => {
  await tab.size(PHONES[0]);
  await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
  const steps = await tab.ev(`(() => { const t = document.querySelector("#hud .timer"), out = []; for (const c of ["", "blink-1", "blink-2"]) { t.className = "timer " + c; const s = getComputedStyle(t); out.push({ opacity: s.opacity, color: s.color, ring: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 }); } t.className = "timer"; return out; })()`);
  expect(steps.map((x: any) => x.opacity)).toEqual(["1", "1", "1"]);
  expect(new Set(steps.map((x: any) => x.color)).size).toBe(1);
  expect(steps.map((x: any) => x.ring)).toEqual([false, true, true]);
}, 180_000);

test.skipIf(!chromeFound)("on a desktop, a long Linear project name stays inside the DONE MEANS rail", async () => {
  await tab.s("Emulation.setTouchEmulationEnabled", { enabled: false });
  for (const width of [1280, 1440, 1920]) {
    await tab.s("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await tab.load(office.base, "#room/pay-migration", {});
    await tab.until(`!!document.querySelector(".roomview .acc .accproj")`);
    const rail = await tab.ev(`(() => { const r = document.querySelector(".rvrail"), a = document.querySelector(".acc").getBoundingClientRect(), b = r.getBoundingClientRect(); return { sideways: r.scrollWidth > r.clientWidth + 1, inside: a.right <= b.right + 1, show: (() => { const s = document.querySelector(".accshow")?.getBoundingClientRect(); return !s || s.right <= b.right + 1; })() }; })()`);
    expect(rail).toEqual({ sideways: false, inside: true, show: true });
  }
}, 180_000);

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
}, 180_000);

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
  await tab.until(`document.getElementById("room").toDataURL() !== ${JSON.stringify(first)}`);
}, 180_000);

test.skipIf(!chromeFound)("asked for less motion: no animation runs, the count rests, nothing is hidden", async () => {
  await tab.size(PHONES[0]);
  await tab.s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await openSurface(tab, office, SURFACES.find((s) => s.name === "needs-you")!);
    await tab.rest();
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
}, 180_000);
