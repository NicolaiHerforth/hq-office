// PERMITS: what a lane's hook (bin/lane-hook.ts) sent the HUD, and the owner's "allow this once". A lane never waits on
// a permission prompt: its hook asks here, and the answer is no unless the owner tapped "Allow this once" on the HUD
// for that exact request within the last hour. Then it is yes, one time.
//
// "This exact request" is the key: the lane, the tool, the folder and the tool's input without its labels, as
// canonical JSON, hashed. Not the whole input: the model writes a new `description` for a Bash call on every try, and
// a new `prompt` for a fetch (docs/lane-permits.md has the trial). What the card shows the owner is what the key
// covers, so his yes cannot land on anything he did not read.
//
// An allow is used at exactly one of the hook's two doors, and which one is the row's kind. A request that was
// stopped by a prompt ('prompt') is let through where the prompt comes again, at PermissionRequest. One the auto-mode
// classifier blocked ('classifier') never reaches a prompt, so it is let through before the classifier, at
// PreToolUse. When an allowed 'prompt' request is blocked by the classifier on its retry instead (auto mode's
// fallback prompt comes and goes), the row turns 'classifier' and the lane is told it may retry. No allow passes
// both doors, so no second call can ride on the first.
//
// createPermits runs on a database and a clock, so a test runs it in memory and moves the clock. The server's one
// instance, with its events, its question and its marker file, is lane-permits.ts.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type Kind = "prompt" | "classifier" | "stuck";
export type Status = "refused" | "allowed" | "used" | "expired";
export type Row = {
  id: number; floor: string | null; lane: string | null; at: number; kind: Kind; tool: string | null; input: string | null;
  key: string | null; mode: string | null; cwd: string | null; reason: string | null; tries: number; status: Status;
  ask: number | null; said: string | null; allowed_at: number | null; used_at: number | null;
};
export type Request = { floor: string | null; lane: string | null; kind: Kind; tool?: unknown; input?: unknown; mode?: unknown; cwd?: unknown; reason?: unknown };

// The owner's tap is good for this long, and a refused request met again within it is the same row.
export const ALLOW_MS = 3600_000;
// A tool input longer than this is not kept, and so can never be shown or allowed.
export const MAX_INPUT = 100_000;

export const TITLE = "Allow this once?";
export const ALLOW = "Allow this once";
export const NO = "No";

// ---- the key ----

// What a call does: its input without the fields that are only labels. Bash: the model's description of the command,
// and how long it may take. WebFetch and Artifact: the prompt, which is what to say about the page. Any other
// built-in tool: its description, so an Agent call keeps its prompt, which is what it does. An MCP tool: nothing is
// left out, since nobody here knows which of its fields are labels. Everything else counts, also a field this file
// has never heard of: a Bash call that asks to leave the sandbox is not the same call as one that does not.
const LABELS: Record<string, string[]> = { Bash: ["description", "timeout"], WebFetch: ["prompt"], Artifact: ["prompt"] };
// A Bash flag that is off is the same as one that is not there.
const BASH_FLAGS: Record<string, string> = { dangerouslyDisableSandbox: "outside the sandbox", run_in_background: "in the background" };
export function identityOf(tool: string, input: unknown): Record<string, unknown> {
  // An input that is not an object of fields says nothing a card could show (cannotAllow).
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const labels = tool.startsWith("mcp__") ? [] : LABELS[tool] ?? ["description"];
  return Object.fromEntries(Object.entries(input).filter(([k, v]) => !labels.includes(k) && !(tool === "Bash" && k in BASH_FLAGS && !v)));
}

// JSON with every object's keys in order, so the same input always hashes the same.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

export function keyOf(lane: string | null, tool: string, input: unknown, cwd: string | null) {
  return createHash("sha256").update(canonical({ lane, tool, cwd, input: identityOf(tool, input) })).digest("hex");
}

// Every string in a value through `mask`, keys too: before JSON, where a quote in a secret would be written \" and
// no longer match. A number that is a held value (a PIN) becomes the masked text.
function masked(v: unknown, mask: (s: string) => string): unknown {
  if (typeof v === "string") return mask(v);
  if (typeof v === "number" || typeof v === "bigint") return mask(String(v)) === String(v) ? v : mask(String(v));
  if (Array.isArray(v)) return v.map((x) => masked(x, mask));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [mask(k), masked(x, mask)]));
  return v;
}

