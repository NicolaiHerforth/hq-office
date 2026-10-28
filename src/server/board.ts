// WORK BOARD: one tracked item per piece of work in flight (an issue key, its PRs, the lane that owns it).
// An item's state is derived from facts on every read, never typed in: GitHub (PR state, draft, checks),
// the lane's herdr status, open asks that name it, and what last happened. Only HQ's own decisions are
// stored: done, and paused with a reason.
//
// GitHub is the only thing this polls. Results are cached here; the cache is refreshed every GH_REFRESH_MS
// while there are open items or followed PRs (the timer stops when there are none), and on demand by `hud board` when the
// cache is older than GH_CACHE_MS. A page load never fetches.
import type { Database } from "bun:sqlite";

export const STALL_MS = 45 * 60_000;
export const GH_REFRESH_MS = 10 * 60_000;
export const GH_CACHE_MS = 60_000;
const DONE_SHOWN_MS = 24 * 3600_000;
const GH_TIMEOUT_MS = 20_000;
const GH_FIELDS = "state,isDraft,statusCheckRollup,mergedAt,closedAt,updatedAt";

export type BoardState = "done" | "blocked" | "owner" | "ci" | "paused" | "moving" | "stalled";
// Most urgent first: the order of the board, top to bottom.
// BLOCKED ON A PROMPT tops it: the lane's agent waits at a prompt in its pane, and nothing moves until it is answered.
export const STATE_ORDER: BoardState[] = ["blocked", "stalled", "owner", "ci", "moving", "paused", "done"];
export const STATE_LABEL: Record<BoardState, string> = {
  blocked: "BLOCKED ON A PROMPT",
  stalled: "STALLED",
  owner: "WAITING ON OWNER",
  ci: "WAITING ON CI",
  moving: "MOVING",
  paused: "PAUSED",
  done: "DONE",
};

// What `gh pr view --json` returns, or what a fake returns in tests.
export type GhRunner = (ref: PrRef) => Promise<any>;
export type PrRef = { key: string; number: number; repo: string | null };

type PrFact = {
  key: string;
  number: number;
  fetchedAt: number;
  error?: string;
  state?: string; // OPEN | MERGED | CLOSED
  draft?: boolean;
  ci?: "running" | "failed" | "passed" | "none";
  ciAt?: number | null;
  updatedAt?: number | null;
  endedAt?: number | null; // merged or closed
};

// stuck: it happened, but it is not progress (a lane that went away).
type Happened = { at: number; what: string; stuck?: boolean };

const ts = (s: unknown) => (typeof s === "string" && s ? Date.parse(s) || null : null);

// "123", "#123", "owner/repo#123" or a pull request URL.
export function parsePr(raw: string, defaultRepo: string): PrRef | null {
  const s = String(raw).trim();
  let m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (m) return { key: `${m[1]}#${m[2]}`, number: Number(m[2]), repo: m[1] };
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (m) return { key: `${m[1]}#${m[2]}`, number: Number(m[2]), repo: m[1] };
  m = s.match(/^#?(\d+)$/);
  if (m) return { key: m[1], number: Number(m[1]), repo: defaultRepo || null };
  return null;
}

function splitList(v: unknown): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(/[\s,]+/)).filter(Boolean);
}

// The real gh. HUD_GH_BIN points it elsewhere (a fake in tests).
export function ghCli(bin = process.env.HUD_GH_BIN ?? "gh"): GhRunner {
  return async (ref) => {
    const args = [bin, "pr", "view", String(ref.number), "--json", GH_FIELDS, ...(ref.repo ? ["--repo", ref.repo] : [])];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(err.trim().split("\n")[0] || `gh exit ${code}`);
    return JSON.parse(out);
  };
}

