// THE PAGE RUNTIME's sample: a page asks a model, as an artifact does with claude.use("sample"). Off unless the owner
// sets HUD_SAMPLE_CMD: a command on this machine that reads a prompt on stdin and prints the answer (the README has the
// line for Claude Code). It never goes to a lane's or HQ's session: each call runs the command once, with no memory, in an empty
// folder of its own, with HUD_SAMPLE_TIER (default, quick or complex) and HUD_SAMPLE_PAGE in its environment. The answer
// streams back as it is printed. Secret values are masked in the prompt before the command sees it, and in the answer.
// The HUD asks the owner (ALLOW or NO) before a page's first call in a view (src/client/page-runtime/index.js).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secrets } from "./push.ts";
import { addStatePart } from "./state.ts";
import { PageError } from "./page-runtime.ts";

const CMD = (process.env.HUD_SAMPLE_CMD ?? "").trim();
export const SAMPLE_LIMITS = { promptBytes: 200_000, output: 100_000, timeoutMs: 180_000, running: 2, perPageMinute: 10 };
export const TIERS = ["default", "quick", "complex"];
addStatePart("pageSample", () => !!CMD);

const running = new Set<number>();
const recent = new Map<string, number[]>();
let seq = 0;

const fail = (code: string, message: string) => new PageError(code, message);
function promptOf(input: unknown) {
  if (typeof input === "string") return input;
  const ok = Array.isArray(input) && input.length > 0 && input.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") && input.at(-1).role === "user";
  if (!ok) throw fail("invalid_request", "input is a string, or a list of { role: user | assistant, content } that ends with the user");
  return (input as { role: string; content: string }[]).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
}

// The answer as newline-separated JSON: { text } as it grows (every 100 ms at most), then { text, done, truncated,
// tier }, or { error, code }, with empty lines between while the command is quiet. text is the whole answer so far.
export function sample(page: string, body: { input?: unknown; tier?: unknown }, signal: AbortSignal): Response {
  if (!CMD) throw fail("sampling_disabled", "this HUD asks no model: the owner has not set HUD_SAMPLE_CMD");
  const prompt = secrets.mask(promptOf(body.input));
  if (!prompt.trim()) throw fail("invalid_request", "the prompt is empty");
  if (new TextEncoder().encode(prompt).length > SAMPLE_LIMITS.promptBytes) throw fail("prompt_too_large", `a prompt is at most ${SAMPLE_LIMITS.promptBytes / 1000} KB`);
  const tier = TIERS.includes(String(body.tier)) ? String(body.tier) : "default";
  const now = Date.now();
  const times = (recent.get(page) ?? []).filter((t) => now - t < 60_000);
  if (running.size >= SAMPLE_LIMITS.running || times.length >= SAMPLE_LIMITS.perPageMinute) throw fail("rate_limited", `at most ${SAMPLE_LIMITS.running} at once, and ${SAMPLE_LIMITS.perPageMinute} a minute for a page`);
  recent.set(page, [...times, now]);

  const id = ++seq;
  running.add(id);
  const cwd = mkdtempSync(join(tmpdir(), "hud-sample-"));
  const proc = Bun.spawn(["sh", "-c", CMD], { cwd, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HUD_SAMPLE_TIER: tier, HUD_SAMPLE_PAGE: page } });
  // Stopping (cancelled, too long, timed out) kills the command and stops reading it at once: a child it started may
  // still hold its output open, and must not hold the call's place.
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { proc.kill(); } catch {}
    reader.cancel().catch(() => {});
  };
  const timer = setTimeout(stop, SAMPLE_LIMITS.timeoutMs);
  signal.addEventListener("abort", stop);
  const stderrText = new Response(proc.stderr).text().catch(() => "");
  const stderr = () => Promise.race([stderrText, Bun.sleep(500).then(() => "")]);
  const enc = new TextEncoder();

  // The work runs beside start(), not in it: a stream whose start() has not returned is never told it was cancelled.
  const stream = new ReadableStream({
    start(controller) { void pump(controller); },
    cancel: stop,
  });
  async function pump(controller: ReadableStreamDefaultController) {
    const out = (o: object) => { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
    // An empty line every second while the command is quiet: writing is how a closed connection shows, and the
    // command is stopped when it does. Readers skip empty lines.
    const beat = setInterval(() => { try { controller.enqueue(enc.encode("\n")); } catch { stop(); } }, 1000);
    let raw = "", sentAt = 0, truncated = false;
    try {
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        raw += chunk;
        if (raw.length > SAMPLE_LIMITS.output) { raw = raw.slice(0, SAMPLE_LIMITS.output); truncated = true; stop(); break; }
        if (Date.now() - sentAt >= 100) { sentAt = Date.now(); out({ text: secrets.mask(raw) }); }
      }
      const code = await Promise.race([proc.exited, Bun.sleep(stopped ? 500 : 5000).then(() => -1)]);
      const text = secrets.mask(raw).trim();
      if (signal.aborted) out({ error: "cancelled", code: "cancelled", text });
      else if (code !== 0 && !truncated && !text) out({ error: `the sample command failed (exit ${code}): ${secrets.mask((await stderr()).trim()).slice(-300)}`, code: "upstream_error" });
      else if (!text) out({ error: "the command answered nothing", code: "empty_completion" });
      else out({ text, done: true, truncated, tier });
    } catch (e) {
      out({ error: (e as Error).message, code: "upstream_error" });
    } finally {
      clearInterval(beat);
      clearTimeout(timer);
      running.delete(id);
      rmSync(cwd, { recursive: true, force: true });
      try { controller.close(); } catch {}
    }
  }
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
