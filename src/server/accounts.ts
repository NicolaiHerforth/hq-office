// Accounts: the Claude and Codex accounts on each machine, what each has left, and grazr's swap. Read once a minute
// with account-stats.py (names and percentages only, never a credential) and kept in memory: the page shows the
// latest reading, and nothing here is history.
import { DIR, HERDR, LOCAL, MACHINES } from "./config.ts";
import { SSH_REUSE, sshTarget } from "./machines.ts";
import { bump } from "./push.ts";
import { addStatePart } from "./state.ts";

export const ACCOUNTS_MS = 60_000;
const SCRIPT = `${DIR}/src/server/account-stats.py`;
// grazr's defaults; Codex has no rotation tool, so its accounts are judged against the same two lines.
const DEFAULT_SESSION = 15;
const DEFAULT_WEEKLY = 10;

type Raw = {
  claude: { grazr: boolean; logged_in: boolean; active_enrolled: boolean; status_line: boolean; log: string[]; config: Record<string, string>; accounts: { name: string; active: boolean; windows: Record<string, { left: number; resets_at: string | null }> }[] };
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

export async function sampleAccounts() {
  for (const machine of MACHINES) {
    try {
      const out = await onMachine(machine, ["python3", "-I", SCRIPT], "python3 -I -", SCRIPT);
      samples.set(machine, { at: Date.now(), raw: JSON.parse(out) });
    } catch (e) {
      samples.set(machine, { at: Date.now(), error: (e as Error).message.slice(0, 200) });
    }
  }
  bump();
}

// grazr's swap: to the first account in its ACCOUNTS with room, with its own lock, log and toast. herdr is not on a
// plain ssh PATH on every machine, so the remote command adds the usual install places.
export async function swapClaude(machine: string): Promise<string> {
  if (!MACHINES.includes(machine)) throw new Error(`no machine named ${machine}`);
  const out = await onMachine(machine, [HERDR, "plugin", "action", "invoke", "wazum.grazr.swap"], `PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH" herdr plugin action invoke wazum.grazr.swap`);
  await sampleAccounts();
  return out.trim().split("\n").filter(Boolean).pop() ?? "";
}

// A reading taken before its window reset says nothing about now: the window is full again.
function window(left: number | undefined, resetsAt: number | null, now: number): Window | null {
  if (left === undefined) return null;
  if (resetsAt !== null && resetsAt <= now) return { left: 100, resetsAt: null };
  return { left: Math.max(0, Math.round(left)), resetsAt };
}
const ms = (t: string | number | null | undefined) => (t == null ? null : typeof t === "number" ? t * 1000 : Date.parse(t) || null);

// What one Claude or Codex account looks like on the page: its two windows and whether it can still be spent.
function judge(session: Window | null, weekly: Window | null, limits: { session: number; weekly: number }) {
  const out = [session, weekly].some((w) => w && w.left <= 0);
  const low = !out && ((session && session.left < limits.session) || (weekly && weekly.left < limits.weekly));
  return { session, weekly, out, low: !!low };
}

export function accountsView(now = Date.now()) {
  return MACHINES.map((machine) => {
    const s = samples.get(machine);
    if (!s?.raw) return { machine, ok: false, error: s?.error ?? "not read yet", age: s ? now - s.at : null, claude: null, codex: [] };
    const { claude: c, codex } = s.raw;
    const limits = { session: Number(c.config.REMAINING_SESSION ?? DEFAULT_SESSION), weekly: Number(c.config.REMAINING_WEEKLY ?? DEFAULT_WEEKLY) };
    const order = (c.config.ACCOUNTS ?? "").split(/\s+/).filter(Boolean);
    const accounts = c.accounts
      .map((a) => ({
        name: a.name,
        active: a.active,
        listed: order.includes(a.name),
        ...judge(window(a.windows.session?.left, ms(a.windows.session?.resets_at), now), window(a.windows.weekly?.left, ms(a.windows.weekly?.resets_at), now), limits),
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || (order.indexOf(a.name) + 1 || 99) - (order.indexOf(b.name) + 1 || 99));
    const rotating = accounts.filter((a) => a.listed).length >= 2;
    const state = !c.grazr ? "no_grazr" : !accounts.length ? "none" : c.config.ENABLED === "0" ? "off" : !rotating ? "one" : c.config.DRY_RUN === "1" ? "dry_run" : "rotating";
    const active = accounts.find((a) => a.active);
    return {
      machine,
      ok: true,
      age: now - s.at,
      claude: {
        state,
        loggedIn: c.logged_in,
        activeEnrolled: c.active_enrolled,
        statusLine: c.status_line,
        limits,
        accounts,
        out: !!active?.out,
        low: !!active?.low,
        canSwap: c.grazr && accounts.some((a) => !a.active && !a.out && !a.low),
        log: c.log,
      },
      codex: codex.map((h) => {
        const by = (minutes: number) => h.reading?.windows.find((w) => w.minutes === minutes);
        const five = by(300), week = by(10080);
        return {
          name: h.name,
          loggedIn: h.logged_in,
          readingAt: ms(h.reading?.at),
          sharesSessionsWith: h.shares_sessions_with,
          ...judge(window(five && 100 - five.used, ms(five?.resets_at), now), window(week && 100 - week.used, ms(week?.resets_at), now), { session: DEFAULT_SESSION, weekly: DEFAULT_WEEKLY }),
        };
      }),
    };
  });
}

addStatePart("accounts", () => accountsView());
sampleAccounts();
setInterval(sampleAccounts, ACCOUNTS_MS);
