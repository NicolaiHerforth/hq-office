#!/usr/bin/env bun
// HQ's side of the command centre.
//   hud ask --lane L --title T [--body B] [--opt A --opt B] [--rec A] [--kind decision|action|info] [--link URL] [--due HH:MM]
//           [--secret NAME ...]   ask the owner for named secrets, filled in on the question card
//           [--item TEXT ...]     a checklist; an item naming a PR (#123) ticks itself when it merges, and the
//                                 question closes itself ("all done") when every item is done
// ask ledger: change an open question instead of withdrawing and reposting it
//   hud update ID [--title T] [--body B] [--opt A --opt B] [--rec A] [--link URL] [--lane L]   only the fields given;
//                                --lane L moves it to lane L, --lane hq (or "") takes it off every lane
//   hud comment ID TEXT          a timestamped line under the question; information, not in the inbox
//   hud item ID N done|undo      tick or untick item N (from 1) by hand
//   hud item ID add TEXT         add an item to an open question
//   hud lane NAME [--title T] [--machine M] [--pane P] [--issue OPE-1] [--pr 123] [--phase running|waiting|parked|done] [--note N]
//           [--parent OTHER]      the lane it reports to; --parent hq (or "") puts it straight under HQ
//           [--level NAME|auto]   its level (one of the owner's level names) over the one the tree gives; auto: the tree's
//   hud rm-lane NAME     its reports move up to the lane it reported to (or HQ)
//   hud tree [--json]    the lanes under HQ, each with its level name and status
//   hud withdraw ID [--reason R]
//   hud event [--lane L] TEXT
//   hud tell --title T [--lane L] [--body B]   an update for the owner: information, no reply asked for
//                                              (hud say is the same command)
//   hud inbox            answers and notes HQ has not acted on
//   hud ack a:ID | n:ID  mark an answer or note as acted on
//   hud wait             block until the owner answers or writes (exits with the inbox)
//   hud state            the board as JSON
//   hud sync             refresh herdr status now
//   hud secret set NAME --minutes N [--by WHO]   the value comes from stdin, never from an argument
//   hud secret get NAME [--once] | <command>     the raw value to a pipe; refuses a terminal; says if it was lost
//   hud secret rm NAME
//   hud secret redact NAME  replace the value wherever it was typed and stored (answers, notes, updates) with [secret NAME]
//   hud secret list      names, who set them and when they expire, and LOST ones (lost in a restart); never values
// work board: one item per issue in flight; its state is derived from GitHub, the lane, and open asks
//   hud track ISSUE --lane L --pr N [--pr N...]   track (or add PRs to) a piece of work
//   hud done ISSUE                                close it by hand (merged or closed PRs close it on their own)
//   hud pause ISSUE REASON...  /  hud resume ISSUE deliberately on hold, so it is not called stalled
//   hud board [--json]                            blocked on a prompt, then stalled, first; refreshes GitHub if the cache is over a minute old
//   hud guide            how HQ talks to the owner (through the HUD, never only in its terminal)
// conference rooms: one per piece of work, where the owner talks straight to the lane that owns it (see roomCmd below)
//   hud room create|path|brief|artifact|say|read|list|archive ...   `hud room` prints the usage
// floors: one HQ agent and everything it runs (see floorCmd below). hud tells the server which pane it runs in
// ($HERDR_PANE_ID), so an HQ's or a lane's writes land on its own floor, and inbox, wait, ack, board, tree and
// room list show its own floor only; --all shows every floor, and --floor ID picks a floor by hand.
//   hud floor add ID (--hq AGENT | --start [--kind K]) [--name N] [--color #hex]  |  list  |  set ID [--name] [--hq] [--color]  |  rm ID
//   hud floor tell FLOOR TEXT    type a line into another floor's HQ
//   hud lane NAME --floor ID     move a lane, with every lane under it, to another floor
import { GUIDE } from "./src/hq-guide.ts";
import { treeText } from "./src/lane-tree.ts";
import { atText, expiresText } from "./src/client/secrets/expiry.js";
import { restartTime } from "./src/server/secrets.ts";

const BASE = process.env.HUD_URL ?? "http://127.0.0.1:4747";

function parse(argv: string[]) {
  const flags: Record<string, string[]> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) (flags[a.slice(2)] ??= []).push(argv[++i] ?? "");
    else rest.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  return { flags, rest, one };
}

