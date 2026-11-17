// THE MONITOR, who a process belongs to: a lane, a pane, HQ Office, an app, the system, or nobody known. Pure: it is
// given the processes and the panes, and what it may ask about a process (a Lookup) when the parent chain does not
// say. The rules are one ordered table (RULES); the first that matches a process decides.
import type { Lookup, Owner, Pane, Proc } from "./monitor-types.ts";

export type Ctx = { panes: Pane[]; self: number; uid: number; home: string; lookup?: Lookup };
const NOTHING: Lookup = { launchPane: () => null, cwd: () => null, responsible: () => null };

// The system's own bundles (the Finder, the Dock, agents) are the system. The apps it ships, such as its browser, sit
// in a System/Applications folder and are apps like any other.
const SYSTEM_BUNDLES = ["/System/", "/usr/", "/Library/Apple/"];
const SHIPPED_APPS = "/System/Applications/";
const SYSTEM_PATHS = ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/Library/Apple/"];
const under = (path: string, prefixes: string[]) => prefixes.some((prefix) => path.startsWith(prefix));

// The app whose bundle a path is in: the outermost one, so a helper's own bundle inside it counts as the app.
export function appOf(path: string | null): string | null {
  if (!path || (under(path, SYSTEM_BUNDLES) && !path.includes(SHIPPED_APPS))) return null;
  const bundle = path.split("/").find((part) => part.length > 4 && part.endsWith(".app"));
  return bundle ? bundle.slice(0, -4) : null;
}

const TEMP = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];

// A folder as its owner would say it: "~/work/repo". Deep below home it keeps the last two folders, which is where
// a worktree's name is. Outside home it keeps the last two as well, never the whole path. Temp folders are one
// label: each has a name of its own, and a label per run would never be seen twice.
export function folderLabel(cwd: string | null, home: string): string | null {
  if (cwd === null) return null;
  if (under(`${cwd}/`, TEMP)) return "a temp folder";
  const inHome = cwd === home || cwd.startsWith(`${home}/`);
  const parts = (inHome ? cwd.slice(home.length) : cwd).split("/").filter(Boolean);
  if (inHome) return parts.length > 3 ? `~/…/${parts.slice(-2).join("/")}` : ["~", ...parts].join("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : `/${parts.join("/")}`;
}

const MAX_UP = 64;

// A process and its ancestors, nearest first. It ends below launchd and the kernel (everything descends from them, so
// they say nothing), at a parent that is gone, and after MAX_UP steps, so a cycle of parents cannot hang it.
function chainOf(p: Proc, byPid: Map<number, Proc>): Proc[] {
  const chain = [p];
  for (let up = byPid.get(p.ppid); up && up.pid > 1 && chain.length <= MAX_UP; up = byPid.get(up.ppid)) chain.push(up);
  return chain;
}

type Facts = { p: Proc; chain: Proc[]; ctx: Ctx; shells: Map<number, Pane>; byPid: Map<number, Proc>; lookup: Lookup };

// What was run: the app when the executable is in one, so a browser a lane's test starts is one name with its helpers.
const ran = (p: Proc) => appOf(p.path) ?? p.name;

const inPane = (pane: Pane, p: Proc, ctx: Ctx): Owner =>
  pane.lane ? { kind: "lane", owner: pane.lane, name: ran(p) } : { kind: "pane", owner: folderLabel(pane.cwd, ctx.home) ?? pane.pane, name: ran(p) };
const system = (p: Proc, ctx: Ctx) => p.uid !== ctx.uid || (p.path !== null && under(p.path, SYSTEM_PATHS));
// The top of a process's chain: what launchd started. A detached tree is known by it.
const rootOf = (chain: Proc[]) => chain[chain.length - 1];

// In order. The pane comes before HQ Office on purpose: a throwaway server a lane runs is that lane's work. The pane
// a tree was started from comes before the app, so a browser a lane's detached test run left behind is the lane's.
const RULES: ((facts: Facts) => Owner | null)[] = [
  ({ p, chain, ctx, shells }) => {
    const pane = chain.map((c) => shells.get(c.pid)).find(Boolean);
    return pane ? inPane(pane, p, ctx) : null;
  },
  ({ p, chain, ctx }) => (chain.some((c) => c.pid === ctx.self) ? { kind: "hq", owner: "HQ Office", name: ran(p) } : null),
  // The root is asked first, then down to the process itself: a root that is a system shell gives no environment,
  // and what it started still carries the pane.
  ({ p, chain, ctx, lookup }) => {
    if (p.uid !== ctx.uid) return null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = lookup.launchPane(chain[i]);
      const pane = id === null ? undefined : ctx.panes.find((x) => x.pane === id);
      if (pane) return inPane(pane, p, ctx);
    }
    return null;
  },
  ({ p, chain }) => {
    const app = chain.map((c) => appOf(c.path)).find(Boolean);
    return app ? { kind: "app", owner: app, name: p.name } : null;
  },
  // A system helper that works for an app, such as a browser engine's content process: launchd starts it, the
  // system ships it, and macOS knows which app it serves.
  ({ p, ctx, byPid, lookup }) => {
    if (p.uid !== ctx.uid || !system(p, ctx)) return null;
    const app = appOf(byPid.get(lookup.responsible(p) ?? -1)?.path ?? null);
    return app ? { kind: "app", owner: app, name: p.name } : null;
  },
  ({ p, ctx }) => (system(p, ctx) ? { kind: "system", owner: "system", name: p.name } : null),
];

// What fits no rule is grouped by the folder its tree runs in, which says more than "other": a dev stack is known
// by its worktree. The root folder and the home folder say nothing.
function other({ p, chain, ctx, lookup }: Facts): Owner {
  const cwd = lookup.cwd(rootOf(chain));
  const folder = cwd === null || cwd === "/" || cwd === ctx.home ? null : folderLabel(cwd, ctx.home);
  return { kind: "other", owner: folder ?? "other", name: p.name };
}

function ownerOf(facts: Facts): Owner {
  for (const rule of RULES) {
    const owner = rule(facts);
    if (owner) return owner;
  }
  return other(facts);
}

export function attribute(procs: Proc[], ctx: Ctx): Map<number, Owner> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const shells = new Map(ctx.panes.map((pane) => [pane.shellPid, pane]));
  const lookup = ctx.lookup ?? NOTHING;
  return new Map(procs.map((p) => [p.pid, ownerOf({ p, chain: chainOf(p, byPid), ctx, shells, byPid, lookup })]));
}
