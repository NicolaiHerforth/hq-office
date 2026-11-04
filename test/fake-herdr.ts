// A stub herdr for the floor tests: the agents it lists live in <dir>/agents.json, and every call is logged to
// <dir>/calls.log (one JSON array of arguments per line). `tab create` answers with a new tab and its root pane;
// `agent start NAME --pane P` adds NAME to the list, idle, in pane P (or fails while <dir>/fail-start exists; or
// says it started but lists nothing while <dir>/hide-start exists: an HQ that never shows up; or, while
// <dir>/block-start exists, lists it blocked and fails with agent_not_ready: an agent stopped at a startup question,
// whose pane read answers that file's text, its last --lines N lines when asked); `agent start --help` and
// `integration status` answer like herdr's own; `agent get NAME` answers that agent from the list;
// `pane list` lists every agent's pane and the plain shells in <dir>/shells.json;

// `--machine M agent list` answers <dir>/agents-M.json (empty when missing): another machine's agents;
// `agent prompt NAME TEXT` fails with agent_not_found for a name not in the list, else appends to <dir>/typed/;
// `machine list` answers no machines.
// Written into the test's own throwaway dir by fakeHerdr(); never a real herdr.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeAgent = { name?: string; agent_status: string; pane_id: string; agent: string; workspace_id?: string; cwd?: string; foreground_cwd?: string; interactive_ready?: boolean; agent_session?: { value: string } };

// Its body is checked in (fake-herdr-bin.js) and <dir>/herdr is a sh wrapper: every Bun start reads each folder above
// its script, and the system's temp dir can hold tens of thousands of entries, read one start at a time.
const SCRIPT = (dir: string) => `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fake-herdr-bin.js"))} ${JSON.stringify(dir)} "$@"\n`;

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
