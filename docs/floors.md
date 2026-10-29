# Floors

A floor is one HQ agent and everything it runs. One HQ can direct only so many lanes; floors let the owner run
several HQs side by side, each owning a domain (frontend, backend, legal...). One floor behaves exactly as HQ Office
did before floors; the page shows only the switcher row over the office (that floor's pill and its readings), so
floors can be found and added.

The server and `hud` come first; the page is built on the state contract below (see "The page").

## The model

- Table `floors`: `id` (a slug), `name`, `color` (`#rrggbb`, never red, amber or green: see "The floor UI rules"; a
  floor that wore one is moved at start to the nearest allowed colour, `src/server/floor-colors.ts`), `hq` (the herdr
  agent that is its HQ), `position`,
  `created_at`, and `hq_pane` / `hq_seen_at` (the pane its HQ was last seen in, for the NAME button and the heal).
- **The upgrade.** At start, with no floors, the server makes the first floor: id and name `hq` / `HQ`, or from
  `HUD_FLOOR_NAME` (its id is the name as a slug), with `HUD_HQ_AGENT` as its HQ and the pane `hq_link` held. Every
  existing row is put on it. Its `hq` is stored empty and read from `HUD_HQ_AGENT`, so that setting keeps working;
  `hud floor set ID --hq AGENT` stores one.
- A `floor` column on `lanes`, `asks`, `updates`, `notes`, `rooms`, `work_items`, `hq_outbox` and `events`.

Shared by every floor: secrets, settings (the sweep settings too), machines and sound.

## Who is calling

`hud` sends `x-hud-pane: $HERDR_PANE_ID`, `x-hud-machine: $HUD_LOCAL_MACHINE` when it is set, `x-hud-cwd` (the
folder it runs in) and `x-hud-session` (the values of any `*_SESSION_ID` or `*_THREAD_ID` in its environment). Every
sync records each named agent's pane (by machine) and, on this machine, its folders (herdr's `cwd`, `foreground_cwd`),
its session id (`agent_session`) and every pane herdr has (`herdr pane list`). The calling agent is:

1. the agent whose herdr session id hud sent; else
2. the agent in the pane hud named, while herdr has that pane and the session ids hud sent do not say it is another
   agent's (an agent in its own pane is trusted wherever it runs hud, e.g. an HQ in a lane's worktree); else
3. the agent working in hud's folder (the one whose folder holds it most closely). Agents on several floors there and
   no floor given is an error that says to add `--floor ID`, never a write on the wrong floor.

Some agents run their commands from one background process shared by all their sessions, started in another pane: its
`HERDR_PANE_ID` is that pane's, gone or another agent's. Steps 1 and 3 find them without any provider-specific code.
The caller's floor is then:

1. an explicit floor: `x-hud-floor` (`hud ... --floor ID`), or `floor` in the body or the query; then
2. the floor whose HQ is the calling agent; then
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

A floor other than the first whose HQ herdr has never shown (`floors.hq_seen_at` is null) is STARTING. Its link sets
no reason, raises no "HQ isn't receiving" event, strip or toast, and types nothing into it: what is meant for its HQ
is held, and goes, in order and confirmed, on the first sync that finds it. After 2 minutes (`HUD_HQ_STARTING_MS`) it
is "not started". An HQ seen once and then gone is the alarm, as before. The first floor's HQ is never STARTING: it is
the HQ the HUD was set up with.

