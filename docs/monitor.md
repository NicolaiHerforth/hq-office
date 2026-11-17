# The monitor

The MACHINES readings say how full a machine is. They do not say who filled it. The monitor answers that: every ten
seconds it reads which processes use the CPU, hold the memory and write to the disk, finds out whose each one is,
and stores the result, so the question "why is this machine capped" has an answer now and for the past 90 days.

This page explains the model: whom usage is blamed on, what is measured and why that and not something cheaper,
what it costs, and what it cannot see. The numbers were measured on the machine it was built on (16 cores, 64 GB,
about 820 processes, 24 herdr panes), in November 2026.

## The pieces

| | |
| --- | --- |
| `src/server/monitor-types.ts` | the shapes: a reading of the machine, an owner, a tick's rows |
| `src/server/monitor-darwin.ts` | the reader on macOS: libproc and Mach through `bun:ffi`, one `ps` for other users' processes |
| `src/server/monitor-ps.ts` | the rows of one `ps`, parsed |
| `src/server/monitor-panes.ts` | herdr's panes: which shell each runs, which agent it belongs to |
| `src/server/monitor-containers.ts` | what runs inside OrbStack's virtual machine, from the Docker API's socket |
| `src/server/monitor-attribution.ts` | whose a process is: one ordered table of rules |
| `src/server/monitor-usage.ts` | what was used between two readings |
| `src/server/monitor-store.ts`, `monitor-schema.sql` | `monitor.db`: ticks, rollups, retention, the size limit |
| `src/server/monitor.ts` | the tick that joins them |
| `src/server/monitor-disk.ts` | the disk growers: the sizes of the cache and temp folders that fill the disk over weeks |
| `src/server/monitor-limits.ts` | what limits the machine in a stretch of time: one table of rules |
| `src/server/monitor-history.ts` | the history read back: episodes, marks, what keeps coming back |
| `src/server/monitor-page.ts`, `monitor-words.ts` | the recorded data in the shape the page reads, and every sentence made from it |
| `src/server/monitor-standing.ts` | the verdict on now by itself, which MACHINES in the HUD's top bar speaks by |
| `src/server/routes/monitor.ts` | starts it (macOS, where `HUD_MONITOR=1` asks for it), serves the page at `/monitor` and its data under `/api/monitor/page/`, `/api/monitor/now` and `/api/monitor/marks` |
| `public/monitor.html` | the page: memory as one picture of tiles that you scrub through time |
| `src/client/monitor/` | the way in: MACHINES in the HUD's top bar opens the page in a tab of its own |
| `scripts/monitor-fixture.ts` | writes an invented hour, `calm` or `capped`, for a replay |
| `hud monitor mark TEXT [--kind K]` | puts a mark on the timeline; never fails, never waits more than 1.5 s |
| `scripts/monitor-probe.ts` | runs it without the server on a folder of your choosing, and prints a report from the database |

## Where it runs

Only where it is asked for: on macOS, in a server started with `HUD_MONITOR=1`. The plugin starts its server and
writes its service with that (`bin/hud-plugin.ts`), unless `config.env` says `HUD_MONITOR=0`, so an installed HUD
monitors. Every other server has it off: one started by hand, by a test, by a script such as the Parity Lab's, or
by a lane that tries something out. Such a server would otherwise read this machine's process table every ten
seconds and walk its cache folders after ten minutes, for nobody. `HUD_MONITOR=1 bun server.ts` is a hand-started
server that monitors.

The service carries the setting in its own file. One that a version before the monitor installed starts without
it, and the monitor stays off until the plugin's restart action (or install service) has written the service
again, as after any update. The page says so while it is off.

## Whom usage is blamed on

A pid means nothing to the person at the machine. An owner does. Every process gets one, by the first rule that
matches:

