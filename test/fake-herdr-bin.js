// The stub herdr's body (see fake-herdr.ts): <dir>/herdr runs it with that test's dir first, then herdr's arguments.
const { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const D = process.argv[2];
let args = process.argv.slice(3);
appendFileSync(D + "/calls.log", JSON.stringify(args) + "\n");
const machine = args[0] === "--machine" ? args[1] : null;
if (machine) args = args.slice(2);
const agents = () => JSON.parse(readFileSync(D + "/agents.json", "utf8"));
const elsewhere = () => existsSync(D + "/agents-" + machine + ".json") ? JSON.parse(readFileSync(D + "/agents-" + machine + ".json", "utf8")) : [];
const flag = (k) => args[args.indexOf(k) + 1];
const fail = (code, message) => { process.stderr.write(JSON.stringify({ error: { code, message } })); process.exit(1); };
const [a, b] = args;
if (a === "agent" && b === "list") process.stdout.write(JSON.stringify({ result: { agents: machine ? elsewhere() : agents() } }));
else if (a === "machine" && b === "list") process.stdout.write("[]");
else if (a === "tab" && b === "create") {
  const n = Number(existsSync(D + "/tabs") ? readFileSync(D + "/tabs", "utf8") : "0") + 1;
  writeFileSync(D + "/tabs", String(n));
  const ws = flag("--workspace");
  process.stdout.write(JSON.stringify({ id: "cli:tab:create", result: { type: "tab_created", tab: { tab_id: ws + ":t9" + n, workspace_id: ws, label: flag("--label") }, root_pane: { pane_id: ws + ":p9" + n } } }));
} else if (a === "agent" && b === "start" && args.includes("--help")) {
  process.stdout.write("Options:\n      --kind <KIND>\n          [possible values: pi, claude, codex, gemini]\n");
} else if (a === "integration" && b === "status") {
  process.stdout.write("pi: not installed (/x)\nclaude: current (v10) (/x)\ncodex: current (v8) (/x)\nletta (experimental): not installed (/x)\n");
} else if (a === "pane" && b === "list") {
  process.stdout.write(JSON.stringify({ result: { panes: [...agents(), ...(existsSync(D + "/shells.json") ? JSON.parse(readFileSync(D + "/shells.json", "utf8")) : [])].map((x) => ({ pane_id: x.pane_id, cwd: x.cwd })) } }));
} else if (a === "pane" && b === "read") {
  const text = existsSync(D + "/block-start") ? readFileSync(D + "/block-start", "utf8") : "";
  process.stdout.write(args.includes("--lines") ? text.split("\n").slice(-Number(flag("--lines"))).join("\n") : text);
} else if (a === "agent" && b === "get") {
  const ag = agents().find((x) => x.name === args[2]);
  if (!ag) fail("agent_not_found", "not found");
  process.stdout.write(JSON.stringify({ result: { agent: ag } }));
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
  writeFileSync(D + "/typed/" + Date.now() + "-" + Math.random().toString(36).slice(2), args[2] + "\n" + args[3]);
}