// A check is running while a CheckRun is not COMPLETED or a StatusContext is PENDING or EXPECTED.
function readChecks(rollup: any[]): { ci: PrFact["ci"]; ciAt: number | null } {
  if (!Array.isArray(rollup) || !rollup.length) return { ci: "none", ciAt: null };
  let running = false;
  let failed = false;
  let at: number | null = null;
  // The rollup keeps every run at the head sha, so a run superseded by a newer one (CANCELLED when a push
  // restarts CI) still shows. Only the newest run per check name counts (24 Oct 2026: #3533 read red from
  // cancelled jobs while its CI gate had passed). A completed "CI gate" decides on its own.
  const newest = new Map<string, any>();
  for (const c of rollup) {
    const key = `${c.workflowName ?? ""}\u0000${c.name ?? c.context ?? ""}`;
    const prev = newest.get(key);
    if (!prev || (ts(c.startedAt) ?? 0) >= (ts(prev.startedAt) ?? 0)) newest.set(key, c);
  }
  const gate = newest.get("PR checks\u0000CI gate") ?? [...newest.values()].find((c) => c.name === "CI gate");
  if (gate && gate.status === "COMPLETED" && ["SUCCESS", "FAILURE"].includes(gate.conclusion)) {
    return { ci: gate.conclusion === "SUCCESS" ? "passed" : "failed", ciAt: ts(gate.completedAt) ?? ts(gate.startedAt) };
  }
  for (const c of newest.values()) {
    const isRun = c.__typename === "CheckRun" || "conclusion" in c;
    if (isRun) {
      if (c.status && c.status !== "COMPLETED") running = true;
      else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion)) failed = true;
    } else {
      if (["PENDING", "EXPECTED"].includes(c.state)) running = true;
      else if (["FAILURE", "ERROR"].includes(c.state)) failed = true;
    }
    for (const t of [ts(c.startedAt), ts(c.completedAt)]) if (t && (!at || t > at)) at = t;
  }
  return { ci: running ? "running" : failed ? "failed" : "passed", ciAt: at };
}