| Order | Rule | Owner |
| --- | --- | --- |
| 1 | An ancestor is a herdr pane's shell. | The lane (the pane's named agent), or the pane's folder as `~/…` when no agent in it has a name. |
| 2 | It is this server, or a descendant of it. | HQ Office. |
| 3 | Its tree was started from a pane and then detached: the tree's root has launchd for a parent, but the root, or a process between the root and it, still carries the pane's `HERDR_PANE_ID`. | That lane or pane. |
| 4 | Its executable, or its nearest ancestor's, is inside an app bundle. | The app, with all its helpers. |
| 5 | The system ships it, launchd started it, and macOS holds an app responsible for it (a browser engine's content process). | That app. |
| 6 | Another user runs it, or its executable is the system's. | The system. |
| 7 | Nothing above. | The folder its tree runs in (the last two parts of it; every temp folder is "a temp folder"), or "other". The page calls "other" Unsorted processes, because it has a holder named Other apps. |

Within a lane, what ran is named by its app when it is in one, so a browser a lane's test starts is one name with all
its helpers and counts toward the lane, not toward the browser.

Rule 3 exists because of what the first real reading showed. 9.6 GB sat in "other". 7.7 GB of it was one dev stack
of `node` and `bun` under a detached `tmux` server, which a lane had started. The parent chain of a detached tree
ends at launchd, so rule 1 cannot see it. The environment is inherited, so the tree's root still names its pane.
With rule 3 "other" held 0.6 GB. The chain is asked from the root down, because the root does not always answer:
the kernel gives no environment for a system binary such as `/bin/sh`.

Rule 3 can be wrong in one way: a tree that outlives its lane and is later used by others is still blamed on the pane
that started it, for as long as that pane exists.

## Inside the virtual machine

OrbStack runs every container in one Linux virtual machine, and the process table shows that machine as one
process. On the build machine it was the largest holder, 13 GB, with nothing to say what was in it.

The Docker API answers on a socket in the user's folder. One request lists the running containers with their
compose labels, and one per container gives its memory and its CPU total. For 17 containers that is about 2 ms of
CPU in this process, every tick, and no `docker` command is started. A container's command line is in the list and
is never taken.

A container enters the reading as a process inside the machine's process. The tick's arithmetic takes each one off
the machine's own row, so nothing is counted twice and the totals stay exact. What is left on the machine's row is
the Linux machine itself: its kernel, its file cache, and memory it has not given back to macOS. On the build
machine the 17 containers held 2.3 GB and the machine itself 10.7 GB. So most of what OrbStack holds is not any
container's working memory.

A container is the lane's that runs in the folder its compose project was started in, or up to two folders above it
(a worktree with its compose file in `infra/docker`). A lane's folders are its pane's folder and the folder of every
tree it started and detached. When no lane runs there, or two do, the container stays with the app and is named by
its project and service. A shared stack that several lanes use is blamed on the one whose folder started each
service, which is who started it and not who uses it.

Checked with OrbStack only. Docker Desktop has another socket and another machine process, and is not read.

## What is measured, and why not something cheaper

**Memory is the footprint, not the resident size.** The resident size is what `ps` prints. It leaves out memory the
system has compressed or swapped, and that is most of what a process holds on a machine under pressure. On the
build machine the resident sizes of the user's processes summed to 28.5 GB and their footprints to 68 GB. One `node`
process showed 0.04 GB resident and held 3.0 GB. A monitor that reads resident size hides the processes that cause
the pressure, at the moment someone asks about the pressure. The footprint is what Activity Monitor's Memory column
shows.

**CPU comes from totals, not from a percentage.** Every reading takes each process's CPU time since it started. A
tick's CPU is the difference between two readings. A process that started and exited between two readings is never
seen, but its parent's "CPU of collected children" total grew by what it used, so that CPU is counted too, in a row
named "(exited)" under the same owner. A test run is mostly such processes. A child that has exited and waits to be
collected stays in the table until it is gone, so the life it was already counted for is not counted again.

**The host's own counters close the books.** The CPU of all rows is compared with the host's busy time over the same
ten seconds. Whatever the host spent that no process accounts for is its own row, "kernel and unattributed": the
kernel's own work, and children of processes the monitor may not read. Over the first measured window the processes that were
alive at both readings covered 79.8% of the busy time, and 87.5% with the exited children.

**The process table is read in this process.** One pass through libproc costs about 3 ms of CPU. `ps` that prints
executable paths costs 110 to 160 ms, because it reads every process's arguments. Without paths it costs 10 to 20
ms. libproc may not read other users' processes, so one `ps` without paths supplies their CPU time and resident
size. Their memory is therefore the resident size: the system's rows are less exact than the user's.

So every tick reads all of the user's own processes through libproc (628 of 838 in one reading on the build
machine, holding 57.5 GB), and `ps` runs once in the same tick for the rest only (210, holding 1.4 GB resident),
which costs about 8 ms. Nothing of the user's is skipped. When `ps` printed every process it cost about 30 ms.

