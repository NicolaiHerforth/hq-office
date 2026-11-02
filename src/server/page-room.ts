// THE PAGE RUNTIME's room: whoever has a page open right now, the way an artifact's room capability works. A page's
// lobby, and any room it joins by name, holds peers: each view of the page in the HUD (one per HUD tab and page,
// kind "viewer", always the owner), and agents that listen in (hud page room PAGE listen, kind "agent"). A peer sets
// its presence (one small object everyone sees) and sends moments (emit) that every other peer hears. Nothing is
// kept: it lives in this process and is gone when the last peer leaves, or with a restart.
// A HUD tab holds one stream (GET /api/page-runtime/room/events?tab=ID) for all its pages' rooms; its views join,
// emit and set presence with POST /api/page-runtime/room. When the stream closes, the tab's peers leave.
import { PageError } from "./page-runtime.ts";

export const ROOM_LIMITS = { data: 4096, presence: 4096, peers: 64, emitsPerSecond: 20, keys: 64, depth: 8 };
const TOPIC = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z0-9_.:-]{0,64}$/; // "" is the lobby
const PEER = /^[A-Za-z0-9_:-]{1,80}$/;

type Peer = { id: string; tab: string; kind: "viewer" | "agent"; by: string; presence: Record<string, unknown>; updatedAt: number; second: number; sent: number };
type Tab = { send: (event: object) => void; peers: Set<string> }; // peers: room key + "\n" + peer id
const rooms = new Map<string, Map<string, Peer>>(); // page + "\n" + room name -> peers
const tabs = new Map<string, Tab>();
const keyOf = (page: string, room: string) => `${page}\n${room}`;

const bad = (message: string) => new PageError("invalid_argument", message);
function sized(v: unknown, max: number, what: string) {
  let text: string;
  try { text = JSON.stringify(v ?? null); } catch { throw bad(`${what} must be plain JSON`); }
  if (new TextEncoder().encode(text).length > max) throw bad(`${what} is at most ${max / 1024} KiB of JSON`);
  const deep = (x: unknown, d: number): void => {
    if (d > ROOM_LIMITS.depth) throw bad(`${what} is at most ${ROOM_LIMITS.depth} levels deep`);
    if (x && typeof x === "object") {
      const entries = Object.entries(x);
      if (entries.length > ROOM_LIMITS.keys) throw bad(`${what} has at most ${ROOM_LIMITS.keys} keys or entries per object`);
      for (const [, y] of entries) deep(y, d + 1);
    }
  };
  deep(v, 1);
  return JSON.parse(text);
}
const roomName = (v: unknown) => { const n = String(v ?? ""); if (!NAME.test(n)) throw bad("a room's name is up to 64 letters, digits and _ . : -"); return n; };

// What a peer looks like to another: who, what kind, its presence. isMe: every viewer is the owner; sameTab: the same
// HUD tab as the one it is sent to.
const view = (p: Peer, to: Peer | null) => ({ peer: p.id, by: p.by, kind: p.kind, guest: false, isMe: p.kind === "viewer" && to?.kind === "viewer", sameTab: !!to && p.tab === to.tab, presence: p.presence, updatedAt: p.updatedAt });
function tell(room: Map<string, Peer>, page: string, name: string) {
  for (const to of room.values()) tabs.get(to.tab)?.send({ t: "peers", page, room: name, to: to.id, peers: [...room.values()].map((p) => view(p, to)) });
}

// ---- tabs: one stream each ----

// A tab that opens its stream again (EventSource reconnects with the same id) starts over: its views join again. The
// old stream's close only closes the tab it opened.
export const isTabId = (id: string) => PEER.test(id);
export function openTab(id: string, send: (event: object) => void) {
  if (!PEER.test(id)) throw bad("bad tab id");
  closeTab(id);
  const tab: Tab = { send, peers: new Set() };
  tabs.set(id, tab);
  return tab;
}
export function closeTab(id: string, only?: Tab) {
  const tab = tabs.get(id);
  if (!tab || (only && tab !== only)) return;
  tabs.delete(id);
  for (const k of tab.peers) {
    const [page, name, peer] = k.split("\n");
    leave(page, name, peer);
  }
}

