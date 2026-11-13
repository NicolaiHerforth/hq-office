// A lane's Claude Code hook (the lane settings file wires it: src/server/lane-settings.ts). It answers every
// permission prompt in a lane through the HUD, so a lane never waits on a prompt nobody will press, and the owner's
// tap on the HUD can allow one exact request once (src/server/permits.ts). Run as: lane-hook.ts EVENT, with the
// hook's JSON on stdin. It does nothing unless HUD_LANE_HOOK=1, which only the lane settings file sets.
//
//   PermissionRequest  asks the HUD and prints its decision: allow, or deny with the HUD's message. HUD down, slow
//                      (HUD_LANE_HOOK_MS, 2 s) or anything else wrong: deny. It never ends without a decision,
//                      because no decision leaves a prompt in a pane nobody watches.
//   PreToolUse         asks the HUD whether the owner allowed this exact call, which auto mode's classifier blocked;
//                      prints allow if so, else nothing (the normal flow). The settings file runs it only while an
//                      allow waits to be used.
//   PermissionDenied   tells the HUD (an auto-mode classifier block). Nothing to decide; if the owner has allowed
//                      this exact call, it prints that the lane may retry, and the retry passes at PreToolUse.
//   Notification       permission_prompt only: tells the HUD this lane shows a prompt the hook did not answer.
//
// No imports at all: it starts fast, and the server runs lanes on a copy of this file in its data folder
// (lane-settings.ts), where a plugin update cannot move it from under a running lane.
const BASE = process.env.HUD_URL ?? "http://127.0.0.1:4747";
// At most 3 s: the settings file gives a hook 10 s, and reading stdin, asking and the last resort below must fit.
const WAIT = Math.min(Number(process.env.HUD_LANE_HOOK_MS) || 2000, 3000);
const UNASKED = "the HUD could not be asked; nobody answers prompts in this pane; do it another way, or tell HQ what you need";

const print = (o: unknown) => process.stdout.write(JSON.stringify(o));
const deny = (message: string) => print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } });
const allow = () => print({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
const preAllow = (permit: unknown) => print({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: `the owner allowed this exact call once on the HUD${permit ? ` (permit #${permit})` : ""}` } });

// The hook's input, or null when stdin is not JSON or never ends.
async function stdin(): Promise<any> {
  try {
    const text = await Promise.race([Bun.stdin.text(), Bun.sleep(WAIT).then(() => null)]);
    const v = text === null ? null : JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

// Who is calling, as hud says it (floors.ts callerOf): the pane, the machine, the folder, and the session's id.
function who(input: any): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "x-hud": "1" };
  if (process.env.HERDR_PANE_ID) h["x-hud-pane"] = process.env.HERDR_PANE_ID;
  if (process.env.HUD_LOCAL_MACHINE) h["x-hud-machine"] = process.env.HUD_LOCAL_MACHINE;
  h["x-hud-cwd"] = encodeURIComponent(process.cwd());
  if (typeof input?.session_id === "string" && /^[A-Za-z0-9._:-]{8,100}$/.test(input.session_id)) h["x-hud-session"] = input.session_id;
  return h;
}

async function ask(event: string, input: any): Promise<any> {
  const body = { event, tool: input?.tool_name, input: input?.tool_input, mode: input?.permission_mode, cwd: input?.cwd, reason: input?.reason, message: input?.message, type: input?.notification_type };
  const res = await fetch(`${BASE}/api/permits/hook`, { method: "POST", headers: who(input), body: JSON.stringify(body), signal: AbortSignal.timeout(WAIT) });
  if (!res.ok) throw new Error(`the HUD answered ${res.status}`);
  return res.json();
}

async function main() {
  if (process.env.HUD_LANE_HOOK !== "1") return;
  const named = process.argv[2];
  const input = await stdin();
  const event = named || input?.hook_event_name;
  if (event === "PermissionRequest") {
    // Whatever happens below, a decision is printed: once, and within about twice the wait.
    let done = false;
    const decide = (say: () => void) => { if (!done) { done = true; say(); } };
    const late = setTimeout(() => { decide(() => deny(UNASKED)); process.exit(0); }, WAIT + 1500);
    try {
      if (!input) throw new Error("no input");
      const d = await ask(event, input);
      if (d?.decision === "allow") decide(allow);
      else if (d?.decision === "deny" && typeof d.message === "string" && d.message) decide(() => deny(d.message));
      else throw new Error("no decision");
    } catch {
      decide(() => deny(UNASKED));
    }
    clearTimeout(late);
    return;
  }
  if (!input) return;
  if (event === "PreToolUse") {
    const d = await ask(event, input).catch(() => null);
    if (d?.decision === "allow") preAllow(d.permit);
  } else if (event === "PermissionDenied") {
    const d = await ask(event, input).catch(() => null);
    if (d?.retry === true) print({ hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true } });
  } else if (event === "Notification" && input.notification_type === "permission_prompt") {
    await ask(event, input).catch(() => null);
  }
}

await main().catch(() => {});
process.exit(0);
