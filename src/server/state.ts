// /api/state: everything the page draws, in one object. A feature adds its part with addStatePart.
import { CONFIG, whoOf } from "./config.ts";
import { db } from "./db.ts";
import type { Ask, Lane } from "./types.ts";
import { secrets, version } from "./push.ts";
import { lastSync, untracked } from "./herdr.ts";
import { laneStatus, withTree } from "./lanes.ts";
import { score } from "./score.ts";
import { pageStamp } from "./page.ts";
import { machineHealth } from "./machines.ts";
import { board } from "./work-board.ts";

// What the owner told HQ, newest first, in the page's note shape. Older notes are in the notes table (ids 12); a Tell
// goes to HQ's queue now and is an ask with no lane and a recipient (ids q12, so the two never share a key). Its
// acked_at is set when HQ reads it (hud req next), which is what lights "HQ has it".
function notes() {
  const old = db.query("SELECT id, at, text, acked_at FROM notes ORDER BY at DESC, id DESC LIMIT 20").all();
  const queued = db
    .query("SELECT 'q' || id AS id, created_at AS at, COALESCE(body, title) AS text, acked_at FROM asks WHERE lane IS NULL AND recipient != 'owner' ORDER BY created_at DESC, id DESC LIMIT 20")
    .all();
  return [...old, ...queued].sort((a: any, b: any) => b.at - a.at).slice(0, 20);
}

export function state() {
  const now = Date.now();
  const lanes = db.query("SELECT * FROM lanes ORDER BY name").all() as Lane[];
  const open = db.query("SELECT * FROM asks WHERE status = 'open' AND recipient = 'owner' ORDER BY urgent_at IS NULL, COALESCE(due, 9e15), created_at").all() as Ask[];
  const answered = db
    .query("SELECT * FROM asks WHERE status != 'open' AND recipient = 'owner' AND COALESCE(answered_at, created_at) >= ? ORDER BY answered_at DESC LIMIT 40")
    .all(now - 24 * 3600_000) as Ask[];
  const openByLane = new Map<string, number>();
  for (const a of open) if (a.lane) openByLane.set(a.lane, (openByLane.get(a.lane) ?? 0) + 1);
  const parse = (a: Ask) => ({ ...a, options: a.options ? JSON.parse(a.options) : [], secrets: a.secrets ? JSON.parse(a.secrets) : [] });
  return {
    now,
    version,
    lanes: withTree(lanes).map((l) => ({ ...l, status: laneStatus(l, openByLane, now), asks: openByLane.get(l.name) ?? 0 })),
    open: open.map(parse),
    answered: answered.map(parse),
    notes: notes(),
    updates: db.query("SELECT * FROM updates ORDER BY at DESC, id DESC LIMIT 40").all(),
    updatesUnread: (db.query("SELECT COUNT(*) AS n FROM updates WHERE read_at IS NULL").get() as { n: number }).n,
    events: (db.query("SELECT * FROM events ORDER BY at DESC LIMIT 60").all() as { who: string }[]).map((e) => ({ ...e, who: whoOf(e.who) })),
    score: score(now),
    untracked,
    sync: lastSync,
    page: pageStamp(),
    config: CONFIG,
    machines: machineHealth(),
    ...stateParts(),
    secrets: secrets.list(),
    board: board.view(),
  };
}

// A feature adds its own part of the state here instead of editing state(): addStatePart("board", () => board.view()).
const parts = new Map<string, () => unknown>();
export function addStatePart(key: string, value: () => unknown) {
  parts.set(key, value);
}
function stateParts() {
  return Object.fromEntries([...parts].map(([k, value]) => [k, value()]));
}