// ---- what a row says ----

const parsed = (p: Pick<Row, "input">): unknown => {
  try { return p.input === null ? null : JSON.parse(p.input); } catch { return null; }
};
// What the key covers besides the one thing in the box: for Bash, how the command is run ("outside the sandbox").
function alsoOf(p: Pick<Row, "tool" | "input">): string[] {
  if (p.tool !== "Bash" || p.input === null) return [];
  return Object.entries(identityOf("Bash", parsed(p))).filter(([k]) => k !== "command").map(([k, v]) => BASH_FLAGS[k] ?? `with ${k} ${JSON.stringify(v)}`);
}
// The request in its own words: the command, the address, or every field the key covers as JSON.
export function whatOf(p: Pick<Row, "tool" | "input">): string {
  if (!p.tool || p.input === null) return "";
  const id = identityOf(p.tool, parsed(p)), keys = Object.keys(id);
  // A command with no command, or a fetch with no address, is nothing to show.
  if (p.tool === "Bash") return typeof id.command === "string" ? id.command : "";
  if (p.tool === "WebFetch" && typeof id.url !== "string") return "";
  if (p.tool === "WebFetch" && keys.length === 1) return id.url as string;
  return keys.length ? JSON.stringify(id, null, 2) : "";
}
const chars = (s: string) => [...s];
export const oneLine = (s: string, n = Infinity) => {
  const t = s.replace(/\s+/g, " ").trim();
  return chars(t).length > n ? `${chars(t).slice(0, n - 1).join("")}…` : t;
};
// "Bash: rm -rf build/*/*", for a list or the log.
export const shortOf = (p: Pick<Row, "tool" | "input" | "kind" | "reason">, n = 120) =>
  p.kind === "stuck" ? oneLine(`a prompt the hook did not answer${p.reason ? `: ${p.reason}` : ""}`, n) : oneLine(`${p.tool ?? "?"}${alsoOf(p).map((a) => ` (${a})`).join("")}: ${whatOf(p) || "(nothing to show)"}`, n);

// Reading a page on claude.ai (an Artifact read, or a fetch of it): Claude Code throws away a hook's allow for a page
// made outside the organization (the trial), so an allow for one would be a yes that does nothing. Publishing to
// claude.ai is not reading it.
function readsClaudePage(p: Pick<Row, "tool" | "input">) {
  const id = p.tool ? identityOf(p.tool, parsed(p)) : {};
  if (p.tool === "Artifact") return id.action === "read";
  if (p.tool !== "WebFetch") return false;
  try {
    const host = new URL(String(id.url ?? "")).hostname.toLowerCase();
    return host === "claude.ai" || host.endsWith(".claude.ai");
  } catch {
    return false;
  }
}
// Why this request can never be allowed from the HUD, or null when it can.
export function cannotAllow(p: Row): string | null {
  if (p.kind === "stuck") return "it is a prompt the hook never got to answer, so there is no request to allow; restarting the lane drops the call";
  if (!p.key || p.input === null) return "its input was not kept, so it cannot be shown";
  if (!whatOf(p).trim()) return "its input says nothing a card could show";
  if (readsClaudePage(p)) return "Claude Code throws away a hook's allow for reading a page on claude.ai made outside the organization; send the lane the page as a file";
  return null;
}

