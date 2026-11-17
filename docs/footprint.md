# The footprint

What HQ Office costs the machine it runs on, on a normal day with the owner's page open: the server, what the
server starts, the page in the browser, the hooks and the plugin, and the disk. This page is the baseline, the
method, and a ranked table of where the cost goes and whether that work needs to happen at all.

Round 1 (the measure) was taken on 17 November 2026 on the build machine (16 cores, 64 GB, macOS, bun 1.3.3), on
0.44.2 at `cccb668`, with 26 lanes, 2 floors, 2 machines and 10 open rooms, the load average between 7 and 17.
Round 2 (the build) is in "Round 2: what was built" below: per item, what it cost before and after, and what is left
as a named limit. Everything after that section is round 1 as it was measured, kept as the baseline.

"% of a core" always means one core of the 16. Memory is the footprint (`phys_footprint`), as in `docs/monitor.md`.

## The answer in short

| | Today | Of which is work that need not happen |
| --- | --- | --- |
| The server's own CPU | 6.8% of a core (6.3 to 7.4 over three readings) | about 5.5 points: the state rebuilt in full 9 to 14 times a minute, most of it a work board no page draws |
| What the server starts | 2.0% of a core, 63 processes a minute | about 1.3 points: a pane read every 20 s for every lane that has finished |
| The server's memory | 77 MB, swinging to 143; 220 at startup | the bare runtime is 8 MB; the same code on a small database holds 46 to 58 |
| The page, tab visible | 9.1% of a core (renderer and GPU) at 30 frames a second | 2.2% with the room at 2 frames a second or still: the difference is the SMOOTH setting |
| The page, tab hidden | 0.07% of a core | nothing to cut |
| Hooks | one `sh` file test (2.7 ms) per tool call in a lane | nothing to cut |
| Disk | 457 MB in the data folder | 241 MB are three database backups; 22 MB are old versions of room files |

The server and its children cost 8.8% of a core, where the same code on a seeded copy of the data costs 1.5%. The
difference is not the runtime and not the lanes. It is that one push to the page costs 0.4 s of CPU here.

## Round 2: what was built

Each item is one commit on `feat/lean` with its before and after numbers in the message; this is the summary. The
rows are in round 1's numbering. "Seed" is the seeded copy (26 lanes, 1,284 asks: `scripts/footprint.ts seed`);
"real-size copy" is a copy of the owner's database from before 0.44.2 (89 MB, read for sizes and counts only).

### The whole, round 1's tree against the final one

Two servers side by side, ten minutes, the monitor on and one page stream open, as the live server runs
(`scripts/footprint.ts servers`, load 5 to 8):

| | Seed: round 1 | Seed: final | Real-size copy: round 1 | Real-size copy: final |
| --- | --- | --- | --- | --- |
| Own CPU, % of a core | 0.79 | 0.63 | 1.08 | 0.52 |
| What it starts, % of a core | 1.08 | 0.38 | 0.35 | 0.20 |
| Footprint, median | 58.2 MB | 56.8 MB | 73.7 MB | 73.8 MB |
| Footprint, highest reading | 58.8 MB | 57.4 MB | 162 MB | 85 MB |
| Peak since the start | 128 MB | 84 MB | 172 MB | 101 MB |
| One state build | 41 ms | 9 ms | 279 ms | 14 ms |

What the side-by-side cannot show is the live server's own CPU, which round 1 found to be its pushes: 383 ms each
on the real data, 9 to 14 a minute, from HQ's and the lanes' writes. A push now costs about what a build does on the
real-size copy, 14 ms, and a write that changes nothing a page shows sends nothing. The live figure is measured once
HQ has installed this; until then, about 0.5 to 1% of a core in place of 6.8 is an estimate from these numbers.

### Per item

