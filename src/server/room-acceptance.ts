// The one DONE MEANS cache (acceptance.ts) on the server's database: in /api/state as S.acceptance, its poll kept in
// step with the rooms (a room archived, reopened or unlinked is a write, and every write bumps).
import { createAcceptance } from "./acceptance.ts";
import { db } from "./db.ts";
import { bump, watchers } from "./push.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";

export const acceptance = createAcceptance({ db, onChange: bump, event: (who, text, floor) => event(who, text, null, floor) });
addStatePart("acceptance", () => acceptance.state());

let queued = false;
// On every look (a write, or a POST that may have changed what time decides, such as hud sync): watchers, not
// listeners, which hear writes only (push.ts).
watchers.add(() => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    acceptance.syncTimer();
  });
});

acceptance.start();
