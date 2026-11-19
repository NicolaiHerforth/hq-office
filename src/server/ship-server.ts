// The one SHIP book (ship.ts) on the server's database, in /api/state as S.ship, and everything around it: when GitHub
// is read, when the sorter runs, the owner's merges and SEND BACK, and what the filer is told (docs/ship.md).
//
// Cheap when empty: no timer runs and gh is never called while SHIP has no open item. GitHub is read 2 s after a
// filing, when a page opens SHIP (at most every 30 s), right before a merge, and every HUD_SHIP_POLL_MS (5 minutes)
// while something is open. A held press (UNDO's hold) arms one timer for the earliest one due, only while one exists.
import { ALLOWS, createShip, HOLD_MS, keyOf, LATE, notNow, prLinks, type Hold, type Item, type Read } from "./ship.ts";
import { mergePr, MOVED, readPrs, refusalWords, type FullRead } from "./ship-gh.ts";
import { fallback, runSort, SORT_LIMITS } from "./ship-sort.ts";
import { domainOf, methodOf } from "../client/ship/model.js";
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import { bump, secrets, secretsGen } from "./push.ts";
import { addStatePart } from "./state.ts";
import { event } from "./events.ts";
import { tellLane } from "./ask-routing.ts";
import { laneCaller } from "./asks.ts";
import { laneFloor, type Caller } from "./floors.ts";
import { isPage } from "./pages.ts";

const SAMPLE_CMD = (process.env.HUD_SAMPLE_CMD ?? "").trim();
const ms = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);
const READ_DELAY_MS = 2000;
const LOOK_MS = 30_000;
const POLL_MS = ms(process.env.HUD_SHIP_POLL_MS, 5 * 60_000);
const SORT_MS = ms(process.env.HUD_SHIP_SORT_MS, 30_000);
const SORT_TIMEOUT_MS = ms(process.env.HUD_SHIP_SORT_TIMEOUT_MS, SORT_LIMITS.timeoutMs);
const HOLD_FOR_MS = ms(process.env.HUD_SHIP_HOLD_MS, HOLD_MS);
const LATE_MS = ms(process.env.HUD_SHIP_LATE_MS, 30_000);
const STARTED = Date.now();

const mask = (s: string) => secrets.mask(s);
export const ship = createShip({ db, mask, sampler: !!SAMPLE_CMD, holdMs: HOLD_FOR_MS });
// The rows, and the secrets a note is masked with.
addStatePart("ship", () => ship.view(), { tables: ["ship"], also: () => secretsGen });
// When GitHub was last read for the open items, built on every push: a read that finds nothing new pushes nothing, so
// the pages have it as of the last push.
let readAt: number | null = null;
addStatePart("shipRead", () => readAt);
// The server's clock while a press is held, so the page counts UNDO's time left from it, not from the device's clock.
// Built on every push, null while nothing is held: the page stream sends a part only when its JSON changes, so a
// push with no hold never carries it.
addStatePart("shipNow", () => (ship.nextHold() === null ? null : Date.now()));

// The body and changed paths of items not yet sorted, for the sorter only: never stored.
const details = new Map<number, { body: string; paths: string[] }>();
const given = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ---- telling the filer ----