| # | What | Before | After | Commit |
| --- | --- | --- | --- | --- |
| 1 | The board's view, built in every state build | 253 ms on the real-size copy | 51 ms; 7.5 ms with #8 | `b8c684c` |
| 1 | What the page gets of the board | every field of every item | the fields rooms draw | `b8c684c` |
| 1 | The page's dead board code | `work-board/`, a hidden strip | gone | `b8c684c` |
| 4 | A look that finds nothing changed (real-size copy) | 89 ms | 57 ms, then 14 with #8 | `c4c42be` |
| 4 | The briefs list (reads 73 MB of bodies on the real data) | built at every look | built when a brief or a secret changes (8 looks: 8 builds -> 1) | `c4c42be` |
| 4 | A write no page shows (an event) | a push with the version | nothing sent | `c4c42be` |
| 4 | Who bumps | unknown | `GET /api/push`: by route and by place in the code | `c4c42be` |
| 8 | Statements in one build | 526 (real), 2,766 (seed) | 282, 86 | `c53f9b8` |
| 8 | One build | 73.5 ms (real), 42.9 ms (seed) | 14.1 ms, 9.2 ms | `c53f9b8` |
| 3 | Pane reads | 57 a minute | 21 a minute (the final run) | `1dce656` |
| 3 | What the server starts (seed, monitor off) | 0.77% of a core | 0.32% | `1dce656` |
| 9 | Statements writing to `lanes` in 11 idle minutes | 910 | 26 | `8d1e3e2` |
| 9 | ... to `floors` | 34 | 1 | `8d1e3e2`, `1d9c38e`'s run |
| 10 | herdr list calls with the monitor on | 7.8 a minute | 6 | `3d2125c` |
| 10 | What the server starts, monitor on | 347 ms a minute | 277 | `3d2125c` |
| 5 | What the server starts, monitor on | 322 ms a minute | 213 | `1d9c38e` |
| 5 | This machine's minute sample | `machine-stats.sh`, 15 processes, waits a second | the monitor's newest tick, no process | `1d9c38e` |
| 5 | The temp folders' walk | 1.33 s of CPU every 10 minutes | the monitor's daily reading | `1d9c38e` |
| 5 | The subscriptions' reader | a python every minute | only when a file it reads changed; a whole answer every 10 minutes | `1d9c38e` |
| 13 | HQ's queue hook, queue off, per event of every session | 19 ms, 16.9 ms of CPU, 27 MB | 3 ms, 2.3 ms, 2 MB | `a3daa5e` |
| 13 | `greet` for an agent with no name | 30 s, about 30 herdr calls | 5 s, about 7 | `a3daa5e` |
| 12 | `hq-subs-home-*` left by each test run | 1 a run (600 on this machine) | none; 594 removed | `2960431` |
| 12 | Database backups (HQ) | 241 MB | one kept: the data folder 457 -> 318 MB | HQ |
| 6 | The start's peak, a page connecting (real-size copy) | 167 to 172 MB | 101 to 104 MB | all of the above |
| 7 | The server at rest (seed, monitor on) | 56 to 59 MB | 53 to 56 MB | `61a4a91` |

The question panel did not get slower (#4, `scripts/answer-speed.ts`, both trees, 7 trials each, the calm round at
load 12): press to the card gone 5 / 6 ms (desktop), 6 / 7 ms (phone), 38 / 37 ms (slow phone); press to the reply
14 / 14, 132 / 134, 354 / 358 ms. The answer's POST alone, the two servers side by side: 1.3 / 1.4 ms (median of 30).
The room's pixels are today's (`room-pixels` against the commit before each change, both themes), and the ROOMS tab
and an open room draw the same tags, colours and screenshots as before #1.

### What fills `hud.db`

Round 1 could not see it. On the real-size copy (`dbstat`, sizes and counts only): 89 MB in all, of which `briefs`
73.0 MB (182 rows; the largest body 3.9 MB), `rooms` 2.8 MB (18 rows, one brief of 2.8 MB), `ask_pages` 2.7 MB,
`events` 1.5 MB (8,086 rows), `asks` 1.5 MB (1,284 rows), everything else under 1 MB. The two new indexes take
208 KB.

### SMOOTH (#2), as the owner decided it

The owner: SMOOTH stays SMOOTH, with no cost text and no rule about focus, and gets cheap with the same frames. The
target was BALANCED's cost, about 2% of a core. **It cannot be reached with today's frames, and here is what stops
it.**

Where a SMOOTH frame's cost is, on this page in Chrome with the real GPU (Apple M4 Max through ANGLE and Metal,
Skia Graphite), renderer and GPU process together, 30-second stretches:

