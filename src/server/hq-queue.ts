// THE HQ QUEUE (the HQ QUEUE setting, off by default; off is exactly the HUD without it). When it is on, what lanes and
// the owner send a floor's HQ waits in a queue instead of interrupting HQ mid-turn:
// - a message a lane types into HQ's pane (herdr agent prompt, as lanes do today) is held by HQ's own hook
//   (bin/hq-queue-hook.ts, UserPromptSubmit) and filed here; lanes change nothing. Held only once it is stored: the
//   hook lets the message through untouched when this server is down, slow or answers anything else (fail open);
// - hud request TEXT files one by hand; the owner's Tell HQ notes are filed here too (URGENT on Tell HQ types them in);
// - a message that starts with URGENT goes straight to HQ, as before (main is red, production is affected, or the
//   owner is waiting on it).
// HQ sees the count on every prompt and tool call (the hook adds the line), cannot stop while something is unread (the
// Stop hook), and is prompted when it sits idle with unread items (kick, after each sync, for any agent kind). HQ
// reads the next item with hud req next; a lane's item stays open until HQ answers it (hud req answer: typed into the
// lane's pane) or closes it (hud req close), so a lane waiting for a go never waits unseen.
import { OWNER, HERDR, LOCAL } from "./config.ts";
import { db } from "./db.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { getSettings } from "./settings.ts";
import { postUpdate } from "./updates.ts";
import { live, promptAgent } from "./herdr.ts";
import { agentOfSession, floorList, floorOf, floorOfHq, floorOr, hasSession, hqOf } from "./floors.ts";
import { hqLink, hqNowOf } from "./hq-link.ts";
import { installed as hookInstalled } from "../../bin/queue-hook.ts";

export type Item = { id: number; floor: string; at: number; from_name: string; text: string; via: string; ref: string | null; urgent: number; read_at: number | null; answered_at: number | null; answer: string | null; closed_at: number | null; closed_why: string | null };
const MAX_TEXT = 50_000;
const KICK_EVERY = Number(process.env.HUD_QUEUE_KICK_MS) || 5 * 60_000;
const CLEAR_AFTER = Number(process.env.HUD_QUEUE_CLEAR_MS) || 400;

export const queueOn = () => getSettings().hqQueue === true;
const OPEN = "closed_at IS NULL AND answered_at IS NULL";

