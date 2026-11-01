// HQ's Claude Code hook for the HQ QUEUE (src/server/hq-queue.ts), run on UserPromptSubmit, PostToolUse and Stop.
// It asks the HUD what to do with the event and prints only what the HUD answers: the count line as context, a held
// prompt (already stored in the queue), or a Stop that may not happen while something is unread. It fails open: when
// the HUD is down, slow (HUD_QUEUE_HOOK_MS, 1500 ms) or answers anything but a decision, it prints nothing and exits
// 0, so the prompt reaches HQ untouched. It does nothing in any session but a floor's HQ's own (the HUD matches the
// session id herdr reports for it), and nothing while the HQ QUEUE setting is off.
const BASE = process.env.HUD_URL || "http://127.0.0.1:4747";
const WAIT = Number(process.env.HUD_QUEUE_HOOK_MS) || 1500;

async function main() {
  let input: any;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  const body = { event: input.hook_event_name, session_id: input.session_id, prompt: input.prompt, stop_hook_active: input.stop_hook_active };
  const headers: Record<string, string> = { "content-type": "application/json", "x-hud": "1" };
  if (process.env.HERDR_PANE_ID) headers["x-hud-pane"] = process.env.HERDR_PANE_ID;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/queue/hook`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(WAIT) });
  } catch {
    return;
  }
  if (!res.ok) return;
  let d: any;
  try {
    d = await res.json();
  } catch {
    return;
  }
  if (d && typeof d.output === "object" && d.output) process.stdout.write(JSON.stringify(d.output));
  else if (d && typeof d.text === "string" && d.text) process.stdout.write(d.text);
}

await main().catch(() => {});
process.exit(0);
