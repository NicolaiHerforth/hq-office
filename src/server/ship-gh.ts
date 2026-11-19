// SHIP's GitHub, through `gh` on this machine (the owner's login; HUD_GH_BIN swaps the binary). One GraphQL query reads
// every PR asked for, an alias per repo and one per PR inside it; `gh pr merge` merges one. Nothing here dispatches,
// re-runs or triggers CI, deletes a branch or merges as an admin.
import { keyOf, type Facts, type Read } from "./ship.ts";

export type Ref = { repo: string; number: number; full?: boolean };
// Facts, and for a PR read in full (the sorter has not seen it yet) its body and changed paths.
export type FullRead = Read & { body?: string; paths?: string[] };
export const GH_TIMEOUT_MS = 30_000;
const bin = () => process.env.HUD_GH_BIN || "gh";

const PR_FIELDS = `state title headRefName baseRefName headRefOid isDraft additions deletions changedFiles reviewDecision mergeable mergeStateStatus
      autoMergeRequest { enabledAt } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

// The query, and which alias is which PR. Repo and number come from parsePr, so they hold no quote or brace.
export function buildQuery(refs: Ref[]) {
  const repos = new Map<string, Ref[]>();
  for (const r of refs) repos.set(r.repo, [...(repos.get(r.repo) ?? []), r]);
  const alias = new Map<string, { repo: string; prs: Map<string, Ref> }>();
  const parts = [...repos].map(([repo, prs], i) => {
    const [owner, name] = repo.split("/");
    const inner = new Map<string, Ref>();
    const body = prs.map((p) => {
      inner.set(`p${p.number}`, p);
      return `    p${p.number}: pullRequest(number: ${p.number}) { ${PR_FIELDS}${p.full ? " body files(first: 100) { nodes { path } }" : ""} }`;
    });
    alias.set(`r${i}`, { repo, prs: inner });
    return `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed\n${body.join("\n")}\n  }`;
  });
  return { query: `query {\n${parts.join("\n")}\n}`, alias };
}

// Squash before merge before rebase: the order the page and the merge pick from.
const ALLOWED = { squash: "squashMergeAllowed", merge: "mergeCommitAllowed", rebase: "rebaseMergeAllowed" } as const;
const METHODS = Object.keys(ALLOWED) as (keyof typeof ALLOWED)[];
const CHECKS: Record<string, Facts["checks"]> = { SUCCESS: "passing", PENDING: "pending", EXPECTED: "pending", FAILURE: "failing", ERROR: "failing" };

// GitHub's answer as facts per repo#number. GraphQL answers what it can and lists the rest in errors[], each with the
// path of what it could not resolve: a PR or a whole repo comes back null and gets that error in words.
export function parseAnswer(answer: any, alias: ReturnType<typeof buildQuery>["alias"]): Map<string, FullRead> {
  const errors = new Map<string, string>();
  for (const e of Array.isArray(answer?.errors) ? answer.errors : []) {
    const path = Array.isArray(e?.path) ? e.path.join(".") : "";
    if (path) errors.set(path, String(e.message ?? e.type ?? "GitHub could not read it"));
  }
  const out = new Map<string, FullRead>();
  for (const [ra, { repo, prs }] of alias) {
    const r = answer?.data?.[ra];
    const methods = r ? METHODS.filter((m) => r[ALLOWED[m]]) : [];
    for (const [pa, ref] of prs) {
      const p = r?.[pa];
      const key = keyOf(ref);
      if (!p) {
        out.set(key, { error: errors.get(`${ra}.${pa}`) ?? errors.get(ra) ?? (r ? `GitHub has no PR #${ref.number} in ${repo}` : `GitHub could not read ${repo}`) });
        continue;
      }
      const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const facts: FullRead = {
        state: p.state, title: String(p.title ?? ""), branch: String(p.headRefName ?? ""), base: String(p.baseRefName ?? ""), sha: String(p.headRefOid ?? ""),
        draft: !!p.isDraft, checks: rollup ? CHECKS[rollup.state] ?? "pending" : "none", review: p.reviewDecision ?? null,
        mergeable: p.mergeable ?? "UNKNOWN", mergeState: p.mergeStateStatus ?? "UNKNOWN",
        additions: Number(p.additions) || 0, deletions: Number(p.deletions) || 0, files: Number(p.changedFiles) || 0,
        methods, autoMergeAllowed: !!r.autoMergeAllowed, autoMerge: !!p.autoMergeRequest,
      };
      if (ref.full) {
        facts.body = String(p.body ?? "");
        facts.paths = (p.files?.nodes ?? []).map((f: any) => String(f?.path ?? "")).filter(Boolean);
      }
      out.set(key, facts);
    }
  }
  return out;
}

