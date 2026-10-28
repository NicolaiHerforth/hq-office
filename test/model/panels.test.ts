// The panels that show a scoped NEW count redraw when only the per-lane unread counts change (one update read and
// another landing in the same push leaves the total as it was). questions/drafts.js imports the page's panels, so this
// reads its PANELS table as text rather than importing it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../../src/client/questions/drafts.js"), "utf8");
const keysOf = (render: string) => {
  const row = src.split("\n").find((l) => l.includes(`() => ${render}()`));
  return row ? [...row.matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
};

test("the tabs' N NEW, the FROM HQ count and the messages' +N line redraw on updatesUnreadByLane", () => {
  for (const render of ["renderQTabs", "renderLog", "renderMsgs"]) expect(keysOf(render)).toContain("updatesUnreadByLane");
});