export function createBoard(opts: {
  db: Database;
  gh?: GhRunner;
  now?: () => number;
  repo?: string;
  onChange?: () => void;
  event?: (who: string, text: string, lane?: string | null) => void;
}) {
  const { db } = opts;
  const gh = opts.gh ?? ghCli();
  const now = opts.now ?? Date.now;
  const repo = opts.repo ?? "";
  const onChange = opts.onChange ?? (() => {});
  const event = opts.event ?? (() => {});

  db.exec(`
  CREATE TABLE IF NOT EXISTS work_items (
    issue TEXT PRIMARY KEY,
    lane TEXT,
    prs TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    paused_reason TEXT,
    paused_at INTEGER
  );
  `);
  // Tracking an item again reopens it: PRs that ended before then no longer count towards done.
  if (!(db.query("PRAGMA table_info(work_items)").all() as { name: string }[]).some((c) => c.name === "reopened_at")) db.exec("ALTER TABLE work_items ADD COLUMN reopened_at INTEGER");

  const cache = new Map<string, PrFact>();
  const inflight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  // PRs another feature needs facts for (a question's checklist). They ride on the same refresh and keep the same
  // poll running while any are named; the board adds no poll of its own for them. onFacts hears every change.
  const followers: (() => string[])[] = [];
  const factListeners: (() => void)[] = [];
  const followed = () => followers.flatMap((keys) => keys());
  const follow = (keys: () => string[]) => void followers.push(keys);
  const onFacts = (fn: () => void) => void factListeners.push(fn);
  const fact = (key: string) => cache.get(key) ?? null;

  const rows = () => (db.query("SELECT * FROM work_items ORDER BY created_at").all() as any[]).map((r) => ({ ...r, prs: JSON.parse(r.prs) as string[] }));
  const getItem = (issue: string) => rows().find((r) => r.issue === issue) ?? null;
  const normIssue = (s: unknown) => String(s ?? "").trim().toUpperCase();
  const mustGet = (issue: string) => {
    const it = getItem(normIssue(issue));
    if (!it) throw new Error(`not tracked: ${issue}`);
    return it;
  };

  function addPrs(issue: string, raws: string[]) {
    const it = getItem(issue)!;
    const keys = new Set(it.prs);
    for (const raw of raws) {
      const ref = parsePr(raw, repo);
      if (!ref) throw new Error(`not a PR: ${raw}`);
      keys.add(ref.key);
    }
    db.query("UPDATE work_items SET prs = ? WHERE issue = ?").run(JSON.stringify([...keys]), issue);
  }

  // ---- writes (HQ) ----

  function track(body: any) {
    const issue = normIssue(body.issue);
    if (!issue) throw new Error("issue is required");
    const lane = body.lane ? String(body.lane) : null;
    const existing = getItem(issue);
    if (!existing) db.query("INSERT INTO work_items (issue, lane, created_at) VALUES (?, ?, ?)").run(issue, lane, now());
    else {
      // Tracking again reopens it, even when its PRs have all ended (a new PR is coming).
      db.query("UPDATE work_items SET lane = COALESCE(?, lane), done_at = NULL, reopened_at = ? WHERE issue = ?").run(lane, now(), issue);
    }
    addPrs(issue, splitList(body.prs ?? body.pr));
    event("board", `tracking ${issue}`, lane ?? existing?.lane);
    kick();
    return view();
  }

  function done(body: any) {
    const it = mustGet(body.issue);
    db.query("UPDATE work_items SET done_at = ? WHERE issue = ?").run(now(), it.issue);
    event("board", `${it.issue} done`, it.lane);
  }

  function pause(body: any) {
    const it = mustGet(body.issue);
    const reason = String(body.reason ?? "").trim();
    if (!reason) throw new Error("a reason is required");
    db.query("UPDATE work_items SET paused_reason = ?, paused_at = ? WHERE issue = ?").run(reason, now(), it.issue);
    event("board", `${it.issue} paused: ${reason}`, it.lane);
  }

  function resume(body: any) {
    const it = mustGet(body.issue);
    db.query("UPDATE work_items SET paused_reason = NULL, paused_at = NULL WHERE issue = ?").run(it.issue);
    event("board", `${it.issue} resumed`, it.lane);
    kick();
  }

  // `hud lane NAME --issue X --pr N`: the lane's issue becomes a tracked item owned by that lane, with those PRs.
  function linkLane(body: any) {
    if (!body?.name || (body.issue === undefined && body.pr === undefined)) return;
    const lane = db.query("SELECT issue, pr FROM lanes WHERE name = ?").get(body.name) as any;
    const issues = splitList(body.issue ?? lane?.issue).map(normIssue);
    if (!issues.length) return;
    for (const issue of issues) {
      if (!getItem(issue)) db.query("INSERT INTO work_items (issue, lane, created_at) VALUES (?, ?, ?)").run(issue, body.name, now());
      else db.query("UPDATE work_items SET lane = ? WHERE issue = ?").run(body.name, issue);
    }
    const prs = splitList(body.pr).filter((p) => parsePr(p, repo));
    if (prs.length) addPrs(issues[0], prs);
    kick();
  }

  // ---- GitHub ----

  async function fetchPr(key: string) {
    const ref = parsePr(key, repo)!;
    const prev = cache.get(key);
    let fact: PrFact;
    try {
      const pr = await gh(ref);
      const { ci, ciAt } = readChecks(pr.statusCheckRollup);
      fact = {
        key,
        number: ref.number,
        fetchedAt: now(),
        state: String(pr.state ?? "").toUpperCase(),
        draft: !!pr.isDraft,
        ci,
        ciAt,
        updatedAt: ts(pr.updatedAt),
        endedAt: ts(pr.mergedAt) ?? ts(pr.closedAt),
      };
    } catch (e) {
      // Keep what we knew; note the error.
      fact = { ...(prev ?? { key, number: ref.number }), fetchedAt: now(), error: (e as Error).message.slice(0, 160) };
    }
    cache.set(key, fact);
    const sig = (f?: PrFact) => (f ? JSON.stringify({ ...f, fetchedAt: 0 }) : "");
    return sig(prev) !== sig(fact);
  }

  const isOpen = (it: any) => !it.done_at && !prsEnded(it);
  const hasEnded = (k: string) => ["MERGED", "CLOSED"].includes(cache.get(k)?.state ?? "");
  // The PRs that decide done: all of them, except those that ended before the item was tracked again.
  const currentPrs = (it: any) => it.prs.filter((k: string) => !(it.reopened_at && hasEnded(k) && (cache.get(k)?.endedAt ?? 0) <= it.reopened_at));
  const prsEnded = (it: any) => {
    const cur = currentPrs(it);
    return cur.length > 0 && cur.every(hasEnded);
  };

  // Fetch every PR of every open item whose cached facts are older than maxAge. A merged PR never changes again.
  async function refresh(maxAge = GH_CACHE_MS) {
    const t = now();
    const keys = new Set<string>();
    for (const it of rows()) {
      if (!isOpen(it)) continue;
      for (const k of it.prs) {
        const c = cache.get(k);
        if (c?.state === "MERGED") continue;
        if (!c || t - c.fetchedAt >= maxAge) keys.add(k);
      }
    }
    for (const k of followed()) {
      const c = cache.get(k);
      if (c?.state !== "MERGED" && (!c || t - c.fetchedAt >= maxAge)) keys.add(k);
    }
    let changed = false;
    await Promise.all(
      [...keys].map((k) => {
        let p = inflight.get(k);
        if (!p) {
          p = fetchPr(k).then((c) => {
            if (c) changed = true;
          }).finally(() => inflight.delete(k));
          inflight.set(k, p);
        }
        return p;
      }),
    );
    if (changed) {
      for (const fn of factListeners) fn();
      onChange();
    }
    syncTimer();
    return changed;
  }

  // The poll runs only while something is open.
  function syncTimer() {
    const open = rows().some(isOpen) || followed().length > 0;
    if (open && !timer) timer = setInterval(() => refresh(GH_REFRESH_MS - 5_000).catch(() => {}), GH_REFRESH_MS);
    if (!open && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // After a write: fetch new PRs now (in the background) and make sure the poll runs.
  function kick() {
    refresh(GH_CACHE_MS).catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ---- derived view ----

  function view() {
    const t = now();
    const lanes = new Map((db.query("SELECT * FROM lanes").all() as any[]).map((l) => [l.name, l]));
    const asks = db.query("SELECT id, lane, title, body, status, created_at, answered_at FROM asks WHERE recipient = 'owner' AND status != 'withdrawn'").all() as any[];
    const all = rows();
    // An ask names an item by its issue key or one of its PR numbers, in the title or the body.
    const prNums = (it: any) => it.prs.map((k: string) => parsePr(k, repo)?.number).filter(Boolean) as number[];
    const namesItem = (a: any, it: any) => {
      const text = `${a.title ?? ""}\n${a.body ?? ""}`;
      if (text.toUpperCase().includes(it.issue)) return true;
      return prNums(it).some((n) => new RegExp(`(^|[^\\w])#?${n}(?![\\w])`).test(text));
    };
    const named = new Map(asks.map((a) => [a.id, new Set(all.filter((it) => namesItem(a, it)).map((it) => it.issue))]));
    const items = all.map((it) => {
      const prs = it.prs.map((k: string) => {
        const c = cache.get(k);
        return {
          key: k,
          number: parsePr(k, repo)?.number ?? null,
          repo: parsePr(k, repo)?.repo ?? null,
          state: c?.state ?? null,
          draft: c?.draft ?? null,
          ci: c?.ci ?? null,
          updatedAt: c?.updatedAt ?? null,
          fetchedAt: c?.fetchedAt ?? null,
          error: c?.error ?? null,
        };
      });
      const lane = it.lane ? lanes.get(it.lane) : null;
      const working = lane?.herdr === "working" || !!lane?.bg;
      // An ask is this item's when it names the item, or when it sits on the item's lane and names no tracked item
      // at all (a question about the lane). One that names another item belongs to that item, even on this lane.
      const laneAsk = (a: any) => !!it.lane && a.lane === it.lane && !named.get(a.id)!.size;
      const myAsks = asks.filter((a) => named.get(a.id)!.has(it.issue) || laneAsk(a));
      // A lane's question holds its work only while the lane is not working: a lane can have both at once.
      const openAsks = myAsks.filter((a) => a.status === "open" && (named.get(a.id)!.has(it.issue) || !working));

      // What last happened: PR update, CI change, lane status change, ask, or a note on the lane.
      const happened: Happened[] = [];
      for (const k of it.prs) {
        const c = cache.get(k);
        const n = `#${parsePr(k, repo)?.number ?? k}`;
        if (c?.updatedAt) happened.push({ at: c.updatedAt, what: `${n} ${c.state === "MERGED" ? "merged" : c.state === "CLOSED" ? "closed" : "updated"}` });
        if (c?.ciAt) happened.push({ at: c.ciAt, what: `CI on ${n} ${c.ci === "running" ? "started" : c.ci}` });
      }
      if (lane?.herdr_since) happened.push({ at: lane.herdr_since, what: `lane went ${lane.herdr ?? "?"}`, stuck: lane.herdr === "gone" });
      if (it.reopened_at) happened.push({ at: it.reopened_at, what: "tracked again" });
      for (const a of myAsks) {
        happened.push({ at: a.created_at, what: `asked: ${a.title}` });
        if (a.answered_at) happened.push({ at: a.answered_at, what: `answered: ${a.title}` });
      }
      if (it.lane) {
        const e = db.query("SELECT at, text FROM events WHERE lane = ? AND who != 'board' ORDER BY at DESC LIMIT 1").get(it.lane) as any;
        if (e) happened.push({ at: e.at, what: `note: ${e.text}` });
      }
      const last = happened.sort((a, b) => b.at - a.at)[0] ?? null;
      const lastMove = happened.find((h) => !h.stuck) ?? null;

      const ended = prsEnded(it);
      let state: BoardState;
      let why: string;
      if (it.done_at || ended) {
        state = "done";
        why = it.done_at ? "closed by HQ" : "all PRs merged or closed";
      } else if (lane?.prompt) {
        state = "blocked";
        why = lane.prompt.split("\n").join(" / ");
      } else if (openAsks.length) {
        state = "owner";
        const a = openAsks.find((x) => named.get(x.id)!.has(it.issue)) ?? openAsks[0];
        why = `ask #${a.id}: ${a.title}`;
      } else if (prs.some((p: any) => p.state === "OPEN" && p.ci === "running")) {
        state = "ci";
        why = "a check is running";
      } else if (it.paused_reason) {
        state = "paused";
        why = it.paused_reason;
      } else if (working) {
        state = "moving";
        why = lane?.bg ? `lane is working (${lane.bg})` : "lane is working";
      } else if (lastMove && t - lastMove.at < STALL_MS) {
        state = "moving";
        why = "changed recently";
      } else {
        state = "stalled";
        why = lastMove ? `no change for ${Math.floor((t - lastMove.at) / 60_000)} min` : "nothing has happened";
      }
      const doneAt = it.done_at ?? (ended ? Math.max(...prs.map((p: any) => cache.get(p.key)?.endedAt ?? 0)) || t : null);
      return {
        issue: it.issue,
        lane: it.lane,
        // The lane its lane reports to (null: HQ), so the board can group work under its managers.
        manager: lane?.parent && lanes.has(lane.parent) ? (lane.parent as string) : null,
        laneStatus: lane?.herdr ?? null,
        // Where the prompt waits, so someone can go and answer it.
        where: state === "blocked" ? { machine: lane?.machine ?? null, pane: lane?.pane ?? null } : null,
        prs,
        state,
        why,
        pausedReason: it.paused_reason,
        pausedAt: it.paused_at,
        openAsks: openAsks.map((a) => a.id),
        last: last ? { at: last.at, what: last.what, age: t - last.at } : null,
        createdAt: it.created_at,
        doneAt,
      };
    });
    const shown = items.filter((i) => i.state !== "done" || t - (i.doneAt ?? t) < DONE_SHOWN_MS);
    // Within a state, the oldest last change first.
    shown.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || (a.last?.at ?? 0) - (b.last?.at ?? 0));
    const counts = Object.fromEntries(STATE_ORDER.map((s) => [s, shown.filter((i) => i.state === s).length])) as Record<BoardState, number>;
    // Lanes blocked on a prompt with no open tracked item: `hud board` lists them too, so no block goes unseen.
    const covered = new Set(shown.filter((i) => i.state === "blocked").map((i) => i.lane));
    const blockedLanes = [...lanes.values()]
      .filter((l) => l.prompt && !covered.has(l.name))
      .map((l) => ({ lane: l.name as string, machine: (l.machine ?? null) as string | null, pane: (l.pane ?? null) as string | null, prompt: l.prompt as string }));
    return { now: t, stallMs: STALL_MS, counts, items: shown, blockedLanes };
  }

  return { track, done, pause, resume, linkLane, refresh, view, syncTimer, stop, follow, onFacts, fact };
}

// ---- plain text for HQ's sweep: stalled first ----

function ago(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

// `owner` names the person who answers asks (HUD_OWNER), in place of OWNER.
export function boardText(v: ReturnType<ReturnType<typeof createBoard>["view"]>, owner = "") {
  const label = (s: BoardState) => (s === "owner" && owner ? `WAITING ON ${owner.toUpperCase()}` : STATE_LABEL[s]);
  const where = (machine: string | null, pane: string | null) => (machine || pane ? ` (${[machine, pane].filter(Boolean).join(", ")})` : "");
  // Lanes blocked on a prompt that no tracked item covers come first, before the board itself.
  const loose = (v.blockedLanes ?? []).map((b) => `  lane ${b.lane}${where(b.machine, b.pane)}  ${b.prompt.split("\n").join(" / ")}`);
  const looseHead = loose.length ? [`${STATE_LABEL.blocked} (answer in the pane)`, ...loose] : [];
  if (!v.items.length) return [...looseHead, ...(loose.length ? [""] : []), "WORK BOARD: nothing tracked. Add work with: hud track ISSUE --lane L --pr N"].join("\n");
  const head = `WORK BOARD: ${STATE_ORDER.filter((s) => v.counts[s]).map((s) => `${v.counts[s]} ${label(s).toLowerCase()}`).join(", ")}`;
  const out = [...looseHead, ...(loose.length ? [""] : []), head];
  for (const s of STATE_ORDER) {
    const its = v.items.filter((i) => i.state === s);
    if (!its.length) continue;
    out.push("", `${label(s)}${s === "stalled" ? " (push these)" : s === "blocked" ? " (answer in the pane)" : ""}`);
    // With lanes in a tree, the work in each state is grouped under the lane its lane reports to (in the order
    // of its oldest item), so a manager sees its reports' work together.
    const grouped = v.items.some((i) => i.manager);
    const groups = new Map<string, typeof its>();
    for (const i of its) {
      const key = i.manager ?? "HQ";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    }
    for (const [manager, list] of grouped ? groups : new Map([["", its]])) {
      if (grouped) out.push(`  under ${manager}`);
      for (const i of list) {
        const prs = i.prs.map((p) => `#${p.number}${p.draft ? " draft" : ""}${p.state && p.state !== "OPEN" ? ` ${p.state.toLowerCase()}` : ""}${p.ci && p.ci !== "none" && p.state === "OPEN" ? ` ci ${p.ci}` : ""}${p.error ? ` (gh: ${p.error})` : ""}`).join(", ");
        const last = i.last ? `last: ${i.last.what} (${ago(i.last.age)})` : "last: nothing yet";
        const lane = s === "blocked" && i.where ? where(i.where.machine, i.where.pane) : i.laneStatus ? ` (${i.laneStatus})` : "";
        out.push(`${grouped ? "    " : "  "}${i.issue}  lane ${i.lane ?? "-"}${lane}  PR ${prs || "-"}  ${s === "paused" || s === "owner" || s === "blocked" ? `${i.why}  ` : ""}${last}`);
      }
    }
  }
  return out.join("\n");
}