// Who is calling (the server maps the pane to an agent, and the agent to its floor), and the floor asked for by hand.
// Also the folder hud runs in and any session ids the calling agent put in the environment (*_SESSION_ID,
// *_THREAD_ID): an agent whose commands do not run in its own herdr pane is found by those (floors.ts callerOf).
function who(): Record<string, string> {
  const h: Record<string, string> = {};
  if (process.env.HERDR_PANE_ID) h["x-hud-pane"] = process.env.HERDR_PANE_ID;
  if (process.env.HUD_LOCAL_MACHINE) h["x-hud-machine"] = process.env.HUD_LOCAL_MACHINE;
  h["x-hud-cwd"] = encodeURIComponent(process.cwd());
  const ids = Object.entries(process.env).filter(([k, v]) => /(^|_)(SESSION|THREAD)_ID$/.test(k) && v && /^[A-Za-z0-9._:-]{8,100}$/.test(v)).map(([, v]) => v!);
  if (ids.length) h["x-hud-session"] = [...new Set(ids)].join(",");
  if (FLOOR) h["x-hud-floor"] = FLOOR;
  return h;
}

// The HUD did not answer at all. An agent whose commands run in a sandbox without network (some agents default to one)
// cannot reach 127.0.0.1 from inside it: say so, so whichever agent runs hud knows to run it outside its sandbox.
function unreachable(e: unknown): never {
  console.error(`hud: could not reach the HUD at ${BASE} (${(e as Error)?.message ?? e}).
If the HUD is running, this command ran in a sandbox that blocks the network: run hud outside the sandbox (ask for escalated permissions, or allow commands that start with "hud").
If the HUD is not running, start it: herdr plugin action invoke hq-office.start`);
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", "x-hud": "1", ...who() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(unreachable);
  const data = await res.json();
  if (!res.ok) {
    console.error(data.error ?? res.statusText);
    process.exit(1);
  }
  return data;
}

function dueAt(hhmm?: string) {
  if (!hhmm) return undefined;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m ?? 0, 0, 0);
  return d.getTime();
}

const [cmd, ...argv] = process.argv.slice(2);
// --all (every floor) takes no value; --json neither (read with `"json" in flags`, so it goes last or alone).
const ALL = argv.includes("--all");
// --start (hud floor add: the server starts the new floor's HQ) takes no value either.
const START = cmd === "floor" && argv.includes("--start");
const { flags, rest, one } = parse(argv.filter((a) => a !== "--all" && !(cmd === "floor" && a === "--start")));
// `hud floor` names its floor as an argument; everywhere else --floor ID picks the floor by hand.
const FLOOR = ALL ? "all" : cmd === "floor" ? undefined : one("floor");

