// HQ's link, per floor: whether a floor's HQ can take what the server types into it, and the outbox that holds what
// it could not take. Every sync checks, for each floor, that an agent named as that floor's HQ is in herdr on this
// machine and ready for input, so the page says "HQ isn't receiving" before the owner writes into the void.
// Everything for an HQ goes through the outbox: typed in at once when it can be, held when it cannot, and sent in
// order on the first sync that finds that HQ again. One floor's trouble never holds up another's.
import { HERDR } from "./config.ts";
import { db } from "./db.ts";
import { bump } from "./push.ts";
import { event } from "./events.ts";
import { addStatePart } from "./state.ts";
import { withHint } from "../hq-guide.ts";
import { promptAgent, syncHerdr } from "./herdr.ts";
import { firstFloor, floorCounts, floorList, floorOr, hqOf, officeCounts } from "./floors.ts";

type Held = { id: number; at: number; text: string; ref: string | null; error: string | null; tries: number; sent_at: number | null; confirmed_at: number | null; resend: number };
// One floor's link. seen: what the last sync found (null: fine, or not checked yet). sent: why the last delivery
// failed (null once one succeeds). The page shows the first of the two.
// tracked: HQ by pane (the quiet rename heal, see checkFloor). status and workingAt: HQ's herdr status at the last
// sync, and when it was last seen working (the sweep nudge reads both).
type Link = {
  seen: string | null;
  sent: string | null;
  since: number;
  candidate: { pane: string; agent: string } | null;
  checked: boolean;
  tracked: { pane: string; agent: string } | null;
  status: string | null;
  workingAt: number;
  flushing: Promise<void> | null;
  again: boolean;
  // When this link started (the floor added, or given another HQ): a new HQ has STARTING_MS to show up in herdr.
  startedAt: number;
};
const links = new Map<string, Link>();
function linkOf(floor: string): Link {
  let l = links.get(floor);
  if (!l) links.set(floor, (l = { seen: null, sent: null, since: 0, candidate: null, checked: false, tracked: null, status: null, workingAt: 0, flushing: null, again: false, startedAt: Date.now() }));
  return l;
}
// A new floor's HQ that has never been seen in herdr is STARTING, not "not receiving": no alarm, no red strip, and
// nothing typed into it (what is meant for it is held) until the first sync that finds it. After STARTING_MS it is
// "not started", a calm note on that floor only. An HQ seen once (floors.hq_seen_at) and then gone is the alarm, as
// before. The first floor's HQ is never STARTING: it is the HQ the HUD was set up with, and its alarm stays.
const STARTING_MS = Number(process.env.HUD_HQ_STARTING_MS) || 2 * 60_000;
export function neverSeen(floor: string) {
  if (floor === firstFloor()) return false;
  const row = db.query("SELECT hq_seen_at AS at FROM floors WHERE id = ?").get(floor) as { at: number | null } | null;
  return !!row && row.at == null;
}
const notStarted = (floor: string) => Date.now() - linkOf(floor).startedAt >= STARTING_MS;
// What the page says about a STARTING floor, and whether the last sync said it was not started yet (to bump once).
const notStartedShown = new Map<string, boolean>();

// A floor's HQ changed or the floor went: its link starts over.
export const forgetLink = (floor: string) => { links.delete(floor); notStartedShown.delete(floor); };
// HQ's herdr status at the last sync, and when it last worked (the sweep nudge).
export const hqNowOf = (floor: string) => ({ status: linkOf(floor).status, workingAt: linkOf(floor).workingAt });

// herdr's errors are JSON on stderr: {"error":{"code":"agent_not_found","message":"..."}}. Said for the owner.
function reasonOf(error: string, agent: string): string {
  let code = "", message = error;
  try {
    const e = JSON.parse(error).error;
    code = e?.code ?? "";
    message = e?.message ?? error;
  } catch {}
  if (code === "agent_not_found") return `no agent in herdr is named "${agent}"`;
  if (code === "agent_blocked") return "HQ is stopped at a prompt (a permission or a question) in its pane";
  if (code === "agent_prompt_stalled") return "HQ did not start working on a message typed into its pane (at a menu, or stuck?); it is held and tried again";
  return `herdr could not type into HQ: ${message}`.slice(0, 300);
}