export function fileItem(o: { floor: string; from: string; text: string; via: string; ref?: string | null; urgent?: boolean; read?: boolean }) {
  const text = String(o.text ?? "").trim();
  if (!text) throw new Error("an empty message has nothing to queue");
  if (text.length > MAX_TEXT) throw new Error(`a queued message is at most ${MAX_TEXT.toLocaleString("en")} characters`);
  const now = Date.now();
  const id = Number(db.query("INSERT INTO hq_queue (floor, at, from_name, text, via, ref, urgent, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(floorOr(o.floor), now, o.from, text, o.via, o.ref ?? null, o.urgent ? 1 : 0, o.read ? now : null).lastInsertRowid);
  event(o.from === "owner" ? OWNER : o.from, `queued for HQ #${id}${o.urgent ? " URGENT" : ""}: ${text.slice(0, 120)}`, null, floorOr(o.floor));
  return id;
}

const itemOf = (id: number) => db.query("SELECT * FROM hq_queue WHERE id = ?").get(id) as Item | null;
function mustItem(id: number, floor?: string | null) {
  const it = itemOf(id);
  if (!it) throw new Error(`no queue item #${id}`);
  if (floor && it.floor !== floor) throw new Error(`queue item #${id} is on floor ${it.floor}, not yours (${floor})`);
  return it;
}
const fromLane = (it: Item) => it.from_name !== "owner" && it.from_name !== "unknown";
const firstWords = (s: string, n = 70) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const age = (ms: number) => (ms < 60_000 ? "now" : ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86_400_000)}d`);
const who = (it: Item) => (it.from_name === "owner" ? OWNER : it.from_name);

// HQ reads the next item: the oldest unread on its floor. Read, a lane's item stays open until answered or closed;
// the owner's note counts as delivered (and acked once answered or closed).
export function nextItem(floor: string) {
  const it = db.query(`SELECT * FROM hq_queue WHERE floor = ? AND read_at IS NULL AND ${OPEN} ORDER BY urgent DESC, at, id LIMIT 1`).get(floor) as Item | null;
  if (!it) return null;
  db.query("UPDATE hq_queue SET read_at = ? WHERE id = ?").run(Date.now(), it.id);
  return { ...it, read_at: Date.now(), left: counts(floor).unread };
}
export function listItems(floor: string | null, all = false) {
  return db.query(`SELECT * FROM hq_queue WHERE ${floor ? "floor = ? AND " : ""}${all ? "1" : OPEN} ORDER BY at DESC, id DESC LIMIT 200`).all(...(floor ? [floor] : [])) as Item[];
}

// An answer: to a lane, typed into its pane; to the owner's note, an update from HQ ("Re: ..."), as hud tell is.
export async function answerItem(id: number, text: string, floor?: string | null) {
  const it = mustItem(id, floor);
  const answer = String(text ?? "").trim();
  if (!answer) throw new Error("say what the answer is: hud req answer ID TEXT");
  if (it.answered_at || it.closed_at) throw new Error(`queue item #${id} is already ${it.answered_at ? "answered" : "closed"}`);
  if (fromLane(it)) {
    const machine = (db.query("SELECT machine FROM lanes WHERE name = ?").get(it.from_name) as { machine: string | null } | null)?.machine ?? live.find((a) => a.name === it.from_name)?.machine ?? null;
    const r = await promptAgent(it.from_name, `HQ answered your message #${id} ("${firstWords(it.text, 60)}"): ${answer}`, machine);
    if (!r.ok) throw new Error(`could not reach ${it.from_name} in herdr (${r.error}); the item stays open. Answer it another way and close it: hud req close ${id} WHY`);
  } else if (it.from_name === "owner") {
    postUpdate({ title: `Re: ${firstWords(it.text, 80)}`, body: answer }, it.floor);
  }
  db.query("UPDATE hq_queue SET answered_at = ?, answer = ?, read_at = COALESCE(read_at, ?) WHERE id = ?").run(Date.now(), answer, Date.now(), id);
  if (it.ref?.startsWith("note:")) db.query("UPDATE notes SET acked_at = COALESCE(acked_at, ?) WHERE id = ?").run(Date.now(), Number(it.ref.slice(5)));
  return { id, to: who(it) };
}
export function closeItem(id: number, why: string, floor?: string | null) {
  const it = mustItem(id, floor);
  if (it.answered_at || it.closed_at) throw new Error(`queue item #${id} is already ${it.answered_at ? "answered" : "closed"}`);
  db.query("UPDATE hq_queue SET closed_at = ?, closed_why = ?, read_at = COALESCE(read_at, ?) WHERE id = ?").run(Date.now(), String(why ?? "").trim() || "closed with no reply", Date.now(), id);
  if (it.ref?.startsWith("note:")) db.query("UPDATE notes SET acked_at = COALESCE(acked_at, ?) WHERE id = ?").run(Date.now(), Number(it.ref.slice(5)));
  return { id };
}

