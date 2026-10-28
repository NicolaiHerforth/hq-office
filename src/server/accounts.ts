// Accounts: the Claude and Codex accounts on each machine, what each has left, and which lane runs on which. Read once a minute
// with account-stats.py (names and percentages only, never a credential) and kept in memory: the page shows the
// latest reading, and nothing here is history.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, LOCAL, MACHINES } from "./config.ts";
import { db } from "./db.ts";
import { SSH_REUSE, sshTarget } from "./machines.ts";
import { bump } from "./push.ts";
import { MCP_NOTE, homeDir } from "./claude-home.ts";
import { addStatePart } from "./state.ts";

export const ACCOUNTS_MS = 60_000;
const SCRIPT = `${DIR}/src/server/account-stats.py`;
// An account is judged low under these percentages of its 5-hour window or its week.
const LIMITS = { session: 15, weekly: 10 };

type Raw = {
  claude: { homes: { name: string; logged_in: boolean; windows: Record<string, { left: number; resets_at: string | number | null }> }[] };
  codex: { name: string; logged_in: boolean; shares_sessions_with: string[]; reading: { at: string; windows: { minutes: number; used: number; resets_at: number | null }[] } | null }[];
};
type Sample = { at: number; raw?: Raw; error?: string };
export type Window = { left: number; resetsAt: number | null };

const samples = new Map<string, Sample>();

// Runs a command on a machine: here, or over the same kept-open ssh connection the machine sampler uses.
async function onMachine(machine: string, local: string[], remote: string, stdin?: string): Promise<string> {
  const here = machine === LOCAL;
  const args = here ? local : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...SSH_REUSE, await sshTarget(machine), remote];
  const proc = Bun.spawn(args, { stdin: stdin ? Bun.file(stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 20_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error((await new Response(proc.stderr).text()).trim().split("\n").pop() || `exit ${code}`);
  return out;
}

// One fresh reading of a machine's accounts.
export async function readMachine(machine: string): Promise<Raw> {
  return JSON.parse(await onMachine(machine, ["python3", "-I", SCRIPT], "python3 -I -", SCRIPT));
}

export async function sampleAccounts() {
  for (const machine of MACHINES) {
    try {
      samples.set(machine, { at: Date.now(), raw: await readMachine(machine) });
    } catch (e) {
      samples.set(machine, { at: Date.now(), error: (e as Error).message.slice(0, 200) });
    }
  }
  bump();
}

// A reading taken before its window reset says nothing about now: the window is full again.
function window(left: number | undefined, resetsAt: number | null, now: number): Window | null {
  if (left === undefined) return null;
  if (resetsAt !== null && resetsAt <= now) return { left: 100, resetsAt: null };
  return { left: Math.max(0, Math.round(left)), resetsAt };
}
const ms = (t: string | number | null | undefined) => (t == null ? null : typeof t === "number" ? t * 1000 : Date.parse(t) || null);

// What one Claude or Codex account looks like on the page: its two windows and whether it can still be spent.
function judge(session: Window | null, weekly: Window | null) {
  const out = [session, weekly].some((w) => w && w.left <= 0);
  const low = !out && ((session && session.left < LIMITS.session) || (weekly && weekly.left < LIMITS.weekly));
  return { session, weekly, out, low: !!low };
}

// The Claude lanes on a machine and the account each runs on: the one it was last moved to, else the default home.
function claudeLanes(machine: string) {
  const moved = new Map((db.query("SELECT lane, account FROM lane_accounts").all() as { lane: string; account: string }[]).map((r) => [r.lane, r.account]));
  return (db.query("SELECT name, herdr FROM lanes WHERE machine = ? AND agent = 'claude' AND herdr != 'gone' ORDER BY name").all(machine) as { name: string; herdr: string | null }[]).map((l) => ({ name: l.name, status: l.herdr, account: moved.get(l.name) ?? "default" }));
}

// The names of the MCP servers a home was made without a secret for (written by makeHome; names only).
function mcpNeedsSecretIn(account: string): string[] {
  try {
    const names = JSON.parse(readFileSync(join(homeDir(account), MCP_NOTE), "utf8"));
    return Array.isArray(names) ? names.map(String) : [];
  } catch {
    return [];
  }
}

export function accountsView(now = Date.now()) {
  return MACHINES.map((machine) => {
    const s = samples.get(machine);
    if (!s?.raw) return { machine, ok: false, error: s?.error ?? "not read yet", age: s ? now - s.at : null, claude: null, codex: [] };
    const { claude: c, codex } = s.raw;
    const lanes = claudeLanes(machine);
    const accounts = c.homes.map((h) => ({
      name: h.name,
      loggedIn: h.logged_in,
      lanes: lanes.filter((l) => l.account === h.name).map((l) => l.name),
      mcpNeedsSecret: machine === LOCAL ? mcpNeedsSecretIn(h.name) : [],
      ...judge(window(h.windows.session?.left, ms(h.windows.session?.resets_at), now), window(h.windows.weekly?.left, ms(h.windows.weekly?.resets_at), now)),
    }));
    const used = accounts.filter((a) => a.lanes.length);
    return {
      machine,
      ok: true,
      age: now - s.at,
      claude: {
        // Moving is the laptop's so far: the move runs herdr and the relaunch on this machine.
        canMove: machine === LOCAL,
        accounts,
        lanes,
        out: used.some((a) => a.out),
        low: used.some((a) => a.low),
      },
      codex: codex.map((h) => {
        const by = (minutes: number) => h.reading?.windows.find((w) => w.minutes === minutes);
        const five = by(300), week = by(10080);
        return {
          name: h.name,
          loggedIn: h.logged_in,
          readingAt: ms(h.reading?.at),
          sharesSessionsWith: h.shares_sessions_with,
          ...judge(window(five && 100 - five.used, ms(five?.resets_at), now), window(week && 100 - week.used, ms(week?.resets_at), now)),
        };
      }),
    };
  });
}

addStatePart("accounts", () => accountsView());
sampleAccounts();
setInterval(sampleAccounts, ACCOUNTS_MS);
