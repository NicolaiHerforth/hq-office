// DONE MEANS: a room linked to a Linear project, and that project's acceptance criteria (its issues with the
// acceptance label), so anyone can see how far along it is without opening Linear. Linear stays the source of truth;
// the HUD only keeps the link (a room_links row, kind "project", ref the project's id) and the project's name and URL.
//
// Linear is fetched when a room is linked, on demand (hud room acceptance --refresh, ?refresh=1) when the cache is
// older than CACHE_MS, and every REFRESH_MS only while an open room has a project (the timer stops when none has).
// A page load never fetches. The cache is in memory; a restart fetches once if any open room has a project.
// The key (HUD_LINEAR_API_KEY) is read when a fetch needs it and never stored, logged or shown: linear.ts cleans every
// error of it.
//
// This file is the cache and the schedule on a given database (testable on its own); room-acceptance.ts runs the one
// instance on the server's database and puts it in /api/state as S.acceptance.
import type { Database } from "bun:sqlite";
import { createLinear, LinearError, type Issue, type Project, type StateType } from "./linear.ts";

export const REFRESH_MS = 10 * 60_000;
export const CACHE_MS = 60_000;
export const NO_KEY = "no Linear key";
export const DEFAULT_LABEL = "acceptance";

export type Item = { key: string; title: string; state: string; stateType: StateType; url: string; updatedAt: number };
export type Milestone = { name: string | null; items: Item[] };
export type RoomAcceptance = { project: Project; met: number; total: number; milestones: Milestone[]; fetchedAt: number | null; error: string | null };

type Cached = { met: number; total: number; milestones: Milestone[]; fetchedAt: number | null; triedAt: number; error: string | null };
type Timers = { every: (fn: () => void, ms: number) => unknown; cancel: (handle: any) => void };

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;

// "ENG-9" before "ENG-10": by team, then by number.
function byKey(a: Item, b: Item) {
  const [ta, na] = [a.key.replace(/-\d+$/, ""), Number(a.key.match(/(\d+)$/)?.[1] ?? 0)];
  const [tb, nb] = [b.key.replace(/-\d+$/, ""), Number(b.key.match(/(\d+)$/)?.[1] ?? 0)];
  return ta.localeCompare(tb) || na - nb;
}

// met: done; total: everything not canceled. Milestones in Linear's order, the issues without one last (name null).
export function summarize(issues: Issue[]) {
  const groups = new Map<string, { name: string | null; order: number; items: Item[] }>();
  for (const i of issues) {
    const id = i.milestone?.id ?? "";
    if (!groups.has(id)) groups.set(id, { name: i.milestone ? i.milestone.name : null, order: i.milestone ? i.milestone.sortOrder : Infinity, items: [] });
    groups.get(id)!.items.push({ key: i.key, title: i.title, state: i.state, stateType: i.stateType, url: i.url, updatedAt: i.updatedAt });
  }
  const milestones = [...groups.values()]
    .sort((a, b) => (a.order === b.order ? (a.name ?? "").localeCompare(b.name ?? "") : a.order === Infinity ? 1 : b.order === Infinity ? -1 : a.order - b.order))
    .map((g) => ({ name: g.name, items: g.items.sort(byKey) }));
  return {
    met: issues.filter((i) => i.stateType === "completed").length,
    total: issues.filter((i) => i.stateType !== "canceled").length,
    milestones,
  };
}