switch (cmd) {
  case "ask": {
    const out = await call("POST", flags.item ? "/api/ledger/asks" : "/api/asks", {
      lane: one("lane"),
      kind: one("kind"),
      title: one("title"),
      body: one("body"),
      options: flags.opt ?? [],
      recommended: one("rec"),
      link: one("link"),
      due: dueAt(one("due")),
      secrets: flags.secret ?? [],
      items: flags.item,
    });
    console.log(`ask #${out.id}`);
    break;
  }
  case "update":
    await call("POST", `/api/asks/${rest[0]}/update`, { title: one("title"), body: one("body"), options: flags.opt, recommended: one("rec"), link: one("link"), lane: one("lane") });
    console.log(`ask #${rest[0]} updated`);
    break;
  case "comment":
    await call("POST", `/api/asks/${rest[0]}/comment`, { text: rest.slice(1).join(" ") });
    break;
  case "item": {
    const [id, what, ...words] = rest;
    if (what === "add") console.log(`item ${(await call("POST", `/api/asks/${id}/items`, { text: words.join(" ") })).n}`);
    else if (/^\d+$/.test(what ?? "") && ["done", "undo"].includes(words[0])) await call("POST", `/api/asks/${id}/items/${what}`, { done: words[0] === "done" });
    else {
      console.error("usage: hud item ID N done|undo  |  hud item ID add TEXT");
      process.exit(2);
    }
    break;
  }
  case "lane":
    await call("POST", "/api/lanes", {
      name: rest[0],
      title: one("title"),
      machine: one("machine"),
      pane: one("pane"),
      issue: one("issue"),
      pr: flags.pr?.join(","),
      phase: one("phase"),
      level: one("level"),
      note: one("note"),
      parent: one("parent"),
    });
    console.log(`lane ${rest[0]}`);
    break;
  case "tree": {
    // The caller's floor's lanes, or every floor's (--all), each floor under its own HQ.
    const [{ lanes }, { floors, caller }] = await Promise.all([call("GET", "/api/state"), call("GET", "/api/floors")]);
    const view = lanes.map((l: any) => ({ name: l.name, parent: l.parent, depth: l.depth, level: l.level, status: l.status, path: l.path, floor: l.floor }));
    const shown = floors.filter((f: any) => ALL || f.id === caller);
    // One floor prints exactly what it did before floors: no floor field.
    if ("json" in flags) console.log(JSON.stringify(view.filter((l: any) => shown.some((f: any) => f.id === l.floor)).map(({ floor, ...l }: any) => (floors.length > 1 ? { ...l, floor } : l)), null, 2));
    else console.log(shown.map((f: any) => treeText(view.filter((l: any) => l.floor === f.id), floors.length > 1 ? `HQ of floor ${f.id} (${f.hq})` : "HQ")).join("\n\n"));
    break;
  }
  case "rm-lane":
    await call("POST", "/api/lanes/delete", { name: rest[0] });
    break;
  case "withdraw":
    await call("POST", `/api/asks/${rest[0]}/withdraw`, { reason: one("reason") });
    break;
  case "event":
    await call("POST", "/api/events", { lane: one("lane"), text: rest.join(" ") });
    break;
  case "tell":
  case "say":
    await call("POST", "/api/updates", { lane: one("lane"), title: one("title"), body: one("body") });
    break;
  case "inbox":
    console.log(JSON.stringify(await call("GET", "/api/inbox"), null, 2));
    break;
  case "ack":
    for (const ref of rest) {
      const [kind, id] = ref.split(":");
      await call("POST", `/api/${kind === "n" ? "notes" : "asks"}/${id}/ack`, {});
    }
    break;
  case "wait": {
    for (;;) {
      const box = await call("GET", "/api/wait?s=240");
      if (box.answers.length || box.notes.length) {
        console.log(JSON.stringify(box, null, 2));
        break;
      }
    }
    break;
  }
  case "state":
    console.log(JSON.stringify(await call("GET", "/api/state"), null, 2));
    break;
  case "sync":
    await call("POST", "/api/sync", {});
    break;
  case "secret":
    await secret(argv);
    break;
  // ---- work board ----
  case "track":
    await call("POST", "/api/board/track", { issue: rest[0], lane: one("lane"), prs: flags.pr ?? [] });
    console.log(`tracking ${rest[0]}`);
    break;
  case "done":
    await call("POST", "/api/board/done", { issue: rest[0] });
    break;
  case "pause":
    await call("POST", "/api/board/pause", { issue: rest[0], reason: one("reason") ?? rest.slice(1).join(" ") });
    break;
  case "resume":
    await call("POST", "/api/board/resume", { issue: rest[0] });
    break;
  case "board": {
    if ("json" in flags) {
      console.log(JSON.stringify(await call("GET", "/api/board?refresh=1"), null, 2));
      break;
    }
    const res = await fetch(`${BASE}/api/board?refresh=1&format=text`, { headers: who() }).catch(unreachable);
    if (!res.ok) {
      console.error(await res.text());
      process.exit(1);
    }
    process.stdout.write(await res.text());
    break;
  }
  case "guide":
    console.log(GUIDE);
    break;
  case "room":
    await roomCmd(argv);
    break;
  case "floor":
    await floorCmd();
    break;
  default:
    console.log("usage: hud ask|update|comment|item|lane|rm-lane|tree|withdraw|event|tell|say|inbox|ack|wait|state|sync|secret|track|done|pause|resume|board|room|floor|guide");
    console.log("HQ: run `hud guide` for how to reach the owner (through the HUD, never only in your terminal).");
}

// ---- secrets: the value only ever travels through stdin, the request body and stdout ----

async function readValue(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).replace(/\r?\n$/, "");
  // Typed at a terminal: no echo, so the value never shows on screen or in a scrollback.
  process.stderr.write("value (hidden): ");
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stderr.write("\n");
  }
}

