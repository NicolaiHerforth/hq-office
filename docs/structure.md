# How HQ Office is laid out

HQ Office used to be two files: `index.html` (about 2,800 lines of CSS, markup and one script) and `server.ts`
(routes, schema, queries, herdr sync, machine stats, the push stream and the score). Every feature touched both, so
two agents working at the same time edited the same files and overwrote each other. This layout gives every area its
own file, keeps the contracts between them in a few small modules, and lets a new feature arrive as new files.

The split was done by `scripts/restructure.ts`, mechanically: every statement kept its text, its comments and its
order. Only `export`, the imports and a few setters were added. The page draws the same pixels and computes the same
styles as before (see "How it was checked").

## The map

```
server.ts                 entry: one import, so `bun server.ts` still starts everything
hud.ts                    HQ's CLI (unchanged)
bin/hud-plugin.ts         the herdr plugin's entry; bin/service.ts (service mode), bin/hud-command.ts (installs hud)
src/hq-guide.ts           the HQ guide and its one-line reminder (hud guide, the plugin's greet, messages to HQ)
public/index.html         the page shell: head, markup, <script type="module" src="/src/client/main.js">
src/client/               the page, plain ES modules and stylesheets, served as they are
  main.js                 loads every built-in area in the old order
  core/                   shared by every area: state, net, bus, formatting, rich text, base styles, layout
  room/                   the canvas room
    events/               one file per event room (christmas, halloween, ...)
  topbar/ questions/ tell/ card/ messages/ images/ sound/ settings/ secrets/ menu/ lanes/
                          one folder per panel or feature: its module(s) and its stylesheet
  <feature>/index.js      a new feature: loaded by the page on its own
src/server/               the server, one file per concern
  main.ts                 loads every module in the old order, starts the timers
  config.ts db.ts push.ts router.ts page.ts json.ts http.ts
  herdr.ts lanes.ts asks.ts updates.ts events.ts inbox.ts score.ts state.ts machines.ts
  routes/                 one file per resource: a list of { method, path | prefix | pattern, handle }
  schema/                 one .sql file per table, applied at startup
  machine-stats.sh        the machine sampler (runs here or over ssh)
test/                     the tests that were there, unchanged
  server/ client/         new: the server starts and serves; modules link; the page works; pixels match
scripts/                  restructure.ts (the split), room-hash.ts (the pixel and style check)
docs/                     this file
```

## Module boundaries and contracts

Each file says in its first line what it is for. A module imports exactly what it uses, so its import list is its
interface: what it depends on is visible at the top, and a renamed or moved name fails the link test at once.

The contracts, the things several areas agree on, each live in one small module and change rarely:

| Contract | Where | What it is |
| --- | --- | --- |
| The state | `src/server/state.ts` builds it, `src/client/core/state.js` holds it (`S`, `CONFIG`) | the one object the page draws from |
| Writes | `src/client/core/net.js` (`post`), `src/server/router.ts` | POST with `x-hud: 1`; the reply is JSON; every write bumps the version |
| Events on the page | `src/client/core/bus.js` | `state`, `tick`, `room:draw`: where a feature hooks in |
| Status words and colours | `src/client/core/status.js`, `src/server/lanes.ts` (`laneStatus`) | `needs_you`, `hq_turn`, `moving`, ... |
| The room's pixel grid | `src/client/room/canvas.js` | `TS`, `SC`, `W`, `H`, `ctx`, `px`, the art cache |
| Sprites and palettes | `src/client/room/sprites.js`, `palette.js` | 16x16 frames and colour letters |
| Accessories | `src/client/room/accessory-table.js` | data only; order decides who wears what |
| Seasons | `src/client/room/seasons.js` | the season or event id everything else keys on |

Mutable state that another module changes has a setter in the module that owns it (`setSeason`, `setCtx`,
`setS`, ...): an imported binding is read-only, and a setter makes every outside write visible in a search.

## How a feature arrives as new files

- Page: a folder `src/client/<name>/` with `index.js` (and any `.css`). The server links every stylesheet under
  `src/client` and loads every `<name>/index.js` after `main.js` when it serves the shell, so nothing else is edited.
  The feature imports what it reads and listens on the bus: `on("state", ...)`, `on("tick", ...)`,
  `on("room:draw", now => ...)`.
- Server: `src/server/<name>.ts` for the logic, `src/server/routes/<name>.ts` for its routes (the router loads every
  file there), `src/server/schema/<table>.sql` for its tables, and `addStatePart("<name>", () => ...)` for its part
  of `/api/state`.
- Event rooms are one file each in `room/events/`; adding one also adds its dates to `room/seasons.js` and one import
  line in `room/events.js` (three small, distinct edits).

