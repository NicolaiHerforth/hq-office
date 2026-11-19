# SHIP (the MERGE tab)

Agents open PRs for the owner to merge. Asked through NEEDS YOU, sixty overnight bugfix PRs drown the questions only
he can answer, and nothing shows where his merging is what holds work up. SHIP is the place for them: the MERGE tab
beside NEEDS YOU. An agent ships (`hud ship`), the owner merges: the page and everything it says to the owner says
MERGE; the code, the routes, the table and `hud ship` keep "ship" inside. NEEDS YOU keeps decisions and the things
only the owner can do; a PR to merge never goes there again.

The page answers three questions at first look: what is ready to merge, what is urgent, and which agents are idle
until he merges. A domain is one row with one button (MERGE 7); a PR that is fine says nothing about itself; a PR
that is not his move shows why where the button would be. The design and its reasons are brief #211.

## The pieces

| | |
| --- | --- |
| `hud ship PR_URL [--lane L] [--note TEXT] [--urgent WHY]` | files a PR (HQ or a lane). The same PR again updates its item |
| `src/server/schema/ship.sql` | the table: one row per PR ever filed, unique on (repo, number) |
| `src/server/ship.ts` | the book, on a database and a clock: filing, the status machine, GitHub's facts, the sort's answers, the view |
| `src/server/ship-gh.ts` | GitHub through `gh` (`HUD_GH_BIN`): one GraphQL query for every open item, and `gh pr merge` |
| `src/server/ship-sort.ts` | the little sorter: one `HUD_SAMPLE_CMD` call per batch gives each new item a domain and an urgency |
| `src/server/ship-server.ts` | the server's book: when GitHub is read, when the sorter runs, merges, held presses, SEND BACK, telling the filer |
| `src/server/routes/ship.ts` | the routes |
| `src/client/ship/model.js` | pure: whose move a PR is and why, the groups and their order, the counts, who is idle until a merge, what is stuck. The server imports it too |
| `src/client/ship/index.js`, `ship.css` | the MERGE tab |
| `test/fake-gh-world.ts` | a stub `gh` that answers from a JSON world and records every call. No test calls the real `gh` |

## The item

Status machine (`FROM` in ship.ts):

| status | means | leaves by |
| --- | --- | --- |
| `open` | in SHIP (it may carry a hold: a press the owner can still UNDO) | merged, closed, sent back |
| `merged` | merged on GitHub (from SHIP or by anyone) | filed again → open |
| `closed` | closed on GitHub without a merge | filed again → open |
| `sent_back` | the owner sent it back with a note | filed again → open |

Filing a PR that has a row sets it open again and replaces lane, filer, note and urgent WHY with the new call's
(a missing flag keeps the old value while the item is open, and clears it when it was ended). The sort's domain and
urgency stay unless the item was ended, in which case it is sorted again.

`S.ship`, the state part (built only after a write to the ship table, or a change of the secrets a note is masked with):