// A lane that filed hears it in its pane (kept while away or busy); HQ's own PRs go to the floor's HQ.
function tell(it: Item, text: string) {
  tellLane(it.filer, laneFloor(it.filer) ?? it.floor, text, `ship:${it.id}`);
}
const mergedLine = (it: Item) => `merged ${keyOf(it)}${it.gh?.title ? ` (${it.gh.title})` : ""}`;
// The filer hears of each PR merged.
function merged(it: Item, byOwnerNow: boolean) {
  tell(it, `HUD SHIP: ${mergedLine(it)}`);
  event(byOwnerNow ? OWNER : "github", `${mergedLine(it)} from MERGE`, it.lane, it.floor);
}
// MESSAGES gets one line per press: the PR, or for a group how many and in which domain, with the PRs in its body.
// The owner pressed it himself: read already. A MERGE WHEN CHECKS PASS that GitHub finished later is news.
function noteMerged(items: Item[], byOwnerNow: boolean) {
  if (!items.length) return;
  const [first] = items;
  const shared = <T>(f: (it: Item) => T) => (items.every((it) => f(it) === f(first)) ? f(first) : null);
  const domain = shared((it) => domainOf(it) as string);
  const title = items.length === 1 ? `MERGE: ${mergedLine(first)}` : `MERGE: merged ${items.length} ${domain ? `in ${domain}` : "PRs"}`;
  const body = items.length === 1 ? first.url : items.map((it) => `- [${keyOf(it)}](${it.url})${it.gh?.title ? ` ${it.gh.title.replace(/[[\]]/g, "\\$&")}` : ""}`).join("\n");
  db.query("INSERT INTO updates (at, lane, title, body, floor, read_at) VALUES (?, ?, ?, ?, ?, ?)").run(Date.now(), shared((it) => it.lane), title, body, first.floor, byOwnerNow ? Date.now() : null);
}

// ---- reading GitHub ----

let readTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let reading: Promise<void> | null = null;
let readAgain = false;
let lastLook = 0;

// GitHub's answer on the items: facts on each, what was merged or closed there leaves.
function settle(reads: Map<string, FullRead>) {
  const facts = new Map<string, Read>();
  for (const it of ship.openItems()) {
    const r = reads.get(keyOf(it));
    if (!r) continue;
    if ("error" in r) {
      facts.set(keyOf(it), { error: mask(r.error) });
      continue;
    }
    const { body, paths, ...f } = r;
    if (paths) details.set(it.id, { body: body ?? "", paths });
    facts.set(keyOf(it), f);
  }
  readAt = Date.now();
  const { ended, changed } = ship.applyFacts(facts);
  for (const e of ended) {
    details.delete(e.item.id);
    if (e.how === "merged" && e.asked) {
      merged(e.item, false);
      noteMerged([e.item], false);
    }
    else event("hud", `${keyOf(e.item)} left SHIP: ${e.how} on GitHub`, e.item.lane, e.item.floor);
  }
  // Only a read that changed something reaches the pages: S.shipRead goes with the next push.
  if (changed) bump("SHIP read GitHub");
}

// Every open item in one query. One read at a time; a call during one runs another when it ends.
function readOpen(): Promise<void> {
  if (reading) {
    readAgain = true;
    return reading;
  }
  reading = (async () => {
    do {
      readAgain = false;
      const items = ship.openItems();
      if (!items.length) break;
      settle(await readPrs(items.map((it) => ({ repo: it.repo, number: it.number, full: !it.sorted && !details.has(it.id) }))));
    } while (readAgain);
  })().finally(() => {
    reading = null;
    poll();
  });
  return reading;
}
// Filings within the window share one read.
function readSoon() {
  readTimer ??= setTimeout(() => {
    readTimer = null;
    void readOpen();
  }, READ_DELAY_MS);
}
// The 5-minute read, armed only while something is open.
function poll() {
  if (!ship.hasOpen()) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    return;
  }
  pollTimer ??= setTimeout(() => {
    pollTimer = null;
    void readOpen();
  }, POLL_MS);
}

// POST /api/ship/look: a page opened SHIP.
export function look() {
  if (!ship.hasOpen() || Date.now() - lastLook < LOOK_MS) return { reading: false };
  lastLook = Date.now();
  void readOpen();
  return { reading: true };
}

// ---- the sorter ----

let sortTimer: ReturnType<typeof setTimeout> | null = null;
let sorting = false;
let sortAgain = false;

