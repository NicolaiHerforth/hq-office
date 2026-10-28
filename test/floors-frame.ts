// The signed design's own office, for frame pairs: `bun test/floors-fixture.ts --frame` seeds a throwaway office with the
// prototype's floors, lanes, projects, rooms and questions (floors-design/snap-f8b/floors.html, its data block at
// "the office at Mon 26 Oct, 17:40"), so a hub capture of the build and of the prototype show the same office. Test
// data only; placeholder names, as in the prototype. Never points at a real server, hud.db or herdr.
//
// What the build cannot take from the prototype, and does instead:
// - The tree. The prototype names each lane's floor, not its parent; the app finds floors from parents (a lane under HQ
//   heads a floor when something sits two levels below it). PARENTS below gives each general a PM with a builder under it.
//   The prototype's own "HQ" lane is HQ itself, so it is not registered.
// - The states. The prototype ranks a lane: blocked, then an open question ("waiting on you"), then its base state. The app
//   reads "waiting on you" only for a lane that is not working, so a lane with an open question is idle in the stub herdr.
//   Base states: work = working; blocked = at a prompt; stalled = idle for 40 minutes; ci = working, phase waiting;
//   gen and idle = idle (waiting on HQ).
// - Times. The prototype's clock is 17:40; here ages and times are counted back from now, and a due time is the next one.
// - Kinds. APPROVAL is a decision here; SECRET is an action that asks for one secret by name.
// - Machines and accounts. The server reads them from herdr and two scripts on each machine; frameStubs puts stand-ins for
//   herdr, python3, sh and ssh first on the server's PATH, which answer with the prototype's two machines (laptop and hub),
//   each lane on its machine and account, and the numbers its ACCOUNTS and MACHINES panels draw.
// - The messages you sent. A note in the app goes to HQ, so only the one the prototype sent to HQ is seeded; its notes to
//   SALES and PEOPLE have no place here.
// - Question numbers, the colours and order of the floors and RUNDOWN's words are the app's own, not seeded.
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Post = (path: string, body: object) => Promise<any>;
const MIN = 60_000;

// Each lane's parent; a lane not listed reports straight to HQ.
const PARENTS: Record<string, string> = {
  "chat-ope-1812": "chat-pm", "search-ope-1831": "chat-pm", "docs-ope-1822": "chat-pm", "home-ope-1799": "wf-pm", "hooks-ope-3540": "jobs-pm",
  outb: "sales", "outb-ope-3004": "outb", "outb-lists": "outb", mkt: "sales",
  books: "finance", invoices: "books", runway: "finance",
  hiring: "people", contracts: "hiring",
  onboarding: "support", tickets: "onboarding",
};
type Q = { id: string; floor: string; t: string; pm: string; work: string; project: string; age: number; title: string; means: string; opts: string[]; rec: number; why: string; from?: string; due?: string; back?: boolean; thread?: [string, string, string][]; bg?: string };
const QUESTIONS = (): Q[] => [...DATA.RICH, ...DATA.EXTRA];
const isLane = (name: string) => name !== "HQ" && DATA.LANES.some((l) => l[0] === name);

// The lanes in registration order (parents first), with what the stub herdr says of each.
export function frameLanes() {
  const asking = new Set(QUESTIONS().map((q) => q.pm));
  const lanes = DATA.LANES.filter(([name]) => name !== "HQ").map(([name, , base, doing, account, machine]) => ({
    name,
    parent: PARENTS[name],
    title: doing,
    herdr: (base === "blocked" ? "blocked" : asking.has(name) || ["stalled", "gen", "idle"].includes(base) ? "idle" : "working") as "working" | "idle" | "blocked",
    phase: base === "ci" ? "waiting" : undefined,
    stalled: base === "stalled",
    machine: machine as string,
    account: account as string,
    issue: [...new Set(QUESTIONS().filter((q) => q.pm === name && q.work).map((q) => q.work))].join(" ") || undefined,
  }));
  const depth = (n: string): number => (PARENTS[n] ? 1 + depth(PARENTS[n]) : 1);
  return lanes.sort((a, b) => depth(a.name) - depth(b.name));
}
// The lane at a prompt in herdr.
export const frameBlocked = (): string => DATA.LANES.find((l: string[]) => l[2] === "blocked")[0];

// The prototype's machines and accounts, as its MACHINES and ACCOUNTS panels draw them (machinesP and accountsP): how busy
// each machine is, and what each account has left. Its panels draw one number per account; both windows get it here.
const MACHINE_STATS: Record<string, string> = { laptop: "cores=10 load1=4.1 cpu_busy=41 mem_used=52", hub: "cores=16 load1=9.3 cpu_busy=58 mem_used=61" };
const LEFT: Record<string, number> = { work: 62, "work-2": 23, codex: 80 };
function accountsOn(machine: string) {
  const used = [...new Set(frameLanes().filter((l) => l.machine === machine).map((l) => l.account))].sort();
  const both = (left: number) => ({ session: { left, resets_at: null }, weekly: { left, resets_at: null } });
  return {
    claude: { homes: used.filter((a) => a !== "codex").map((name) => ({ name, logged_in: true, windows: both(LEFT[name]) })) },
    codex: used.filter((a) => a === "codex").map((name) => ({
      name, logged_in: true, shares_sessions_with: [],
      reading: { at: new Date().toISOString(), windows: [300, 10080].map((minutes) => ({ minutes, used: 100 - LEFT[name], resets_at: null })) },
    })),
  };
}

