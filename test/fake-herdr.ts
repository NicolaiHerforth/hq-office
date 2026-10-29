// A stub herdr for the floor tests: the agents it lists live in <dir>/agents.json, and every call is logged to
// <dir>/calls.log (one JSON array of arguments per line). `tab create` answers with a new tab and its root pane;
// `agent start NAME --pane P` adds NAME to the list, idle, in pane P (or fails while <dir>/fail-start exists; or
// says it started but lists nothing while <dir>/hide-start exists: an HQ that never shows up; or, while
// <dir>/block-start exists, lists it blocked and fails with agent_not_ready: an agent stopped at a startup question,
// whose pane read answers that file's text); `agent start --help` and `integration status` answer like herdr's own;
// `pane list` lists every agent's pane and the plain shells in <dir>/shells.json;

// `--machine M agent list` answers <dir>/agents-M.json (empty when missing): another machine's agents;
// `agent prompt NAME TEXT` fails with agent_not_found for a name not in the list, else appends to <dir>/typed/.
// Written into the test's own throwaway dir by fakeHerdr(); never a real herdr.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeAgent = { name?: string; agent_status: string; pane_id: string; agent: string; workspace_id?: string; cwd?: string; foreground_cwd?: string; interactive_ready?: boolean; agent_session?: { value: string } };

const SCRIPT = (dir: string) => `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const D = ${JSON.stringify(dir)};
let args = process.argv.slice(2);
appendFileSync(D + "/calls.log", JSON.stringify(args) + "\\n");
const machine = args[0] === "--machine" ? args[1] : null;
if (machine) args = args.slice(2);
const agents = () => JSON.parse(readFileSync(D + "/agents.json", "utf8"));
const elsewhere = () => existsSync(D + "/agents-" + machine + ".json") ? JSON.parse(readFileSync(D + "/agents-" + machine + ".json", "utf8")) : [];
const flag = (k) => args[args.indexOf(k) + 1];
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } })); process.exit(1); };
const [a, b] = args;
if (a === "agent" && b === "list") process.stdout.write(JSON.stringify({ result: { agents: machine ? elsewhere() : agents() } }));
else if (a === "tab" && b === "create") {
  const n = Number(existsSync(D + "/tabs") ? readFileSync(D + "/tabs", "utf8") : "0") + 1;
  writeFileSync(D + "/tabs", String(n));
  const ws = flag("--workspace");
  process.stdout.write(JSON.stringify({ id: "cli:tab:create", result: { type: "tab_created", tab: { tab_id: ws + ":t9" + n, workspace_id: ws, label: flag("--label") }, root_pane: { pane_id: ws + ":p9" + n } } }));
} else if (a === "agent" && b === "start" && args.includes("--help")) {
  process.stdout.write("Options:\\n      --kind <KIND>\\n          [possible values: pi, claude, codex, gemini]\\n");
} else if (a === "integration" && b === "status") {
  process.stdout.write("pi: not installed (/x)\\nclaude: current (v10) (/x)\\ncodex: current (v8) (/x)\\nletta (experimental): not installed (/x)\\n");
} else if (a === "pane" && b === "list") {
  process.stdout.write(JSON.stringify({ result: { panes: [...agents(), ...(existsSync(D + "/shells.json") ? JSON.parse(readFileSync(D + "/shells.json", "utf8")) : [])].map((x) => ({ pane_id: x.pane_id, cwd: x.cwd })) } }));
} else if (a === "pane" && b === "read") {
  process.stdout.write(existsSync(D + "/block-start") ? readFileSync(D + "/block-start", "utf8") : "");
} else if (a === "agent" && b === "start" && existsSync(D + "/block-start")) {
  writeFileSync(D + "/agents.json", JSON.stringify([...agents(), { name: args[2], agent_status: "blocked", pane_id: flag("--pane"), agent: flag("--kind") }]));
  fail("agent_not_ready", "agent " + args[2] + " is blocked during startup and is not ready for prompts");
} else if (a === "agent" && b === "start") {
  if (existsSync(D + "/fail-start")) fail("agent_start_failed", "the pane is not at a shell prompt");
  if (!existsSync(D + "/hide-start")) writeFileSync(D + "/agents.json", JSON.stringify([...agents(), { name: args[2], agent_status: "idle", pane_id: flag("--pane"), agent: flag("--kind") }]));
  process.stdout.write(JSON.stringify({ result: { type: "agent_started" } }));
} else if (a === "agent" && b === "prompt") {
  if (!agents().some((x) => x.name === args[2])) fail("agent_not_found", "not found");
  mkdirSync(D + "/typed", { recursive: true });
  writeFileSync(D + "/typed/" + Date.now() + "-" + Math.random().toString(36).slice(2), args[2] + "\\n" + args[3]);
}
`;

export function fakeHerdr(dir: string, initial: FakeAgent[]) {
  mkdirSync(join(dir, "typed"), { recursive: true });
  const bin = join(dir, "herdr");
  writeFileSync(bin, SCRIPT(dir));
  chmodSync(bin, 0o755);
  const world = (list: FakeAgent[]) => writeFileSync(join(dir, "agents.json"), JSON.stringify(list));
  world(initial);
  const calls = (): string[][] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const typed = (): [string, string][] =>
    readdirSync(join(dir, "typed")).sort().map((f) => {
      const s = readFileSync(join(dir, "typed", f), "utf8");
      const i = s.indexOf("\n");
      return [s.slice(0, i), s.slice(i + 1)];
    });
  const failStart = (on: boolean) => (on ? writeFileSync(join(dir, "fail-start"), "") : rmSync(join(dir, "fail-start"), { force: true }));
  const blockStart = (pane: string | null) => (pane !== null ? writeFileSync(join(dir, "block-start"), pane) : rmSync(join(dir, "block-start"), { force: true }));
  const hideStart = (on: boolean) => (on ? writeFileSync(join(dir, "hide-start"), "") : rmSync(join(dir, "hide-start"), { force: true }));
  const elsewhere = (machine: string, list: FakeAgent[]) => writeFileSync(join(dir, `agents-${machine}.json`), JSON.stringify(list));
  const agents = (): FakeAgent[] => JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
  return { bin, world, calls, typed, typedInto: (name: string) => typed().filter(([a]) => a === name).map(([, t]) => t), failStart, hideStart, blockStart, elsewhere, agents };
}