function sortSoon() {
  if (sortTimer) clearTimeout(sortTimer);
  sortTimer = setTimeout(() => {
    sortTimer = null;
    void sortNow();
  }, SORT_MS);
}
// Every open item not yet sorted, in one call, after GitHub has been read for them when a read is due.
async function sortNow() {
  if (sorting) {
    sortAgain = true;
    return;
  }
  sorting = true;
  try {
    if (readTimer) {
      clearTimeout(readTimer);
      readTimer = null;
      await readOpen();
    } else if (reading) await reading;
    const todo = ship.openItems().filter((it) => !it.sorted);
    if (!todo.length) return;
    const inputs = todo.map((it) => ({ id: it.id, repo: it.repo, number: it.number, title: it.gh?.title ?? "", branch: it.gh?.branch ?? "", body: details.get(it.id)?.body ?? "", paths: details.get(it.id)?.paths ?? [] }));
    const { answers, error } = await runSort(inputs, { cmd: SAMPLE_CMD, domains: ship.domainsInUse(), mask, timeoutMs: SORT_TIMEOUT_MS });
    if (error) event("hud", `SHIP's sorter: ${mask(error)}; ${todo.length} sorted by repo`);
    if (ship.applySort(answers)) bump("SHIP sorted");
    for (const it of todo) details.delete(it.id);
  } finally {
    sorting = false;
    if (sortAgain) {
      sortAgain = false;
      sortSoon();
    }
  }
}

// ---- filing ----

// hud ship, and an ask turned into SHIP items. A lane's PR is its lane's; HQ names one with --lane. On the lane's
// floor, else the caller's.
export function fileShip(o: { url: unknown; lane?: unknown; note?: unknown; urgent?: unknown }, caller: Caller) {
  const filer = laneCaller(caller.agent);
  const lane = given(o.lane) ?? filer;
  const { item, updated } = ship.file({ url: o.url, floor: laneFloor(lane) ?? caller.floor, lane, filer, note: o.note, urgent: o.urgent });
  event(filer ?? "hq", `${updated ? "updated" : "filed"} ${keyOf(item)} in SHIP`, item.lane, item.floor);
  // Without a model the fallback is all there is: no reason to wait for it.
  if (!item.sorted) {
    if (SAMPLE_CMD) sortSoon();
    else ship.applySort([fallback(item)]);
  }
  readSoon();
  return { id: item.id, repo: item.repo, number: item.number, floor: item.floor, updated };
}

// The old way: an ask (hud ask, the ledger's) whose title asks for a merge, that links GitHub PRs and carries nothing
// else for the owner to answer, files each linked PR in SHIP instead, with the ask's title and body as the note, and
// makes no ask. An ask with options, items, a page or secrets is a decision: it stays an ask. null: it is an ask.
const MERGE = /\bmerg/i;
const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "");
export function shipFromAsk(body: any, caller: Caller) {
  const title = typeof body?.title === "string" ? body.title : "";
  const text = typeof body?.body === "string" ? body.body : "";
  if (!MERGE.test(title) || isPage(text) || ["options", "items", "file", "secrets"].some((k) => filled(body?.[k]))) return null;
  const prs = prLinks(`${title}\n${text}`);
  if (!prs.length) return null;
  const note = [title.trim(), text.trim()].filter(Boolean).join("\n\n");
  const ship = prs.map((p) => fileShip({ url: p.url, lane: body.lane, note }, caller));
  const n = ship.length;
  return { ship, said: `a PR to merge goes to the MERGE tab, not NEEDS YOU: ${n === 1 ? "it is" : `all ${n} are`} filed in MERGE and no ask was made. Next time: hud ship PR_URL [--lane L] [--note TEXT] [--urgent WHY]` };
}

// ---- the owner's ----

// Only from the HUD's page: a browser's POST carries an Origin (http.ts lets only the HUD's own through), says
// same-origin when it says anything, and comes from no herdr pane. It stops hud, not a process that forges headers.
export function ownerOnly(req: Request, what: string) {
  const site = req.headers.get("sec-fetch-site");
  if (!req.headers.has("origin") || req.headers.has("x-hud-pane") || (site !== null && site !== "same-origin")) throw new Error(`only the owner ${what}, from the HUD's page`);
}

// What stops a merge the owner asked for, on facts read a moment ago; null when nothing does.
function refusal(it: Item, sha: string, allows: string[], read: FullRead | undefined) {
  if (!read || "error" in read) return `GitHub could not be read just now${read && "error" in read ? `: ${mask(read.error)}` : ""}`;
  if (!sha) return "the page sent no head commit: look again";
  if (it.gh?.sha !== sha) return MOVED;
  return notNow(it, allows);
}

