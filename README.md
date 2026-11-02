# HQ Office

HQ Office is a small local web app for people who run AI coding agents in [herdr](https://herdr.dev). It draws a pixel-art office in the style of a handheld RPG: every lane (one agent working one task) is a worker at a desk, and you can see at a glance who is busy, who is blocked and who is done. Next to the room is the question panel, where your HQ agent (the agent that coordinates the others) asks you things and you answer them. Your answers are typed straight into the HQ agent's session.

## Requirements

- [herdr](https://herdr.dev) 0.8.0 or newer
- [Bun](https://bun.sh) 1.1 or newer
- macOS or Linux

## Install

```sh
herdr plugin install NicolaiHerforth/hq-office
```

## First run

1. Run the start action:
   ```sh
   herdr plugin action invoke hq-office.start
   ```
   It creates `config.env` in the plugin's config directory (the path is printed; `herdr plugin config-dir hq-office` shows it too), starts the server and opens the page.
2. Edit `config.env` and set `HUD_HQ_AGENT` to the herdr agent name of your HQ lane. `herdr agent list` shows the names; the start action prints them too when `HUD_HQ_AGENT` is empty.
3. Restart to pick up the change:
   ```sh
   herdr plugin action invoke hq-office.reload
   ```

The database and uploaded images and files live in the plugin's state directory, so they survive reinstalls.

To keep HQ Office running across crashes and restarts, install it as a service (below). To give HQ the `hud` command, run `herdr plugin action invoke hq-office.install-hud`.

## Actions and pane

| Name | What it does |
| --- | --- |
| `hq-office.start` | Starts the server if it is not running (through the service, when it is installed), then opens the page in your browser. |
| `hq-office.stop` | Stops the server the plugin started. With the service installed, stops the service until the next login or start. |
| `hq-office.reload` | Restarts the server. Use it after editing `config.env`. With the service installed, it writes the service again with the new settings. |
| `hq-office.open` | Opens the page without touching the server. |
| `hq-office.install-service` | Runs the server as a per-user service that starts at login and restarts when it stops. Run it again to update the service. |
| `hq-office.remove-service` | Stops and removes the service. Your data stays. |
| `hq-office.install-hud` | Puts the `hud` command in `~/.local/bin` for HQ. Run it again to update it. |
| `status` pane | A popup with the server state, whether the service is installed and running, open questions, lanes by status, the HQ agent, whether HQ's current session has the HQ guide, the data directory and the URL. |
| `pane.agent_detected` event | When an agent starts, `bin/hud-plugin.ts greet` types the HQ guide (below) into it, once per session, if it is your HQ agent. Other agents get nothing. |

## Service mode

The start action runs the server as a background process, which ends when the machine restarts or the server crashes. The install service action makes it a per-user service instead:

```sh
herdr plugin action invoke hq-office.install-service
```

- **macOS**: a LaunchAgent, `~/Library/LaunchAgents/dev.hq-office.server.plist`, loaded with `launchctl bootstrap gui/<your uid>`. It runs at login and launchd restarts it whenever it stops (`RunAtLoad`, `KeepAlive`).
- **Linux**: a systemd user unit, `~/.config/systemd/user/hq-office.service`, with `Restart=always`, enabled and started with `systemctl --user enable --now`. User services run while you are logged in; to keep it running when you are not, and to start it at boot, run `loginctl enable-linger "$USER"` once.

The service runs Bun on the plugin's `server.ts` with the values from `config.env`, `HUD_DATA_DIR` set to the plugin's state directory (the same data the start action uses), and a PATH that includes `~/.bun/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. Its log is `server.log` in the state directory. If something else is already answering on the port, the action stops and says so instead of installing a service that cannot start.

With the service installed, start, stop and restart use it. The settings are written into the service, so after editing `config.env`, or after updating the plugin, run the restart action, `herdr plugin action invoke hq-office.reload` (herdr takes the action as `hq-office.<action>`; options go before it), or install service again: it writes the service again and restarts it. Restart refuses to point the service at a different data folder than the one it uses, so running the plugin's script by hand cannot swap in an empty board; `--force` moves it on purpose. Stop unloads the service until the next login or the next start; remove service takes it away for good:

```sh
herdr plugin action invoke hq-office.remove-service
```

Removing the service never touches the database or the uploads.

## The `hud` command

HQ talks to the server with `hud`. The install hud command action writes `~/.local/bin/hud`, a small script that runs the plugin's `hud.ts` with `HUD_URL` set to your server's address (a `HUD_URL` in the environment still wins):

```sh
herdr plugin action invoke hq-office.install-hud
```

It creates `~/.local/bin` if needed and prints what to add to your shell profile if that folder is not on your PATH. Run it again after changing `HUD_PORT` or updating the plugin. If `~/.local/bin/hud` already exists and is not the plugin's own (for example a link to a `hud.ts` somewhere else), the action leaves it alone and prints what it points at; remove it and run the action again to replace it.

## Teaching HQ to talk through the HUD

You read the page, not HQ's terminal, so an HQ that answers your notes in its own terminal is never heard. The plugin
teaches it without any setup per session:

- **The HQ guide.** When herdr detects your HQ agent (`HUD_HQ_AGENT`) starting in a pane, the plugin types a short
  guide into it, once per agent session: replies go back through `hud tell` or `hud comment ID`, questions are asks
  edited in place, work in flight is on the board and `hud board` starts every sweep. `hud guide` prints it, and the
  plugin log (`herdr plugin log list --plugin hq-office`) shows each greet. `HUD_HQ_GREET=0` turns it off.
- **A reminder on every message.** Every note, answer, reply and secret the server types into HQ ends with one line:
  reply through the HUD, the owner does not read this terminal. `HUD_HQ_HINT=0` leaves it out.

## The question panel and Tell HQ

Questions from HQ appear at the top of the panel, most urgent first. Pick an option or type an answer; it goes to HQ the moment you send it. Tell HQ is a free-text box for anything HQ did not ask about, such as a new priority or a correction. Both are stored, so nothing is lost if HQ is busy.

HQ uses the CLI in `hud.ts` (the `hud` command after the install hud command action, or `bun hud.ts` from the plugin directory with `HUD_URL` set if you changed the port) to add lanes, ask questions and wait for your answers. HQ posts progress to the **MESSAGES** tab with `hud tell --title "PR is up" [--body "details"] [--lane NAME]` (`hud say` is the same command); the tab counts unread updates until you open it. MESSAGES is the whole conversation: HQ's updates, your notes and your answers to HQ's questions (with whether HQ acted on them), oldest at the top. `hud guide` prints how HQ should reach you.

## Briefs

A brief is a longer write-up from a floor's HQ: a project update, a plan, a summary. Messages are too narrow for that. HQ posts one with:

```sh
hud brief --title "Weekly: pricing and search" --file brief.md   # or --body "...", or pipe it in
```

A brief can also be a whole HTML page (anything starting with `<!doctype html>` or `<html>`), with its own styles, scripts, charts and pictures inline, the way a Claude artifact is, without a Claude account: `hud brief --title T --file brief.html`. See [Pages](#pages).

It goes on the HQ's own floor. The **BRIEFS** tab lists the floor's briefs newest first, with dates and a count of new ones. Opening one takes the right column at full width, the way a room does, with its markdown rendered (headings, tables, lists, code), **NEWER**, **OLDER** and **BACK**; on a phone it fills the screen. Each new brief also puts one short line in MESSAGES that opens it. The HQ guide tells every HQ to use briefs for anything longer than a few lines.

### Comments

You can comment on any brief, and on a room's pages, the way you comment on a Claude artifact. The thread sits beside the brief on a wide screen and under it on a phone (a **COMMENTS** button jumps to it), newest at the bottom, with a send box that takes images and files. Select a passage of a markdown brief and press **COMMENT** to quote it in your comment.

Each comment is typed into the brief's author: the lane that posted it, else the floor's HQ (through HQ's outbox, so it waits while HQ is not receiving). On a room's page it goes to the room's owner. A comment for a lane shows **DELIVERED**, or **AWAY · KEPT** while herdr does not see the lane; a kept one is typed in once when the lane is back. The prompt names the brief and says how to answer:

```sh
hud brief comments ID                      # the thread (--json for JSON)
hud brief reply ID "Answer" [--reply N]    # answer in it (or pipe the text in)
hud page comments rooms/SLUG/files/NAME.html          # the same for a room's page (or rooms/SLUG/brief)
hud page reply rooms/SLUG/brief "Answer" [--reply N]
```

An answer shows in the thread, marks the brief **REPLY** in BRIEFS until you open it, and puts one line in MESSAGES.

## HQ queue

**HQ QUEUE** in SETTINGS is off by default, and off is the HUD as it always was: lanes and your notes are typed straight into HQ's pane. Turned on, what reaches HQ waits in a queue HQ reads at its own pace, instead of interrupting it mid-turn:

- **Lanes change nothing.** What a lane types into HQ's pane (as lanes do today, `herdr agent prompt hq "api-auth: ..."`) is held by HQ's hook and filed in the queue; the name before the colon says who sent it. `hud request TEXT` files one directly. A message that starts with **URGENT** goes straight in: for when main is red, production is affected, or you are waiting on it (`hud guide lane` gives lanes that rule).
- **Your Tell HQ notes** wait there too; the **URGENT** switch on Tell HQ sends one straight in. Its mark says "in HQ's queue" until HQ reads it.
- **HQ always sees the count**: a line on every prompt and tool call, with what is unread and which lane is waiting for an answer, from whom and since when. It cannot stop while something is unread, and the HUD prompts it when it sits idle with unread items.
- **HQ reads and answers**: `hud req next` reads the next item; `hud req answer ID TEXT` types the answer into the lane's pane (or, for your note, posts it as an update); `hud req close ID WHY`. A lane's item stays open until HQ does one of these. `hud req list`, `hud req line`.
- The top bar shows **HQ QUEUE** with the count while it is on.

**HQ's hook** is what holds lanes' messages. It is a Claude Code hook, added to this user's `~/.claude/settings.json` by the plugin action **HQ Office: add HQ's queue hook** (`herdr plugin action invoke hq-office.install-queue-hook`). That action:

- writes a backup first, `~/.claude/settings.json.hq-office-<time>.bak`;
- adds three entries under `hooks` (`UserPromptSubmit`, `PostToolUse`, `Stop`), each running `HUD_URL=http://127.0.0.1:<port> bun <plugin>/bin/hq-queue-hook.ts` with a 5 second timeout, and changes nothing else;
- is undone by **HQ Office: remove HQ's queue hook** (`hq-office.remove-queue-hook`), which takes out exactly those entries (again after a backup), or by restoring the backup.

The hook does nothing in any session but a floor's HQ's own (the HUD matches the session id herdr reports for HQ), and nothing while HQ QUEUE is off. It fails open: if the HUD is down, slow (1.5 s) or answers anything else, the message reaches HQ untouched; a message is held only after the HUD has stored it. Without the hook, the queue still takes your notes and `hud request`, and still prompts an idle HQ; lanes' typed messages then reach HQ directly, as before.

## Layouts

**MENU**, top right, holds SECRETS, SETTINGS, SOUND and LAYOUT. LAYOUT is each viewer's own choice, remembered in that browser:

- **OFFICE** (the default): the office, or the building with several floors, takes the whole right column.
- **LANES BOARD**: a board under the office lists every lane by name in three columns: **WORKING**, **WAITING ON YOU** (with what it asks, oldest first) and **NOT MOVING** (waiting on HQ, on CI, at a prompt, or its agent gone; stuck longest first). Parked and done lanes are counted, not listed. Inside a floor it shows that floor's lanes; in the building, every floor's.

Clicking a worker in the office, or a lane on the board, slides in its **agent drawer** from the right, over the office. It is read-only; talking to a lane goes through its room. It shows the lane's status, its open question (with **ANSWER IN NEEDS YOU**), a prompt it is blocked on, **NOW**: its terminal (the last 30 lines, read from herdr every 3 seconds while the drawer is open and the page is visible, and not otherwise; any secret value the HUD holds is blanked out as `[secret NAME]`), what it last said (its updates, room messages, questions and events), and its work (issue, PR and its rooms). ✕ or Esc closes it; on a phone it is a sheet at the bottom of the screen.

## Subscription usage

**SUBS**, in the top bar next to MACHINES, shows how much each subscription has left, so you can pick the one with
room. One square per sub, colored by its tighter window (green: 25% or more left; amber: under 25%; red: under 10%), and
how many have room. Click it for each sub's **5H** and **WEEK** windows: what is left, when each resets, which machine
it is active on (or PARKED), and how old the reading is. Esc or a click elsewhere closes it.

The numbers are what the agents last reported, read once a minute on every machine in `HUD_MACHINES` (over the same
ssh as the machine stats) by `src/server/sub-usage.sh`, which needs python3 on that machine:

- **Claude Code**, through the [grazr](https://github.com/wazum/herdr-grazr) herdr plugin. After every message, grazr
  keeps the 5-hour and weekly usage Claude hands its status line, per enrolled account. SUBS shows each account once,
  with its newest reading from any machine. A parked account shows what it had when grazr left it.
- **Codex**: the last `rate_limits` in its newest session log (`~/.codex/sessions`). Codex doesn't say which account it
  is on, so each machine's Codex is a sub of its own. It may report a weekly window only; SUBS then says "no 5-hour limit
  reported".

Nothing calls a provider or uses a credential. Only names, percentages and times leave a machine: no email, account
id, token or transcript text. The readings are kept in memory, never in the database. A machine without grazr,
Codex or python3 shows as "no source" in the dropdown; with no source anywhere, there is no SUBS box.

## Secrets

Paste a key into **MENU › SECRETS** (a panel over the office) with a name and a lifetime in minutes, or into the fields of a question HQ asked with `hud ask --secret NAME`. HQ reads it until it expires:

```sh
hud secret get NAME | <command>          # the raw value, to a pipe only; refuses a terminal
hud secret get NAME --once | <command>   # and delete it on read
<command> | hud secret set NAME --minutes 30   # the value comes from stdin, never an argument
hud secret rm NAME
hud secret list                          # names, who set them, when they expire, and any LOST ones
```

Every expiry is said both ways, in local time: `expires in 6d 23h (Mon 2 Nov, 13:45)`, or `expires in 23h (tomorrow 13:45)`.

Values live in the server's memory only: never in the database, the log, `/api/state` or any listing. The deadline is checked on every read. Setting, removing and listing secrets works from the HUD's own page wherever you open it: on this machine, or at an address listed in `HUD_TRUSTED_ORIGINS` (the tailnet through `tailscale serve`, say), the same addresses every other write accepts. A write from such an address needs the page's own `x-hud` header and, where the browser sends `Sec-Fetch-Site`, same-origin; another site's page can do neither, so it is refused, as is any address not listed. The read route answers only a client that is not a browser (`hud secret get`), and no page gets a value except through COPY (below).

One exception, for you: **COPY** on a secret in MENU › SECRETS puts its value on your clipboard. It is the only way a value reaches a browser, and the server gives it only to the HUD's own page:
- the page's own origin, or one you listed in `HUD_TRUSTED_ORIGINS` (such as your tailnet address);
- a same-origin request (`Sec-Fetch-Site`) with the page's header;
- only when you click.

The value goes straight to the clipboard and is never written into the page, its storage, `/api/state`, the log or the database. Each copy adds an event line, "copied NAME". Anything that can read your clipboard, a clipboard manager for instance, can read a copied value.

**Restarts.** A planned restart (the plugin's reload or install service action, which a plugin update needs) hands the secrets over: the plugin takes them from the running server over loopback, holds them in its own memory while the new server starts, and gives them back with their original deadlines. Nothing is written to disk on the way. The handover routes also need a token that each server start writes to `secret-handover.token` in the data folder (readable by you only; it is not a secret value), and the new server takes a handover only while it holds no secrets, within 2 minutes of its start.

A crash, a kill or a stop and start loses the values. The server keeps each secret's name, setter and deadline (never its value) in the database, so after such a restart it knows what it lost: the SECRETS tab lists those names as LOST in red, `hud secret list` marks them, `hud secret get NAME` fails with `NAME was lost when the server restarted at 13:45; ask the owner to set it again`, and HQ gets a one-line note. Setting the secret again clears it, and DISMISS (or `hud secret rm NAME`) removes the name.

## Lanes in levels

Lanes can form a tree under HQ. `hud lane NAME --parent OTHER` sets who a lane reports to (`--parent hq` puts it straight under HQ); a loop is refused, and removing a lane moves its reports up a level. `hud tree` prints the tree with each lane's level name and status. In SETTINGS, LEVEL NAMES names the levels from the top (default `Manager, Lead, Engineer`; deeper lanes take the last name) and LEVEL THEME picks how the room dresses them. The worker card shows a lane's level and its chain up to HQ.

A theme dresses every figure in the room, whatever the levels:

| | Office (default) | Arena |
| --- | --- | --- |
| Level 1 | dark suit, tie in its own colour | masked guard, square mark, black belt |
| Level 2 | light cardigan | masked guard, triangle mark |
| Level 3 and deeper | everyday clothes | numbered player in a matching tracksuit |
| No tree (every lane under HQ) | everyday clothes | numbered players |
| Your hero | as picked in HERO | the game master: black coat, black mask with gold eyes, your hero's own hair (standing, dancing and asleep) |
| HQ | its usual look | the senior guard, a gold crown on the hood |

In Arena nothing seasonal is drawn over a mask (guards, the hero, HQ; so HERO HAT has no effect there), and players
leave off seasonal hats and coats but keep what they hold. Office with no tree looks as it always did. The art is
our own, not any show's.

## Floors

A floor is one HQ agent and everything it runs. When one HQ has too many lanes, run several: one HQ per domain
(frontend, backend, marketing, legal), each with its own questions, messages, work board, rooms, lane tree and sweep
nudge. Secrets, settings and machines are shared. Everything you have starts as the first floor (`HUD_FLOOR_NAME`
names it, `HQ` by default), and one floor works exactly as HQ Office always has.

Every floor, and the whole office, shows three readings the same way everywhere: red `! N` when N things wait on you,
green bars for lanes working now, and amber `Zz N` when nothing is moving (lanes assigned, none working, none waiting
on you: HQ's to unstick; red after 20 minutes). On the page, one row over the office shows the floor you are in as a
pill; it opens the floor list, where **+ ADD A FLOOR** adds one: give it a name and a colour, and either pick an agent
that runs in herdr on this machine as its HQ, or **START A NEW HQ**: the HUD opens a herdr tab beside your first HQ and
starts `hq-<floor>` in it, as whichever agent you pick (any kind herdr can start; your first HQ's by default). Nothing
in a floor assumes a provider: its HQ and its lanes are whatever agents you run in herdr. An agent whose commands run in
a sandbox that blocks the network has to run `hud` outside it (with escalated permissions); `hud` and the HQ guide say
so. A floor whose HQ is not running says so where it shows, with START ITS HQ and PICK ANOTHER;
only an HQ that was running and stopped raises the "HQ isn't receiving" alarm. With two or more floors, BUILDING shows
them all. `docs/floors.md` has the rules of the floor UI.

```
hud floor add backend --hq hq-backend --name Backend --color #4a90d9   # hq-backend runs in herdr here
hud floor add legal --start --name Legal                                  # the HUD starts its HQ, hq-legal
hud floor add ops --start --kind codex --name Ops                         # its HQ as another herdr agent kind
hud floor list                                                            # HQ, receiving, lanes, waiting on you
hud floor set backend --name "Back end"
hud floor rm backend                                                      # only an empty floor
hud lane api-auth --floor backend                                         # moves it, with every lane under it
hud floor tell legal "can you review the terms change?"                  # from one HQ to another floor's HQ
```

`hud` sends its herdr pane with every call, so an HQ's work lands on its own floor without any setup, and a lane's on
its lane's floor. Your answers and notes reach the HQ of their floor only. `hud inbox`, `wait`, `ack`, `board`, `tree`
and `room list` show the caller's floor; `--all` shows every floor, and `--floor ID` picks one by hand. The details
and the state the page reads are in [docs/floors.md](docs/floors.md).

## The work board

The WORK tab lists every piece of work in flight: an issue key, its pull requests and the lane that owns it. HQ adds one with `hud track ISSUE --lane L --pr N`, and `hud lane NAME --issue X --pr N` links a lane's work too. Each item's state is worked out from facts, in this order: done (all PRs merged or closed, or `hud done ISSUE`), waiting on you (an open question names its lane, issue or PR), waiting on CI (a check is running), paused (`hud pause ISSUE REASON`, undone with `hud resume ISSUE`), moving (the lane is working, or something changed in the last 45 minutes), and otherwise stalled. Stalled work shows red at the top of the question column and at the top of `hud board` (`--json` for JSON).

PR facts come from the `gh` CLI. The server caches them and refreshes them every 10 minutes while anything is open, and when HQ runs `hud board` if the cache is over a minute old. Page loads never call GitHub.

## Conference rooms

A piece of work with an owner can get a conference room: one place where you talk straight to the lane that owns it (usually a manager or a lead) or to any lane in it, and where that lane keeps the concrete context of the problem. Think of it as the work's project folder. HQ opens one, and the owning lane keeps it current:

You can open one yourself too: **+ NEW ROOM** on the ROOMS tab asks for a title, the lane that owns the room (or HQ), any other lanes, an issue or a PR, and an optional first message. The room's address comes from the title, HQ hears that you opened it, the first message goes to the owning lane like any message in the room, and the room opens.

```sh
hud room create SLUG --title T --owner LANE [--member L ...] [--issue X ...] [--pr N ...]   # again: change or reopen it
hud room path SLUG                    # the room's folder (see below)
hud room brief SLUG --body B          # the pinned brief, in markdown, replaced as a whole (or piped on stdin)
hud room brief SLUG --file brief.html # or a whole HTML page (see Pages)
hud room artifact SLUG --title T --url U            # a Claude artifact link (recognised by its address) or any link
hud room artifact SLUG --title T --file PATH        # an image or any file, copied into the room's files/ (25 MB at most)
hud room say SLUG TEXT [--as LANE] [--reply ID]     # write in the thread (as the owning lane unless --as)
hud room read SLUG [--since ID] [--wait] [--json]   # your messages; --wait blocks until a new one, like hud wait
hud room list [--all] [--json]
hud room archive SLUG
```

The **ROOMS** tab, next to WORK, lists the rooms with their owner and its level, the state of their work on the work board and their last activity; the tab counts rooms with new messages from lanes. A room is a place you go to: open one and it takes the place of the office on the right, full height, at its own address (`#room/SLUG`), so a link, a reload and the browser's back button work. BACK TO OFFICE or Esc return to the office, and the strip at the top of a room moves straight to the other open rooms, marking those with new messages. The question column never moves. In the room, the thread fills the main column with the send box always at its foot: write there, with images as anywhere else, and messages keep their line breaks and render as markdown. TO picks the lane (the owner by default, or any lane in the room); REPLY on a lane's message answers it and addresses that lane. A rail beside the thread holds the room's lanes (level, status, and AWAY when herdr cannot find the agent), its issues and PRs with their board state, the brief and the artifacts shelf (Claude artifacts and links as cards with OPEN, images as thumbnails that open full screen, files); fold it to give the thread the width. Above them a small pixel conference room seats the room's lanes at a table with you at its head. On a phone a room fills the screen with CHAT, BRIEF and SHELF tabs.

Each room is a folder on the HUD's machine, `rooms/SLUG/` in its data folder (`hud room path SLUG` prints it, and so does `hud room create`). Its `files/` holds everything shared in the room: files added with `hud room artifact --file`, files you add on the page, and images attached to the room's messages, each under its own name (`name-2.ext` when the name is taken). A lane can also save straight into `files/`: the file joins the shelf (by "folder") once it is written, and a file deleted from `files/` drops off the shelf. Beside it, `shelf.json` and `brief.md` mirror the shelf and the brief, so a lane can read the whole room from disk; the database stays the source of truth and the mirrors are rewritten whenever the shelf or the brief changes. An open room's `files/` is watched (no polling); an archived room keeps its folder. On the page, the shelf's **+ ADD** takes files from a picker and a link with a title, and dropping files anywhere on the room or pasting an image into it does the same. Files are served from `/rooms/SLUG/files/NAME` sandboxed: images show inline, text as plain text, an `.html` file as a sandboxed page (see [Pages](#pages)), and SVG and anything else download instead of opening on the HUD's address.

What you write is typed into that lane's terminal through herdr, naming the room and telling it to answer with `hud room say` and to keep the brief and artifacts current. Each message shows DELIVERED, or AWAY · KEPT when the lane is not there: a kept message stays in the thread and is typed into the lane once, when herdr sees it again (RETRY appears if herdr refused one). Uploaded files are served sandboxed, so a file a lane uploads can show but never run a script.


### Pages

A lane can show the owner a whole HTML page, the way a Claude artifact does, without anyone logging in to a Claude account. A page is any `.html` file on a room's shelf, and any brief that starts with `<!doctype html>` or `<html>`, with its own styles, scripts, pictures, diagrams and interactive parts, up to 5 MB. Like a Claude artifact, a page may also be a fragment, with no `<!doctype>`, `<html>` or `<body>`: a brief that starts with `<title>`, `<meta>`, `<link>`, `<style>` or `<script>` is one, and so is any `.html` file. The HUD serves a fragment wrapped in a small skeleton (charset, a viewport with `viewport-fit=cover`, `color-scheme: light` on `:root`, no body margin), as claude.ai does for an artifact: a fragment that has a dark look of its own gets dark with the HUD, any other stays light. A brief that starts any other way is markdown, even when it has HTML in it.

```sh
hud room artifact SLUG --title "Pricing model" --file model.html   # on the room's shelf; OPEN shows it in the HUD
hud room brief SLUG --file brief.html                              # the room's brief; OPEN THE BRIEF shows it
hud brief --title "Weekly: pricing" --file weekly.html             # a floor brief; the BRIEFS view shows the page
```

The HUD shows a page on the stage at full width (the whole screen on a phone) with **BACK** and **OPEN IN NEW TAB**, at its own address (`#page/rooms/SLUG/files/NAME`, `#page/rooms/SLUG/brief`, `#page/briefs/ID`), so markdown elsewhere can link to it. A shelf page loads the room's other files by name (`<img src="chart.png">` for `files/chart.png`); a room brief, which sits at the top of the room's folder, loads them as `files/NAME`; a floor brief carries its pictures inline (`data:` URLs). Scripts, styles and fonts may also come from https, so a page can use a chart library from a CDN.

A page can use React with JSX, the way an artifact does, with nothing to build: load React and Babel from a CDN and put the component in a `<script type="text/babel">`, inline (Babel cannot fetch a separate `.jsx` file from inside the sandbox). React 18 is the last version with these browser builds.

```html
<!doctype html>
<html>
<head>
  <title>Counter</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js"></script>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    function Counter() {
      const [n, setN] = React.useState(0);
      return <button onClick={() => setN(n + 1)}>Clicked {n} times</button>;
    }
    ReactDOM.createRoot(document.getElementById("root")).render(<Counter />);
  </script>
</body>
</html>
```

**Theme.** A page shows in the HUD's theme, light or dark (the HUD's own, or your screen's while it has none), the way an artifact does on claude.ai: the frame asks for `?theme=light` or `?theme=dark`, and the page's `<html>` gets `data-theme="light"` or `data-theme="dark"`, so a page styled with `:root[data-theme="dark"]` follows it, and follows a change at once. A page that has a dark look of its own (a `color-scheme` naming dark, a `prefers-color-scheme` query or a `data-theme` selector) also gets the matching `color-scheme`; one without keeps its own, so its text stays readable on the background it set.

**Versions.** A lane that uploads a file under a name already on the room's shelf (`hud room artifact SLUG --title T --file page.html` again) replaces it: the card stays one card and shows the newest, and the one it replaced is kept. So is every earlier brief of a room (`hud room brief`). The page's **VERSIONS** lists them, newest first; an older one opens read-only, at the page's own address with `?v=V` (`#page/rooms/SLUG/files/page.html?v=V`), under a line that says which version it is, with **SHOW LATEST**. An earlier brief that was markdown shows under **VERSIONS** in the room's brief pane. While you look at the newest, a new version replaces it in place. The versions live in the room's folder (`versions/files/NAME/` and `versions/brief/`, each file named after when it was written and by whom), the newest 20 of each; `hud room versions SLUG NAME` (or `--brief`) lists them. Your own uploads from the page keep both files (`image-2.png`), since two pasted pictures are often both called `image.png`. A file a lane writes straight into `files/` replaces the old one with no version kept: upload with `hud room artifact --file` to keep it.

#### What a page can keep: the page runtime

The HUD gives every page the runtime a Claude artifact gets, so a page written for an artifact runs unchanged. It goes in first, before the page's own scripts, as `window.hud` and, unless the page already has one, `window.claude`, each with one function: `use(name)` resolves a capability, or `null` where the page cannot use it (opened on its own in a tab, for example).

| `use(...)` | What the page gets |
| --- | --- |
| `"db"` | A database for this page, in the artifact db's shape: `db.doc("votes/owner")` and `db.collection("votes")`, with `get`, `set`, `update`, `delete`, `where`, `orderBy`, `limit`, `add` and `onSnapshot`, which hears every write live, from any view of the page. A document is a JSON object up to 256 KB; a page keeps up to 5000 documents and 10 MB. |
| `"user"` | Who is viewing: always the owner (`id()` is `"owner"`, `me().name` is `HUD_OWNER`, `isOwner()` and `canEdit()` are true). |
| `"downloads"` | `save({ filename, data })`: the HUD asks you (SAVE or NO) and saves the file. Programs and scripts (`.exe`, `.sh`, `.js` and the like) are refused. |
| `"artifact"`, `"room"`, `"comments"`, `"sample"`, anything else | `null`, for now. |

`localStorage` works too, synchronously: the page's stored keys come in the page itself and every change is sent back, up to 1 MB. `sessionStorage` lasts while the page is open. A page with `.mermaid` diagrams that does not load Mermaid itself gets them drawn (Mermaid 11.4.1 from jsdelivr).

What a page keeps is kept **per page** (`briefs/ID`, `rooms/SLUG/brief`, `rooms/SLUG/files/NAME`) on this machine, and is **shared by everyone who opens the HUD**: there is no per-viewer data, since every viewer is the owner. Secret values are blanked out before anything is kept. HQ and lanes read it back:

```sh
hud page data                        # every page that keeps anything
hud page data briefs/8               # its stored keys and every document
hud page data briefs/8 votes         # one collection
hud page data briefs/8 votes/owner   # one document
```

The page never talks to the server. It talks to the HUD page that shows it, which decides which page it is from the frame it sits in, never from what the page says, and answers only the page's own frame. `bun scripts/parity-lab/harness.ts` measures what a page can do next to a Claude artifact.

Pages run in a sandbox: the server sends each with `Content-Security-Policy: sandbox allow-scripts ...` without `allow-same-origin`, and the HUD shows it in an `<iframe sandbox>` without it too. The page gets an origin of its own: it cannot read the HUD's page, its data, its storage or its cookies, cannot send anything to the HUD's server (it may only connect to https; what it keeps goes through the runtime above), and cannot navigate the HUD. Secret values are masked in a page as they are in the agent drawer. As in an artifact, a click in a page may copy to the clipboard (`navigator.clipboard.writeText`) and take the page full screen (`requestFullscreen`): the frame allows `clipboard-write` and `fullscreen`, and nothing else.

## Changing a question in place

HQ keeps one question per thing by changing it instead of withdrawing and reposting it:

```sh
hud update ID [--title T] [--body B] [--opt A --opt B] [--rec A] [--link URL]   # only the fields given; the card shows EDITED hh:mm
hud comment ID TEXT                          # a timestamped line under the question (latest 5 shown, MORE for older)
hud ask --title T --item "Land #1234" --item "Write the notes"                  # a question with a checklist
hud item ID N done|undo                      # tick item N (from 1) by hand
hud item ID add TEXT                         # add an item to an open question
```

Your typed answer stays on the card through an edit; a picked option the edit removed is unpicked. Comments are information: they never reach HQ's inbox, cost no points and leave the question's timer alone. An item that names a PR (`#1234`, `owner/repo#1234` or a PR link) ticks itself when that PR merges. Its facts come from the work board's GitHub cache, on the board's own refresh, and only while the question is open. When every item is done the question closes itself with the answer "all done". If HQ ticked the last item, it is already acked. If a merge did, it waits in `hud inbox` and is not typed into HQ's session.

## Settings

SETTINGS (in MENU) picks your hero, the season and the hero's hat; SOUND turns the new-question chime on and off. These are saved on the server, in the data directory, so they survive a restart, a plugin update and clearing your browser's data, and every browser shows the same ones. The page keeps a copy only to draw the first frame before the server answers. The first time a page from 0.3.0 or later opens against a server with no settings, it sends up the settings that browser remembered.

## Images and files

Every send box (Tell HQ, each question's answer, a reply in MESSAGES, a room's send box) is one composer: attachments on top, the text field, then the attach button on the left and SEND on the right. The field grows with what you type, up to five lines. On a phone the attach button opens the phone's own menu: photo library, take a photo, or choose a file. On a computer it opens a file picker. Dropping images or files on a box, or anywhere on its panel or card (the TELL HQ panel, a question's card, the reply under a message, the TO row of a room's send box), attaches them to that box, which lights up while they are over it; pasting into a box works too. A drop anywhere else on the page does nothing (in a room, a drop outside the send box goes on the shelf).

Each image is shrunk in the browser before it is sent: its longest side to at most 2048 px, as JPEG (or WebP where the browser makes that smaller), so uploads are quick over a phone connection and an iPhone's HEIC photo arrives as a JPEG. A GIF, or an image already small and in PNG, JPEG, GIF or WebP, is sent as it is. 10 MB at most.

Other files go as they are, 25 MB at most each, and only these kinds: pdf, txt, md, csv, tsv, json, log, yaml, yml, xml, zip, gz, tar, docx, xlsx, pptx, mp4, mov, webm, mp3, wav, m4a. The kind is checked by the extension and the browser's file type on the page, and by the extension on the server; anything else (html, svg, scripts, programs, installers) is refused. A message carries 10 attachments at most.

Attached images show as thumbnails in the box and files as chips with their name and size, each with a small round × on its corner to remove it; tap a thumbnail to see it full screen, a file chip to open the file. The text you type stays clean. An attachment is dimmed under a spinner while it uploads; a failed upload gets a red ring and a retry icon (tap it to try again), and one that is refused says why in one line. When you send, each one's full path on the HUD's machine is added to the end of your text, `[image: /path]` for an image and `[file: /path]` for any other file, which is how HQ or a lane opens it; sent messages show a thumbnail or a link named after the file. Attachments are part of the draft: they stay through live updates and a reload of the page (the page keeps their paths, never their bytes), and are cleared once the message is sent.

Everything stays on this machine. Outside a room it is saved in the data directory's `uploads/`; in a room, in the room's `files/`, so it shows on the shelf. Each file keeps its own name (`name-2.ext` when the name is taken). Files are served sandboxed and never sniffed: images and video show in the browser, everything else downloads.

## Configuration

Set these in `config.env`. An empty value means the default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUD_HQ_AGENT` | `hq` | herdr agent name of your HQ lane. Answers and notes are typed into it. With floors, it is the first floor's HQ. |
| `HUD_FLOOR_NAME` | `HQ` | Name of the first floor, read once, when the first floor is made (its id is the name as a slug). |
| `HUD_HQ_HINT` | on | `0` leaves out the one-line "reply through the HUD" reminder after every message typed into HQ. |
| `HUD_HQ_BLOCKED` | on | `0` stops telling HQ when a lane's agent becomes blocked on a prompt in herdr (the page still shows it). |
| `HUD_HQ_GREET` | on | `0` stops the plugin typing the HQ guide into each new HQ session. |
| `HUD_OWNER` | empty | Your name: on the desk sign, on the default hero, and in the notes and answers HQ is sent. Empty means "the owner" (and "YOU" on the hero). |
| `HUD_PORT` | `4747` | Port the server listens on. |
| `HUD_HOST` | `127.0.0.1` | Address the server binds to. |
| `HUD_TRUSTED_ORIGINS` | empty | Extra page addresses that may use the page, comma-separated and exact, such as a phone reaching it through `tailscale serve` (`https://name.tailnet.ts.net:4747`). Every other site is refused. A listed address may also set and remove secrets (never read a value, except COPY). |
| `HUD_GITHUB_REPO` | empty | `owner/repo`, used to link lanes to pull requests. |
| `HUD_LINEAR_WORKSPACE` | empty | Linear workspace slug, used to link lanes to issues. |
| `HUD_LOCAL_MACHINE` | `local` | Name of this machine in the room. |
| `HUD_MACHINES` | this machine | Comma-separated herdr machine labels to poll for agents, sample for CPU and memory, and read subscription usage from (SUBS). Remote machines need SSH access. |
| `HERDR_BIN` | `herdr` on PATH | Path to the herdr binary. |
| `HUD_GH_BIN` | `gh` on PATH | Path to the GitHub CLI, used by the work board. |
| `HUD_DATA_DIR` | plugin state dir | Where the database, uploads and settings live. The plugin sets it; leave it empty. |

## Running without the herdr plugin

```sh
bun server.ts
```

Then open http://127.0.0.1:4747. Without the plugin the database and uploads live next to `server.ts` unless you set `HUD_DATA_DIR`. All the variables above work as plain environment variables, for example `HUD_HQ_AGENT=lead bun server.ts`.

Run the tests with `bun test`.

## Working on it

No build step: `public/index.html` is the page shell, `src/client/` the page as plain ES modules (one folder per area), `src/server/` the server (one file per concern, routes in `src/server/routes/`, one schema file per table in `src/server/schema/`). `AGENTS.md` has the map and the rules for working on it in parallel; `docs/structure.md` explains the layout and its trade-offs.
