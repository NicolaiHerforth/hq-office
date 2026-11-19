// SHIP's little sorter: one model call for a batch of new items gives each a domain (a short label, reused where one
// fits), an urgency and, for URGENT, one line why. It runs HUD_SAMPLE_CMD as the page runtime's sample does
// (page-sample.ts): the prompt on stdin with secrets masked, HUD_SAMPLE_TIER=quick, in an empty folder of its own.
// Nothing waits on it: without the command, or when it fails or answers nonsense, an item's domain is its repo's name
// and its urgency NORMAL.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URGENCIES, type SortAnswer, type Urgency } from "./ship.ts";

export type SortInput = { id: number; repo: string; number: number; title: string; branch: string; body: string; paths: string[] };
export const SORT_LIMITS = { timeoutMs: 120_000, output: 100_000, bodyLines: 8, paths: 40, domain: 32, why: 200 };

export const URGENT_MEANS = "a fix for something broken for users now, security, data loss, or something other work is blocked on";

export function sortPrompt(items: SortInput[], domains: string[]) {
  const pr = (it: SortInput) => {
    const body = it.body.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(0, SORT_LIMITS.bodyLines);
    const paths = it.paths.slice(0, SORT_LIMITS.paths);
    return [
      `### id ${it.id}: ${it.repo}#${it.number}`,
      `title: ${it.title || "(not read yet)"}`,
      `branch: ${it.branch || "(not read yet)"}`,
      body.length ? `body (first lines):\n${body.map((l) => `  ${l}`).join("\n")}` : "body: (none)",
      paths.length ? `changed paths (${it.paths.length}${it.paths.length > paths.length ? `, first ${paths.length}` : ""}):\n${paths.map((p) => `  ${p}`).join("\n")}` : "changed paths: (not read)",
    ].join("\n");
  };
  return `You sort pull requests that agents want merged, for the one person who merges them.

For each PR below give:
- domain: a short lowercase label (at most ${SORT_LIMITS.domain} characters) for the part of the product or system it touches. Reuse a domain already in use whenever one fits; make a new one only when none does.
- urgency: URGENT, NORMAL or LOW. URGENT means ${URGENT_MEANS}. LOW is a chore nobody waits on (docs, a refactor, tooling). Anything else is NORMAL.
- why: for URGENT, one short line saying why it is urgent; otherwise null.

Domains already in use: ${domains.length ? domains.join(", ") : "none yet"}

Answer with ONLY a JSON array, one object per PR, nothing before or after it, like:
[{"id": 1, "domain": "billing", "urgency": "NORMAL", "why": null}]

PRs:

${items.map(pr).join("\n\n")}
`;
}

export const fallback = (it: Pick<SortInput, "id" | "repo">): SortAnswer => ({ id: it.id, domain: it.repo.split("/").pop()!, urgency: "NORMAL", why: null });

// The first JSON array in the text that parses: the model may wrap it in a code fence or a sentence. A bounded number
// of tries, so a long answer full of brackets cannot hold the server.
function firstArray(text: string): unknown[] | null {
  let tries = 0;
  for (let i = text.indexOf("["); i >= 0 && tries < 400; i = text.indexOf("[", i + 1)) {
    for (let j = text.lastIndexOf("]"); j > i && tries++ < 400; j = text.lastIndexOf("]", j - 1)) {
      try {
        const v = JSON.parse(text.slice(i, j + 1));
        if (Array.isArray(v)) return v;
      } catch {}
    }
  }
  return null;
}

// The model's answer for each item, each field checked; an item it left out or answered badly gets the fallback.
export function parseSort(text: string, items: Pick<SortInput, "id" | "repo">[]): SortAnswer[] {
  const got = new Map<number, any>();
  for (const a of firstArray(text) ?? []) if (a && typeof a === "object" && Number.isInteger(Number((a as any).id))) got.set(Number((a as any).id), a);
  return items.map((it) => {
    const a = got.get(it.id);
    const domain = typeof a?.domain === "string" ? a.domain.replace(/\s+/g, " ").trim().toLowerCase().slice(0, SORT_LIMITS.domain).trim() : "";
    if (!domain) return fallback(it);
    const urgency: Urgency = URGENCIES.includes(String(a.urgency).toUpperCase() as Urgency) ? (String(a.urgency).toUpperCase() as Urgency) : "NORMAL";
    const why = urgency === "URGENT" && typeof a.why === "string" && a.why.trim() ? a.why.replace(/\s+/g, " ").trim().slice(0, SORT_LIMITS.why) : null;
    return { id: it.id, domain, urgency, why };
  });
}

// One call for the batch. Never throws: error says why the fallback was used, when it was.
export async function runSort(items: SortInput[], o: { cmd: string; domains: string[]; mask: (s: string) => string; timeoutMs?: number }): Promise<{ answers: SortAnswer[]; error: string | null }> {
  if (!items.length) return { answers: [], error: null };
  if (!o.cmd) return { answers: items.map(fallback), error: null };
  const cwd = mkdtempSync(join(tmpdir(), "hud-ship-sort-"));
  try {
    // In a process group of its own: stopping it (too long, too much) kills the command and everything it started, and
    // stops reading at once, as page-sample.ts does, so a child that still holds the output cannot hold the sorter.
    const proc = Bun.spawn(["sh", "-c", o.cmd], { cwd, detached: true, stdin: new Blob([o.mask(sortPrompt(items, o.domains))]), stdout: "pipe", stderr: "ignore", env: { ...process.env, HUD_SAMPLE_TIER: "quick", HUD_SAMPLE_PAGE: "ship" } });
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      reader.cancel().catch(() => {});
    };
    const ms = o.timeoutMs ?? SORT_LIMITS.timeoutMs;
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop();
    }, ms);
    let out = "", code: number;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
        if (out.length > SORT_LIMITS.output) { stop(); break; }
      }
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (late) return { answers: items.map(fallback), error: `the sorter took longer than ${ms / 1000} s` };
    const answers = parseSort(out, items);
    if (code !== 0 && !firstArray(out)) return { answers: items.map(fallback), error: `the sorter failed (exit ${code})` };
    return { answers, error: firstArray(out) ? null : "the sorter answered no JSON array" };
  } catch (e) {
    return { answers: items.map(fallback), error: `the sorter could not run: ${(e as Error).message}` };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
