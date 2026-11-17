// THE MONITOR's containers: what runs inside the Linux virtual machine of OrbStack, which the process table shows
// as one process holding everything. Read from the Docker API on its socket, in this process: the list, and each
// container's memory and CPU total. No `docker` command is started. A container enters a reading as a process
// inside the machine's process (Proc.inside), so the deltas take it off the machine's own row and nothing is counted
// twice. Only names and labels are taken: a container's command line is in the list and is never read.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Owner, Proc } from "./monitor-types.ts";

// Where the API listens, and the process that is the virtual machine. Checked with OrbStack only.
const ENGINES = [{ socket: join(homedir(), ".orbstack", "run", "docker.sock"), machine: "OrbStack Helper" }];
// A container that does not answer in this time is left out of the tick: the tick must not wait for it.
const ASK_MS = 1_000;

export type Container = {
  id: string;
  // The compose project and service, or the container's own name.
  name: string;
  // The folder `docker compose` was run in: whose container it is. In memory only.
  folder: string | null;
  startedAt: number;
  cpuMs: number;
  mem: number;
};

async function ask(socket: string, path: string): Promise<any> {
  const res = await fetch(`http://docker${path}`, { unix: socket, signal: AbortSignal.timeout(ASK_MS) } as RequestInit);
  if (!res.ok) throw new Error(`docker ${path.split("?")[0]}: ${res.status}`);
  return res.json();
}

// What the list and one container's stats say, as a Container. Memory is what the container cannot give up: its
// usage less the file pages that are not in use, which is what `docker stats` shows.
export function containerOf(listed: any, stats: any): Container {
  const labels = listed.Labels ?? {};
  const project = labels["com.docker.compose.project"];
  const service = labels["com.docker.compose.service"];
  const memory = stats.memory_stats ?? {};
  return {
    id: String(listed.Id),
    name: project && service ? `${project}: ${service}` : String(listed.Names?.[0] ?? listed.Id).replace(/^\//, ""),
    folder: typeof labels["com.docker.compose.project.working_dir"] === "string" ? labels["com.docker.compose.project.working_dir"] : null,
    startedAt: Number(listed.Created) || 0,
    cpuMs: Number(stats.cpu_stats?.cpu_usage?.total_usage ?? 0) / 1e6,
    mem: Math.max(0, Number(memory.usage ?? 0) - Number(memory.stats?.inactive_file ?? 0)),
  };
}

// Every running container of the first engine that answers, with the name of the process that is its machine.
// null when there is no engine. A container whose stats fail is left out; a list that fails throws.
export async function readContainers(): Promise<{ machine: string; containers: Container[] } | null> {
  const engine = ENGINES.find((e) => existsSync(e.socket));
  if (!engine) return null;
  const listed: any[] = await ask(engine.socket, "/containers/json");
  const read = await Promise.all(listed.map((c) => ask(engine.socket, `/containers/${c.Id}/stats?stream=false&one-shot=true`).then((stats) => containerOf(c, stats), () => null)));
  return { machine: engine.machine, containers: read.filter((c): c is Container => c !== null) };
}

// A container as a process inside its machine. Its pid is made from its id and is negative, so it can meet no real
// one and stays the same from tick to tick.
export function asProcs(containers: Container[], machine: Proc): Proc[] {
  return containers.map((c) => ({
    pid: -(1 + (Number.parseInt(c.id.slice(0, 12), 16) % 2_000_000_000)),
    ppid: machine.pid,
    uid: machine.uid,
    name: c.name,
    path: null,
    start: c.startedAt,
    cpuMs: c.cpuMs,
    childCpuMs: null,
    mem: c.mem,
    exact: true,
    read: null,
    written: null,
    inside: machine.pid,
  }));
}

// How far below a lane's folder a compose project may sit and still be the lane's: `infra/docker` in its worktree.
const DEPTH = 2;

// Whose a container is: the lane or pane that runs in the folder its compose project was started in, or up to two
// folders above it. The deepest such folder decides. Two owners in that one folder decide nothing, and neither does
// a lane that runs in the home folder or the root, which are above everything: the container stays with the app.
export function ownerByFolder(folder: string | null, running: { folder: string; owner: Owner }[], home: string): Owner | null {
  if (folder === null) return null;
  const below = (r: { folder: string }) => (folder === r.folder ? 0 : folder.startsWith(`${r.folder}/`) ? folder.slice(r.folder.length).split("/").filter(Boolean).length : Infinity);
  const over = running.filter((r) => r.folder !== home && r.folder !== "/" && below(r) <= DEPTH);
  const depth = Math.max(0, ...over.map((r) => r.folder.length));
  const deepest = over.filter((r) => r.folder.length === depth);
  const owners = new Set(deepest.map((r) => `${r.owner.kind}\0${r.owner.owner}`));
  return owners.size === 1 ? deepest[0].owner : null;
}