| The page | % of a core |
| --- | --- |
| An empty page that asks for 30 animation frames a second and changes nothing | 2.3 |
| The room's loop running at 30 frames, nothing painted | 2.3 to 3.0 |
| The same, one 3 by 3 square changed each frame | 6.7 to 8.5 |
| The room as it is, SMOOTH, fall | 8.5 to 12 |
| BALANCED, for comparison | 2.2 |

So asking for 30 frames costs about what BALANCED costs in all, and presenting any change 30 times a second costs
6 to 8%. What the room paints in a frame is at most the last 2 to 3 points.

Those 2 to 3 points were taken in an experiment: the frame is noted call by call, held against the frame before, and
only the boxes that changed are painted again, on a CPU canvas (the GPU's shade at a smoothed edge depends on how
Chrome batches a frame's draws, so a partial repaint on it is not exact). Three trees in one Chrome, four rounds
(`scripts/footprint-ab.ts`): today 11.0%, the CPU canvas alone 10.9%, the CPU canvas with the partial repaint 9.0%.
The page's own script stays under 0.3 ms a frame.

It is not shipped, because it does not draw today's frames. Held against today's tree frame by frame on the frozen
clock (`scripts/frame-ab.ts` on the branch), the CPU canvas alone differs from frame 102 of a fall room by a shade in
16,000 to 18,000 bytes, in the dancing hero's box, which the pixel test masks. With the partial repaint, 9 bytes at
the corners of a label's see-through background also differ by up to 4 levels in about half the frames. HQ's call:
it does not ship, and the branch `experiment/lean-smooth` (`796c2ba`) goes after the release.

The last try, HQ's, with a stop: the pixel layer at 1x (384 by 256, a ninth of the pixels), scaled by CSS as today,
with what is off the 3-pixel grid on a 3x canvas over it; it would ship at 5% of a core or less with every frame
today's. Almost everything that moves in an idle SMOOTH room is off that grid (the falling leaves land on any device
pixel; the dance and the workers' sway are fractional), so the overlay would change every frame. Its floor, in the
real page with the room's own drawing switched off (`scripts/footprint-floor.ts`, two rounds of 30 s):

| The page | % of a core |
| --- | --- |
| One square changed each frame, today's 1152 by 768 canvas | 8.5, 5.7 |
| The same on the canvas at 384 by 256 | 8.7, 5.3 |
| A still 1x canvas, one square changed each frame on a 3x canvas over it | 5.1, 5.3 |
| Nothing changes | 2.9 to 3.9 |

The canvas's size does not change what a changed frame costs: Chrome's work is per frame presented, not per pixel.
The design's floor, before it draws a single leaf, is at or over the stop, so it was not built. On `feat/lean`
SMOOTH draws as it always did.

### Named limits

- **SMOOTH costs 8.5 to 12% of a core while the office is visible**, for the reasons above: any way of presenting a
  changed frame 30 times a second costs Chrome 5 to 8% on this page, and the frames must stay today's. Hidden, 0.06%.
- **herdr's status is still polled**, every 20 s. herdr's CLI has no event stream (`agent wait` is one agent; `api`
  has `snapshot` and `schema`); events would mean speaking its socket protocol (22 today) from the server, a second
  way in beside the CLI and tied to a protocol version, while the plugin supports herdr from 0.8.0, and the other
  machine is reached through the CLI over ssh. What polling still costs: 6 list calls a minute, and at most one pane
  read a minute per resting lane.
- **The first page to connect builds everything once**, about 30 MB for a moment on the real-size copy (peak 101 to
  104 MB, then 74). The briefs list and the rooms list read whole bodies to show their first lines (73 MB of brief
  bodies on the real data); they now do it only when a brief or a room changes. A column holding each brief's first
  lines would end it; that is a change to a table, which is HQ's call.
- **The footprint at rest is about 53 to 56 MB on the seed and 74 on the real-size copy.** The runtime is 8 MB; the
  rest is the modules and what they keep. The export and its printer now load on first use (3 MB); the monitor's
  modules are larger, and the live server uses them.
- **A push that lands soon after a reload can cost a closed card its note.** Seen once: when the minute's two
  samplers shared one bump 2 s late, `test/client/needs-closed.test.ts` (a picture-only draft on a question
  withdrawn while the page was away) failed 2 of 4 runs. The shared bump is gone and the file passes. HQ's review
  found the race exists on main too; it was not looked into further.
- **The live server was only read.** The after figures are from throwaway servers on the seed and on the real-size
  copy, side by side with round 1's tree. The live figures come when HQ has installed it.
- **Not measured:** the owner's own browser and a phone (headless Chrome uses the same GPU, but presents no
  screen); the other machine's side of every ssh call; MACHINES' readings of other machines, which still come from
  the script.

