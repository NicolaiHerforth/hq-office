// Floors and the scope, as pure functions of S (the last /api/state): which floors there are, which lane is on which,
// what a scope lets through, and the counts and lines every panel shows for it. No DOM, so `bun test` imports it.
// A floor is a lane that directs leads (src/lane-tree.ts decides which; the state's lanes carry `floor` and `heads`).

export const HQ = "hq";
// In order, from HQ's floor on; they repeat after five. The colours belong to the page, not the server.
export const FLOOR_COLORS = ["#3c6fd6", "#2f9e57", "#c07a12", "#b8327a", "#7a4fc9"];

const lanesOf = (S) => S?.lanes ?? [];
const floorOf = (l) => l.floor ?? HQ;

// The floor a module copy belongs to, from its URL or path: /floor/<id>/src/client/... is <id>, anything else is HQ's.
export function floorFromPath(url) {
  let path = String(url ?? "");
  try { path = new URL(path, "http://page.invalid").pathname; } catch {}
  const m = path.match(/^\/floor\/([^/]+)\//);
  if (!m) return HQ;
  try { return decodeURIComponent(m[1]) || HQ; } catch { return m[1]; }
}
// HQ's floor draws on the page's own canvas; every other floor on its own.
export const canvasId = (floor) => (!floor || floor === HQ ? "room" : `room-${floor}`);

// HQ's floor first, then the others by name.
export function floorList(S) {
  const heads = lanesOf(S).filter((l) => l.heads).map((l) => l.name).sort((a, b) => a.localeCompare(b));
  return [HQ, ...heads].map((id, i) => ({ id, label: id === HQ ? "HQ" : id.toUpperCase(), color: FLOOR_COLORS[i % FLOOR_COLORS.length] }));
}
export const hasLane = (S, name) => !!name && lanesOf(S).some((l) => l.name === name);
// A lane that is gone, or none, is on HQ's floor.
export function floorOfLane(S, name) {
  const l = name ? lanesOf(S).find((x) => x.name === name) : null;
  return l ? floorOf(l) : HQ;
}
// The workers of a floor: its lanes except its head, who is the figure at the terminal.
export const floorLanes = (S, floor) => lanesOf(S).filter((l) => floorOf(l) === floor && !l.heads);
// The terminal's label, cut as a worker's name is (room/loop.js).
export function terminalName(S, floor) {
  if (!floor || floor === HQ) return "HQ";
  const name = floor.toUpperCase();
  return name.length > 14 ? name.slice(0, 13) + "…" : name;
}
export const floorTagShown = (S) => floorList(S).length >= 2;
// The tag on a question or an update: its floor's label in the floor's colour. None with one floor, where every row
// would carry the same one. An item with no lane (or a lane that is gone), and your notes, are on HQ's floor.
export function floorTag(S, item) {
  if (!floorTagShown(S)) return null;
  const f = floorList(S).find((x) => x.id === floorOfLane(S, item?.lane));
  return f ? { id: f.id, label: f.label, color: f.color } : null;
}

// What the stage shows. One floor is today's room and adds nothing ("single"). With two or more it is the building,
// every floor at once ("out"), or the floor zoomed into ("in"): the scope's floor decides, so a page loaded with a
// floor in its tab opens zoomed in and any other opens zoomed out.
export function stageMode(S, scope) {
  if (floorList(S).length < 2) return "single";
  return scope.floor ? "in" : "out";
}
// The floors whose rooms draw: all of them in the building, the one zoomed into, HQ's alone with one floor. A floor
// out of sight rests.
export function floorsInView(S, scope) {
  const mode = stageMode(S, scope);
  if (mode === "single") return [HQ];
  return mode === "out" ? floorList(S).map((f) => f.id) : [scope.floor];
}
// The stage bar's buttons: ◀ ALL FLOORS only while zoomed in, BUILDING marked while zoomed out. None with one floor.
export function stageBar(S, scope) {
  const mode = stageMode(S, scope);
  return mode === "single" ? null : { back: mode === "in", building: mode === "out" };
}
// A floor's label in the building: its tag, the questions waiting on you there, and who needs help (worst first).
export function floorLabel(S, id) {
  const f = floorList(S).find((x) => x.id === id) ?? floorList(S)[0];
  return { ...f, waiting: S.open.filter((a) => floorOfLane(S, a.lane) === f.id).length, help: needHelp(S, { floor: f.id, agent: null }) };
}
// The colour of a help state's dot: magenta blocked, red waiting on you, brown stalled, amber waiting on HQ.
export const HELP_COLORS = { blocked: "#b8327a", waiting: "#d63c3c", stalled: "#8b6a45", hq: "#e0901e" };

// Tell HQ goes to HQ in every scope, until other generals exist on the server.
export const tellRecipient = () => "HQ";

// What the lists filter by: nothing under SHOW ALL.
export const viewOf = (scope) => (scope.all ? { floor: null, agent: null } : { floor: scope.floor, agent: scope.agent });
// An item with a `lane` (an ask, an update) is in scope when it is the agent's, or on the floor. No lane is HQ's floor.
export function inScope(S, item, view) {
  if (!view || (!view.floor && !view.agent)) return true;
  if (view.agent) return (item.lane ?? null) === view.agent;
  return floorOfLane(S, item.lane) === view.floor;
}

const WAIT_ON_HQ = ["hq_turn", "stale", "gone"];
// The lanes in scope, and the WORKING n/m they make: moving, over those not done or parked. The strip and PARTY both read this.
export const lanesIn = (S, view) => lanesOf(S).filter((l) => inScope(S, { lane: l.name }, view));
export const tally = (lanes) => ({ working: lanes.filter((l) => l.status === "moving").length, live: lanes.filter((l) => !["done", "parked"].includes(l.status)).length });
// Every number the top bar and the tabs show. Unscoped, these are today's numbers.
export function counts(S, view) {
  const scoped = !!(view && (view.floor || view.agent));
  const open = S.open.filter((a) => inScope(S, a, view));
  const lanes = lanesIn(S, view);
  const by = S.updatesUnreadByLane;
  const unread = !scoped || !by ? S.updatesUnread ?? 0 : Object.entries(by).reduce((n, [lane, c]) => n + (inScope(S, { lane: lane || null }, view) ? c : 0), 0);
  return {
    waiting: open.length,
    oldest: open.length ? Math.min(...open.map((a) => a.created_at)) : null,
    ...tally(lanes),
    onHq: lanes.filter((l) => WAIT_ON_HQ.includes(l.status)).length,
    unread,
    otherWaiting: S.open.length - open.length,
    otherUnread: (S.updatesUnread ?? 0) - unread,
  };
}

// The chip's words, or "" when nothing is scoped or SHOW ALL is on. The floor is named only with two or more floors.
export function chipText(S, scope) {
  if (scope.all || (!scope.floor && !scope.agent)) return "";
  const floor = scope.floor && `${floorList(S).find((f) => f.id === scope.floor)?.label ?? scope.floor.toUpperCase()} FLOOR`;
  return [floor, scope.agent].filter(Boolean).join(" › ") + " ✕";
}
const target = (S, scope) => chipText(S, { ...scope, all: false }).replace(/ ✕$/, "").split(" › ").pop();
// The first line of a scoped list: how many are left out and the way to see them (`tail`, SHOW ALL by default); or,
// with SHOW ALL on, the way back. "" when nothing is hidden.
export function othersLine(S, scope, hidden, tail = "SHOW ALL") {
  if (scope.all) {
    if (!scope.floor && !scope.agent) return "";
    return `${floorList(S).length > 1 ? "ALL FLOORS" : "ALL AGENTS"} · ONLY ${target(S, scope)}`;
  }
  if (!hidden || (!scope.floor && !scope.agent)) return "";
  return `+${hidden} ${scope.agent ? "FROM OTHER AGENTS" : "ON OTHER FLOORS"} · ${tail}`;
}
// What an empty scoped list says.
export const nothingLine = (S, scope) => (scope.all || (!scope.floor && !scope.agent) ? "" : `NOTHING FROM ${target(S, scope)} WAITS ON YOU`);

// How much a lane needs the owner or HQ, worst first: blocked > waiting on you > stalled > waiting on HQ.
const HELP = { blocked: "blocked", needs_you: "waiting", stale: "stalled", hq_turn: "hq" };
export const helpState = (lane) => HELP[lane.status] ?? null;
const HELP_ORDER = ["blocked", "waiting", "stalled", "hq"];
// The lanes in scope that need help, worst first, then by name.
// A floor's general is idle while its PMs work, which is its normal state: waiting on HQ, and after 15 idle minutes the
// server calls that stalled too. So it needs help only when it is blocked or waiting on the owner. Then it counts as any
// agent does: a NEED HELP row, a dot on its floor's tile, and a marker at its terminal.
const generalNeedsHelp = (l) => ["blocked", "waiting"].includes(helpState(l));
const needsHelp = (l) => (l.heads ? generalNeedsHelp(l) : !!helpState(l));
export function needHelp(S, view) {
  return lanesOf(S)
    .filter((l) => needsHelp(l) && inScope(S, { lane: l.name }, view))
    .sort((a, b) => HELP_ORDER.indexOf(helpState(a)) - HELP_ORDER.indexOf(helpState(b)) || a.name.localeCompare(b.name))
    .map((l) => ({ lane: l.name, state: helpState(l) }));
}
// The NEED HELP strip: a count, its rows, and whether it can be pressed. Nobody needing help is disabled with no rows.
export function helpStrip(S, view) {
  const rows = needHelp(S, view);
  return { count: rows.length, rows, disabled: !rows.length };
}

// ---- the layer: markers beside the agents that need help, project frames on the wall, and the NEED HELP strip ----

export const HELP_NAMES = { blocked: "BLOCKED AT A PROMPT", waiting: "WAITING ON YOU", stalled: "STALLED", hq: "WAITING ON HQ" };
// Who gets a marker on a floor, worst first. Zoomed out, every agent that needs help: the names are too small to read
// there, so the marker is the signal. Zoomed in, the room already shows a "!" over a worker waiting on you and a "?"
// over one waiting on HQ, so only what it cannot tell apart is marked: blocked at a prompt, and stalled. The general at
// the terminal has no bubble of its own, so it is marked whenever it needs help (generalNeedsHelp), at either zoom.
export function helpMarks(S, floor, zoomedIn) {
  return lanesOf(S)
    .filter((l) => floorOf(l) === floor && needsHelp(l) && (!zoomedIn || l.heads || ["blocked", "stalled"].includes(helpState(l))))
    .map((l) => ({ lane: l.name, state: helpState(l), head: !!l.heads }))
    .sort((a, b) => HELP_ORDER.indexOf(a.state) - HELP_ORDER.indexOf(b.state) || a.lane.localeCompare(b.lane));
}

// A project is a conference room (S.rooms). It hangs on the floor of its owner's lane, and a lane that is gone, or HQ
// itself, is HQ's floor. Archived rooms are not on the wall.
export const roomLanes = (room) => [room.owner, ...(room.members ?? [])];
const boardItems = (S, room) => (S.board?.items ?? []).filter((i) => room.issues?.includes(i.issue) || i.prs?.some((p) => room.prs?.includes(p.key)));
// The open questions about the room: the ones that name it (hud ask --room). A deferred question is not in S.open, so it
// is not counted. A question of the room's lanes that names no room is not the project's, and never counted. Frames,
// RUNDOWN and the project panel all count with this one function, so they agree.
export const roomCalls = (S, room) => S.open.filter((a) => a.room === room.slug);
const BOARD_STATE = { owner: "waiting", blocked: "blocked", stalled: "stalled", ci: "ci" };
const PROJECT_ORDER = ["waiting", "blocked", "stalled", "ci"];
// The colour of a project's state: the help colours for the three that need someone, blue while CI runs, green when it moves.
export const PROJECT_COLORS = { waiting: HELP_COLORS.waiting, blocked: HELP_COLORS.blocked, stalled: HELP_COLORS.stalled, ci: "#3c6fd6", moving: "#2f9e57" };
export const PROJECT_NAMES = { waiting: "WAITING ON YOU", blocked: "BLOCKED AT A PROMPT", stalled: "STALLED", ci: "WAITING ON CI", moving: "MOVING" };
// The most urgent thing about a project: something about it waits on you (a question that names its room, or its linked
// work waiting on you on the board), then a lane blocked at a prompt, then stalled (a lane idle too long, or its work on
// the board), then CI running, else it moves. Red means "something about this project waits on you": a question, which
// the count shows, or a board item, which it does not, so a red frame can read 0. A room lane waiting on you without a
// question that names the room leaves the project its other state.
export function projectState(S, room) {
  const found = new Set();
  for (const name of roomLanes(room)) {
    const l = lanesOf(S).find((x) => x.name === name), h = l && helpState(l);
    if (h && h !== "hq" && h !== "waiting") found.add(h);
  }
  if (roomCalls(S, room).length) found.add("waiting");
  for (const i of boardItems(S, room)) if (BOARD_STATE[i.state]) found.add(BOARD_STATE[i.state]);
  return PROJECT_ORDER.find((s) => found.has(s)) ?? "moving";
}
export const FRAMES_MAX = 7;
// The open rooms that hang on a floor, oldest first.
export const openRooms = (S, floor) =>
  (S.rooms ?? [])
    .filter((r) => !r.archivedAt && floorOfLane(S, r.owner) === floor)
    .sort((a, b) => a.createdAt - b.createdAt || a.slug.localeCompare(b.slug));
// The ones the wall hangs: at most seven (the wall has seven places).
export const floorRooms = (S, floor) => openRooms(S, floor).slice(0, FRAMES_MAX);
// A floor's frames, in wall order: the room, its state and colour, and how many questions about it wait on you.
export function frames(S, floor) {
  return floorRooms(S, floor).map((r) => {
    const state = projectState(S, r);
    return { slug: r.slug, title: r.title, state, color: PROJECT_COLORS[state], calls: roomCalls(S, r).length };
  });
}
// What a frame's button says: the project, its state and how many questions about it wait on you.
export const frameName = (f) => `${f.title}: ${PROJECT_NAMES[f.state]}${f.calls ? `, ${f.calls} for you` : ""}`;

// ---- RUNDOWN and PARTY: the panels over the room ----

// The floors a scope shows: the floor zoomed into, the chosen agent's floor, or all of them, HQ's first.
function viewFloors(S, view) {
  const all = floorList(S);
  const at = view?.agent ? floorOfLane(S, view.agent) : view?.floor;
  return at ? all.filter((f) => f.id === at) : all;
}
export const BRIEF_MAX = 280;
// A brief as one short run of words: the whitespace folded, cut at BRIEF_MAX. Null when it says nothing.
export function briefExcerpt(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return !t ? null : t.length > BRIEF_MAX ? t.slice(0, BRIEF_MAX - 1).trimEnd() + "…" : t;
}
// RUNDOWN: for each floor in scope, who needs help there and each open project with its state, its owner, how many
// questions about it wait on you, the thread's last line, when it last moved and its brief. `briefs` maps a slug to the brief's text, once the page has fetched it
// (S.rooms carries only when it was set). A project with no brief has none: nothing stands in for it.
export function rundown(S, view, briefs = {}) {
  return viewFloors(S, view).map((f) => ({
    ...f,
    help: needHelp(S, { floor: f.id, agent: null }),
    projects: openRooms(S, f.id).map((r) => {
      const state = projectState(S, r);
      return { slug: r.slug, title: r.title, owner: r.owner, state, color: PROJECT_COLORS[state], name: PROJECT_NAMES[state], calls: roomCalls(S, r).length, last: r.last ? { who: r.last.who, to: r.last.to, text: r.last.text } : null, at: r.lastAt ?? r.createdAt, brief: briefExcerpt(briefs[r.slug]) };
    }),
  }));
}
// PARTY: the lanes in scope by floor, HQ's first (a floor with none in scope is left out), the general first on its floor,
// then by name; and the WORKING n/m the strip shows for the same scope.
export function party(S, view) {
  const lanes = lanesIn(S, view);
  const groups = floorList(S)
    .map((f) => ({ ...f, lanes: lanes.filter((l) => floorOf(l) === f.id).sort((a, b) => !!b.heads - !!a.heads || a.name.localeCompare(b.name)).map((l) => ({ name: l.name, status: l.status, head: !!l.heads, title: l.title ?? "" })) }))
    .filter((g) => g.lanes.length);
  return { groups, ...tally(lanes) };
}

// A scope that still holds: a lane that is gone drops the agent, a floor that is gone zooms out, an agent's floor is
// where the agent is, and one floor has no floor scope. SHOW ALL means nothing with nothing scoped.
export function normalizeScope(S, scope) {
  const floors = floorList(S).map((f) => f.id);
  let { floor, agent, all } = scope;
  if (agent && !hasLane(S, agent)) agent = null;
  if (agent) floor = floors.length >= 2 ? floorOfLane(S, agent) : null;
  else if (!floors.includes(floor) || floors.length < 2) floor = null;
  return { floor, agent, all: !!all && !!(floor || agent) };
}

// Opening MESSAGES marks only the shown updates in scope as read.
export const marksRead = (S, view) => (S.updates ?? []).filter((u) => !u.read_at && inScope(S, u, view)).map((u) => u.id);
// The body of MARK ALL READ: empty unscoped, which marks everything.
export function readAllBody(view) {
  const body = {};
  if (view?.floor) body.floor = view.floor;
  if (view?.agent) body.lane = view.agent;
  return body;
}

// What Escape does: close the panel over the room ("panel"), else step the scope out one level ("out"), else leave the key
// alone (null): nothing is open or scoped, or something else owns it: a conference room on the stage, SETTINGS or a
// dialog, a text field.
export function escapeAction(scope, busy) {
  if (busy.stage || busy.settings || busy.dialog || busy.typing) return null;
  if (busy.panel) return "panel";
  return scope.floor || scope.agent ? "out" : null;
}
// The scope that shows a question: its lane when the state has it, else its floor (a question with no lane is HQ's).
// With one floor there is no floor to scope to.
export const askScope = (S, ask) => ({ floor: floorList(S).length >= 2 ? floorOfLane(S, ask.lane) : null, agent: hasLane(S, ask.lane) ? ask.lane : null, all: false });
// Where a `jump` takes the question panel: with an ask's id, that question; with true, the chosen lane's first open
// question. Null when there is none.
export const jumpAsk = (S, lane, jump = true) => (typeof jump === "number" ? S.open.find((a) => a.id === jump) ?? null : hasLane(S, lane) ? S.open.find((a) => a.lane === lane) ?? null : null);

// ---- links: on a question, and in the project panel ----

const words = (v) => String(v ?? "").split(/[ ,]+/).filter(Boolean);
// An issue or a pull request as a tag: its key, and where it opens (null when the server names no workspace or repo).
export const issueLink = (config, key) => ({ key, href: config?.linearWorkspace ? `https://linear.app/${config.linearWorkspace}/issue/${key}` : null });
export function prLink(config, raw) {
  const key = String(raw).replace(/^#/, ""), num = key.split("#").pop(), repo = key.includes("#") ? key.split("#")[0] : config?.githubRepo;
  return { key, num, href: repo ? `https://github.com/${repo}/pull/${num}` : null };
}
// What a question links to: the open project whose room it names (the rule roomCalls counts by), and its lane's own
// issue and pull requests. No project for a question that names no room or an archived one.
export function askLinks(S, config, ask) {
  const lane = ask?.lane ? lanesOf(S).find((l) => l.name === ask.lane) : null;
  const room = ask?.room ? (S.rooms ?? []).find((r) => r.slug === ask.room && !r.archivedAt) : null;
  return {
    projects: room ? [{ slug: room.slug, title: room.title }] : [],
    issues: words(lane?.issue).map((k) => issueLink(config, k)),
    prs: words(lane?.pr).map((k) => prLink(config, k)),
  };
}

// Everything the project panel shows for a room, or null when there is no such open room.
export function projectView(S, config, slug) {
  const room = (S.rooms ?? []).find((r) => r.slug === slug && !r.archivedAt);
  if (!room) return null;
  const state = projectState(S, room), items = boardItems(S, room);
  return {
    room, state, color: PROJECT_COLORS[state], name: PROJECT_NAMES[state],
    floor: floorOfLane(S, room.owner),
    calls: roomCalls(S, room),
    lanes: roomLanes(room).map((name, i) => {
      const l = lanesOf(S).find((x) => x.name === name);
      return { name, owner: i === 0, title: l?.title ?? "", status: l?.status ?? null, help: l ? helpState(l) : null };
    }),
    issues: room.issues.map((k) => ({ ...issueLink(config, k), board: items.find((i) => i.issue === k) ?? null })),
    prs: room.prs.map((k) => {
      const item = items.find((i) => i.prs.some((p) => p.key === k)) ?? null;
      return { ...prLink(config, k), board: item, pr: item?.prs.find((p) => p.key === k) ?? null };
    }),
  };
}
