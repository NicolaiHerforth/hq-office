// One lane up close, for the agent drawer on the page (GET /api/lanes/NAME/live): its terminal, the last 30 lines
// herdr reads from its pane on its own machine, with every live secret's value blanked out; and what it last said
// (its updates, its messages in rooms, its questions, its events), newest first. Read only when the page asks, which it
// does every 3 seconds while the drawer is open; nothing here is stored or polled on its own.
import { HERDR, LOCAL } from "./config.ts";
import { db } from "./db.ts";
import { secrets } from "./push.ts";

const LINES = 30;
const SAID = 10;
type Pane = { text: string | null; at: number; error: string | null };
const recent = new Map<string, { at: number; pane: Promise<Pane> }>(); // one read per lane at a time, reused for 1.5 s

async function readTail(machine: string, pane: string): Promise<Pane> {
  const args = machine === LOCAL ? [HERDR, "pane", "read", pane, "--lines", String(LINES)] : [HERDR, "--machine", machine, "pane", "read", pane, "--lines", String(LINES)];
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 8_000);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return { text: null, at: Date.now(), error: `herdr could not read pane ${pane} on ${machine}${err.trim() ? `: ${err.trim().slice(0, 160)}` : ""}` };
    return { text: secrets.mask(out.replace(/\s+$/, "")), at: Date.now(), error: null };
  } catch (e) {
    return { text: null, at: Date.now(), error: `herdr did not answer (${(e as Error).message})` };
  }
}

const cut = (s: string | null | undefined, n = 300) => { const t = String(s ?? "").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export async function laneLive(name: string) {
  const lane = db.query("SELECT name, machine, pane FROM lanes WHERE name = ?").get(name) as { name: string; machine: string | null; pane: string | null } | null;
  if (!lane) throw new Error(`no lane ${name}`);
  let pane: Pane;
  if (!lane.pane) pane = { text: null, at: Date.now(), error: "herdr has not seen this lane's pane yet" };
  else {
    const hit = recent.get(name);
    if (!hit || Date.now() - hit.at > 1500) recent.set(name, { at: Date.now(), pane: readTail(lane.machine || LOCAL, lane.pane) });
    pane = await recent.get(name)!.pane;
  }
  const rows = [
    ...(db.query("SELECT at, title, body FROM updates WHERE lane = ? ORDER BY at DESC LIMIT ?").all(name, SAID) as any[]).map((u) => ({ at: u.at, kind: "update", title: cut(u.title, 160), text: cut(u.body) })),
    ...(db.query("SELECT at, slug, text FROM room_messages WHERE author = ? ORDER BY at DESC LIMIT ?").all(name, SAID) as any[]).map((m) => ({ at: m.at, kind: "room", room: m.slug, text: cut(m.text) })),
    ...(db.query("SELECT created_at AS at, title, status FROM asks WHERE lane = ? ORDER BY created_at DESC LIMIT ?").all(name, SAID) as any[]).map((a) => ({ at: a.at, kind: "question", title: cut(a.title, 160), text: a.status === "open" ? "" : a.status })),
    // Events, less the ones that only echo an update or a question listed above.
    ...(db.query("SELECT at, who, text FROM events WHERE lane = ? AND text NOT LIKE 'update: %' AND text NOT LIKE 'asked: %' ORDER BY at DESC LIMIT ?").all(name, SAID) as any[]).map((e) => ({ at: e.at, kind: "event", who: e.who, text: cut(e.text) })),
  ].sort((a, b) => b.at - a.at).slice(0, SAID);
  return { name, pane: lane.pane, machine: lane.machine || LOCAL, terminal: pane, said: rows };
}