## The baseline

### The server, live

Read from outside with `proc_pid_rusage` every 5 s (`scripts/footprint.ts watch`); nothing was sent to it but GETs.
The server was restarted on 0.44.2 in the middle of the measuring, so there is a reading of each version.

| | 0.44.1, 15 min | 0.44.1, 10 min | 0.44.2, 10 min |
| --- | --- | --- | --- |
| Own CPU, % of a core | 7.36 | 6.26 | 6.82 |
| Children's CPU, % of a core | 2.00 | 2.06 | 1.98 |
| Footprint, MB: min / median / max | 126 / 141 / 216 | 126 / 136 / 206 | 75 / 77 / 143 |
| Footprint's peak since start, MB | 253.5 | 253.5 | 220.3 |
| Wakeups a second | 12.3 | 10.6 | 11.1 |
| Pushes to the page a minute | | 9.7 | 8.7 |
| State version bumps a minute | | 11.6 | 9.9 |

HQ read the same process ten minutes after the install: 73 to 83 MB, peak 220 MB reached during startup.

Three things in these readings carry the rest of this page:

- **Own CPU is pushes.** Per minute, own CPU fits `427 ms x pushes` with nothing left over on 0.44.1 (ten minutes,
  3 to 17 pushes a minute), and `930 ms + 383 ms x pushes` on 0.44.2 (nine minutes). The 930 ms a minute that
  0.44.2 adds is the collection after every monitor tick, which now also sweeps what the pushes leave behind.
- **A push is a full state build, and the build is slow here.** `GET /api/state` took 284 to 340 ms for 277 KB.
  `GET /api/board` alone took 245 to 281 ms for 11 KB. `GET /api/requests` (69 KB) took 1 ms, `GET
  /api/machines?hours=1` 1 ms, `GET /api/floors/agents` 1 ms. So about 250 of every 300 ms is the work board.
- **0.44.2 halved the memory and left the CPU where it was.** The swing from 126 to 216 MB was garbage waiting for
  a collection, and the monitor's collection every 10 s now takes it. The work that makes the garbage is unchanged.

What the pushes carried, over the ten minutes on 0.44.2 (87 pushes, 890 KB): the board in 40 of them (429 KB, 48%
of the bytes), `lanes` in 14 (131 KB), `requests` in 3 (208 KB), `score` in 45. 18 pushes carried the version
number and nothing else; 25 carried nothing but the version and the score; 47 of the 87 carried nothing a page
draws (version, score and board only, and the page no longer draws the board). On 0.44.1 it was 59 of 96.

### The server on a seeded copy, side by side

`scripts/footprint.ts servers`: six servers from one tree at the same time, each on its own copy of a seeded data
folder (26 lanes, 1,284 asks, 100 briefs, 800 events, 26 tracked work items, 10 rooms: a 2.3 MB database), with a
stub herdr that answers like the live one (7 lanes working, 18 done, 1 idle) and logs every call. Ten minutes
each after a minute to settle, load 7 to 11. This is the method of 0.44.2 (`docs/monitor.md`).

| Server | Own CPU | Children | Footprint min / median / max | Peak | herdr calls a minute |
| --- | --- | --- | --- | --- | --- |
| monitor off, no page | 0.14% | 0.85% | 46 / 51 / 58 MB | 70 | 63 |
| monitor off, one page stream open | 0.25% | 0.68% | 50 / 53 / 69 | 111 | 63 |
| monitor on, no page | 0.56% | 0.83% | 57 / 58 / 66 | 75 | 65 |
| monitor on, one page stream open (as live) | 0.67% | 0.83% | 55 / 56 / 62 | 110 | 65 |
| monitor off, the minute's samplers off | 0.11% | 0.55% | 40 / 44 / 60 | 64 | 63 |
| monitor off, herdr says every lane works | 0.06% | 0.19% | 43 / 57 / 70 | 72 | 6 |
| a bare bun with HTTP and SQLite, idle | 0.003% | 0 | 8.1 | 8.7 | |

