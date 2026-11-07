// A walk through the whole page on a phone with real taps, every way in and out, and at each step nothing spilling,
// no scroller hiding a control. It stops at the first failure. On a throwaway server; run it through the suite lock.
//   bun scripts/mobile-walk-check.ts
import { resolve } from "node:path";
import { startChrome } from "./room-hash.ts";
import { MEASURE, PHONES, SURFACES, WIDEST_COUNTS, openPhone, openSurface, startOffice } from "../test/mobile-walk.ts";

const chrome = await startChrome(), o = await startOffice(resolve(import.meta.dir, "..")), errors: string[] = [];
const t = await openPhone(chrome, errors);
let steps = 0;
const end = async (code: number) => { await t.s("Page.navigate", { url: "about:blank" }); await o.stop(); await chrome.close(); process.exit(code); };
const step = async (name: string, ok: string | null = null) => {
  await t.rest();
  const m = await t.ev(MEASURE);
  const good = !m.moved && m.scrollW <= m.vw && !m.spills.length && !m.scrollers.length && !m.clipped.length && (ok ? await t.ev(ok).catch(() => false) : true);
  steps++;
  if (good) return;
  console.log("FAIL", name, JSON.stringify({ moved: m.moved, scrollW: m.scrollW, spills: m.spills.slice(0, 3), scrollers: m.scrollers, clipped: m.clipped.slice(0, 3), ok }));
  await end(1);
};
const esc = async () => { for (const type of ["keyDown", "keyUp"]) await t.s("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); };
const shown = (s: string) => `(() => { const e = document.querySelector(${JSON.stringify(s)}); return !!e && e.getBoundingClientRect().height > 0; })()`;
const gone = (s: string) => `!${shown(s)}`;
const sheetIs = (s: string) => `!!document.querySelector(${JSON.stringify(`${s}.sheet`)})`;
const noSheet = `!document.querySelector(".sheet") && !history.state?.hqSheet`;
const outside = () => t.tapAt(195, 3);
const pick = (slug: string) => t.ev(`(() => { const s = document.querySelector(".rvjump select"); s.value = ${JSON.stringify(slug)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);

for (const phone of PHONES) {
  console.log("phone", phone.width);
  await t.size(phone);
  await t.load(o.base, "", {});
  await step("home");
  await t.ev(WIDEST_COUNTS);
  await step("five tabs whole with the widest counts", `(() => { const q = document.getElementById("qtabs"); return q.scrollWidth <= q.clientWidth && [...q.querySelectorAll("[data-qtab]")].every((b) => b.getBoundingClientRect().right <= innerWidth && b.getBoundingClientRect().height >= 44); })()`);
  await step("question in the top half", `document.querySelector("#hud .ask h3").getBoundingClientRect().top + scrollY < innerHeight / 2`);
  await step("no title row, readings below the desk", `${gone(".top .title")} && document.querySelector(".top .strip").getBoundingClientRect().top > document.querySelector(".main").getBoundingClientRect().top`);
  // MENU and what opens from it
  await t.tap("#menuBtn"); await step("MENU", sheetIs("#menuDrop"));
  await outside(); await step("MENU closes on a tap outside", noSheet);
  await t.tap("#menuBtn"); await esc(); await step("MENU closes on Esc", noSheet);
  await t.tap("#menuBtn"); await t.tap("#secretsBtn"); await step("SECRETS", sheetIs(".spanel"));
  await t.tap("[data-secret-rm]"); await step("DELETE asks", sheetIs(".confirm"));
  await t.tap(".confirmno"); await step("KEEP IT keeps it, SECRETS stays", `${sheetIs(".spanel")} && !!document.querySelector("[data-secret-rm]")`);
  await t.tap(".spx"); await step("SECRETS closes on its mark", noSheet);
  await t.tap("#menuBtn"); await t.tap("#settingsBtn"); await step("SETTINGS", sheetIs("#settings"));
  await t.tap("#settings [data-close]"); await step("SETTINGS closes", noSheet);
  await t.tap("#menuBtn"); await t.tap("#menuTell"); await step("TELL HQ from MENU, the list has not moved", `${sheetIs(".tell")} && scrollY === 0`);
  await outside(); await step("TELL HQ closes", noSheet);
  await t.tap("#menuBtn"); await t.tap("#menuSubs"); await step("SUBS from MENU", sheetIs("#subsDrop"));
  await t.ev(`history.back()`); await t.until(noSheet); await step("Back closes SUBS, still in the app", `!!document.getElementById("hud")`);
  await t.tap("#menuBtn"); await t.tap("#menuOffice"); await t.until(shown(".jumpback")); await step("the office from MENU");
  await t.tap(".jumpback"); await t.until(`scrollY === 0`); await step("back to the list", gone(".jumpback"));
  // the question card's ledger and tabs
  await t.tap("#hud [data-ledger-more]"); await step("ledger MORE", `document.querySelectorAll(".ledger .lc").length === 7`);
  await t.tap("#hud [data-ledger-more]"); await step("ledger LESS", `document.querySelectorAll(".ledger .lc").length === 5`);
  for (const tab of ["messages", "work", "rooms", "briefs", "questions"]) { await t.tap(`[data-qtab="${tab}"]`); await step(`tab ${tab}`); }
  // floors
  await t.tap('.tgo[data-floor-go="pay"]'); await step("a floor's row opens", shown(".ftile.pic .tenterb"));
  await t.tap("[data-pill]"); await step("floor list", sheetIs(".fmenu"));
  await t.tap(".fmenu [data-floor-add]"); await step("add a floor", sheetIs(".fpanel"));
  await t.tap(".fpanel .fpx"); await step("the panel closes on its mark", noSheet);
  await t.tap("[data-pill]"); await t.tap(".fpx[data-list-close]"); await step("floor list closes on its mark", noSheet);
  await t.tap('.tenterb[data-floor-go="pay"]'); await t.until(`!!document.querySelector(".schip")`); await step("into the floor, the way out says so", `document.querySelector(".sx").innerText.includes("LEAVE")`);
  await t.tap(".sall"); await step("SHOW ALL");
  await t.tap(".sall"); await step("THIS FLOOR ONLY");
  await t.tap("#hud .ask .tag.lane"); await t.until(sheetIs("#card")); await step("a lane from its question");
  await t.ev(`document.getElementById("card").scrollTop = 1e6`); await t.tap(".cardx"); await step("the drawer closes from its end", noSheet);
  await t.tap("#hud .ask .tag.lane"); await t.until(sheetIs("#card")); await t.ev(`history.back()`); await t.until(noSheet); await step("Back closes the drawer, still in the app", `!!document.getElementById("hud")`);
  await t.tap(".sx"); await t.until(gone(".scoperow")); await step("LEAVE the floor");
  // rooms
  await t.tap('[data-qtab="rooms"]'); await t.tap(".rnew"); await step("new room", sheetIs(".nrpanel"));
  await t.tap(".nrpanel .spx"); await step("new room closes", noSheet);
  await t.tap('#rooms article[data-room="pay-migration"] .rlane'); await t.until(shown(".roomview .rvchat")); await step("a tile's middle opens the room", gone(".card:not([hidden])"));
  await step("every room in the picker", `document.querySelector(".rvjump select").options.length === 3`);
  await pick("crm-short"); await t.until(`location.hash === "#room/crm-short"`); await step("picker to a room");
  await pick("pay-migration"); await t.until(`location.hash === "#room/pay-migration"`); await step("picker back");
  await t.tap(".rsend textarea"); await t.until(`document.activeElement === document.querySelector(".rsend textarea")`); await step("the composer folds the strip", gone(".rvpix"));
  await t.ev(`document.activeElement.blur()`); await step("the strip comes back", shown(".rvpix"));
  await t.tap('[data-ptab="brief"]'); await step("room BRIEF", shown(".roomview .rbrief"));
  await t.tap('[data-ptab="shelf"]'); await step("room SHELF", shown(".roomview .rshelf"));
  await t.tap(".rshelf .addbtn"); await step("shelf ADD", shown(".radd input[type=url]"));
  await t.tap('[data-ptab="chat"]'); await t.tap("[data-room-close]"); await step("CLOSE ROOM asks", sheetIs(".confirm"));
  await outside(); await step("a tap outside keeps it open", `${noSheet} && !!document.querySelector("[data-room-close]")`);
  await t.tap("[data-room-back]"); await t.until(gone(".roomview .rvchat")); await step("BACK TO OFFICE");
  // a brief, its comments, a page
  await t.tap('[data-qtab="briefs"]'); await t.ev(`location.hash = "#brief/${o.ids.brief}"`); await t.until(shown(".briefview .bbody")); await step("a brief");
  await t.tap(".bvbar [data-comments-toggle]"); await t.until(sheetIs(".cmount")); await step("one COMMENTS opens the sheet", gone(".cjump"));
  await t.tap(".cclose"); await step("the sheet closes", noSheet);
  await esc(); await t.until(gone(".briefview:not([hidden])")); await step("Esc leaves the brief");
  await t.load(o.base, `#page/rooms/pay-migration/files/${o.ids.shelf}`, {}); await t.until(shown(".pageview iframe")); await step("a page");
  await t.tap(".pageview [data-comments-toggle]"); await t.until(sheetIs(".cmount")); await step("its comment sheet");
  await outside(); await step("closes on a tap outside", noSheet);
  await t.ev(`location.hash = "#room/pay-migration"`); await t.until(shown(".roomview .rvchat")); await step("to a room");
  await t.ev(`history.back()`); await t.until(shown(".pageview iframe")); await step("browser back to the page");
  await t.load(o.base, "", {}); await t.tap('[data-qtab="messages"]'); await step("MESSAGES", shown("#msgs [data-msg]"));
  await t.tap("#msgs [data-reply]"); await step("a reply box", shown("#msgs [data-rbox] textarea"));
  await t.ev(`location.reload()`); await t.until(`document.readyState === "complete" && !!document.querySelector("#menuDrop .seg.on[data-set-theme]")`); await step("reload");
}
for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 844, height: 390 }, { width: 932, height: 430 }]) {
  console.log("size", size.width);
  await t.size(size);
  for (const s of SURFACES.filter((x) => ["needs-you", "building", "office", "lanes-board", "room-chat", "room-brief", "brief-comment-sheet", "page", "secrets", "settings", "menu", "subs", "floor-add", "close-room-confirm"].includes(x.name))) {
    await openSurface(t, o, s);
    await step(`${size.width}x${size.height} ${s.name}`);
  }
}
const real = errors.filter((e) => !/fonts|ERR_BLOCKED/.test(e));
console.log(`${steps} steps, 0 failures; console errors: ${real.length}`, real.slice(0, 4));
await end(real.length ? 1 : 0);