async function secret(args: string[]) {
  const once = args.includes("--once");
  const { rest, one } = parse(args.filter((a) => a !== "--once"));
  const [verb, name, ...extra] = rest;
  const usage = () => {
    console.error("usage: hud secret set NAME --minutes N  (value on stdin) | get NAME [--once] | rm NAME | redact NAME | list");
    process.exit(2);
  };
  if (verb !== "list" && !name) usage();
  switch (verb) {
    case "set": {
      if (extra.length || one("value") !== undefined) {
        console.error("the value is read from stdin, never from an argument: <command> | hud secret set NAME --minutes N");
        process.exit(2);
      }
      const minutes = Number(one("minutes"));
      if (!(minutes > 0)) usage();
      const value = await readValue();
      const m = await call("POST", "/api/secrets", { name, value, minutes, by: one("by") ?? "hq" });
      console.error(`secret ${m.name} set, ${expiresText(m.expiresAt)}`);
      break;
    }
    case "get": {
      // Checked before the request: a value printed to a terminal lands in a transcript.
      if (process.stdout.isTTY) {
        console.error(`refusing to print secret ${name} to a terminal. Pipe it instead: hud secret get ${name} | <command>`);
        process.exit(2);
      }
      const { value } = await call("POST", "/api/secrets/get", { name, once });
      process.stdout.write(value);
      break;
    }
    case "redact": {
      // The server replaces the value wherever it is stored with [secret NAME]; the value never comes through here.
      const { rows, tables } = await call("POST", "/api/secrets/redact", { name });
      console.log(rows ? `redacted ${name} from ${rows} stored ${rows === 1 ? "row" : "rows"}: ${Object.entries(tables).map(([k, n]) => `${k} ${n}`).join(", ")}` : `${name} is not stored anywhere`);
      break;
    }
    case "rm": {
      const { removed } = await call("POST", "/api/secrets/rm", { name });
      console.error(removed ? `secret ${name} removed` : `no secret ${name}`);
      break;
    }
    case "list": {
      const list = await call("GET", "/api/secrets");
      if (!list.length) console.log("no secrets");
      // A lost one is a name the server knew but lost its value in a restart: it has to be set again.
      for (const s of list) {
        const set = `set by ${s.by} ${atText(s.setAt)}`;
        if (s.lostAt) console.log(`${s.name}\tLOST (lost in a restart at ${restartTime(s.lostAt)}, set it again)\t${set}`);
        else console.log(`${s.name}\t${set}\t${expiresText(s.expiresAt)}`);
      }
      break;
    }
    default:
      usage();
  }
}

// ---- conference rooms (hud room ...): the brief, the shelf and the thread of one piece of work ----

// (Function declarations, not constants: the switch above runs before any constant down here exists.)
function roomUsage() {
  return `usage:
  hud room create SLUG --title T --owner LANE [--member L ...] [--issue X ...] [--pr N ...]   (again: change or reopen it)
  hud room path SLUG                                 the room's folder: files/ is shared, and what is saved there shows on the shelf
  hud room brief SLUG --body B [--as LANE]           the pinned brief, replaced as a whole (or from stdin)
  hud room brief SLUG                                 prints the brief (nothing given: never writes); --clear clears it
  hud room artifact SLUG --title T (--url U | --file PATH) [--kind claude-artifact|link|image|file] [--as LANE]
  hud room say SLUG TEXT [--as LANE] [--reply ID]    write in the thread (as the owning lane unless --as)
  hud room read SLUG [--since ID] [--wait] [--json]  the owner's messages; --wait blocks until a new one
  hud room list [--all] [--json]
  hud room archive SLUG`;
}

// Text from an argument, else from stdin when it is piped.
// Text from --body, else piped in. A stdin that is open but says nothing (a shell or an agent's tool that never closes
// it) would wait forever: with no first bytes within a second it counts as nothing given.
async function textArg(given: string | undefined) {
  if (given !== undefined) return given;
  if (process.stdin.isTTY) return "";
  const reader = Bun.stdin.stream().getReader();
  const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => null)]);
  if (!first || first.done) {
    reader.releaseLock();
    return "";
  }
  const chunks = [first.value];
  for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  return new TextDecoder().decode(Buffer.concat(chunks)).replace(/\r?\n$/, "");
}

