// HQ's link: whether HQ can take what the server types into it, and the outbox that holds what it could not take.
// Every sync checks that an agent named HQ_AGENT is in herdr on this machine and ready for input, so the page says
// "HQ isn't receiving" before the owner writes into the void. Everything for HQ goes through the outbox: typed in at
// once when it can be, held when it cannot, and sent in order on the first sync that finds HQ again.
import { HERDR } from "./config.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { withHint } from "../hq-guide.ts";
import { HQ_AGENT, promptAgent, syncHerdr } from "./herdr.ts";

type Held = { id: number; at: number; text: string; ref: string | null; error: string | null; tries: number; sent_at: number | null; confirmed_at: number | null; resend: number };
// seen: what the last sync found (null: fine, or not checked yet). sent: why the last delivery failed (null once one
// succeeds). The page shows the first of the two.
let seen: string | null = null;
let sent: string | null = null;
let since = 0;
let candidate: { pane: string; agent: string } | null = null;
let checked = false;

// herdr's errors are JSON on stderr: {"error":{"code":"agent_not_found","message":"..."}}. Said for the owner.
function reasonOf(error: string): string {
  let code = "", message = error;
  try {
    const e = JSON.parse(error).error;
    code = e?.code ?? "";
    message = e?.message ?? error;
  } catch {}
  if (code === "agent_not_found") return `no agent in herdr is named "${HQ_AGENT}"`;
  if (code === "agent_blocked") return "HQ is stopped at a prompt (a permission or a question) in its pane";
  if (code === "agent_prompt_stalled") return "HQ did not start working on a message typed into its pane (at a menu, or stuck?); it is held and tried again";
  return `herdr could not type into HQ: ${message}`.slice(0, 300);
}

function setReason(next: { seen?: string | null; sent?: string | null }) {
  const was = seen ?? sent;
  if ("seen" in next) seen = next.seen ?? null;
  if ("sent" in next) sent = next.sent ?? null;
  const now = seen ?? sent;
  if (now === was) return;
  if (now && !was) since = Date.now();
  event("hud", now ? `HQ isn't receiving: ${now}` : "HQ is receiving again");
  bump();
}

// HQ by pane. herdr drops an agent's name when a session report for its pane carries another session id: a Claude
// Code background job started from HQ's pane inherits HERDR_PANE_ID, so its compaction re-binds HQ's pane to the
// job's session, and HQ's own next compaction then clears the name. HQ's process is still there, so the server gives
// the name back, quietly: only to the pane HQ was last named in, and only while that pane has held an agent of the
// same kind at every sync since (the same occupant). Memory only, so never across a server restart (the NAME button
// is there for that). HUD_HQ_RENAME=0 leaves it to the owner.
let tracked: { pane: string; agent: string } | null = null;
// HQ's herdr status at the last sync, and when it was last seen working (the sweep nudge reads both).
export const hqNow: { status: string | null; workingAt: number } = { status: null, workingAt: 0 };
const AUTO_RENAME = process.env.HUD_HQ_RENAME !== "0";