Since a floor's HQ must run when it is added (below), a floor is STARTING only for the moment between START A NEW HQ
and the next sync, or when the HQ it was given never came up (a floor from 0.20.0 given an agent that was not
running). Wherever such a floor shows (its pill's row, its row in the floor list, its tile) it says
"`<hq>` is not running in herdr" and offers **START ITS HQ** (`POST /api/floors/ID` with `start`: the start below, for
this floor, and `hq-<id>` becomes its HQ) and **PICK ANOTHER** (EDIT at the HQ select: live agents only).

## Adding a floor

A floor's HQ is an agent that runs in herdr **on this machine** (the HUD types into HQ here), or one the HUD starts:

- **An agent that runs** (USE AN AGENT on the page, `hud floor add ID --hq AGENT`): any named agent herdr lists on this
  machine, a lane too (a lane promoted to run a domain). One that is not running is refused ("`X` is not running in
  herdr: pick an agent that runs, or START A NEW HQ"), one on another machine too; the server reads herdr again first
  when its last sync did not show it. The same holds for `hud floor set ID --hq AGENT` and EDIT. The HUD sends the new
  HQ the HQ guide for its floor (`guideFor` in `src/hq-guide.ts`) through its outbox.
- **START A NEW HQ** (`POST /api/floors` with `start: true`, `hud floor add ID --start`): the server (`floor-start.ts`)
  reads `herdr agent list` for the first floor's HQ's `workspace_id` and `cwd`, runs
  `herdr tab create --workspace W --cwd C --label "<Name> HQ" --no-focus`, and starts `hq-<id>` in the new tab's root
  pane with `herdr agent start hq-<id> --kind K --pane P`. K is the kind the owner picked (`kind`, `--kind`; any kind
  herdr names), else the kind the first floor's HQ runs: nothing in a floor assumes a provider. `GET /api/floors/kinds`
  gives the panel herdr's kinds (from `herdr agent start --help`), those whose herdr integration is installed (from
  `herdr integration status`) and the first HQ's. The kind each floor's HQ ran is kept in `floor_kinds` (started or
  seen) and shown as `S.floors[].kind`; START ITS HQ starts that kind again. Once herdr says the agent is ready the floor
  is stored, and its HQ sent the guide for its floor. An agent that stops at a question while it starts (an update
  notice, trusting the folder: herdr's `agent_not_ready`, the agent listed) is kept too: the floor is stored, the reply
  and the event carry the prompt's excerpt (`waiting`), the floor shows its HQ at a prompt, and the guide goes in once
  the owner has answered it in the pane. On any other failure the tab is closed again, no floor is added, and the
  reply says what went wrong and what to do next (the first HQ not running here, no workspace from herdr, no tab, the
  agent not starting). An id or agent name that is taken is refused before herdr is asked anything.
- **Sandboxed agents.** `hud` reaches the HUD at 127.0.0.1. An agent whose commands run in a sandbox without network
  (some agents' default) cannot; `hud` then says to run it outside the sandbox, and the HQ guide says so up front.
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
| `GET /api/floors/agents` | | `{ agents: [{ name, machine, status, lane, floor }] }`: herdr's live named agents on this machine at the last sync, lanes too, and the floor each runs (null for none) |
| `POST /api/floors` | `{ id, hq, name?, color? }`, or `{ id, name?, color?, start: true }` | `{ id }`, once the floor is stored (with `start`, once its HQ runs) |
| `POST /api/floors/ID` | `{ name?, hq?, color? }`, `{ start: true }` (START ITS HQ), or `{ rm: true }` | `{ ok: true }`, or `{ floors: [ids] }` after a remove |
| `POST /api/floors/ID/tell` | `{ text }` | `{ ok: true }` |
| `POST /api/notes` | `{ text, floor? }` | `{ ok: true }` |
| `POST /api/hq/check`, `POST /api/hq/name` | `{ floor? }` | that floor's link (the first floor's without one) |
| `POST /api/updates/read-all` | `{ floor? }` | marks that floor's updates read (every floor's without one) |

## State contract for the page

- `S.floors`: an array, by position, of
  `{ id, name, color, hq, receiving: true | false | null, reason, starting, notStarted, counts }`, where `counts` is
  `{ blocking, needsYou, oldestWaitAt, working, active, idleSince, blocked, lanes, unreadMessages }`.
  `receiving` is null until the first sync has checked that floor's HQ, and while it is `starting` (its HQ never seen);
  `notStarted` is true once a starting HQ has been waited on for 2 minutes. `blocking` (and `needsYou`, the same) counts
  the floor's open questions and TO DOs, `oldestWaitAt` when the oldest was asked; `working` its lanes at work (herdr
  working, or background work, and not at a prompt: the lanes whose status is `moving`), `active` its lanes not done or
  parked; `idleSince` is null while a lane works, else the latest time a lane stopped working (`herdr_since`), else the
  last time a lane changed, else when the floor was made. `blocked` counts its lanes at a prompt, `lanes` all its lanes,
  `unreadMessages` its unread updates from HQ (`floors.ts` `readingsOf`).
- `S.office`: the same `counts` for the whole office. The top bar reads it, so its numbers agree with the floors'.
- Every lane, open ask, answered ask, update, note, room (`S.rooms[i].floor`) and board item
  (`S.board.items[i].floor`) carries `floor`. Events carry `floor` too (null for one about no floor).