function ago(t: number) {
  const m = Math.floor((Date.now() - t) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m ago` : `${Math.floor(m / 1440)}d ago`;
}

async function roomCmd(args: string[]) {
  const bools = new Set(args.filter((a) => ["--json", "--wait", "--all", "--clear"].includes(a)));
  const { flags: f, rest: r, one: o } = parse(args.filter((a) => !bools.has(a)));
  const [verb, slugRaw, ...words] = r;
  const slug = (slugRaw ?? "").toLowerCase();
  const path = `/api/rooms/${encodeURIComponent(slug)}`;
  const usage = () => {
    console.error(roomUsage());
    process.exit(2);
  };
  if (verb !== "list" && !slug) usage();
  switch (verb) {
    case "create": {
      const out = await call("POST", "/api/rooms", { slug, title: o("title"), owner: o("owner"), members: f.member ?? [], issues: f.issue ?? [], prs: f.pr ?? [] });
      console.log(`room ${out.slug} ${out.created ? "created" : "updated"}`);
      console.log(`folder ${out.folder} (files/ is shared; anything saved there shows on the shelf)`);
      break;
    }
    case "path":
      console.log((await call("GET", path)).folder);
      break;
    case "brief": {
      // Writes only what it is given: --body, or text piped in. Nothing given (no --body, nothing on stdin) prints
      // the brief; an empty brief is never a way to clear one by accident, only --clear clears it.
      if (bools.has("--clear")) {
        await call("POST", `${path}/brief`, { body: "", clear: true, as: o("as") });
        console.log(`brief of ${slug} cleared`);
        break;
      }
      const body = await textArg(o("body"));
      if (!body.trim()) {
        if (o("body") !== undefined) {
          console.error(`an empty --body would clear the brief of ${slug}; to clear it, use: hud room brief ${slug} --clear`);
          process.exit(2);
        }
        const v = await call("GET", path);
        console.log(v.brief ?? `(${slug} has no brief yet: hud room brief ${slug} --body B, or pipe it in)`);
        break;
      }
      await call("POST", `${path}/brief`, { body, as: o("as") });
      console.log(`brief of ${slug} set`);
      break;
    }
    case "artifact": {
      const file = o("file");
      if (!!file === !!o("url")) usage();
      if (file) {
        const blob = Bun.file(file);
        if (!(await blob.exists())) {
          console.error(`no file ${file}`);
          process.exit(1);
        }
        const name = file.split("/").pop()!;
        const q = new URLSearchParams({ name, title: o("title") ?? name, ...(o("kind") ? { kind: o("kind")! } : {}), ...(o("as") ? { as: o("as")! } : {}) });
        const res = await fetch(`${BASE}${path}/files?${q}`, { method: "POST", headers: { "content-type": blob.type || "application/octet-stream", "x-hud": "1", ...who() }, body: blob }).catch(unreachable);
        const out = await res.json();
        if (!res.ok) {
          console.error(out.error ?? res.statusText);
          process.exit(1);
        }
        console.log(`artifact #${out.id} (${out.kind}) on ${slug}: ${BASE}${out.url}`);
        console.log(`file ${out.path}`);
      } else {
        const out = await call("POST", `${path}/artifacts`, { title: o("title"), url: o("url"), kind: o("kind"), as: o("as") });
        console.log(`artifact #${out.id} on ${slug}`);
      }
      break;
    }
    case "say": {
      const out = await call("POST", `${path}/say`, { text: await textArg(words.length ? words.join(" ") : undefined), as: o("as"), reply: o("reply") });
      console.log(`message #${out.id} in ${slug}`);
      break;
    }
    case "read": {
      let since = o("since");
      for (;;) {
        const q = new URLSearchParams({ ...(since ? { since } : {}), ...(bools.has("--wait") ? { wait: "240" } : {}) });
        const out = await call("GET", `${path}/read?${q}`);
        if (bools.has("--wait") && !out.messages.length) {
          since = String(out.since);
          continue;
        }
        if (bools.has("--json")) console.log(JSON.stringify(out, null, 2));
        else {
          if (!out.messages.length) console.log(`no messages from the owner in ${slug} after #${out.since}`);
          for (const m of out.messages) console.log(`#${m.id} ${new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} owner -> ${m.to}${m.reply ? ` (re #${m.reply})` : ""}: ${m.text}`);
          console.log(`next: hud room read ${slug} --since ${out.last}${bools.has("--wait") ? " --wait" : ""}`);
        }
        break;
      }
      break;
    }
    case "list": {
      const rooms = await call("GET", `/api/rooms${bools.has("--all") ? "?all=1" : ""}`);
      if (bools.has("--json")) {
        console.log(JSON.stringify(rooms, null, 2));
        break;
      }
      if (!rooms.length) console.log("no rooms yet: hud room create SLUG --title T --owner LANE");
      for (const x of rooms) {
        const work = [...x.issues, ...x.prs.map((p: string) => `#${p.split("#").pop()}`)].join(" ");
        console.log(`${x.slug}${x.archivedAt ? " (archived)" : ""}  "${x.title}"  owner ${x.owner}${x.members.length ? `  members ${x.members.join(", ")}` : ""}${work ? `  work ${work}` : ""}  ${x.artifacts} artifacts  last ${ago(x.lastAt)}${x.unread ? `  ${x.unread} unread by the owner` : ""}`);
      }
      break;
    }
    case "archive":
      await call("POST", `${path}/archive`, {});
      console.log(`room ${slug} archived`);
      break;
    default:
      usage();
  }
}

