# Floors and the scope

A floor is a lane under HQ that directs leads. With a flat or two-level tree there is one floor and the page is the
page it always was. The rule is one pure function, `floorsOf` in `src/lane-tree.ts`: a lane straight under HQ heads a
floor when a lane sits at depth 3 or deeper under it. Its whole subtree is on its floor; every other lane is on HQ's.

## The scope

`src/client/core/scope.js` holds `{ floor, agent, all }` and emits `"scope"` on the bus on every change. Every list and
count reads `view()` and builds its numbers with the pure functions in `src/client/core/floors.js`; none calls another
panel. The scope is kept in `sessionStorage` (`hq-scope`) and checked against the lanes when read back, so a reload
keeps it and a new tab starts unscoped.

## Choosing an agent

A click on a worker (`"worker"` on the room's bus), a question's lane tag, ANSWER on the card and the BLOCKED box all
end in `chooseAgent(name, { jump: true })`. The card shows `scope().agent`; `floors/index.js` rings that worker on its
floor; the question panel switches to QUESTIONS and flashes the lane's first question. The chip, the border and the
"+N FROM OTHER AGENTS · SHOW ALL" line say that the lists are narrowed. Escape and the chip's ✕ go out one level
(`escapeAction`); a room on the stage, SETTINGS, a dialog or a text field keep the key.

## The building

With one floor the page is today's page: `floors/` adds nothing to it, not an element, a tag or a border. With two or
more (`stageMode` in `core/floors.js`) the stage is the building or one floor of it, and the scope's floor decides
which: no floor in the scope is zoomed out, which is how a new tab opens; a floor in the scope is zoomed into.

- **Zoomed out**, every floor is a tile: its tag in the floor's colour, the questions waiting on you there, a dot per
  agent that needs help, and a live room. A click anywhere on a tile calls `setFloor(id)`, which zooms in and scopes in
  one action. Two tiles a row, one on a narrow screen.
- **Zoomed in**, the floor is today's room at its full size, with today's legend under it and ◀ ALL FLOORS above it.
  Clicking a worker chooses that agent.
- **◀ ALL FLOORS and BUILDING** call `setFloor(null)`: all the way out from a floor, an agent or SHOW ALL. The chip's
  ✕ and Escape go out one level (`outOne`).
- **A floor other than HQ's** is the room's modules loaded again from `/floor/<id>/src/client/...` (`room/floor.js`),
  so it has its own canvas, workers, frame loop and bus. `floors/index.js` feeds each copy the page's state and the
  "stage" event, tells it its size (`fitTo`) and whether it is in sight (`show`): only the floors in `floorsInView`
  draw. Each copy's terminal reads its floor's general (`terminalName`).
- **Floor tags** on a question and on an update (MESSAGES and FROM HQ) name its lane's floor in the floor's colour,
  only with two or more floors. A question or update with no lane, a lane that is gone, and your notes, are on HQ's floor.

A second floor appears only when a lane runs PMs that have builders under them (the floor rule above). `test/floors-fixture.ts`
builds an office with such a lane (three floors) for the Chrome tests and the captures; it also builds the one-floor
office for the "nothing changes" checks.

## The layer and NEED HELP

Over every floor's room, `layer/` draws on a canvas of its own (the room's pixels are never touched). The room's canvas
lives in a `.scene` with the layer beside it, with one floor too: that is the only thing one floor gains in the DOM.

- **Markers** (`helpMarks`): zoomed out, one beside every agent that needs help (the names are too small to read);
  zoomed in, only workers blocked at a prompt or stalled, because the room already shows a "!" over a worker waiting on
  you and a "?" over one waiting on HQ. The general at the terminal is marked only when blocked or waiting on you: idle is its normal state, whether the server
  calls it waiting on HQ or, after 15 idle minutes, stalled. A marker takes the nearest
  spot clear of every name label, sprite, bubble, wall piece and other marker (`layer/place.js`; the label boxes come from
  `room/scene.js` `labelBox`, which measures them the way `drawLabel` draws them). With no clear spot there is no marker.
