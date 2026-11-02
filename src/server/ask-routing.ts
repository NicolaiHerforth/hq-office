// Who an ask is for, and where the owner's answer goes. A lane that asks (a PM asking for its lanes) gets the answer
// and NOT YET typed into its pane, kept while it is away or busy; any other ask's go to its floor's HQ, as before.
import { OWNER } from "./config.ts";
import { db } from "./db.ts";
import type { Ask } from "./types.ts";
import { bump, listeners } from "./push.ts";
import { event } from "./events.ts";
import { notifyHq } from "./hq-link.ts";
import { promptAgent } from "./herdr.ts";
import { addStatePart } from "./state.ts";
import { floorOr, isHqAgent, laneFloor } from "./floors.ts";

type Row = { id: number; at: number; floor: string | null; to_lane: string; ref: string; text: string; delivery: string; error: string | null; delivered_at: number | null };
type LaneRow = { name: string; machine: string | null; herdr: string | null; herdr_since: number | null; prompt: string | null; floor: string | null };
// Kept: not typed in yet. away: herdr finds no agent by the lane's name, or it waits at a prompt (typing in would
// answer the prompt). busy: mid-turn, where a typed message can be lost; it goes when the lane is next idle, unless the
// lane read it meanwhile (hud wait, hud inbox) and acked it.
const KEPT = ["queued", "away", "busy"];
// Gone this long, a lane is not coming back for its answer: its floor's HQ gets it.
const GONE_MS = Number(process.env.HUD_LANE_GONE_MS) || 30 * 60_000;

const laneRow = (name: string) => db.query("SELECT name, machine, herdr, herdr_since, prompt, floor FROM lanes WHERE name = ?").get(name) as LaneRow | null;
const goneLong = (l: LaneRow) => l.herdr === "gone" && Date.now() - (l.herdr_since ?? 0) > GONE_MS;
const waitFor = (l: LaneRow) => (l.herdr === "gone" || l.prompt ? "away" : l.herdr === "working" ? "busy" : null);

// The asker is recorded only when a registered lane, not an HQ, files the ask on its own floor.
export function recordAsker(id: number, agent: string | null | undefined, floor: string) {
  if (!agent || isHqAgent(agent)) return;
  if (floorOr(laneFloor(agent)) !== floor || !laneRow(agent)) return;
  db.query("INSERT OR REPLACE INTO ask_askers (ask_id, agent, at) VALUES (?, ?, ?)").run(id, agent, Date.now());
}

// The lane that asked, while it can still get what is said about the ask: on the ask's floor and not gone for good.
// null means the floor's HQ.
export function askerOf(ask: Pick<Ask, "id" | "floor">): string | null {
  const row = db.query("SELECT agent FROM ask_askers WHERE ask_id = ?").get(ask.id) as { agent: string } | null;
  const l = row && laneRow(row.agent);
  return l && floorOr(l.floor) === floorOr(ask.floor) && !goneLong(l) ? row.agent : null;
}

// Whose an answer is to act on and ack: the lane it went to (or is kept for), or HQ (null) when it went to HQ or no
// lane asked. Settled once the answer is on its way, so a lane that moves on later keeps its answers.
export function answerOwner(ask: Pick<Ask, "id" | "floor">): string | null {
  const row = db.query("SELECT to_lane, delivery FROM lane_outbox WHERE ref = ? ORDER BY id DESC LIMIT 1").get(`ask:${ask.id}`) as { to_lane: string; delivery: string } | null;
  return row ? (row.delivery === "hq" ? null : row.to_lane) : askerOf(ask);
}

// The one way to tell whoever asked: its lane, through lane_outbox, or the floor's HQ.
export function tellAsker(ask: Ask, text: string, ref: string) {
  const lane = askerOf(ask);
  if (!lane) return notifyHq(text, ref, ask.floor);
  db.query("INSERT INTO lane_outbox (at, floor, to_lane, ref, text, delivery) VALUES (?, ?, ?, ?, ?, 'queued')").run(Date.now(), ask.floor, lane, ref, text);
  bump();
  pump(lane);
}

const askIdOf = (ref: string) => Number(ref.split(":")[1]);
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

// Nothing to type: the answer was acked (read from hud inbox or hud wait), or a NOT YET's ask is no longer open.
function settled(ref: string) {
  const a = db.query("SELECT status, acked_at FROM asks WHERE id = ?").get(askIdOf(ref)) as { status: string; acked_at: number | null } | null;
  return !a || (ref.startsWith("ask:") ? !!a.acked_at : a.status !== "open");
}

function promptText(r: Row) {
  const id = askIdOf(r.ref);
  const after = r.ref.startsWith("ask:")
    ? `Ack it once you have acted on it: hud ack a:${id} (hud inbox lists your answers).`
    : `The question stays open in the owner's NEEDS YOU.`;
  const late = r.delivery === "queued" ? "" : `(kept while you were ${r.delivery === "busy" ? "busy" : "away"}; written at ${hhmm(r.at)}) `;
  return `${late}${r.text}\n${after} ${OWNER} reads the HUD, not this terminal.`;
}

