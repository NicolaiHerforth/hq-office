// THE MONITOR's panes: every herdr pane on this machine with the shell it runs and its agent's name, so a process
// can be traced to the lane that started it. Read-only: `herdr pane list`, `herdr agent list` (or the lists the
// server's herdr sync already has), and one `herdr pane process-info` per pane, asked once and kept until the shell
// is gone.
import type { Pane, Proc } from "./monitor-types.ts";

const LIST_MS = 60_000;
// After a pane herdr could not name a shell for, it is asked again sooner.
const RETRY_MS = 20_000;
const ASK_MS = 5_000;
// How long the first tick waits for the first list: one asking of a herdr that answers, and no more of one that
// does not.
const FIRST_WAIT_MS = ASK_MS;

async function ask(herdr: string, args: string[]): Promise<{ result: any; cpuMs: number }> {
  const proc = Bun.spawn([herdr, ...args], { stdout: "pipe", stderr: "ignore", timeout: ASK_MS });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  const cpuMs = Number(proc.resourceUsage()?.cpuTime.total ?? 0) / 1000;
  if (code !== 0) throw new Error(`herdr ${args.join(" ")}: exit ${code}`);
  return { result: JSON.parse(out).result, cpuMs };
}

// panes(procs) gives the panes as last listed and does not wait for herdr: asking takes a call per new pane, and a
// herdr that is slow or hangs would hold the tick up for all of them. herdr is asked in the background, one asking
// at a time: once a minute, and at once when a process shows up beside the panes' shells that is not one of them (a
// new pane, whose first minute is often its busiest). What it answers is the next tick's list. Only the very first
// list is waited for, FIRST_WAIT_MS at most, because with no list every lane's processes are nobody's. A pane whose
// shell is gone is asked for its shell again. A herdr that fails or is not there leaves the last list standing, so
// one bad minute does not move every lane's processes to "other".
// lists: the pane list and the agent list someone else already has (the server's own herdr sync asks for both every
// 20 s). The minute's look takes those when they are no older than a minute, and starts no herdr at all; without
// them, or for a new pane, which they may not have yet, herdr is asked here as before.
export type Lists = { at: number; panes: any[]; agents: any[] };
export function createPanes(herdr: string, now: () => number = Date.now, lists?: () => Lists | null) {
  const shells = new Map<string, number>();
  // Children of herdr's server that are not a pane's shell, already seen: each asks for one early refresh, not one
  // a tick.
  const strays = new Set<number>();
  let listed: Pane[] = [];
  let due = -Infinity;
  let cpuMs = 0;
  let asking: Promise<void> | null = null;
  let first = true;

  async function refresh(alive: Set<number>, newPane: boolean) {
    const given = newPane ? null : (lists?.() ?? null);
    const [panes, agents] = given && now() - given.at <= LIST_MS
      ? [{ result: { panes: given.panes }, cpuMs: 0 }, { result: { agents: given.agents }, cpuMs: 0 }]
      : await Promise.all([ask(herdr, ["pane", "list"]), ask(herdr, ["agent", "list"])]);
    cpuMs += panes.cpuMs + agents.cpuMs;
    const lanes = new Map<string, string>();
    for (const a of agents.result?.agents ?? []) if (a.name && a.pane_id) lanes.set(String(a.pane_id), String(a.name));
    const ids: { pane: string; cwd: string | null }[] = (panes.result?.panes ?? []).map((p: any) => ({ pane: String(p.pane_id), cwd: typeof p.cwd === "string" ? p.cwd : null }));
    for (const pane of [...shells.keys()]) if (!ids.some((p) => p.pane === pane)) shells.delete(pane);
    const next: Pane[] = [];
    for (const { pane, cwd } of ids) {
      let shellPid = shells.get(pane);
      if (shellPid === undefined || !alive.has(shellPid)) {
        shells.delete(pane);
        try {
          const info = await ask(herdr, ["pane", "process-info", "--pane", pane]);
          cpuMs += info.cpuMs;
          shellPid = Number(info.result?.process_info?.shell_pid);
        } catch {
          shellPid = NaN;
        }
        if (!Number.isInteger(shellPid) || shellPid <= 1) {
          due = Math.min(due, now() + RETRY_MS);
          continue;
        }
        shells.set(pane, shellPid);
      }
      next.push({ pane, shellPid, lane: lanes.get(pane) ?? null, cwd });
    }
    listed = next;
  }

  function newStray(procs: Proc[]) {
    const known = new Set(shells.values());
    const servers = new Set(procs.filter((p) => known.has(p.pid) && p.ppid > 1).map((p) => p.ppid));
    let found = false;
    for (const p of procs) {
      if (!servers.has(p.ppid) || known.has(p.pid) || strays.has(p.pid)) continue;
      strays.add(p.pid);
      found = true;
    }
    return found;
  }

  return {
    async panes(procs: Proc[]): Promise<Pane[]> {
      const alive = new Set(procs.map((p) => p.pid));
      for (const pid of strays) if (!alive.has(pid)) strays.delete(pid);
      // A stray that shows up during an asking is looked at by the tick after it, so it still gets its own.
      const newPane = !asking && newStray(procs);
      if (!asking && (now() >= due || newPane)) {
        due = now() + LIST_MS;
        asking = refresh(alive, newPane)
          .catch(() => void (due = Math.min(due, now() + RETRY_MS)))
          .finally(() => (asking = null));
      }
      if (first) {
        first = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([asking, new Promise((over) => (timer = setTimeout(over, FIRST_WAIT_MS)))]);
        clearTimeout(timer);
      }
      return listed;
    },
    // Resolves when no asking is under way: what a test waits for before it looks at the next list.
    async settled() {
      await asking;
    },
    // The CPU the herdr calls used since the last time this was asked.
    takeCpuMs() {
      const used = cpuMs;
      cpuMs = 0;
      return used;
    },
  };
}
