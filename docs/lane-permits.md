# Lane permits

A lane is an agent nobody watches. A permission prompt in its pane is a question no person will see: the lane stops
until someone finds it. Lane permits remove the wait. Every lane starts with one settings file, whose hook answers
each prompt through the HUD: refused, at once, with a line that tells the lane to go another way or tell HQ. When a
lane truly needs the action, HQ puts the exact request in front of the owner on the HUD, and the owner's tap allows
that one request once.

Nobody presses a key in a pane, and no agent says yes for the owner. HQ carries the question and "try again", never
the yes.

## The pieces

| | |
| --- | --- |
| `hud lane-settings` | prints the path of the lane settings file, written first if it is missing or different |
| `src/server/lane-settings.ts` | what the file says: the hook on four events, `HUD_LANE_HOOK=1`, and a deny rule for pages on claude.ai |
| `bin/lane-hook.ts` | the hook: asks the HUD, prints its decision; refuses when the HUD cannot be asked. Lanes run a copy of it in the data folder |
| `src/server/permits.ts` | the permit book on a database and a clock: the key, one row per exact request, allowed once |
| `src/client/permits/permits.css` | the code box of a permit question wraps |
| `src/server/lane-permits.ts` | the server's book: what the hook is answered, HQ's question, the owner's answer, the log |
| `hud permit` | HQ's side: `list`, `show ID`, `ask ID [--why TEXT]` |

A lane is started with the file. Nothing is written to `~/.claude/settings.json` or any other shared settings; the
lane still has whatever those already say, plus this file:

```sh
herdr agent start NAME --kind claude --pane P -- --settings "$(hud lane-settings)"
```

## What happens

1. A lane's call would raise a prompt. Claude Code runs the hook (`PermissionRequest`) instead of showing it. The
   hook asks the HUD, which records the request as a permit and answers no:
   `nobody answers prompts in this pane; do it another way, or tell HQ what you need. This exact request is permit #7 (HQ: hud permit ask 7)`.
   The lane reads that as the tool's error and keeps working.
2. Usually that is the end: the lane does it another way.
3. If it needs that action, it tells HQ. HQ runs `hud permit ask 7`. A question appears in NEEDS YOU: "Allow this
   once?", the lane, the tool, the folder, the mode, and the exact command in a code box that wraps, so no part of it
   is off the side, with **Allow this once** and **No**. The body is built from the permit, never from HQ's words.
   `--why TEXT` adds one comment under it, marked as HQ's.
4. The owner presses. The HUD stores the allow on the permit and types into the lane's pane:
   `HUD permit #7: allowed once by OWNER. Retry the exact same call now (...)`, with any words the owner added.
5. The lane retries. The hook asks again, the HUD finds the allow for that exact request, lets it through and uses it
   up. The next identical call is refused again, as a new permit.

An allow lasts an hour. A lane that is refused the same request again while its refusal is fresh keeps its permit
number (the row counts the tries), so HQ asks once.

## This exact request: the key

Claude Code gives a hook no request id, and a retry is a new tool call. What says "the same request" is a hash of:

- the lane;
- the tool;
- the folder the call runs in;
- the tool's input without its labels. The labels are: for `Bash`, `description` and `timeout`; for `WebFetch` and
  `Artifact`, `prompt`; for any other built-in tool, `description`; for an MCP tool, nothing.

Not the whole input. The model writes a new `description` for the same Bash command on every try, and a new `prompt`
for the same fetch, so a hash of everything would never match a retry. Everything else counts: a Bash call that asks
to run outside the sandbox or in the background is another request than one that does not, what an `Artifact` call
publishes is part of it, and for an `Agent` call the `prompt` is what the call does. Nobody here knows which fields of
an MCP tool are labels, so all of them count.

The question shows what the key covers: the lane, the tool, the folder, how a command is run ("outside the sandbox"),
and the command, the address or the input's fields in the code box. So the owner's yes cannot land on something the
card did not show. If the lane changes the command, or runs it from another folder, the allow does not apply. The card
also shows the permission mode and whether auto mode's own check blocked the call; those are not in the key.

## Whose yes it is

- The question's body is the request as recorded, and the permit keeps it as it was raised. A question that was edited
  afterwards (`hud update`) cannot allow anything: the answer is refused and says so. HQ withdraws it and asks again.
- "Allow this once" counts only from the HUD's page. The answer route refuses a permit question's answer from a
  caller that names a herdr pane, and from one that is not a browser page (no `Origin`).
- A lane cannot raise the question for its own permit; it tells HQ.
- Only a registered lane can use an allow. A request from an HQ's pane, or from a pane the HUD does not know as a
  lane, is recorded and refused, told that nothing can be allowed there, and cannot be asked for: the file is for
  lanes.
- Every allow and every use is an event in the log, on the lane.

What this does not stop: a lane runs as the same user as the HUD. It can read and write the HUD's database and send
any request a browser can. Permits keep an honest lane from waiting and make the owner's yes exact; they are not a
wall against a lane that sets out to get around them.