export function createAcceptance(opts: {
  db: Database;
  key?: () => string;
  apiUrl?: () => string;
  label?: () => string;
  now?: () => number;
  onChange?: () => void;
  event?: (who: string, text: string, floor: string | null) => void;
  timers?: Timers;
}) {
  const { db } = opts;
  const key = opts.key ?? (() => process.env.HUD_LINEAR_API_KEY?.trim() ?? "");
  const apiUrl = opts.apiUrl ?? (() => process.env.HUD_LINEAR_API_URL ?? "");
  const label = opts.label ?? (() => process.env.HUD_LINEAR_ACCEPTANCE_LABEL?.trim() || DEFAULT_LABEL);
  const now = opts.now ?? Date.now;
  const onChange = opts.onChange ?? (() => {});
  const event = opts.event ?? (() => {});
  const timers = opts.timers ?? { every: (fn, ms) => setInterval(fn, ms), cancel: (h) => clearInterval(h) };

  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<void>>();
  let timer: unknown = null;

  // Every room with a project, open or archived.
  const linked = () =>
    db.query("SELECT l.slug, l.ref, r.archived_at FROM room_links l JOIN rooms r ON r.slug = l.slug WHERE l.kind = 'project' ORDER BY l.slug").all() as { slug: string; ref: string; archived_at: number | null }[];
  const openProjects = () => [...new Set(linked().filter((l) => !l.archived_at).map((l) => l.ref))];
  const projectRow = (id: string) => db.query("SELECT id, name, url FROM linear_projects WHERE id = ?").get(id) as Project | null;
  const saveProject = (p: Project) =>
    db.query("INSERT INTO linear_projects (id, name, url, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, at = excluded.at").run(p.id, p.name, p.url, now());
  const mustRoom = (raw: unknown) => {
    const slug = String(raw ?? "").trim().toLowerCase();
    const r = SLUG.test(slug) ? (db.query("SELECT slug, floor FROM rooms WHERE slug = ?").get(slug) as { slug: string; floor: string | null } | null) : null;
    if (!r) throw new Error(`no room ${slug}`);
    return r;
  };
  const linkOf = (slug: string) => (db.query("SELECT ref FROM room_links WHERE slug = ? AND kind = 'project'").get(slug) as { ref: string } | null)?.ref ?? null;
  const linear = () => createLinear({ key: key(), url: apiUrl() });
  // Last line of defence: no message leaves with the key in it, whatever threw it.
  const scrub = (msg: string) => (key() ? msg.split(key()).join("[key]") : msg);

  // ---- writes ----

  // Link a room to the project a REF names (URL, slugId or exact name), resolved now to its id; or { clear: true }.
  async function link(slugRaw: unknown, body: any, who = "hq") {
    const r = mustRoom(slugRaw);
    if (body?.clear) {
      const was = linkOf(r.slug);
      db.query("DELETE FROM room_links WHERE slug = ? AND kind = 'project'").run(r.slug);
      if (was) event(who, `unlinked room ${r.slug} from its Linear project`, r.floor);
      syncTimer();
      return { project: null };
    }
    const ref = String(body?.ref ?? "").trim();
    if (!ref) throw new Error("give a Linear project: its URL, its slugId or its exact name");
    if (!key()) throw new Error(NO_KEY);
    let p: Project;
    try {
      p = await linear().project(ref);
    } catch (e) {
      throw new Error(scrub((e as Error).message));
    }
    db.transaction(() => {
      db.query("DELETE FROM room_links WHERE slug = ? AND kind = 'project'").run(r.slug);
      db.query("INSERT INTO room_links (slug, kind, ref) VALUES (?, 'project', ?)").run(r.slug, p.id);
      saveProject(p);
    })();
    event(who, `linked room ${r.slug} to Linear project ${p.name}`, r.floor);
    syncTimer();
    // Its criteria now, in the background: the reply does not wait for them, the page hears when they land.
    fetchProject(p.id).catch(() => {});
    return { project: p };
  }

  // ---- Linear ----

  function fetchProject(id: string) {
    let p = inflight.get(id);
    if (p) return p;
    p = (async () => {
      const prev = cache.get(id);
      const t = now();
      const k = key();
      if (!k) {
        cache.set(id, { ...(prev ?? { met: 0, total: 0, milestones: [], fetchedAt: null }), triedAt: t, error: NO_KEY });
      } else {
        try {
          const got = await linear().issues(id, label());
          saveProject(got.project);
          cache.set(id, { ...summarize(got.issues), fetchedAt: t, triedAt: t, error: null });
        } catch (e) {
          // Keep what we knew; say what went wrong.
          const msg = scrub(e instanceof LinearError ? e.message : `Linear: ${(e as Error).message}`).slice(0, 200);
          cache.set(id, { ...(prev ?? { met: 0, total: 0, milestones: [], fetchedAt: null }), triedAt: t, error: msg });
        }
      }
      onChange();
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  const stale = (id: string, maxAge: number) => {
    const c = cache.get(id);
    return !c || now() - c.triedAt >= maxAge;
  };

  // Every open room's project whose cache is older than maxAge.
  async function refresh(maxAge = CACHE_MS) {
    await Promise.all(openProjects().filter((id) => stale(id, maxAge)).map(fetchProject));
    syncTimer();
  }

  // One room's project (open or archived) when its cache is older than maxAge: hud room acceptance --refresh.
  async function refreshRoom(slugRaw: unknown, maxAge = CACHE_MS) {
    const id = linkOf(mustRoom(slugRaw).slug);
    if (id && stale(id, maxAge)) await fetchProject(id);
  }

  // The poll runs only while an open room has a project.
  function syncTimer() {
    const need = openProjects().length > 0;
    if (need && !timer) timer = timers.every(() => refresh(REFRESH_MS - 5_000).catch(() => {}), REFRESH_MS);
    if (!need && timer) {
      timers.cancel(timer);
      timer = null;
    }
  }

  // At startup: the poll, if an open room has a project, and its first fetch.
  function start() {
    syncTimer();
    if (timer) refresh(0).catch(() => {});
  }

  function stop() {
    if (timer) timers.cancel(timer);
    timer = null;
  }

  // ---- reads ----

  function entry(slug: string, id: string): RoomAcceptance {
    const c = cache.get(id);
    return {
      project: projectRow(id) ?? { id, name: "", url: "" },
      met: c?.met ?? 0,
      total: c?.total ?? 0,
      milestones: c?.milestones ?? [],
      fetchedAt: c?.fetchedAt ?? null,
      error: !key() ? NO_KEY : c?.error ?? null,
    };
  }

  // S.acceptance: every room with a project, by slug.
  function state(): Record<string, RoomAcceptance> {
    return Object.fromEntries(linked().map((l) => [l.slug, entry(l.slug, l.ref)]));
  }

  // One room's, or null when it has no project.
  function view(slugRaw: unknown): RoomAcceptance | null {
    const r = mustRoom(slugRaw);
    const id = linkOf(r.slug);
    return id ? entry(r.slug, id) : null;
  }

  return { link, refresh, refreshRoom, syncTimer, start, stop, state, view, running: () => !!timer };
}

// ---- plain text for a room's lane: "are we done?" ----

const MARK: Record<string, string> = { completed: "[x]", canceled: "[-]" };

export function acceptanceText(slug: string, a: RoomAcceptance | null, ago: (t: number) => string) {
  if (!a) return `room ${slug} has no Linear project: hud room project ${slug} URL`;
  const out = [`PROJECT ${a.project.name || a.project.id}: ${a.met} of ${a.total} met`];
  if (a.project.url) out.push(a.project.url);
  if (a.error) out.push(`(${a.error}${a.fetchedAt ? "; showing what was fetched before" : ""})`);
  if (!a.fetchedAt) {
    if (!a.error) out.push("(not fetched yet: hud room acceptance " + slug + " --refresh)");
    return out.join("\n");
  }
  if (!a.milestones.length) out.push("", `no issues labelled acceptance yet`);
  for (const m of a.milestones) {
    out.push("", m.name ?? "NO MILESTONE");
    for (const i of m.items) out.push(`  ${MARK[i.stateType] ?? "[ ]"} ${i.key}  ${i.state}  ${i.title}`);
  }
  out.push("", `updated ${ago(a.fetchedAt)}  ([x] met, [ ] open, [-] canceled: not counted)`);
  return out.join("\n");
}
