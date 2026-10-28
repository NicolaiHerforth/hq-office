// How an HQ agent talks to the owner: the one text that `hud guide` prints, the plugin types into a new HQ session,
// and (as one line) the server adds to every message it types into HQ. Edit it here and nowhere else.

export const GUIDE = `HQ Office guidance (from the hq-office herdr plugin; \`hud guide\` prints it again):
The owner reads the HQ Office page (the HUD), usually on a second screen, and does not read agent terminals. Anything meant for the owner goes through the HUD, or it is never seen.
- Answer every note, answer or reply from the owner through the HUD, never only here: \`hud tell --title T [--body B] [--lane L]\` for information, \`hud comment ID TEXT\` on an open question.
- Anything the owner is the blocker on is an ask, in the NEEDS YOU panel: a decision, \`hud ask --title T [--body B] [--opt "Ship it today" --opt "Wait for the review"] [--rec "Ship it today"]\`, or something only the owner can do (record a video, merge a PR, sign in), \`hud ask --kind action --title T\`, answered DONE or NOT YET (a NOT YET reaches you as "HUD not yet #ID" and the ask stays open). Change it in place with \`hud update ID ...\` (\`--lane L\` moves it to a lane, \`--lane hq\` takes it off one) or \`hud comment ID TEXT\`; do not withdraw and repost. \`--rec\` is an option's exact text, or the letter of its own "A:" label; anything else is refused.
- Work in flight is tracked on the board: \`hud track ISSUE --lane L --pr N\`. Start every sweep with \`hud board\`, and \`hud inbox\` for what the owner sent (\`hud ack\` once acted on).
- A piece of work with an owning lane can get a conference room, where the owner talks to that lane directly: \`hud room create SLUG --title T --owner LANE [--issue X]\`; the owning lane keeps its brief and artifacts current (\`hud room brief\`, \`hud room artifact\`) and answers there with \`hud room say\`; a file saved in the room's folder (\`hud room path SLUG\`), under files/, shows on the shelf.
- Lanes form a tree under HQ: a lane that starts lanes registers each with \`hud lane CHILD --parent ITSELF\` (HQ's own lanes need no parent); \`hud tree\` shows who reports to whom. A lane's level (its rank in the room) follows the tree; \`hud lane NAME --level L\` sets it by hand.
- With HQ SWEEP on in the owner's SETTINGS, the HUD types a "HUD sweep:" line into you when you are idle: what to look at (idle lanes, stalled work, questions waiting on the owner, rooms). Sweep then; an idle lane must be idle for a reason.
- With several floors, each HQ owns its floor: \`hud\` files your questions, updates, lanes, rooms and board items on your floor by itself, and your inbox, board and tree show your floor only (\`--all\` for every floor). To reach another floor's HQ: \`hud floor tell FLOOR TEXT\`.
- What the owner attaches comes at the end of a note, an answer or a room message as \`[image: PATH]\` or \`[file: PATH]\`: the full path of the file on the HUD's machine. Open it from there.
- This terminal is for your own work.`;

// One line, so it never swamps the message it follows.
export const HINT = "Reply through the HUD (hud tell --title T, or hud comment ID TEXT on an open question); the owner does not read this terminal.";

// A message for HQ with the reply reminder appended, unless HUD_HQ_HINT=0.
export function withHint(text: string, env: Record<string, string | undefined> = process.env) {
  return env.HUD_HQ_HINT === "0" ? text : `${text}\n${HINT}`;
}