```js
{
  sampler: true,            // HUD_SAMPLE_CMD is set: new items are sorted by the model
  items: [{                 // open items only, every floor
    id, floor, repo: "owner/name", number, url,
    lane,                   // whose work it is: --lane, or the lane that filed it; null for HQ's own
    filer,                  // who ran hud ship: a lane's name, or null for HQ (what it is told goes there)
    note,                   // the filer's note, markdown, secrets masked
    at,                     // first filed (how long it has waited), kept across updates while open
    domain,                 // the sorter's label, or null until sorted (shown as the repo's name)
    urgency,                // "URGENT" | "NORMAL" | "LOW": URGENT whenever urgentWhy is set
    why,                    // one line for URGENT: the filer's --urgent WHY, else the sorter's
    sorted,                 // false until the sorter (or its fallback) has run on it
    gh: null | {            // what GitHub said at the last read that changed something
      state: "OPEN" | "MERGED" | "CLOSED", title, branch, base, sha, draft,
      checks: "passing" | "pending" | "failing" | "none",
      review: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null,
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN",
      mergeState: "CLEAN" | "HAS_HOOKS" | "UNSTABLE" | "BEHIND" | "BLOCKED" | "DIRTY" | "DRAFT" | "UNKNOWN",
      additions, deletions, files,
      methods: ["squash", "merge", "rebase"],   // the repo's allowed ones, in that order
      autoMergeAllowed,     // the repo allows auto-merge
      autoMerge,            // auto-merge is on for this PR (MERGE WHEN GREEN was pressed, here or on GitHub)
    },
    ghError,                // why GitHub could not be read for it, in words, or null
    mergeError,             // why the last merge failed, in the owner's words, or null; cleared when the head moves
    hold: null | {          // a press the owner can still take back (UNDO), held by the server
      verb: "merge" | "auto" | "back",
      until,                // when it runs (ms); past it, it is running and can no longer be undone
      note,                 // SEND BACK's note, masked; null for the others
    },
  }],
  done: [{                  // what left SHIP in the last 24 hours by a merge or a SEND BACK, newest first, every floor
    id, floor, repo, number, url, lane,
    title,                  // GitHub's title at the last read, masked; null if it was never read
    how: "merged" | "self" | "back",  // merged: the owner merged it from the page; self: merged on GitHub (auto-merge, or by hand there); back: sent back
    at,                     // when it left
    note,                   // what the owner wrote, for "back"; null otherwise
  }],
}
```

DONE is built when the ship table changes, so it can hold an entry a little older than 24 hours until the next
change: the page shows only what left in the last 24 hours by its own clock. A PR closed on GitHub is not in DONE.
How it left is the row's `ended_how`: `merged` when the page's merge ran (at once, or a held MERGE), and also when GitHub
says merged while a MERGE was held (the run was cut off after gh merged it: see the hold); `self` when GitHub merged it
otherwise (auto-merge finished, or someone merged it there); `back`; `closed`. Filing the PR again clears it.

`verdict(item)` in model.js is the one answer to "whose move is it": `{ can, pile, why, tone, move }`.

| pile | can | means | the page |
| --- | --- | --- | --- |
| `ready` | `merge` | its checks passed and nothing stops it | merges with its group's MERGE N, or by one press with UNDO |
| `check` | `check` | it can merge, but no checks ran on it | CHECK THESE YOURSELF: its own button, which asks first; never with a group |
| `wait` | `auto` | checks running, the repo allows auto-merge | MERGE WHEN CHECKS PASS (one press, UNDO) |
| `wait` | `queued` | auto-merge is on | "merges by itself" |
| `wait` | `no` | someone else has the next move | `why` stands where the button would be; no button |

`why` is a few words ("checks failing", "conflicts with main"); `tone` is ok, wait (amber), bad (red: the PR has to
change) or neutral; `move` is whose move it is: owner, lane (whoever filed it), review, checks, github, or null. The
server runs the same function on facts it has just read before it merges anything.

It denies by default. `ready` needs state OPEN, mergeable MERGEABLE and checks passing (`check` the same with checks
none), and nothing else stopping it. A fact `verdict` reads that GitHub left out, or gave as a value not listed in
`gh` above (checks missing, mergeable null, a mergeState GitHub added later, no methods list), makes the PR `wait`,
`no`, move github, why "unclear from GitHub: " and the fact in words ("its checks", "whether it can merge"). No
merge, group, one press, hold or MERGE WHEN CHECKS PASS runs on a guess.

Stuck, nobody moving (`stuckOn`, `stuck`): a `wait` PR whose `move` is lane while that lane is idle on the page, or
whose `move` is review (the page cannot see a review under way, and in a one-owner outfit the reviewer is usually the
owner). The top of the tab names them beside "Idle until you merge", each name a jump to those PRs, and while any is
stuck it says NOTHING TO MERGE, never NOTHING HERE WAITS ON YOU.

## GitHub

- Read through `gh` on this machine, the owner's login: `gh api graphql -f query=…`, one query for every open item
  (an alias per repo, one per PR inside it). The body and changed paths are asked only for items not yet sorted.
- When: 2 s after a filing (filings in that window share the read), when a page opens SHIP (at most every 30 s), right
  before a merge (only the PRs being merged), and every 5 minutes while SHIP has open items. Nothing when it is empty.
