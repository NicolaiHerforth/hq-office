# Floors

A floor is one HQ agent and everything it runs. One HQ can direct only so many lanes; floors let the owner run
several HQs side by side, each owning a domain (frontend, backend, legal...). One floor behaves exactly as HQ Office
did before floors; the page shows only the floor bar over the office (that floor's tab and + FLOOR), so floors can be
found and added.

The server and `hud` come first; the page is built on the state contract below (see "The page").

## The model

- Table `floors`: `id` (a slug), `name`, `color` (`#rrggbb`), `hq` (the herdr agent that is its HQ), `position`,
  `created_at`, and `hq_pane` / `hq_seen_at` (the pane its HQ was last seen in, for the NAME button and the heal).
- **The upgrade.** At start, with no floors, the server makes the first floor: id and name `hq` / `HQ`, or from
  `HUD_FLOOR_NAME` (its id is the name as a slug), with `HUD_HQ_AGENT` as its HQ and the pane `hq_link` held. Every
  existing row is put on it. Its `hq` is stored empty and read from `HUD_HQ_AGENT`, so that setting keeps working;
  `hud floor set ID --hq AGENT` stores one.
- A `floor` column on `lanes`, `asks`, `updates`, `notes`, `rooms`, `work_items`, `hq_outbox` and `events`.

Shared by every floor: secrets, settings (the sweep settings too), machines and sound.

## Who is calling

`hud` sends `x-hud-pane: $HERDR_PANE_ID`, and `x-hud-machine: $HUD_LOCAL_MACHINE` when it is set. Every sync
records each named agent's pane (by machine). The caller's floor is:

1. an explicit floor: `x-hud-floor` (`hud ... --floor ID`), or `floor` in the body or the query; then
2. the floor whose HQ is the agent in that pane; then
3. the floor of the lane the agent is; then
4. the first floor.

`x-hud-floor: all` (`hud ... --all`) asks for every floor where a read is scoped.

## Which floor a thing belongs to

| Thing | Floor |
| --- | --- |
| Lane | `--floor`, else its parent's floor, else the caller's. Re-registering an existing lane never moves it, except with `--floor` or a `--parent` on another floor. |
| Moving a lane (`hud lane NAME --floor ID`) | Its whole subtree moves, with their open questions, the rooms they own and their board items. A lane whose parent stays behind reports to its new floor's HQ. `--floor` with a `--parent` on another floor is refused. |
| Ask, update | Its lane's floor, else the caller's. `hud update ID --lane L` moves the ask to L's floor. |
| Room | Its owning lane's floor, else the caller's (a room HQ owns keeps its floor when changed). |
| Board item | Its lane's floor; an item with no lane, the floor it was tracked from. |
| Note from the page | `floor` in the body of `POST /api/notes`, else the first floor. |
| Event | The floor given, else its lane's floor; else none. |

## Routing to an HQ

`notifyHq(text, ref, floor)` types into that floor's HQ (the first floor's when none is given):

