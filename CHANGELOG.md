# Changelog

All notable changes to HQ Office are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.23.0] - 2026-10-29
### Changed

- **The office gets the whole right column.** The panel under the office (FROM HQ, SENT & ANSWERED, SECRETS) only
  repeated the left column, so it is gone, and the office or the building fills the space. This layout, **OFFICE**,
  is the default.
- **LANES BOARD, if you prefer.** MENU › LAYOUT › LANES BOARD puts a board under the office with every lane by name:
  **WORKING**, **WAITING ON YOU** (with what it asks, oldest first) and **NOT MOVING** (waiting on HQ, on CI, at a
  prompt, or its agent gone; stuck longest first), each with how long. Parked and done lanes are counted. Inside a
  floor it shows that floor's lanes; in the building, every floor's. Each viewer picks their own layout, and the
  browser remembers it.
- **One MENU.** SECRETS, SETTINGS, SOUND and LAYOUT moved into one menu in the top right. SECRETS opens as a panel
  over the office. A red dot on MENU says a restart lost a secret.
- **Your answers are in MESSAGES**, with whether HQ acted on them, beside HQ's updates and your notes. The page
  marks the updates it shows as read, as before.
- **The worker card opens over the office** when you click a worker or a lane on the board; ✕ or Esc closes it. It
  no longer takes a box of its own.
- **The top bar says each thing once.** The FROM HQ box and the FLOORS box are gone: MESSAGES counts what is new, and
  the floor pill and the building show each floor. In the building, the row over it no longer repeats the top bar's
  readings.

## [0.22.1] - 2026-10-29
### Fixed

- **A floor's HQ is recognised even when its commands don't run in its own pane.** Some agents (Codex, for one) run
  every command from one background process shared by all their sessions. That process carries another pane's
  `HERDR_PANE_ID`, so a Codex HQ's `hud tell` was filed on the first floor. `hud` now also sends the folder it runs in
  and any session id the agent puts in its environment. The HUD uses these whenever the pane is not the caller's:
  it matches herdr's session ids first, then the agent working in that folder. If agents on several floors work in
  that folder, `hud` asks for `--floor` instead of guessing, and each floor's guide names its floor.

## [0.22.0] - 2026-10-29
### Changed

- **Any agent can run a floor.** Nothing in a floor assumes a provider anymore: its HQ and its lanes are whatever
  agents you run in herdr (Claude, Codex, or any other CLI herdr can start). **START A NEW HQ** now asks which agent
  to start. It lists the kinds herdr can run, those with herdr's integration installed first, and defaults to the
  kind your first HQ runs. Before, it always started Claude. `hud floor add ID --start --kind K` does the same from the
  CLI.
- A floor remembers its HQ's kind, so **START ITS HQ** brings back the same kind of agent. `hud floor list` shows it.

### Fixed

- **An HQ that stops at a question while starting is kept.** Agents can ask something before they are ready, such as
  an update notice or whether to trust the folder. START A NEW HQ used to give up, close the tab and add no floor.
  Now the floor is added and the page says its HQ waits on a prompt in its pane; the activity feed shows what it
  asks. Once you answer it there, the HQ gets its guide.
- **`hud` says why it can't reach the HUD.** Some agents run commands in a sandbox that blocks the network, so `hud`
  cannot reach the HUD from inside it. `hud` now says to run it outside the sandbox (with escalated permissions), and
  the HQ guide says so up front.

## [0.21.1] - 2026-10-29
### Fixed

- **A floor whose HQ never started can be removed.** `hud floor rm` used to refuse a floor with messages held for its
  HQ, and nothing could clear them. Now a floor with no lanes goes. Your notes and answers that its HQ never got move
  to the first floor's HQ, marked "meant for floor X, whose HQ never got it". What was already read, and the guide
  meant only for that floor's HQ, are dropped. The activity feed has a line with both counts.

## [0.21.0] - 2026-10-28
### Changed

- **Three readings, the same everywhere.** Every floor, and the whole office, now answers two questions at a glance:
  *am I the bottleneck?* and *is work happening?* Red `! N` means N questions or TO DOs wait on you; green bars mean
  lanes are working right now; amber `Zz N` means **nothing is moving**: lanes are assigned, none is working and none
  waits on you, so it is HQ's to unstick. It shows once it has held for 3 minutes and turns red after 20. The top bar,
  the floor switcher, the floor list and the building tiles all count the same way, and a lane that is working is at
  its desk in the office, whatever its phase. Red, amber and green mean only these: floors no longer wear them (a red,
  amber or green floor moves to the nearest free colour).
- **One row to move between floors.** The floor tabs are replaced by one switcher row over the office: the floor you are
  in as a pill (its name in a readable font, its readings beside it), ◀ BUILDING and EDIT inside a floor, and the
  readings in words on the right. It never wraps, at any width or with any number of floors. The pill opens the floor
  list: BUILDING, every floor with its HQ and readings, and + ADD A FLOOR. Arrow keys, Enter and Esc work; on a phone
  it is a sheet from the bottom.
- **The top bar has a FLOORS box** when you have two or more floors: one pip per floor in its worst state; click one
  to go there. Between 1151 and 1300 px wide (and whenever the FLOORS box shows) the HQ OFFICE title box makes room,
  and no label in the top bar wraps.
- **THE BUILDING fits the screen**: two tiles across up to four floors, then three (four on a wide screen), every row
  visible. A tile leads with its readings, big; its office picture is smaller, beside them. On a phone each floor is a
  row, with its picture behind PICTURE.
- **Inside a floor** the office's border takes the floor's colour, and one row under the question tabs says
  `[Backend ×] +3 ON OTHER FLOORS · SHOW ALL` (red when questions wait on other floors). The coloured page frame and
  the separate floor header are gone.
- **A floor where nothing moves says so.** Its empty NEEDS YOU no longer reads "all good": it says how many lanes are
  idle and for how long, names the HQ it is on, and TELL <HQ> points the TELL HQ box at that floor.
- In lists that show every floor, a card carries a stripe in its floor's colour and a swatch in its lane tag, instead
  of a floor tag; the timer stays on the right. TELL HQ's floor is a compact `to: Backend ▾` beside SEND. Its toast
  names the floor ("SENT TO BACKEND HQ.").
- The floor panel: USE AN AGENT / START A NEW HQ is one control, its buttons are bigger, and REMOVE says why a floor
  cannot go yet ("Not empty: 3 lanes, 1 question"). SETTINGS lists FLOORS first when you have two or more; Esc closes
  SETTINGS and its CLOSE stays in reach. The "+N MORE OUT OF VIEW" pill sits at the foot of the question list.