- A PR GitHub says is merged or closed leaves SHIP by itself.
- A read that finds nothing new writes nothing and pushes nothing to the pages, so a quiet SHIP of 60 PRs costs one
  `gh` call every 5 minutes and no push. `S.shipRead` (when GitHub was last read) is built on every push, so the page's
  "GITHUB READ N MIN AGO" is when GitHub was last read as of the last push: it can lag a quiet read until something
  else is pushed.
- Merging: `gh pr merge N --repo R --squash|--merge|--rebase --match-head-commit SHA [--auto]`, with the first method the
  repo allows of squash, merge, rebase. Never `--delete-branch`, never `--admin`. Nothing dispatches, re-runs or
  triggers CI.
- `HUD_GH_BIN` swaps the binary. The test preload sets it to `false` for every test, so no test can reach the real `gh`.

## The sorter

Items not yet sorted are batched: the sorter runs `HUD_SHIP_SORT_MS` (30 s) after the last filing, once, for all of
them. It runs `HUD_SAMPLE_CMD` with `HUD_SAMPLE_TIER=quick`, with each PR's repo, title, body's first lines, branch and
changed paths, and the domains already in use (so domains stay stable). Secret values are masked in the prompt. It
asks for JSON: `[{ "id", "domain", "urgency", "why" }]`. Without `HUD_SAMPLE_CMD`, or when the call fails or answers
nonsense, the domain is the repo's name and the urgency NORMAL. `--urgent WHY` is URGENT whatever the model says.
The command runs in a process group of its own; after 2 minutes (`HUD_SHIP_SORT_TIMEOUT_MS`) the group is killed and
its output no longer read, so a child that keeps the output open cannot stop the next batch from being sorted.

## Who may do what

- `hud ship` (HQ or a lane): file and update. A lane's PR is its lane's; HQ names a lane with `--lane`.
- `hud ask` whose title asks for a merge (a word starting with `merg`), that links a GitHub PR in its title or body and
  carries nothing else for the owner to answer (no `--opt`, no `--item`, no `--file`, no `--secret`, no body that is a
  page) files each linked PR in SHIP instead, with the ask's title and body as the note, and says so in its reply. No
  ask is made. Every other ask stays an ask in NEEDS YOU, untouched: "Roll back or hotfix?" with options, about a PR
  that merged, is a decision, and so is "Should I merge #12 or #13?" with options.
- MERGE, MERGE WHEN CHECKS PASS, a group's MERGE N, UNDO and SEND BACK: only the owner, only from the HUD's page. The route refuses a
  request with no Origin, with a herdr pane (`x-hud-pane`), or whose `Sec-Fetch-Site` is not same-origin. As with a
  permit's "Allow this once", a lane runs as the same user as the HUD, so this is not a sandbox: it stops `hud`, not a
  process that forges a browser's headers.
- The page sends the head SHA it showed. A PR pushed to since then is not merged: the item says so in his words
  ("Not merged: new commits came in while it waited here, and a merge only takes what this page showed you.", `MOVED`
  in ship-gh.ts; nobody is named, since we cannot tell who pushed) and its checks run again, so it is no longer his
  move.
- A merge `gh` refuses is kept on the item in his words (`refusalWords` in ship-gh.ts): a moved head, a conflict, a
  review required, required checks, the branch's rules, auto-merge not allowed, a method no longer allowed, checks not
  passing, not mergeable. Anything else is "Not merged: GitHub said: " and GitHub's own first line.
- While a merge runs on a PR (from its read to gh's answer), SEND BACK, a hold and another merge on it are refused
  ("it is being merged now: wait for it to finish"). What gh answers is recorded whatever the row says by then: a read
  that found the PR merged meanwhile took it for GitHub's own, and gh's answer makes it the owner's merge (DONE says
  merged, the filer is told once). A PR in a group that fails does not stop the group's next PR.
