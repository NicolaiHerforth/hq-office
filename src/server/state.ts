// /api/state: everything the page draws, in one object, made of parts. A feature adds its part with addStatePart.
//
// A part says what it reads, so that it is built only when that changed (docs/footprint.md, "A push"):
//   { tables }          rows of those tables of hud.db and nothing else: built again only after a write to one;
//   { tables, minute }  the same, and the clock in a way a minute cannot show (a 24-hour window);
//   { tables, also }    the same, and something else that says when it changed (the secrets a text is masked with);
//   "live"              anything else: memory, files, the clock, another database. Built every time. The default,
//                       and the right word whenever in doubt: a part that reads more than it says goes stale.
import { CONFIG, whoOf } from "./config.ts";
import { db } from "./db.ts";
import type { Ask, Lane } from "./types.ts";
import { secrets, version } from "./push.ts";
import { herdrSeen, lastSync, untracked } from "./herdr.ts";
import { laneStatus, withTree } from "./lanes.ts";
import { score } from "./score.ts";
import { pageStamp } from "./page.ts";
import { machineHealth } from "./machines.ts";
import { board } from "./work-board.ts";
import { tablesStamp } from "./db-stamp.ts";

export type Reads = "live" | { tables: string[]; minute?: boolean; also?: () => unknown };
type Part = { key: string; build: () => unknown; reads: Reads };

const parse = (a: Ask) => ({ ...a, options: a.options ? JSON.parse(a.options) : [], secrets: a.secrets ? JSON.parse(a.secrets) : [] });
const openAsks = () => db.query("SELECT * FROM asks WHERE status = 'open' ORDER BY COALESCE(due, 9e15), created_at").all() as Ask[];

// The parts every state has, in the order /api/state has always listed them.
const head: Part[] = [
  { key: "now", reads: "live", build: () => Date.now() },
  { key: "version", reads: "live", build: () => version },
  // A lane's status counts its open questions and reads the clock (stale after a while).
  { key: "lanes", reads: "live", build: () => {
    const now = Date.now();
    const openByLane = new Map((db.query("SELECT lane, COUNT(*) AS n FROM asks WHERE status = 'open' AND lane IS NOT NULL GROUP BY lane").all() as { lane: string; n: number }[]).map((r) => [r.lane, r.n]));
    return withTree(db.query("SELECT * FROM lanes ORDER BY name").all() as Lane[]).map((l) => ({ ...l, herdr_seen: herdrSeen.get(l.name) ?? l.herdr_seen, status: laneStatus(l, openByLane, now), asks: openByLane.get(l.name) ?? 0 }));
  } },
  { key: "open", reads: { tables: ["asks"] }, build: () => openAsks().map(parse) },
  { key: "answered", reads: { tables: ["asks"], minute: true }, build: () =>
    (db.query("SELECT * FROM asks WHERE status != 'open' AND COALESCE(answered_at, created_at) >= ? ORDER BY answered_at DESC LIMIT 40").all(Date.now() - 24 * 3600_000) as Ask[]).map(parse) },
  { key: "notes", reads: { tables: ["notes"] }, build: () => db.query("SELECT * FROM notes ORDER BY at DESC LIMIT 20").all() },
  { key: "updates", reads: { tables: ["updates"] }, build: () => db.query("SELECT * FROM updates ORDER BY at DESC, id DESC LIMIT 40").all() },
  { key: "updatesUnread", reads: { tables: ["updates"] }, build: () => (db.query("SELECT COUNT(*) AS n FROM updates WHERE read_at IS NULL").get() as { n: number }).n },
  { key: "events", reads: { tables: ["events"] }, build: () => (db.query("SELECT * FROM events ORDER BY at DESC LIMIT 60").all() as { who: string }[]).map((e) => ({ ...e, who: whoOf(e.who) })) },
  { key: "score", reads: "live", build: () => score(Date.now()) },
  { key: "untracked", reads: "live", build: () => untracked },
  { key: "sync", reads: "live", build: () => lastSync },
  { key: "page", reads: "live", build: () => pageStamp() },
  { key: "config", reads: "live", build: () => CONFIG },
  { key: "machines", reads: "live", build: () => machineHealth() },
];
// What features add, in the order they were added.
const added = new Map<string, Part>();
// A feature adds its own part of the state here instead of editing this file: addStatePart("rooms", () => roomsView()).
// `reads` is "live" unless the part reads nothing but the tables it names (see the top of this file).
export function addStatePart(key: string, build: () => unknown, reads: Reads = "live") {
  added.set(key, { key, build, reads });
}
const tail: Part[] = [
  { key: "secrets", reads: "live", build: () => secrets.list() },
  // The work board reads the clock (stalled after a while), GitHub's facts and the database.
  { key: "board", reads: "live", build: () => board.view() },
];

// A part that reads only some tables keeps its value until one of them is written to.
const kept = new Map<string, { at: string; value: unknown }>();
export const partBuilds = new Map<string, number>();
function valueOf(p: Part, minute: number) {
  const at = p.reads === "live" ? null : `${tablesStamp(p.reads.tables)}${p.reads.minute ? `@${minute}` : ""}${p.reads.also ? `+${p.reads.also()}` : ""}`;
  const hit = at === null ? undefined : kept.get(p.key);
  if (hit && hit.at === at) return hit.value;
  const value = p.build();
  partBuilds.set(p.key, (partBuilds.get(p.key) ?? 0) + 1);
  if (at !== null) kept.set(p.key, { at, value });
  return value;
}

// The parts by name, each built when it is first read, in the order of /api/state. `only` leaves the others unbuilt.
// A kept part's value is the same object from one call to the next, so nobody may change what this returns.
export function stateParts(only?: (key: string) => boolean): [string, unknown][] {
  const minute = Math.floor(Date.now() / 60_000);
  // A feature's part with the name of an earlier one takes its place, as it always did.
  const parts = new Map<string, Part>();
  for (const p of [...head, ...added.values(), ...tail]) parts.set(p.key, p);
  return [...parts.values()].filter((p) => !only || only(p.key)).map((p) => [p.key, valueOf(p, minute)]);
}

export function state() {
  return Object.fromEntries(stateParts()) as Record<string, any>;
}