async function rename(pane: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([HERDR, "agent", "rename", pane, HQ_AGENT], { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? null : reasonOf((await new Response(proc.stderr).text()).trim() || `exit ${code}`);
  } catch (e) {
    return (e as Error).message;
  }
}

// After each sync: `agents` is this machine's `herdr agent list`, or null with `error` when herdr did not answer.
export async function checkHq(agents: any[] | null, error?: string) {
  checked = true;
  if (!agents) {
    candidate = null;
    hqNow.status = null;
    setReason({ seen: `herdr did not answer on this machine${error ? `: ${error}` : ""}`.slice(0, 300) });
    return;
  }
  let hq = agents.find((a) => a.name === HQ_AGENT);
  if (!hq && tracked) {
    const there = agents.find((a) => a.pane_id === tracked!.pane);
    if (!there || there.agent !== tracked.agent || there.name) tracked = null; // gone, replaced, or named on purpose
    else if (AUTO_RENAME) {
      const failed = await rename(there.pane_id);
      if (failed) event("hud", `herdr dropped HQ's name; could not give it back to pane ${there.pane_id}: ${failed}`);
      else {
        event("hud", `herdr dropped HQ's name; gave it back to pane ${there.pane_id}`);
        hq = { ...there, name: HQ_AGENT };
      }
    }
  }
  hqNow.status = hq?.agent_status ?? null;
  if (hq?.agent_status === "working") hqNow.workingAt = Date.now();
  if (hq) {
    candidate = null;
    tracked = { pane: hq.pane_id, agent: hq.agent };
    db.query("INSERT INTO hq_link (id, pane, seen_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET pane = excluded.pane, seen_at = excluded.seen_at").run(hq.pane_id, Date.now());
    if (hq.agent_status === "blocked") setReason({ seen: "HQ is stopped at a prompt (a permission or a question) in its pane" });
    else if (hq.interactive_ready === false) setReason({ seen: "HQ's agent is starting and cannot take input yet" });
    else setReason({ seen: null, sent: null }); // the flush below finds out if typing in still fails
  } else {
    // The pane HQ was last seen in, if it still holds an agent without a name: most likely HQ, restarted or resumed.
    const last = db.query("SELECT pane FROM hq_link WHERE id = 1").get() as { pane: string } | null;
    const there = last && agents.find((a) => a.pane_id === last.pane && !a.name);
    candidate = there ? { pane: there.pane_id, agent: there.agent } : null;
    setReason({ seen: `no agent in herdr is named "${HQ_AGENT}"` });
  }
  if (!seen) {
    if (["idle", "done"].includes(hq?.agent_status)) reconfirm();
    flush();
  }
}

// HQ is idle: what was typed in while it was mid-turn could not be confirmed, and a queued message can be lost. Each
// of the owner's notes and answers among them goes once more, unless HQ acked it meanwhile; anything else counts as
// delivered. Only recent ones (RESEND_WINDOW, 3 h) and at most MAX_RESEND per check: an old backlog is never replayed.
const RESEND_WINDOW = Number(process.env.HUD_RESEND_WINDOW_MS) || 3 * 3600_000;
const MAX_RESEND = 3;
function reconfirm() {
  const now = Date.now();
  let resent = 0;
  for (const row of db.query("SELECT * FROM hq_outbox WHERE sent_at IS NOT NULL AND confirmed_at IS NULL ORDER BY id").all() as Held[]) {
    const old = now - (row.sent_at ?? 0) > RESEND_WINDOW;
    if (!row.ref || row.resend || old || alreadyRead(row.ref)) db.query("UPDATE hq_outbox SET confirmed_at = ? WHERE id = ?").run(now, row.id);
    else if (resent < MAX_RESEND) {
      db.query("UPDATE hq_outbox SET sent_at = NULL, resend = 1 WHERE id = ?").run(row.id);
      resent += 1;
    }
  }
}

// The one way to tell HQ something. `ref` ties it to what it carries ("note:12", "ask:5") so the page can mark it held.
export function notifyHq(text: string, ref?: string) {
  db.query("INSERT INTO hq_outbox (at, text, ref) VALUES (?, ?, ?)").run(Date.now(), text, ref ?? null);
  if (ref) bump();
  flush();
}

const held = () => db.query("SELECT * FROM hq_outbox WHERE sent_at IS NULL ORDER BY id").all() as Held[];

// Sends what is held, oldest first, and stops at the first failure so HQ reads things in the order they were written.
// One flush at a time; a call during one runs another when it ends.
let flushing: Promise<void> | null = null;
let again = false;
function flush(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      again = false;
      for (const row of held()) {
        // HQ already read it from its inbox (`hud inbox`): nothing to type in.
        if (alreadyRead(row.ref)) {
          db.query("UPDATE hq_outbox SET sent_at = ?, error = NULL WHERE id = ?").run(Date.now(), row.id);
          continue;
        }
        const late = row.resend ? `(sent again: it was typed in while you were mid-turn${ackHint(row.ref)}) ` : Date.now() - row.at > 60_000 ? `(held while HQ was not receiving; written at ${clock(row.at)}) ` : "";
        // Idle: herdr confirms HQ starts working on it. Mid-turn: typed in now (it may be read at once), confirmed or
        // sent again when HQ is next idle (reconfirm).
        const idle = ["idle", "done"].includes(hqNow.status ?? "");
        const r = await promptAgent(HQ_AGENT, withHint(late + row.text), null, { confirm: idle });
        if (r.ok) {
          const now = Date.now();
          db.query("UPDATE hq_outbox SET sent_at = ?, confirmed_at = ?, error = NULL, tries = tries + 1 WHERE id = ?").run(now, idle ? now : null, row.id);
          setReason({ sent: null });
          bump();
        } else if (r.error.includes("agent_not_found") && tracked && AUTO_RENAME) {
          // HQ's name went between syncs and the server knows its pane: heal it now, quietly. The row stays held
          // without an error, so the page shows nothing; the sync after the rename sends it.
          db.query("UPDATE hq_outbox SET tries = tries + 1 WHERE id = ?").run(row.id);
          recheckSoon();
          again = false;
          break;
        } else {
          db.query("UPDATE hq_outbox SET error = ?, tries = tries + 1 WHERE id = ?").run(r.error.slice(0, 500), row.id);
          setReason({ sent: reasonOf(r.error) });
          bump();
          again = false;
          break;
        }
      }
    } while (again);
  })().finally(() => (flushing = null));
  return flushing;
}