- The page says what each merge request is: `kind: "group"` (a group's MERGE N, whatever its size) or `kind: "one"`
  (one PR's own button, one PR only). A kind left out or not known is a group. A group never merges a PR on the
  `check` pile, a group of one included: those merge only by `kind: "one"`, after the page has asked. In a group that
  PR answers "no checks ran on it: it merges only by its own button" and the rest merge. `kind: "one"` with more than
  one PR is refused ("one press merges one PR: this asked for N"). The verdict each press needs is `ALLOWS` in
  ship.ts: a group `merge`, one PR `merge` or `check`, MERGE WHEN CHECKS PASS `auto`; a held MERGE `merge` only (a PR
  with no checks is not held: the page asks).

## UNDO: the hold

One press on one PR (MERGE, MERGE WHEN CHECKS PASS, SEND BACK) is held by the server for 5 seconds
(`HUD_SHIP_HOLD_MS`) before it runs; UNDO cancels it. The hold is on the row (`hold_verb`, `hold_until`, `hold_sha`,
`hold_note`), so it is in S.ship: a page that is closed or reloaded in those 5 seconds neither loses the press nor
runs it twice, and a reloaded page shows UNDO with the time left. A server restarted with a hold on a row runs it once
it is due, unless it was due more than 30 s (`HUD_SHIP_LATE_MS`) before the server started: the owner pressed it to
happen then, not minutes later. Such a hold is dropped: GitHub is read for the PR first (a merge gh made before the
server died still counts as his), the PR stays in MERGE, the log has it, and its `mergeError` says the press was not
made because the HUD was down ("Not merged: the HUD was down when this merge was due, so it was not made. …"). When it is due the hold runs as the same merge or SEND BACK as before: GitHub is read for it, the head
SHA the page showed is checked then, and the merge is the same `gh pr merge … --match-head-commit SHA`. Once it runs
there is no undo; UNDO then answers why ("it is merging now: a merge cannot be taken back"). A group and an
unchecked PR ask first in the page, so they are not held.

UNDO takes MERGE's place under the pointer. So the second click of a double click, or the second tap of a double tap,
does not land on it: what takes a button's place in the page (UNDO, MERGE after UNDO, a confirm that opened under the
pointer, the list under a confirm a press closed) takes no press for its first 600 ms, past the 500 ms double-click
time macOS and Windows use by default.

- The time left is counted from the server's clock, never the device's, which may be off by minutes. `S.shipNow` is
  the server's `Date.now()` while any open item has a hold, and null otherwise; it is built on every push, but a part
  goes to a page only when it changes, so a SHIP with no hold pushes nothing for it. The hold's and UNDO's answers
  carry `now` too. The page computes UNDO's time left as `hold.until − N + (time elapsed since it received N)`, where
  N is the `shipNow` or the hold answer's `now` it received last, timed with its own monotonic clock
  (`performance.now()`).
- Timing: one timer, for the earliest hold due, armed only while a hold exists and no hold is running; a SHIP with no
  hold runs none. Holds due together run one after another.
- A hold runs once. In-process, one run at a time takes every hold due, and each leaves the row (merged, sent back, or
  its hold cleared) whatever happens. Across a restart, the row still holds the press, so it runs again: the GitHub read
  it starts with finds a merge that went through before the server died, the PR leaves as merged (`ended_how`
  merged, its filer told), and `gh pr merge` is not run again.
- While a PR is held, MERGE at once and SEND BACK at once on it are refused ("it is held: UNDO it, or let it run").
- UNDO's answers, each with the server's `now`: `{ undone: true }` before the time; after it, by the held verb: "it is merging now: a merge cannot be
  taken back", "auto-merge is being turned on now: turn it off on GitHub if it must not merge", "it is going back now:
  the note is on its way"; once the PR has left: "it is merged already: a merge cannot be taken back", "it was sent back
  already", "it was closed on GitHub"; and "nothing to undo: it was not held".
- A held press that is refused when it runs (the head moved, the checks failed meanwhile) leaves the PR in SHIP with
  no hold; a moved head or gh's refusal is its `mergeError`, the rest its verdict says.

## What the page promises

- MERGE N's confirm keeps what it listed when it opened, each with the head SHA it showed. MERGE N merges what is
  ticked, still ready and at that head, sending that SHA. A PR that turns ready while it is open shows unticked and
  marked NEW; one whose head moved is left out (NEW COMMITS · LEFT OUT). Another floor or SHOW ALL closes it. An
  unchecked PR's own confirm keeps its head the same way. A merge request says `kind: "group"` or `"one"`.
- While he aims (the pointer moving over the list, or a touch or a key in it under 1.5 s ago) a push changes what a row
  says, not where it stands: no row is reordered, added or removed, none gets shorter, and the row under the pointer
  stays put when one above it grows. The new order comes when the pointer leaves the list or rests for 1.5 s; a row or
  group head that moves then takes no press for 600 ms. The list and the confirm change in place
  (`src/client/ship/morph.js`), so a press begun before a push lands and a focused field keeps its selection and
  composition.
- The top, the tab's count and each MERGE N leave out what is held or running, and the top says it apart
  ("READY TO MERGE · 1 merging").
- UNDO's time left is the hold's until minus the server's now (S.shipNow, or `now` in the hold's and UNDO's answers)
  plus the time since it came; past it the row says MERGING · CAN'T BE UNDONE (SENDING BACK · CAN'T BE UNDONE,
  AUTO-MERGE GOING ON · TURN IT OFF ON GITHUB).
