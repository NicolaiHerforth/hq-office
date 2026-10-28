// A throwaway office with more than one floor, for the Chrome tests (test/client/floors.test.ts) and the capture brief
// (brief-hub-capture-floors-v4-build.md): a server on a spare port, a data dir of its own and a stub herdr. With a
// general there are three floors (HQ, FIN, SALES); without one, a single floor of the same shape as this installation's.
// Never points at a real server, hud.db or herdr.
//
//   from a test:  const office = await startFloors();  ...  office.base, office.post(path, body), await office.stop()
//   by hand:      bun test/floors-fixture.ts [--one]   prints the address and runs until Ctrl-C
//   --frame:      the signed design's own office instead (test/floors-frame.ts), for frame pairs with the prototype
//
// The floors, by what the lane rule makes of the tree (src/lane-tree.ts): a lane under HQ heads a floor when something
// sits two levels below it.
//   HQ floor:    hq-pm (PM) > hq-api (builder), hq-web (builder, BLOCKED on a prompt); hq-ops (PM, idle)
//   FIN floor:   fin (the general, at the terminal) > fin-books (PM) > fin-recon (builder, STALLED), fin-audit (builder)
//   SALES floor: sales (the general) > sales-pm (PM) > sales-outb (builder, idle with a question), sales-lead (builder)
// The projects (conference rooms) hang on the floor of their owner's lane; see FACTS.rooms.
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer } from "../scripts/room-hash.ts";
import { frameBlocked, frameLanes, frameStubs, seedFrame } from "./floors-frame.ts";

const ROOT = join(import.meta.dir, "..");

type Lane = { name: string; parent?: string; herdr: "working" | "idle" | "blocked"; issue?: string; pr?: string };
const HQ_LANES: Lane[] = [
  { name: "hq-pm", herdr: "working", issue: "REL-1", pr: "acme-example/app#12" },
  { name: "hq-api", parent: "hq-pm", herdr: "working" },
  { name: "hq-web", parent: "hq-pm", herdr: "blocked" },
  { name: "hq-ops", herdr: "idle" },
];
const GENERAL_LANES: Lane[] = [
  { name: "fin", herdr: "idle" },
  { name: "fin-books", parent: "fin", herdr: "working" },
  { name: "fin-recon", parent: "fin-books", herdr: "idle" },
  { name: "fin-audit", parent: "fin-books", herdr: "working" },
  { name: "sales", herdr: "idle" },
  { name: "sales-pm", parent: "sales", herdr: "working" },
  { name: "sales-outb", parent: "sales-pm", herdr: "idle" },
  { name: "sales-lead", parent: "sales-pm", herdr: "working" },
];

// What the fixture holds, for a test or a capture to check against. `floors` and `waiting` are in floor order.
export const FACTS = {
  floors: ["hq", "fin", "sales"],
  labels: ["HQ", "FIN", "SALES"],
  generals: { fin: "fin", sales: "sales" },
  waiting: { hq: 3, fin: 1, sales: 2 }, // open questions by floor (one of HQ's names no lane, and the room release)
  blocked: "hq-web",
  stalled: "fin-recon",
  // a lane with a question on each floor, and the question's title
  asks: { hq: ["hq-pm", "Ship the release?"], fin: ["fin-audit", "Reclassify the March invoices?"], sales: ["sales-outb", "Take the EU call?"] },
  // unread updates by floor
  updates: { hq: 2, fin: 1, sales: 1 },
  // The projects, by the floor they hang on, oldest first, and the state each one's frame shows. `release` has linked work
  // (an issue and a pull request, both on its owner's lane too), a brief and one thing on its shelf.
  rooms: { hq: ["release", "web-fix"], fin: ["recon"], sales: ["pipeline", "outbound"] },
  roomStates: { release: "waiting", "web-fix": "blocked", recon: "stalled", pipeline: "moving", outbound: "waiting" } as Record<string, string>,
  // The questions that name each project (`, N for you` on its frame, the count tag, RUNDOWN's tag and the panel's OPEN CALLS).
  // A project turns red only for these. "The pipeline moved" is asked by sales-pm, a member of `outbound`, and names no room:
  // it is in the open count and nowhere on a frame.
  roomCalls: { release: 2, "web-fix": 0, recon: 0, pipeline: 0, outbound: 1 } as Record<string, number>,
  unnamed: ["sales-pm", "The pipeline moved"],
  // HQ's own question: no lane, and it names the release room. It is the second of release's open calls.
  hqCall: "The weekly numbers are in",
  // The briefs the fixture pins, by project. The others have none, and RUNDOWN shows them without one.
  briefs: { release: "Cut the branch, tag it, and tell the owner when the checks are green.", recon: "Close March: match every invoice to a payment, then list what is left.", pipeline: "Review the open deals and name the three that need the owner." } as Record<string, string>,
  release: { title: "Ship the release", owner: "hq-pm", members: ["hq-api", "hq-web"], issue: "REL-1", pr: "acme-example/app#12", shelf: "Release checklist" },
};