// Resolves when the current flush, if any, is done: a route that checks HQ answers with what came of it.
export const flushed = () => flushing ?? Promise.resolve();

// An ask in a queue (a lane's urgent request, an urgent Tell) is answered from the queue: hud ack refuses it.
const ackHint = (ref: string | null) => {
  const [kind, id] = (ref ?? "").split(":");
  if (kind === "note") return `; ack it with hud ack n:${id}`;
  if (kind !== "ask") return "";
  const ask = db.query("SELECT recipient FROM asks WHERE id = ?").get(Number(id)) as { recipient: string } | null;
  return ask && ask.recipient !== "owner" ? `; it is #${id} in your queue (hud req next)` : `; ack it with hud ack a:${id}`;
};

// Where each of the owner's notes and answers stands, for the page: held (not typed in yet), unconfirmed (typed in
// while HQ was mid-turn), delivered (HQ started working on it) or acked (HQ acked it). The last day's, by ref.
function deliveries() {
  const out: Record<string, string> = {};
  const rows = db.query("SELECT ref, sent_at, confirmed_at FROM hq_outbox WHERE ref IS NOT NULL AND at > ? ORDER BY id").all(Date.now() - 86_400_000) as { ref: string; sent_at: number | null; confirmed_at: number | null }[];
  for (const r of rows) out[r.ref] = alreadyRead(r.ref) ? "acked" : !r.sent_at ? "held" : r.confirmed_at ? "delivered" : "unconfirmed";
  return out;
}

function alreadyRead(ref: string | null) {
  const [kind, id] = (ref ?? "").split(":");
  if (kind === "note") return !!(db.query("SELECT acked_at FROM notes WHERE id = ?").get(Number(id)) as { acked_at: number | null } | null)?.acked_at;
  if (kind === "ask") return !!(db.query("SELECT acked_at FROM asks WHERE id = ?").get(Number(id)) as { acked_at: number | null } | null)?.acked_at;
  return false;
}

// A delivery found HQ's name gone between syncs: sync now (which gives the name back, see checkHq) instead of in
// up to 20 s. At most once every 5 s, so a name that cannot be healed does not turn into a loop.
let lastRecheck = 0;
function recheckSoon() {
  if (Date.now() - lastRecheck < 5_000) return;
  lastRecheck = Date.now();
  setTimeout(() => void syncHerdr(), 0);
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

// Gives HQ's last pane its name back (`herdr agent rename`). Only the pane the server offered, never one the page names.
export async function nameHq(): Promise<void> {
  if (!candidate) throw new Error(`no pane to name: start HQ in herdr with the name ${HQ_AGENT}`);
  const failed = await rename(candidate.pane);
  if (failed) throw new Error(failed);
  event("hud", `named pane ${candidate.pane} ${HQ_AGENT}`);
}

export function hqLink() {
  const rows = held();
  const reason = seen ?? sent;
  return {
    agent: HQ_AGENT,
    ok: checked ? !reason : null,
    reason,
    since: reason ? since : null,
    candidate,
    deliveries: deliveries(),
    // While HQ is not receiving, all of it; otherwise only what failed (the rest is on its way).
    held: rows.filter((r) => reason || r.error).map((r) => ({ id: r.id, at: r.at, ref: r.ref, text: r.text.length > 240 ? r.text.slice(0, 239) + "…" : r.text })),
  };
}
addStatePart("hq", hqLink);