- an answer, and a NOT YET: the ask's floor;
- a note: the note's floor;
- a lane blocked on a prompt: the lane's floor;
- a room the owner closed: the room's floor; a room message to `hq` goes to the room's floor's HQ;
- a secret the owner sets, and secrets lost in a restart: every floor's HQ;
- `hud floor tell FLOOR TEXT`: that floor's HQ, as `HUD from floor <caller's floor>: TEXT`, with an event line.

## A new floor's HQ: STARTING, never the alarm

A floor other than the first whose HQ herdr has never shown (`floors.hq_seen_at` is null: a new floor, or one given
another HQ) is STARTING. Its link sets no reason, raises no "HQ isn't receiving" event, strip or toast, and types
nothing into it: what is meant for its HQ is held, and goes, in order and confirmed, on the first sync that finds it.
After 2 minutes (`HUD_HQ_STARTING_MS`) it is "not started": a calm note on that floor only. An HQ seen once and then
gone is the alarm, as before. The first floor's HQ is never STARTING: it is the HQ the HUD was set up with.

## Adding a floor

- **An agent that runs** (USE AN AGENT on the page, `hud floor add ID --hq AGENT`): any named agent, a lane too (a lane
  promoted to run a domain). When it runs in herdr on this machine, the HUD sends it the HQ guide for its floor
  (`guideFor` in `src/hq-guide.ts`: the guide, with a line naming the floor it owns) through its outbox.
- **START A NEW HQ** (`POST /api/floors` with `start: true`, `hud floor add ID --start`): the server (`floor-start.ts`)
  reads `herdr agent list` for the first floor's HQ's `workspace_id` and `cwd`, runs
  `herdr tab create --workspace W --cwd C --label "<Name> HQ" --no-focus`, and starts `hq-<id>` in the new tab's root
  pane with `herdr agent start hq-<id> --kind claude --pane P`. Only once herdr says the agent is ready is the floor
  stored, and its HQ sent the guide for its floor. On any failure the tab is closed again, no floor is added, and the
  error is the reply (the page shows it in the panel). An id or agent name that is taken is refused before herdr is
  asked anything.
- **The plugin's greet** (`bin/hud-plugin.ts`, on `pane.agent_detected`) treats every floor's HQ as an HQ: it asks the
  HUD for `GET /api/floors` and sends a floor's HQ the guide for its floor, once per session.

## Per floor, inside the 20 s sync

No new timers. Each sync, for each floor in order: the HQ link (receiving or not, the reason, since when, the
candidate pane for NAME), the quiet rename heal (the pane HQ was tracked in), HQ's herdr status, the outbox flush
with confirmed delivery and resend, and then the sweep nudge. The sweep settings are shared; each floor's HQ is nudged
about its own floor only (its idle and gone lanes, stalled items, open questions, rooms), with its own last nudge,
next nudge and backoff. One floor's HQ not receiving never holds up another's outbox.

## Reading is scoped

By default to the caller's floor, with `--all` for every floor: `hud inbox`, `hud wait`, `hud ack` (another
floor's answer or note is refused without `--all`), `hud board`, `hud tree`, `hud room list` (there `--all` also
lists archived rooms, as before). An HQ never sees another floor's answers or notes in its inbox. `/api/state` is
not scoped: the page gets every floor, each row tagged.

## CLI

```
hud floor add ID --hq AGENT [--name N] [--color #hex]
hud floor add ID --start [--name N] [--color #hex]   the HUD starts its HQ, hq-ID, in a new herdr tab
hud floor list [--json]          id, name, HQ, receiving (or STARTING), lanes, waiting on the owner (* marks your floor)
hud floor set ID [--name N] [--hq AGENT] [--color #hex]
hud floor rm ID                  refused unless the floor is empty (no lanes, open questions, open rooms,
                                 open board items, or messages held for its HQ); the last floor never goes
hud floor tell FLOOR TEXT
hud lane NAME --floor ID
```

A floor's id is 1 to 32 lowercase letters, digits and dashes (not `all`). One agent is the HQ of one floor only.
What a removed floor leaves behind (answered questions, updates, notes, the log) moves to the first floor.

## API

| Route | Body | Reply |
| --- | --- | --- |
| `GET /api/floors` | | `{ floors: S.floors, caller: "<floor id>" }` |
| `GET /api/floors/agents` | | `{ agents: [{ name, machine, status, lane, floor }] }`: herdr's live named agents at the last sync, lanes too, and the floor each runs (null for none) |
| `POST /api/floors` | `{ id, hq, name?, color? }`, or `{ id, name?, color?, start: true }` | `{ id }`, once the floor is stored (with `start`, once its HQ runs) |
| `POST /api/floors/ID` | `{ name?, hq?, color? }`, or `{ rm: true }` | `{ ok: true }`, or `{ floors: [ids] }` after a remove |
| `POST /api/floors/ID/tell` | `{ text }` | `{ ok: true }` |
| `POST /api/notes` | `{ text, floor? }` | `{ ok: true }` |
| `POST /api/hq/check`, `POST /api/hq/name` | `{ floor? }` | that floor's link (the first floor's without one) |
| `POST /api/updates/read-all` | `{ floor? }` | marks that floor's updates read (every floor's without one) |

## State contract for the page

- `S.floors`: an array, by position, of
  `{ id, name, color, hq, receiving: true | false | null, reason, starting, notStarted, counts: { needsYou, blocked, working, lanes, unreadMessages } }`.
  `receiving` is null until the first sync has checked that floor's HQ, and while it is `starting` (its HQ never seen);
  `notStarted` is true once a starting HQ has been waited on for 2 minutes. `needsYou` counts the floor's open
  questions, `blocked` its lanes blocked on a prompt, `working` its lanes at work (herdr working, or something still
  running in the background), `lanes` all its lanes, `unreadMessages` its unread updates from HQ.
- Every lane, open ask, answered ask, update, note, room (`S.rooms[i].floor`) and board item
  (`S.board.items[i].floor`) carries `floor`. Events carry `floor` too (null for one about no floor).
- `S.hq` stays the first floor's link: `{ agent, ok, starting, notStarted, reason, since, candidate, deliveries, held }`.
  `S.hqLinks` maps floor id to the same shape for every floor (the first floor's included); `deliveries` and `held`
  hold that floor's messages only. `ok` is null while the floor is `starting`.
- `S.sweep` keeps its shape (`{ on, minutes, hours, lastAt, nextAt, backoff }`) for the first floor.
  `S.sweepByFloor` maps floor id to `{ lastAt, nextAt, backoff }`.
- `S.board.counts` and `S.board.blockedLanes` count every floor; a page scoped to a floor filters `items` by `floor`.

## The page

One floor (`S.floors` has one entry) is the page as it was before floors, plus the floor bar over the office: that
floor's tab (with EDIT) and + FLOOR. No building, header, frame, chip, tag, scope line or FLOOR select. The room's
pixel and layout test proves the rest is unchanged (`PIXEL_BASE=<ref> bun test test/client/room-pixels.test.ts`): it
leaves the bar out of its style hash, as it leaves out the FLOORS section in SETTINGS. With two or more floors:

- **The floor bar** (`src/client/floors/index.js`), first on the stage: BUILDING, then a tab per floor in its colour
  with its name, its need-you dots (one per open question, the count past five), STARTING or NOT STARTED in amber
  while its new HQ is not up, and a red ! when its HQ was receiving and stopped; the tab of the floor you are in is
  filled with its colour and carries EDIT. Then + FLOOR. A tab enters its floor.
- **Inside a floor**: a header over the office, `◀ ALL FLOORS · <NAME> FLOOR · HQ: <agent> · N need you` (and the
  HQ's state when it is not up), with EDIT; the whole page framed in the floor's colour; a scope chip
  `<NAME> FLOOR ×` under the question tabs; and "+N on other floors · show all" at the top of each list. Esc and the
  chip's × step out one level: SHOW ALL off first, then out to the building (Esc closes the floor panel before
  anything; not while typing, in SETTINGS, a conference room or a preview). The office's workers are that floor's
  lanes (`officeLanes()` in `room/workers.js`), HQ at the terminal is labelled with that floor's HQ, and the room's
  frame takes the floor's colour.
- **THE BUILDING** (`floors/building.js`): a grid of tiles, two to a row (one on a narrow screen), each with the floor's
  name tag in its colour, its need-you count and dots, its HQ's state and ZOOM IN ›, over a still picture of its
  office, and its HQ, lanes and working count under it. The picture is drawn by the room's own code
  (`room/still.js`: the room, the hero, that floor's HQ and a worker per lane where its status puts it, with its bubble
  and name) into the tile's own canvas at half the room's size, and drawn again only when what it shows changes (its
  lanes, their status and rank, its HQ, the theme, the season) and only while the building shows. No frame loop per
  tile and no second copy of the room's modules: only the floor you are in runs the live loop, which rests while the
  building shows. Then a + ADD A FLOOR slot, and the legend: CLICK A FLOOR TO ZOOM IN.
- **The floor panel** (`floors/panel.js`), over the stage (a sheet on a phone): + FLOOR, + ADD A FLOOR and SETTINGS ·
  FLOORS open it to add a floor (a name, a colour from the palette, and its HQ: USE AN AGENT, a select of herdr's live
  named agents that run no floor, read from `GET /api/floors/agents` when it opens, or a name typed; or START A NEW HQ).
  An error from the server shows in the panel and nothing is added. EDIT opens it for one floor: rename, recolour,
  another HQ, or REMOVE an empty floor after a confirm in the page (never a browser dialog).
- **The scope** (`src/client/core/scope.js`): the floor you are in, or none (the building), and SHOW ALL. It is kept in
  sessionStorage, dropped when its floor is gone, and every change emits `scope` on the bus. `listFloor()` is the
  floor the lists show (none in the building or under SHOW ALL), `pick(list)` a list's rows on it by their `floor`,
  `others(list)` how many are left out, `tagged()` whether cards carry their floor's tag, `outOne()` one level out.
  Pure helpers of `S` (the floor list, a floor's HQ link and state, need-you dots, the tag and the scope line) are in
  `core/floors.js`.
- **Lists and counts**: NEEDS YOU, MESSAGES, WORK (and its STALLED strip), ROOMS, FROM HQ and SENT & ANSWERED, and
  the tab counts, follow `listFloor()`. A floor's unread messages count is `S.floors[i].counts.unreadMessages`; WORK
  counts its own items. The top bar counts every floor. Opening MESSAGES marks only the shown updates read; MARK ALL
  READ sends `{ floor }`. A note's and an answer's delivery mark reads its own floor's link in `S.hqLinks`.
- **TELL HQ**: a FLOOR select beside SEND whenever there are floors. It shows the floor you are in, or in the building
  the last floor used (kept in localStorage); set to another floor inside a floor, it holds until you go elsewhere.
  The placeholder names the floor (`Tell HQ (Backend)…`), says its HQ isn't receiving, or that the note is kept until
  a STARTING HQ runs. A reply in MESSAGES goes to the floor of what it answers.
- **HQ isn't receiving**: the strip shows the link of the floor you are in; in the building, one line per floor whose
  HQ isn't receiving (a STARTING floor is never one), each with its own NAME and CHECK NOW (they send `{ floor }`). A
  toast says when a floor's HQ that was receiving stops; the window title says it while any is down.
- **A phone** (under 1151 px): the floor bar and a floor's header sit under the top bar, the bar one row of tabs that
  scrolls sideways (44 px targets on touch); the building is a list of tiles after the questions; inside a floor the
  header and the coloured frame; no sideways page scroll.
- SECRETS stay global.

The navigation (the stage bar with BUILDING and a tab per floor, a floor's header, the coloured page border, the scope
chip, the building's grid of tiles with ZOOM IN and its legend, TELL HQ's floor select) and the scope (SHOW ALL,
marking read within it, the scope kept in sessionStorage) and floor tags are adapted from PR #8. Floors
themselves come from `S.floors`, not the depth of the lane tree, and only the floor you are in has a live office.
