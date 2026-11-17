// The state version and its listeners: bump() after a write, and every open stream and wait hears it.
// touch() is for when something may have changed that is not in the database (memory, a file): open pages look
// again, the version stays, and nothing that waits on a write wakes.
import { createSecretStore } from "./secrets.ts";

export let version = 1;
// Hears every bump: a wait on the inbox, a room's reader, what delivers kept messages when the state changes.
export const listeners = new Set<() => void>();
// Hears every bump and every touch: the page stream, which then builds what changed and sends it.
export const watchers = new Set<() => void>();

// Who bumps and who touches, counted since the server started (GET /api/push): docs/footprint.md, "A push".
// A caller that gives no cause is named by its place in the code.
const since = Date.now();
const counts = { bump: new Map<string, number>(), touch: new Map<string, number>() };
function count(kind: "bump" | "touch", cause: string | undefined) {
  // The first place on the stack that is not this file.
  const who = cause ?? new Error().stack?.split("\n").map((l) => l.match(/([\w.-]+\.(?:ts|js)):(\d+)/)).find((m) => m && m[1] !== "push.ts")?.slice(1, 3).join(":") ?? "somewhere";
  counts[kind].set(who, (counts[kind].get(who) ?? 0) + 1);
}
const sorted = (m: Map<string, number>) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
export const pushCounts = () => ({ since, version, bumps: sorted(counts.bump), touches: sorted(counts.touch) });

export function bump(cause?: string) {
  version++;
  count("bump", cause);
  for (const fn of [...listeners]) fn();
  for (const fn of [...watchers]) fn();
}
export function touch(cause?: string) {
  count("touch", cause);
  for (const fn of [...watchers]) fn();
}

// Secrets live in this process only (see secrets.ts). A change bumps, so the page's countdowns stay current.
// secretsGen counts those changes: what masks text with the secrets (a brief's first lines) is made again after one.
export let secretsGen = 0;
export const secrets = createSecretStore({ onChange: () => { secretsGen++; bump("a secret set, read or gone"); } });
