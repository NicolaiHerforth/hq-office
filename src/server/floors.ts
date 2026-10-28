// FLOORS: one HQ agent and everything it runs. Each floor's HQ files its own questions, updates, lanes, rooms and
// board items, reads its own inbox, and is the one the owner's answers and notes for that floor are typed into.
// One floor (what the upgrade makes in db.ts) behaves exactly as before floors existed. See docs/floors.md.
//
// Who is calling: hud sends x-hud-pane ($HERDR_PANE_ID) and x-hud-machine; the server knows every named agent's pane
// from the last herdr sync (setPanes). A floor's HQ is on its floor, a lane is on its lane's floor, anyone else is on
// the first floor; an explicit floor (x-hud-floor, or floor in the body or the query) wins over all of these.
import { LOCAL } from "./config.ts";
import { db } from "./db.ts";
import { event } from "./events.ts";
import { FLOOR_PALETTE, freeColor } from "./floor-colors.ts";

export type Floor = { id: string; name: string; color: string; hq: string; position: number; created_at: number; hq_pane: string | null; hq_seen_at: number | null };
export type Caller = { floor: string; explicit: string | null; all: boolean; agent: string | null };

// The first floor's HQ when none is stored: the setting, as before floors.
const ENV_HQ = process.env.HUD_HQ_AGENT || "hq";
const FLOOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
// Colours for floors added without one, in turn: the floor palette (never red, amber or green: floor-colors.ts).
const COLORS = FLOOR_PALETTE;

const withHq = (f: any): Floor => ({ ...f, hq: f.hq || ENV_HQ });
export const floorList = () => (db.query("SELECT * FROM floors ORDER BY position, created_at").all() as any[]).map(withHq);
export const firstFloor = () => (db.query("SELECT id FROM floors ORDER BY position, created_at LIMIT 1").get() as { id: string }).id;
export function floorOf(id: unknown): Floor | null {
  const row = db.query("SELECT * FROM floors WHERE id = ?").get(String(id ?? ""));
  return row ? withHq(row) : null;
}
export function mustFloor(id: unknown): Floor {
  const f = floorOf(id);
  if (!f) throw new Error(`no floor ${String(id ?? "")}: hud floor list shows them`);
  return f;
}
// The HQ agent of a floor; an unknown floor is the first floor's.
export const hqOf = (id: string | null | undefined) => (floorOf(id) ?? floorOf(firstFloor())!).hq;
export const floorOfHq = (agent: string | null | undefined) => (agent ? floorList().find((f) => f.hq === agent)?.id ?? null : null);
export const isHqAgent = (agent: string) => !!floorOfHq(agent);
export const laneFloor = (name: string | null | undefined) =>
  name ? ((db.query("SELECT floor FROM lanes WHERE name = ?").get(name) as { floor: string | null } | null)?.floor ?? null) : null;
// A floor that exists, else the first floor.
export const floorOr = (id: string | null | undefined) => (id && floorOf(id) ? id : firstFloor());

// ---- who is calling ----

// Every named agent's pane, by machine, from the last sync.
let panes = new Map<string, string>();
export function setPanes(list: { machine: string; pane: string; name: string }[], keep: (machine: string) => boolean = () => false) {
  const next = new Map([...panes].filter(([k]) => keep(k.slice(0, k.indexOf(" ")))));
  for (const a of list) next.set(`${a.machine} ${a.pane}`, a.name);
  panes = next;
}
// The agent in a pane: on the machine given, else this machine's, else any machine's.
export function agentAt(pane: string, machine?: string | null): string | null {
  if (!pane) return null;
  if (machine) return panes.get(`${machine} ${pane}`) ?? null;
  const local = panes.get(`${LOCAL} ${pane}`);
  if (local) return local;
  for (const [k, name] of panes) if (k.slice(k.indexOf(" ") + 1) === pane) return name;
  return null;
}

export function callerOf(req: Request, body?: any, url?: URL): Caller {
  const agent = agentAt(req.headers.get("x-hud-pane") ?? "", req.headers.get("x-hud-machine"));
  const detected = floorOfHq(agent) ?? (agent && laneFloor(agent) && floorOf(laneFloor(agent)) ? laneFloor(agent)! : firstFloor());
  const given = req.headers.get("x-hud-floor") || (body && typeof body === "object" && body.floor ? String(body.floor) : "") || url?.searchParams.get("floor") || "";
  if (given === "all") return { floor: detected, explicit: null, all: true, agent };
  if (given) mustFloor(given);
  return { floor: given || detected, explicit: given || null, all: false, agent };
}