// Stand-ins the frame's server finds first on its PATH, in `data`/bin, and the environment that makes it see two machines.
// herdr lists each machine's lanes and names the hub; python3 and sh answer the account and machine scripts here, ssh
// answers them on the hub; anything else goes to the real python3 and sh.
export function frameStubs(data: string, paneFile: string) {
  const bin = join(data, "bin");
  mkdirSync(bin);
  const lanes = frameLanes(), blocked = lanes.findIndex((l) => l.name === frameBlocked());
  // HQ's own agent is on the laptop, so the page's "HQ ISN'T RECEIVING" banner stays out of the way of the room
  const hq = { name: "hq", agent_status: "idle", pane_id: "w1:hq", agent: "claude" };
  const agents = (machine: string) => JSON.stringify({ result: { agents: [...lanes.flatMap((l, i) => (l.machine === machine ? [{ name: l.name, agent_status: l.herdr, pane_id: `w1:p${i}`, agent: l.account === "codex" ? "codex" : "claude" }] : [])), ...(machine === "laptop" ? [hq] : [])] } });
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh
${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  script("herdr", `case "$*" in
  *"machine list"*) echo '[{"label":"hub","target":"hub.example"}]' ;;
  *"--machine hub agent list"*) echo '${agents("hub")}' ;;
  *"agent list"*) echo '${agents("laptop")}' ;;
  *"pane read w1:p${blocked} "*) cat "${paneFile}" ;;
esac
exit 0
`);
  script("python3", `case "$*" in
  *account-stats.py*) echo '${JSON.stringify(accountsOn("laptop"))}' ;;
  *) exec ${Bun.which("python3") ?? "false"} "$@" ;;
esac
`);
  script("sh", `case "$1" in
  *machine-stats.sh) echo '${MACHINE_STATS.laptop}' ;;
  *) exec /bin/sh "$@" ;;
esac
`);
  script("ssh", `case "$*" in
  *"python3 -I -") echo '${JSON.stringify(accountsOn("hub"))}' ;;
  *" sh -s") echo '${MACHINE_STATS.hub}' ;;
  *) exit 255 ;;
esac
`);
  return { herdr: join(bin, "herdr"), env: { PATH: `${bin}:${process.env.PATH}`, HUD_MACHINES: "laptop,hub", HUD_LOCAL_MACHINE: "laptop" } };
}

// The next time of day `hhmm` (today if still to come), or on weekday `day` (SUN to SAT).
function next(now: number, hhmm = "23:59", day?: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (day) {
    const want = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(day);
    d.setDate(d.getDate() + ((want - d.getDay() + 7) % 7 || 7));
  } else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
// "20:00", "SAT" or "TUE 09:00" as a time.
function dueOf(now: number, due: string) {
  const [a, b] = due.split(" ");
  return /^\d/.test(a) ? next(now, a) : next(now, b, a);
}

export async function seedFrame(post: Post, data: string, base: string) {
  const now = Date.now();
  const must = async (path: string, body: object) => {
    const r = await post(path, body);
    if (r?.error) throw new Error(`${path}: ${r.error}`);
    return r;
  };
  // The projects, each a conference room on its owner's floor, in the prototype's wall order.
  for (const p of DATA.PROJECTS) {
    const room = p.room ? DATA.ROOMS[p.room] : null;
    const members = (room?.lanes ?? []).filter((l: string) => isLane(l) && l !== p.owner);
    await must("/api/rooms", { slug: p.id, title: p.title, owner: p.owner, members, prs: p.prs.map(([pr]: string[]) => pr.replace(/^PR #/, "")) });
    if (room) await must(`/api/rooms/${p.id}/brief`, { body: room.brief });
    for (const [i, [kind, title]] of p.arts.entries()) {
      const ext = kind === "IMAGE" ? (/\.\w+$/.test(title) ? "" : ".png") : "";
      const file = /\.\w+$/.test(title) ? title : `${i + 1}${ext}`;
      await must(`/api/rooms/${p.id}/artifacts`, { title, url: `https://example.com/${p.id}/${encodeURIComponent(file)}` });
    }
    for (const [who, , text] of room?.thread ?? []) {
      if (who === "YOU") await must(`/api/rooms/${p.id}/post`, { text, to: p.owner });
      else await must(`/api/rooms/${p.id}/say`, { text, as: who === "HQ" ? "hq" : who });
    }
  }
  // The open questions, oldest first.
  const back: number[] = [];
  for (const q of [...QUESTIONS()].sort((a, b) => b.age - a.age)) {
    const opt = q.opts[q.rec];
    const { id } = await must("/api/asks", {
      lane: q.pm === "HQ" ? null : q.pm,
      ...(q.project ? { room: q.project } : {}), // the project the prototype tags it with; the one without a project names no room
      kind: q.t === "x" || q.t === "s" ? "action" : "decision",
      title: q.title,
      body: [q.means, q.why, q.bg].filter(Boolean).join("\n\n"),
      options: q.opts,
      recommended: opt,
      created_at: now - q.age * MIN,
      ...(q.due ? { due: dueOf(now, q.due) } : {}),
      ...(q.from ? { from: lowered(q.from.replace(/^HANDED IN BY /, "")) } : {}),
      ...(q.t === "s" ? { secrets: ["FUND_A_SSO_CLIENT_SECRET"] } : {}),
    });
    for (const [who, , text] of q.thread ?? []) {
      if (who === "YOU") await must(`/api/asks/${id}/talk`, { text, to: "hq" });
      else await must(`/api/asks/${id}/comment`, { text, as: who === "HQ" ? null : who });
    }
    if (q.back) back.push(id);
  }
  // Deferred, until the time each one names.
  for (const [, , title, when, lane] of DATA.DEFERRED) {
    const [, day, hhmm] = when.match(/BACK (\w{3}) (\d\d:\d\d)/)!;
    const { id } = await must("/api/asks", { lane, kind: "decision", title, created_at: now - 600 * MIN });
    await must(`/api/asks/${id}/defer`, { until: next(now, hhmm, day) });
  }
  // Answered today: [time, title, your answer, route, state, what was done].
  for (const [, title, answer, route, state] of DATA.ANSWERED) {
    const { id } = await must("/api/asks", { lane: route.split(" → ")[1], kind: "decision", title });
    await must(`/api/asks/${id}/answer`, { answer });
    if (state === "acted") await must(`/api/asks/${id}/ack`, {});
  }
  // The generals' updates, oldest first; the ones the prototype shows as read are read.
  for (const [, , title, text, unread, lane] of [...DATA.UPDATES].reverse()) {
    const { id } = await must("/api/updates", { lane, title, body: text });
    if (!unread) await must(`/api/updates/${id}/read`, {});
  }
  // The note the prototype sent to HQ, read.
  for (const [, to, text] of [...SENT].reverse().filter(([, to]) => to === "HQ")) {
    await must("/api/notes", { text });
    // A Tell is a queue item for HQ (q<N>), no longer a note: HQ closing it is what reads it.
    const queued = await (await fetch(`${base}/api/requests`)).json();
    await must(`/api/requests/${queued.find((r: any) => r.text === text).id}/close`, { reason: "read" });
  }
  await must("/api/sync", {});
  // Only this fixture's own throwaway database: the rooms were opened a minute apart in wall order (created together, they
  // would hang by name), each Claude lane is on its account, the stalled lanes have been idle 40 minutes, and the question that came back from a deferral came
  // back a minute ago.
  const db = new Database(join(data, "hud.db"));
  db.exec("PRAGMA busy_timeout = 5000;"); // the server may still be writing after the sync
  DATA.PROJECTS.forEach((p: any, i: number) => db.query("UPDATE rooms SET created_at = ? WHERE slug = ?").run(now - (DATA.PROJECTS.length - i) * MIN, p.id));
  for (const l of frameLanes().filter((l) => l.stalled)) db.query("UPDATE lanes SET herdr_since = ? WHERE name = ?").run(now - 40 * MIN, l.name);
  for (const l of frameLanes().filter((l) => l.account !== "codex")) db.query("INSERT INTO lane_accounts (lane, account, moved_at) VALUES (?, ?, ?)").run(l.name, l.account, now);
  for (const id of back) db.query("INSERT INTO ask_defers (ask_id, from_at, to_at) VALUES (?, ?, ?)").run(id, now - 2 * MIN, now - MIN);
  db.close();
  await must("/api/lanes", { name: frameLanes().find((l) => l.stalled)!.name }); // a write, so the page's next state carries them
}

// What the prototype's owner sent, newest first (its SENT, beside the data block): time, to whom, the text.
const SENT = [["17:31", "HQ", "Where are we with the meetings?"], ["16:40", "SALES", "Fund A first. Anything that blocks their paid decision goes to HQ today."], ["14:02", "PEOPLE", "Hold the founding engineer role open until I’ve seen the three."]];

// The prototype's data block, as its page evaluates it: made by running snap-f8b/floors.html's script from `const NOW` up to
// `const SENT` and printing NOW, FLOORS, LANES, PROJECTS, RICH, EXTRA, DEFERRED, ANSWERED, ROOMS and UPDATES as JSON. Remake it
// the same way rather than editing it by hand.
const FRAME_DATA: any = {
 "NOW": 1060,
 "FLOORS": {
  "hq": {
   "name": "HQ",
   "shirt": "#3c6fd6",
   "model": "OPUS",
   "pane": "laptop w1:p1",
   "resp": "Product and engineering"
  },
  "sales": {
   "name": "SALES",
   "shirt": "#2f9e57",
   "model": "OPUS",
   "pane": "laptop w4E:p1",
   "resp": "Sales, marketing and top of funnel"
  },
  "finance": {
   "name": "FINANCE",
   "shirt": "#e0901e",
   "model": "OPUS",
   "pane": "hub w3:p1",
   "resp": "Books, invoices, payments and runway"
  },
  "people": {
   "name": "PEOPLE",
   "shirt": "#e05fa8",
   "model": "OPUS",
   "pane": "hub w3:p4",
   "resp": "Hiring, contractors and advisors"
  },
  "support": {
   "name": "SUPPORT",
   "shirt": "#9a5fe0",
   "model": "OPUS",
   "pane": "laptop w4F:p1",
   "resp": "Pilots and customers, from first login on"
  }
 },
 "LANES": [
  [
   "HQ",
   "hq",
   "work",
   "Orchestrating three PMs",
   "work",
   "laptop",
   ""
  ],
  [
   "chat-pm",
   "hq",
   "work",
   "Thread search: migration at 23:00",
   "work",
   "laptop",
   "thread-search"
  ],
  [
   "wf-pm",
   "hq",
   "work",
   "Memory: two designs written",
   "work",
   "laptop",
   "memory"
  ],
  [
   "jobs-pm",
   "hq",
   "work",
   "Retries and nightly jobs",
   "work",
   "hub",
   "jobs"
  ],
  [
   "home-ope-1799",
   "hq",
   "work",
   "Home screen: empty states",
   "work",
   "hub",
   "home"
  ],
  [
   "chat-ope-1812",
   "hq",
   "ci",
   "Fund A Drive: the spike",
   "work",
   "laptop",
   "fund-a-drive"
  ],
  [
   "hooks-ope-3540",
   "hq",
   "blocked",
   "At a permission prompt in hub w2:p3 since 17:02",
   "codex",
   "hub",
   "hooks"
  ],
  [
   "hq2",
   "hq",
   "gen",
   "herdr 0.9: waits on HQ to hand it over",
   "work",
   "hub",
   "jobs"
  ],
  [
   "docs-ope-1822",
   "hq",
   "stalled",
   "Search help pages: no change since 15:20",
   "work",
   "hub",
   "thread-search"
  ],
  [
   "search-ope-1831",
   "hq",
   "work",
   "Thread search: result ranking",
   "work",
   "laptop",
   "thread-search"
  ],
  [
   "SALES",
   "sales",
   "work",
   "Tomorrow’s four calls",
   "work-2",
   "laptop",
   ""
  ],
  [
   "outb",
   "sales",
   "work",
   "Call prep: Lender H, Partner C",
   "work-2",
   "laptop",
   "calls"
  ],
  [
   "outb-ope-3004",
   "sales",
   "work",
   "Lender A’s budget email",
   "work-2",
   "laptop",
   "lender-a"
  ],
  [
   "outb-lists",
   "sales",
   "work",
   "Three CRM changes",
   "work-2",
   "laptop",
   "pipeline"
  ],
  [
   "mkt",
   "sales",
   "idle",
   "Launch post, parked",
   "work-2",
   "laptop",
   "launch"
  ],
  [
   "FINANCE",
   "finance",
   "work",
   "October close",
   "work",
   "hub",
   ""
  ],
  [
   "books",
   "finance",
   "work",
   "212 of 240 lines matched",
   "work",
   "hub",
   "october-close"
  ],
  [
   "runway",
   "finance",
   "work",
   "Cloud bill and runway",
   "work",
   "hub",
   "cloud-bill"
  ],
  [
   "invoices",
   "finance",
   "work",
   "Client M #0007",
   "work",
   "hub",
   "invoices"
  ],
  [
   "PEOPLE",
   "people",
   "idle",
   "Waits for interviews",
   "work",
   "hub",
   ""
  ],
  [
   "hiring",
   "people",
   "work",
   "Founding engineer shortlist",
   "work",
   "hub",
   "founding-eng"
  ],
  [
   "contracts",
   "people",
   "stalled",
   "November renewals: no change since 13:10",
   "work",
   "hub",
   "contracts"
  ],
  [
   "SUPPORT",
   "support",
   "work",
   "Fund A and Lender A pilots",
   "work",
   "laptop",
   ""
  ],
  [
   "tickets",
   "support",
   "work",
   "Export drops accents",
   "work",
   "laptop",
   "export-accents"
  ],
  [
   "onboarding",
   "support",
   "work",
   "Fund A’s three logins",
   "work",
   "laptop",
   "fund-a-pilot"
  ]
 ],
 "PROJECTS": [
  {
   "id": "thread-search",
   "floor": "hq",
   "title": "Thread search",
   "owner": "chat-pm",
   "state": "moving",
   "prog": 0.8,
   "room": "thread-search",
   "prs": [
    [
     "PR #3509",
     "GREEN"
    ]
   ],
   "arts": [
    [
     "LINK",
     "Migration plan"
    ],
    [
     "DESIGN",
     "Search results, one screen"
    ]
   ],
   "last": "#3509 green, migrates at 23:00"
  },
  {
   "id": "fund-a-drive",
   "floor": "hq",
   "title": "Fund A Drive",
   "owner": "chat-ope-1812",
   "state": "moving",
   "prog": 0.2,
   "room": "fund-a-drive",
   "prs": [
    [
     "PR #3571",
     "DRAFT"
    ]
   ],
   "arts": [
    [
     "DESIGN",
     "Drive picker, two screens"
    ],
    [
     "IMAGE",
     "attachment-inline.png"
    ]
   ],
   "last": "handed in by Sales at 16:20; spike running"
  },
  {
   "id": "memory",
   "floor": "hq",
   "title": "Memory",
   "owner": "wf-pm",
   "state": "moving",
   "prog": 0.3,
   "room": "workforce-memory",
   "prs": [
    [
     "PR #3561",
     "DRAFT"
    ]
   ],
   "arts": [
    [
     "DESIGN",
     "One table: one page"
    ],
    [
     "DESIGN",
     "One per kind: one page"
    ]
   ],
   "last": "two designs, one page each"
  },
  {
   "id": "hooks",
   "floor": "hq",
   "title": "Hooks",
   "owner": "hooks-ope-3540",
   "state": "moving",
   "prog": 0.4,
   "room": "",
   "prs": [
    [
     "PR #3540",
     "IN CI"
    ]
   ],
   "arts": [
    [
     "LINK",
     "The three-PR plan"
    ]
   ],
   "last": "PR 1 in CI"
  },
  {
   "id": "home",
   "floor": "hq",
   "title": "Home screen",
   "owner": "home-ope-1799",
   "state": "moving",
   "prog": 0.6,
   "room": "",
   "prs": [
    [
     "PR #3555",
     "OPEN"
    ]
   ],
   "arts": [
    [
     "DESIGN",
     "Empty states"
    ]
   ],
   "last": "empty states"
  },
  {
   "id": "jobs",
   "floor": "hq",
   "title": "Jobs",
   "owner": "jobs-pm",
   "state": "moving",
   "prog": 0.5,
   "room": "",
   "prs": [
    [
     "PR #3548",
     "OPEN"
    ]
   ],
   "arts": [],
   "last": "retries in staging for a week"
  },
  {
   "id": "lender-a",
   "floor": "sales",
   "title": "Lender A",
   "owner": "outb-ope-3004",
   "state": "moving",
   "prog": 0.7,
   "room": "",
   "prs": [],
   "arts": [
    [
     "EMAIL",
     "The reconciled budget, draft"
    ],
    [
     "FILE",
     "reconciliation.xlsx"
    ]
   ],
   "last": "closest to paid"
  },
  {
   "id": "pipeline",
   "floor": "sales",
   "title": "Pipeline",
   "owner": "outb-lists",
   "state": "moving",
   "prog": 0.5,
   "room": "",
   "prs": [],
   "arts": [
    [
     "LINK",
     "The CRM, pipeline view"
    ]
   ],
   "last": "15 deals"
  },
  {
   "id": "calls",
   "floor": "sales",
   "title": "Tomorrow’s calls",
   "owner": "outb",
   "state": "moving",
   "prog": 0.5,
   "room": "",
   "prs": [],
   "arts": [
    [
     "DOC",
     "Prep: Lender H"
    ],
    [
     "DOC",
     "Prep: Partner C"
    ]
   ],
   "last": "2 of 4 prepped"
  },
  {
   "id": "launch",
   "floor": "sales",
   "title": "Launch post",
   "owner": "mkt",
   "state": "moving",
   "prog": 0.9,
   "room": "",
   "prs": [],
   "arts": [
    [
     "DOC",
     "The post, draft 3"
    ]
   ],
   "last": "parked until you pick a date"
  },
  {
   "id": "october-close",
   "floor": "finance",
   "title": "October close",
   "owner": "books",
   "state": "moving",
   "prog": 0.88,
   "room": "october-close",
   "prs": [],
   "arts": [
    [
     "LINK",
     "Unmatched lines"
    ]
   ],
   "last": "212 of 240 lines matched"
  },
  {
   "id": "cloud-bill",
   "floor": "finance",
   "title": "Cloud bill",
   "owner": "runway",
   "state": "moving",
   "prog": 0.5,
   "room": "",
   "prs": [],
   "arts": [
    [
     "FILE",
     "October bill"
    ]
   ],
   "last": "October up 38%"
  },
  {
   "id": "invoices",
   "floor": "finance",
   "title": "Invoices",
   "owner": "invoices",
   "state": "moving",
   "prog": 0.6,
   "room": "",
   "prs": [],
   "arts": [
    [
     "INVOICE",
     "Client M #0007"
    ]
   ],
   "last": "two waiting to go out"
  },
  {
   "id": "tax",
   "floor": "finance",
   "title": "Q3 sales tax",
   "owner": "FINANCE",
   "state": "moving",
   "prog": 0.95,
   "room": "",
   "prs": [],
   "arts": [
    [
     "LINK",
     "The state portal"
    ]
   ],
   "last": "needs your login, due Sat"
  },
  {
   "id": "founding-eng",
   "floor": "people",
   "title": "Founding engineer",
   "owner": "hiring",
   "state": "moving",
   "prog": 0.4,
   "room": "",
   "prs": [],
   "arts": [
    [
     "DOC",
     "Shortlist of three"
    ]
   ],
   "last": "shortlist of three"
  },
  {
   "id": "contracts",
   "floor": "people",
   "title": "Renewals",
   "owner": "contracts",
   "state": "moving",
   "prog": 0.3,
   "room": "",
   "prs": [],
   "arts": [
    [
     "DOC",
     "November renewals"
    ]
   ],
   "last": "no change since 13:10"
  },
  {
   "id": "fund-a-pilot",
   "floor": "support",
   "title": "Fund A pilot",
   "owner": "onboarding",
   "state": "moving",
   "prog": 0.6,
   "room": "",
   "prs": [],
   "arts": [
    [
     "EMAIL",
     "Logins and a walkthrough, draft"
    ]
   ],
   "last": "logins ready for Thursday"
  },
  {
   "id": "export-accents",
   "floor": "support",
   "title": "Export accents",
   "owner": "tickets",
   "state": "moving",
   "prog": 0.7,
   "room": "export-accents",
   "prs": [
    [
     "PR #3570",
     "APPROVED"
    ]
   ],
   "arts": [
    [
     "IMAGE",
     "export-before-after.png"
    ]
   ],
   "last": "one-line patch, reviewed"
  }
 ],
 "RICH": [
  {
   "id": "216",
   "floor": "sales",
   "t": "a",
   "pm": "outb-ope-3004",
   "work": "OPE-3004",
   "project": "lender-a",
   "age": 370,
   "title": "Send Lender A’s CFO the reconciled budget: £519 against £670, with a live test on 3 Nov?",
   "means": "Lender A is the deal closest to paid. This email answers their CFO’s last open question and asks for a test date. Nothing else waits on you for Lender A.",
   "opts": [
    "Approve and send",
    "Edit it first",
    "Don’t send"
   ],
   "rec": 0,
   "why": "The £151 gap was two duplicate August lines, now removed, and the export fix merged at 15:10, so the number is final. The CFO has waited since 21 Oct.",
   "thread": [
    [
     "outb-ope-3004",
     "15:20",
     "The £151 is two duplicate August lines; both are marked in the spreadsheet."
    ]
   ],
   "links": [
    [
     "THE DRAFT EMAIL",
     "k"
    ],
    [
     "RECONCILIATION.XLSX",
     "k"
    ]
   ],
   "bg": "Lender A has had the deck, the video and a login since 21 Oct. Their CFO asked one thing: why our budget output read **£670** when their own sheet said **£519**.\n- The export counted two August lines twice.\n- HQ fixed the export in PR #3566, merged at 15:10.\n- The draft names Tue 3 Nov for a live test with their analyst."
  },
  {
   "id": "215",
   "floor": "hq",
   "t": "d",
   "pm": "wf-pm",
   "work": "OPE-1840",
   "project": "memory",
   "age": 250,
   "title": "Memory: one table for every kind of memory, or one table per kind?",
   "means": "HQ asks this a second time, because #212 didn’t explain it. It decides how soon agents remember what you told them across lanes: one table ships Thursday, one per kind ships next Wednesday.",
   "opts": [
    "One table per kind",
    "One table for every kind"
   ],
   "rec": 1,
   "why": "Every lookup planned for the next two months reads across kinds, and one table keeps those lookups simple. If one kind outgrows it, moving that kind out is a day’s work.",
   "links": [
    [
     "PR #3561",
     "pr"
    ],
    [
     "DESIGN PAGE",
     "k"
    ]
   ],
   "thread": [
    [
     "YOU",
     "13:25",
     "I need a better explanation of this. I don’t get it (#212)"
    ],
    [
     "HQ",
     "13:40",
     "Asked again as this one, with what it means for you first."
    ],
    [
     "wf-pm",
     "13:52",
     "Both designs are on the shelf in the room, one page each."
    ]
   ],
   "bg": "**One table:** every memory (a fact, a preference, a decision) is a row with a kind. One index, one place to search.\n**One table per kind:** facts, preferences and decisions each get their own table. Each can change shape alone, but a search across kinds reads three tables.\nwf-pm recommends one table. PR #3561 has both sketches."
  },
  {
   "id": "219",
   "floor": "hq",
   "t": "d",
   "pm": "chat-pm",
   "work": "OPE-1812",
   "project": "fund-a-drive",
   "age": 75,
   "title": "Fund A’s Drive read and write: build it before thread search, or after?",
   "means": "Before: Fund A can go paid around 4 Nov, and thread search moves from 2 Nov to 6 Nov. After: search keeps 2 Nov, and Fund A waits until about 10 Nov.",
   "opts": [
    "Before thread search",
    "After thread search"
   ],
   "rec": 0,
   "why": "Fund A is the only pilot ready to pay, and Sales says Drive is the one thing in the way. No customer waits on search’s date.",
   "from": "HANDED IN BY SALES",
   "links": [
    [
     "PR #3571",
     "pr"
    ]
   ],
   "thread": [
    [
     "chat-pm",
     "16:25",
     "Sized at four days for one builder."
    ],
    [
     "SALES",
     "16:31",
     "Fund A’s paid decision waits on it. Their ops lead confirmed by email."
    ]
   ],
   "bg": "Sales handed this to HQ at 16:20, with the deal it blocks. Fund A’s three named users want Drive files attached in threads and shown inline."
  },
  {
   "id": "221",
   "floor": "finance",
   "t": "d",
   "pm": "runway",
   "work": "",
   "project": "cloud-bill",
   "age": 42,
   "title": "The cloud bill rose 38% in October: cap it at $900 a month, or let it run?",
   "means": "A cap pauses the hub’s builders when it is reached, likely around the 25th of each month. No cap means about $1,150 in November.",
   "opts": [
    "Cap it at $900",
    "Let it run, review in December"
   ],
   "rec": 1,
   "why": "A pause would stop Fund A’s Drive work near its date. The rise is the hub’s extra disk and two always-on lanes, both planned.",
   "links": [
    [
     "OCTOBER BILL",
     "k"
    ]
   ],
   "bg": "October: **$1,104**, against $800 in September.\n- The hub’s extra disk: +$120.\n- Two always-on lanes: +$184."
  },
  {
   "id": "222",
   "floor": "support",
   "t": "d",
   "pm": "tickets",
   "work": "OPE-1830",
   "project": "export-accents",
   "age": 12,
   "title": "Lender A’s export drops accented names: patch their copy now, or wait for the 6 Nov release?",
   "means": "Their analyst sees broken names in every export until it is fixed. The patch touches only their workspace, tonight.",
   "opts": [
    "Patch it now",
    "Wait for 6 Nov"
   ],
   "rec": 0,
   "why": "It is a one-line patch that HQ has already reviewed, and Lender A is the deal closest to paid.",
   "due": "20:00",
   "links": [
    [
     "PR #3570",
     "pr"
    ]
   ],
   "thread": [
    [
     "tickets",
     "17:30",
     "HQ reviewed the patch: the same line as the 6 Nov fix."
    ]
   ],
   "bg": "Found by Lender A’s analyst on 24 Oct: a name like “José” comes out as “Jos?”. The fix is in PR #3570 for 6 Nov."
  }
 ],
 "EXTRA": [
  {
   "id": "170",
   "floor": "hq",
   "t": "d",
   "pm": "jobs-pm",
   "work": "OPE-1760",
   "project": "jobs",
   "age": 1210,
   "title": "Retries: give up after 3 tries, or keep trying for an hour?",
   "means": "Decides what a member sees when a job fails: an error at once, or a wait.",
   "opts": [
    "3 tries, then an error",
    "Keep trying for an hour"
   ],
   "rec": 0,
   "why": "Members told Support they would rather know. An hour of silence reads as broken."
  },
  {
   "id": "171",
   "floor": "hq",
   "t": "d",
   "pm": "home-ope-1799",
   "work": "OPE-1799",
   "project": "home",
   "age": 980,
   "title": "Home screen: show empty sections, or hide them until they have something?",
   "means": "First-day members see either a full-looking page with blanks, or a short page that grows.",
   "opts": [
    "Hide them until filled",
    "Show them empty"
   ],
   "rec": 0,
   "why": "Fund A’s ops lead read the blanks as broken on the 23 Oct call."
  },
  {
   "id": "172",
   "floor": "hq",
   "t": "a",
   "pm": "hooks-ope-3540",
   "work": "OPE-3540",
   "project": "hooks",
   "age": 860,
   "title": "Merge hooks PR 1: run hooks after a tool call, observe only",
   "means": "Hooks start logging what tools did. Nothing they do can block a run yet.",
   "opts": [
    "Approve the merge",
    "Hold it"
   ],
   "rec": 0,
   "why": "Codex review passed and it changes no behaviour; PR 2 builds on it.",
   "links": [
    [
     "PR #3540",
     "pr"
    ]
   ]
  },
  {
   "id": "173",
   "floor": "hq",
   "t": "d",
   "pm": "chat-pm",
   "work": "OPE-1777",
   "project": "thread-search",
   "age": 720,
   "title": "Thread search: search attachments’ text too, or only messages?",
   "means": "Attachments double the index and push search from 2 Nov to 4 Nov.",
   "opts": [
    "Messages only, attachments next",
    "Both now"
   ],
   "rec": 0,
   "why": "Fund A asked for message search; nobody has asked for attachments."
  },
  {
   "id": "174",
   "floor": "hq",
   "t": "d",
   "pm": "wf-pm",
   "work": "OPE-1841",
   "project": "memory",
   "age": 640,
   "title": "Workforce: may a PM start a builder without asking HQ first?",
   "means": "Fewer questions reach you through HQ, and more builders run at once.",
   "opts": [
    "Yes, up to two each",
    "No, ask HQ"
   ],
   "rec": 0,
   "why": "HQ approved 18 of the last 19 starts unchanged."
  },
  {
   "id": "175",
   "floor": "hq",
   "t": "d",
   "pm": "jobs-pm",
   "work": "OPE-1765",
   "project": "jobs",
   "age": 560,
   "title": "Nightly jobs: run them on the hub, or on the laptop when it is open?",
   "means": "The hub costs about $40 a month more; the laptop misses nights it is closed.",
   "opts": [
    "The hub",
    "The laptop"
   ],
   "rec": 0,
   "why": "Three of the last seven nights the laptop was closed and jobs waited."
  },
  {
   "id": "176",
   "floor": "hq",
   "t": "x",
   "pm": "home-ope-1799",
   "work": "OPE-1802",
   "project": "home",
   "age": 480,
   "title": "Record a 30-second voice-over for the home screen demo",
   "means": "Thursday’s walkthrough for Fund A has a demo with no sound yet.",
   "opts": [
    "Done",
    "Not this week"
   ],
   "rec": 0,
   "why": "It is your voice the pilot users know."
  },
  {
   "id": "177",
   "floor": "hq",
   "t": "d",
   "pm": "chat-pm",
   "work": "OPE-1790",
   "project": "thread-search",
   "age": 300,
   "title": "Notes: one start time per meeting, or each attendee’s own?",
   "means": "Changes how a meeting with late joiners reads in the notes.",
   "opts": [
    "One per meeting",
    "Each attendee’s own"
   ],
   "rec": 0,
   "why": "One time is what a calendar shows; nobody reads per-attendee times."
  },
  {
   "id": "178",
   "floor": "hq",
   "t": "a",
   "pm": "jobs-pm",
   "work": "OPE-1766",
   "project": "jobs",
   "age": 190,
   "title": "Turn on retries for the export jobs in production",
   "means": "Failed exports retry three times before anyone sees an error.",
   "opts": [
    "Approve",
    "Not yet"
   ],
   "rec": 0,
   "why": "It ran a week in staging with no duplicate exports."
  },
  {
   "id": "179",
   "floor": "hq",
   "t": "d",
   "pm": "HQ",
   "work": "OPE-1850",
   "project": "",
   "age": 150,
   "title": "herdr 0.9: upgrade both machines tonight, or wait for 0.9.1?",
   "means": "Upgrading restarts every lane once, for about two minutes.",
   "opts": [
    "Tonight, after 23:00",
    "Wait for 0.9.1"
   ],
   "rec": 0,
   "why": "0.9 fixes the dropped name that stops HQ receiving.",
   "back": true
  },
  {
   "id": "180",
   "floor": "hq",
   "t": "d",
   "pm": "wf-pm",
   "work": "OPE-1845",
   "project": "memory",
   "age": 95,
   "title": "Where does a piece of work’s brief live: its conference room, or Linear?",
   "means": "Decides where you read what a piece of work is for.",
   "opts": [
    "In its room",
    "In Linear"
   ],
   "rec": 0,
   "why": "The room is kept current by the lane that owns it; Linear issues go stale."
  },
  {
   "id": "181",
   "floor": "hq",
   "t": "a",
   "pm": "chat-ope-1812",
   "work": "OPE-1812",
   "project": "fund-a-drive",
   "age": 55,
   "title": "Give the Drive spike read access to the shared test drive",
   "means": "The spike can open real files from the test drive; it writes nothing.",
   "opts": [
    "Approve",
    "Not yet"
   ],
   "rec": 0,
   "why": "Without it the spike tests against a mock and proves little."
  },
  {
   "id": "182",
   "floor": "hq",
   "t": "d",
   "pm": "home-ope-1799",
   "work": "OPE-1806",
   "project": "home",
   "age": 30,
   "title": "Home screen: keep the greeting line, or start with the work?",
   "means": "One line of space on every member’s first screen.",
   "opts": [
    "Start with the work",
    "Keep the greeting"
   ],
   "rec": 0,
   "why": "Members scroll past it; the work is what they came for."
  },
  {
   "id": "183",
   "floor": "hq",
   "t": "d",
   "pm": "jobs-pm",
   "work": "OPE-1770",
   "project": "jobs",
   "age": 6,
   "title": "Job logs: keep 30 days, or 90?",
   "means": "90 days triples the log bill, to about $25 a month.",
   "opts": [
    "30 days",
    "90 days"
   ],
   "rec": 0,
   "why": "No one has opened a log older than nine days."
  },
  {
   "id": "184",
   "floor": "sales",
   "t": "d",
   "pm": "SALES",
   "work": "OPE-3010",
   "project": "pipeline",
   "age": 1500,
   "title": "Channel G wants to resell to brokers: move it from the pipeline to channel partners?",
   "means": "The pipeline drops to 14 deals; Channel G gets a partner’s terms, not a buyer’s.",
   "opts": [
    "Move it to channel partners",
    "Keep it in the pipeline"
   ],
   "rec": 0,
   "why": "Its founder said on Thursday’s call they won’t buy, only resell.",
   "due": "20:00"
  },
  {
   "id": "185",
   "floor": "sales",
   "t": "d",
   "pm": "outb",
   "work": "",
   "project": "calls",
   "age": 380,
   "title": "Lender H’s call is Tue 04:00 ET: hand it to the EU lead?",
   "means": "You skip a 4 am call; the EU lead takes it with the prep that is ready.",
   "opts": [
    "Hand it to the EU lead",
    "I take it"
   ],
   "rec": 0,
   "why": "It is 09:00 in London, and the prep answers their CTO’s question.",
   "due": "20:00"
  },
  {
   "id": "186",
   "floor": "sales",
   "t": "a",
   "pm": "outb-ope-3004",
   "work": "OPE-3004",
   "project": "pipeline",
   "age": 340,
   "title": "Send Agency E’s director the output he asked to review after the 21 Oct demo",
   "means": "Keeps a $500-a-month deal warm; the email also asks for a trial date.",
   "opts": [
    "Approve and send",
    "Return"
   ],
   "rec": 0,
   "why": "He asked for it five days ago and has heard nothing."
  },
  {
   "id": "187",
   "floor": "sales",
   "t": "a",
   "pm": "outb-ope-3004",
   "work": "OPE-3004",
   "project": "pipeline",
   "age": 260,
   "title": "Reply to Fund C’s partner with two dated slots",
   "means": "Closes a loop open since 12 Oct.",
   "opts": [
    "Approve and send",
    "Return"
   ],
   "rec": 0,
   "why": "Two slots this week; a vague reply would cost another round."
  },
  {
   "id": "188",
   "floor": "sales",
   "t": "a",
   "pm": "outb-lists",
   "work": "OPE-3011",
   "project": "pipeline",
   "age": 140,
   "title": "Write three pipeline changes to the CRM",
   "means": "Channel G to partners, Prospect K parked to January, Fund B added.",
   "opts": [
    "Approve",
    "Return"
   ],
   "rec": 0,
   "why": "All three follow calls you already made."
  },
  {
   "id": "189",
   "floor": "sales",
   "t": "d",
   "pm": "mkt",
   "work": "OPE-3020",
   "project": "launch",
   "age": 110,
   "title": "The launch post: publish Thursday, or after Fund A goes paid?",
   "means": "Thursday gets it out; waiting gives it a customer to name.",
   "opts": [
    "After Fund A goes paid",
    "Thursday"
   ],
   "rec": 0,
   "why": "A named customer is the post’s strongest line."
  },
  {
   "id": "190",
   "floor": "sales",
   "t": "x",
   "pm": "mkt",
   "work": "",
   "project": "launch",
   "age": 64,
   "title": "Forward the intro blurb to the introducer from your own inbox",
   "means": "Three intros wait on it; it reads better from you.",
   "opts": [
    "Done",
    "Not today"
   ],
   "rec": 0,
   "why": "He asked you directly on 6 Oct."
  },
  {
   "id": "191",
   "floor": "sales",
   "t": "d",
   "pm": "SALES",
   "work": "OPE-3012",
   "project": "pipeline",
   "age": 48,
   "title": "Partner C: price by seat, or by jobs done?",
   "means": "Sets the first number at Tuesday’s demo.",
   "opts": [
    "By jobs done",
    "By seat"
   ],
   "rec": 0,
   "why": "acme-example asked for the same, and it tracks the value they see."
  },
  {
   "id": "192",
   "floor": "sales",
   "t": "d",
   "pm": "outb",
   "work": "",
   "project": "calls",
   "age": 20,
   "title": "Bank B’s sponsor hasn’t sent his brief: hold Tuesday’s call anyway?",
   "means": "Without the brief, the call is discovery, not a pitch.",
   "opts": [
    "Hold it as discovery",
    "Move it a week"
   ],
   "rec": 0,
   "why": "Moving it loses the sponsor’s slot until November."
  },
  {
   "id": "193",
   "floor": "finance",
   "t": "a",
   "pm": "invoices",
   "work": "",
   "project": "invoices",
   "age": 2600,
   "title": "Pay widget-co’s October contractor invoice: $4,800, due Wednesday",
   "means": "Paid from the operating account.",
   "opts": [
    "Approve",
    "Return"
   ],
   "rec": 0,
   "why": "60 hours at $80: the signed rate."
  },
  {
   "id": "194",
   "floor": "finance",
   "t": "d",
   "pm": "runway",
   "work": "",
   "project": "cloud-bill",
   "age": 900,
   "title": "Runway: count Client M’s fee past December, or stop it there?",
   "means": "With it, runway reads 14 months; without, 11.",
   "opts": [
    "Stop at December",
    "Count it through March"
   ],
   "rec": 0,
   "why": "The agreement ends 31 Dec, and no renewal is signed."
  },
  {
   "id": "195",
   "floor": "finance",
   "t": "x",
   "pm": "FINANCE",
   "work": "",
   "project": "tax",
   "age": 520,
   "title": "Sign the Q3 sales-tax return in the state portal",
   "means": "It needs your login; everything else is filled in and checked.",
   "opts": [
    "Done",
    "Not today"
   ],
   "rec": 0,
   "why": "It is due Saturday, and the portal is slow at month end.",
   "due": "SAT"
  },
  {
   "id": "196",
   "floor": "finance",
   "t": "a",
   "pm": "invoices",
   "work": "",
   "project": "invoices",
   "age": 25,
   "title": "Send Client M invoice #0007: $6,000, net 15",
   "means": "The first invoice for paid revenue.",
   "opts": [
    "Approve and send",
    "Return"
   ],
   "rec": 0,
   "why": "It follows your call that the fee is company revenue."
  },
  {
   "id": "197",
   "floor": "finance",
   "t": "d",
   "pm": "books",
   "work": "",
   "project": "october-close",
   "age": 15,
   "title": "Two card payments have no receipts: write them off, or chase them?",
   "means": "$212 together. Chasing takes a week; writing off closes October tonight.",
   "opts": [
    "Write them off",
    "Chase them"
   ],
   "rec": 0,
   "why": "Less than the hour it would cost to chase them."
  },
  {
   "id": "198",
   "floor": "people",
   "t": "d",
   "pm": "hiring",
   "work": "",
   "project": "founding-eng",
   "age": 2200,
   "title": "Founding engineer: interview the three on the shortlist, or reopen at a higher band?",
   "means": "Interviews start Wednesday, or the role reopens for about three more weeks.",
   "opts": [
    "Interview the three",
    "Reopen at a higher band"
   ],
   "rec": 0,
   "why": "All three passed the take-home; reopening pushes the hire into December."
  },
  {
   "id": "199",
   "floor": "people",
   "t": "a",
   "pm": "contracts",
   "work": "",
   "project": "contracts",
   "age": 610,
   "title": "Renew the design contractor for November: 40 hours at the current rate",
   "means": "Keeps the screens moving through November at the same cost.",
   "opts": [
    "Approve",
    "Return"
   ],
   "rec": 0,
   "why": "October’s 40 hours shipped the Notes and Workforce screens."
  },
  {
   "id": "200",
   "floor": "people",
   "t": "d",
   "pm": "contracts",
   "work": "",
   "project": "contracts",
   "age": 140,
   "title": "Servicer F’s advisor: 0.25% equity over two years, or a fee per intro?",
   "means": "Equity ties him in; a fee keeps the cap table clean.",
   "opts": [
    "A fee per intro",
    "0.25% over two years"
   ],
   "rec": 0,
   "why": "Two leads in a month is promising, not yet proven.",
   "due": "TUE 09:00"
  },
  {
   "id": "201",
   "floor": "people",
   "t": "d",
   "pm": "hiring",
   "work": "",
   "project": "founding-eng",
   "age": 35,
   "title": "Ask the three candidates for references now, or after interviews?",
   "means": "References now add two days; after keeps the schedule.",
   "opts": [
    "After interviews",
    "Now"
   ],
   "rec": 0,
   "why": "Only the one you pick needs references."
  },
  {
   "id": "202",
   "floor": "support",
   "t": "a",
   "pm": "onboarding",
   "work": "",
   "project": "fund-a-pilot",
   "age": 1900,
   "title": "Approve Fund A’s onboarding email: three logins and a 30-minute walkthrough on Thursday",
   "means": "Fund A’s three users can start on Thursday.",
   "opts": [
    "Approve and send",
    "Return"
   ],
   "rec": 0,
   "why": "Their ops lead asked for it on the 23 Oct call."
  },
  {
   "id": "203",
   "floor": "support",
   "t": "x",
   "pm": "SUPPORT",
   "work": "",
   "project": "fund-a-pilot",
   "age": 8,
   "title": "Add Fund A’s ops lead as a guest in the pilot workspace",
   "means": "Thursday’s walkthrough needs it, and only an admin can do it.",
   "opts": [
    "Done",
    "Not today"
   ],
   "rec": 0,
   "why": "You are the only admin."
  },
  {
   "id": "204",
   "floor": "support",
   "t": "s",
   "pm": "onboarding",
   "work": "",
   "project": "fund-a-pilot",
   "age": 52,
   "title": "Paste Fund A’s SSO client secret, so their users log in with their own accounts",
   "means": "Onboarding reads it once to set up the login. The value never shows here, in a log or in a listing.",
   "opts": [
    "Paste it now",
    "Not today"
   ],
   "rec": 0,
   "why": "Their IT lead sent it to you, not to the lane."
  }
 ],
 "DEFERRED": [
  [
   "155",
   "hq",
   "Inbox queue trial: run the manual step on the hub",
   "BACK TUE 09:00",
   "jobs-pm"
  ],
  [
   "207",
   "sales",
   "Servicer F’s joint venture: inside the company, or a new entity?",
   "BACK WED 08:00 · before your 1:1",
   "outb"
  ]
 ],
 "ANSWERED": [
  [
   "17:31",
   "Thread search: run the index migration tonight?",
   "Tonight",
   "HQ → chat-pm",
   "acted",
   "17:33 · chat-pm set it for 23:00"
  ],
  [
   "16:05",
   "Partner C’s demo: Tuesday 09:00?",
   "Yes",
   "SALES → outb",
   "acted",
   "16:10 · invite sent"
  ],
  [
   "15:40",
   "Client M’s fee: company revenue?",
   "Company revenue",
   "FINANCE → invoices",
   "acted",
   "15:52 · invoice #0007 drafted for your approval"
  ],
  [
   "15:12",
   "Hooks: three PRs, or one?",
   "Three PRs",
   "HQ → hooks-ope-3540",
   "toact",
   ""
  ]
 ],
 "ROOMS": {
  "fund-a-drive": {
   "title": "Fund A: Drive read and write",
   "project": "fund-a-drive",
   "owner": "chat-ope-1812",
   "lanes": [
    "chat-pm",
    "chat-ope-1812",
    "SALES"
   ],
   "fresh": 1,
   "brief": "**Goal:** Fund A’s three users attach Drive files in threads and see them inline.\n- Read and write through the Drive picker\n- Attachments shown inline\n- Blocks Fund A going paid (Sales)",
   "thread": [
    [
     "chat-ope-1812",
     "16:40",
     "The spike reads a test file through the picker. Writing is next."
    ],
    [
     "YOU",
     "16:52",
     "Does it handle shared drives?"
    ],
    [
     "chat-ope-1812",
     "16:55",
     "Yes: the picker lists shared drives too. The second design screen on the shelf shows it."
    ],
    [
     "chat-pm",
     "17:28",
     "Four days for one builder, if it goes before thread search. Your call is in the queue."
    ]
   ]
  },
  "thread-search": {
   "title": "Thread search",
   "project": "thread-search",
   "owner": "chat-pm",
   "lanes": [
    "chat-pm",
    "docs-ope-1822",
    "HQ"
   ],
   "fresh": 2,
   "brief": "**Goal:** search every thread’s messages by 2 Nov.\n- Index migration tonight at 23:00, about 40 s of lock on the largest workspace\n- Attachments later",
   "thread": [
    [
     "chat-pm",
     "17:36",
     "Migration is green on staging. Running it at 23:00."
    ],
    [
     "HQ",
     "17:38",
     "Post when it’s done."
    ]
   ]
  },
  "workforce-memory": {
   "title": "Workforce memory",
   "project": "memory",
   "owner": "wf-pm",
   "lanes": [
    "wf-pm",
    "HQ"
   ],
   "fresh": 0,
   "brief": "**Goal:** agents remember what you told them, across lanes.\n- One table or one per kind: your call\n- Lookups across kinds first",
   "thread": [
    [
     "wf-pm",
     "13:52",
     "Both designs are on the shelf, one page each."
    ]
   ]
  },
  "export-accents": {
   "title": "Export drops accented names",
   "project": "export-accents",
   "owner": "tickets",
   "lanes": [
    "tickets",
    "SUPPORT"
   ],
   "fresh": 0,
   "brief": "**Goal:** names with accents export correctly.\n- Lender A’s copy: patch tonight, if you say so\n- Everyone: the 6 Nov release",
   "thread": [
    [
     "tickets",
     "17:30",
     "HQ reviewed the patch: the same line as the 6 Nov fix."
    ]
   ]
  },
  "october-close": {
   "title": "October close",
   "project": "october-close",
   "owner": "books",
   "lanes": [
    "books",
    "FINANCE"
   ],
   "fresh": 0,
   "brief": "**Goal:** October’s books closed by 31 Oct.\n- 212 of 240 lines matched\n- Two card payments without receipts: your call",
   "thread": [
    [
     "books",
     "17:05",
     "28 lines left; 26 are matched to receipts by tomorrow."
    ]
   ]
  }
 },
 "UPDATES": [
  [
   "17:36",
   "hq",
   "Thread search: the index migration is green",
   "PR #3509 locks the messages table for about 40 seconds on the largest workspace. chat-pm runs it at 23:00 unless you say otherwise.",
   1,
   "chat-pm"
  ],
  [
   "17:22",
   "support",
   "Fund A’s three logins are ready",
   "Thursday’s walkthrough needs their ops lead as a guest; that is in your queue.",
   1,
   "onboarding"
  ],
  [
   "17:05",
   "hq",
   "Fund A’s Drive gap is in your queue",
   "Sales handed it in at 16:20 with the deal it blocks.",
   1,
   "chat-ope-1812"
  ],
  [
   "16:58",
   "sales",
   "Tomorrow’s four calls",
   "Prep is ready for Lender H and Partner C. Fund A’s slot is unconfirmed; Bank B’s sponsor hasn’t sent his brief.",
   1,
   "outb"
  ],
  [
   "16:20",
   "finance",
   "October close: 212 of 240 lines matched",
   "The 28 left are card payments without receipts. Two need you.",
   0,
   "books"
  ],
  [
   "15:40",
   "hq",
   "Hooks: plan written, three PRs",
   "PR 1 observes only. PR 2 adds logs; PR 3 decides who may edit a hook.",
   0,
   "hooks-ope-3540"
  ],
  [
   "14:55",
   "people",
   "Holding the founding engineer role",
   "Interviews can start Wednesday if you say go.",
   0,
   "hiring"
  ],
  [
   "14:10",
   "hq",
   "Memory: asked again",
   "#212 came back with “I don’t get it”. Asked again as #215, with what it means for you first.",
   0,
   "wf-pm"
  ]
 ]
};
// A floor's id is its general's lane name, and the default fixture's are lower case: so are these. The label the owner sees
// stays upper case, and the prototype's own block above stays as it was made.
const GENERALS = new Set(["SALES", "FINANCE", "PEOPLE", "SUPPORT"]);
const lowered = (v: any): any => (typeof v === "string" ? (GENERALS.has(v) ? v.toLowerCase() : v) : Array.isArray(v) ? v.map(lowered) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lowered(x)])) : v);
const DATA: any = lowered(FRAME_DATA);