export function counts(floor: string) {
  const unread = db.query(`SELECT * FROM hq_queue WHERE floor = ? AND read_at IS NULL AND ${OPEN} ORDER BY at`).all(floor) as Item[];
  const waiting = db.query(`SELECT * FROM hq_queue WHERE floor = ? AND read_at IS NOT NULL AND ${OPEN} AND from_name NOT IN ('owner', 'unknown') ORDER BY at`).all(floor) as Item[];
  return { unread: unread.length, unreadItems: unread, waiting };
}
// The one line HQ sees on every prompt and tool call: what is unread, and what a lane is still waiting on HQ for.
export function queueLine(floor: string, now = Date.now()): string | null {
  const c = counts(floor);
  if (!c.unread && !c.waiting.length) return null;
  const parts: string[] = [];
  if (c.unread) {
    const o = c.unreadItems[0];
    parts.push(`${c.unread} unread (oldest ${age(now - o.at)}, from ${who(o)})`);
  }
  if (c.waiting.length) parts.push(`waiting for your answer: ${c.waiting.slice(0, 3).map((w) => `#${w.id} ${who(w)}, ${age(now - w.at)} ("${firstWords(w.text, 40)}")`).join("; ")}${c.waiting.length > 3 ? `; +${c.waiting.length - 3} more` : ""}`);
  return `HQ QUEUE: ${parts.join(" · ")}. ${c.unread ? "Read the next: hud req next." : "Answer: hud req answer ID TEXT, or hud req close ID WHY."}`;
}

// Who typed a held message: the "name:" it starts with, when that is a lane or an agent herdr knows; else unknown.
function senderOf(text: string) {
  const m = text.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]{1,59})\s*:\s/);
  if (!m) return "unknown";
  const name = m[1];
  const known = db.query("SELECT 1 FROM lanes WHERE name = ?").get(name) || live.some((a) => a.name === name);
  return known ? name : "unknown";
}

// Claude Code hands the hook a long message as a paste, <pasted_content id="X">TEXT</pasted_content id="X">, and shows
// it in the input box as a "[Pasted text #N]" token. The message is TEXT.
const PASTE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;
const typed = (prompt: string) => prompt.replace(PASTE, "$2").trim();
// The HUD's own messages, Claude Code's own (a background task's end), commands, URGENT and empty prompts go straight
// in; anything else waits in the queue.
const straightIn = (p: string) => !p || /^HUD[\s:]/.test(p) || /^<task-notification>/.test(p) || /^\//.test(p) || /^URGENT\b/i.test(p);