function setReason(floor: string, next: { seen?: string | null; sent?: string | null }) {
  const l = linkOf(floor);
  const was = l.seen ?? l.sent;
  if ("seen" in next) l.seen = next.seen ?? null;
  if ("sent" in next) l.sent = next.sent ?? null;
  const now = l.seen ?? l.sent;
  if (now === was) return;
  if (now && !was) l.since = Date.now();
  event("hud", now ? `HQ isn't receiving: ${now}` : "HQ is receiving again", null, floor);
  bump();
}

// HQ by pane. herdr drops an agent's name when a session report for its pane carries another session id: a Claude
// Code background job started from HQ's pane inherits HERDR_PANE_ID, so its compaction re-binds HQ's pane to the
// job's session, and HQ's own next compaction then clears the name. HQ's process is still there, so the server gives
// the name back, quietly: only to the pane HQ was last named in, and only while that pane has held an agent of the
// same kind at every sync since (the same occupant). Memory only, so never across a server restart (the NAME button
// is there for that). HUD_HQ_RENAME=0 leaves it to the owner.
const AUTO_RENAME = process.env.HUD_HQ_RENAME !== "0";

async function rename(pane: string, agent: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([HERDR, "agent", "rename", pane, agent], { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 ? null : reasonOf((await new Response(proc.stderr).text()).trim() || `exit ${code}`, agent);
  } catch (e) {
    return (e as Error).message;
  }
}

// After each sync: `agents` is this machine's `herdr agent list`, or null with `error` when herdr did not answer.
// Every floor's HQ is checked, one after the other.
export async function checkHq(agents: any[] | null, error?: string) {
  for (const f of floorList()) await checkFloor(f.id, f.hq, agents, error);
}

async function checkFloor(floor: string, agent: string, agents: any[] | null, error?: string) {
  const l = linkOf(floor);
  l.checked = true;
  // STARTING: until herdr first shows this floor's HQ, no reason is set and nothing is typed in.
  if (neverSeen(floor) && !agents?.some((a) => a.name === agent)) {
    l.seen = l.sent = null;
    l.candidate = null;
    l.status = null;
    const late = notStarted(floor);
    if (notStartedShown.get(floor) !== late) {
      notStartedShown.set(floor, late);
      if (late) event("hud", `${agent} has not started in herdr yet`, null, floor);
      bump();
    }
    return;
  }
  if (!agents) {
    l.candidate = null;
    l.status = null;
    setReason(floor, { seen: `herdr did not answer on this machine${error ? `: ${error}` : ""}`.slice(0, 300) });
    return;
  }
  let hq = agents.find((a) => a.name === agent);
  if (!hq && l.tracked) {
    const there = agents.find((a) => a.pane_id === l.tracked!.pane);
    if (!there || there.agent !== l.tracked.agent || there.name) l.tracked = null; // gone, replaced, or named on purpose
    else if (AUTO_RENAME) {
      const failed = await rename(there.pane_id, agent);
      if (failed) event("hud", `herdr dropped HQ's name; could not give it back to pane ${there.pane_id}: ${failed}`, null, floor);
      else {
        event("hud", `herdr dropped HQ's name; gave it back to pane ${there.pane_id}`, null, floor);
        hq = { ...there, name: agent };
      }
    }
  }
  l.status = hq?.agent_status ?? null;
  if (hq?.agent_status === "working") l.workingAt = Date.now();
  if (hq) {
    l.candidate = null;
    l.tracked = { pane: hq.pane_id, agent: hq.agent };
    db.query("UPDATE floors SET hq_pane = ?, hq_seen_at = ? WHERE id = ?").run(hq.pane_id, Date.now(), floor);
    if (hq.agent_status === "blocked") setReason(floor, { seen: "HQ is stopped at a prompt (a permission or a question) in its pane" });
    else if (hq.interactive_ready === false) setReason(floor, { seen: "HQ's agent is starting and cannot take input yet" });
    else setReason(floor, { seen: null, sent: null }); // the flush below finds out if typing in still fails
  } else {
    // The pane HQ was last seen in, if it still holds an agent without a name: most likely HQ, restarted or resumed.
    const last = db.query("SELECT hq_pane AS pane FROM floors WHERE id = ?").get(floor) as { pane: string | null } | null;
    const there = last?.pane && agents.find((a) => a.pane_id === last.pane && !a.name);
    l.candidate = there ? { pane: there.pane_id, agent: there.agent } : null;
    setReason(floor, { seen: `no agent in herdr is named "${agent}"` });
  }
  if (!l.seen) {
    if (["idle", "done"].includes(hq?.agent_status)) reconfirm(floor);
    flush(floor);
  }
}

// HQ is idle: what was typed in while it was mid-turn could not be confirmed, and a queued message can be lost. Each
// of the owner's notes and answers among them goes once more, unless HQ acked it meanwhile; anything else counts as
// delivered. Only recent ones (RESEND_WINDOW, 3 h) and at most MAX_RESEND per check: an old backlog is never replayed.
const RESEND_WINDOW = Number(process.env.HUD_RESEND_WINDOW_MS) || 3 * 3600_000;
const MAX_RESEND = 3;
function reconfirm(floor: string) {
  const now = Date.now();
  let resent = 0;
  for (const row of db.query("SELECT * FROM hq_outbox WHERE sent_at IS NOT NULL AND confirmed_at IS NULL AND floor = ? ORDER BY id").all(floor) as Held[]) {
    const old = now - (row.sent_at ?? 0) > RESEND_WINDOW;
    if (!row.ref || row.resend || old || alreadyRead(row.ref)) db.query("UPDATE hq_outbox SET confirmed_at = ? WHERE id = ?").run(now, row.id);
    else if (resent < MAX_RESEND) {
      db.query("UPDATE hq_outbox SET sent_at = NULL, resend = 1 WHERE id = ?").run(row.id);
      resent += 1;
    }
  }
}

// The one way to tell an HQ something: the floor's HQ (the first floor's when none is given). `ref` ties it to what
// it carries ("note:12", "ask:5") so the page can mark it held.
export function notifyHq(text: string, ref?: string, floor?: string | null) {
  const to = floorOr(floor);
  db.query("INSERT INTO hq_outbox (at, text, ref, floor) VALUES (?, ?, ?, ?)").run(Date.now(), text, ref ?? null, to);
  if (ref) bump();
  flush(to);
}
// What every HQ must hear (secrets are shared by every floor).
export function notifyAllHqs(text: string) {
  for (const f of floorList()) notifyHq(text, undefined, f.id);
}

const held = (floor: string) => db.query("SELECT * FROM hq_outbox WHERE sent_at IS NULL AND floor = ? ORDER BY id").all(floor) as Held[];

// Sends what is held for a floor's HQ, oldest first, and stops at the first failure so HQ reads things in the order
// they were written. One flush per floor at a time; a call during one runs another when it ends.
function flush(floor: string): Promise<void> {
  const l = linkOf(floor);
  if (neverSeen(floor)) return Promise.resolve(); // STARTING: held until the first sync that finds its HQ
  if (l.flushing) {
    l.again = true;
    return l.flushing;
  }
  l.flushing = (async () => {
    do {
      l.again = false;
      for (const row of held(floor)) {
        // HQ already read it from its inbox (`hud inbox`): nothing to type in.
        if (alreadyRead(row.ref)) {
          db.query("UPDATE hq_outbox SET sent_at = ?, error = NULL WHERE id = ?").run(Date.now(), row.id);
          continue;
        }
        const late = row.resend ? `(sent again: it was typed in while you were mid-turn${ackHint(row.ref)}) ` : Date.now() - row.at > 60_000 ? `(held while HQ was not receiving; written at ${clock(row.at)}) ` : "";
        // Idle: herdr confirms HQ starts working on it. Mid-turn: typed in now (it may be read at once), confirmed or
        // sent again when HQ is next idle (reconfirm).
        const idle = ["idle", "done"].includes(l.status ?? "");
        const agent = hqOf(floor);
        const r = await promptAgent(agent, withHint(late + row.text), null, { confirm: idle });
        if (r.ok) {
          const now = Date.now();
          db.query("UPDATE hq_outbox SET sent_at = ?, confirmed_at = ?, error = NULL, tries = tries + 1 WHERE id = ?").run(now, idle ? now : null, row.id);
          setReason(floor, { sent: null });
          bump();
        } else if (r.error.includes("agent_not_found") && l.tracked && AUTO_RENAME) {
          // HQ's name went between syncs and the server knows its pane: heal it now, quietly. The row stays held
          // without an error, so the page shows nothing; the sync after the rename sends it.
          db.query("UPDATE hq_outbox SET tries = tries + 1 WHERE id = ?").run(row.id);
          recheckSoon();
          l.again = false;
          break;
        } else {
          db.query("UPDATE hq_outbox SET error = ?, tries = tries + 1 WHERE id = ?").run(r.error.slice(0, 500), row.id);
          setReason(floor, { sent: reasonOf(r.error, agent) });
          bump();
          l.again = false;
          break;
        }
      }
    } while (l.again);
  })().finally(() => (l.flushing = null));
  return l.flushing;
}

// Resolves when the current flushes, if any, are done: a route that checks HQ answers with what came of it.
export const flushed = () => Promise.all([...links.values()].map((l) => l.flushing ?? Promise.resolve())).then(() => {});

const ackHint = (ref: string | null) => {
  const [kind, id] = (ref ?? "").split(":");
  return kind === "note" ? `; ack it with hud ack n:${id}` : kind === "ask" ? `; ack it with hud ack a:${id}` : "";
};

// Where each of the owner's notes and answers for a floor stands, for the page: held (not typed in yet), unconfirmed
// (typed in while HQ was mid-turn), delivered (HQ started working on it) or acked (HQ acked it). The last day's, by ref.
function deliveries(floor: string) {
  const out: Record<string, string> = {};
  const rows = db.query("SELECT ref, sent_at, confirmed_at FROM hq_outbox WHERE ref IS NOT NULL AND at > ? AND floor = ? ORDER BY id").all(Date.now() - 86_400_000, floor) as { ref: string; sent_at: number | null; confirmed_at: number | null }[];
  for (const r of rows) out[r.ref] = alreadyRead(r.ref) ? "acked" : !r.sent_at ? "held" : r.confirmed_at ? "delivered" : "unconfirmed";
  return out;
}

function alreadyRead(ref: string | null) {
  const [kind, id] = (ref ?? "").split(":");
  if (kind === "note") return !!(db.query("SELECT acked_at FROM notes WHERE id = ?").get(Number(id)) as { acked_at: number | null } | null)?.acked_at;
  if (kind === "ask") return !!(db.query("SELECT acked_at FROM asks WHERE id = ?").get(Number(id)) as { acked_at: number | null } | null)?.acked_at;
  return false;
}

// A delivery found HQ's name gone between syncs: sync now (which gives the name back, see checkFloor) instead of in
// up to 20 s. At most once every 5 s, so a name that cannot be healed does not turn into a loop.
let lastRecheck = 0;
function recheckSoon() {
  if (Date.now() - lastRecheck < 5_000) return;
  lastRecheck = Date.now();
  setTimeout(() => void syncHerdr(), 0);
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

// Gives a floor's HQ its last pane's name back (`herdr agent rename`). Only the pane the server offered, never one the
// page names.
export async function nameHq(floor = firstFloor()): Promise<void> {
  const agent = hqOf(floor);
  const candidate = linkOf(floor).candidate;
  if (!candidate) throw new Error(`no pane to name: start HQ in herdr with the name ${agent}`);
  const failed = await rename(candidate.pane, agent);
  if (failed) throw new Error(failed);
  event("hud", `named pane ${candidate.pane} ${agent}`, null, floor);
}

export function hqLink(floor = firstFloor()) {
  const l = linkOf(floor);
  const rows = held(floor);
  const reason = l.seen ?? l.sent;
  const starting = neverSeen(floor);
  return {
    agent: hqOf(floor),
    ok: starting ? null : l.checked ? !reason : null,
    // A new floor's HQ not seen in herdr yet: STARTING, and after a while "not started"; never the alarm.
    starting,
    notStarted: starting && notStarted(floor),
    reason,
    since: reason ? l.since : null,
    candidate: l.candidate,
    deliveries: deliveries(floor),
    // While HQ is not receiving, all of it; otherwise only what failed (the rest is on its way).
    held: rows.filter((r) => reason || r.error).map((r) => ({ id: r.id, at: r.at, ref: r.ref, text: r.text.length > 240 ? r.text.slice(0, 239) + "…" : r.text })),
  };
}

// S.office: the three readings for the whole office (floors.ts), the same definitions as each floor's counts.
addStatePart("office", () => officeCounts());
// S.hq: the first floor's link, as before floors. S.hqLinks: every floor's, by id. S.floors: the floors, in order,
// with their link and what their tile counts.
addStatePart("hq", () => hqLink());
addStatePart("hqLinks", () => Object.fromEntries(floorList().map((f) => [f.id, hqLink(f.id)])));
addStatePart("floors", () =>
  floorList().map((f) => {
    const l = linkOf(f.id);
    const reason = l.seen ?? l.sent;
    const starting = neverSeen(f.id);
    return {
      id: f.id, name: f.name, color: f.color, hq: f.hq,
      receiving: starting ? null : l.checked ? !reason : null, reason,
      starting, notStarted: starting && notStarted(f.id),
      counts: floorCounts(f.id),
    };
  }),
);