async function run(args: string[]) {
  const proc = Bun.spawn([bin(), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { out, err, code, firstLine: err.trim().split("\n")[0] || (proc.signalCode ? `gh took over ${GH_TIMEOUT_MS / 1000} s` : `gh exit ${code}`) };
}

// Every PR in one call. gh exits non-zero when the answer has errors, and still prints the answer: what it holds is
// used. Only a call that answered nothing usable fails every PR, with gh's first line.
export async function readPrs(refs: Ref[]): Promise<Map<string, FullRead>> {
  if (!refs.length) return new Map();
  const { query, alias } = buildQuery(refs);
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run(["api", "graphql", "-f", `query=${query}`]);
  } catch (e) {
    r = { out: "", err: "", code: -1, firstLine: `gh could not be run: ${(e as Error).message}` };
  }
  let answer: any = null;
  try { answer = JSON.parse(r.out); } catch {}
  if (answer?.data) return parseAnswer(answer, alias);
  return new Map(refs.map((ref) => [keyOf(ref), { error: r.firstLine }]));
}

// A PR whose head is not the commit the page showed. We cannot tell who pushed, so it names nobody.
export const MOVED = "Not merged: new commits came in while it waited here, and a merge only takes what this page showed you.";
// gh pr merge's refusals the owner meets, in his words; GitHub's own text after "GitHub said" for the rest.
const REFUSALS: [RegExp, string][] = [
  [/head branch was modified|head commit .*(does not match|not match)|expected head sha/i, MOVED],
  [/merge conflict|conflicts? (with|must be resolved)/i, "Not merged: it conflicts with its base branch, so whoever filed it has to fix that."],
  [/approving review|review is required|reviews? required|changes requested/i, "Not merged: GitHub wants an approving review first."],
  [/required status checks?|status checks? (are|is) (expected|pending|failing|required)/i, "Not merged: checks the branch requires have not passed yet."],
  [/base branch policy|branch protection|protected branch|repository rule|rule violations?/i, "Not merged: the branch's rules on GitHub do not allow it yet."],
  [/auto.?merge is not allowed|not enabled for auto.?merge/i, "Not merged: this repo does not allow auto-merge."],
  [/merges are not allowed on this repository/i, "Not merged: the repo no longer allows that way of merging. Look again."],
  [/unstable status/i, "Not merged: some checks on it are not passing."],
  [/not mergeable/i, "Not merged: GitHub says it cannot be merged right now."],
];
export function refusalWords(error: string) {
  return REFUSALS.find(([re]) => re.test(error))?.[1] ?? `Not merged: GitHub said: ${error}`;
}

// One merge with the method the repo allows, and only while the head is the commit the owner saw.
export async function mergePr(o: { repo: string; number: number; method: string; sha: string; auto: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = await run(["pr", "merge", String(o.number), "--repo", o.repo, `--${o.method}`, "--match-head-commit", o.sha, ...(o.auto ? ["--auto"] : [])]);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.firstLine };
  } catch (e) {
    return { ok: false, error: `gh could not be run: ${(e as Error).message}` };
  }
}
