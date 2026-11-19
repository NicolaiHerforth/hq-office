// The stub gh's body (see fake-gh-world.ts): <dir>/gh runs it with that test's dir first, then gh's arguments.
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const D = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(D + "/calls.log", JSON.stringify(args) + "\n");
const world = JSON.parse(readFileSync(D + "/world.json", "utf8"));
const save = () => writeFileSync(D + "/world.json", JSON.stringify(world));
const fail = (code, message) => { process.stderr.write(message + "\n"); process.exit(code); };
const repoOf = (name) => world.repos[name.toLowerCase()];

function pr(repo, p, full) {
  const out = {
    state: p.state ?? "OPEN", title: p.title ?? "", headRefName: p.branch ?? "feature", baseRefName: p.base ?? "main", headRefOid: p.sha,
    isDraft: !!p.draft, additions: p.additions ?? 1, deletions: p.deletions ?? 0, changedFiles: (p.files ?? []).length,
    reviewDecision: p.review ?? null, mergeable: p.mergeable ?? "MERGEABLE", mergeStateStatus: p.mergeState ?? "CLEAN",
    autoMergeRequest: p.autoMerge ? { enabledAt: "2026-01-01T00:00:00Z" } : null,
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
  };
  if (full) Object.assign(out, { body: p.body ?? "", files: { nodes: (p.files ?? []).map((path) => ({ path })) } });
  return out;
}

if (args[0] === "api" && args[1] === "graphql" && args[2] === "-f" && String(args[3]).startsWith("query=")) {
  const q = args[3].slice("query=".length);
  const marks = [...q.matchAll(/(\w+):\s*(repository|pullRequest)\(([^)]*)\)/g)];
  const data = {}, errors = [];
  let ra = null, repo = null;
  marks.forEach((m, i) => {
    const seg = q.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : q.length);
    if (m[2] === "repository") {
      const owner = m[3].match(/owner:\s*"([^"]+)"/)[1], name = m[3].match(/name:\s*"([^"]+)"/)[1];
      ra = m[1];
      repo = repoOf(`${owner}/${name}`);
      if (!repo) {
        data[ra] = null;
        errors.push({ type: "NOT_FOUND", path: [ra], message: `Could not resolve to a Repository with the name '${owner}/${name}'.` });
        return;
      }
      const methods = repo.methods ?? ["squash", "merge", "rebase"];
      data[ra] = { squashMergeAllowed: methods.includes("squash"), mergeCommitAllowed: methods.includes("merge"), rebaseMergeAllowed: methods.includes("rebase"), autoMergeAllowed: !!repo.autoMergeAllowed };
    } else if (repo) {
      const n = m[3].match(/number:\s*(\d+)/)[1];
      const p = repo.prs[n];
      if (!p) {
        data[ra][m[1]] = null;
        errors.push({ type: "NOT_FOUND", path: [ra, m[1]], message: `Could not resolve to a PullRequest with the number of ${n}.` });
        return;
      }
      data[ra][m[1]] = pr(repo, p, /\bbody\b/.test(seg));
    }
  });
  process.stdout.write(JSON.stringify(errors.length ? { data, errors } : { data }));
  if (errors.length) fail(1, "gh: " + errors.map((e) => e.message).join("\n"));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "merge") {
  const known = new Set(["--repo", "--squash", "--merge", "--rebase", "--match-head-commit", "--auto"]);
  const flags = args.slice(3).filter((a) => a.startsWith("--"));
  if (flags.some((f) => !known.has(f))) fail(2, "fake gh: refused " + flags.filter((f) => !known.has(f)).join(" "));
  const val = (k) => args[args.indexOf(k) + 1];
  const repo = repoOf(val("--repo") ?? "");
  const p = repo?.prs[args[2]];
  if (!p) fail(1, `GraphQL: Could not resolve to a PullRequest with the number of ${args[2]}. (repository.pullRequest)`);
  const method = ["squash", "merge", "rebase"].find((m) => args.includes("--" + m));
  if (!method || !(repo.methods ?? ["squash", "merge", "rebase"]).includes(method)) fail(1, `GraphQL: ${method ?? "that"} merges are not allowed on this repository (mergePullRequest)`);
  if (val("--match-head-commit") !== p.sha) fail(1, "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)");
  if (p.unmergeable) fail(1, p.unmergeable);
  if (args.includes("--auto")) {
    if (!repo.autoMergeAllowed) fail(1, "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)");
    p.autoMerge = true;
  } else p.state = "MERGED";
  save();
  // GitHub has merged it; gh takes this long to say so.
  if (p.mergeSlowMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, p.mergeSlowMs);
  process.stdout.write(args.includes("--auto") ? "will be automatically merged when all requirements are met\n" : "merged\n");
  process.exit(0);
}

fail(2, "fake gh: refused " + args.join(" "));