// ---- the owner's writes (hud floor, or the page) ----

function checkHq(agent: unknown, except?: string) {
  const hq = String(agent ?? "").trim();
  if (!hq) throw new Error("a floor needs its HQ agent: --hq AGENT (its name in herdr)");
  const taken = floorList().find((f) => f.hq === hq && f.id !== except);
  if (taken) throw new Error(`${hq} is already the HQ of floor ${taken.id}: one HQ runs one floor`);
  return hq;
}
// A colour asked for, as the floor gets it: never red, amber or green, and not one another floor wears while one is free.
function checkColor(color: unknown, except?: string) {
  const c = String(color ?? "").trim();
  if (!COLOR.test(c)) throw new Error("a colour is #rrggbb, such as #4a90d9");
  return freeColor(c, floorList().filter((f) => f.id !== except).map((f) => f.color));
}

// A new floor as asked for, checked but not yet stored: { id, name, color, hq }. With `start` its HQ is the one the
// server starts for it (floor-start.ts): hq-<id>.
export function newFloor(body: any, start = false) {
  const id = String(body.id ?? "").trim();
  if (!FLOOR_ID.test(id) || id === "all") throw new Error("a floor's id is 1 to 32 lowercase letters, digits and dashes, such as backend (and not all)");
  if (floorOf(id)) throw new Error(`floor ${id} exists: hud floor set ${id} changes it`);
  const n = floorList().length;
  return {
    id,
    name: String(body.name ?? "").trim() || id,
    color: body.color ? checkColor(body.color) : COLORS.find((c) => !floorList().some((f) => f.color === c)) ?? COLORS[n % COLORS.length],
    hq: checkHq(start ? `hq-${id}` : body.hq),
  };
}
export function addFloor(body: any) {
  const f = newFloor(body);
  insertFloor(f);
  return floorOf(f.id)!;
}
export function insertFloor(f: { id: string; name: string; color: string; hq: string }) {
  const position = ((db.query("SELECT MAX(position) AS p FROM floors").get() as { p: number | null }).p ?? -1) + 1;
  db.query("INSERT INTO floors (id, name, color, hq, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(f.id, f.name, f.color, f.hq, position, Date.now());
  return floorOf(f.id)!;
}

// Returns whether the floor's HQ changed (its link starts over).
export function setFloor(id: string, body: any) {
  const f = mustFloor(id);
  let hqChanged = false;
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new Error("a floor's name cannot be empty");
    db.query("UPDATE floors SET name = ? WHERE id = ?").run(name, f.id);
  }
  if (body.color !== undefined) db.query("UPDATE floors SET color = ? WHERE id = ?").run(checkColor(body.color, f.id), f.id);
  if (body.hq !== undefined) {
    const hq = checkHq(body.hq, f.id);
    if (hq !== f.hq) {
      db.query("UPDATE floors SET hq = ?, hq_pane = NULL, hq_seen_at = NULL WHERE id = ?").run(hq, f.id);
      hqChanged = true;
    }
  }
  return hqChanged;
}

// Only a floor with no work goes: no lanes, no open question, no open room, no open board item. What was held for its
// HQ (it never took it) moves to the first floor's HQ, marked as meant for this floor; what its HQ's owner already
// read is dropped. What it leaves behind (answered questions, updates, notes, the log) moves to the first floor too.
export function removeFloor(id: string) {
  const f = mustFloor(id);
  if (floorList().length === 1) throw new Error("the last floor cannot go");
  const count = (sql: string) => (db.query(sql).get(f.id) as { n: number }).n;
  const left = [
    [count("SELECT COUNT(*) AS n FROM lanes WHERE floor = ?"), "lanes"],
    [count("SELECT COUNT(*) AS n FROM asks WHERE floor = ? AND status = 'open'"), "open questions"],
    [count("SELECT COUNT(*) AS n FROM rooms WHERE floor = ? AND archived_at IS NULL"), "open rooms"],
    [count("SELECT COUNT(*) AS n FROM work_items WHERE floor = ? AND done_at IS NULL"), "open board items"],
  ].filter(([n]) => n) as [number, string][];
  if (left.length) throw new Error(`floor ${f.id} is not empty: ${left.map(([n, what]) => `${n} ${what}`).join(", ")}. Move lanes with hud lane NAME --floor OTHER first`);
  let moved = 0, dropped = 0;
  db.transaction(() => {
    db.query("DELETE FROM floors WHERE id = ?").run(f.id);
    const to = firstFloor();
    const now = Date.now();
    for (const row of db.query("SELECT id, ref, text FROM hq_outbox WHERE floor = ? AND sent_at IS NULL").all(f.id) as { id: number; ref: string | null; text: string }[]) {
      // The owner's words (a note, an answer) move; a notice meant only for that floor's HQ (its guide), or something
      // already read, is dropped.
      if (!row.ref || readAlready(row.ref)) {
        db.query("UPDATE hq_outbox SET sent_at = ?, confirmed_at = ?, error = 'not delivered: its floor was removed' WHERE id = ?").run(now, now, row.id);
        dropped += 1;
      } else {
        db.query("UPDATE hq_outbox SET floor = ?, text = ?, error = NULL, resend = 0 WHERE id = ?").run(to, `(meant for floor ${f.name}, whose HQ never got it) ${row.text}`, row.id);
        moved += 1;
      }
    }
    for (const t of ["asks", "updates", "notes", "rooms", "hq_outbox", "events", "work_items"]) db.query(`UPDATE ${t} SET floor = ? WHERE floor = ?`).run(to, f.id);
  })();
  event("hud", `floor ${f.id} removed: ${moved} held ${moved === 1 ? "message" : "messages"} moved to ${firstFloor()}, ${dropped} dropped (already read, or only for its HQ)`);
}

