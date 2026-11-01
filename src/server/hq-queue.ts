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
import { agentOfSession, floorList, floorOf, floorOfHq, floorOr, hqOf } from "./floors.ts";
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

// After a held prompt Claude Code puts its text back in HQ's input box: clear it (ctrl+u), but only while the queue
// is on and only when the box holds exactly that text, so nothing typed by hand is lost.
function clearInput(floor: string, text: string) {
  setTimeout(async () => {
    if (!queueOn()) return;
    const pane = floorOf(floor)?.hq_pane;
    if (!pane) return;
    try {
      const read = Bun.spawn([HERDR, "pane", "read", pane, "--lines", "6"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(read.stdout).text();
      const head = text.replace(/\s+/g, " ").trim().slice(0, 40);
      if (!out.split("\n").some((l) => /^\s*❯\s/.test(l) && l.replace(/^\s*❯\s*/, "").replace(/\s+/g, " ").startsWith(head))) return;
      Bun.spawn([HERDR, "agent", "send-keys", hqOf(floor), "ctrl+u"], { stdout: "ignore", stderr: "ignore" });
    } catch {}
  }, CLEAR_AFTER);
}

// The hook's question: what to do with this event in this session. Only a floor's HQ, in its own session (herdr's
// session id for it), with the queue on, gets anything; everyone else gets {} and the hook does nothing.
export type HookIn = { event?: string; session_id?: string; prompt?: string; stop_hook_active?: boolean };
export function hookDecision(input: HookIn): { output?: unknown; text?: string } {
  if (!queueOn()) return {};
  const agent = agentOfSession(input.session_id);
  const floor = floorOfHq(agent);
  if (!agent || !floor) return {};
  const line = queueLine(floor);
  if (input.event === "UserPromptSubmit") {
    const p = String(input.prompt ?? "");
    // The HUD's own messages, commands, URGENT and empty prompts go straight in; anything else waits in the queue.
    if (!p.trim() || /^\s*HUD[\s:]/.test(p) || /^\s*\//.test(p) || /^\s*URGENT\b/i.test(p)) return line ? { text: line } : {};
    const id = fileItem({ floor, from: senderOf(p), text: p, via: "hook" });
    clearInput(floor, p);
    return { output: { decision: "block", reason: `Queued for HQ as #${id}; HQ reads it with hud req next.` } };
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
// it through.
const kicked = new Map<string, { at: number; top: number }>();
export async function kickQueue(now = Date.now()) {
  if (!queueOn()) return;
  for (const f of floorList()) {
    const c = counts(f.id);
    if (!c.unread) continue;
    const top = c.unreadItems.at(-1)!.id, k = kicked.get(f.id);
    if (k && k.top === top && now - k.at < KICK_EVERY) continue;
    const hq = hqNowOf(f.id);
    if (!["idle", "done"].includes(hq.status ?? "") || hqLink(f.id).ok !== true) continue;
    const r = await promptAgent(hqOf(f.id), `HUD queue: ${queueLine(f.id, now)}`);
    if (r.ok) kicked.set(f.id, { at: now, top });
  }
}

// Whether HQ's hook is in this user's Claude Code settings (bin/queue-hook.ts), looked at once per 10 s at most.
let hookSeen = { at: 0, yes: false };
const hookIn = () => {
  if (Date.now() - hookSeen.at > 10_000) hookSeen = { at: Date.now(), yes: !!process.env.HOME && hookInstalled(process.env.HOME) };
  return hookSeen.yes;
};
// S.queue: whether it is on, whether HQ's hook is installed, and each floor's counts, for the page (top bar, SETTINGS).
addStatePart("queue", () => {
  const on = queueOn();
  if (!on) return { on, hook: false, floors: {} }; // off: the user's settings are not even looked at
  return { on, hook: hookIn(), floors: Object.fromEntries(floorList().map((f) => { const c = counts(f.id); return [f.id, { unread: c.unread, waiting: c.waiting.length }]; })) };
});