function set(id: number, delivery: string, error: string | null = null) {
  db.query("UPDATE lane_outbox SET delivery = ?, error = ?, delivered_at = CASE WHEN ? = 'sent' THEN ? ELSE delivered_at END WHERE id = ?").run(delivery, error, delivery, Date.now(), id);
  bump();
}

// The lane cannot take it (removed, moved to another floor, gone for good, or herdr refused): its floor's HQ gets it.
function toHq(r: Row, why: string) {
  set(r.id, "hq", why.slice(0, 200));
  notifyHq(`${r.text} (for ${r.to_lane}, which did not get it: ${why})`.slice(0, 4000), r.ref, r.floor);
}

// A lane's kept rows go one at a time, oldest first, so a NOT YET and the answer after it arrive in that order. Safe to
// call any time: it sends nothing while one is on its way, and changes nothing while the lane still cannot take it.
function pump(lane: string) {
  if (db.query("SELECT 1 FROM lane_outbox WHERE to_lane = ? AND delivery = 'sending'").get(lane)) return;
  const r = db.query(`SELECT * FROM lane_outbox WHERE to_lane = ? AND delivery IN (${KEPT.map(() => "?").join(", ")}) ORDER BY id LIMIT 1`).get(lane, ...KEPT) as Row | null;
  if (!r) return;
  if (settled(r.ref)) return set(r.id, "sent", "nothing to type: acked, or no longer open"), pump(lane);
  const l = laneRow(lane);
  if (!l || floorOr(l.floor) !== floorOr(r.floor)) return toHq(r, l ? `it moved to floor ${l.floor}` : "it is no longer a lane"), pump(lane);
  if (goneLong(l)) return toHq(r, `herdr has not seen it for ${Math.round((Date.now() - (l.herdr_since ?? 0)) / 60_000)} min`), pump(lane);
  const wait = waitFor(l);
  if (wait) {
    if (r.delivery !== wait) set(r.id, wait);
    return;
  }
  const text = promptText(r);
  set(r.id, "sending");
  promptAgent(lane, text, l.machine).then((res) => {
    if (res.ok) {
      set(r.id, "sent");
      event("hud", `typed ${r.ref.startsWith("ask:") ? "the answer" : "NOT YET"} on #${askIdOf(r.ref)} into ${lane}`, lane, r.floor);
    } else toHq(r, `herdr could not type into it: ${res.error}`);
    pump(lane);
  });
}

// A server restart mid-send: kept again, and sent when herdr next shows the lane idle (at least once, never lost).
db.query("UPDATE lane_outbox SET delivery = 'away' WHERE delivery = 'sending'").run();

// After every change of the state (herdr's sync bumps when a lane's status changes), each lane with something kept
// gets a pump; nothing runs on a timer of its own, and a pump that changes nothing does not bump.
let checkQueued = false;
listeners.add(() => {
  if (checkQueued) return;
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    const lanes = db.query(`SELECT DISTINCT to_lane FROM lane_outbox WHERE delivery IN (${KEPT.map(() => "?").join(", ")})`).all(...KEPT) as { to_lane: string }[];
    for (const { to_lane } of lanes) pump(to_lane);
  });
});

const lastDelivery = (ref: string) => (db.query("SELECT delivery FROM lane_outbox WHERE ref = ? ORDER BY id DESC LIMIT 1").get(ref) as { delivery: string } | null)?.delivery ?? null;

// HQ's inbox: an answer for one of its lanes is the lane's to act on and ack, but HQ sees that it came and where it is.
export function forLanes(floor: string | null) {
  const on = floor ? " AND a.floor = ?" : "";
  const rows = db.query(`SELECT a.id, a.title, a.lane, a.answer, a.answered_at, a.floor FROM asks a JOIN ask_askers k ON k.ask_id = a.id WHERE a.status = 'answered' AND a.acked_at IS NULL${on} ORDER BY a.answered_at`).all(...(floor ? [floor] : [])) as Ask[];
  return rows.flatMap((a) => {
    const lane = answerOwner(a);
    return lane ? [{ id: a.id, title: a.title, lane: a.lane, for: lane, answer: a.answer, answered_at: a.answered_at, floor: a.floor, delivery: lastDelivery(`ask:${a.id}`) }] : [];
  });
}

// S.askers: each open or recent ask a lane asked, by id: { name, now, delivery }. now: where the next answer would
// stand at once (null: typed in, else away or busy: kept). delivery: the last answer or NOT YET typed in (queued,
// sending, sent, away, busy; null before either). An ask whose asker cannot get it any more is HQ's and not here.
addStatePart("askers", () => {
  const rows = db.query("SELECT a.id, a.floor, a.status FROM ask_askers k JOIN asks a ON a.id = k.ask_id WHERE a.status = 'open' OR a.answered_at >= ?").all(Date.now() - 24 * 3600_000) as { id: number; floor: string | null; status: string }[];
  const out: Record<number, { name: string; now: string | null; delivery: string | null }> = {};
  for (const a of rows) {
    const name = a.status === "open" ? askerOf(a) : answerOwner(a);
    if (!name) continue;
    const l = laneRow(name);
    out[a.id] = { name, now: l ? waitFor(l) : "away", delivery: lastDelivery(`ask:${a.id}`) ?? lastDelivery(`notyet:${a.id}`) };
  }
  return out;
});