A reading also takes: memory by state (wired, app, cached, compressed, free), how much memory is stored in the
compressor, swap, the kernel's memory pressure level and its "available" percentage, page-ins, page-outs, swap-ins
and swap-outs, load, the thermal pressure level, free disk, and each process's bytes read from and written to disk.

**No command line is stored.** A command line carries tokens. The database holds executable names and derived
labels (a lane, an app, a folder as `~/…`). Rule 3 reads a process's argument and environment block into memory,
takes the one variable out, wipes the buffer, and returns only the pane id. Labels pass through the secret mask
before they are written.

## One tick

Ticks fall on the wall clock's multiples of ten seconds, so every minute holds the same six. A tick that runs long
skips the ticks it covered. A reading that fails writes nothing: the gap is a gap, and the reading after it starts
a new stretch instead of counting the gap as one long tick. So do two readings more than two minutes apart, which
is a machine that slept.

Why ten seconds: a tick costs about 35 ms of CPU. At 8640 ticks a day that is 0.35% of one core, inside the limit
of 0.5%. Five seconds would break the limit. Thirty seconds would average away the spikes of a
test run, which is the thing most often asked about.

A process group gets a row of its own only when it used 1% of a core over the tick or holds 50 MB. Smaller ones
fold into one "(small)" row per owner, so an owner's totals stay exact. That is 178 rows a tick here.

One tick runs at a time. A tick that is asked for while one runs is that one, so the tick a start begins with and
the timer's first cannot count the same stretch twice.

A tick never waits for herdr. The panes are asked for in the background, one asking at a time: once a minute, and
at once when a new shell shows up beside the panes' shells. A tick uses the list it has, and what herdr answers is
the next tick's. Asking takes a call per new pane, and each may take five seconds to give up, so a herdr that hangs
would otherwise hold a tick for longer than the two minutes that end a stretch. The first tick is the exception:
with no list yet every lane's processes would be nobody's, so it waits for the first list, five seconds at most.

## The database

`monitor.db` in the data folder, never `hud.db`.

| Table | One row per | Kept |
| --- | --- | --- |
| `series` | owner and name; rows refer to it by id | 91 days after the newest tick it was in |
| `raw`, `host_raw` | tick: each series' CPU, memory, process count and disk bytes; the host's readings | 24 hours and 15 minutes |
| `roll`, `host_roll` at 60 s | minute: sums, averages, maxima, and how many milliseconds the bucket covers | 7 days |
| `roll`, `host_roll` at 900 s | quarter of an hour, the same | 90 days |
| `growers` | reading of one disk grower: its name, the time, its size | 90 days |
| `grower_tries` | disk grower: when its walk was last tried | 90 days |

A tick at second `t` says what was used in the ten seconds up to `t`, so it belongs to the bucket that `t - 1` is
in. Both resolutions are made from the raw ticks, never one from the other, so no figure is an average of averages.
A series' average memory divides by the bucket's samples, not by the ticks the series was in: gone for half the
bucket, it held half as much. A bucket without a sample gets no row.

