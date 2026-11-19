// A stub gh for SHIP's tests: it answers from a JSON world in the test's own dir and logs every call to <dir>/calls.log
// (one JSON array of arguments per line). Never the real gh.
//   api graphql -f query=...   the repository(owner:, name:) and pullRequest(number:) aliases in the query, answered
//                              as GitHub does: data, and errors[] with a path for an unknown repo or PR (exit 1, as gh)
//   pr merge N --repo R --squash|--merge|--rebase --match-head-commit SHA [--auto]   fails as gh does when the head
//                              is not SHA, the method is not allowed or the PR says unmergeable; else MERGED, or
//                              auto-merge on with --auto
//   anything else (--delete-branch, --admin, run, workflow ...) is refused with exit 2.
// A PR in the world: { title, branch, base, sha, state, draft, checks: SUCCESS|PENDING|FAILURE|null, review,
// mergeable, mergeState, additions, deletions, files: [paths], body, autoMerge, unmergeable: "gh's message",
// mergeSlowMs: a merge that GitHub has made at once, but gh answers only after that long }.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakePr = Record<string, any> & { sha: string };
export type World = { repos: Record<string, { methods?: string[]; autoMergeAllowed?: boolean; prs: Record<string, FakePr> }> };

const SCRIPT = (dir: string) => `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fake-gh-world-bin.js"))} ${JSON.stringify(dir)} "$@"\n`;

export function fakeGhWorld(dir: string, initial: World) {
  const bin = join(dir, "gh");
  writeFileSync(bin, SCRIPT(dir));
  chmodSync(bin, 0o755);
  const file = join(dir, "world.json");
  const setWorld = (w: World) => writeFileSync(file, JSON.stringify(w));
  setWorld(initial);
  const world = (): World => JSON.parse(readFileSync(file, "utf8"));
  const setPr = (repo: string, n: number, fields: Partial<FakePr>) => {
    const w = world();
    w.repos[repo].prs[String(n)] = { ...w.repos[repo].prs[String(n)], ...fields };
    setWorld(w);
  };
  const calls = (): string[][] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, world, setWorld, setPr, calls, reads: () => calls().filter((c) => c[0] === "api"), merges: () => calls().filter((c) => c[0] === "pr") };
}