- **Frames** (`floorRooms`, `projectState`): each open project (a conference room) hangs on the wall of its owner's
  floor, oldest first, at most seven, coloured by its state: a question about the project waits on you, blocked,
  stalled, CI running, else moving. There is no progress bar because there is no progress data.
- **A project's questions** (`roomCalls`) are the open questions that name its room (`hud ask --room SLUG`); a deferred
  question is not counted, and a question of the room's lanes that names no room is not the project's. The frame
  (`, N for you` in its name and a count tag), RUNDOWN (`N OPEN CALLS`) and the project panel (OPEN CALLS) all count with
  this one function. Red means "a question about this project waits on you": `projectState` counts waiting only from
  `roomCalls` and from linked work waiting on the owner (`BOARD_STATE.owner`), so a room lane waiting on you without a
  question that names the room leaves the frame its other state (the NEED HELP strip and the markers still show the
  lane). Blocked, stalled and CI still come from the room's lanes and the board.
- **Buttons.** Zoomed in, a marker is a button that chooses its agent and a frame is a button for its project. Zoomed
  out, a click anywhere on a floor zooms in, so the layer is a picture only.
- **NEED HELP** (`help/`, `helpStrip`) is a strip between the floor and the worker card: the agents in scope that need
  help, worst first, each row choosing its agent like a worker's click. Nobody needing help reads "0 NEED HELP" and is
  disabled. The strip follows the scope and never changes it: every row's lane is on the scoped floor.
- The legend gains BLOCKED and STALLED rows. A general that needs help (blocked or waiting on you) gets a NEED HELP row
  and a dot on its floor's tile as well as its marker.

## Projects, links and the way into rooms

A frame on the wall, a question's PROJECT tag or `showPanel("project", { slug })` opens the project panel (`project/`,
`projectView`) over the room, in the accounts panel's pattern: its state, OPEN CALLS (a click chooses the agent and
closes the panel), ROOM, PULL REQUESTS with their board state, ARTIFACTS (fetched from `GET /api/rooms/<slug>`) and
WHO IS ON IT. Panels over the room take turns through `core/panel.js` and the `"panel"` bus event: opening one closes
the other, and Escape closes the open panel before it steps the scope out (`escapeAction`).

A question shows, in its meta row, PROJECT and ROOM for each open project its lane is in, and its lane's issue and pull
requests (`askLinks`). ROOM, and the panel's OPEN THE ROOM, are `#room/SLUG`, the address the ROOMS tab already uses;
the ROOMS tab stays.

## Decisions the code carries

- **Everything follows the scope** (the owner, on the phone tabs: "When I click a floor everything is scoped to that
  floor. Eg queue and messages as well."). WAITING ON YOU, the questions, the messages and their unread counts, the
  FROM HQ list and MARK ALL READ all follow it. This replaces the earlier decision that the MESSAGES badge counts every
  room; the line "+N ON OTHER FLOORS" counts the rest.
- **Today's tab row stays.** Questions and messages keep the tabs they have.
- **Tell and messages go to HQ** in every scope until other generals exist on the server (`tellRecipient`).

## Not scoped

They are about the whole installation or the owner, not one floor's work: the tab title and the chimes, BANK, the
BLOCKED box, HQ ISN'T RECEIVING, ACCOUNTS, MACHINES, SENT & ANSWERED and SECRETS.

## Rules the tests keep

- Marking read in a scope marks only what is in that scope (`read-all` takes `{ floor, lane }`; `marksRead` on the page).
- With no scope set, every count and list is what it was before floors (`counts`, `readAllBody`).
- A scope that no longer holds (a lane gone, a floor gone, one floor) is dropped on every state (`normalizeScope`).
- The stage shows what `stageMode` says, the floors that draw are `floorsInView`, and a floor tag shows only with two or
  more floors (`floorTag`). `test/model/building.test.ts` holds each; `test/client/floors.test.ts` checks them on a page.