type Ask = { id: number; sha: string; auto: boolean };
type Result = { id: number; ok: boolean; error?: string; merged?: true; queued?: true };
// The PRs a merge is running on, from its read to gh's answer: SEND BACK, a hold or another merge on one waits.
const merging = new Set<number>();
const BEING_MERGED = "it is being merged now: wait for it to finish";
const HELD = "it is held: UNDO it, or let it run";
// The PRs are read again in one query, then merged one at a time, each only if what was read allows its press. One
// that fails does not stop the rest. What was merged is returned for MESSAGES' one line.
async function merge(asks: Ask[], allows: (a: Ask) => string[]) {
  const open = asks.map((a) => ship.openItem(a.id)).filter((it): it is Item => !!it);
  for (const it of open) merging.add(it.id);
  try {
    const fresh = await readPrs(open.map((it) => ({ repo: it.repo, number: it.number })));
    if (open.length) settle(fresh);
    const results: Result[] = [];
    const done: Item[] = [];
    for (const a of asks) {
      try {
        results.push(await mergeOne(a, allows(a), fresh, done));
      } catch (e) {
        event("hud", `a merge of ${a.id} in MERGE failed: ${mask((e as Error).message)}`);
        results.push({ id: a.id, ok: false, error: `Not merged: ${mask((e as Error).message)}` });
      }
    }
    return { results, done };
  } finally {
    for (const it of open) merging.delete(it.id);
    poll();
  }
}
async function mergeOne(a: Ask, allows: string[], fresh: Map<string, FullRead>, done: Item[]): Promise<Result> {
  const it = ship.openItem(a.id);
  if (!it) return { id: a.id, ok: false, error: "no longer in MERGE: merged, closed or sent back" };
  const no = refusal(it, a.sha, allows, fresh.get(keyOf(it)));
  if (no) {
    if (no === MOVED) ship.setMergeError(it.id, no);
    event(OWNER, `did not merge ${keyOf(it)}: ${no}`, it.lane, it.floor);
    return { id: it.id, ok: false, error: no };
  }
  const r = await mergePr({ repo: it.repo, number: it.number, method: methodOf(it)!, sha: a.sha, auto: a.auto });
  if (!r.ok) {
    const error = refusalWords(mask(r.error));
    ship.setMergeError(it.id, error);
    event(OWNER, `could not merge ${keyOf(it)}: ${mask(r.error)}`, it.lane, it.floor);
    return { id: it.id, ok: false, error };
  }
  if (a.auto) {
    ship.autoAsked(it.id);
    event(OWNER, `turned on MERGE WHEN CHECKS PASS for ${keyOf(it)}`, it.lane, it.floor);
    return { id: it.id, ok: true, queued: true };
  }
  const m = ship.markMerged(it.id);
  if (m) {
    merged(m, true);
    done.push(m);
  }
  return { id: it.id, ok: true, merged: true };
}

// POST /api/ship/merge, at once. kind "group": a group's MERGE N, of any size (ready PRs only: one no checks ran on
// merges only by its own button). kind "one": one PR's own button, an unchecked PR after the page asked. A kind left
// out or not known is a group, the stricter. A PR that is held waits for its hold.
export async function mergeItems(list: unknown, kind: unknown) {
  if (!Array.isArray(list) || !list.length) throw new Error("say what to merge: items [{ id, sha, auto }]");
  const one = kind === "one";
  if (one && list.length > 1) throw new Error(`one press merges one PR: this asked for ${list.length}`);
  const asked: Ask[] = list.map((x: any) => ({ id: Number(x?.id), sha: String(x?.sha ?? "").trim(), auto: x?.auto === true }));
  const waits = new Map<number, string>();
  for (const a of asked) {
    if (merging.has(a.id)) waits.set(a.id, BEING_MERGED);
    else if (ship.openItem(a.id)?.hold) waits.set(a.id, HELD);
  }
  const allows = (a: Ask) => (a.auto ? ALLOWS.auto : one ? ALLOWS.one : ALLOWS.group);
  const { results, done } = await merge(asked.filter((a) => !waits.has(a.id)), allows);
  noteMerged(done, true);
  const byId = new Map(results.map((r) => [r.id, r]));
  return { results: asked.map((a) => (waits.has(a.id) ? { id: a.id, ok: false, error: waits.get(a.id)! } : byId.get(a.id)!)) };
}

