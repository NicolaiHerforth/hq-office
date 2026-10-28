#!/usr/bin/env bun
// A Claude Code hook for HQ's session: shows how many messages wait in HQ's queue, so HQ sees the count at every step
// and reads the queue when it chooses. Settings snippet: README, "HQ's queue".
//
// It acts only in a session that says it is a lead's: HUD_LEAD must be set (the settings snippet sets it, README "The
// hook"). Without it the hook prints nothing and exits 0, so a copy in a settings file every lane shares does nothing.
//
// Reads the event from stdin and the open items for $HUD_LEAD from the server at $HUD_URL, then:
//   UserPromptSubmit  plain stdout: Claude Code adds it to the context with the prompt
//   PostToolUse       {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": LINE}}
//   Stop              {"decision": "block", "reason": ...} once; when stop_hook_active is true HQ is already
//                     continuing because of this hook, so it prints nothing and HQ may stop (no loop)
// It prints nothing, and exits 0, when the queue is empty, the server is down, or the event is another one: a hook
// that fails would get in the way of the session it is only there to inform. The fetch is aborted at 150 ms.
const BASE = process.env.HUD_URL ?? "http://127.0.0.1:4747";
const LEAD = (process.env.HUD_LEAD ?? "").trim();
const FETCH_MS = 150;

export function ageText(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// `HQ QUEUE 4 · oldest 12m · 1 URGENT`; null for an empty queue.
export function queueLine(items: { created_at: number; urgent_at: number | null }[], lead = LEAD || "HQ", now = Date.now()) {
  if (!items.length) return null;
  const urgent = items.filter((i) => i.urgent_at).length;
  const oldest = Math.min(...items.map((i) => i.created_at));
  return [`${lead} QUEUE ${items.length}`, `oldest ${ageText(now - oldest)}`, ...(urgent ? [`${urgent} URGENT`] : [])].join(" · ");
}

async function main() {
  if (!LEAD) return;
  const [input, items] = await Promise.all([
    Bun.stdin.text().then((t) => JSON.parse(t || "{}")).catch(() => ({})),
    fetch(`${BASE}/api/requests?lead=${encodeURIComponent(LEAD)}`, { signal: AbortSignal.timeout(FETCH_MS) }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  const line = Array.isArray(items) ? queueLine(items) : null;
  if (!line) return;
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      console.log(line);
      break;
    case "PostToolUse":
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } }));
      break;
    case "Stop":
      if (!input.stop_hook_active) console.log(JSON.stringify({ decision: "block", reason: `${line}. \`hud req next\` to read.` }));
      break;
  }
}

if (import.meta.main) await main().catch(() => {});