type Server = Awaited<ReturnType<typeof spawnServer>>;

// The data dir is made first and everything after it is undone together: a spawn that never comes up, a seed that throws or a
// Ctrl-C at any point after the dir exists leaves no server listening and no dir behind. (A Ctrl-C in the instant the server is
// being spawned, before it is handed back, cannot stop it: that window is the spawn's own.)
export async function startFloors(opts: { general?: boolean; frame?: boolean } = {}) {
  const data = mkdtempSync(join(tmpdir(), "hq-floors-fixture-"));
  let server: Server | undefined;
  const stop = async () => { await server?.stop(); rmSync(data, { recursive: true, force: true }); };
  const interrupted = () => stop().finally(() => process.exit(130));
  process.once("SIGINT", interrupted);
  try {
    return { ...(await openOffice(opts, data, (s) => (server = s))), stop };
  } catch (e) {
    await stop();
    throw e;
  } finally {
    process.off("SIGINT", interrupted);
  }
}

async function openOffice(opts: { general?: boolean; frame?: boolean }, data: string, started: (server: Server) => void) {
  const general = opts.general ?? true;
  const lanes: Lane[] = opts.frame ? frameLanes() : general ? [...HQ_LANES, ...GENERAL_LANES] : HQ_LANES;
  const herdr = join(data, "herdr");
  // HQ's own agent is in herdr too, so the page's "HQ ISN'T RECEIVING" banner stays out of the way of the room
  const agents = [...lanes.map((l, i) => `{"name":"${l.name}","agent_status":"${l.herdr}","pane_id":"w1:p${i}","agent":"claude"}`), `{"name":"hq","agent_status":"idle","pane_id":"w1:hq","agent":"claude"}`].join(",");
  const blocked = lanes.findIndex((l) => l.name === (opts.frame ? frameBlocked() : FACTS.blocked));
  writeFileSync(join(data, "pane.txt"), "│ Bash command\n│   rm -rf build\n│   Remove the build folder\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. No, and tell Claude what to do differently (esc)\n");
  const gh = join(data, "gh"); // a stand-in, so the work board never runs the real one
  writeFileSync(gh, "#!/bin/sh\nexit 1\n");
  chmodSync(gh, 0o755);
  writeFileSync(herdr, `#!/bin/sh\ncase "$*" in\n  *"agent list"*) echo '{"result":{"agents":[${agents}]}}' ;;\n  *"pane read w1:p${blocked}"*) cat "${data}/pane.txt" ;;\nesac\nexit 0\n`);
  chmodSync(herdr, 0o755);
  const env = { ...process.env, HUD_HOST: "127.0.0.1", HUD_DATA_DIR: data, HERDR_BIN: herdr, HUD_GH_BIN: gh, HUD_OWNER: "Tester", HUD_MACHINES: "local", HUD_LOCAL_MACHINE: "local", HUD_HQ_AGENT: "hq", HOME: data };
  // HOME is the data dir too, so nothing done on the page (making an account's home) reaches the real one.
  // The frame's office is on two machines, with stand-ins for what the server reads there.
  if (opts.frame) {
    const stubs = frameStubs(data, join(data, "pane.txt"));
    Object.assign(env, stubs.env, { HERDR_BIN: stubs.herdr });
  }
  const server = await spawnServer({ cwd: ROOT, env });
  started(server);
  const { base } = server;
  // A refused write fails the fixture: a question it meant to file must not go missing and show up later as a wrong count.
  const post = async (path: string, body: object) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-hud": "1" }, body: JSON.stringify(body) });
    const reply = await r.json();
    if (!r.ok || reply?.error) throw new Error(`${path}: ${reply?.error ?? r.status}`);
    return reply;
  };
  // FACTS describe the default office, not the frame's: frame mode returns none.
  if (opts.frame) {
    for (const l of lanes as ReturnType<typeof frameLanes>) await post("/api/lanes", { name: l.name, parent: l.parent ?? "hq", machine: l.machine, title: l.title, ...(l.phase ? { phase: l.phase } : {}), ...(l.issue ? { issue: l.issue } : {}) });
    await seedFrame(post, data, base);
    return { base, post };
  }

  for (const l of lanes) await post("/api/lanes", { name: l.name, parent: l.parent ?? "hq", machine: "local", title: l.name, ...(l.issue ? { issue: l.issue, pr: l.pr } : {}) });
  // Parents first in the lists above, so each parent is registered before its reports.
  const ask = (lane: string | null, kind: string, title: string, extra: object = {}) => post("/api/asks", { lane, kind, title, ...extra });
  // The rooms come first: a question names its room only if the room is open.
  const R = FACTS.release;
  await post("/api/rooms", { slug: "release", title: R.title, owner: R.owner, members: R.members, issues: [R.issue], prs: [R.pr] });
  await post("/api/rooms/release/brief", { body: FACTS.briefs.release });
  await post("/api/rooms/release/artifacts", { title: R.shelf, url: "https://example.com/release-checklist" });
  await post("/api/rooms", { slug: "web-fix", title: "Fix the web build", owner: "hq-web" });
  if (general) {
    await post("/api/rooms", { slug: "recon", title: "Reconcile March", owner: "fin-recon" });
    await post("/api/rooms/recon/brief", { body: FACTS.briefs.recon });
    await post("/api/rooms", { slug: "pipeline", title: "Pipeline review", owner: "sales-lead" });
    await post("/api/rooms/pipeline/brief", { body: FACTS.briefs.pipeline });
    await post("/api/rooms", { slug: "outbound", title: "Outbound calls", owner: "sales-outb", members: ["sales-pm"] });
  }
  await ask("hq-pm", "decision", FACTS.asks.hq[1], { body: "Two ways to go.", options: ["Ship it", "Hold"], recommended: "Ship it", room: "release" });
  await ask("hq-ops", "action", "Approve the vendor contract");
  await ask(null, "info", FACTS.hqCall, { room: "release" });
  await post("/api/updates", { lane: "hq-pm", title: "The release branch is cut", body: "Tests are green." });
  await post("/api/updates", { lane: null, title: "Nothing is on fire" });
  await post("/api/notes", { text: "Keep going." });
  if (general) {
    await ask("fin-audit", "decision", FACTS.asks.fin[1], { options: ["Yes", "No"], recommended: "Yes" });
    await ask("sales-outb", "decision", FACTS.asks.sales[1], { options: ["I take it", "Hand it over"], recommended: "Hand it over", room: "outbound" });
    await ask(FACTS.unnamed[0], "info", FACTS.unnamed[1]);
    await post("/api/updates", { lane: "fin-books", title: "March is reconciled", body: "Two invoices are left." });
    await post("/api/updates", { lane: "sales-pm", title: "Two calls booked" });
  }
  await post("/api/sync", {});
  if (general) {
    // The stalled lane: idle in herdr for longer than the server's 15 minutes. Only this fixture's own throwaway database.
    const db = new Database(join(data, "hud.db"));
    db.exec("PRAGMA busy_timeout = 5000;"); // the server may still be writing after the sync
    db.query("UPDATE lanes SET herdr_since = ? WHERE name = ?").run(Date.now() - 40 * 60_000, FACTS.stalled);
    db.close();
    await post("/api/lanes", { name: FACTS.stalled, note: "waiting for a reply" }); // a write, so the page's next state carries it
  }
  return { base, post, facts: FACTS };
}

if (import.meta.main) {
  const office = await startFloors({ general: !process.argv.includes("--one"), frame: process.argv.includes("--frame") });
  console.log(`floors fixture on ${office.base}`);
  process.on("SIGINT", async () => { await office.stop(); process.exit(0); });
  await new Promise(() => {});
}