- `S.hq` stays the first floor's link: `{ agent, ok, starting, notStarted, reason, since, candidate, deliveries, held }`.
  `S.hqLinks` maps floor id to the same shape for every floor (the first floor's included); `deliveries` and `held`
  hold that floor's messages only. `ok` is null while the floor is `starting`.
- `S.sweep` keeps its shape (`{ on, minutes, hours, lastAt, nextAt, backoff }`) for the first floor.
  `S.sweepByFloor` maps floor id to `{ lastAt, nextAt, backoff }`.
- `S.board.counts` and `S.board.blockedLanes` count every floor; a page scoped to a floor filters `items` by `floor`.

## The floor UI rules

What the owner must read at a glance, on every floor and for the whole office: **am I the bottleneck?** and **is work
happening?** If a lot of work is assigned, none is happening and none waits on the owner, something is wrong, and that
must be as plain to the owner as to the HQs.

1. **Three readings, three colours, nothing else in them.** Red: *waiting on you* ("N wait on you · oldest 2h",
   questions and TO DOs). Green: *working* ("5 of 9 working": herdr working or background work). Amber, then red:
   *nothing moving* (active lanes, none working, none waiting on you), shown once it has held 3 minutes so it never
   flickers, red after 20 minutes. A reading that is zero is quiet, never red. Floors never wear red, amber or green;
   their palette is blue, teal, purple, magenta, slate, brown and cyan. A STARTING floor is a dashed grey, not amber.
2. **Status before identity, the same everywhere.** Slot A: a red `! N` when anything waits on you, else an amber (or
   red) `Zz N` when nothing moves. Then the name. Slot B: a green bar per working lane, up to five, then `▮5+`. Same
   size and place on the pill, the floor list rows and the building tiles; the top bar's FLOORS box shows each floor's
   worst state as a pip.
3. **Working is one definition.** A lane herdr reports working, or with background work, is `moving` and at its desk
   in the office, whatever its phase (`lanes.ts` `laneStatus`); the counts, the bars and the office agree.
4. **Where am I, said once by the office and once by the lists.** Inside a floor the office's border is its colour,
   and one row under the question tabs names it (`[Backend ×] +3 ON OTHER FLOORS · SHOW ALL`, red when questions wait
   on other floors). No page frame.
5. **One navigation row, never wrapping.** What takes space: the pill (the floor's name shortens first), ◀ BUILDING and
   EDIT inside a floor (fixed), and the readings (they keep their size; on a narrow row they use short words). Nothing
   on it changes width when you switch floors.
6. **Long names**: the × and the counts never shrink; only names do, with an ellipsis and the full name in a tooltip.
   Names are in the text font; the pixel font is for short fixed labels.
7. **The fix sits where the problem shows.** A floor whose HQ is not running offers START ITS HQ and PICK ANOTHER on its
   pill's row, its list row and its tile; a floor where nothing moves says whose it is, inside it, with TELL `<HQ>`.

## The page

One floor (`S.floors` has one entry) is the page as it was before floors, plus the switcher row over the office: that
floor's pill (`HQ ▾`, its slots) and its readings; the pill opens the floor list (that floor, with EDIT, and + ADD A
FLOOR). No building, scope row, FLOORS box, card stripe or `to:`. The room's pixel and layout test proves the rest is
unchanged (`PIXEL_BASE=<ref> bun test test/client/room-pixels.test.ts`): it leaves the row out of its style hash, as it
leaves out the FLOORS section in SETTINGS, and puts back the two things this rework moved for every page (the
+N MORE OUT OF VIEW pill, now at the foot of the question list, and SETTINGS' sticky header). With two or more floors:

- **The switcher row** (`src/client/floors/index.js`), first on the stage: the pill (BUILDING with the office's slots in
  the building; the floor you are in, in its colour, inside one), ◀ BUILDING and EDIT inside a floor, and the readings
  in words on the right (`N WAIT ON YOU · 2h`, `N AT A PROMPT` when any, `5 OF 9 WORKING` or `NOTHING MOVING · 25 min`),
  or a not-running floor's fix. It is one row at every width: under 600 px of row the words shorten.
- **The floor list** (`floors/list.js`), from the pill: BUILDING, a row per floor (colour, slots, name, HQ and its state:
  receiving, starting, not running, stopped; its readings; EDIT on hover or focus; the fix when its HQ is not running),
  then + ADD A FLOOR. ↓ on the pill opens it; arrows, Home, End, Enter; Esc or a click outside closes it. A bottom sheet
  under 1151 px.
- **The top bar's FLOORS box**: a pip per floor in its worst state (red, amber or red, green, grey), each a way into its
  floor; an amber border when a floor has nothing moving and nothing waits on you. It takes the HQ OFFICE title box's
  place. WORKING in the strip is `S.office`'s working of active, and turns into NOTHING MOVING (amber, then red) for the
  whole office.
- **Inside a floor**: the office's border in its colour; the scope row under the question tabs (its × and Esc step out
  one level: SHOW ALL off first, then out to the building; Esc closes the floor panel and the list before anything; not
  while typing, in SETTINGS, a conference room or a preview). The office's workers are that floor's lanes
  (`officeLanes()` in `room/workers.js`); HQ at the terminal is that floor's HQ, a grey ghost when it is not there.
  NEEDS YOU, empty on a floor where nothing moves, says so, names its HQ and offers TELL `<HQ>`.
- **THE BUILDING** (`floors/building.js`): tiles that fit the stage (2 across up to four floors, then 3, 4 from 1600 px;
  rows share the height), and + ADD A FLOOR. A tile: its label row (slot A, the name, slot B), its HQ and its state,
  the readings big (or the fix), and a small still picture of its office (`room/still.js`, without event art), hidden
  when the tile is too narrow. Its frame takes slot A's colour; a click enters the floor; ENTER › shows on hover. A
  picture is drawn again only when what it shows changes and only while the building shows; no frame loop per tile.
  Coming back to the building starts at its top. CLICK A WORKER is hidden there. Under 1151 px a tile is a 44 px row,
  its picture behind PICTURE.
- **The floor panel** (`floors/panel.js`), over the stage (a sheet on a phone): + ADD A FLOOR adds a floor (a name, a
  colour from the floor palette, and its HQ: USE AN AGENT, a select of herdr's live agents on this machine, those
  running another floor shown disabled with its name, read from `GET /api/floors/agents` when it opens; or START A NEW
  HQ). No typed names. An error from the server shows in the panel and nothing is added. EDIT renames, recolours, gives
  another HQ, or REMOVEs an empty floor after a confirm in the page; when it cannot, it says why.
- **The scope** (`src/client/core/scope.js`): the floor you are in, or none (the building), and SHOW ALL. It is kept in
  sessionStorage, dropped when its floor is gone, and every change emits `scope` on the bus. Pure helpers of `S` (the
  floor list, a floor's HQ link and state, the readings and slots, the card stripe) are in `core/floors.js`.
- **Lists and counts**: NEEDS YOU, MESSAGES, WORK (and its STALLED strip), ROOMS, FROM HQ and SENT & ANSWERED, and the
  tab counts, follow `listFloor()`. In a list that shows every floor a card has a 4 px stripe in its floor's colour and
  a swatch in its lane tag; its kind tag stays; the timer stays on the right and the tags shorten first.
- **TELL HQ**: `to: Backend ▾` left of SEND (a native select under a label as wide as the name, at most 40% of the row)
  with two or more floors. It shows the floor you are in, or in the building the last floor used (kept in
  localStorage); set to another floor inside a floor, it holds until you go elsewhere. The toast names the floor.
- **HQ isn't receiving**: the strip shows the link of the floor you are in; in the building, one line per floor whose
  HQ isn't receiving (a STARTING floor never is one), each with its own NAME and CHECK NOW. A toast says when a floor's
  HQ that was receiving stops; the window title says it while any is down.
- **The page clock**: ages in the readings use `data-since` with `data-ago` (a minute's step), and the tick redraws the
  floors only when a stall's step (none, amber, red) changes. No timer of its own.
- **A phone** (under 1151 px): the switcher row under the top bar (44 px targets on touch), then the questions; the
  floor list a bottom sheet; the building a list of rows after the questions; no sideways page scroll.
- SECRETS stay global.

The scope, SHOW ALL and marking read within it are adapted from PR #8. Floors themselves come from `S.floors`, not the
depth of the lane tree, and only the floor you are in has a live office.
