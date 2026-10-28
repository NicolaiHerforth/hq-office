// The tree of lanes under HQ: depth and path from each lane's parent, level names, and the plain-text tree that
// `hud tree` prints. Pure functions, shared by the server and the CLI.

// The owner names the levels in SETTINGS; these stand until then. Deeper than the list uses the last name.
export const DEFAULT_LEVELS = ["Manager", "Lead", "Engineer"];

// A list that starts with HQ names HQ's own level (depth 0, always "HQ"): the lanes' levels are the rest.
export function levelNames(setting?: unknown): string[] {
  const names = typeof setting === "string" ? setting.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (names[0]?.toLowerCase() === "hq") names.shift();
  return names.length ? names : DEFAULT_LEVELS;
}

// The rank (1 = the top level) of a level name, any case; null for a name not in the list.
export function rankOf(level: unknown, names: string[]): number | null {
  const i = names.findIndex((n) => n.toLowerCase() === String(level ?? "").trim().toLowerCase());
  return i < 0 ? null : i + 1;
}

// HQ is depth 0, a lane straight under HQ depth 1, its lanes depth 2, and so on.
export function levelName(depth: number, names: string[]) {
  return depth < 1 ? "HQ" : names[Math.min(depth, names.length) - 1];
}

// `--parent hq` or an empty parent means straight under HQ.
export const underHq = (parent: unknown) => parent == null || String(parent).trim() === "" || String(parent).trim().toLowerCase() === "hq";

// Each lane's ancestors, from the top (path) and its depth. A parent that is not a lane counts as HQ, and a chain
// that comes back on itself stops there (the server refuses loops; this only keeps a bad row from hanging a read).
export function laneTree(lanes: { name: string; parent?: string | null }[]) {
  const parentOf = new Map(lanes.map((l) => [l.name, l.parent ?? null]));
  const out = new Map<string, { depth: number; path: string[] }>();
  for (const l of lanes) {
    const path: string[] = [];
    const seen = new Set([l.name]);
    for (let p = parentOf.get(l.name); p && parentOf.has(p) && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p);
      path.unshift(p);
    }
    out.set(l.name, { depth: path.length + 1, path });
  }
  return out;
}

// HQ's floor. Every lane is on it unless it sits under (or is) a general: a lane straight under HQ with a lane at
// depth 3 or deeper below it. A general directs leads as HQ does, so its subtree is a floor of its own, named for it.
// A tree of HQ > PM > builder stays one floor. The rule lives here and in its tests only.
export const HQ_FLOOR = "hq";

export function floorsOf(lanes: { name: string; parent?: string | null }[]) {
  const tree = laneTree(lanes);
  const heads = new Set<string>();
  for (const t of tree.values()) if (t.depth >= 3) heads.add(t.path[0]);
  const out = new Map<string, { floor: string; heads: boolean }>();
  for (const l of lanes) {
    const top = tree.get(l.name)!.path[0] ?? l.name;
    const floor = heads.has(top) ? top : HQ_FLOOR;
    out.set(l.name, { floor, heads: floor !== HQ_FLOOR && top === l.name });
  }
  return out;
}

const STATUS_WORDS: Record<string, string> = {
  blocked: "blocked on a prompt",
  needs_you: "waiting on the owner",
  hq_turn: "waiting on HQ",
  stale: "waiting on HQ 15+ min",
  gone: "agent gone",
  moving: "working",
  waiting: "waiting on CI / other",
  parked: "parked",
  done: "done",
};

type TreeLane = { name: string; parent?: string | null; level?: string; status?: string };

// The tree as `hud tree` prints it: HQ at the top, each lane under the lane it reports to, with its level name and
// status. Siblings in name order.
export function treeText(lanes: TreeLane[]) {
  if (!lanes.length) return "HQ\n  (no lanes yet: hud lane NAME [--parent OTHER])";
  const names = new Set(lanes.map((l) => l.name));
  const kids = new Map<string | null, TreeLane[]>();
  for (const l of lanes) {
    const p = l.parent && names.has(l.parent) && l.parent !== l.name ? l.parent : null;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(l);
  }
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const out = ["HQ"];
  const seen = new Set<string>();
  const walk = (parent: string | null, prefix: string) => {
    const list = kids.get(parent) ?? [];
    list.forEach((l, i) => {
      if (seen.has(l.name)) return;
      seen.add(l.name);
      const last = i === list.length - 1;
      const status = l.status ? STATUS_WORDS[l.status] ?? l.status : "";
      out.push(`${prefix}${last ? "└─ " : "├─ "}${l.name}  ${l.level ?? ""}${status ? ` · ${status}` : ""}`);
      walk(l.name, prefix + (last ? "   " : "│  "));
    });
  };
  walk(null, "");
  return out.join("\n");
}
