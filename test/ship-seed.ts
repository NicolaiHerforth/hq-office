// SHIP with many PRs for the page's walks and screenshots: a fake GitHub world (test/fake-gh-world.ts) with PRs in every
// state the tab draws, the filings that put them in SHIP (lanes and HQ, notes, --urgent), and a stand-in sorter that
// gives each a domain and an urgency. Nothing reaches the real gh or a real model.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeGhWorld, type FakePr, type World } from "./fake-gh-world.ts";

const DOMAINS = ["billing", "checkout ui", "search", "infra", "docs"];
const REPOS: Record<string, { methods: string[]; autoMergeAllowed: boolean }> = {
  "acme/web": { methods: ["merge", "rebase"], autoMergeAllowed: true },
  "acme/api": { methods: ["squash", "merge"], autoMergeAllowed: false },
  "acme/billing": { methods: ["squash"], autoMergeAllowed: true },
};
const repoOf = (i: number) => Object.keys(REPOS)[i % 3];
export const shaOf = (i: number, v = 1) => `${String(i).padStart(4, "0")}${"e".repeat(35)}${v}`;

// The i-th PR: i % 10 picks its state, so every tenth one is ready and the rest each stop for a reason of their own.
export function prOf(i: number): FakePr {
  const k = i % 10;
  return {
    title: i % 7 === 3 ? `Fix the **rounding** of tax lines in \`invoice_total\` when the cart holds more than one currency (${i})` : `Fix bug ${i}: the thing that broke`,
    branch: `fix/bug-${i}`, base: "main", sha: shaOf(i), state: "OPEN", draft: k === 6,
    checks: k === 2 || k === 7 ? "PENDING" : k === 3 ? "FAILURE" : k === 8 ? null : "SUCCESS",
    review: k === 4 ? "CHANGES_REQUESTED" : k === 5 ? "REVIEW_REQUIRED" : "APPROVED",
    mergeable: k === 9 ? "CONFLICTING" : "MERGEABLE", mergeState: k === 9 ? "DIRTY" : k === 5 ? "BLOCKED" : k === 2 || k === 7 ? "UNSTABLE" : "CLEAN",
    additions: 3 + i * 7, deletions: i * 2, files: Array.from({ length: 1 + (i % 6) }, (_, f) => `src/f${i}-${f}.ts`), body: `Fixes bug ${i}.`,
  };
}
export const urlOf = (i: number) => `https://github.com/${repoOf(i)}/pull/${100 + i}`;
export const keyOf = (i: number) => `${repoOf(i)}#${100 + i}`;

export function shipWorld(count: number): World {
  const world: World = { repos: {} };
  for (const [repo, r] of Object.entries(REPOS)) world.repos[repo] = { ...r, prs: {} };
  for (let i = 0; i < count; i++) world.repos[repoOf(i)].prs[String(100 + i)] = prOf(i);
  return world;
}

// The sorter's stand-in: a domain per PR, LOW for every ninth, one urgent the model picks out by itself.
export function shipSorter(dir: string, count: number) {
  mkdirSync(dir, { recursive: true });
  const answer: Record<string, object> = {};
  for (let i = 0; i < count; i++) answer[keyOf(i)] = { domain: DOMAINS[i % DOMAINS.length], urgency: i === 5 ? "URGENT" : i % 9 === 8 ? "LOW" : "NORMAL", why: i === 5 ? "checkout is down for every EU customer" : "" };
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  const script = join(dir, "sort.js");
  writeFileSync(script, `const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const a = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "answer.json"))}, "utf8"));
const out = [...prompt.matchAll(/^### id (\\d+): (\\S+)$/gm)].filter((m) => a[m[2]]).map((m) => ({ id: Number(m[1]), ...a[m[2]] }));
process.stdout.write(JSON.stringify(out));
`);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

// The env a server needs for this world: the stub gh, the stand-in sorter, a short wait before sorting.
export function shipEnv(dir: string, count: number) {
  const gh = fakeGhWorld((mkdirSync(join(dir, "gh"), { recursive: true }), join(dir, "gh")), shipWorld(count));
  return { gh, env: { HUD_GH_BIN: gh.bin, HUD_SAMPLE_CMD: shipSorter(join(dir, "sorter"), count), HUD_SHIP_SORT_MS: "300" } };
}

type Post = (path: string, body: object, pane?: string) => Promise<any>;
// Files COUNT PRs: each from a lane's pane (its own) or from HQ's (HQ's own, or naming a lane); a note on every fifth,
// --urgent on the first three. lanes: [name, pane] of lanes registered on the server.
export async function fileShips(post: Post, count: number, hqPane: string, lanes: [string, string][]) {
  for (let i = 0; i < count; i++) {
    const [lane, pane] = lanes[i % lanes.length];
    const how = i % 3;
    const note = i % 5 === 0 ? `Fixes the crash on **login** when the token expires.\n\n- reproduced\n- tested on staging${i % 10 === 0 ? `\n\n${"More words about it. ".repeat(14)}` : ""}` : undefined;
    const urgent = i < 3 ? (i === 1 ? "checkout is down since the deploy at 02:00" : "security: tokens leak into logs") : undefined;
    await post("/api/ship", { url: urlOf(i), lane: how === 1 ? lane : undefined, note, urgent }, how === 0 ? hqPane : how === 1 ? hqPane : pane);
  }
}
// Until GitHub has been read for every item and the sorter has run on all of them.
export async function shipSettled(base: string, count: number, ms = 60_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(150)) {
    const items = ((await (await fetch(`${base}/api/state`)).json()).ship?.items ?? []) as { gh: unknown; sorted: boolean }[];
    if (items.length === count && items.every((x) => x.gh && x.sorted)) return items;
  }
  throw new Error(`SHIP did not settle with ${count} items`);
}