// What HQ's input box holds, read from its pane: "" when empty (or only the dim startup placeholder), null when no
// Claude Code box is seen. The box is the last "❯" line between two rules; the lines under it until the second rule
// are its wrapped text. Read 200 lines: a long box pushes its first line out of a short read.
const RULE = /^─{8,}$/;
async function hqBox(floor: string): Promise<string | null> {
  const pane = floorOf(floor)?.hq_pane;
  if (!pane) return null;
  try {
    const read = Bun.spawn([HERDR, "pane", "read", pane, "--lines", "200", "--format", "ansi"], { stdout: "pipe", stderr: "ignore" });
    const raw = (await new Response(read.stdout).text()).split("\n").map((l) => l.replace(/\r$/, ""));
    const plain = raw.map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd());
    for (let i = plain.length - 1; i > 0; i--) {
      if (!plain[i].startsWith("❯") || !RULE.test(plain[i - 1])) continue;
      const end = plain.findIndex((l, j) => j > i && RULE.test(l));
      if (end < 0) return null;
      if (/^❯\s*(\x1b\[[0-9;]*m)*\x1b\[2m/.test(raw[i])) return "";
      return [plain[i].slice(1), ...plain.slice(i + 1, end)].join("\n").trim();
    }
  } catch {}
  return null;
}
// Whether the box holds exactly this held prompt (whitespace aside: the box wraps it), a paste shown as its token.
function boxHolds(box: string, prompt: string) {
  const flat = (s: string) => s.replace(/\s+/g, "");
  const esc = (s: string) => flat(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = prompt.trim().split(new RegExp(PASTE.source)).filter((_, i) => i % 3 !== 1);
  const re = parts.map((x, i) => (i % 2 ? "\\[Pastedtext#\\d+(\\+\\d+lines)?\\]" : esc(x))).join("");
  return new RegExp(`^${re}$`).test(flat(box));
}
async function hqIdle(floor: string) {
  try {
    const get = Bun.spawn([HERDR, "agent", "get", hqOf(floor)], { stdout: "pipe", stderr: "ignore" });
    return ["idle", "done"].includes(JSON.parse(await new Response(get.stdout).text())?.result?.agent?.agent_status);
  } catch {
    return false;
  }
}

// After a held prompt Claude Code puts it back in HQ's input box. It is cleared with ctrl+c (ctrl+u clears only the
// box's last line), only while the queue is on, HQ is idle (ctrl+c interrupts a working HQ) and the box holds exactly
// that prompt (nothing typed by hand is lost, and ctrl+c on an empty box is a step toward exiting). Tried once the
// box has it back and again on each sync while it is there. The last few held prompts are kept, since Claude does not
// put every one back. An empty box drops those held over HELD_BACK_MS ago: Claude puts one back at once, so it is gone.
const HELD_BACK_MS = 10_000;
const heldInBox = new Map<string, { prompt: string; at: number }[]>();
async function clearHeld(floor: string, box: string | null) {
  const holds = (h: { prompt: string }) => !!box && boxHolds(box, h.prompt);
  if (!queueOn() || !(heldInBox.get(floor) ?? []).some(holds) || !(await hqIdle(floor))) return;
  // Looked at again after the wait, and every match dropped at once: two clears of one box send one ctrl+c, not the
  // two that exit Claude Code.
  const held = heldInBox.get(floor) ?? [];
  if (!held.some(holds)) return;
  heldInBox.set(floor, held.filter((h) => !holds(h)));
  Bun.spawn([HERDR, "agent", "send-keys", hqOf(floor), "ctrl+c"], { stdout: "ignore", stderr: "ignore" });
}
function hold(floor: string, prompt: string, reason: string) {
  heldInBox.set(floor, [{ prompt, at: Date.now() }, ...(heldInBox.get(floor) ?? [])].slice(0, 10));
  setTimeout(async () => clearHeld(floor, await hqBox(floor)), CLEAR_AFTER);
  return { output: { decision: "block", reason } };
}
// The open item a prompt starts with: what Claude put back in the box after a hold, with something typed after it.
function queuedAt(floor: string, p: string) {
  const open = db.query(`SELECT * FROM hq_queue WHERE floor = ? AND via = 'hook' AND ${OPEN} ORDER BY length(text) DESC`).all(floor) as Item[];
  return open.find((it) => p.startsWith(it.text)) ?? null;
}

// The hook's question: what to do with this event in this session. Only a floor's HQ, in its own session (herdr's
// session id for it), with the queue on, gets anything; everyone else gets {} and the hook does nothing.
export type HookIn = { event?: string; session_id?: string; prompt?: string; stop_hook_active?: boolean };
export function hookDecision(input: HookIn): { output?: unknown; text?: string } {
  const agent = agentOfSession(input.session_id);
  const floor = floorOfHq(agent);
  if (!agent || !floor) return {};
  hookRan.set(floor, Date.now());
  if (!queueOn()) return {};
  const line = queueLine(floor);
  if (input.event === "UserPromptSubmit") {
    const raw = String(input.prompt ?? ""), p = typed(raw);
    // Already queued: held again when nothing follows it; what follows goes straight in when it would on its own.
    const dup = queuedAt(floor, p), rest = dup ? p.slice(dup.text.length).trim() : null;
    if (dup && !rest) return hold(floor, raw, `Already queued as #${dup.id}; HQ reads it with hud req next.`);
    if (dup && straightIn(rest!)) return { text: `${line ?? ""} This prompt starts with queue item #${dup.id}, already in your queue: answer it there.`.trim() };
    if (straightIn(p)) return line ? { text: line } : {};
    const id = fileItem({ floor, from: senderOf(p), text: p, via: "hook" });
    return hold(floor, raw, `Queued for HQ as #${id}; HQ reads it with hud req next.`);
  }
  if (input.event === "PostToolUse") return line ? { output: { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } } } : {};
  if (input.event === "Stop") {
    if (!counts(floor).unread) return {};
    return { output: { decision: "block", reason: `${line} Do not stop with unread items in your queue.` } };
  }
  return {};
}

// An idle HQ with unread items is prompted (any agent kind; a hook only keeps a working one going): at once for a new
// item, then every KICK_EVERY while it stays idle and something is unread. The line starts with HUD, so the hook lets
// it through. Only into an empty box: typed after text already there, both would be submitted as one prompt. A held
// prompt still in the box is cleared first, unread items or not, and the kick goes in on the next sync.
const kicked = new Map<string, { at: number; top: number }>();
export async function kickQueue(now = Date.now()) {
  if (!queueOn()) return;
  for (const f of floorList()) {
    const c = counts(f.id), top = c.unreadItems.at(-1)?.id, k = kicked.get(f.id);
    const due = !!c.unread && !(k && k.top === top && now - k.at < KICK_EVERY);
    if (!due && !heldInBox.get(f.id)?.length) continue;
    if (!["idle", "done"].includes(hqNowOf(f.id).status ?? "") || hqLink(f.id).ok !== true) continue;
    const box = await hqBox(f.id);
    if (box === "") heldInBox.set(f.id, (heldInBox.get(f.id) ?? []).filter((h) => now - h.at < HELD_BACK_MS));
    if (box) await clearHeld(f.id, box);
    if (box || !due) continue;
    const r = await promptAgent(hqOf(f.id), `HUD queue: ${queueLine(f.id, now)}`);
    if (r.ok) kicked.set(f.id, { at: now, top: top! });
  }
}

// Whether HQ's hook is in this user's Claude Code settings (bin/queue-hook.ts), looked at once per 10 s at most.
const HOOK_CHECK_MS = process.env.HUD_QUEUE_HOOK_CHECK_MS !== undefined ? Number(process.env.HUD_QUEUE_HOOK_CHECK_MS) : 10_000;
let hookSeen = { at: 0, yes: false };
const hookIn = () => {
  if (Date.now() - hookSeen.at >= HOOK_CHECK_MS) hookSeen = { at: Date.now(), yes: !!process.env.HOME && hookInstalled(process.env.HOME) };
  return hookSeen.yes;
};
// When HQ's hook last ran in each floor's HQ's session (memory only: a restart forgets it until the next event).
const hookRan = new Map<string, number>();

// Whether lanes' typed messages are held on a floor right now, and if not, why: the hook must be installed, HQ must
// run a Claude Code agent herdr reports a session for, and the hook must have run in that session.
export function heldOn(floor: string, now = Date.now()): { held: boolean; why: string } {
  const f = floorOf(floor);
  const hq = f ? live.find((a) => a.name === f.hq && a.machine === LOCAL) : undefined;
  if (!hookIn()) return { held: false, why: "HQ's hook is not installed (plugin action: HQ Office: add HQ's queue hook)" };
  if (!hq) return { held: false, why: `HQ (${f?.hq ?? "?"}) is not running in herdr on this machine` };
  if (hq.kind && hq.kind !== "claude") return { held: false, why: `HQ runs ${hq.kind}, which has no prompt hook: lanes' messages go straight in (notes and hud request still queue)` };
  if (!hasSession(hq.name)) return { held: false, why: "herdr does not report HQ's session, so the hook cannot tell it is HQ" };
  const ran = hookRan.get(floor);
  if (!ran) return { held: false, why: "the hook has not run in HQ's session yet: restart HQ's session to load it" };
  const m = Math.round((now - ran) / 60_000);
  return { held: true, why: `the hook last ran ${m < 1 ? "just now" : `${m} min ago`}` };
}
// S.queue: whether it is on, whether HQ's hook is installed, and each floor's counts, for the page (top bar, SETTINGS).
addStatePart("queue", () => {
  const on = queueOn();
  if (!on) return { on, hook: false, floors: {} }; // off: the user's settings are not even looked at
  return { on, hook: hookIn(), floors: Object.fromEntries(floorList().map((f) => { const c = counts(f.id); return [f.id, { unread: c.unread, waiting: c.waiting.length, ...heldOn(f.id) }]; })) };
});
