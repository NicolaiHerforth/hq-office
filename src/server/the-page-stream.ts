// The page stream: what open pages are sent, and when.
import { watchers } from "./push.ts";
import { stateParts } from "./state.ts";

// Every open page holds the whole state. Its stream starts with the whole state, then each message holds only the
// parts (top-level keys of the state) that changed since that page's last message. A part is built only when what
// it reads changed (state.ts), each part is made into JSON once for all pages, and a burst of writes (HQ posting a
// lane, a note and an event together) becomes one look. A look that finds no part changed sends nothing: the
// state's version alone is not news. HQ's /api/wait long-poll is not delayed: only the page stream coalesces.
export type Page = { sent: Map<string, number>; send: (text: string) => void };
export const pages = new Set<Page>();
const parts = new Map<string, { value: unknown; json: string; gen: number }>();
let partGen = 0;
export const PING_MS = 120_000; // the minute's machine sample pushes anyway; this only keeps a quiet stream open
// What the page shows of the state. It leaves out what no page reads and what changes without anything on the page
// changing: the event log (HQ reads it through /api/state), the herdr sync stamps, the server clock, when herdr
// last saw each lane (it is stamped every sync), and the ages the machines count from the clock (the page counts
// them from their times). Left out here, such a part is not even built. /api/state still has all of it.
const UNSEEN = new Set(["events", "untracked", "sync", "now"]);
const SHOWN: Record<string, (value: any) => unknown> = {
  lanes: (lanes) => lanes.map(({ herdr_seen, ...lane }: any) => lane),
  machines: (machines) => machines.map(({ age, ...m }: any) => m),
  // The work board is no longer on the page; rooms show the state of the issues and PRs they link, and that is
  // all of it the page gets. `hud board` and /api/board have the whole of it.
  board: (board) => ({ items: board.items.map((i: any) => ({ issue: i.issue, state: i.state, why: i.why, prs: i.prs.map((p: any) => ({ key: p.key, state: p.state, draft: p.draft, ci: p.ci })) })) }),
};
// How often the stream looked, and what came of it (GET /api/push).
export const looks = { looks: 0, quiet: 0, pushes: 0, bytes: 0, parts: new Map<string, number>() };
export function refreshParts() {
  looks.looks++;
  for (const [key, value] of stateParts((key) => !UNSEEN.has(key))) {
    const was = parts.get(key);
    // A part that was not built again is the same object: nothing to compare.
    if (was && was.value === value) continue;
    const json = JSON.stringify(SHOWN[key] ? SHOWN[key](value) : value);
    if (was?.json === json) was.value = value;
    else parts.set(key, { value, json, gen: ++partGen });
  }
}
export function pushTo(page: Page) {
  const out: string[] = [];
  for (const [key, part] of parts) {
    if (key === "version" || page.sent.get(key) === part.gen) continue;
    out.push(`${JSON.stringify(key)}:${part.json}`);
    page.sent.set(key, part.gen);
    looks.parts.set(key, (looks.parts.get(key) ?? 0) + 1);
  }
  if (!out.length) return false;
  // The version goes with what changed, never by itself.
  const text = `data: {"version":${parts.get("version")!.json},${out.join(",")}}\n\n`;
  looks.pushes++;
  looks.bytes += text.length;
  page.send(text);
  return true;
}
let pushTimer: ReturnType<typeof setTimeout> | null = null;
watchers.add(() => {
  if (!pages.size) return;
  pushTimer ??= setTimeout(() => {
    pushTimer = null;
    if (!pages.size) return;
    refreshParts();
    let sent = false;
    for (const page of pages) sent = pushTo(page) || sent;
    if (!sent) looks.quiet++;
  }, 250);
});