// Text as a code block, verbatim: a fence longer than any run of backticks in it (as core/markdown.js fence).
function fence(text: string) {
  const run = (text.match(/`+/g) ?? []).reduce((most, r) => Math.max(most, r.length), 2);
  const f = "`".repeat(run + 1);
  return `${f}\n${text}\n${f}`;
}
const code = (s: string) => (s.includes("`") || s.includes("\n") ? `\n\n${fence(s)}\n\n` : `\`${s}\``);
const MODE: Record<string, string> = { default: "manual", auto: "auto" };

// The question's body: the request as recorded and nothing else. Everything the key covers is in it: the lane, the
// tool, the folder, how a command is run, and the command (or the input) in the code box it ends with, which the card
// never cuts or folds behind MORE (core/markdown.js). It also says when it was auto mode's own check that stopped the
// call, since a yes then lets it past that check. The row keeps the body as raised (said), so the server can tell
// later whether the card still says it. HQ's --why is not in it: it is a comment under the question
// (lane-permits.ts), marked as HQ's.
export function askBody(p: Row) {
  const does = p.tool === "Bash" ? "run this command" : p.tool === "WebFetch" ? "fetch this address" : "use this tool with this input";
  const how = alsoOf(p).map((a) => `, **${a}**`).join("");
  const blocked = p.kind === "classifier" ? ` Auto mode's safety check blocked it${p.reason ? ` (${oneLine(p.reason, 200)})` : ""}.` : "";
  return `**${p.lane}** wants to ${does} (${p.tool})${how} in ${code(p.cwd ?? "an unknown folder")}${p.mode ? `, ${MODE[p.mode] ?? p.mode} mode` : ""}.${blocked} Permit #${p.id}, as its hook recorded it:\n\n${fence(whatOf(p))}`;
}

const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const age = (ms: number) => (ms < 60_000 ? "now" : ms < 3600_000 ? `${Math.round(ms / 60_000)}m ago` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h ago` : `${Math.round(ms / 86_400_000)}d ago`);

// ---- the book ----

export function createPermits(deps: { db: Database; now?: () => number; mask?: (s: string) => string }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const mask = deps.mask ?? ((s: string) => s);
  const text = (v: unknown) => (v === undefined || v === null || v === "" ? null : mask(String(v)));

  const row = (id: number) => db.query("SELECT * FROM permits WHERE id = ?").get(id) as Row | null;

  // What is stored of a request, and its key: both from the masked input, so no held secret reaches the table, not
  // even as a hash of it.
  function shape(r: Request) {
    const tool = text(r.tool), cwd = text(r.cwd);
    let input: string | null = r.kind === "stuck" || r.input === undefined ? null : JSON.stringify(masked(r.input, mask));
    let reason = text(r.reason);
    if (input !== null && input.length > MAX_INPUT) {
      reason = [reason, `its input was too long to keep (${input.length} characters)`].filter(Boolean).join("; ");
      input = null;
    }
    const key = tool && input !== null ? keyOf(r.lane, tool, JSON.parse(input), cwd) : null;
    return { tool, cwd, input, reason, key, mode: text(r.mode) };
  }

  // A request the hook was refused (or a block, or a stuck prompt): a row. The same exact request met again while
  // its refusal is fresh is the same row, so a lane that tries again keeps its permit number and HQ asks once.
  function seen(r: Request): Row {
    const s = shape(r), t = now();
    const same = s.key ? (db.query("SELECT id FROM permits WHERE lane IS ? AND key = ? AND status = 'refused' AND at > ? ORDER BY id DESC LIMIT 1").get(r.lane, s.key, t - ALLOW_MS) as { id: number } | null) : null;
    if (same) {
      db.query("UPDATE permits SET at = ?, tries = tries + 1, kind = ?, reason = ? WHERE id = ?").run(t, r.kind, s.reason, same.id);
      return row(same.id)!;
    }
    const { lastInsertRowid } = db
      .query("INSERT INTO permits (floor, lane, at, kind, tool, input, key, mode, cwd, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.floor, r.lane, t, r.kind, s.tool, s.input, s.key, s.mode, s.cwd, s.reason);
    return row(Number(lastInsertRowid))!;
  }

  // The owner's unused, unexpired allow for this exact request, if there is one.
  const allowedFor = (lane: string | null, key: string | null, more = "") =>
    lane && key ? (db.query(`SELECT * FROM permits WHERE lane = ? AND key = ? AND status = 'allowed' AND allowed_at > ?${more} ORDER BY id LIMIT 1`).get(lane, key, now() - ALLOW_MS) as Row | null) : null;

  // Uses the allow for this exact request, if the owner gave one: the row, or null. The PreToolUse door takes only a
  // request the classifier blocked; the PermissionRequest door takes whatever is allowed. An allow is used once: the
  // read and the write are one transaction, with no await, so of two calls at once one wins.
  function take(r: Request, door: "pre" | "prompt"): Row | null {
    const { key } = shape(r);
    return db.transaction(() => {
      const hit = allowedFor(r.lane, key, door === "pre" ? " AND kind = 'classifier'" : "");
      if (!hit) return null;
      db.query("UPDATE permits SET status = 'used', used_at = ? WHERE id = ?").run(now(), hit.id);
      return row(hit.id)!;
    })();
  }

  // The classifier blocked a call. If the owner has allowed this exact request, the allow now waits at the PreToolUse
  // door (the row turns 'classifier'), and `retry` says the lane may try again: that try is let through. Otherwise
  // it is a refused request like any other.
  function blocked(r: Request): { row: Row; retry: boolean } {
    const s = shape(r);
    const hit = allowedFor(r.lane, s.key);
    if (!hit) return { row: seen({ ...r, kind: "classifier" }), retry: false };
    db.query("UPDATE permits SET kind = 'classifier', reason = ?, tries = tries + 1 WHERE id = ?").run(s.reason, hit.id);
    return { row: row(hit.id)!, retry: true };
  }

  // The owner's yes for one row. Only a refused or expired one: an allowed one is already his, a used one is spent.
  function allow(id: number): Row {
    const p = row(id);
    if (!p) throw new Error(`no permit ${id}`);
    if (p.status !== "refused" && p.status !== "expired") throw new Error(`permit #${id} is already ${p.status}`);
    db.query("UPDATE permits SET status = 'allowed', allowed_at = ?, used_at = NULL WHERE id = ?").run(now(), id);
    return row(id)!;
  }

  // An allow nobody used within the hour is gone. Returns how many went.
  const expire = () => db.query("UPDATE permits SET status = 'expired' WHERE status = 'allowed' AND allowed_at <= ?").run(now() - ALLOW_MS).changes;

  return {
    seen,
    take,
    blocked,
    allow,
    expire,
    row,
    // Whether any allow is waiting to be used: the hook's PreToolUse door asks the HUD only while one is.
    open: () => !!db.query("SELECT 1 FROM permits WHERE status = 'allowed' AND allowed_at > ?").get(now() - ALLOW_MS),
    byAsk: (ask: number) => db.query("SELECT * FROM permits WHERE ask = ? ORDER BY id DESC LIMIT 1").get(ask) as Row | null,
    // The question raised for a row, and its body as the owner is shown it.
    setAsk: (id: number, ask: number, said: string) => { db.query("UPDATE permits SET ask = ?, said = ? WHERE id = ?").run(ask, said, id); },
    // Recent requests, newest first.
    list(limit = 200): Row[] {
      expire();
      return db.query("SELECT * FROM permits ORDER BY at DESC, id DESC LIMIT ?").all(limit) as Row[];
    },
    // hud permit list: one line per request.
    line(p: Row, askStatus?: string | null) {
      const state = p.status === "refused" && p.ask && askStatus === "open" ? `refused, waiting on the owner (ask #${p.ask})` : p.status;
      return `#${p.id}  ${age(now() - p.at)}  ${p.lane ?? "(not a lane)"}  ${p.kind}  ${state}${p.tries > 1 ? `  ${p.tries} tries` : ""}  ${shortOf(p)}`;
    },
    // hud permit show ID: the whole row, the input as it was recorded.
    show(p: Row, askStatus?: string | null) {
      const no = cannotAllow(p);
      return [
        `permit #${p.id}: ${p.status}${p.status === "allowed" && p.allowed_at ? `, until ${hhmm(p.allowed_at + ALLOW_MS)}` : ""}${p.used_at ? `, used at ${hhmm(p.used_at)}` : ""}`,
        `lane    ${p.lane ?? "(not a registered lane)"}${p.floor ? `  (floor ${p.floor})` : ""}`,
        `kind    ${p.kind}${p.reason ? `: ${p.reason}` : ""}`,
        `when    ${hhmm(p.at)} (${age(now() - p.at)})${p.tries > 1 ? `, ${p.tries} tries` : ""}`,
        `folder  ${p.cwd ?? "-"}`,
        `mode    ${p.mode ? MODE[p.mode] ?? p.mode : "-"}`,
        `tool    ${p.tool ?? "-"}`,
        ...(p.input !== null ? [`request (what an allow covers${alsoOf(p).length ? `; run ${alsoOf(p).join(", ")}` : ""}):`, whatOf(p), "input as recorded:", p.input] : []),
        ...(p.ask ? [`ask     #${p.ask}${askStatus ? ` (${askStatus})` : ""}`] : []),
        ...(no ? [`cannot be allowed: ${no}`] : p.status === "refused" || p.status === "expired" ? (askStatus === "open" ? [] : [`to ask the owner: hud permit ask ${p.id} [--why TEXT]`]) : []),
      ].join("\n");
    },
  };
}
export type Permits = ReturnType<typeof createPermits>;