### Fixed

- **A new floor no longer sits in STARTING for good.** USE AN AGENT offers only agents that run in herdr on this
  machine (one that already runs a floor is shown, greyed, with that floor's name), and a floor's HQ that is not
  running is refused with what to do instead. A floor whose HQ is not running shows why, with **START ITS HQ** (the HUD
  starts `hq-<floor>` in a new herdr tab and makes it the floor's HQ) and **PICK ANOTHER**, on its tile, its row in the
  floor list and inside it. It is never the page-wide red alarm; that stays for an HQ that ran and stopped.
- START A NEW HQ's errors say what went wrong and what to do next.
- An HQ that is not there is drawn as a grey ghost at its terminal, not as if it were working.
- **Files a lane saves into a room's folder reach the shelf even when the system stops reporting file changes.**
  macOS's file event service can stall under load, and then nothing new reached the shelf. Every 20-second sync now
  also checks each open room's folder and catches the shelf up. `HUD_FOLDER_WATCH=0` turns the system's file events
  off and relies on that check alone.

## [0.20.0] - 2026-10-28

### Added

- **The floor bar, always on the page.** Over the office, a tab for every floor in its colour, with dots for the
  questions waiting on you there, and **+ FLOOR**. With one floor it is that floor's tab and + FLOOR, so you can find
  floors and add one; nothing else on the page changes. With two or more, **BUILDING** shows them all.
- **Inside a floor you can see where you are.** A header over the office says `◀ ALL FLOORS · BACKEND FLOOR · HQ:
  hq-backend · 2 NEED YOU`, the whole page is framed in the floor's colour, and a chip under the question tabs names
  the floor; its × (or Esc) steps back out, one level at a time.
- **THE BUILDING is a grid of your floors**, each tile a small picture of that floor's office (its workers where they
  are, its HQ at the terminal), with its name, what waits on you and ZOOM IN. A picture is redrawn only when that floor
  changes. Then + ADD A FLOOR and a short legend.
- **Adding a floor works end to end.** + FLOOR opens a panel: a name, a colour, and its HQ, either an agent that already
  runs in herdr (a lane you promote to run a domain, for example) or **START A NEW HQ**: the HUD opens a herdr tab beside
  your first HQ, in its folder, starts `hq-<floor>` in it and sends it the HQ guide for its floor. If herdr cannot, the
  panel says why and no floor is added. From a terminal: `hud floor add ID --start`.
- **EDIT** on a floor's tab, or in SETTINGS · FLOORS, renames it, recolours it, gives it another HQ, or removes an
  empty one after asking in the page.
- **TELL HQ has a floor select beside SEND** whenever you have floors, set to the floor you are in.
- **On a phone** the floor bar is a row of tabs under the top bar that you scroll sideways, the building a list of
  floors after your questions, and inside a floor its header and coloured frame.
- Every floor's HQ gets the HQ guide when it starts (the plugin's greet), with a line saying which floor it owns.

### Fixed

- **A new floor no longer raises "HQ isn't receiving".** A floor whose HQ has never run shows STARTING (amber) on its
  tab and tile, "waiting for <agent> in herdr", and holds what you send it until the HQ is up. After two minutes it says
  "not started", calmly, on that floor only. The red alarm is for an HQ that was running and stopped.
- A room opened from its address (`#room/...`) could stay closed when the page loaded quickly.

## [0.19.1] - 2026-10-28

### Fixed

- **One worker per desk.** With more than 28 lanes, two workers could sit at the same desk, because desks were
  counted out by name across every lane, even lanes in the queue or on the couch. Now:
  - only workers at their desks take one, and each keeps its desk while it stays there;
  - a newcomer takes the desk its name points to, or the next free one, so the same lanes always get the same desks;
  - with more workers at desks than desks, the rest stand in the aisles between the desk rows, one per spot.

## [0.19.0] - 2026-10-28

### Added

- **Floors: one HQ per domain.** One HQ agent can only direct so many lanes. A floor is one HQ agent and everything
  it runs, so you can run several HQs side by side: one for the frontend, one for the backend, one for legal.
  - Everything you have today becomes the first floor, and one floor works exactly as before. Name it with
    `HUD_FLOOR_NAME` (default `HQ`).
  - Add a floor with `hud floor add ID --hq AGENT [--name N] [--color #hex]`, where AGENT is that HQ's name in herdr.
    `hud floor list` shows each floor's HQ, whether it is receiving, its lanes and how many questions wait on you;
    `hud floor set ID` changes one; `hud floor rm ID` removes an empty one.
  - An HQ needs no setup: when it runs `hud`, the HUD recognises its herdr pane and files its questions, updates,
    lanes, rooms and board items on its floor. A lane belongs to the floor of whoever registered it, or of its
    parent; `hud lane NAME --floor ID` moves it, with every lane under it.
  - Your answers, NOT YETs and notes reach the HQ of the right floor only. A lane blocked on a prompt is reported to
    its own floor's HQ. A secret you set is shared: every floor's HQ hears of it.
  - Each HQ reads its own floor: `hud inbox`, `hud wait`, `hud ack`, `hud board`, `hud tree` and `hud room list`
    show that floor only, and `--all` shows every floor.
  - Each floor has its own "HQ isn't receiving" check, its own held messages and its own sweep nudge, about its own
    floor only.
  - One HQ can reach another floor's HQ: `hud floor tell FLOOR TEXT`.
