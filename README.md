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

The database and uploaded images live in the plugin's state directory, so they survive reinstalls.

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

HQ uses the CLI in `hud.ts` (the `hud` command after the install hud command action, or `bun hud.ts` from the plugin directory with `HUD_URL` set if you changed the port) to add lanes, ask questions and wait for your answers. HQ posts progress to the **FROM HQ** tab with `hud tell --title "PR is up" [--body "details"] [--lane NAME]` (`hud say` is the same command); the tab counts unread updates until you open them or mark them all read. `hud guide` prints how HQ should reach you.

## Who needs you, and one lane in focus

Only a lane with an open question for you (`hud ask --lane L`) carries a speech bubble: a red one with a white "!", over a red glow, its name on red, standing in the queue at your desk. A lane waiting on HQ stands beside HQ with no bubble; one waiting on CI, parked or done shows a small mark of its own. At a desk means working.

Click or tap a worker to put its lane in focus. The top of the question column then shows the lane (its status, role, issue, PR and projects), and the QUESTIONS, MESSAGES and WORK tabs show only that lane: its open questions, answered there as anywhere else; its messages (HQ's updates about it, what happened to it, such as questions asked and answered, and your replies), from `/api/lanes/stream`; and its tracked work. In the room everyone else steps back and the lane stands in a yellow ring. CLEAR, Esc or a click on the empty floor shows everyone again. On a phone, a tap in the room goes up to the column.

HQ says what a lane is, so the room shows it:

```sh
hud lane NAME --role pm                                      # orchestrator, pm, builder or walker; --role "" clears it
hud lane NAME --project "Deploy gate=https://linear.app/acme/project/deploy-gate-1a2b3c4d"   # repeat --project for more
hud lane NAME --project https://linear.app/acme/project/deploy-gate-1a2b3c4d                 # a bare link names itself
hud lane NAME --project none                                 # no projects
```

An orchestrator wears a headset and its name tag is gold; a PM carries a clipboard and its tag is purple; a builder wears a hard hat; a walker carries a magnifying glass and its tag is teal. A lane with a role wears no season's hat or hand item. The projects are links at the top of the column while the lane is in focus. A list of projects replaces the old one; a flag left out leaves its value as it is.

## Secrets

Paste a key into the SECRETS tab (under the room) with a name and a lifetime in minutes, or into the fields of a question HQ asked with `hud ask --secret NAME`. HQ reads it until it expires:

```sh
hud secret get NAME | <command>          # the raw value, to a pipe only; refuses a terminal
hud secret get NAME --once | <command>   # and delete it on read
<command> | hud secret set NAME --minutes 30   # the value comes from stdin, never an argument
hud secret rm NAME
hud secret list                          # names, who set them, when they expire
```

Values live in the server's memory only: never in the database, the log, `/api/state` or any listing, and a restart clears them all. The deadline is checked on every read. Secret routes answer only to this machine, the read route only to a client that is not a browser, and any request from another web origin is refused.

## The work board

The WORK tab lists every piece of work in flight: an issue key, its pull requests and the lane that owns it. HQ adds one with `hud track ISSUE --lane L --pr N`, and `hud lane NAME --issue X --pr N` links a lane's work too. Each item's state is worked out from facts, in this order: done (all PRs merged or closed, or `hud done ISSUE`), waiting on you (an open question names its lane, issue or PR), waiting on CI (a check is running), paused (`hud pause ISSUE REASON`, undone with `hud resume ISSUE`), moving (the lane is working, or something changed in the last 45 minutes), and otherwise stalled. Stalled work shows red at the top of the question column and at the top of `hud board` (`--json` for JSON).

PR facts come from the `gh` CLI. The server caches them and refreshes them every 10 minutes while anything is open, and when HQ runs `hud board` if the cache is over a minute old. Page loads never call GitHub.

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

SETTINGS in the top bar picks your hero, the season and the hero's hat; SOUND next to it turns the new-question chime on and off. These are saved on the server, in the data directory, so they survive a restart, a plugin update and clearing your browser's data, and every browser shows the same ones. The page keeps a copy only to draw the first frame before the server answers. The first time a page from 0.3.0 or later opens against a server with no settings, it sends up the settings that browser remembered.

## Images

Drop or paste an image into any text box on the page. It is saved in the data directory and its path is put into the text, so HQ can open it.

## Configuration

Set these in `config.env`. An empty value means the default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HUD_HQ_AGENT` | `hq` | herdr agent name of your HQ lane. Answers and notes are typed into it. |
| `HUD_HQ_HINT` | on | `0` leaves out the one-line "reply through the HUD" reminder after every message typed into HQ. |
| `HUD_HQ_GREET` | on | `0` stops the plugin typing the HQ guide into each new HQ session. |
| `HUD_OWNER` | empty | Your name: on the desk sign, on the default hero, and in the notes and answers HQ is sent. Empty means "the owner" (and "YOU" on the hero). |
| `HUD_PORT` | `4747` | Port the server listens on. |
| `HUD_HOST` | `127.0.0.1` | Address the server binds to. |
| `HUD_TRUSTED_ORIGINS` | empty | Extra page addresses that may use the page, comma-separated and exact, such as a phone reaching it through `tailscale serve` (`https://name.tailnet.ts.net:4747`). Every other site is refused, and secrets stay this machine's own page only. |
| `HUD_GITHUB_REPO` | empty | `owner/repo`, used to link lanes to pull requests. |
| `HUD_LINEAR_WORKSPACE` | empty | Linear workspace slug, used to link lanes to issues. |
| `HUD_LOCAL_MACHINE` | `local` | Name of this machine in the room. |
| `HUD_MACHINES` | this machine | Comma-separated herdr machine labels to poll for agents and sample for CPU and memory. Remote machines need SSH access. |
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
