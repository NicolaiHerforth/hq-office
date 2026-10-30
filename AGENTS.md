# HQ Office

A local command centre for people who run AI coding agents in herdr: a handheld-RPG-style office where every lane (an AI agent working one task) is a sprite worker, plus the panel where the owner answers HQ's questions. It runs as a herdr plugin or as `bun server.ts`, at http://127.0.0.1:4747 by default.

If `AGENTS.local.md` exists next to this file, read it too: it holds the rules of this particular installation (how the server is run and restarted, who to report to). It is gitignored and never published.

- `server.ts`, `public/`, `src/`: the server and the page, one file per concern (see the map below).
- `hud.ts`: HQ's CLI (`hud` when linked onto PATH, or `bun hud.ts`).
- `src/lane-tree.ts`: the lane tree's depth, path, level names and `hud tree` text (shared by the server and the CLI).
- `src/server/floors.ts`: floors (one HQ agent and everything it runs), who is calling (by herdr pane) and which floor a thing is on. `docs/floors.md` has the model and the state contract.
- `src/hq-guide.ts`: the HQ guide (how HQ reaches the owner: through the HUD) and its one-line reminder. The one copy: `hud guide`, the plugin's greet and the server's messages to HQ all use it.
- `src/server/secrets.ts`: the secret drop. Values in server memory only; see the README. `src/server/secret-ledger.ts` keeps their names (never values) so a restart can say what it lost; `src/secret-handover.ts` is the plugin's half of the handover that carries values across a planned restart.
- `bin/hud-plugin.ts`, `herdr-plugin.toml`: the herdr plugin (actions, the status pane, and `greet` on `pane.agent_detected`, for the configured HQ and every floor's HQ); `bin/service.ts` (service mode: launchd, systemd), `bin/hud-command.ts` (installs `hud`). Their tests (`test/plugin/`) use a fake home and `test/fake-service.ts` for launchctl and systemctl: never run the real ones from a test. Floor tests use `test/fake-herdr.ts`, a stub herdr that records every call.

Rules for anyone changing it:
- The question panel is the point. A change to the room must never make an open question harder to see or answer.
- Never touch `hud.db` by hand and never delete it: it holds the owner's answers.
- After a change under src/server/ (or server.ts), restart the server (the plugin's reload action, or however `AGENTS.local.md` says this installation runs it). The page's files (public/, src/client/) are read on every request; a reload is enough, and open pages reload themselves.
- Original pixel art only: the style of Gen 3 handheld RPGs, never copied sprites, names or logos from a real game.
- A secret value must never reach `hud.db`, a log, a listing or the page's markup or storage. `bun test` greps for it.
- Code, comments and docs name no real person, machine or service label: say "the owner", "this machine". The owner's name comes from `HUD_OWNER` at run time.
- Tests start their own servers on spare ports with throwaway data dirs. Never point a test or `hud` at a server that holds real answers.

## Map

No build step: the browser loads `src/client` as it is, Bun runs `src/server` as it is. Each file's first line says
what it is for. `docs/structure.md` explains the layout and its trade-offs.

- `server.ts`: the entry, one import of `src/server/main.ts`, so the service, the plugin and the tests still run `bun server.ts`.
- `public/index.html`: the page shell (head, markup). The server adds every stylesheet and every feature folder when it serves it.
- `src/client/main.js`: loads the built-in areas in their original order.
- `src/client/core/`: shared by every area: `state.js` (S, CONFIG), `net.js` (post), `bus.js` (events), `boot.js` (load, stream, autoreload), `format.js`, `markdown.js` (the one renderer for text HQ or a lane wrote: `md`, `mdInline`, `mdClip`, COPY on code boxes), `dom.js`, `clicks.js`, `status.js`, `floors.js` (floors as pure functions of S: the list, a floor's HQ link, the three readings and their slots, the card's floor stripe), `scope.js` (the floor you are in and SHOW ALL: what every list shows); `base.css`, `controls.css`, `layout.css`, `markdown.css`.
- `src/client/room/`: the canvas room: `canvas.js` (pixel grid, px, art cache), `sprites.js`, `palette.js`, `scene.js`, `workers.js`, `spots.js`, `collision.js`, `hero.js`, `breakroom.js`, `loop.js`, `input.js`, `seasons.js`, `weather.js`, `accessory-table.js` (data), `accessories.js`, `still.js` (a still picture of one floor's office, for the building's tiles), `themes.js` (data: the looks per level of the lane tree), `looks.js` (who wears which look), `art.js` (tools for event art), `events.js` (runs the current event), `room.css`.
- `src/client/room/events/`: one file per event room.
- `src/client/topbar/`, `questions/`, `tell/` (and `last-note.js`), `card/` (the agent drawer: a lane's question, terminal, what it said and its work, read-only, from `GET /api/lanes/NAME/live`, `src/server/lane-live.ts`), `messages/` (HQ's updates, your notes and answers), `images/`, `sound/`, `settings/`, `secrets/` (the panel MENU opens): one folder per panel or feature, its module(s) and its stylesheet. `menu/` is MENU (SECRETS, SETTINGS, SOUND, LAYOUT: OFFICE or LANES BOARD, each viewer's own, set as data-layout on the root). `lanes/` is the LANES BOARD under the office. `briefs/` is the BRIEFS tab and one brief on the stage (`#brief/ID`), from `src/server/briefs.ts` (hud brief). `floors/` is the switcher row on the stage (always there, also with one floor) and the scope row (`index.js`), the floor list the pill opens (`list.js`), THE BUILDING (`building.js`: a tile per floor, readings first, with a still picture of its office) and the floor panel that adds and edits floors (`panel.js`). `docs/floors.md` has the floor UI rules. `rooms/` is the ROOMS tab and the room view that takes the stage (`pix.js`: its pixel strip; `markdown.js`: the brief and the thread; the shelf's ADD, drop and paste put files in the room's folder).
- `src/server/`: one file per concern: `config.ts`, `db.ts`, `push.ts` (version, bump), `router.ts`, `page.ts` (shell, client files, autoreload stamp), `json.ts`, `http.ts`, `herdr.ts`, `prompt.ts` (a lane blocked on a prompt: detection and excerpt), `floors.ts` (floors: one HQ each; the caller's floor from its herdr pane), `floor-start.ts` (START A NEW HQ and START ITS HQ: a herdr tab and an agent for a floor), `floor-colors.ts` (the floor palette: never red, amber or green), `hq-sweep.ts` (HQ SWEEP: the nudge to each floor's HQ when it is idle and something on its floor needs a look), `hq-link.ts` (whether each floor's HQ can take input, checked every sync; the outbox that holds what it cannot take and sends it once it can), `lanes.ts`, `asks.ts`, `updates.ts`, `events.ts`, `inbox.ts`, `score.ts`, `state.ts`, `machines.ts` (+ `machine-stats.sh`), `settings.ts` (the owner's settings), `rooms.ts` (conference rooms: brief, shelf, thread, delivery to lanes), `room-folder.ts` (each room's folder, DATA/rooms/SLUG/: files/ watched while the room is open, the shelf.json and brief.md mirrors, the move from room-files/), `main.ts`.
- `src/server/routes/`: one file per resource; the router loads them all.
- `src/server/schema/`: one `.sql` file per table, applied at startup.
- `test/`: the original tests; `test/server/` and `test/client/` mirror `src/`.
- `scripts/`: `release.ts` (the release routine, below), `restructure.ts` (how the split was made; re-runnable), `room-hash.ts` (pixel and style hashes of the page).

## Working in parallel (lanes)

- Before starting, a lane names the files it will touch. Two lanes never touch the same file at the same time.
- A lane owns its feature's folder: `src/client/<feature>/`, `src/server/<feature>.ts`, `src/server/routes/<feature>.ts`, `src/server/schema/<table>.sql`, `test/*/<feature>.test.ts`.
- Shared files change only in a lane that says so up front, as a small change of its own merged before the work that needs it: `src/client/core/*` (contracts: state, net, bus, status, base styles, layout), `src/client/main.js`, `src/client/room/canvas.js`, `sprites.js`, `palette.js`, `seasons.js`, `src/server/main.ts`, `router.ts`, `page.ts`, `db.ts`, `config.ts`, `push.ts`, `state.ts`, `public/index.html`.
- `src/client/room/accessory-table.js` is append-only: add entries at the end of the list, never reorder (the order decides who wears what).
- Hook in, do not reach in: listen on `core/bus.js` instead of adding a call to another area's render function; use `addStatePart` instead of editing `state()`; add a route file instead of editing another lane's.
- Do not reformat, rename or reorder code in files you do not own.
- A refactor of the room or the page must not change what is drawn: `PIXEL_BASE=HEAD bun test test/client/room-pixels.test.ts` (needs Chrome).
- `bun test` passes before every commit; `test/client/modules.test.ts` catches a broken import before a browser does.

## How to add

- **A page feature or panel**: create `src/client/<name>/index.js` (and `<name>.css`). The page loads it after the built-in areas, no other file changes. Import what you read (`S` from `core/state.js`, `post` from `core/net.js`, `$` from `core/dom.js`) and render from the bus: `on("state", (S) => render())`. Text that HQ or a lane wrote goes through `core/markdown.js` (`md` for blocks, `mdInline` for titles and one-line places, `mdClip` for MORE/LESS), never `esc()`: `test/client/one-renderer.test.ts` fails otherwise. A panel inserts its own element (for example into `.under` or under the questions); it must never push an open question out of view.
- **An accessory**: append one entry to `src/client/room/accessory-table.js`: `{ id, slot: "head" | "body" | "hand", seasons: [...] | "any", pal, front, side }` (or `hand` for a hand item). Original pixel art only.
- **An event room**: `src/client/room/events/<id>.js` exporting `{ still() {}, live(now) {}, counter(now) {} }` (draw with `dp` and the tools in `room/art.js`), its dates in `EVENTS` in `room/seasons.js`, and one import in `room/events.js`.
- **Something drawn in the room every frame**: `on("room:draw", (now) => { ... })` in your feature, drawing with `px` from `room/canvas.js`.
- **A route**: add `{ method, path | prefix | pattern, handle }` to `src/server/routes/<resource>.ts`, or add the file. GET handlers return a Response; POST handlers get `{ body, m }` and return the JSON reply (nothing means `{ ok: true }`); writes are bumped for you.
- **A table**: `src/server/schema/<table>.sql` with `CREATE TABLE IF NOT EXISTS`. Changing an existing table is a migration: ask HQ first.
- **Server logic and state**: `src/server/<name>.ts`, imported by its route file; `addStatePart("<name>", () => value)` from `state.ts` puts it in `/api/state` as `S.<name>`.

## Releasing

Every public release goes through `scripts/release.ts`; nothing is copied to the public repo by hand.

1. Add the version's section to `CHANGELOG.md` (`## [X.Y.Z] - YYYY-MM-DD`, Keep a Changelog style, written for the people who use the plugin), and bump `version` in `herdr-plugin.toml` and `package.json`. Commit.
2. `bun scripts/release.ts X.Y.Z` exports the tracked tree of HEAD (`--ref R` for another) with `git archive`, leaves out `AGENTS.local.md` and whatever `.release-exclude` lists, fails on any line matching a pattern in `.release-denylist` (printing file and line), runs `bun install` and `bun test` on the export, then copies it into a local clone of the public repo (`--public DIR`, default `../hq-office-public`, cloned from `--remote URL` when missing), commits `release: vX.Y.Z` with the changelog section and tags `vX.Y.Z`. It stops there and prints what it would push.
3. Read the commit in the clone. Then run it again with `--push`: it pushes main and the tag and creates the GitHub release with the changelog section as its notes.

`.release-exclude` (paths, one per line, `#` comments) and `.release-denylist` (one regular expression per line, matched case-insensitively; a line `!TEXT` allows that exact text) are gitignored: each installation keeps its own. Without a denylist the script refuses to run.