// ---- floors (hud floor ...): one HQ agent and everything it runs ----

async function floorCmd() {
  const [verb, id, ...words] = rest;
  const usage = () => {
    console.error(`usage:
  hud floor list [--json]                                  every floor: its HQ, whether it is receiving, lanes, waiting on the owner
  hud floor add ID --hq AGENT [--name N] [--color #hex]    a new floor, run by the herdr agent AGENT
  hud floor add ID --start [--kind K] [--name N] [--color #hex]
                                                           a new floor whose HQ the HUD starts: hq-ID, in a new herdr tab, as
                                                           herdr agent kind K (herdr agent start --help lists them; default: the first floor's HQ's)
  hud floor set ID [--name N] [--hq AGENT] [--color #hex]
  hud floor rm ID                                          only an empty floor (move its lanes first: hud lane NAME --floor OTHER)
  hud floor tell FLOOR TEXT                                type a line into that floor's HQ, from your floor`);
    process.exit(2);
  };
  switch (verb) {
    case "list": {
      const { floors, caller } = await call("GET", "/api/floors");
      if ("json" in flags) {
        console.log(JSON.stringify(floors, null, 2));
        break;
      }
      for (const f of floors) {
        const link = f.starting ? (f.notStarted ? `not started: waiting for ${f.hq} in herdr` : `STARTING: waiting for ${f.hq} in herdr`)
          : f.receiving === true ? "receiving" : f.receiving === false ? `NOT receiving (${f.reason})` : "not checked yet";
        console.log(`${f.id === caller ? "*" : " "} ${f.id}  "${f.name}"  HQ ${f.hq}${f.kind ? ` (${f.kind})` : ""}  ${link}  ${f.counts.lanes} lanes  ${f.counts.needsYou} waiting on the owner`);
      }
      break;
    }
    case "add":
      if (!id) usage();
      if (START && one("hq")) usage();
      if (!START && one("kind")) usage();
      if (START) console.log(`starting hq-${id} in a new herdr tab…`);
      {
        const r = await call("POST", "/api/floors", { id, name: one("name"), color: one("color"), ...(START ? { start: true, kind: one("kind") } : { hq: one("hq") }) });
        if (!START) console.log(`floor ${id} added`);
        else if (r.waiting) console.log(`floor ${id} added; its HQ hq-${id} started but waits on a prompt in its pane (answer it in herdr; it gets the HQ guide after):\n${r.waiting}`);
        else console.log(`floor ${id} added; its HQ hq-${id} is running and gets the HQ guide`);
      }
      break;
    case "set":
      if (!id) usage();
      await call("POST", `/api/floors/${encodeURIComponent(id)}`, { name: one("name"), hq: one("hq"), color: one("color") });
      console.log(`floor ${id} changed`);
      break;
    case "rm":
      if (!id) usage();
      await call("POST", `/api/floors/${encodeURIComponent(id)}`, { rm: true });
      console.log(`floor ${id} removed`);
      break;
    case "tell":
      if (!id || !words.length) usage();
      await call("POST", `/api/floors/${encodeURIComponent(id)}/tell`, { text: words.join(" ") });
      console.log(`told floor ${id}`);
      break;
    default:
      usage();
  }
}
