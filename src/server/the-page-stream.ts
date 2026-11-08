// Moved here from server.ts.
import { listeners } from "./push.ts";
import { state } from "./state.ts";

// Every open page holds the whole state. Its stream starts with the whole state, then each message holds only the
// parts (top-level keys of state()) that changed since that page's last message. The state is built once per push
// for all pages, and a burst of writes (HQ posting a lane, a note and an event together) becomes one push.
// HQ's /api/wait long-poll is not delayed: only the page stream coalesces.
export type Page = { sent: Map<string, number>; send: (text: string) => void };
export const pages = new Set<Page>();
const parts = new Map<string, { json: string; gen: number }>();
let partGen = 0;
export const PING_MS = 120_000; // the minute's machine sample pushes anyway; this only keeps a quiet stream open
// What the page shows of the state. It leaves out what no page reads and what changes without anything on the page
// changing: the event log (HQ reads it through /api/state), the herdr sync stamps, the server clock, when herdr
// last saw each lane (it is stamped every sync), and the ages the board and the machines count from the clock (the page
// counts them from their times). /api/state still has all of it.
function pageView() {
  const { events, untracked, sync, now, ...rest } = state();
  const { now: _, ...board } = rest.board;
  return {
    ...rest,
    lanes: rest.lanes.map(({ herdr_seen, ...lane }) => lane),
    machines: rest.machines.map(({ age, ...m }) => m),
    board: { ...board, items: board.items.map((i) => (i.last ? { ...i, last: { at: i.last.at, what: i.last.what } } : i)) },
  };
}
export function refreshParts() {
  for (const [key, value] of Object.entries(pageView())) {
    const json = JSON.stringify(value);
    if (parts.get(key)?.json !== json) parts.set(key, { json, gen: ++partGen });
  }
}
export function pushTo(page: Page) {
  const out: string[] = [];
  for (const [key, part] of parts) {
    if (page.sent.get(key) === part.gen) continue;
    out.push(`${JSON.stringify(key)}:${part.json}`);
    page.sent.set(key, part.gen);
  }
  if (out.length) page.send(`data: {${out.join(",")}}\n\n`);
}
let pushTimer: ReturnType<typeof setTimeout> | null = null;
listeners.add(() => {
  if (!pages.size) return;
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    if (!pages.size) return;
    refreshParts();
    for (const page of pages) pushTo(page);
  }, 250);
});
