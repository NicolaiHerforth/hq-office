# Changelog

All notable changes to HQ Office are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Click a worker to put its lane in focus.** The question column then shows only that lane: its questions,
  answered right there, its messages (HQ's updates about it, its questions asked and answered, your replies) and its
  work, under a bar with its status, issue, PR and projects. Everyone else steps back in the room and the lane stands
  in a yellow ring. CLEAR, Esc or a click on the empty floor shows everyone again; on a phone a tap in the room goes
  up to the column.
- **Roles and projects for lanes.** `hud lane NAME --role orchestrator|pm|builder|walker` dresses the worker (a
  headset, a clipboard, a hard hat, a magnifying glass) and colours its name tag; `hud lane NAME --project
  "NAME=URL"` lists the lane's projects, linked from the focus bar.

### Changed

- **Only a lane that needs you has a speech bubble.** It is red with a white "!", over a red glow, with its name on
  red. A lane waiting on HQ no longer shows a "?" bubble that looked like a question for you; it stands beside HQ
  with none. Waiting on CI, parked and done keep a small mark without a bubble.
- The HQ guide tells HQ to name the lane on every question (`hud ask --lane L`), since that is what makes the
  lane's worker show it needs you, and to say what each lane is (`hud lane NAME --role R --project NAME=URL`).
- The worker card under the room is gone: its contents moved to the focus bar over the question column, and the
  FROM HQ panel has the row to itself.

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