// SEND BACK: the note goes to whoever filed it, and the item leaves SHIP until it is filed again.
function back(id: unknown, note: unknown) {
  const it = ship.sendBack(id, note);
  const words = mask(String(note).trim());
  tell(it, `HUD SHIP: sent back ${keyOf(it)}: ${words}`);
  event(OWNER, `sent back ${keyOf(it)}: ${words}`, it.lane, it.floor);
  details.delete(it.id);
  poll();
}
// POST /api/ship/ID/back, at once.
export function sendBack(id: unknown, note: unknown) {
  if (merging.has(Number(id))) throw new Error(BEING_MERGED);
  if (ship.openItem(Number(id))?.hold) throw new Error(HELD);
  back(id, note);
}

// ---- UNDO's hold ----

// One timer, for the earliest hold due, armed only while a hold exists; none while a run is on (it re-arms at its end).
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdRun: Promise<void> | null = null;
function armHolds() {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  if (holdRun) return;
  const next = ship.nextHold();
  if (next === null) return;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    holdRun = runHolds().finally(() => {
      holdRun = null;
      armHolds();
    });
  }, Math.max(0, next - Date.now()));
}
// Each hold whose time has come runs once, as the same merge or SEND BACK as a press at once. It leaves the row in
// every outcome; a run cut off by a restart runs again, and GitHub's read then finds a merge that went through.
async function runHolds() {
  for (let due = ship.dueHolds(); due.length; due = ship.dueHolds()) {
    for (const h of due) {
      try {
        await runHold(h);
      } catch (e) {
        event("hud", `a held press on ${h.id} in MERGE failed: ${mask((e as Error).message)}`);
      } finally {
        ship.clearHold(h.id);
      }
    }
    bump("MERGE ran a held press");
  }
}
async function runHold(h: Hold & { id: number }) {
  if (h.until < STARTED - LATE_MS) return dropLate(h);
  if (h.verb === "back") return back(h.id, h.note);
  const { done } = await merge([{ id: h.id, sha: h.sha, auto: h.verb === "auto" }], () => (h.verb === "auto" ? ALLOWS.auto : ALLOWS.group));
  noteMerged(done, true);
}

// A hold due more than LATE_MS before this server started waited out a HUD that was down: the press is not made, and
// the PR says so. GitHub is read for it first, so a merge gh made before the server died still counts as the owner's.
async function dropLate(h: Hold & { id: number }) {
  const was = ship.openItem(h.id);
  if (was && h.verb !== "back") settle(await readPrs([{ repo: was.repo, number: was.number }]));
  const it = ship.openItem(h.id);
  if (!it) return;
  ship.setMergeError(it.id, LATE[h.verb]);
  event("hud", `${keyOf(it)}: ${LATE[h.verb]}`, it.lane, it.floor);
}

// POST /api/ship/ID/hold and /undo: one press held for HUD_SHIP_HOLD_MS, and taken back inside it. Each answer says
// the server's now, which the page counts UNDO's time left from.
export function holdPress(id: unknown, body: any) {
  if (merging.has(Number(id))) throw new Error(BEING_MERGED);
  const r = ship.hold(id, { verb: body?.verb, sha: body?.sha, note: body?.note });
  armHolds();
  return { ...r, now: Date.now() };
}
export function undoPress(id: unknown) {
  const r = ship.undo(id);
  armHolds();
  return { ...r, now: Date.now() };
}

// At start: what was open before the restart is read again soon, sorted if it was not, and the poll runs. A hold
// pressed before the restart runs when it is due, at once if that has passed, unless it is more than LATE_MS (30 s)
// overdue: then it is dropped (dropLate).
armHolds();
if (ship.hasOpen()) {
  readSoon();
  if (ship.openItems().some((it) => !it.sorted)) {
    if (SAMPLE_CMD) sortSoon();
    else ship.applySort(ship.openItems().filter((it) => !it.sorted).map(fallback));
  }
}
