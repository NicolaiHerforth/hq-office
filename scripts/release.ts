#!/usr/bin/env bun
// The release routine: export a ref's tracked tree, check it is safe to publish and that its tests pass, then commit
// and tag it in a local clone of the public repo. Only with --push does anything leave this machine.
//
//   bun scripts/release.ts X.Y.Z [--ref REF] [--public DIR] [--remote URL] [--push]
//
//   X.Y.Z      the version; CHANGELOG.md at REF must have a "## [X.Y.Z]" section, and herdr-plugin.toml and
//              package.json must say this version
//   --ref      what to release (default HEAD)
//   --public   the local clone of the public repo (default ../hq-office-public, next to this repo); cloned when missing
//   --remote   where to clone it from (default: "repository" in package.json)
//   --push     push the branch and the tag, and create the GitHub release with the changelog section as its notes
//
// After bun test, the export's Parity Lab (scripts/parity-lab/harness.ts) must pass at least PARITY_BAR checks, with
// a stub model command for HUD_SAMPLE_CMD. It needs Chrome and the network (three checks load from CDNs).
//
// Files of this installation, never published, looked up in this working tree and then in the main one:
//   .release-denylist  one regular expression per line, matched case-insensitively against every line and path of
//                      the export; any match fails the release. "!TEXT" allows that exact text. "#" starts a comment.
//                      Required: without it the release refuses to run.
//   .release-exclude   paths or globs (relative to the repo root) left out of the export, one per line.
//   AGENTS.local.md    always left out.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { findChrome } from "./room-hash.ts";

const ALWAYS_EXCLUDED = ["AGENTS.local.md"];

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

// Runs a command and returns its stdout; fails the release when it exits non-zero, unless `soft`.
function run(cmd: string[], opts: { cwd?: string; soft?: boolean; inherit?: boolean; env?: Record<string, string | undefined> } = {}) {
  const p = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env ?? process.env, stdout: opts.inherit ? "inherit" : "pipe", stderr: opts.inherit ? "inherit" : "pipe" });
  if (p.exitCode !== 0 && !opts.soft) fail(`${cmd.join(" ")} failed${opts.inherit ? "" : `:\n${p.stderr.toString().trim()}`}`);
  return { ok: p.exitCode === 0, out: opts.inherit ? "" : p.stdout.toString().trim() };
}

// ---- arguments ----

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) fail(`--${name} needs a value`);
  args.splice(i, 2);
  return v;
};
const push = args.includes("--push");
if (push) args.splice(args.indexOf("--push"), 1);
const refArg = flag("ref") ?? "HEAD";
const publicArg = flag("public");
const remoteArg = flag("remote");
const version = args.shift()?.replace(/^v/, "");
if (!version || args.length) fail("usage: bun scripts/release.ts X.Y.Z [--ref REF] [--public DIR] [--remote URL] [--push]");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`"${version}" is not a version like 0.2.0`);
const tag = `v${version}`;
const PARITY_BAR = 21; // every check in scripts/parity-lab/template.html
const chrome = findChrome();
if (!chrome) fail("the Parity Lab needs Chrome and none was found; install it or set CHROME_BIN");
if (!existsSync(chrome)) fail(`the Parity Lab needs Chrome: CHROME_BIN is ${chrome}, which does not exist`);

// Everyone who wrote or co-wrote a commit since the previous release (this repo's previous v* tag), except the
// owner and AI co-author lines: the public repo gets one commit per release, so they are credited on it.
function contributors(): string[] {
  const prev = run(["git", "describe", "--tags", "--abbrev=0", "--match", "v*", `${commit}^`], { cwd: ROOT, soft: true });
  if (!prev.ok) return [];
  const owner = run(["git", "config", "user.email"], { cwd: ROOT, soft: true }).out.trim().toLowerCase();
  const log = run(["git", "log", "--format=%an <%ae>%n%(trailers:key=Co-Authored-By,valueonly)", `${prev.out.trim()}..${commit}`], { cwd: ROOT }).out;
  const seen = new Map<string, string>();
  for (const line of log.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const email = line.match(/<([^>]+)>/)?.[1]?.toLowerCase();
    if (!email || email === owner || email.endsWith("@anthropic.com") || email.includes("noreply")) continue;
    if (!seen.has(email)) seen.set(email, line);
  }
  return [...seen.values()];
}