// A note or an answer HQ has already read (acked): nothing to deliver.
function readAlready(ref: string | null) {
  const [kind, id] = (ref ?? "").split(":");
  const table = kind === "note" ? "notes" : kind === "ask" ? "asks" : null;
  return !!table && !!(db.query(`SELECT acked_at FROM ${table} WHERE id = ?`).get(Number(id)) as { acked_at: number | null } | null)?.acked_at;
}

// The three readings the owner reads at a glance, for one floor or the whole office (docs/floors.md, "Three
// readings"): what waits on the owner (blocking: open questions and TO DOs, and since when), whether work is
// happening (working: lanes herdr says are working or that have background work; active: lanes not done or parked),
// and, for NOTHING MOVING, since when nothing has worked (idleSince: null while a lane works; else the latest time a
// lane stopped working, else the last time a lane changed, else when the floor was made). Plus the floor's lanes
// blocked on a prompt, all its lanes and its unread updates from HQ.
type LaneRow = { phase: string; herdr: string | null; herdr_since: number | null; bg: string | null; prompt: string | null; updated_at: number | null };
export function readingsOf(lanes: LaneRow[], waits: number[], unreadMessages: number, since: number) {
  // Working is lanes.ts laneStatus's "moving": not at a prompt, and herdr working or background work.
  const working = lanes.filter((l) => !l.prompt && (l.herdr === "working" || !!l.bg)).length;
  const live = lanes.filter((l) => l.phase !== "done" && l.phase !== "parked");
  const latest = (xs: (number | null)[]) => xs.reduce<number | null>((m, x) => (x && (!m || x > m) ? x : m), null);
  return {
    blocking: waits.length,
    needsYou: waits.length,
    oldestWaitAt: waits.length ? Math.min(...waits) : null,
    working,
    active: live.length,
    idleSince: working ? null : latest(live.map((l) => l.herdr_since)) ?? latest(lanes.map((l) => l.updated_at)) ?? since,
    blocked: lanes.filter((l) => l.prompt).length,
    lanes: lanes.length,
    unreadMessages,
  };
}
const LANE_COLS = "phase, herdr, herdr_since, bg, prompt, updated_at";
export function floorCounts(id: string) {
  const f = floorOf(id);
  return readingsOf(
    db.query(`SELECT ${LANE_COLS} FROM lanes WHERE floor = ?`).all(id) as LaneRow[],
    (db.query("SELECT created_at AS at FROM asks WHERE floor = ? AND status = 'open'").all(id) as { at: number }[]).map((r) => r.at),
    (db.query("SELECT COUNT(*) AS n FROM updates WHERE floor = ? AND read_at IS NULL").get(id) as { n: number }).n,
    f?.created_at ?? Date.now(),
  );
}
// The same for the whole office: every floor's lanes and questions.
export function officeCounts() {
  const first = floorOf(firstFloor());
  return readingsOf(
    db.query(`SELECT ${LANE_COLS} FROM lanes`).all() as LaneRow[],
    (db.query("SELECT created_at AS at FROM asks WHERE status = 'open'").all() as { at: number }[]).map((r) => r.at),
    (db.query("SELECT COUNT(*) AS n FROM updates WHERE read_at IS NULL").get() as { n: number }).n,
    first?.created_at ?? Date.now(),
  );
}