- A press the server refused says "Not done: WHY". One whose answer was lost (the network, 10 s without a reply for a
  hold, a reply that is not the server's) says "May have gone through: looking again.", reads the server's state and
  shows what happened.

## What the filer hears

Through ask-routing's lane outbox (kept while the lane is away or busy, its HQ's when the lane is gone), or its HQ:

- `HUD SHIP: merged REPO#N (TITLE)` after a merge from SHIP, including a MERGE WHEN CHECKS PASS that GitHub finished
  later.
- MESSAGES gets one line per press: `MERGE: merged REPO#N (TITLE)` for one PR, `MERGE: merged N in DOMAIN` (the PRs
  listed in its body as links) for a group, `MERGE: merged N PRs` when the group's PRs are in more than one domain.
  Only what merged counts: a group of three with one refused is "merged 2", and a group where one merged is that PR's
  own line. On the lane when all share one, on the first PR's floor. Read already when the owner pressed it; unread
  when GitHub finished a MERGE WHEN CHECKS PASS later.
- `HUD SHIP: sent back REPO#N: NOTE` after SEND BACK. The item leaves SHIP until it is filed again.
- Both go through ask-routing's lane outbox with the reference `ship:ID`. Unlike an answer, nothing settles it: it is
  typed once the lane can take it, with no "ack it" line.

## Routes

| | |
| --- | --- |
| `POST /api/ship` `{ url, lane?, note?, urgent? }` | file (HQ or a lane): `{ id, repo, number, floor, updated }`. `updated` is true when the PR was in SHIP already |
| `POST /api/ship/look` | a page opened SHIP: `{ reading }`, false when SHIP is empty or the last look was under 30 s ago |
| `POST /api/ship/merge` `{ kind: "group" \| "one", items: [{ id, sha, auto? }] }` | owner only, at once: `kind` "group" is a group's MERGE N (ready PRs only, a group of one too), "one" one PR's own button (one unchecked PR after the page asked); left out or unknown, a group. `{ results: [{ id, ok, error?, merged?, queued? }] }` in the order asked, merged one at a time after one read. A held PR answers "it is held: UNDO it, or let it run"; "one" with more than one item is refused |
| `POST /api/ship/ID/hold` `{ verb: "merge" \| "auto" \| "back", sha, note? }` | owner only: hold one press for 5 s, `{ until, now }` (`now`: the server's clock, for UNDO's time left). Refused when the item's verdict does not allow the verb now, or it is held already for another verb (the same verb again answers the same `until`) |
| `POST /api/ship/ID/undo` | owner only: `{ undone: true, now }`, or `{ undone: false, why, now }` when it already ran or was never held |
| `POST /api/ship/ID/back` `{ note }` | owner only, at once; the note is required |

A merge refused before `gh` runs (the head moved, checks failing, anything `verdict` says no to) answers its reason in
`results`. Only a moved head and a failure `gh` reports are kept on the item as `mergeError`: the rest the item's
verdict already says.
