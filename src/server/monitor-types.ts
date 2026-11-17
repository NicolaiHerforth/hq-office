// THE MONITOR's shapes: what a source reads from the machine (a Reading), who a process belongs to (an Owner), and
// what one tick stores (Usage rows and one HostUsage). docs/monitor.md has the model and the arithmetic.

// One process as a source read it. Times and byte counts are totals since the process started; the sampler turns
// two readings into what was used in between.
export type Proc = {
  pid: number;
  ppid: number;
  uid: number;
  // The executable's name. Never its arguments: a command line carries tokens.
  name: string;
  // The executable's path, to tell an app's bundle from a system daemon. In memory only, never stored.
  path: string | null;
  // When it started (epoch seconds), so a reused pid is not taken for the same process. 0 when the source cannot say.
  start: number;
  cpuMs: number;
  // CPU time of its children that have exited and been collected, their own children included. null when unreadable.
  childCpuMs: number | null;
  // Bytes of memory it holds. exact: its footprint (what it would free, compressed and swapped pages included).
  // Otherwise its resident size, which leaves those pages out and counts shared ones more than once.
  mem: number;
  exact: boolean;
  // Bytes read from and written to disk. null when unreadable.
  read: number | null;
  written: number | null;
  // Set on what is not a process of its own but runs inside one, such as a container in a virtual machine: the pid
  // of that process. What it used and holds is part of that process's figures, and is taken off them.
  inside?: number;
};

// The machine as a whole. busyMs, idleMs and the page counters are totals since boot; the rest is as of now.
export type Host = {
  cores: number;
  busyMs: number;
  idleMs: number;
  load1: number;
  memTotal: number;
  memFree: number;
  // What MACHINES counts as not used (machine-stats.sh): free, inactive and speculative pages. Not stored: it is
  // only there so MACHINES can take this machine's memory reading from a tick (monitor-machine.ts).
  memReclaimable?: number;
  memWired: number;
  // Anonymous memory that is not compressed: what apps hold in RAM.
  memApp: number;
  // File pages kept in RAM: given back the moment something needs the room.
  memCached: number;
  // RAM the compressor occupies, and how much memory is stored in it.
  memCompressed: number;
  memStored: number;
  swapTotal: number;
  swapUsed: number;
  // The kernel's memory pressure level: 1 normal, 2 warn, 4 critical. null when unreadable.
  pressure: 1 | 2 | 4 | null;
  // Percent of memory the kernel counts as available. null when unreadable.
  available: number | null;
  pageins: number;
  pageouts: number;
  swapins: number;
  swapouts: number;
  // The thermal pressure level: 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping. null when unreadable.
  thermal: number | null;
  diskTotal: number | null;
  diskFree: number | null;
  // When the machine started (epoch seconds): a reading with another value was taken after a restart. null when
  // unreadable.
  bootAt: number | null;
};

// A herdr pane: the shell it runs and, when an agent in it has a name, that name.
export type Pane = { pane: string; shellPid: number; lane: string | null; cwd: string | null };

export type Reading = { at: number; procs: Proc[]; host: Host };

// What attribution may ask about one process when the parent chain alone does not say whose it is. Each answer is
// null when it cannot be read.
export type Lookup = {
  // The herdr pane it was started from: the HERDR_PANE_ID it inherited. A server a lane starts and detaches has
  // launchd for a parent, and still carries its pane.
  launchPane(p: Proc): string | null;
  // Its working folder.
  cwd(p: Proc): string | null;
  // The pid macOS holds responsible for it: the app a system helper works for.
  responsible(p: Proc): number | null;
};

// The unit of blame. owner is who the owner of the machine recognises; name is what that owner ran.
//   lane    a named herdr agent and everything under its pane        owner: the agent's name
//   pane    a herdr pane without a named agent                       owner: its folder, as ~/…
//   app     an app bundle with all its helpers                       owner: the app's name
//   hq      this server and what it starts                           owner: "HQ Office"
//   system  other users' processes and the system's own              owner: "system"
//   other   the user's processes that fit none of the above          owner: the folder they run in, as ~/…, or "other"
//   lost    CPU the host spent that no readable process accounts for owner: "kernel and unattributed"
export type OwnerKind = "lane" | "pane" | "app" | "hq" | "system" | "other" | "lost";
export type Owner = { kind: OwnerKind; owner: string; name: string };

// What one owner's processes of one name used during a tick, and held at its end.
export type Usage = Owner & { cpuMs: number; memKb: number; n: number; readKb: number; writtenKb: number };

// The machine during a tick. dtMs is the time since the reading before; 0 for the first one after a start, when
// nothing can be said about the tick's CPU.
export type HostUsage = {
  dtMs: number;
  cores: number;
  busyMs: number;
  load1: number;
  memTotalKb: number;
  memFreeKb: number;
  memReclaimableKb?: number;
  memWiredKb: number;
  memAppKb: number;
  memCachedKb: number;
  memCompressedKb: number;
  memStoredKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  pressure: 1 | 2 | 4 | null;
  available: number | null;
  pageins: number;
  pageouts: number;
  swapins: number;
  swapouts: number;
  thermal: number | null;
  diskTotalKb: number | null;
  diskFreeKb: number | null;
  bootAt: number | null;
  // What all the tick's rows hold together.
  heldKb: number;
  // What the monitor itself cost in this tick: its CPU (the processes it starts included) and the memory its
  // process holds.
  selfCpuMs: number;
  selfMemKb: number;
};
