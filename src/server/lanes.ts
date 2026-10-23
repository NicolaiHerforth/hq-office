// Lanes: their status as the page shows it, and HQ's writes to them.
import { OWNER, STALE_MS, whoOf } from "./config.ts";
import { db } from "./db.ts";
import type { Lane } from "./types.ts";
import { event } from "./events.ts";

export function laneStatus(lane: Lane, openByLane: Map<string, number>, now: number): string {
  if (openByLane.get(lane.name)) return "needs_you";
  if (lane.phase === "done" || lane.phase === "parked") return lane.phase;
  if (lane.phase === "waiting") return "waiting";
  if (lane.herdr === "working" || lane.bg) return "moving"; // an idle agent with shells or a monitor still running is working
  if (lane.herdr === "gone") return "gone";
  if (lane.herdr_since && now - lane.herdr_since > STALE_MS) return "stale";
  return "hq_turn";
}


const LANE_FIELDS = ["title", "machine", "pane", "issue", "pr", "phase", "note"] as const;

export function upsertLane(body: any) {
  if (!body.name) throw new Error("name is required");
  const now = Date.now();
  db.query("INSERT INTO lanes (name, updated_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").run(body.name, now);
  for (const f of LANE_FIELDS) {
    if (body[f] !== undefined) db.query(`UPDATE lanes SET ${f} = ?, updated_at = ? WHERE name = ?`).run(body[f] === "" ? null : body[f], now, body.name);
  }
  if (body.role !== undefined || body.projects !== undefined) setLaneMeta(body.name, body.role, body.projects, now);
  if (body.note || body.phase) event("hq", [body.phase && `phase ${body.phase}`, body.note].filter(Boolean).join(": "), body.name);
}

// A lane's role and projects (schema/lane_meta.sql). Each is changed only when given: a role of "" clears it, and a
// projects list replaces the old one ([] clears it). A project is { name, url } or "NAME=URL" or a bare URL.
export const ROLES = ["orchestrator", "pm", "builder", "walker"];
function project(p: any): { name: string; url: string } {
  const text = typeof p === "string" ? p.trim() : "";
  const m = text.match(/^(.*?)\s*=\s*(https?:\/\/\S+)$/);
  const url = String(p?.url ?? m?.[2] ?? (/^https?:\/\//.test(text) ? text : "")).trim();
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error(`a project needs an http(s) link: ${typeof p === "string" ? p : JSON.stringify(p)}`);
  // A bare Linear project link names itself: .../project/deploy-gate-1a2b3c4d/overview -> "deploy gate"
  const slug = url.match(/\/project\/([^/?#]+)/)?.[1]?.replace(/-[0-9a-f]{6,}$/i, "").replace(/-/g, " ");
  const name = String(p?.name ?? m?.[1] ?? "").trim() || slug || url;
  return { name, url };
}
export function setLaneMeta(lane: string, role: unknown, projects: unknown, now = Date.now()) {
  if (role !== undefined && role !== null && role !== "" && !ROLES.includes(String(role).toLowerCase())) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  const list = projects === undefined || projects === null ? undefined : (Array.isArray(projects) ? projects : [projects]).filter((p) => p !== "").map(project);
  db.query("INSERT INTO lane_meta (lane, updated_at) VALUES (?, ?) ON CONFLICT(lane) DO NOTHING").run(lane, now);
  if (role !== undefined) db.query("UPDATE lane_meta SET role = ?, updated_at = ? WHERE lane = ?").run(role ? String(role).toLowerCase() : null, now, lane);
  if (list !== undefined) db.query("UPDATE lane_meta SET projects = ?, updated_at = ? WHERE lane = ?").run(list.length ? JSON.stringify(list) : null, now, lane);
}

// One lane's messages, oldest first: HQ's updates about it, its events (questions asked and answered, phases, the
// board), and the owner's replies to those updates. An update's own "update: ..." event is left out: the update says it.
const REPLY = /^re: #u(\d+)(?: \("[^"\n]*"\))?[ \t]*/;
export function laneStream(name: string, limit = 80) {
  const updates = db.query("SELECT id, at, title, body, read_at FROM updates WHERE lane = ? ORDER BY at DESC, id DESC LIMIT ?").all(name, limit) as { id: number; at: number; title: string; body: string | null; read_at: number | null }[];
  const events = db.query("SELECT id, at, who, text FROM events WHERE lane = ? AND text NOT LIKE 'update: %' ORDER BY at DESC, id DESC LIMIT ?").all(name, limit) as { id: number; at: number; who: string; text: string }[];
  const ids = new Set(updates.map((u) => u.id));
  const replies = ids.size
    ? (db.query("SELECT id, at, text, acked_at FROM notes WHERE text LIKE 're: #u%' ORDER BY at DESC LIMIT 500").all() as { id: number; at: number; text: string; acked_at: number | null }[])
        .map((n) => ({ n, m: n.text.match(REPLY) }))
        .filter(({ m }) => m && ids.has(Number(m[1])))
    : [];
  return [
    ...updates.map((u) => ({ key: `u${u.id}`, at: u.at, who: "hq", title: u.title, text: u.body ?? "", read: !!u.read_at })),
    ...events.map((e) => ({ key: `e${e.id}`, at: e.at, who: whoOf(e.who) === OWNER ? "you" : whoOf(e.who), text: e.text })),
    ...replies.map(({ n, m }) => ({ key: `n${n.id}`, at: n.at, who: "you", to: `u${m![1]}`, text: n.text.slice(m![0].length), acked: !!n.acked_at })),
  ]
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
    .slice(-limit);
}
