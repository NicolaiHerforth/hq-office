// The stage's address (src/client/core/stage.js): what each address opens, and the address of each pair. The module
// listens on the page at import, so the test gives it a page with nothing in it.
import { expect, test } from "bun:test";

const page = { location: { hash: "" }, document: { addEventListener() {} }, addEventListener() {} };
const kept = Object.fromEntries(Object.keys(page).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
Object.assign(globalThis, page);
const { parseStage, stageHash } = await import("../../src/client/core/stage.js");
for (const [k, d] of Object.entries(kept)) d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k];

test("an address names a room, a side, or a room and its side", () => {
  expect(parseStage("")).toEqual({ room: null, side: null });
  expect(parseStage("#room/pricing")).toEqual({ room: "pricing", side: null });
  expect(parseStage("#brief/12")).toEqual({ room: null, side: "brief/12" });
  expect(parseStage("#page/asks/4")).toEqual({ room: null, side: "page/asks/4" });
  expect(parseStage("#room/pricing+brief/12")).toEqual({ room: "pricing", side: "brief/12" });
  expect(parseStage("#room/pricing+page/rooms/pricing/files/plan.html?v=3")).toEqual({ room: "pricing", side: "page/rooms/pricing/files/plan.html?v=3" });
});

test("a page's name may hold a +; the room's slug never does", () => {
  expect(parseStage("#page/rooms/x/files/a+b.html")).toEqual({ room: null, side: "page/rooms/x/files/a+b.html" });
  expect(parseStage("#room/x+page/rooms/x/files/a+b.html")).toEqual({ room: "x", side: "page/rooms/x/files/a+b.html" });
});

test("what is not a side opens nothing beside the room", () => {
  expect(parseStage("#room/x+lane/api")).toEqual({ room: "x", side: null });
  expect(parseStage("#room/x+brief/")).toEqual({ room: "x", side: null });
  expect(parseStage("#page/rooms/x/files/chart.png")).toEqual({ room: null, side: null });
  expect(parseStage("#page/briefs/3?v=2")).toEqual({ room: null, side: null });
  expect(parseStage("#lane/api")).toEqual({ room: null, side: null });
  expect(parseStage("#room/Pricing")).toEqual({ room: null, side: null });
  expect(parseStage("#brief/12+room/x")).toEqual({ room: null, side: null });
});

test("every pair has one address, and it reads back as the same pair", () => {
  const pairs = [
    { room: null, side: null },
    { room: "pricing", side: null },
    { room: null, side: "brief/12" },
    { room: "pricing", side: "brief/12" },
    { room: "x", side: "page/rooms/x/files/a+b.html" },
  ];
  expect(pairs.map(stageHash)).toEqual(["", "#room/pricing", "#brief/12", "#room/pricing+brief/12", "#room/x+page/rooms/x/files/a+b.html"]);
  for (const p of pairs) expect(parseStage(stageHash(p))).toEqual(p);
});