// ---- peers ----

export function join(page: string, nameRaw: unknown, peerRaw: unknown, tabId: string, as: { kind: "viewer" | "agent"; by: string }) {
  const name = roomName(nameRaw);
  const id = String(peerRaw ?? "");
  if (!PEER.test(id)) throw bad("bad peer id");
  const tab = tabs.get(tabId);
  if (!tab) throw new PageError("upstream_error", "this view's room stream is not open");
  const k = keyOf(page, name);
  const room = rooms.get(k) ?? new Map<string, Peer>();
  if (!room.has(id) && room.size >= ROOM_LIMITS.peers) throw new PageError("limit_reached", `a room holds at most ${ROOM_LIMITS.peers} peers`);
  room.set(id, { id, tab: tabId, kind: as.kind, by: as.by, presence: room.get(id)?.presence ?? {}, updatedAt: Date.now(), second: 0, sent: 0 });
  rooms.set(k, room);
  tab.peers.add(`${page}\n${name}\n${id}`);
  tell(room, page, name);
}
export function leave(page: string, nameRaw: unknown, peerRaw: unknown) {
  const name = String(nameRaw ?? "");
  const k = keyOf(page, name);
  const room = rooms.get(k);
  const p = room?.get(String(peerRaw));
  if (!room || !p) return;
  room.delete(p.id);
  tabs.get(p.tab)?.peers.delete(`${page}\n${name}\n${p.id}`);
  if (room.size) tell(room, page, name);
  else rooms.delete(k);
}
const member = (page: string, name: string, peer: unknown, tabId: string) => {
  const p = rooms.get(keyOf(page, name))?.get(String(peer));
  if (!p || p.tab !== tabId) throw new PageError("not_permitted", "join the room first");
  return p;
};

export function presence(page: string, nameRaw: unknown, peer: unknown, tabId: string, patch: unknown) {
  const name = roomName(nameRaw);
  const p = member(page, name, peer, tabId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("presence takes an object");
  const next = { ...p.presence };
  for (const [k, v] of Object.entries(patch)) v === null ? delete next[k] : (next[k] = v);
  p.presence = sized(next, ROOM_LIMITS.presence, "presence");
  p.updatedAt = Date.now();
  tell(rooms.get(keyOf(page, name))!, page, name);
}

// A moment, to every other peer in the room. An agent that only speaks (hud page room PAGE emit) need not join.
export function emit(page: string, nameRaw: unknown, from: { peer: unknown; tab: string } | { agent: string }, topicRaw: unknown, dataRaw: unknown) {
  const name = roomName(nameRaw);
  const topic = String(topicRaw ?? "");
  if (!TOPIC.test(topic)) throw bad("a topic is a name: a letter or _, then up to 63 letters, digits, _ or -");
  const data = dataRaw === undefined ? undefined : sized(dataRaw, ROOM_LIMITS.data, "data");
  const room = rooms.get(keyOf(page, name));
  let sender: Peer;
  if ("agent" in from) sender = { id: `agent:${from.agent}`, tab: "", kind: "agent", by: from.agent, presence: {}, updatedAt: Date.now(), second: 0, sent: 0 };
  else sender = member(page, name, from.peer, from.tab);
  const now = Date.now();
  if (now - sender.second >= 1000) { sender.second = now; sender.sent = 0; }
  if (++sender.sent > ROOM_LIMITS.emitsPerSecond) throw new PageError("rate_limited", `at most ${ROOM_LIMITS.emitsPerSecond} messages a second`);
  let heard = 0;
  for (const to of room?.values() ?? []) {
    if (to.id === sender.id) continue;
    tabs.get(to.tab)?.send({ t: "msg", page, room: name, to: to.id, msg: { ...view(sender, to), presence: undefined, updatedAt: undefined, topic, data } });
    heard++;
  }
  return { heard };
}

export const peersOf = (page: string, nameRaw: unknown) => [...(rooms.get(keyOf(page, roomName(nameRaw)))?.values() ?? [])].map((p) => view(p, null));