- **Floors on the page.** With one floor the page is exactly as before. Add a second floor and the office becomes a
  building:
  - **THE BUILDING** shows one tile per floor, in its colour, with its HQ and how many questions need you, lanes are
    blocked, lanes are working and lanes it has. A red mark says when that floor's HQ isn't receiving. Click a tile to
    go in.
  - **Inside a floor** the office shows that floor's lanes, with its HQ at the terminal, under ◀ BUILDING and the
    floor's name. Esc takes you back out.
  - NEEDS YOU, MESSAGES, WORK, ROOMS, FROM HQ and SENT & ANSWERED, and their counts, follow the floor you are in. A
    line at the top says how many wait on other floors; click it to SHOW ALL. In the building, and with SHOW ALL, every
    card carries its floor's name and colour. WAITING ON YOU at the top always counts every floor.
  - Opening MESSAGES or MARK ALL READ inside a floor marks only that floor's messages read.
  - TELL HQ goes to the HQ of the floor you are in, and says which (`Tell HQ (Backend)…`). In the building, or with
    SHOW ALL, pick the floor beside SEND; it remembers the last one. A reply in MESSAGES goes to the HQ that wrote.
  - The "HQ isn't receiving" strip is about the floor you are in; in the building it lists every floor whose HQ isn't.
  - **SETTINGS · FLOORS** adds a floor (a name, its HQ from herdr's agents or typed, a colour), renames it, recolours
    it, gives it another HQ, and removes an empty one after asking in the page.
  - SECRETS stay shared by every floor.

## [0.18.0] - 2026-10-28

### Added

- **Files as well as images, on every send box.** Tell HQ, the answer on a NEEDS YOU card, a reply in MESSAGES and
  a room's send box now take files too.
  - Drop them on the box or anywhere on its panel or card, paste them into the box, or pick them with the attach
    button (on a phone it offers photos and files). The box lights up while files are over it.
  - A drop anywhere else on the page does nothing, and never opens the file in place of the page.
  - Each file shows in the box as a chip with its name and size and a × to remove it; images keep their thumbnail.
  - Allowed: pdf, txt, md, csv, tsv, json, log, yaml, yml, xml, zip, gz, tar, docx, xlsx, pptx, mp4, mov, webm,
    mp3, wav and m4a. Anything else (html, svg, js, sh, exe, dmg, pkg, app...) is refused with a one-line reason in
    the box.
  - Limits: 25 MB per file, 10 attachments per message. Images are as before: shrunk in the browser to at most
    2048 px, 10 MB at most.
  - When you send, each file is added to your text as `[file: /path]`, the full path on the HUD's machine, as images
    are with `[image: /path]`. HQ and lanes get it in their terminal, in `hud inbox` and in `hud room read`.
  - Sent messages show a file as a link with its name.
  - Files stay on this machine: in the data directory's `uploads/`, or in a room's `files/` (so they show on its
    shelf). They keep their own name, with `-2`, `-3` added when it is taken.
  - Files open sandboxed: images and video show in the browser; everything else downloads.

## [0.17.0] - 2026-10-28

### Added

- **Everyday gadgets.** Each worker in the office has a habit: a coffee mug, a water bottle, a donut or a big
  tumbler with a handle and a straw.
  - While a worker sits at its desk, the gadget stands on the desk beside the monitor.
  - Standing or walking, the worker holds it.
  - About once a minute it takes a sip or a bite. At the desk it lifts the gadget to its hand, then puts it back.
  - Now and then it brings something else for a couple of hours, or nothing at all.
  - A worker holding a seasonal item carries the gadget in its other hand.
  - Gadgets work in both themes and never cover a status bubble, a name label, a mask's mark or a player's number.
  - Your hero and HQ hold none.
  - Sips add no frames: POWER SAVER shows none.

### Fixed

- `hud room brief SLUG` (and other commands that can read text piped in) no longer waits forever when stdin is left
  open but silent, as an agent's tool or a background job may leave it. With no input within a second it counts as
  nothing given, and the brief is printed.

## [0.16.2] - 2026-10-28

### Fixed

- **No more backlog replays.** 0.16.1 treated every message typed into HQ before the upgrade as unconfirmed, and
  sent the whole backlog again. Now:
  - messages from before confirmed delivery count as delivered;
  - only a message typed in while HQ was busy in the last 3 hours is sent again;
  - at most 3 go again each time HQ is free.

### Added

- **`hud secret redact NAME`.** For a secret's value that was typed somewhere it should not be, such as an answer, a
  note or an update. The server replaces it wherever it is stored with `[secret NAME]`, using the value it holds,
  which never passes through the command. Overwritten data is zeroed and the database journal truncated, so the
  value is gone from the files. It works from this machine only, never from a browser, and the event log says how
  many rows were redacted.

## [0.16.1] - 2026-10-28

### Fixed

- **Your answers and notes reach HQ, confirmed.** Five answers were typed into HQ's pane while it was busy, which
  herdr accepts, and were then lost in HQ's session. Now:
  - when HQ is idle, the HUD waits until HQ starts working on what it typed in;
  - if HQ does not start, the message is held, the red strip says so, and it is tried again;
  - anything typed in while HQ was mid-turn is sent once more as soon as HQ is free, unless HQ acked it in the
    meantime, marked "sent again" with the command to ack it.
- **SENT & ANSWERED shows where each one stands:** typed in while HQ was busy, delivered to HQ, HQ has it / HQ acted
  (acked), or HELD.

## [0.16.0] - 2026-10-28

### Added

- **CLOSE ROOM.** You can close a room yourself from its view. CLOSE ROOM asks first, in the page: CLOSE IT
  archives the room, and KEEP IT OPEN backs out. A closed room shows ARCHIVED, stops taking messages and moves under
  ARCHIVED in ROOMS. Its folder and thread stay, and `hud room create SLUG` reopens it as before. The event log says
  you closed it, and HQ hears it at once.

## [0.15.0] - 2026-10-28

### Changed

- **Markdown everywhere.** Every place the HUD shows text from HQ or a lane renders markdown the same way: question
  titles and bodies, checklists and HQ's comments on a question, MESSAGES, FROM HQ, SENT & ANSWERED, your last
  note, the worker card's title and note, the WORK board, the ROOMS list, a room's title, brief and thread, and
  what is held while HQ isn't receiving. Bold, italic, `code`, headings, bullet, numbered and task lists (nested),
  quotes, links and code boxes with COPY all work; line breaks show. Titles and one-line places show inline
  markdown only. Links open in a new tab and go only to http(s), mailto or the HUD's own files; anything that
  looks like HTML stays text.
- **Long text and code boxes.** MORE now also folds long text that contains code, but never cuts a code box or
  hides one: the text up to and including the last code box always shows. A long line in a code box scrolls
  sideways inside the box, so a phone never scrolls the whole page; long words and URLs wrap.
- **A blocked prompt** on the worker card shows in a code box with COPY, exactly as the agent printed it.

## [0.14.0] - 2026-10-28

### Added

- **COPY on a secret.** Each secret in the SECRETS tab has a COPY button that puts its value on your clipboard, for
  example to hand a login to someone. The server gives the value only to the HUD's own page: its own origin, or one
  in `HUD_TRUSTED_ORIGINS`, so it works from your phone on the tailnet too. It does so only when you click, and never
  to another site or to a client without an origin (that is `hud secret get`). The value goes straight to the
  clipboard and is never written into the page, its storage, `/api/state`, the log or the database. Each copy adds
  an event line ("copied NAME"). Over plain http from another device, the browser may refuse the clipboard; open
  the HUD over https (the tailnet address) or on this machine.

## [0.13.0] - 2026-10-28

### Changed

- **QUESTIONS is now NEEDS YOU.** It holds everything you are the blocker on, and each card says which kind it is:
  a **QUESTION** to decide (options, SEND), a **TO DO** only you can do, like recording a video, merging a PR or
  signing in (DONE or NOT YET), or **FYI** (OK). It is the same ask as before, so `hud ask` is still the way in, and
  answers and comments work as they did. A TO DO is `hud ask --kind action`.

### Added

- **NOT YET on a TO DO.** It keeps the card open, since you are still the blocker. HQ hears it at once with whatever
  you typed as a note, and a line on the card says when. DONE closes it as before.

## [0.12.0] - 2026-10-28

### Added

- **HQ SWEEP: the HUD can nudge HQ to sweep.** A new row in SETTINGS, off by default. When it is on, the HUD types
  one "HUD sweep:" line into HQ, listing what needs a look: idle or done lanes (an idle lane must be idle for a
  reason, and only HQ can judge it), gone lanes, stalled board items, questions waiting on you, and rooms with
  undelivered messages. It only goes when:
  - HQ is idle or done right now, never in the middle of a turn, and is receiving;
  - the interval (20, 30 or 60 min) has passed since the last nudge;
  - the hour is in the window (8-24 by default, this machine's clock);
  - something needs a look. A quiet office gets no nudge.
- **No pile-up.** A nudge HQ does not act on doubles the wait for the next, up to 2 h. A nudge that cannot go is
  dropped, never queued. Each nudge is a line in the event log, and the row shows the last and next one.
- It runs on the HUD's existing 20-second check, with no timer of its own. The settings are kept with your other
  settings and survive restarts. Secrets are not touched.

## [0.11.2] - 2026-10-27

### Fixed

- **Clicking an option in a question no longer slides the list away from it.** Picking an option built the whole
  question list again and then put the focus back on that question's text box, and the browser scrolled the list
  to the box. Now an option changes its card in place. When the list is built again (a new question arriving), it
  keeps its place. Focus only goes back to a box you were typing in, without scrolling anything.
- The same in MESSAGES: the reply box gets its focus back without moving the list.
- In a conference room, the TO dropdown is no longer rewritten while it is open. It used to close or jump when a
  lane came or went; it now catches up when it closes.

## [0.11.1] - 2026-10-27

### Fixed

- **`hud room brief SLUG` no longer wipes the brief.** With no `--body` and nothing piped in, it read an empty brief
  and saved it, clearing the room's brief. Now it prints the current brief and never writes. An empty `--body` is
  refused, and clearing a brief takes `--clear`. The server refuses an empty brief from any client that does not ask
  to clear it.

## [0.11.0] - 2026-10-27

### Added

- **Every room has its own folder.** A room is now a real folder on the HUD's machine, `rooms/SLUG/` in its data
  folder, holding `files/` (everything shared in the room), `shelf.json` (the shelf) and `brief.md` (the brief).
  `hud room path SLUG` prints it, `hud room create` prints it too, and every message you send a lane from a room
  tells it where the folder is.
- **Lanes can drop files straight in.** A file a lane saves into an open room's `files/` appears on the shelf once it
  is fully written, marked as added by "folder"; a file deleted from `files/` drops off the shelf. Nothing polls: the
  HUD only looks when the folder changes.
- **Add to the shelf from the page.** The shelf has **+ ADD**: pick files, or paste a link with a title. You can also
  drop files anywhere on a room, or paste an image into it. It works on a phone in the SHELF tab.

- **Ranks you can see in ARENA.** Every worker wears a mask whose shape is its rank: ★ star (the top level, ours
  above the show's three), ■ square, ▲ triangle, ● circle; deeper than that, a numbered player. The shape is on the
  mask from the front and on the back of the hood, and the same symbol sits in front of the name label, so a rank
  reads even from behind at a desk. A lane straight under HQ is the top level from the start, so a flat team is a
  team of PMs, not of players. HQ keeps its crown and you stay the game master.
- **A lane's level, set by hand.** `hud lane NAME --level L` gives a lane one of your level names over the one the
  tree gives (`--level auto` gives it back); the card and `hud tree` show it. A level list in SETTINGS that starts
  with HQ now names HQ's own level, so "HQ, PM, Senior Engineer, Engineer" works as typed.

### Changed

- Files on the shelf keep their own names (`report.html`, not a timestamped name); a second file with the same name
  becomes `report-2.html`.
- Images you attach to a message in a room are saved in that room's folder and appear on its shelf. Remove one from
  the send box before sending and it comes off the shelf again.
- Shelf files are served from `/rooms/SLUG/files/NAME`, always sandboxed: images show inline, text files as plain
  text, and HTML, SVG and other files download instead of opening in the HUD.
- Existing shelf files move into their room's folder the first time the HUD starts with this version. Links to the
  old `/room-files/...` addresses in earlier messages still work.

### Fixed

- **Updating from 0.10.0 keeps your secrets too.** A server from before the handover cannot export its secrets, so
  the restart that installs this version reads each one the way `hud secret get` does, over loopback into memory,
  and gives it to the new server with its original deadline. From here on every planned restart keeps them.
- **HQ keeps its name.** herdr can drop HQ's agent name while HQ is still running in its pane (for example when a
  background job started from HQ's pane compacts its context). The HUD now remembers HQ's pane and gives the name back
  on its own, within a second if a message finds it gone, so notes and answers arrive without anyone noticing. It
  only does this while the same agent has stayed in that pane; if the pane emptied or another agent took it, the red
  strip and its NAME button ask you instead. `HUD_HQ_RENAME=0` turns it off.
- A test run that hangs stops itself: every child process a test waits on has a timeout, and a whole `bun test` run
  stops after 15 minutes (`HUD_TEST_LIMIT_MIN`), with what it started.

## [0.10.1] - 2026-10-26

### Fixed

- **Secrets survive a plugin update.** Restarting HQ Office (the reload or install service action, which every plugin
  update needs) used to clear every secret silently, even ones set for a week. Now the plugin hands them from the old
  server to the new one, memory to memory, with their original deadlines. Values are still never written to disk.
- **A secret lost in a crash is never lost quietly.** If the server stops without a handover (a crash, a kill), the
  SECRETS tab lists each lost name in red with when it was lost, `hud secret list` marks it LOST, `hud secret get`
  says it was lost and to ask you to set it again instead of "not found", and HQ gets a one-line note. Set the secret
  again, or dismiss the name.
- **Expiry times say the day.** "expires 1:45:01 PM" read like now even when it was tomorrow. Every expiry (the
  SECRETS tab, `hud secret set` and `list`, answers to secret questions, notes to HQ) now reads like
  "expires in 6d 23h (Mon 2 Nov, 13:45)" or "expires in 23h (tomorrow 13:45)".

## [0.10.0] - 2026-10-26

### Changed

- **A conference room is its own view.** Opening a room (from the ROOMS list, the strip of rooms, or a link to
  `#room/SLUG`) swaps the office on the right for the room itself, full height. BACK TO OFFICE, Esc or the browser's
  back button take you back, a reload keeps you in the room, and the strip at its top moves straight to another open
  room, with its new messages marked. Your questions stay where they are: a room never covers or shrinks the
  question column, and Tell HQ stays under it.
- **The conversation comes first.** The thread fills the room with the send box (TO, attach, SEND) always in view at
  its foot. The lanes, linked work, brief and shelf sit in a rail beside it that you can fold; this browser remembers
  your choice. The thread, the rail and the ROOMS list each scroll on their own.
- **A small conference room at the top of each room:** its lanes at the table in their office sprites, you at the
  head, a lit laptop for each lane that is working and the office's bubbles for the rest. It is drawn only when
  something in it changes.
- **On a phone, a room fills the screen** with CHAT, BRIEF and SHELF tabs and a back button that says how many
  questions are waiting. The send box stays above the keyboard.
- The office draws as it did before 0.9: no glass room in the bottom-left corner and no lanes gathering there, and
  the fourth row of desks is back (28 desks). The office stops drawing while a room covers it.

### Fixed

- Line breaks in a room's messages show: a new line breaks the line, a blank line starts a paragraph, and lists and
  code boxes render as in the brief.

## [0.9.1] - 2026-10-26

### Fixed

- **The page says at once when HQ isn't receiving.** Every sync (every 20 seconds) checks that an agent with HQ's
  name is in herdr and can take input. When it isn't (herdr dropped the name after a restart or resume, HQ is stopped
  at a permission prompt, or herdr does not answer), a red **HQ ISN'T RECEIVING** strip at the top says why and since
  when, before you write into the void. The tab title says it too, and Tell HQ's box tells you that what you send is kept.
- **Nothing for HQ is lost.** Notes, answers and other messages for HQ that cannot be typed in are held and marked
  **HELD** in red, not "not picked up yet". They are listed under the strip, and sent in the order you wrote them the
  moment HQ can take them, each marked with when it was written. Anything HQ already read with `hud inbox` is not
  sent again.
- **One click to fix it.** When herdr dropped the name but HQ's last pane still holds an agent, **NAME** gives that
  pane HQ's name back (`herdr agent rename`) and sends what was held. **CHECK NOW** checks again without waiting for
  the next sync.

## [0.9.0] - 2026-10-26

### Added

- **Conference rooms: talk straight to the lane that owns a piece of work.** HQ opens a room for a piece of work
  with `hud room create SLUG --title T --owner LANE` (members at any level, issues and PRs too). The owning lane
  keeps a pinned brief in markdown (`hud room brief`) and a shelf of artifacts (`hud room artifact`: Claude
  artifacts, links, images and files) current, so the room is the work's project folder: open it for the concrete
  context of that problem.
- **A ROOMS tab** next to WORK, counting rooms with new messages. The list shows each room's owner and level, the
  state of its work on the board and its last activity. An open room shows its lanes with their level and status,
  its issues and PRs with their board state, the brief, the shelf as cards, and the thread. Write to the owning
  lane or pick another lane in the room with TO, attach images as anywhere else, and REPLY to a lane's message.
  Works on a phone: the thread opens at its newest message, scrolls inside itself and keeps your place when
  something new lands.
- **Your message reaches the lane itself.** It is typed into that lane's terminal through herdr, with how to
  answer (`hud room say`) and a reminder to keep the brief and artifacts current. A message for a lane that is away
  stays in the thread as AWAY · KEPT and is typed in once, when the lane is back. Lanes read your messages with
  `hud room read SLUG [--since ID] [--wait]`.
- **A conference room in the office.** Glass walls, a table and six chairs in the bottom-left corner. While a room
  is talking (five minutes after its last message), its lanes that are not busy elsewhere walk over and sit at the
  table.
- The HQ guide tells HQ that work with an owning lane can get a room, kept current by that lane.

### Changed

- The question column's tabs tighten to fit four on a narrow column or a phone, and scroll sideways rather than ever
  widening the page.
- With 22 or more lanes, the fourth row of desks starts beside the conference room (from x 9), so the office holds
  24 desks instead of 28.

## [0.8.3] - 2026-10-26

### Fixed

- **A lane stuck at a prompt in herdr is no longer invisible.** When a lane's agent stops at a permission prompt
  (Claude's "Do you want to proceed?") or a question (Codex's question picker), herdr reports it as blocked, and the
  lane now reads **BLOCKED ON A PROMPT** everywhere: a red bubble over its worker at its desk, a red BLOCKED count in
  the top bar (only while there is one; click it to open that lane), the worker card with what the agent asks (the
  question and its options) and the machine and pane to go and answer it in, the work item at the very top of the
  WORK board with the prompt as its reason, and first in `hud board`, which also lists blocked lanes with no
  tracked work. A blocked lane is blocked before anything else, even with a question of yours open on it.
- **HQ is told when a lane gets stuck at a prompt**, once per prompt: "Lane L is blocked on a prompt in herdr
  (machine, pane): ...". It clears when the lane moves on. `HUD_HQ_BLOCKED=0` turns the message off.

## [0.8.2] - 2026-10-25

### Fixed

- **A question no longer makes a working lane look stuck.** A lane can hold a question for you and keep working at
  the same time. A lane whose agent is working (or still has shells, a monitor or subagents running) now reads as
  working even with a question open: its worker stays at its desk with a still "!" over its head, and only a lane
  that has stopped queues at the counter. WAITING ON YOU in the top bar still counts every open question, and the
  worker card lists the lane's questions.
- **On the work board, a question holds only the work it is about.** A piece of work waits on you when a question
  names its issue key or one of its PRs. A question on a lane that names no tracked work holds that lane's work only
  while the lane is not working. A question that names one issue no longer marks the lane's other issues as waiting
  on you. Each item still says which question holds it.

### Added

- **`hud update ID --lane L` moves a question to another lane**, and `--lane hq` (or `--lane ""`) takes it off every
  lane.

## [0.8.1] - 2026-10-24

### Changed

- **Every send box is one composer, like a chat app.** Tell HQ, each question's answer box and a reply in MESSAGES
  are now a single rounded box: your images on top, the text field at full width (no more short lines wrapping
  beside the buttons), and a slim row under it with the photo button on the left and SEND, DONE or OK on the right.
  The field grows with what you type, up to five lines, then scrolls. On a computer the box stays compact: about
  22 px taller than before for a question's answer, 16 px for Tell HQ, and about the same for a reply.
- **Images are thumbnails in the box.** Each attached image is a rounded thumbnail with a small round × on its corner
  (an easy target on a phone). While it uploads it is dimmed under a spinner; a failed upload gets a red ring and a
  retry icon (tap it to try again); an image that is too big or that the browser cannot read stays in the box with
  one line saying why. Tap a thumbnail to see it full screen; tap outside it or the close button to go back.

## [0.8.0] - 2026-10-24

### Added

- **Attach images from a phone.** Every send box (Tell HQ, each question's answer, a reply in MESSAGES) has an
  ATTACH button beside SEND. On a phone it opens the phone's own menu (photo library, camera, files); on a computer,
  a file picker. Pick several at once. Each image is shrunk in the browser to at most 2048 px on its longest side,
  as JPEG (or WebP where that is smaller), so uploads are quick on a phone connection and iPhone HEIC photos, which
  the server does not take, arrive as JPEG. GIFs and images already small are sent as they are.

### Changed

- **Images show as chips under the box, not as paths in your text.** Picked, dropped or pasted images appear as
  thumbnails with a × to remove them, and the text box stays clean. On send the `[image: /path]` tokens are added at
  the end of the message, so HQ receives the same as before. A failed upload shows on its chip with RETRY; an image
  that is too big or that the browser cannot read says why. Images are part of the draft: they stay through live
  updates and a reload, and clear once sent.
- **Drafts survive any reload.** Unsent text, an open reply and attached images used to be kept only when the page
  reloaded itself after an update; now they are kept on every reload, and when a phone drops the page while its
  camera is open.

### Fixed

- On a phone, any tap inside MESSAGES or FROM HQ rebuilt the question list, the thread and the log. Only MORE does now.

## [0.7.2] - 2026-10-24

### Fixed

- **ARENA now visibly dresses the whole room.** With ARENA picked and no lane tree, every worker was already given
  the player look, but that look was a teal shirt and a tiny number on the worker's everyday sprite, with the
  season's hat still on top, so at real size nobody looked in costume. The hero and HQ were never dressed at all.

### Changed

- **A theme dresses every figure in the room, whatever the levels.** In ARENA:
  - **Players** (the deepest level, and everyone when lanes have no tree) wear one matching numbered tracksuit:
    top and trousers alike, white piping, a white zip, white trainers and a white number on the chest and back.
    Each player keeps its own hair and face. Seasonal hats and coats are left off; seasonal things in the hand stay.
  - **Guards** (levels 1 and 2 in a tree) are as before (a square or a triangle on the mask), now with nothing
    seasonal over the mask.
  - **Your hero** behind the counter is the game master: a long black coat with gold buttons, black gloves and a
    black mask with gold eyes. The mask covers only the face, so the HERO you picked keeps its hair (and glasses).
    It stays in costume while it stands, dances and moonwalks, and asleep in bed at night. No hat is drawn on the
    mask, so HERO HAT has no effect in ARENA.
  - **HQ** at its terminal is the senior guard: the hooded suit with a gold crown on the back of the hood.

  OFFICE looks exactly as before: its everyday clothes are its costume, and a tree adds the suit and the cardigan.

## [0.7.1] - 2026-10-24

### Changed

- **MESSAGES and FROM HQ take a bounded height on a phone, each with its own scroll.** With a busy day they used to
  stretch the page to about 13,000 pixels, so Tell HQ, the room and the worker card were thousands of pixels away.
  Now the page is about 1,800 pixels tall on an iPhone: MESSAGES fits on one screen with its tabs and Tell HQ, and
  FROM HQ (with SENT & ANSWERED and SECRETS) fits on one screen with the room. Swiping inside a list scrolls that
  list, with momentum, and reaching its end does not drag the page; a fade at an edge shows there is more that way.
  MESSAGES still opens at the newest message and stays there while you are at the bottom; reading older messages or
  older updates, a live update or a reply no longer moves what you read (FROM HQ used to jump by one update). At the
  top of FROM HQ a new update shows first. The desktop is unchanged.

## [0.7.0] - 2026-10-24

### Added

- **Lanes in levels.** Lanes can now form a tree under HQ: a lane reports to HQ (level 1), or to another lane, which
  puts it one level deeper. HQ or a lane sets it with `hud lane NAME --parent OTHER`; `--parent hq` puts a lane
  straight back under HQ. A lane that starts lanes of its own registers them with itself as their parent. A parent
  that would make a loop is refused with an error that shows the chain, and when you remove a lane, the lanes that
  reported to it move up one level instead of being lost. Nothing changes until a lane gets a parent.
- **Name your levels.** SETTINGS has LEVEL NAMES: one name per level from the top, comma-separated. The default is
  `Manager, Lead, Engineer`; `PM, Senior, Junior` or `L1, L2, L3` work just as well. Lanes deeper than your list take
  the last name.
- **See the levels in the room.** Once there is a tree, each level dresses differently, and every worker keeps its own
  hair, skin and colours. Pick the look in SETTINGS under LEVEL THEME:
  - **Office** (the default): level 1 wears a dark suit and a tie in its own colour (all suit from behind), level 2 a light cardigan over
    its own shirt, level 3 and deeper the everyday look. A room without a tree looks exactly as before.
  - **Arena**: levels 1 and 2 are masked guards in a magenta hooded suit, with a white square (level 1, who also
    wears a black belt) or a triangle (level 2) on the black mask and on the back of the hood; level 3 and deeper are
    players in a teal tracksuit with a white number. In a room without a tree, everyone is a player. Our own art, not
    any show's.
- **A level mark on every name label**, so the level reads from any side, even from behind at a desk: three pips
  for level 1, two for level 2, one for level 3 and deeper, in a colour that matches the theme's look (Office: gold,
  cream, blue; Arena: pink for guards, teal for players). Only in a room with a tree.
- **The worker card** shows the lane's level and its chain up to HQ, for example `HQ > web-pm > api-lead > api-auth`;
  click a step to open that lane.
- **`hud tree`** prints the tree with each lane's level name and status (`--json` for JSON). On the WORK tab and in
  `hud board`, the work in each state is grouped under the lane its lane reports to; stalled work still comes first.

## [0.6.4] - 2026-10-23

### Fixed

- **Messages scroll like a chat on a phone.** MESSAGES opens at the newest message instead of eight screens above
  it; at the newest message, a new one stays in view; reading older ones, a live update or a reply landing above no
  longer moves what you are reading (the same holds for the questions). The QUESTIONS / MESSAGES / WORK tabs stay at
  the top of the screen while their list scrolls, and switching tabs starts the list at its top. The sent log under
  the room no longer scrolls inside the page. The desktop layout is unchanged.
- **No zoom on a phone.** The page no longer zooms on a pinch, a double tap or a tap into a text field (every text
  field is 16px on a phone).

## [0.6.3] - 2026-10-23

### Fixed

- **Running the plugin's script by hand could point the service at an empty board.** Outside herdr, the script fell
  back to folders inside the plugin, so a restart rewrote the service to a new, empty database and dropped your
  config.env settings (nothing was lost; the real data stayed put). The installed plugin now finds herdr's own
  config and data folders when run by hand, and restart refuses to point an installed service at a different data
  folder than the one it uses (`--force` moves it on purpose).
- The plugin's messages give the exact restart command, `herdr plugin action invoke hq-office.reload`.

## [0.6.2] - 2026-10-23

### Fixed

- **A phone can use HQ Office again.** Since 0.2.0 every page that is not this machine's own was refused, which also
  stopped a phone opening the page through `tailscale serve`: it loaded empty and every answer was "forbidden". List
  your phone's page address in `HUD_TRUSTED_ORIGINS` (exact, comma-separated) and it can read and answer like the
  machine's own page. Every other site is still refused, and secrets stay this machine's own page only. Thanks to
  Aleksander (PR #2).

## [0.6.1] - 2026-10-23

### Fixed

- **SETTINGS no longer hides your hero.** The panel opens from the bottom right, so the hero behind the counter
  stays in view and a click on a hero or a hat shows its result at once.

## [0.6.0] - 2026-10-23

### Added

- **A PERFORMANCE setting in SETTINGS: SMOOTH, BALANCED or POWER SAVER**, saved on the server with the other
  settings and applied at once. SMOOTH (the default) draws walking, the hero's dance, snow, leaves, event effects
  and steam at 30 frames a second, focused or not. BALANCED is the 0.5.0 room: walking at 10 frames a second, small
  motions on a slow beat. POWER SAVER freezes everything but walking workers (8 frames a second); a room where
  nobody walks shows no new frames at all. What it costs, measured in Safari with the page in front: SMOOTH about
  3 to 4% on an ordinary day, but about 15% all day in snowy and event weeks, when the weather never stops; BALANCED
  about 2%; POWER SAVER about 1%.

### Changed

- **A quiet room costs less.** The room's small motions (desk screens, HQ's terminal, coffee lights, bobs, nods,
  bubbles) now share one beat, so they share frames: in BALANCED a room where nobody walks shows 1 frame a second
  (was 2) in a plain season and 2 (was 4) in snowy and event weeks. The coffee machines' lights blink once a
  second, and the kitchen machine steams only while someone takes a coffee.

## [0.5.1] - 2026-10-23

### Changed

- **Chimes you recognise across the room.** A new question now plays a marimba call ("dum, da-DUM", rising), and a
  new message from HQ plays a soft bubble pop and a bell. Different instruments, so you tell them apart at once.

## [0.5.0] - 2026-10-23

### Changed

- **The room costs about an eighth of what it did.** A browser pays for every frame it shows, whatever is drawn, and
  the room used to show 12 to 30 frames a second all day even when nothing in it moved. Now it shows a frame only
  when something visible changes: 10 a second while someone walks, otherwise one per quarter-second beat for the
  room's small motions (screens, steam, the hero's dance), and none when nothing changes. Measured in Safari with the
  page in front: from about 26% extra CPU to about 3%. On a second screen, about 2 to 4 frames a second instead of 12.
  It still animates whenever the window is visible, focused or not.
- **Idle workers are calmer.** They rest 8 to 20 seconds between errands instead of 1 to 3, so someone is walking
  about 15% of the time instead of 36%.
- The hero's dance steps on the beat: each move is a short ground-and-air bounce.

## [0.4.0] - 2026-10-23

### Added

- **HQ learns to talk to you through the HUD.** An HQ agent that answered your notes in its own terminal was never
  heard. Now, when herdr detects your HQ agent starting, the plugin types a short guide into it once per session
  (reply with `hud tell` or `hud comment ID`, ask with `hud ask` and edit in place, track work on the board, read
  `hud board` every sweep), and every note, answer and reply typed into HQ ends with a one-line reminder to reply
  through the HUD. `hud guide` prints the guide; the status pane says whether HQ's current session has it.
  `HUD_HQ_HINT=0` and `HUD_HQ_GREET=0` turn the two off.

## [0.3.2] - 2026-10-23

### Fixed

- **A lane in a phase HQ named itself (such as "paused") never got its background work checked**, so a lane running
  a subagent or shells still read as HQ's turn. Every lane that would otherwise read as HQ's turn or stale is checked now.

## [0.3.1] - 2026-10-23

### Fixed

- **Lanes running a subagent read as waiting on HQ.** An agent that is idle while a subagent works (its status bar
  shows "← 1 agent", or its pane lists a running subagent such as "◯ general-purpose ... 34m 0s"), or while
  shells and monitors run ("1 shell, 1 monitor"), now counts as moving.
- **Re-tracking finished work.** `hud track ISSUE` on an item whose pull requests have all ended reopens it as
  moving: PRs that ended before you tracked it again no longer count towards done, so a new PR decides.

## [0.3.0] - 2026-10-23

### Added

- **Service mode.** The new **install service** action runs HQ Office as a per-user service that starts when you
  log in and restarts if it stops: a LaunchAgent on macOS, a systemd user unit on Linux. Run it again after a
  `config.env` change or a plugin update to rewrite the service and restart it; **remove service** takes it away
  and leaves your data where it is. With the service installed, start, stop and restart use it instead of a
  background process, and the status pane says whether the service is installed and running.
- **The `hud` command, installed for you.** The **install hud command** action puts `hud` in `~/.local/bin`,
  pointing at the plugin's `hud.ts` and your server's port, and tells you if that folder is not on your PATH. Run
  it again to update it. It never replaces a `hud` that is not its own; it tells you what that one points at and
  how to replace it.

### Changed

- **Settings are kept on the server.** Your hero, season, hero hat and SOUND are saved in the data directory, so
  they survive a restart, a plugin update and clearing your browser's data, and every browser you open HQ Office
  in shows the same ones. The first time you open the page after updating, the settings your browser remembered
  are moved to the server.

### Fixed

- **Lanes that were working read as waiting on HQ.** An agent that is idle but still has shells or a monitor running
  in the background (its pane ends with "2 shells still running" or "monitor still running") now counts as moving,
  in the room, the top bar and the work board, instead of HQ's turn or stale.

## [0.2.0] - 2026-10-23

### Added

- **FROM HQ.** HQ can now tell you things without asking: `hud tell --title "PR is up" [--body ...] [--lane ...]`
  (`hud say` works too). Updates land in the FROM HQ feed under the room, the top bar counts the unread ones, and
  you can mark one or all of them read.
- **The MESSAGES tab.** One thread, oldest at the top, of HQ's updates and your notes. Reply to any message: the
  reply reaches HQ as a note that says what it answers. Your notes show whether HQ has picked them up yet.
- **The work board.** A WORK tab lists every piece of work in flight: its issue, its pull requests and the lane that
  owns it. Each item's state (done, waiting on you, waiting on CI, paused, moving, stalled) is worked out from
  GitHub, the lane and your open questions. Stalled work shows as a red strip at the top of the question column.
  HQ uses `hud track`, `hud done`, `hud pause`, `hud resume` and `hud board`. Needs the `gh` CLI.
- **Questions that change in place.** HQ can edit an open question (`hud update`) instead of withdrawing and
  reposting it; the card shows EDITED and the time, and your typed answer stays. HQ can comment under a question
  (`hud comment`) and give it a checklist (`hud ask --item ...`, `hud item`). A checklist item that names a pull
  request ticks itself when that PR merges, and a question whose items are all done closes itself.
- **The secret drop.** Paste an API key or token into the SECRETS tab, or into the fields of a question HQ asked
  with `hud ask --secret NAME`, with a lifetime in minutes. HQ reads it with `hud secret get NAME | <command>`
  until it expires. Values stay in the server's memory only: never in the database, a log, the page or a listing.
- **Settings.** A SETTINGS panel to pick your hero (the default one carries your `HUD_OWNER` name), the season and
  the hero's hat, each remembered in your browser, with a reset to defaults.
- **Seasons and holidays.** The room follows the calendar: spring, summer, fall and winter views out of the
  windows, snow and falling leaves, and its own decorations for Christmas, New Year, Valentine's Day,
  St. Patrick's Day, Easter, Halloween and Thanksgiving. Workers and the hero wear seasonal hats and carry seasonal
  items. Preview any season with `?season=halloween` (or any other) or from SETTINGS.
- **The break room.** Idle workers wander to the break room for coffee and snacks, chat in pairs, and check their
  watch now and then while they wait.
- **The hero's dance and sleep.** With nothing waiting on you, the hero behind the counter dances a routine that
  ends in a moonwalk. From midnight to seven the hero sleeps in a bed behind the desk instead.
- **New character sprites.** Handheld-RPG style workers with 12 kinds of head and hair.
- **Machine health.** A chip per machine in the top bar shows its CPU and memory, sampled every minute. Remote
  machines in `HUD_MACHINES` are sampled over SSH.
- **A chime for new questions.** Turn SOUND on and a short chime plays when a new question arrives. Generated in
  the browser, no audio files.
- Long messages fold to a few lines with MORE and LESS.

### Changed

- **A new layout.** Questions on the left, the room and the feed on the right.
- **Your name, not a fixed one.** The notes and answers HQ is sent, and the event log, name you from `HUD_OWNER`,
  or "the owner" when it is unset. Events logged by 0.1.0 read as yours.
- **Lighter on your machine.** The server sends each open page only the parts of the state that changed, and the
  page redraws only the panels whose data changed. The room copies pre-painted sprites instead of drawing every
  pixel, stops drawing while the tab is hidden, and keeps animating (at a lower frame rate) when the window is
  visible but not focused. Fewer disk writes per herdr sync and per machine sample, and one SSH connection kept
  for remote machine stats.
- **For contributors.** The page and the server are split into one file per concern (`public/`, `src/client/`,
  `src/server/`), so a new feature arrives as new files. `AGENTS.md` and `docs/structure.md` explain the layout,
  and `scripts/release.ts` is the release routine.

### Fixed

- **FROM HQ was always empty.** The released page had the tab but the server had no routes for it. Thanks to
  Aleksander (PR #1).
- **The plugin's actions and status pane failed with "No such file or directory"** when herdr's PATH did not
  include `~/.bun/bin`, Bun's default install folder. Every action and the pane now add it. Thanks to Aleksander
  (PR #1).
- **Every note to HQ said the same fixed name.** It now uses `HUD_OWNER`. Thanks to Aleksander (PR #1).
- Standing workers no longer stack on one tile.
- The log of what you sent and answered shows notes and answers in one time order.
- An answer is saved and shown as sent even when herdr cannot be started to deliver it.
- A page closes its stream when it goes away and reopens it when shown again from the browser's back-forward cache.

## [0.1.0] - 2026-10-22

The first public release.

### Added

- **The office.** A pixel-art room in the style of a handheld RPG where every herdr lane (one agent working one
  task) is a worker at a desk, coloured by status: working, waiting on you, waiting on HQ, done. Click a worker for
  its card. HQ sits at its terminal, and the hero dances behind the counter when nothing is waiting on you.
- **The question panel.** HQ's questions, most urgent first, with options to pick or a box to type in. Your answer
  is typed straight into the HQ agent's session the moment you send it, and stored, so nothing is lost if HQ is
  busy. Code in a question shows in a box with a copy button.
- **Tell HQ.** A free-text box for anything HQ did not ask about.
- **Images.** Drop or paste an image into any text box; it is saved and its path put into the text for HQ to open.
- **The herdr plugin.** Install with `herdr plugin install`, then the start, stop, reload and open actions and a
  status pane. Configured in `config.env`; the database and images live in the plugin's state directory and
  survive reinstalls.
- **The `hud` CLI** for HQ: add lanes, ask questions, wait for answers, read the inbox.
- The page reloads itself when the server changes.
