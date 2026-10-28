// FLOORS: one HQ agent and everything it runs. Each floor's HQ files its own questions, updates, lanes, rooms and
// board items, reads its own inbox, and is the one the owner's answers and notes for that floor are typed into.
// One floor (what the upgrade makes in db.ts) behaves exactly as before floors existed. See docs/floors.md.
//
// Who is calling: hud sends x-hud-pane ($HERDR_PANE_ID) and x-hud-machine; the server knows every named agent's pane
// from the last herdr sync (setPanes). A floor's HQ is on its floor, a lane is on its lane's floor, anyone else is on
// the first floor; an explicit floor (x-hud-floor, or floor in the body or the query) wins over all of these.
import { LOCAL } from "./config.ts";
import { db } from "./db.ts";

export type Floor = { id: string; name: string; color: string; hq: string; position: number; created_at: number; hq_pane: string | null; hq_seen_at: number | null };
export type Caller = { floor: string; explicit: string | null; all: boolean; agent: string | null };

// The first floor's HQ when none is stored: the setting, as before floors.
const ENV_HQ = process.env.HUD_HQ_AGENT || "hq";
const FLOOR_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
// Colours for floors added without one, in turn.
const COLORS = ["#e0b040", "#4a90d9", "#d9534f", "#5cb85c", "#9b59b6", "#e67e22", "#1abc9c", "#c0392b"];

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
function checkColor(color: unknown) {
  const c = String(color ?? "").trim();
  if (!COLOR.test(c)) throw new Error("a colour is #rrggbb, such as #4a90d9");
  return c.toLowerCase();
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
    color: body.color ? checkColor(body.color) : COLORS[n % COLORS.length],
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
  if (body.color !== undefined) db.query("UPDATE floors SET color = ? WHERE id = ?").run(checkColor(body.color), f.id);
  if (body.hq !== undefined) {
    const hq = checkHq(body.hq, f.id);
    if (hq !== f.hq) {
      db.query("UPDATE floors SET hq = ?, hq_pane = NULL, hq_seen_at = NULL WHERE id = ?").run(hq, f.id);
      hqChanged = true;
    }
  }
  return hqChanged;
}

// Only an empty floor goes: no lanes, no open question, no open room, no open board item and nothing held for its
// HQ. What it leaves behind (answered questions, updates, notes, the log) moves to the first floor that stays.
export function removeFloor(id: string) {
  const f = mustFloor(id);
  if (floorList().length === 1) throw new Error("the last floor cannot go");
  const count = (sql: string) => (db.query(sql).get(f.id) as { n: number }).n;
  const left = [
    [count("SELECT COUNT(*) AS n FROM lanes WHERE floor = ?"), "lanes"],
    [count("SELECT COUNT(*) AS n FROM asks WHERE floor = ? AND status = 'open'"), "open questions"],
    [count("SELECT COUNT(*) AS n FROM rooms WHERE floor = ? AND archived_at IS NULL"), "open rooms"],
    [count("SELECT COUNT(*) AS n FROM work_items WHERE floor = ? AND done_at IS NULL"), "open board items"],
    [count("SELECT COUNT(*) AS n FROM hq_outbox WHERE floor = ? AND sent_at IS NULL"), "messages held for its HQ"],
  ].filter(([n]) => n) as [number, string][];
  if (left.length) throw new Error(`floor ${f.id} is not empty: ${left.map(([n, what]) => `${n} ${what}`).join(", ")}. Move lanes with hud lane NAME --floor OTHER first`);
  db.transaction(() => {
    db.query("DELETE FROM floors WHERE id = ?").run(f.id);
    const to = firstFloor();
    for (const t of ["asks", "updates", "notes", "rooms", "hq_outbox", "events", "work_items"]) db.query(`UPDATE ${t} SET floor = ? WHERE floor = ?`).run(to, f.id);
  })();
}

// What a floor's tile counts.
export function floorCounts(id: string) {
  const n = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
  return {
    needsYou: n("SELECT COUNT(*) AS n FROM asks WHERE floor = ? AND status = 'open'"),
    blocked: n("SELECT COUNT(*) AS n FROM lanes WHERE floor = ? AND prompt IS NOT NULL"),
    working: n("SELECT COUNT(*) AS n FROM lanes WHERE floor = ? AND (herdr = 'working' OR bg IS NOT NULL)"),
    lanes: n("SELECT COUNT(*) AS n FROM lanes WHERE floor = ?"),
    unreadMessages: n("SELECT COUNT(*) AS n FROM updates WHERE floor = ? AND read_at IS NULL"),
  };
}