const ROOT = run(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir }).out;
// The main working tree: where this installation's own files live when the release runs from another worktree.
const MAIN = run(["git", "worktree", "list", "--porcelain"], { cwd: ROOT }).out.split("\n")[0].replace(/^worktree /, "");
const localFile = (name: string) => [join(ROOT, name), join(MAIN, name)].find((p) => existsSync(p));
const commit = run(["git", "rev-parse", "--verify", `${refArg}^{commit}`], { cwd: ROOT }).out;
const show = (path: string) => {
  const r = run(["git", "show", `${commit}:${path}`], { cwd: ROOT, soft: true });
  if (!r.ok) fail(`${path} is not in ${refArg}`);
  return r.out;
};

// ---- the changelog section and the version ----

function changelogSection(text: string, v: string) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${v}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## \[/.test(l));
  if (end < 0) end = lines.length;
  // Link references at the bottom of the file belong to no section.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]: /.test(l)).join("\n").trim();
  return body || null;
}
const notes = changelogSection(show("CHANGELOG.md"), version);
if (!notes) fail(`CHANGELOG.md at ${refArg} has no "## [${version}]" section, or it is empty`);
const tomlVersion = show("herdr-plugin.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pkg = JSON.parse(show("package.json"));
if (tomlVersion !== version) fail(`herdr-plugin.toml says version ${tomlVersion}, not ${version}`);
if (pkg.version !== version) fail(`package.json says version ${pkg.version}, not ${version}`);

// ---- the denylist ----

const denyFile = localFile(".release-denylist");
if (!denyFile) fail(`no .release-denylist in ${ROOT}${MAIN !== ROOT ? ` or ${MAIN}` : ""}: write the personal terms the release must not contain, one pattern per line`);
const allowed: string[] = [];
const denied: RegExp[] = [];
for (const raw of readFileSync(denyFile, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  if (line.startsWith("!")) allowed.push(line.slice(1));
  else {
    try {
      denied.push(new RegExp(line, "i"));
    } catch (e) {
      fail(`${denyFile}: bad pattern ${line}: ${(e as Error).message}`);
    }
  }
}
if (!denied.length) fail(`${denyFile} has no patterns`);

// ---- export ----

const TMP = mkdtempSync(join(tmpdir(), `hq-office-release-${version}-`));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
const EXPORT = join(TMP, "export");
mkdirSync(EXPORT);
run(["sh", "-c", `git -C "$1" archive --format=tar "$2" | tar -x -C "$3"`, "sh", ROOT, commit, EXPORT]);

const excludeFile = localFile(".release-exclude");
const excludes = [
  ...ALWAYS_EXCLUDED,
  ...(excludeFile ? readFileSync(excludeFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : []),
];
const removed: string[] = [];
for (const pattern of excludes) {
  const clean = pattern.replace(/^\/+|\/+$/g, "");
  const direct = join(EXPORT, clean);
  if (resolve(direct).startsWith(EXPORT + "/") && existsSync(direct)) {
    rmSync(direct, { recursive: true, force: true });
    removed.push(clean);
    continue;
  }
  for (const hit of new Bun.Glob(clean).scanSync({ cwd: EXPORT, dot: true, onlyFiles: false })) {
    rmSync(join(EXPORT, hit), { recursive: true, force: true });
    removed.push(hit);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });
}
const files = filesUnder(EXPORT).map((p) => relative(EXPORT, p)).sort();
console.log(`exported ${files.length} files of ${refArg} (${commit.slice(0, 7)})${removed.length ? `, left out: ${removed.join(", ")}` : ""}`);

// ---- scan ----

const hits: string[] = [];
const scrub = (text: string) => allowed.reduce((t, a) => t.split(a).join(""), text);
for (const file of files) {
  for (const re of denied) if (re.test(scrub(file))) hits.push(`${file}: the path matches /${re.source}/`);
  const bytes = readFileSync(join(EXPORT, file));
  if (bytes.subarray(0, 8000).includes(0)) continue; // binary
  bytes.toString("utf8").split("\n").forEach((line, i) => {
    const text = scrub(line);
    for (const re of denied) if (re.test(text)) hits.push(`${file}:${i + 1}: /${re.source}/  ${line.trim().slice(0, 160)}`);
  });
}
if (hits.length) {
  console.error(`release: ${hits.length} personal reference${hits.length === 1 ? "" : "s"} in the export (patterns from ${denyFile}):`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`scanned: no line matches the ${denied.length} patterns in ${denyFile}`);

// ---- install and test, on a copy so nothing the tests write is published ----

const CHECK = join(TMP, "check");
cpSync(EXPORT, CHECK, { recursive: true });
if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) run(["bun", "install"], { cwd: CHECK, inherit: true });
const testEnv: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(testEnv)) if (key.startsWith("PIXEL_") || key.startsWith("HUD_")) delete testEnv[key];
console.log("bun test in the export:");
run([process.execPath, "test"], { cwd: CHECK, inherit: true, env: testEnv });

// ---- Parity Lab: the export's pages still do what an artifact's do ----

const MODEL = join(TMP, "stub-model.sh");
writeFileSync(MODEL, "#!/bin/sh\ncat > /dev/null\nprintf 'A fixed answer from the release check.'\n");
console.log(`\nParity Lab in the export (at least ${PARITY_BAR} checks must pass):`);
const parity = run([process.execPath, "scripts/parity-lab/harness.ts", "--expect", String(PARITY_BAR), "--out", join(TMP, "parity")], { cwd: CHECK, inherit: true, soft: true, env: { ...testEnv, CHROME_BIN: chrome, HUD_SAMPLE_CMD: `sh ${MODEL}` } });
if (!parity.ok) fail(`the Parity Lab passed fewer than ${PARITY_BAR} checks in the export (each check is listed above)`);

// ---- the public clone ----

const PUBLIC = resolve(publicArg ?? join(dirname(ROOT), "hq-office-public"));
const repoUrl = (r: unknown) => {
  const s = typeof r === "string" ? r : (r as { url?: string } | undefined)?.url;
  if (!s) return undefined;
  const short = s.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  return short ? `https://github.com/${short[1]}.git` : s.replace(/^git\+/, "");
};
const remote = remoteArg ?? repoUrl(pkg.repository);
const pg = (...a: string[]) => run(["git", "-C", PUBLIC, ...a]).out;
if (!existsSync(PUBLIC)) {
  if (!remote) fail(`${PUBLIC} does not exist and there is no --remote or "repository" in package.json to clone it from`);
  console.log(`cloning ${remote} into ${PUBLIC}`);
  run(["git", "clone", remote, PUBLIC], { inherit: true });
}
if (!existsSync(join(PUBLIC, ".git"))) fail(`${PUBLIC} is not a git clone`);
if (pg("status", "--porcelain")) fail(`${PUBLIC} has uncommitted changes; commit or remove them first`);
const branch = pg("symbolic-ref", "--short", "HEAD");
// Bring the clone up to date with the public repo; never rewrite it.
if (run(["git", "-C", PUBLIC, "fetch", "--tags", "origin"], { soft: true }).ok && run(["git", "-C", PUBLIC, "rev-parse", "--verify", `origin/${branch}`], { soft: true }).ok) {
  const behind = Number(pg("rev-list", "--count", `${branch}..origin/${branch}`));
  const ahead = Number(pg("rev-list", "--count", `origin/${branch}..${branch}`));
  if (behind && ahead) fail(`${PUBLIC}: ${branch} and origin/${branch} have diverged; sort that out by hand`);
  if (behind) pg("merge", "--ff-only", `origin/${branch}`);
}

// The tree the export would commit as, from a scratch index: compared without touching the clone's files.
function exportTree() {
  const env = { ...process.env, GIT_INDEX_FILE: join(TMP, "index") };
  run(["git", "-C", PUBLIC, "--work-tree", EXPORT, "add", "-A"], { env });
  return run(["git", "-C", PUBLIC, "write-tree"], { env }).out;
}
const tree = exportTree();

const tagged = run(["git", "-C", PUBLIC, "rev-parse", "-q", "--verify", `refs/tags/${tag}`], { soft: true });
if (tagged.ok) {
  // Released locally already (a run without --push): go on only if that is exactly this export, at the branch head.
  if (pg("rev-parse", `${tag}^{commit}`) !== pg("rev-parse", "HEAD")) fail(`${PUBLIC}: tag ${tag} exists and is not ${branch}'s head; delete it there to redo the release`);
  if (pg("rev-parse", `${tag}^{tree}`) !== tree) fail(`${PUBLIC}: tag ${tag} exists but its tree differs from ${refArg}'s export; delete the tag and its commit there to redo the release`);
  console.log(`${tag} is already committed and tagged in ${PUBLIC}`);
} else {
  if (pg("rev-parse", "HEAD^{tree}") === tree) fail(`${PUBLIC}: the export is identical to ${branch}; nothing to release`);
  // The clone's tree becomes exactly the export: every tracked file goes, then the export comes in.
  for (const f of pg("ls-files", "-z").split("\0").filter(Boolean)) rmSync(join(PUBLIC, f), { force: true });
  cpSync(EXPORT, PUBLIC, { recursive: true });
  pg("add", "-A");
  if (pg("write-tree") !== tree) fail(`${PUBLIC}: the staged tree is not the export (an ignored file in the way?)`);
  const message = join(TMP, "message");
  const credits = contributors();
  writeFileSync(message, `release: ${tag}\n\n${notes}\n${credits.length ? "\n" + credits.map((c) => `Co-Authored-By: ${c}`).join("\n") + "\n" : ""}`);
  if (credits.length) console.log(`credited: ${credits.join(", ")}`);
  pg("commit", "-q", "-F", message);
  pg("tag", "-a", tag, "-F", message);
  console.log(`committed and tagged ${tag} in ${PUBLIC}`);
}
console.log(pg("show", "--stat", "--format=%h %s", "HEAD").split("\n").filter(Boolean).slice(-1)[0]);

// ---- publish ----

const ghRepo = remote?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
const notesFile = join(TMP, "notes.md");
writeFileSync(notesFile, notes + "\n");
const steps = [
  ["git", "-C", PUBLIC, "push", "origin", branch],
  ["git", "-C", PUBLIC, "push", "origin", tag],
  ["gh", "release", "create", tag, "--repo", ghRepo ?? "<OWNER/REPO>", "--title", tag, "--notes-file", notesFile, "--verify-tag"],
];
if (!push) {
  console.log(`\nNot pushed. Read the commit in ${PUBLIC}, then run again with --push. That would run`);
  console.log(`(the notes file holds the [${version}] section of CHANGELOG.md):`);
  for (const step of steps) console.log(`  ${step.join(" ")}`);
  process.exit(0);
}
if (!ghRepo) fail(`cannot tell the GitHub repo from ${remote}; pass --remote https://github.com/OWNER/REPO.git`);
for (const step of steps) run(step, { inherit: true });
// The released commit gets the same tag here, so the next release knows where this one started.
run(["git", "tag", "-a", tag, "-m", `release ${tag}`, commit], { cwd: ROOT, soft: true });
console.log(`released ${tag}: https://github.com/${ghRepo}/releases/tag/${tag}`);
