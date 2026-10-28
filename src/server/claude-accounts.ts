// Moving a Claude lane to another account (see claude-home.ts for what an account is). A working lane is refused, so
// no turn is cut off; an idle one exits Claude and starts it again on the other home with --resume, so the
// conversation carries on. A lane showing a dialog is never typed into: a question is filed. If anything goes wrong after /exit, a question
// holds the command that brings the lane back on its own home.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, DIR, HERDR, LOCAL } from "./config.ts";
import { db } from "./db.ts";
import { createAsk } from "./asks.ts";
import { readMachine } from "./accounts.ts";
import { bump } from "./push.ts";
import { DEFAULT, NAME, dialogKind, homeDir, quote, relaunchCommand } from "./claude-home.ts";
import { BG, SUBAGENT } from "./herdr.ts";

// The settings file that gives this process (and no other) a status line recording its account's rate limits.
export function laneSettings(account: string): string {
  const file = join(DATA, `claude-lane-${account}.settings.json`);
  const command = `python3 -I ${quote(join(DIR, "src/server/claude-statusline.py"))} ${quote(account)}`;
  writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }));
  return file;
}

async function herdr(...args: string[]): Promise<string> {
  const proc = Bun.spawn([HERDR, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error((await new Response(proc.stderr).text()).trim().split("\n").pop() || `herdr ${args[0]} ${args[1]} failed`);
  return out;
}

export const laneAccount = (lane: string) => (db.query("SELECT account FROM lane_accounts WHERE lane = ?").get(lane) as { account: string } | null)?.account ?? DEFAULT;

function fileQuestion(lane: string, title: string, body: string, options: string[]) {
  const open = db.query("SELECT 1 FROM asks WHERE lane = ? AND title = ? AND status = 'open'").get(lane, title);
  if (!open) createAsk({ lane, title, body, options });
}

function fileDialogQuestion(lane: string, account: string, kind: "limit" | "prompt") {
  const what = kind === "limit" ? "limit/credits dialog" : "permission prompt";
  fileQuestion(lane, `${lane} shows a ${what}`, `The move to ${account} was not made. HQ Office never types into a ${what}: it is the owner's to answer in the lane's pane. Then move the lane again.`, ["Answered in the pane", "Leave the lane where it is"]);
}

// Claude was told to exit and the lane did not come back as planned: the pane may be at a bare shell. The command is the
// one that starts the lane again on the home it was on.
function fileStrandedQuestion(lane: string, account: string, why: string, command: string) {
  fileQuestion(
    lane,
    `${lane} was exited for a move and is not confirmed back`,
    `The move to ${account} was not recorded: ${why}. If the lane's pane is at a shell, this brings it back on the account it was on:\n\n\`\`\`\n${command}\n\`\`\`\n\nThen name the pane again with \`herdr agent rename <pane> ${lane}\` if HQ Office no longer lists the lane.`,
    ["Brought back", "Leave the lane"],
  );
}

// The agent is back on the new account but a later step failed: the lane is recorded there, and only that step is open.
function fileUnconfirmedQuestion(lane: string, account: string, why: string) {
  fileQuestion(
    lane,
    `${lane} is on ${account} but a step after the move failed`,
    `The lane came back on ${account} and is recorded there. This step failed: ${why}. Check in the lane's pane, and name the pane again with \`herdr agent rename <pane> ${lane}\` if HQ Office no longer lists the lane.`,
    ["Checked", "Leave the lane"],
  );
}

const exited = async (pane: string) => JSON.parse(await herdr("pane", "get", pane)).result?.pane?.agent == null;
const agents = async (): Promise<any[]> => JSON.parse(await herdr("agent", "list")).result.agents;
const moving = new Set<string>();

export async function moveLane(lane: string, account: string): Promise<string> {
  const row = db.query("SELECT * FROM lanes WHERE name = ?").get(lane) as { machine: string | null; agent: string | null; bg: string | null } | null;
  if (!row) throw new Error(`no lane named ${lane}`);
  if (moving.has(lane)) throw new Error(`${lane} is already being moved`);
  moving.add(lane);
  try {
    return await move(lane, account, row);
  } finally {
    moving.delete(lane);
  }
}

async function move(lane: string, account: string, row: { machine: string | null; agent: string | null; bg: string | null }): Promise<string> {
  if (row.machine !== LOCAL) throw new Error("only this machine's lanes can be moved so far");
  if (row.agent !== "claude") throw new Error(`${lane} is not a Claude lane`);
  if (!NAME.test(account)) throw new Error("no such account");

  const stats = await readMachine(LOCAL);
  const target = stats.claude.homes.find((h) => h.name === account);
  if (!target) throw new Error(`no Claude home named ${account}`);
  if (!target.logged_in) throw new Error(`${account} is not logged in. The owner logs in once: CLAUDE_CONFIG_DIR=${homeDir(account)} claude auth login`);
  const from = laneAccount(lane);
  if (from === account) throw new Error(`${lane} already runs on ${account}`);

  const agent = (await agents()).find((a: any) => a.name === lane);
  if (!agent) throw new Error(`herdr has no pane for ${lane}`);
  const pane: string = agent.pane_id;
  const session = agent.agent_session?.value;
  if (typeof session !== "string" || !session) throw new Error(`${lane}'s session id is unknown, so it could not be resumed`);
  // A working turn is never cut off. Idle and done are at a prompt; blocked is a dialog of some kind.
  if (agent.agent_status === "working") throw new Error(`${lane} is working. Move it when it is idle`);
  if (!["idle", "done", "blocked"].includes(agent.agent_status)) throw new Error(`${lane} is ${agent.agent_status}, not idle`);

  const screen = await herdr("pane", "read", pane, "--source", "visible");
  const kind = dialogKind(screen) ?? (agent.agent_status === "blocked" ? "prompt" : null);
  if (kind) {
    fileDialogQuestion(lane, account, kind);
    throw new Error(`${lane} shows a dialog that is the owner's to answer. A question is filed`);
  }
  // /exit would end background shells, monitors and subagents (or ask to confirm), though herdr calls the lane idle.
  const tail = screen.split("\n").filter((l) => l.trim()).slice(-10).join("\n");
  const bg = row.bg || (SUBAGENT.test(tail) ? "a subagent" : tail.match(BG)?.[1]);
  if (bg) throw new Error(`${lane} has background work (${bg}). Move it when that has finished`);

  // Everything that can fail before Claude is told to exit is done first: both launch commands, with their settings files.
  const back = relaunchCommand(from, session, laneSettings(from));
  const forward = relaunchCommand(account, session, laneSettings(account));

  // A prompt may have arrived since the status was read.
  const now = (await agents()).find((a: any) => a.name === lane);
  if (!now || now.pane_id !== pane || now.agent_status === "working" || now.agent_session?.value !== session) throw new Error(`${lane} changed while the move was prepared. Nothing was sent`);

  const record = () => {
    db.query("INSERT INTO lane_accounts (lane, account, moved_at) VALUES (?, ?, ?) ON CONFLICT(lane) DO UPDATE SET account = excluded.account, moved_at = excluded.moved_at").run(lane, account, Date.now());
    bump();
  };
  let recorded = false;
  await herdr("agent", "prompt", lane, "/exit");
  try {
    const deadline = Date.now() + Number(process.env.HUD_MOVE_EXIT_WAIT_MS ?? 30_000);
    while (!(await exited(pane))) {
      if (Date.now() > deadline) throw new Error(`${lane} had not exited after ${Math.round(Number(process.env.HUD_MOVE_EXIT_WAIT_MS ?? 30_000) / 1000)} s (it may still exit)`);
      await Bun.sleep(500);
    }
    await herdr("pane", "run", pane, forward);
    // The agent's name follows the pane's occupant and is cleared on exit: name the new one, or HQ Office loses the lane.
    const backBy = Date.now() + Number(process.env.HUD_MOVE_BACK_WAIT_MS ?? 60_000);
    let resumed: any;
    for (;;) {
      if (!(await exited(pane))) {
        resumed = (await agents()).find((a: any) => a.pane_id === pane);
        if (resumed) break;
      }
      if (Date.now() > backBy) throw new Error(`${lane} did not come back on ${account}`);
      await Bun.sleep(500);
    }
    // The lane runs on the new account from here: record it before any step that can still fail.
    record();
    recorded = true;
    await herdr("agent", "rename", pane, lane);
    // The session id may show a moment after the agent does.
    while (resumed.agent_session?.value !== session) {
      if (resumed.agent_session?.value) throw new Error(`${lane} came back on a different conversation`);
      if (Date.now() > backBy) throw new Error(`${lane} came back, but its conversation is not confirmed to be the same`);
      await Bun.sleep(500);
      resumed = (await agents()).find((a: any) => a.pane_id === pane) ?? resumed;
    }
  } catch (e) {
    const why = (e as Error).message;
    if (recorded) {
      fileUnconfirmedQuestion(lane, account, why);
      throw new Error(`${why}. The lane is recorded on ${account} and a question is filed`);
    }
    fileStrandedQuestion(lane, account, why, back);
    throw new Error(`${why}. The move was not recorded and a question is filed with the command that brings the lane back`);
  }
  return `${lane} moved to ${account}`;
}
