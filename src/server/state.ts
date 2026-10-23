// /api/state: everything the page draws, in one object. A feature adds its part with addStatePart.
import { CONFIG, whoOf } from "./config.ts";
import { db } from "./db.ts";
import type { Ask, Lane } from "./types.ts";
import { secrets, version } from "./push.ts";
import { lastSync, untracked } from "./herdr.ts";
import { laneStatus } from "./lanes.ts";
import { score } from "./score.ts";
import { pageStamp } from "./page.ts";
import { machineHealth } from "./machines.ts";
import { board } from "./work-board.ts";

export function state() {
  const now = Date.now();
  const lanes = db.query("SELECT lanes.*, lane_meta.role, lane_meta.projects FROM lanes LEFT JOIN lane_meta ON lane_meta.lane = lanes.name ORDER BY name").all() as Lane[];
  const open = db.query("SELECT * FROM asks WHERE status = 'open' ORDER BY COALESCE(due, 9e15), created_at").all() as Ask[];
  const answered = db
    .query("SELECT * FROM asks WHERE status != 'open' AND COALESCE(answered_at, created_at) >= ? ORDER BY answered_at DESC LIMIT 40")
    .all(now - 24 * 3600_000) as Ask[];
  const openByLane = new Map<string, number>();
  for (const a of open) if (a.lane) openByLane.set(a.lane, (openByLane.get(a.lane) ?? 0) + 1);
  const parse = (a: Ask) => ({ ...a, options: a.options ? JSON.parse(a.options) : [], secrets: a.secrets ? JSON.parse(a.secrets) : [] });
  return {
    now,
    version,
    lanes: lanes.map((l) => ({ ...l, projects: l.projects ? JSON.parse(l.projects) : [], status: laneStatus(l, openByLane, now) })),
    open: open.map(parse),
    answered: answered.map(parse),
    notes: db.query("SELECT * FROM notes ORDER BY at DESC LIMIT 20").all(),
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