## Ownership for parallel lanes

A lane owns its feature's folder and files. Two lanes never edit the same file at the same time. The shared files
(the contracts above, `main.js`, `main.ts`, `router.ts`, `page.ts`, `db.ts`, `config.ts`, `public/index.html`,
`core/layout.css`, `core/base.css`, `core/controls.css`) change only in a lane that says so up front, as a small
change of their own, merged before the work that needs it. `AGENTS.md` has the rules in full.

## Trade-offs

**No build step.** The browser loads the modules as they are and Bun serves them. Measured on localhost, headless
Chrome, the same seeded state:

| | before (one file) | after (modules) |
| --- | --- | --- |
| requests on a cold load | 2 | 60 |
| bytes on a cold load | 196 KB | 229 KB (body 211 KB: import lines and headers) |
| bytes on a reload | 196 KB | 27 KB (unchanged files answer 304) |
| DOMContentLoaded, cold / warm | 9 ms / 6 ms | 17 ms / 13 ms |
| server start to first /api/state | 27 ms | 31 ms |

The page is local and its budget is a human's (about 100 ms); 8 ms more on load is not visible, a reload moves 86%
fewer bytes, and there is nothing to run before a change shows. `modulepreload` links were tried and saved about
2 ms, which is noise, so they are not used. A bundler would bring the request count back to 2 but adds a build that
every lane must run, a second copy of the code to keep in step, and source maps to debug through. It would be worth it
if the page were served over a slow network; it is not.

**ES modules, not several classic scripts.** Classic scripts sharing globals would have been a smaller change, but
every name would stay global and every file could reach into every other one. Modules make the dependencies explicit
and checkable, which is what lets two agents work without reading the whole page first. The cost was the setters for
the eight bindings written across modules, and modules being strict (the split checks for undeclared assignments).

**Load order.** Modules run their imports first. `main.js` lists the areas in the order the old script ran them,
and the split checks that nothing reads another module's `let` or `const` before that module has run.

**Stylesheets per area.** The rules were split by selector and are linked `core/` first, then by path. The old
order and the new differ, so the split relied on the rules' selectors not tying on the same property; the computed
style of every element in six states at two sizes is identical before and after.

**Routes in files, not a table in one file.** Each route file is a plain list, loaded by the router at start. Two
lanes adding routes add or edit different files. Routes must not overlap (the split checked the moved ones).

**One accessory table.** Accessories stayed one ordered list: the order decides which item each worker gets
(`wornBy` picks by index), so splitting it by season would have changed who wears what. Adding an item is appending
one entry, which merges cleanly.

**The schema as files.** One `CREATE TABLE IF NOT EXISTS` file per table, applied in name order at start. A change to
an existing table is still a careful by-hand migration; the files only make new tables collision-free.

## How it was checked

- `test/smoke.test.ts` (the old routes) passes unchanged.
- `test/server/start.test.ts`: the server starts from the root, the shell links every stylesheet core-first and
  loads `main.js`, every client file is served with its type and revalidates to 304, nothing outside `src/client`
  is served, and `/api/state` has every key the page reads.
- `test/client/modules.test.ts`: every import resolves to a file and to a name that file exports, every module is
  reached from `main.js` or a feature's `index.js`, every file opens with a comment.
- `test/client/page.test.ts`: in Chrome at 1440x900, no console errors, no page scroll, an answer and a note reach
  the server, the tabs, the worker card, MENU, settings and sound respond.
- `test/client/room-pixels.test.ts` with `scripts/room-hash.ts`: time, randomness and animation frames frozen in the
  page, fonts blocked; the canvas is hashed after the first frame and after 3 s of frames for 19 states (asks open,
  a worker selected, all 11 seasons and events, idle by day and night in three), and every element's computed style,
  box and text is hashed at 1440x900 (plain, settings open, messages tab, a worker selected, idle) and 800x900. All
  hashes match the tree before the split. It runs by itself while HEAD still has the old `index.html`, and with
  `PIXEL_BASE=<ref>` at any time, for example to prove a refactor changed nothing on screen.

The split was also run on a copy of another lane's branch (a new page section, new routes, a new root module and
its tests): it placed the new work in its own module, file and route file, the branch's tests passed, and the page
hashed the same as that branch before the split.

## Running the split again

`scripts/restructure.ts` works from whatever `index.html` and `server.ts` hold, so it runs on a main that has
moved on. Its plan names every top-level binding it knows; anything new goes with the statement above it, or, under
a new section header, into a module of its own, and is listed for review. It refuses to write anything when it finds
something it cannot place (an unknown route shape, a destructuring write to a shared binding, a load-order read), and
ends with a checklist.