The arithmetic, from a measured hour (360 ticks, no gap): 178 rows a tick, and 1.93 MB for 78,000 rows of all
kinds, which is 25 bytes a row with its index.

- raw: 178 × 8640 ticks = 1.5 million rows a day, 38 MB, kept one day;
- minutes: about 190 series a minute × 1440 = 274,000 rows a day, 6.8 MB, kept 7 days: 48 MB;
- quarters: about 300 series × 96 = 29,000 rows a day, 0.7 MB, kept 90 days: 65 MB.

So the database grows by about 45 MB on its first day, by 7.5 MB a day for the rest of the first week, by 0.7 MB a
day after that, and stops at about 150 MB when all three are full. The limit is 500 MB. Over it, every table gives
up the oldest part of its time span until the database is under it again.

A series goes by its `seen` time, never by a look through the rows for one that still names it: `raw` and `roll`
hold about six million rows when full, and the prune runs every quarter of an hour. `seen` is the newest tick the
series was in. The store keeps it in memory and writes it down with each prune, which is a few hundred small
writes, where a write per row and tick would be 178 more writes every ten seconds. After a crash it is behind by a
quarter of an hour at most, so a series is kept a day longer than the longest history: no row can outlive its
series. A database made before the column gets it when the store opens, and its old series count as seen at the
first prune.

**A damaged `monitor.db` does not take the HUD down.** The route file loads with the server, so it must not throw
whatever it finds. A file that is not a database, or is malformed where the open reads it, is moved aside as
`monitor.db.broken-TIMESTAMP` with its `-wal` and `-shm` files, and a new database is started: the monitor is back
by itself, the history is in the file that was set aside, and a mark on the timeline says so. A database that
cannot be opened at all (a folder that cannot be written, a full disk) leaves the monitor off until the server
next starts, and `/api/monitor/now` and the page say why. The HUD's state reads the monitor inside a guard, so a
database that stops answering later costs the top bar its word for this machine and nothing else.

## What the monitor costs

The monitor measures itself and stores the result with every tick: the CPU of the tick's own work, plus the `ps`
and the herdr calls it started, and the footprint of the process it runs in. Inside the server the CPU figure errs upward: it is the process's CPU
between two instants, so it includes what the server did while the tick waited about 20 ms for `ps`. Run alone
(`scripts/monitor-probe.ts`) for an hour, with the container reader on and test runs going on the machine, it used
0.35% of one core, 35.3 ms a tick, and held 47 MB on average and 73 MB at most (about 32 MB after a collection).
An earlier hour, before the containers were read and before `ps` was limited, measured 0.32% and 44 MB, and the
process's own CPU time over that hour plus the `ps` runs agreed with the sum of the ticks' figures.

## Disk growers

A tick records how much of the disk is free. It does not say what fills the disk. `monitor-disk.ts` reads the sizes
of a few cache and temp folders that grow over weeks, and keeps every reading for 90 days, so the page can say
"`~/Library/Caches` is 110 GB and grew 15 GB in 30 days". These folders and their subfolders are all it walks:

| Grower | Folders walked | How often |
| --- | --- | --- |
| Temp folders | `/private/tmp` and the user's own temp folder | once a day |
| `~/Library/Caches` | `~/Library/Caches` | once a day |
| `~/.cache` | `~/.cache` | once a day |
| Package caches | `~/.bun/install/cache` and `~/.npm` | once a day |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData` | once a day |

A grower whose folders do not exist is left out.

**No folder that macOS guards is read in any way.** macOS asks the user before a program may read some folders. A
server started by launchd that touched one could make macOS ask the owner to let it access data from other apps,
and a question on the owner's screen is worse than a missing number. So the disk growers never list, walk or stat
a path that is one of these, lies inside one, or holds one:

- `~/Library/Containers`, `~/Library/Group Containers`
- `~/Library/Mail`, `~/Library/Messages`, `~/Library/Safari`, `~/Library/Calendars`, `~/Library/Reminders`,
  `~/Library/Application Support/AddressBook`
- `~/Pictures`, `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Movies`, `~/Music`
- `/Volumes`

The home folder and `~/Library` hold guarded places, so they are never walked either. The list is one table in
`monitor-disk.ts` (`guarded()`), asked before every walk, and a test holds every folder in the table above to it.

**The container engine's disk image is not measured.** It lives inside the app's group container, which is
guarded, and the engine's own disk report over the Docker API did not answer within 20 seconds on the build
machine, so it cannot be read within the monitor's cost limit.

**A folder is a walk, and a walk is costly.** `nice -n 19 du -sk` has to look at every file. On the build machine
one walk of the large folders above took about 60 seconds of CPU and over 100 seconds of wall time. One folder of
113 GB alone took 41 seconds of CPU. Once a day, 60 seconds is 0.07% of one core. With the ticks' 0.35% the monitor
stays under its limit of 0.5%. Once an hour it would be 1.7%. A folder that fills a disk does so over days, so a
daily size is enough to see it.

The rules of a walk:

- The first walk starts ten minutes after the server starts, so a server that restarts in a loop never walks.
- When each grower's walk was last tried comes from the database, written before the walk starts and whether or
  not it gave a size. A restart does not repeat a walk that is less than a day old, and a walk that fails, or that
  a restart cut short, is not tried again by every restart after it.
- One walk runs at a time, and the tick does not wait for it.
- A walk is stopped after 5 minutes. A walk that was stopped, or that printed no size for one of its folders,
  writes nothing, and is tried again a day later. No size is better than a wrong one.
- `du` exits with 1 when it could not open a folder inside the one it walks, and still prints the size of the rest.
  The monitor takes that size. A grower's size is therefore the size of what the server may read.

The CPU the walks used is part of what the monitor says it costs. It is added to the tick after the last walk
ended, so that one tick's figure is about a minute of CPU, once a day.

`growers(db, { now })` gives the page each grower's newest size, largest first, and how much the grower grew since
the reading nearest to 30 days before, or since its oldest reading while there are fewer days. It lists the growers
of the table above only: the sizes of one that an earlier version read stay in the database for 90 days and are
not shown.

MACHINES still walks the temp folders every ten minutes for its own readings (`machines.ts`). That walk is not
part of the monitor and is not counted here.

## What it cannot see

- **The kernel.** No reader without root sees `kernel_task` as a process. Its CPU is most of "kernel and
  unattributed", and its memory is in the host's wired figure, not in any row.
- **A tree that is killed at once.** When a parent and its children die in the same tick and launchd collects the
  children, the last stretch of their CPU goes to "kernel and unattributed" for that tick. The error never invents
  CPU.
- **The container engine's disk image, and the user's own files.** The disk growers are five cache and temp
  folders. The engine's image is inside a folder macOS guards, and so are Documents, Downloads and the like: the
  disk growers read none of those (see Disk growers), so the page cannot say how large they are.
- **Inside a virtual machine other than OrbStack's.** Docker Desktop is one process holding all its containers'
  memory, and the monitor blames the app. OrbStack's Linux machines that are not containers are part of its
  machine's own row.
- **The footprint of other users' processes.** Root's daemons show their resident size.
- **Thermal throttling in numbers.** The thermal pressure level (nominal to sleeping) is readable without root, and
  reads nominal when the system does not publish it. The CPU speed limit is not readable on Apple silicon.
- **One tick of CPU in about a month.** The host's CPU times are 32-bit counts of hundredths of a second, summed
  over the cores. On 16 cores the idle count wraps after about 31 days up, and the busy counts much later. A total
  that went down is how a restart is told, so the tick that sees a wrap counts no CPU, as the first tick after a
  start does. The tick after it is whole again.
- **Other systems.** The reader is for macOS. On another system the monitor is off. `monitor-ps.ts` parses the `ps`
  of any system, which is what a reader over ssh would start from, but that reader does not exist yet, and it would
  give resident sizes only.

## Marks

A mark is a time, a short kind and a text. Some are put down: `hud monitor mark "full suite started" --kind suite`
from a script that wraps a test run, or a `POST /api/monitor/marks` with `{ text, kind }`. The history finds the
others when it is read: a restart (the machine's start time changed), a gap in the samples, a lane that started or
ended. A mark is kept as long as the history it marks.

`hud monitor mark` is made for scripts that must not be held up. It waits 1.5 seconds at most and its exit code is
0 whatever happened: no HUD, a HUD that never answers, the monitor off, or no text.

`/api/monitor/page/events` and `/api/monitor/marks` give the timeline of the last `?hours=` (whole hours, 24 unless
said, 90 days at most). An answer is kept for a minute per number of hours, because the page asks for a week of it
every minute and reading that takes a tenth of a second. A mark that is put down drops what is kept, so it shows
at once.

## What limits the machine

One table of rules (`monitor-limits.ts`) says what limits the machine in a stretch of time. The verdict on now and
the history's episodes both read it, so they cannot disagree.

| Limit | Tight | Capped |
| --- | --- | --- |
| Memory | The kernel's pressure is at "warn" for half the stretch, or swap grows by 100 MB a minute. | The pressure is "critical" at any time, or it is at "warn" while swap grows. |
| CPU | 80% of all cores busy. | 15 of every 16 cores busy. |
| Heat | Thermal pressure moderate. | Thermal pressure heavy or worse. |
| Disk | Under 100 GB free or under a tenth of the disk, whichever is less. | Under 20 GB free or under a fiftieth of the disk, whichever is less. |

Memory follows the kernel's pressure level and whether swap grows. It never looks at how full swap is: a machine
sits at 90% swap for days and is fine, and one whose swap grows by the minute is not.

Swap growth is over the same time as everything else in the stretch. The verdict on now reads the last six ticks,
which cover 60 seconds, and counts swap from the tick before them to the last of them. From the first of the six
to the last is 50 seconds, and a rate made of that growth over 60 seconds reads a sixth too low. A tick that covers
no time (the first after a start or a gap) adds no growth. A minute's bucket compares its average with the average
of the minute before, which for swap that grows steadily is the same rate.

The disk's lines follow the disk's size, because a 256 GB disk has under 100 GB free for most of its life and a
fixed line would call it tight for ever: its lines are at 25.6 and 5.12 GB, and a disk of 1000 GB or more has them
at 100 and 20 GB. When the disk's size could not be read, the fixed amounts alone apply.

## The page

`/monitor` is one file, `public/monitor.html`, with no part of the HUD's page in it. It asks for the newest sample
with every tick and for each longer part no more often than the server makes it anew (the hour every 10 s, the day
every minute, the week every 5 minutes, the 90 days every quarter of an hour). While it is hidden it has no timer
and asks nothing, but for its first picture: a tab opened in the background shows the machine when it comes to the
front. It says how old the newest sample is, by the server's clock, and says so when the server stops
answering. It draws what the routes give and has no threshold of its own: the limits, the size from which a lane or
an app has a tile (half a GB, or 2% of the cores), the colours and the sentences all come with the data. The
sentences of a sample you scrub to are filled in by the page from the server's words (`pageWords`), because no
request keeps up with a pointer. The server sends the page a policy that lets it load itself and its two fonts and
nothing else. It reads the HUD's theme and writes nothing to the browser.

What the routes promise the page, and any other reader:

- **One name per holder.** `name` is what a holder is called in a tile, a row and a sentence: "lane builder", an
  app's own name, "pane shop". A pane is recorded by its folder (`~/…/trees/shop-web`) and goes by the folder's last
  name. Two panes in one answer that share it each add the folder before it, "pane shop-web (trees)", and keep all
  of the folder when that is the same too. `full` has all of it ("pane ~/…/trees/shop-web") whenever the name is
  the short of it, for a tooltip. A pane inside Other lanes is a part with the same two fields.
- **Nothing at zero.** A holder that prints as 0.0 GB and 0.00 cores is not among what is held, and a part under
  0.05 GB or 0.01 cores is not among a holder's parts. The four fixed holders keep their place in the list of who
  there is, because the groups have their names from it. The page leaves out what prints as nothing in the view it
  draws.
- **The last sample of a range is now.** Its memory is what is held at the newest tick, as `now` reads it, and
  not the average of a step that may be six hours long, so no peak of a range is under what the tiles of now show.
  An incident that still runs peaks at the newest tick when that is its worst reading, and a day's peaks count the
  ticks of the minute still running.
- **A sample is named by when it ends.** A tick at second `t` says what was used up to `t`. A minute, a quarter of
  an hour and a step of a range are named the same way: the minute up to 10:59 is 10:59. So an incident's `peak`
  and a day's worst moment are the end of their bucket, or the newest tick's own time, and the page finds the step
  for a time as the one that ends at it or next after it.
- **One worst moment per day.** A day carries its worst minute and who held the most in it (`worst`). When the
  newest tick is at least as bad as the day's worst minute, the day's worst moment is that tick, with the time and
  the holders `now` gives. An incident that still runs follows the same rule, so the day panel, the dot on the
  strip and the list of worst moments give one time and one figure. The page shows the moment the server names
  and works out none of its own.
- **A day is a date on this machine's clock.** It runs from its own midnight to the next, by the offset of each,
  so the day the clocks change is 23 or 25 hours long and the days after it are not shifted. A past time in a
  sentence is printed by the offset of its own date.
- **A day's average is over the day.** `top` is who held the most over all of the day's samples, from the
  rollups and the ticks no bucket holds yet. A day that is over is read once and kept, because the quarters of an
  hour of 90 days are millions of rows.
- **Where recording began is said once.** `began` comes with `now`: the start of the minute the oldest sample is
  in, or of its quarter of an hour once the minutes are gone. Every range says that same time, and none works one
  out from its own steps.
- **CPU has its own sentence.** `now.sentence` names who holds most of what ran short. `now.sentenceCpu` names who
  uses the most CPU, in cores, whatever the limit is. The page shows it while its map shows CPU.
- **The page's words.** The line of numbers under the blame (`now.detail`) has no verb, so the page fills the same
  phrases (`words.detail`) for a sample you scrub to. A past headline says when and why from `words.past` and
  `words.reason`, which are the phrases the live headline is made of.

The strip under the map is time from left to right. It runs from the first step with a sample, or from where
recording began when that is inside the step, to now. One rule places everything on it. A step is drawn where it
ends, the newest at now, and it stands for the time back to the step before it. Its values, the band of its state,
the pointer over it and the playhead on it all go by that rule, and the labels of the axis are on the same scale. A
band says what the limit was when that is not what the strip draws: "capped by memory" over a quiet CPU strip.

A refresh never takes the keyboard's focus: tiles, the key's rows, the table's rows, an opened holder's parts and
the dots on the strip stay the elements they are while their numbers change, and a list that is built anew gives
the focus back to the same thing, found by its id. No holder wears red or amber, which are the states' colours.

`test/client/monitor-page.test.ts` holds the file to its rules, `test/client/monitor-walk.test.ts` drives the
ranges and Now in Chrome, and `test/mobile-walk.ts` walks it on three phones.

## The design, by Norman's principles

The owner asked for a page designed after The Design of Everyday Things. Each principle is served by a choice that
can be pointed at:

| Principle | The choice |
| --- | --- |
| Discoverability | The answer is a sentence above the map, with the state as a word beside it: "Not capped", "Close to the cap", "Capped". When memory is capped, what does not fit in RAM is drawn above the RAM line in red, so it is seen before it is read. Away from now, the state of now stays in sight as a pill that leads back. |
| Conceptual model | One picture. The rectangle is the machine's RAM, a tile's area is what a holder would free, and time is the strip underneath. Every other gauge is the same kind of vessel with the monitor's limits drawn on it. |
| Signifiers | A tile lifts under the pointer and takes a focus ring. The playhead has a grip. Worst moments are dots on the strip. Every row that moves the playhead ends in an arrow and names the time it goes to. |
| Mapping | A holder keeps one colour in the tiles, the stream, the CPU cells and the evidence strips, and keeps it from one visit to the next. A holder without a colour always carries its name or a number from the key. Time runs left to right everywhere. Area is size. |
| Feedback | The page says which moment it shows ("Viewing 10:29, 31 min ago"), how old the newest sample is, and when the server stops answering. A gap stays empty, and a day that was not recorded is drawn as not recorded. |
| Constraints | Four ranges, two toggles and no settings. The playhead cannot leave the samples that exist, and a strip starts where recording began. |
| Error tolerance | Nothing on the page can stop a process or change the machine. "Now", Esc and the breadcrumb always lead back. |

What it took from the monitors the brief named:

| From | The idea |
| --- | --- |
| Activity Monitor | The verdict follows the kernel's memory pressure level, not a sum of process sizes, and memory is the footprint a holder would free. Helpers count toward their app. |
| iStat Menus | Small vessels that read at a glance, each with who is in it. |
| btop | One cell per core, a dense layout, and every action on the keyboard. |
| Grafana | Range tabs, one shared time axis, and events drawn on the timeline. |
| Netdata | One scrubber drives every panel, trouble is marked on the strip itself, and processes are grouped by whose they are. |
| Disk maps | Area as size and a click to go one level down, as in DaisyDisk and GrandPerspective. |

## A replay

With `HUD_MONITOR_REPLAY=FOLDER` the server opens `FOLDER/monitor.db`, samples nothing, reads no process table and
no herdr, and answers the page's routes as if the database's newest sample were now. It needs no `HUD_MONITOR=1`,
since nothing is sampled. The page then looks the same
on every run, which is what a test and a screenshot need. The colour slots are the one thing it writes.
`bun scripts/monitor-fixture.ts calm|capped FOLDER` writes such a database through the real store, with invented
lanes, panes and apps: an hour in which nothing is the limit, or one that ends capped by memory. A copy of a real
`monitor.db` replays the same way.

`HUD_MONITOR_DISK=0` leaves the disk growers unread, for a server that is only tried out.

## MACHINES and the monitor

MACHINES in the HUD's top bar reads its own samples (`machines.ts`, one row a minute for two days): a machine past
90% of CPU or memory is shown in red with the percentage. This machine swaps by design, so it reads past 90% of
memory for days while nothing limits it. The monitor then said "Not capped" and MACHINES said 93%.

So the two speak with one voice about the machine the monitor runs on. The route file puts the monitor's verdict in
the HUD's state as `S.monitor` (`{ machine, state, said }`, from `monitor-standing.ts`), and the top bar takes its
word for that machine from it: OK, CLOSE or CAPPED, with the monitor's own sentence in the tooltip. A tick that
changes the verdict pushes the state, so the top bar follows within a tick.

MACHINES keeps its old rule in two cases. Other machines have no monitor, so they go by their readings. And
`S.monitor` is absent when the monitor is off and null when its newest tick is more than three ticks old, so a
monitor that has stopped says nothing and the top bar draws as it did before.

The readings themselves stay as they are. For this machine every one of them is part of a tick: load, the busy
share of the CPU, memory used, swap, free disk. The plan is that the monitor replaces them there in a later change,
and that MACHINES keeps its own sampler for the other machines until the monitor has a reader over ssh.