Read as differences:

- The pane reads (57 a minute) cost 0.74% of a core: 0.66 in the children and 0.08 in the server.
- The minute's samplers for this machine alone cost 0.33%.
- The monitor costs 0.42% of own CPU and 7 MB. Its own figure on the live server is 0.49% of a core, up from 0.45%
  before the collection after every tick: the collection's cost, inside its 0.5% limit.
- One open page costs 0.11% on this small database, where the state builds in 41 to 50 ms (three runs of
  `scripts/footprint-state.ts`; one run read 109 ms while another lane's work was on the machine).
- The runtime's floor is 8 MB and no CPU. The server sits at 40 to 46 MB at rest: 32 to 38 MB is our code and what
  it keeps.

The seeded copy cannot show the live build's 300 ms. Its database is 2.3 MB and the live one is 93 MB. What fills
the live one could not be measured: see "Not measured".

### What the server starts

One run each, median of 9 (`scripts/footprint.ts cost`), the real herdr and the real scripts:

| | Wall | CPU | Largest size | How often, live |
| --- | --- | --- | --- | --- |
| `herdr agent list` | 5 ms | 3.8 ms | 8 MB | 3 a minute, plus 1 from the monitor |
| `herdr pane list` | 7 ms | 4.5 ms | 9 MB | 3 a minute, plus 1 from the monitor |
| `herdr --machine OTHER agent list` (ssh) | 323 ms | 17 ms | 11 MB | 3 a minute |
| `herdr pane read` | as the lists | | | 54 a minute (18 lanes x 3) |
| `sh machine-stats.sh` (about 15 processes) | 1,056 ms | 53 ms | 3 MB | 1 a minute per machine |
| `sh machine-stats.sh temp` (walks the temp folders) | 1,362 ms | 1,326 ms | 5 MB | every 10 minutes per machine |
| `sh sub-usage.sh` (starts python3) | 242 ms | 64 ms | 16 MB | 1 a minute per machine |

A herdr sync runs every 20 s and starts 21 processes: two agent lists, a pane list, and a pane read for each lane
that is not working and whose phase is still `running`. 18 of the 26 lanes were in that state: their agents had
finished (`done`) and sat there. The children's CPU is steady at 1.0 to 1.3 s a minute, in steps of about 330 ms
every 20 s. The half that runs on the other machine (its samplers, its side of each ssh) is not in these figures.

### The page

`scripts/footprint-page.ts`: headless Chrome 157 at 1440x900 on a throwaway server from the same seed, 60 s per
stretch, no throttling. CPU is from Chrome's own process table (`SystemInfo.getProcessInfo`).

| Stretch | Frames a second | Canvas calls a second | Renderers | GPU | This tab's script |
| --- | --- | --- | --- | --- | --- |
| Office visible, idle, PERFORMANCE SMOOTH (the default, and this installation's setting) | 30 | 8,337 | 4.12% | 4.99% | 1.19% |
| Office visible, idle, BALANCED | 2.1 | 573 | 1.22% | 1.02% | 0.19% |
| Office visible, idle, POWER SAVER | 0 | 9 | 1.28% | 0.95% | 0.16% |
| Office visible, in use (pointer over the room, a lane's card opened and closed), SMOOTH | 30.2 | 8,400 | 6.10% | 7.28% | 1.45% |
| Office hidden (another tab in front) | 0 | 0 | 0.06% | 0.01% | 0.04% |
| The monitor's page visible, idle | 0 | 0 | 0.65% | 0.50% | 0.01% |

The tab holds 65 to 94 MB (its JS heap 2.7 to 3.9 MB, 2,500 to 2,900 nodes). The loop already draws only when
something changes (`room/beat.js`) and stops when the tab is hidden: a hidden tab costs nothing. What costs is the
number of frames presented. In SMOOTH everything that travels runs at 30 frames a second, and in this season the
weather travels, so an idle room presents 30 frames a second all day: 9.1% of a core against 2.2%. The 2.2% that
remains with the room still is the page's clocks (the ages on open questions tick every second).

Chrome's browser process read 0.1 to 1.2% in five stretches and 10.0 and 5.1% in the BALANCED and POWER SAVER
ones. A first pass with 8 s stretches read 0.6 and 0.1% there, so that is the new profile's own background work,
not the page, and it is left out of the table.

### Hooks, the plugin, the CLI

| | Wall | CPU | Largest size | When |
| --- | --- | --- | --- | --- |
| The lane hook at PreToolUse: one `sh` file test | 4 ms | 2.7 ms | 2 MB | every tool call in a lane |
| `lane-hook.ts` (PermissionRequest, Denied, Notification) | 25 ms | 23 ms | 33 MB | only when a lane meets a prompt |
| `hq-queue-hook.ts` | 20 ms | 17 ms | 27 MB | not installed on this machine. Installed, it runs on every prompt, tool call and stop of every Claude Code session of the user |
| `hud-plugin.ts greet` | 26 ms | 25 ms | 37 MB | every agent herdr detects. For an agent with no name it stays up to 30 s and asks herdr once a second (6 of the 17 agents here have no name) |
| `hud` (any command) | 20 ms | 18 ms | 29 MB | whenever HQ or a lane calls it, plus its request |
| `bun -e 0`, for scale | 9 ms | 8 ms | 20 MB | |

The status pane runs only while it is open. Nothing here runs on a timer.

### Disk

The data folder holds 457 MB. Sizes only were read; no file in it was opened.

| | Size |
| --- | --- |
| Three copies of `hud.db` from before 0.43.0, 0.44.0 and 0.44.1 | 241 MB |
| `rooms/`: files 57 MB, earlier versions 22 MB in 129 files, one archived log 9.8 MB, one brief 2.8 MB | 99 MB |
| `hud.db` (about 8,100 events, 1,280 asks, 1,500 updates, 750 notes, 180 briefs, 94 requests) | 93 MB |
| `monitor.db` after its first day, with a 2 MB write-ahead log | 21 MB |
| `uploads/`, 50 files | 9.4 MB |
| `server.log` | 6 KB |

The server wrote 4.8 to 7.0 MB an hour to disk on 0.44.1. In the system's temp folder, of 8,126 entries: 522
`hq-subs-home-*` folders that the test preload makes and never removes, 23 `hq-office-*` (26 MB), 36
`answer-speed-*`, and 1,824 Chrome socket folders, not all ours. Every bun that starts reads that folder.

## The ranked table

Round 1's table, as it was ranked. What came of each row is in "Round 2: what was built" above.

Ranked by what it costs today. "Needs to happen?" is the question from the brief: is this a constraint, or a choice
someone made. The expected figures are estimates from the measurements above, to be replaced by before and after
numbers in each fix's commit.

| # | What | Costs today | Needs to happen? | The fix | Expected after | Whose call |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **The work board is built inside every state build.** `board.view()` reads every ask ever made with its body, upper-cases each once per tracked item (1,280 x 26), and scans the event log once per item | About 250 of every 300 ms build; at 9 to 14 builds a minute that is about 4.5 points of the server's 6.8% of a core. 48% of the bytes pushed to the page. Most of the garbage behind the 126 to 216 MB swing on 0.44.1 | **No.** No page reads `S.board` since 0.42.0: `renderWork` has no caller. `hud board` asks `/api/board`, which builds its own | Take `board` out of the state. The route and `hud board` stay | Own CPU 6.8% to about 2.5%, and lower if the collection after each tick then has less to sweep. Stream bytes halved | Mine. Small |
| 2 | **The room presents 30 frames a second all day.** SMOOTH is the default and this installation's setting; in it the weather travels at 30 frames a second | 9.1% of a core in the browser while the tab is visible, against 2.2% in BALANCED | **A choice, not a constraint.** The frames are the look the setting promises, so no fix inside the rule "not a pixel changes" removes them | Three ways: (a) BALANCED as the default for new installations; (b) SMOOTH only while the window has focus, BALANCED when it is visible behind another; (c) leave it, and say what it costs beside the setting | (a) or (b): 9.1% to 2.2% while nobody looks at it | **Ask me**: all three change what the owner sees |
| 3 | **herdr is asked every 20 s, and every finished lane's pane is read each time.** 21 processes a sync, 63 a minute | 2.0% of a core in children, of which the reads are about 1.3 (the rest: the lists 0.13, the samplers and the temp walk 0.5, the monitor's `ps` 0.1), and 0.1 in the server. On the seeded copy the reads alone are 0.74% | **Partly.** A lane that has finished says the same thing every 20 s for hours. herdr's socket has `events.subscribe` with `pane.agent_status_changed`, so the status need not be polled at all | First: read a pane when its lane's status changes, and after that once a minute, not once a sync. Then: subscribe to herdr's events, with a slow poll as the net | 2.0% to about 1.1% with a read a minute, then lower with events | Mine, with one thing to confirm: herdr's `revision` does not move when a pane prints (17 agents, 20 s apart), so "2 shells still running" on a finished lane would show up to a minute later than today |
| 4 | **Every bump is a push, and every push a full build.** The version number is a part of the state, so a write that changed nothing a page shows is still built, compared and sent | 9 to 12 bumps a minute. 18 of 87 pushes carried the version alone, 47 of 87 nothing a page draws. After #1 each still costs a build | **No.** | Build a part only when what it reads changed, and send nothing when no part did. Find what bumps 10 times a minute here (the router bumps after every POST, whether it wrote or not) | What is left of own CPU after #1, roughly halved | Mine. Medium |
| 5 | **The minute's samplers.** Per machine each minute: `machine-stats.sh` (15 processes, one of them waits a second), `sub-usage.sh` (a python3); every 10 minutes a walk of the temp folders. Two bumps a minute, so two builds | 0.33% of a core for this machine, and as much again on the other. The temp walk is 1.3 s of CPU each time | **Partly.** The monitor reads this machine's load, CPU, memory, swap and disk every 10 s in-process for 3 ms, and walks the temp folders once a day. Subscriptions change only when an agent reports | This machine's readings from the monitor while it is on. The temp size from the monitor's daily reading. `sub-usage.sh` only when its source files changed. One bump for both | 0.33% to under 0.1% here | Mine. Medium. `docs/monitor.md` already plans the first part |
| 6 | **Startup reaches 220 MB.** | A peak of 220 MB (253 on 0.44.1), then 75 to 83 MB | **Unknown.** The seeded copy peaks at 70 MB, and 110 with a page: so it comes with the size of the real data, the first builds and the monitor's first reads | Find it first: it needs a start on data of the real size (see "Not measured") | Not known | Mine, after an answer on the data |
| 7 | **The server at rest holds 75 to 83 MB.** | The runtime is 8 MB. The same code on a small database: 46 to 58 MB | **Partly.** 32 to 38 MB is every module loaded at start, among them the export, the print proxy and the page runtime, which a day may never use | After #1 and #4, measure again. Then load the rarely used parts when first asked for | Toward 50 MB | Mine. Medium, last |
| 8 | **State queries that grow with the history.** 2,758 SQL statements a build on the seeded copy: one per message to HQ in the last day to ask whether it was read, the event log sorted once per work item, every ask scanned for the last day's answers | 16 to 19 ms of a 41 to 50 ms build on a 2.3 MB database | **No.** | One query in place of 2,560. Indexes on `asks(status, answered_at)` and `events(lane, at)` | The build under 10 ms on the seed | An index is a change to a table: **ask me** |
| 9 | **Writes when nothing changed.** `herdr_seen` is written for every lane on every sync, and no page reads it | Three write transactions a minute; part of the 4.8 to 7.0 MB an hour | **No.** | Keep it in memory | An idle server writes nothing between the minute's samples | Mine. Small |
| 10 | **The monitor.** | 0.49% of a core (limit 0.5%), 7 MB. It asks herdr for the panes and the agents once a minute, though the sync has both | **Yes**, the owner asked for it. The two calls are double work | Give the monitor the sync's lists | 2 fewer processes a minute | Mine. Small |
| 11 | **The page with the room still.** | 2.2% of a core while visible: the ages on open questions tick every second | **Yes** while a question is open: it is the question panel | Nothing now | | |
| 12 | **Disk.** | 241 MB of database backups. 22 MB of old versions with no limit. 522 temp folders from test runs | Backups: who makes them, and how many are wanted? Versions: a limit? The temp folders: no, a leak | The test preload removes its folder when the run ends. The other two are questions | 241 MB if one backup is kept | **Ask me** for backups and versions |
| 13 | **Hooks and the plugin.** | 2.7 ms per tool call in a lane. A bun of 17 to 25 ms on the rare events | The lane hook is already a file test before any process. HQ's queue hook is not: installed, it starts a bun in every session, though it acts in HQ's only | A file test in front of the queue hook, as the lane hook has. `greet` gives up sooner on an agent with no name | Nothing on this machine today | Mine. Small, last |

## The big choices

- **The runtime is not the cost.** A bun that serves HTTP with SQLite open holds 8 MB and uses 0.003% of a core.
  The server uses 2,000 times that CPU. A rewrite in another language would move the 8 MB and none of the rest.
  I do not propose one.
- **The canvas loop is sound.** It draws on change and stops when hidden. The cost is the frame rate the SMOOTH
  setting promises (#2), which is a choice about the look. Round 2 measured the floor under it (see SMOOTH above).
- **`/api/state` on every push is the choice to revisit.** One object for the whole page is simple, and it was
  cheap when the history was short. It is now rebuilt from the whole history 10 times a minute to send, most of
  the time, a number. #1 removes the worst of it, #4 the principle, #8 the growth.
- **Polling herdr is a choice herdr no longer forces** (#3): it has events.

## Method

- **The live server is only read.** `proc_pid_rusage` from outside, `footprint`, `vmmap`, `sample`, `lsof`, and
  GETs that a page also makes (`/api/state`, `/api/board`, `/api/stream` and a few lists). No POST, no restart. The
  data folder's file sizes were listed; no file in it was opened.
- **Throwaway servers** get a spare port, a data folder of their own, a home of their own for `sub-usage.sh`,
  `HERDR_BIN` set to a stub, and none of the caller's `HUD_` or `HERDR_` variables. The stub is `sh` and `cat`
  (about 3 ms a call), close to the real herdr's 4 to 5 ms, so children's CPU on the seed is comparable with the
  live figure for this machine's lanes, and lower than it for lanes on the other machine (17 ms a call).
- **No load is made.** Every figure is of a server or a page doing what it does on a normal day. Each run notes
  the load average at its start, its highest and its end.
- **The scripts**, all in `scripts/`:
  - `footprint.ts seed DIR` makes the seeded data folder.
  - `footprint.ts servers MINUTES SEED OUT.json LABEL[+stream][+allworking][:KEY=VALUE,...] ...` runs servers side
    by side and reads each every 5 s.
  - `footprint.ts watch MINUTES OUT.json LABEL=PID` reads a process that already runs.
  - `footprint.ts stream BASE MINUTES OUT.jsonl` counts the pushes of a page stream and what each carried (names
    and sizes, never contents).
  - `footprint.ts cost RUNS LABEL STDIN -- CMD` times one run of a hook, a script or a herdr call.
  - `footprint.ts floor` measures the bare runtime.
  - `footprint-state.ts SEED` says where one state build's time goes, statement by statement.
  - `footprint-page.ts SEED OUT.json SECONDS` measures the page in headless Chrome.
  - `footprint-ab.ts SEED SECONDS ROUNDS LABEL=TREE ...` measures trees' office pages in one Chrome, in turn, so load
    falls on each alike. Separate runs of the same page read 6.8 and 9.8%; this one tells 2 points apart.
  - `footprint-floor.ts REPO SEED SECONDS` measures SMOOTH's floor: the room's drawing switched off from outside,
    one square changed per frame on today's canvas, at 1x, or on a 3x overlay.
  - `GET /api/push` on any server: who bumped and touched, how often the stream looked and what it sent, how often
    each part of the state was built, and the writes per table.
- **Before and after.** Each fix in round 2 is measured the 0.44.2 way: two trees side by side
  (`FOOTPRINT_REPO=OTHER_TREE` on one label), the same seed, the same ten minutes. A fix that touches the question
  panel also runs `scripts/answer-speed.ts` on both trees, and one that touches the room the pixel test in both
  themes.

## Not measured

- **What fills `hud.db`** and **what bumps the version** were round 1's open questions; round 2 answered both (the
  real-size copy, and `GET /api/push`).
- **The owner's own browser.** The page was measured in headless Chrome, which presents frames without a screen.
  The frame counts are exact; the CPU per frame in the owner's browser can differ. A phone was not measured.
- **The other machine.** Its samplers and its side of every ssh run there and were not read.
- **The disk walk's daily minute** of CPU is in `docs/monitor.md` and was not measured again.