## What cannot be allowed

- **Reading a page on claude.ai** (an `Artifact` read, or a fetch of it). Claude Code throws away a hook's allow for a
  page made outside the organization ("only the user's own approval allows this read"). The settings file refuses
  those reads outright (`WebFetch(domain:claude.ai)`), the hook's refusal says to get the page as a file, and
  `hud permit ask` refuses. Publishing to claude.ai is not reading it, and can be asked for.
- **A prompt the hook never answered** (kind `stuck`). Claude Code's `Notification` of a permission prompt means one
  is showing in the pane. The HUD records it and logs an event on the lane; there is no request to allow. Restarting
  the lane drops the call.
- **An input with nothing to show**: a command with no command, an input over 100,000 characters.
- **A new git repository root.** Claude Code holds hooks back until the workspace-trust dialog is accepted, so no hook
  can refuse that dialog. Start lanes in folders that are already trusted.

## Classifier blocks: one allow, one door (the trials)

In auto mode, a call the classifier judges dangerous is not a prompt: it is blocked, and Claude Code raises
`PermissionDenied`, not `PermissionRequest`. So an allow stored for it would never be asked for on the retry.

Tried on 13 Nov 2026 with Claude Code 2.1.322, in scratch sessions started with their own `--settings` file, no key
pressed: does a `PreToolUse` hook that answers `permissionDecision: "allow"` for the exact command skip the classifier?

| Call | Hooks | What happened |
| --- | --- | --- |
| a command an auto-mode rule blocks | none allows | blocked, `PermissionDenied` |
| the same kind of command | `PreToolUse` allows it | **ran**; no `PermissionDenied`, no prompt (twice) |
| the third block in a row, which becomes a prompt | `PreToolUse` allows it | **ran**; no `PermissionRequest` |
| `rm -rf "$(echo dir)"` (the delete-safety prompt) | `PreToolUse` allows, `PermissionRequest` denies | **refused**: `PermissionRequest` still fires, in the same second |
| the same | both allow | ran, "Allowed by PermissionRequest hook" |
| a blocked command | `PermissionDenied` answers `retry: true`, then `PreToolUse` allows | the model retried by itself, and the retry **ran** |

Also seen: a call let through by `PreToolUse` does not reset auto mode's count of blocks in a row.

So yes, and the settings file has the hook on `PreToolUse` too. What follows from the table:

- **An allow is used at one door, and the permit's kind says which.** A request a prompt stopped (`prompt`) is let
  through where the prompt comes again, at `PermissionRequest`; `PreToolUse` says nothing for it. A request the
  classifier blocked (`classifier`) is let through at `PreToolUse`, before the classifier. No allow passes both, so a
  second identical call, however soon, finds nothing.
- **The fallback prompt comes and goes.** After three blocks in a row auto mode prompts instead of blocking, so the
  same call can be a `prompt` when it is refused and a classifier block when it is retried. Then the HUD turns the
  allowed permit into a `classifier` one and the hook answers `PermissionDenied` with `retry: true`: the lane tries
  again, and that try passes at `PreToolUse`.
- **Classifier blocks can be asked for.** They are permits of kind `classifier`, and the question says auto mode's
  safety check blocked the call. The lane is not told a permit number for a block (a `PermissionDenied` hook can only
  say "you may retry"), so HQ finds it with `hud permit list`.
- **The cost per tool call is one file test.** `PreToolUse` runs on every tool call. Its command first tests for a
  marker file in the data folder; without it no process starts. The server puts the marker there when the owner
  allows something and takes it away the next time a hook asks after the allow was used or ran out. While the marker
  is there every lane's tool calls start the hook, also if the HUD is down; with the HUD down the hook gives no
  decision and the normal flow goes on.

## When the HUD cannot be asked

`PermissionRequest` always ends with a decision. HUD down, slower than 2 seconds, an error, an answer that is not a
decision, input the hook cannot read: the hook refuses with
`the HUD could not be asked; nobody answers prompts in this pane; do it another way, or tell HQ what you need`.

A session reads its settings once, when it starts. So the settings file and the hook it runs are both in the HUD's
data folder: `lane-settings.json`, and `lane-hook.ts`, a copy of `bin/lane-hook.ts` that the server refreshes at
every start. A plugin update that moves the plugin's code leaves a running lane's hook where it was, and the lane
gets the new hook on its next call. The command names the Bun that ran the server; if that file is gone when a hook
runs, the `bun` on PATH runs it. If the HUD moves to another port, running lanes keep asking the old address and are
refused ("the HUD could not be asked") until they are restarted with the file. A lane started without the file has no
hook: restart it with the file.

## Limits

- Lanes on another machine are not covered: the file and the marker are on the HUD's machine.
- A held secret in a tool's input is masked before the permit is stored (as it is usually written, like everywhere
  in the HUD), and the key is of the masked text. A secret set after a request was recorded makes the retry a new
  request.
- Run from a checkout with no `HUD_DATA_DIR`, the data folder is the checkout, so the settings file, the hook's copy
  and the marker are written there.
