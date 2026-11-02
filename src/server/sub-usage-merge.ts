// SUBS, the pure half: the reader's line checked field by field, and the machines' readings merged into one row per
// subscription for the page. No I/O here, so the tests import it as it is (sub-usage.ts does the reading).
export type Win = { w: "5h" | "week"; left: number; resets: number | null };
export type Reading = { key: string; name: string; plan?: string | null; active?: boolean; at: number; windows: Win[] };
// What one machine said. null for a source means it has none; an empty list means it has one with no reading yet.
export type MachineUsage = { machine: string; ok: boolean; python: boolean; claude: Reading[] | null; codex: Reading[] | null };
export type Window = { left: number; resetsAt: number | null };
export type Sub = { provider: "claude" | "codex"; name: string; plan: string | null; activeOn: string[]; fiveHour: Window | null; weekly: Window | null; asOf: number };

// Only the fields the page needs, each checked: the reader's line is data, not trusted to be well formed.
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function list(v: unknown): Reading[] | null {
  if (!Array.isArray(v)) return null;
  return v
    .filter((r) => r && typeof r.key === "string" && num(r.at))
    .map((r) => ({
      key: r.key,
      name: typeof r.name === "string" && r.name ? r.name.slice(0, 40) : "",
      plan: typeof r.plan === "string" ? r.plan.slice(0, 20) : null,
      active: r.active === true,
      at: r.at,
      windows: (Array.isArray(r.windows) ? r.windows : [])
        .filter((w: any) => (w?.w === "5h" || w?.w === "week") && num(w.left))
        .map((w: any) => ({ w: w.w, left: Math.max(0, Math.min(100, w.left)), resets: num(w.resets) ? w.resets : null })),
    }));
}

const windowOf = (r: Reading, w: Win["w"]): Window | null => {
  const hit = r.windows.find((x) => x.w === w);
  return hit ? { left: hit.left, resetsAt: hit.resets } : null;
};
// The room a sub has: its tighter window, where a window past its reset counts as full. For the order only.
function room(s: Sub, now: number) {
  const left = [s.fiveHour, s.weekly].filter((w): w is Window => !!w).map((w) => (w.resetsAt !== null && w.resetsAt <= now ? 100 : w.left));
  return left.length ? Math.min(...left) : -1;
}

// One row per subscription. A Claude account is the same on every machine (grazr enrols it on each), so its newest
// reading wins and it is active wherever Claude is logged in to it. Codex says nothing of its account, so each
// machine's Codex is a sub of its own. The account ids stay here: the page gets none.
export function merge(machines: MachineUsage[], now = Date.now()): Sub[] {
  const claude = new Map<string, { newest: Reading; activeOn: string[] }>();
  const subs: Sub[] = [];
  for (const m of machines) {
    for (const r of m.claude ?? []) {
      const hit = claude.get(r.key) ?? { newest: r, activeOn: [] };
      if (r.at > hit.newest.at) hit.newest = r;
      if (r.active) hit.activeOn.push(m.machine);
      claude.set(r.key, hit);
    }
    for (const r of m.codex ?? [])
      subs.push({ provider: "codex", name: r.key === "codex" ? "CODEX" : `CODEX ${r.key.toUpperCase()}`, plan: r.plan ?? null, activeOn: [m.machine], fiveHour: windowOf(r, "5h"), weekly: windowOf(r, "week"), asOf: r.at });
  }
  for (const { newest: r, activeOn } of claude.values())
    subs.push({ provider: "claude", name: r.name || "CLAUDE", plan: null, activeOn, fiveHour: windowOf(r, "5h"), weekly: windowOf(r, "week"), asOf: r.at });
  return subs.sort((a, b) => room(b, now) - room(a, now) || a.name.localeCompare(b.name));
}

// What each machine has to read from: "ok", "none" (no grazr, no Codex, or no python3) or "unreachable".
export function sources(machines: MachineUsage[]) {
  const say = (m: MachineUsage, src: Reading[] | null) => (!m.ok ? "unreachable" : src ? "ok" : "none");
  return machines.map((m) => ({ machine: m.machine, claude: say(m, m.claude), codex: say(m, m.codex) }));
}
